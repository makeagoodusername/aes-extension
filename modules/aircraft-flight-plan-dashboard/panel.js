"use strict"

/**
 * AFP Dashboard — Schedule Control modal (Tier 1: dry-run preview only).
 *
 * Mounts as a fixed-position overlay on `/app/fleets*`. Opens via
 * FleetHubInlineTable's new D action chip (`aes-fleet-hub:action-d`).
 *
 * UX outline:
 *   ┌─ Schedule Control · <reg> · <equipment> ────── [↗ Open in AS] [×] ─┐
 *   │ Preset: [picker ▾]   [Generate]                                    │
 *   │ Status: hub <IATA> · cands <N> · build <M legs>                    │
 *   │ ┌─ Build preview ──────────────────────────────────────────────┐  │
 *   │ │ → JFK → ATL · 09:00 · 100% · ___  [Dry-run]                  │  │
 *   │ │   ▸ POST body preview                                         │  │
 *   │ │ ← ATL → JFK · 14:00 · 100% · ___  [Dry-run]                  │  │
 *   │ └──────────────────────────────────────────────────────────────┘  │
 *   │ ▸ Recent applies (10)                                              │
 *   │ 🔒 Live submit gated to Tier 2 — dry-run only.                     │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Single-instance host: opening the panel for a different aircraft re-uses
 * the same root + closes any prior open.
 */
class AesAfpDashboardPanel {
    static ROOT_ID  = "aes-afp-dashboard-panel"
    static MARKER   = "data-aes-afp-dashboard"

    constructor(deps) {
        const d = deps || {}
        this.server      = d.server      || ""
        this.airlineCode = d.airlineCode || ""
        this.proxyFetcher = d.proxyFetcher || null
        this.applier     = d.applier     || null
        this.applyLog    = d.applyLog    || null
        this.pipeline    = d.pipeline    || null
        this.roster      = d.roster      || null
        this._row        = null
        this._formContext = null
        this._lastBuild  = null
        this._lastCandidates = null
        this._presets    = []
        this._selectedPresetId = null
        this._rootEl     = null
        // Track 7 slice 7f — cached Schedule for the open aircraft.
        // Populated in openFor() and refreshed by storage onChanged events
        // attached in dashboard host.js. Lets the panel header show a
        // "schedule N min old" badge so the user knows whether the AFP
        // page was visited recently enough to trust the displayed counts.
        this._schedule   = null
    }

    /** Mount + show the panel for one aircraft row. Re-uses any existing root. */
    async openFor(row) {
        if (!row || !row.aircraftId) return
        this._row = row
        this._formContext = null
        this._lastBuild = null
        this._lastCandidates = null
        this._schedule = null
        this._ensureRoot()
        this._render({phase: "loading"})

        // Defer async loads in parallel. Surface any error in the first
        // panel render rather than blocking the modal's appearance.
        // Track 7 slice 7f — pull the persisted Schedule alongside the
        // preset block. Panel header shows a "schedule N min old" badge
        // when the AFP page has been visited recently. We do NOT skip the
        // proxy form-context fetch when the schedule is fresh; the form
        // context is the apply-pipeline's GET handshake and isn't in the
        // schedule store. The schedule is informational on this surface.
        const [presetBlock, schedule] = await Promise.all([
            (typeof SchedulePresets !== "undefined")
                ? SchedulePresets.load().catch(e => ({presets: [], _err: e}))
                : Promise.resolve({presets: []}),
            (typeof AesAfpScheduleStore !== "undefined")
                ? AesAfpScheduleStore.load(this.server, row.aircraftId).catch(() => null)
                : Promise.resolve(null)
        ])
        this._presets = (presetBlock && Array.isArray(presetBlock.presets)) ? presetBlock.presets : []
        this._selectedPresetId = this._resolveDefaultPresetId(presetBlock)
        this._schedule = schedule || null

        // Fetch the form context proactively — the user almost certainly
        // wants to dry-run a leg, and the GET is the slowest step.
        if (this.proxyFetcher) {
            const r = await this.proxyFetcher.fetchAircraftFormContext(row.aircraftId)
            if (r.ok) this._formContext = r.formContext
            this._render({phase: "ready", fetchResult: r})
        } else {
            this._render({phase: "ready"})
        }
    }

