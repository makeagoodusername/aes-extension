"use strict"

/**
 * Audit log + settings-expander UI for the Aircraft Flight Plan Assistant
 * (Slice F).
 *
 * Two stores, both written atomically per `add(record)`:
 *
 *   1. Global timeline   `aircraftFlightPlan:auditLog`
 *      → {entries: [...], updatedAt}
 *      Capped at 200 (newest first; oldest pop off the tail).
 *
 *   2. Per-aircraft ring `aircraftFlightPlan:auditLog:<server>:<aircraftId>`
 *      → {server, aircraftId, entries: [...], updatedAt}
 *      Capped at 50 entries per aircraft.
 *
 * Why both: the global timeline lets the user see "what did I do across
 * the fleet this session"; the per-aircraft ring keeps lookup cheap when
 * the panel re-mounts on one aircraft and only wants its own breadcrumbs.
 *
 * Pattern follows `RouteAssistantPricingApplyLog` (the dual-store apply
 * log shipped earlier this session). Two notable differences:
 *   - No fingerprint dedup. Every bus event is one entry — the user
 *     wants to see misclicks too in the breadcrumb trail.
 *   - Per-aircraft cap is 50 (vs 20 for pricing-apply-log per route)
 *     because each aircraft sees more bus events per session than a
 *     single route sees price applies.
 *
 * The class is exported as a singleton instance via `window.AesAfpAuditLog`
 * — the class itself is internal. Slice F's wiring + UI also lives in this
 * file (the settings expander + recent-activity preview share the same
 * `AesAfp.slot("audit")`, so owning the slot from one module keeps the
 * single-writer guarantee clean).
 */
class AesAfpAuditLogClass {
    static GLOBAL_KEY            = "aircraftFlightPlan:auditLog"
    static PER_AIRCRAFT_PREFIX   = "aircraftFlightPlan:auditLog:"
    static GLOBAL_LIMIT          = 200
    static PER_AIRCRAFT_LIMIT    = 50