    /**
     * Track 7 slice 7f — re-hydrate the cached Schedule and repaint the
     * header. Called by the dashboard host's storage onChanged listener
     * when this aircraft's schedule key changes (a different tab visited
     * the AFP page and the broadcaster wrote a fresh Schedule).
     */
    async refreshSchedule() {
        if (!this._row || !this._row.aircraftId) return
        if (typeof AesAfpScheduleStore === "undefined") return
        try {
            this._schedule = await AesAfpScheduleStore.load(this.server, this._row.aircraftId)
        } catch (_) { /* keep prior */ return }
        // Cheap header-only repaint — the body is unaffected by schedule changes.
        if (this._rootEl) {
            const oldHeader = this._rootEl.firstElementChild
            const newHeader = this._renderHeader()
            if (oldHeader && oldHeader.parentElement === this._rootEl) {
                this._rootEl.replaceChild(newHeader, oldHeader)
            }
        }
    }

    close() {
        if (this._rootEl && this._rootEl.parentElement) {
            this._rootEl.parentElement.removeChild(this._rootEl)
        }
        this._rootEl = null
    }

    _ensureRoot() {
        if (this._rootEl && document.body.contains(this._rootEl)) return
        const old = document.getElementById(AesAfpDashboardPanel.ROOT_ID)
        if (old && old.parentElement) old.parentElement.removeChild(old)
        const root = document.createElement("div")
        root.id = AesAfpDashboardPanel.ROOT_ID
        root.setAttribute(AesAfpDashboardPanel.MARKER, "1")
        root.style.cssText = "position:fixed;top:48px;right:24px;width:560px;max-width:calc(100vw - 48px);"
            + "max-height:calc(100vh - 96px);overflow:auto;z-index:99999;"
            + "background:#0f1623;color:#e2e8f0;border:1px solid #374151;border-radius:6px;"
            + "box-shadow:0 12px 48px rgba(0,0,0,0.6);font-family:inherit;font-size:12px;"
        document.body.appendChild(root)
        this._rootEl = root
    }

    _resolveDefaultPresetId(presetBlock) {
        const hub = String((this._row && this._row.hub) || (this._row && this._row.locIata) || "").toUpperCase()
        const presets = this._presets
        if (hub) {
            const hubMatch = presets.find(p => String((p && p.hub) || "").toUpperCase() === hub)
            if (hubMatch) return hubMatch.id
        }
        if (presetBlock && presetBlock.defaultPresetId
            && presets.find(p => p.id === presetBlock.defaultPresetId)) {
            return presetBlock.defaultPresetId
        }
        return presets[0] ? presets[0].id : null
    }

    // ----- Render --------------------------------------------------------

    _render(state) {
        if (!this._rootEl) return
        const root = this._rootEl
        root.innerHTML = ""
        root.appendChild(this._renderHeader())

        if (state.phase === "loading") {
            const div = document.createElement("div")
            div.style.cssText = "padding:16px;color:#9ca3af;font-style:italic;"
            div.textContent = "Loading aircraft form context…"
            root.appendChild(div)
            return
        }

        if (state.fetchResult && !state.fetchResult.ok) {
            root.appendChild(this._renderFetchError(state.fetchResult))
            // Even on fetch error we still show the deep-link + recent log.
            root.appendChild(this._renderRecentLog())
            return
        }

        root.appendChild(this._renderToolbar())
        root.appendChild(this._renderStatusLine())
        root.appendChild(this._renderBuildSection())
        root.appendChild(this._renderRecentLog())
        root.appendChild(this._renderGateFooter())
    }

    _renderHeader() {
        const row = this._row || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;"
            + "border-bottom:1px solid #1f2937;background:#0b1220;"
            + "position:sticky;top:0;z-index:1;"

        const title = document.createElement("div")
        title.style.cssText = "flex:1 1 auto;min-width:0;font-weight:700;color:#f8fafc;"
        title.innerHTML = "<span>Schedule Control</span>"
            + "<span style=\"color:#6b7280;margin:0 4px;\">·</span>"
            + "<span>" + escapeHtml(row.registration || "—") + "</span>"
            + "<span style=\"color:#6b7280;margin:0 4px;\">·</span>"
            + "<span style=\"color:#cbd5e1;\">" + escapeHtml(row.equipment || "—") + "</span>"
            + "<span style=\"color:#6b7280;margin:0 4px;\">·</span>"
            + "<span title=\"current location\">" + escapeHtml(row.locIata || row.hub || "—") + "</span>"
        wrap.appendChild(title)

        // Track 7 slice 7f — schedule freshness badge. Surfaces both the
        // flight count we observed on the AFP page and how long ago we saw
        // it. "—" when the AFP page hasn't been visited yet for this
        // aircraft (the broadcaster only writes after a real visit).
        const sched = this._schedule
        if (sched) {
            const flightCount = (sched.summary && Number(sched.summary.flightCount)) || 0
            const ageMs = (typeof AesAfpScheduleStore !== "undefined")
                ? AesAfpScheduleStore.getStaleness(sched) : Infinity
            const fresh = isFinite(ageMs)
                && (typeof AesAfpScheduleStore === "undefined"
                    || AesAfpScheduleStore.isFresh(sched, 5 * 60 * 1000))
            const ageLabel = isFinite(ageMs) ? this._ageLabel(ageMs) : "?"
            const badge = document.createElement("span")
            badge.title = "Persisted schedule from a recent AFP page visit"
                + " (" + flightCount + " leg" + (flightCount === 1 ? "" : "s") + ", scraped "
                + ageLabel + " ago). Visit the AFP page to refresh."
            badge.style.cssText = "font-size:10px;padding:2px 6px;border-radius:8px;"
                + "border:1px solid " + (fresh ? "#166534" : "#7c2d12") + ";"
                + "background:" + (fresh ? "#052e16" : "#1f1414") + ";"
                + "color:" + (fresh ? "#86efac" : "#fca5a5") + ";"
                + "font-variant-numeric:tabular-nums;font-weight:600;"
            badge.textContent = flightCount + " legs · " + ageLabel
            wrap.appendChild(badge)
        }

        const fnId = this._guessLastFlightNumberIdFromLog()
        const url = AesAfpDashboardDeepLink.buildAircraftUrl(this.server, row.aircraftId, fnId)
        const open = document.createElement("a")
        open.href = url
        open.target = "_blank"
        open.rel = "noopener"
        open.textContent = "↗ Open in AS"
        open.title = "Open this aircraft's Flight Plan page in a new tab (with ?aes-debug)"
        open.style.cssText = "color:#60a5fa;text-decoration:none;font-size:11px;"
            + "border:1px solid #374151;border-radius:4px;padding:3px 8px;"
        wrap.appendChild(open)

        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "×"
        close.title = "Close"
        close.style.cssText = "background:transparent;color:#9ca3af;border:1px solid #374151;"
            + "border-radius:4px;width:24px;height:24px;cursor:pointer;font-size:14px;line-height:1;"
        close.addEventListener("click", () => this.close())
        wrap.appendChild(close)
        return wrap
    }

    /** Track 7 slice 7f — short relative-age label for the schedule badge. */
    _ageLabel(ms) {
        if (!isFinite(ms) || ms < 0) return "?"
        const s = Math.floor(ms / 1000)
        if (s < 60)   return s + "s"
        const m = Math.floor(s / 60)
        if (m < 60)   return m + "m"
        const h = Math.floor(m / 60)
        if (h < 24)   return h + "h"
        const d = Math.floor(h / 24)
        return d + "d"
    }