    static _aircraftKey(server, aircraftId) {
        return AesAfpAuditLogClass.PER_AIRCRAFT_PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    /**
     * Coerce a raw record into the canonical audit shape and drop nulls
     * to keep storage small. Mirrors `pricing-apply-log._cleanRecord`'s
     * approach — function refs and oversized strings are stripped.
     */
    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:             r.id || null,
            ts:             (typeof r.ts === "number" && isFinite(r.ts)) ? r.ts : Date.now(),
            server:         r.server       ? String(r.server)       : null,
            aircraftId:     r.aircraftId   ? String(r.aircraftId)   : null,
            registration:   r.registration ? String(r.registration) : null,
            action:         r.action       ? String(r.action)       : "unknown",
            hub:            r.hub  ? String(r.hub).toUpperCase().slice(0, 4) : null,
            dest:           r.dest ? String(r.dest).toUpperCase().slice(0, 4) : null,
            depTime:        r.depTime ? String(r.depTime).slice(0, 5)        : null,
            pricePct:       isFinite(Number(r.pricePct)) ? Number(r.pricePct) : null,
            service:        r.service ? String(r.service).slice(0, 64)       : null,
            source:         r.source  ? String(r.source).slice(0, 32)        : null
        }
        for (const k in out) if (out[k] == null) delete out[k]
        return out
    }

    /**
     * Persist one audit record to BOTH stores atomically. Single
     * chrome.storage.local.set writes both keys — consumers MUST NOT
     * split the write or the global timeline and per-aircraft ring will
     * diverge (an invariant in HANDOVER §10).
     *
     * Returns the saved record (with its assigned `id`).
     */
    async add(record) {
        const cleaned = AesAfpAuditLogClass._cleanRecord(record)
        cleaned.id = cleaned.id || AesAfpAuditLogClass._newId(cleaned.ts)

        const globalKey = AesAfpAuditLogClass.GLOBAL_KEY
        const aircraftKey = (cleaned.server && cleaned.aircraftId)
            ? AesAfpAuditLogClass._aircraftKey(cleaned.server, cleaned.aircraftId)
            : null
        const keys = aircraftKey ? [globalKey, aircraftKey] : [globalKey]
        const got = await chrome.storage.local.get(keys)

        const globalRec = (got && got[globalKey]) || {entries: [], updatedAt: 0}
        let entries = Array.isArray(globalRec.entries) ? globalRec.entries.slice() : []
        entries.unshift(cleaned)
        if (entries.length > AesAfpAuditLogClass.GLOBAL_LIMIT) {
            entries = entries.slice(0, AesAfpAuditLogClass.GLOBAL_LIMIT)
        }

        const writes = {[globalKey]: {entries, updatedAt: cleaned.ts}}

        if (aircraftKey) {
            const acRec = (got && got[aircraftKey])
                || {server: cleaned.server, aircraftId: cleaned.aircraftId, entries: [], updatedAt: 0}
            let acEntries = Array.isArray(acRec.entries) ? acRec.entries.slice() : []
            acEntries.unshift(cleaned)
            if (acEntries.length > AesAfpAuditLogClass.PER_AIRCRAFT_LIMIT) {
                acEntries = acEntries.slice(0, AesAfpAuditLogClass.PER_AIRCRAFT_LIMIT)
            }
            writes[aircraftKey] = {
                server:     cleaned.server,
                aircraftId: cleaned.aircraftId,
                entries:    acEntries,
                updatedAt:  cleaned.ts
            }
        }

        await chrome.storage.local.set(writes)
        return cleaned
    }

    /**
     * Read the global timeline. `n` slices the head; omit to get all.
     */
    async getRecent(n) {
        const got = await chrome.storage.local.get([AesAfpAuditLogClass.GLOBAL_KEY])
        const rec = got[AesAfpAuditLogClass.GLOBAL_KEY] || {entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return (isFinite(n) && n > 0) ? entries.slice(0, n) : entries
    }

    /**
     * Read one aircraft's per-aircraft ring.
     */
    async getForAircraft(server, aircraftId, n) {
        if (!server || !aircraftId) return []
        const key = AesAfpAuditLogClass._aircraftKey(server, aircraftId)
        const got = await chrome.storage.local.get([key])
        const rec = got[key] || {entries: []}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return (isFinite(n) && n > 0) ? entries.slice(0, n) : entries
    }

    /**
     * Wipe the global timeline + every per-aircraft ring. Returns the
     * count of keys removed. Mirrors `pricing-apply-log.clear()`'s
     * walk-all-keys approach.
     */
    async clear() {
        const all = await chrome.storage.local.get(null)
        const keys = [AesAfpAuditLogClass.GLOBAL_KEY]
        for (const k in all) {
            if (k.startsWith(AesAfpAuditLogClass.PER_AIRCRAFT_PREFIX)) keys.push(k)
        }
        if (keys.length) await chrome.storage.local.remove(keys)
        return keys.length
    }

    /**
     * Subscribe to audit-log updates across tabs. Mirrors
     * `AesAfpScheduleStore.watch` but reports two scopes since the audit
     * log persists to two key shapes:
     *
     *   - GLOBAL_KEY → cb({scope: "global", record, oldRecord})
     *   - PER_AIRCRAFT_PREFIX + ":server:aircraftId" →
     *       cb({scope: "aircraft", server, aircraftId, record, oldRecord})
     *
     * `record` is the full stored value (entries[] + updatedAt etc.) so
     * consumers can compare entries[] to detect new additions. Returns
     * an unwatch fn.
     */
    watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                const change = changes[key]
                if (key === AesAfpAuditLogClass.GLOBAL_KEY) {
                    try {
                        cb({
                            scope:     "global",
                            record:    change.newValue || null,
                            oldRecord: change.oldValue || null
                        })
                    } catch (e) { console.warn("[AES AFP] audit-log watch (global) threw", e) }
                    continue
                }
                if (key.indexOf(AesAfpAuditLogClass.PER_AIRCRAFT_PREFIX) !== 0) continue
                const tail = key.slice(AesAfpAuditLogClass.PER_AIRCRAFT_PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server     = tail.slice(0, sep)
                const aircraftId = tail.slice(sep + 1)
                try {
                    cb({
                        scope:      "aircraft",
                        server,
                        aircraftId,
                        record:     change.newValue || null,
                        oldRecord:  change.oldValue || null
                    })
                } catch (e) { console.warn("[AES AFP] audit-log watch (aircraft) threw", e) }
            }
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) { return () => {} }
        return () => {
            try { chrome.storage.onChanged.removeListener(handler) }
            catch (_) { /* noop */ }
        }
    }
}