    _guessLastFlightNumberIdFromLog() {
        // Best-effort: pull from the panel's in-memory log slot once we
        // have it. T1 doesn't yet have flightNumberId attached to entries
        // (that's a T2 verify-pass artifact), so this returns null today.
        return null
    }

    _renderToolbar() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;"
            + "padding:8px 12px;border-bottom:1px solid #1f2937;"

        const lbl = document.createElement("span")
        lbl.style.color = "#9ca3af"
        lbl.textContent = "Preset:"
        wrap.appendChild(lbl)

        const sel = document.createElement("select")
        sel.style.cssText = "background:#0b1220;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:3px 6px;font-size:12px;flex:1 1 200px;min-width:140px;"
        if (!this._presets.length) {
            const o = document.createElement("option")
            o.value = ""
            o.textContent = "(no presets — create on dashboard)"
            sel.appendChild(o); sel.disabled = true
        } else {
            for (const p of this._presets) {
                const o = document.createElement("option")
                o.value = p.id
                o.textContent = (p.name || "(unnamed)") + (p.hub ? " · " + p.hub : "")
                if (p.id === this._selectedPresetId) o.selected = true
                sel.appendChild(o)
            }
        }
        sel.addEventListener("change", () => { this._selectedPresetId = sel.value || null })
        wrap.appendChild(sel)

        const gen = document.createElement("button")
        gen.type = "button"
        gen.textContent = this._lastBuild ? "Regenerate" : "Generate"
        gen.disabled = !this._formContext || !this._selectedPresetId
        gen.style.cssText = "background:" + (gen.disabled ? "#374151" : "#1d4ed8") + ";"
            + "color:" + (gen.disabled ? "#9ca3af" : "#f8fafc") + ";"
            + "border:1px solid " + (gen.disabled ? "#374151" : "#1e3a8a") + ";"
            + "border-radius:3px;padding:3px 12px;font-size:12px;font-weight:600;"
            + "cursor:" + (gen.disabled ? "not-allowed" : "pointer") + ";"
        gen.addEventListener("click", () => this._onGenerate())
        wrap.appendChild(gen)

        return wrap
    }

    _renderStatusLine() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:6px 12px;color:#9ca3af;font-size:11px;"
            + "border-bottom:1px solid #1f2937;"
        const fc = this._formContext
        const parts = []
        if (fc) {
            parts.push("hub <strong style=\"color:#cbd5e1;\">" + escapeHtml(fc.currentLocationIata || "?") + "</strong>")
            parts.push("destinations available <strong style=\"color:#cbd5e1;\">" + (fc.destOptions ? fc.destOptions.length : 0) + "</strong>")
            parts.push("already scheduled <strong style=\"color:#cbd5e1;\">" + (fc.existingFlightNumberDests ? fc.existingFlightNumberDests.length : 0) + "</strong>")
        } else {
            parts.push("form context unavailable")
        }
        if (this._lastCandidates) parts.push("candidates <strong style=\"color:#cbd5e1;\">" + this._lastCandidates.length + "</strong>")
        if (this._lastBuild)      parts.push("build <strong style=\"color:#cbd5e1;\">" + ((this._lastBuild.flights || []).length) + " legs</strong>")
        wrap.innerHTML = parts.join(" · ")
        return wrap
    }

    _renderFetchError(fetchResult) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin:12px;padding:10px;background:rgba(239,68,68,0.08);"
            + "border:1px solid rgba(239,68,68,0.40);border-radius:4px;color:#fca5a5;font-size:12px;line-height:1.5;"
        const h = document.createElement("strong")
        h.textContent = "Could not fetch form context"
        h.style.cssText = "display:block;margin-bottom:4px;"
        wrap.appendChild(h)
        const msg = document.createElement("div")
        msg.textContent = (fetchResult.error && fetchResult.error.message) || "Unknown error"
        wrap.appendChild(msg)
        const url = document.createElement("div")
        url.style.cssText = "color:#6b7280;font-size:10px;margin-top:4px;"
        url.textContent = fetchResult.url || ""
        wrap.appendChild(url)
        return wrap
    }

    _renderBuildSection() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:8px 12px;"
        const hdr = document.createElement("div")
        hdr.style.cssText = "font-weight:600;color:#cbd5e1;margin-bottom:6px;font-size:11px;"
            + "text-transform:uppercase;letter-spacing:0.5px;"
        hdr.textContent = "Build preview"
        wrap.appendChild(hdr)

        if (!this._lastBuild) {
            const placeholder = document.createElement("div")
            placeholder.style.cssText = "padding:8px;border:1px dashed #374151;border-radius:4px;"
                + "color:#9ca3af;font-size:11px;line-height:1.5;"
            placeholder.textContent = this._formContext
                ? "Pick a preset and click Generate to compose a wave plan from the route candidates available at " + (this._formContext.currentLocationIata || "this aircraft's hub") + "."
                : "Form context is loading…"
            wrap.appendChild(placeholder)
            return wrap
        }

        const build = this._lastBuild
        if (Array.isArray(build.validation) && build.validation.length) {
            const box = document.createElement("div")
            box.style.cssText = "padding:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.40);"
                + "border-radius:4px;color:#fca5a5;font-size:11px;line-height:1.5;"
            const h = document.createElement("strong")
            h.textContent = "Preset is invalid:"
            h.style.cssText = "display:block;margin-bottom:4px;"
            box.appendChild(h)
            for (const err of build.validation) {
                const line = document.createElement("div")
                line.textContent = "• " + String(err)
                box.appendChild(line)
            }
            wrap.appendChild(box)
            return wrap
        }

        const flights = (build.flights) || []
        if (!flights.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:8px;color:#9ca3af;font-size:11px;font-style:italic;"
            empty.textContent = "No legs placed (see warnings/shortfall in build object)."
            wrap.appendChild(empty)
            return wrap
        }

        for (const f of flights) wrap.appendChild(this._renderLegRow(f))
        return wrap
    }

    _renderLegRow(flight) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 0;"
            + "border-bottom:1px solid #1f2937;font-size:12px;color:#cbd5e1;"

        const inbound = flight.direction === "inbound"
        const arrow = inbound ? "←" : "→"
        const dir = document.createElement("span")
        dir.style.cssText = "color:" + (inbound ? "#10b981" : "#3b82f6") + ";font-weight:700;width:12px;flex:0 0 auto;"
        dir.textContent = arrow
        row.appendChild(dir)

        const od = document.createElement("span")
        od.style.cssText = "font-weight:600;color:#f8fafc;flex:0 0 110px;"
        od.textContent = (flight.origin || "?") + " " + arrow + " " + (flight.destination || "?")
        row.appendChild(od)

        const time = document.createElement("span")
        time.style.cssText = "color:#9ca3af;flex:0 0 50px;font-variant-numeric:tabular-nums;"
        time.textContent = flight.depTimeLocal || "—"
        row.appendChild(time)

        const dist = document.createElement("span")
        dist.style.cssText = "color:#6b7280;flex:0 0 60px;text-align:right;font-size:10px;"
        dist.textContent = flight.distanceNm ? Math.round(flight.distanceNm) + "nm" : "—"
        row.appendChild(dist)

        const spacer = document.createElement("span")
        spacer.style.flex = "1 1 auto"
        row.appendChild(spacer)

        const dryBtn = document.createElement("button")
        dryBtn.type = "button"
        dryBtn.textContent = "Dry-run"
        dryBtn.title = "Compose the AS POST body for this leg and append it to the audit log without sending."
        dryBtn.style.cssText = "background:#0b1220;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;flex:0 0 auto;"
        dryBtn.addEventListener("click", () => this._onDryRunLeg(flight, row))
        row.appendChild(dryBtn)

        return row
    }

    _renderRecentLog() {
        const wrap = document.createElement("details")
        wrap.style.cssText = "padding:6px 12px;border-top:1px solid #1f2937;"
        const sum = document.createElement("summary")
        sum.style.cssText = "cursor:pointer;color:#9ca3af;font-size:11px;padding:2px 0;"
        sum.textContent = "▸ Recent applies (last 10)"
        wrap.appendChild(sum)
        const body = document.createElement("div")
        body.style.cssText = "padding-top:6px;"
        body.dataset.aesAfpDashLog = "1"
        wrap.appendChild(body)
        wrap.addEventListener("toggle", async () => {
            if (!wrap.open || !this.applyLog || !this._row) return
            const r = await this.applyLog.getForAircraft(this.server, this._row.aircraftId, 10)
            body.innerHTML = ""
            if (!r.entries.length) {
                const e = document.createElement("div")
                e.style.cssText = "color:#6b7280;font-size:11px;font-style:italic;"
                e.textContent = "No applies yet for this aircraft."
                body.appendChild(e)
                return
            }
            for (const entry of r.entries) body.appendChild(this._renderLogEntry(entry))
        })
        return wrap
    }

    _renderLogEntry(entry) {
        const div = document.createElement("div")
        div.style.cssText = "padding:4px 0;border-bottom:1px solid #1f2937;font-size:11px;line-height:1.5;"

        const head = document.createElement("div")
        const statusColor = entry.status === "verified" ? "#10b981"
            : entry.status === "posted"   ? "#fbbf24"
            : entry.status === "dry-run"  ? "#60a5fa"
            : entry.status === "aborted"  ? "#9ca3af"
            : entry.status === "failed"   ? "#f87171"
            : "#cbd5e1"
        const ts = entry.ts ? new Date(entry.ts).toLocaleString() : ""
        const leg = entry.leg || {}
        head.innerHTML = "<span style=\"color:" + statusColor + ";font-weight:700;text-transform:uppercase;\">"
            + escapeHtml(entry.status || "?") + "</span>"
            + " <span style=\"color:#cbd5e1;\">" + escapeHtml(leg.origin || "?") + " → " + escapeHtml(leg.destination || "?") + "</span>"
            + " <span style=\"color:#9ca3af;\">" + escapeHtml(leg.depTime || "") + "</span>"
            + (entry.count > 1 ? " <span style=\"color:#fbbf24;\">×" + entry.count + "</span>" : "")
            + " <span style=\"color:#6b7280;float:right;\">" + escapeHtml(ts) + "</span>"
        div.appendChild(head)

        if (entry.bodyPreview) {
            const det = document.createElement("details")
            det.style.cssText = "margin-top:2px;"
            const s = document.createElement("summary")
            s.textContent = "POST body preview"
            s.style.cssText = "cursor:pointer;color:#6b7280;font-size:10px;"
            const pre = document.createElement("pre")
            pre.style.cssText = "margin:4px 0 0;padding:6px;background:#0b1220;color:#e2e8f0;"
                + "font-size:10px;line-height:1.4;overflow:auto;max-height:160px;border-radius:3px;border:1px solid #1f2937;"
            pre.textContent = String(entry.bodyPreview).split("&").join("\n")
            det.appendChild(s); det.appendChild(pre)
            div.appendChild(det)
        }
        if (entry.error && entry.error.message) {
            const err = document.createElement("div")
            err.style.cssText = "color:#fca5a5;font-size:10px;margin-top:2px;"
            err.textContent = "✘ " + entry.error.message
            div.appendChild(err)
        }
        return div
    }

    _renderGateFooter() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:8px 12px;border-top:1px solid #1f2937;color:#9ca3af;"
            + "font-size:11px;display:flex;align-items:center;gap:8px;background:#0b1220;"
        wrap.innerHTML = "<span>🔒</span>"
            + "<span><strong style=\"color:#cbd5e1;\">Tier 1 — dry-run only.</strong> "
            + "<code style=\"color:#fbbf24;\">dryRunOnly=true</code> · "
            + "<code style=\"color:#fbbf24;\">applyEnabled=false</code>. "
            + "Live submit unlocks in Tier 2.</span>"
        return wrap
    }

    // ----- Actions -------------------------------------------------------

    async _onGenerate() {
        if (!this.pipeline)        return
        if (!this._formContext)    return
        if (!this._selectedPresetId) return

        const r = await this.pipeline.generateBuild({
            aircraftId:  this._row.aircraftId,
            formContext: this._formContext,
            presetId:    this._selectedPresetId,
            typeId:      this._row.typeId
        })

        if (!r.ok) {
            const root = this._rootEl
            // Insert the error in place of the build section (re-render once
            // the user generates again the build will replace the error).
            this._lastBuild = null
            this._lastCandidates = null
            this._render({phase: "ready"})
            const banner = document.createElement("div")
            banner.style.cssText = "margin:0 12px 8px;padding:8px;"
                + "background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.40);"
                + "border-radius:4px;color:#fca5a5;font-size:11px;line-height:1.5;"
            banner.textContent = (r.error && r.error.message) || "Generate failed"
            root.appendChild(banner)
            return
        }
        this._lastBuild      = r.build
        this._lastCandidates = r.candidates
        this._render({phase: "ready"})
    }

    async _onDryRunLeg(flight, rowEl) {
        if (!this.applier || !this._formContext) return
        const leg = {
            origin:      flight.origin || (this._formContext.currentLocationIata || null),
            destination: flight.destination,
            depTime:     flight.depTimeLocal,
            pricePct:    100,
            service:     ""
        }
        const result = await this.applier.apply(this._row.aircraftId, leg, {
            source:      "dashboard-dry-run",
            formContext: this._formContext
        })
        // Inline expander beneath the leg row so the user can see the body
        // without scrolling to the audit log.
        const old = rowEl.nextSibling && rowEl.nextSibling.dataset
            && rowEl.nextSibling.dataset.aesAfpInline === "1"
            ? rowEl.nextSibling : null
        if (old && old.parentElement) old.parentElement.removeChild(old)

        const expand = document.createElement("div")
        expand.dataset.aesAfpInline = "1"
        expand.style.cssText = "padding:6px 12px 8px 24px;font-size:11px;"
            + "background:#0b1220;border-bottom:1px solid #1f2937;"
        const summary = document.createElement("div")
        const statusColor = result.status === "dry-run" ? "#60a5fa"
            : result.status === "aborted" ? "#fbbf24" : "#f87171"
        summary.innerHTML = "<span style=\"color:" + statusColor + ";font-weight:700;text-transform:uppercase;\">"
            + escapeHtml(result.status) + "</span>"
            + " <span style=\"color:#cbd5e1;\">" + escapeHtml(leg.origin || "?") + " → " + escapeHtml(leg.destination || "?") + "</span>"
        expand.appendChild(summary)
        if (result.bodyPreview) {
            const pre = document.createElement("pre")
            pre.style.cssText = "margin:4px 0 0;padding:6px;background:#0f1623;color:#e2e8f0;"
                + "font-size:10px;line-height:1.4;overflow:auto;max-height:160px;border-radius:3px;border:1px solid #1f2937;"
            pre.textContent = String(result.bodyPreview).split("&").join("\n")
            expand.appendChild(pre)
        }
        if (result.blockers && result.blockers.length) {
            const div = document.createElement("div")
            div.style.cssText = "color:#fca5a5;font-size:10px;margin-top:4px;"
            div.textContent = "Blockers: " + result.blockers.map(b => b.code).join(", ")
            expand.appendChild(div)
        }
        if (result.error && result.error.message) {
            const div = document.createElement("div")
            div.style.cssText = "color:#fca5a5;font-size:10px;margin-top:2px;"
            div.textContent = "✘ " + result.error.message
            expand.appendChild(div)
        }
        rowEl.parentElement.insertBefore(expand, rowEl.nextSibling)
    }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardPanel = AesAfpDashboardPanel
}