// Singleton — matches the pattern of an instance-method API like the
// pricing apply log, but only one instance is ever used.
const _aesAfpAuditLog = new AesAfpAuditLogClass()
if (typeof window !== "undefined") {
    window.AesAfpAuditLog = _aesAfpAuditLog
}

// ─────────────────────────────────────────────────────────────────────
// Slice F UI + bus wiring. Lives in this file because the settings
// expander + recent-activity preview share `AesAfp.slot("audit")` —
// owning that slot from one module keeps the single-writer guarantee
// clean and avoids races between two render call sites.
// ─────────────────────────────────────────────────────────────────────

(function () {
    if (typeof window === "undefined") return

    const ACTION_LABELS = {
        "candidate-clicked":  "Candidate picked",
        "form-filled":        "Form filled",
        "form-cleared":       "Form cleared",
        "wave-generated":     "Wave plan generated",
        "leg-applied":        "Wave leg applied",
        "preset-selected":    "Preset selected",
        "candidate-dismissed":"Candidate dismissed"
    }

    function fmtAgo(ts) {
        const now = Date.now()
        const dt = Math.max(0, now - (Number(ts) || now))
        const s = Math.floor(dt / 1000)
        if (s < 60)    return s + "s ago"
        const m = Math.floor(s / 60)
        if (m < 60)    return m + "m ago"
        const h = Math.floor(m / 60)
        if (h < 24)    return h + "h ago"
        const d = Math.floor(h / 24)
        return d + "d ago"
    }

    function fmtRoute(rec) {
        if (rec.hub && rec.dest) return rec.hub + "→" + rec.dest
        if (rec.dest) return rec.dest
        return ""
    }

    function _esc(s) {
        // Defensive — helpers.js exports escapeHtml globally, but if the
        // module ever loads before helpers.js (manifest reorder regression)
        // we don't want to throw.
        if (typeof escapeHtml === "function") return escapeHtml(s)
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;")
    }

    /**
     * Wait for AesAfp + AesAfpSettings + AesAfpAuditLog all to be ready
     * before subscribing to the bus. Slice A's host script may not have
     * finished parsing when this IIFE runs (manifest order is enforced
     * but `AesAfp.mount()` is async).
     */
    function whenReady(cb) {
        const start = Date.now()
        const tick = () => {
            if (typeof window.AesAfp !== "undefined"
                && window.AesAfp
                && typeof window.AesAfp.bus !== "undefined"
                && typeof window.AesAfpSettings !== "undefined") {
                cb()
                return
            }
            // Cap at 30s — past that, Slice A failed to mount and there's
            // nothing useful we can do. Log once + bail.
            if (Date.now() - start > 30000) {
                console.warn("[AES AFP audit-log] Slice A host not ready after 30s; giving up.")
                return
            }
            setTimeout(tick, 200)
        }
        tick()
    }

    function ctxFields() {
        const ctx = (window.AesAfp && window.AesAfp.ctx) || {}
        return {
            server:       ctx.server       || null,
            aircraftId:   ctx.aircraftId   || null,
            registration: ctx.registration || null
        }
    }

    /**
     * Re-render the settings expander + recent-activity preview into
     * AesAfp.slot("audit"). Idempotent — replaces the slot's contents
     * each call.
     */
    async function renderSlot() {
        if (!window.AesAfp || typeof window.AesAfp.slot !== "function") return
        const slot = window.AesAfp.slot("audit")
        if (!slot) return
        const settings  = await window.AesAfpSettings.load()
        // Recent-activity preview lives in the per-aircraft sidebar — scope
        // the read to THIS aircraft's ring so flying N001LL at JFK doesn't
        // show form-fills logged against a different aircraft (or the same
        // aircraft when it was based at a different hub). The per-aircraft
        // ring is written atomically alongside the global timeline by
        // `add()` so the data is always available; the legacy global read
        // surfaced cross-aircraft noise. Falls back to the global timeline
        // only when ctx hasn't resolved an aircraftId yet (first paint
        // before mount() finishes).
        const _ctx = (window.AesAfp && window.AesAfp.ctx) || {}
        const recent = (_ctx.server && _ctx.aircraftId)
            ? await _aesAfpAuditLog.getForAircraft(_ctx.server, _ctx.aircraftId, 10)
            : await _aesAfpAuditLog.getRecent(10)

        const html = []
        html.push('<details class="aes-afp-settings-expander" style="margin-top:6px;">')
        html.push('  <summary style="cursor:pointer;font-size:11px;color:#9ca3af;">Settings &amp; activity</summary>')
        html.push('  <div class="aes-afp-settings-body" style="padding:6px 0;font-size:11px;">')
        html.push('    <label style="display:block;margin-bottom:4px;"><input type="checkbox" data-aes-afp-set="enabled"' + (settings.enabled ? ' checked' : '') + '> Enabled</label>')
        html.push('    <label style="display:block;margin-bottom:4px;">Default top-N: <input type="number" min="1" max="50" data-aes-afp-set="defaultTopN" value="' + _esc(String(settings.defaultTopN)) + '" style="width:50px;"></label>')
        html.push('    <label style="display:block;margin-bottom:4px;">Default price %: <input type="number" min="1" max="500" data-aes-afp-set="defaultPricePct" value="' + _esc(String(settings.defaultPricePct)) + '" style="width:50px;"></label>')
        html.push('    <label style="display:block;margin-bottom:4px;">Default service: <input type="text" data-aes-afp-set="defaultService" value="' + _esc(settings.defaultService) + '" style="width:140px;"></label>')
        html.push('    <label style="display:block;margin-bottom:4px;"><input type="checkbox" data-aes-afp-set="showWavePreview"' + (settings.showWavePreview ? ' checked' : '') + '> Show wave preview</label>')
        html.push('    <div style="margin-top:6px;font-size:10px;color:#9ca3af;">Quick-filter defaults:</div>')
        html.push('    <label style="display:block;margin-left:8px;"><input type="checkbox" data-aes-afp-chip="rangeFitOnly"' + (settings.candidateChips.rangeFitOnly ? ' checked' : '') + '> Range-fit only</label>')
        html.push('    <label style="display:block;margin-left:8px;"><input type="checkbox" data-aes-afp-chip="hideAlreadyScheduled"' + (settings.candidateChips.hideAlreadyScheduled ? ' checked' : '') + '> Hide already scheduled</label>')
        html.push('    <label style="display:block;margin-left:8px;"><input type="checkbox" data-aes-afp-chip="watchlistOnly"' + (settings.candidateChips.watchlistOnly ? ' checked' : '') + '> Watchlist only</label>')
        html.push('  </div>')
        html.push('</details>')

        html.push('<div class="aes-afp-recent-activity" style="margin-top:6px;font-size:11px;">')
        html.push('  <div style="color:#9ca3af;margin-bottom:4px;">Recent activity:</div>')
        if (!recent.length) {
            html.push('  <div style="color:#6b7280;font-style:italic;">No actions yet — pick a candidate to start.</div>')
        } else {
            html.push('  <ul style="list-style:none;padding:0;margin:0;">')
            for (const e of recent) {
                const label = ACTION_LABELS[e.action] || e.action || "?"
                const route = fmtRoute(e)
                html.push('    <li style="margin-bottom:2px;color:#d1d5db;">'
                    + '<span style="color:#9ca3af;">' + _esc(fmtAgo(e.ts)) + '</span> · '
                    + _esc(label)
                    + (route ? ' · ' + _esc(route) : '')
                    + '</li>')
            }
            html.push('  </ul>')
            html.push('  <button type="button" data-aes-afp-clear="1" style="margin-top:4px;font-size:10px;padding:2px 6px;cursor:pointer;">Clear</button>')
        }
        html.push('</div>')

        slot.innerHTML = html.join("")

        // Wire change handlers — settings inputs save through AesAfpSettings.
        slot.querySelectorAll("[data-aes-afp-set]").forEach(input => {
            input.addEventListener("change", async () => {
                const key = input.getAttribute("data-aes-afp-set")
                let val
                if (input.type === "checkbox") val = input.checked
                else if (input.type === "number") val = Number(input.value)
                else val = input.value
                const patch = {}
                patch[key] = val
                await window.AesAfpSettings.save(patch)
            })
        })
        slot.querySelectorAll("[data-aes-afp-chip]").forEach(input => {
            input.addEventListener("change", async () => {
                const key = input.getAttribute("data-aes-afp-chip")
                const patch = {candidateChips: {}}
                patch.candidateChips[key] = input.checked
                await window.AesAfpSettings.save(patch)
            })
        })
        const clearBtn = slot.querySelector("[data-aes-afp-clear]")
        if (clearBtn) {
            clearBtn.addEventListener("click", async () => {
                if (!window.confirm("Clear all activity? This wipes the global timeline + every per-aircraft ring.")) return
                await _aesAfpAuditLog.clear()
                await renderSlot()
            })
        }
    }

    /**
     * Subscribe to bus events and write one audit entry per event.
     * Each handler reads AesAfp.ctx at call time so re-mounts after
     * Wicket sidebar refreshes pick up the fresh server/aircraftId/
     * registration (an invariant in HANDOVER §10).
     */
    function wireBus(bus) {
        const logAndEmit = async (rec) => {
            const ctx = ctxFields()
            const merged = Object.assign({}, ctx, rec)
            try {
                const saved = await _aesAfpAuditLog.add(merged)
                bus.emit("audit:logged", {record: saved})
                await renderSlot()
            } catch (err) {
                console.warn("[AES AFP audit-log] add failed", err)
            }
        }

        bus.on("candidate:selected", async (payload) => {
            const cand = (payload && payload.candidate) || {}
            await logAndEmit({
                action: "candidate-clicked",
                dest:   cand.destIata || null,
                source: (payload && payload.source) || "candidate-list"
            })
        })

        bus.on("form:filled", async (payload) => {
            const leg = (payload && payload.leg) || {}
            await logAndEmit({
                action:   "form-filled",
                hub:      leg.origin      || null,
                dest:     leg.destination || null,
                depTime:  leg.depTime     || null,
                pricePct: isFinite(Number(leg.pricePct)) ? Number(leg.pricePct) : null,
                service:  leg.service     || null,
                source:   (payload && payload.source) || null
            })
            // Defensive — if toast-host failed to load, the slice still
            // logs the entry without throwing (an invariant in HANDOVER §10).
            if (typeof RouteAssistantToast !== "undefined") {
                const route = (leg.origin && leg.destination) ? (leg.origin + "→" + leg.destination) : ""
                RouteAssistantToast.info("Pre-filled: " + route + ". Verify and click Submit.")
            }
        })

        bus.on("form:cleared", async () => {
            await logAndEmit({action: "form-cleared"})
        })

        bus.on("wave:built", async (payload) => {
            const build = (payload && payload.build) || {}
            await logAndEmit({
                action: "wave-generated",
                source: "wave-applier",
                dest:   build.hub || null   // best-effort; Slice E build shape may carry hub
            })
        })

        // Slice E may emit candidate:dismissed for the dismissal CTA;
        // listen defensively. Slice C may also emit it on row dismiss.
        bus.on("candidate:dismissed", async (payload) => {
            const cand = (payload && payload.candidate) || {}
            await logAndEmit({
                action: "candidate-dismissed",
                dest:   cand.destIata || null,
                source: (payload && payload.source) || null
            })
        })

        // Slice E may also fire preset:selected and leg-applied events;
        // guard so missing emitters are no-ops.
        bus.on("preset:selected", async (payload) => {
            await logAndEmit({
                action: "preset-selected",
                source: (payload && payload.presetId) ? String(payload.presetId).slice(0, 32) : null
            })
        })
        bus.on("leg:applied", async (payload) => {
            const leg = (payload && payload.leg) || (payload && payload.candidate) || {}
            await logAndEmit({
                action: "leg-applied",
                hub:    leg.origin      || null,
                dest:   leg.destination || leg.destIata || null,
                source: "wave-leg"
            })
        })

        // Re-render the audit preview when ctx becomes available so the
        // first mount shows the slot scaffolding without waiting for the
        // first event.
        bus.on("ctx:ready", () => { renderSlot() })

        // Initial render — covers the case where ctx:ready already fired
        // before this IIFE wired up.
        renderSlot()
    }

    whenReady(() => {
        try {
            wireBus(window.AesAfp.bus)
        } catch (err) {
            console.warn("[AES AFP audit-log] bus wiring failed", err)
        }
    })
})()
