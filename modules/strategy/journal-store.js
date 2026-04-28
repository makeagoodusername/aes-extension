"use strict"

/**
 * AES Strategy — Journal store (Slice 26 Phase 1).
 *
 * One per-account ring of narrative entries: every override save, note,
 * watchlist toggle, applied strategy decision, and weight change lands
 * here as a single chronological row. The journal is the unified
 * narrative the user reads to understand "what's been tried" — distinct
 * from the audit ring (which carries full apply envelopes) and the
 * outcomes ring (which carries before/after measurements).
 *
 * Storage:
 *   aesStrategy:journal                     ← legacy unscoped (read-only fallback)
 *   aesStrategy:journal:acct:<accountId>    ← per-airline ring (cap 750)
 *
 * Eviction order in the strategy namespace soft-cap (1 MB):
 *   learn:outcomes → audit → JOURNAL → learn:weights:history → backtest:results
 *   (slots between audit and weights:history; documented in
 *    docs/STRATEGY-ROADMAP.md §IV and docs/NORTH-STAR.md §4.10.)
 *
 * Entry shape (locked for v1):
 *   {
 *     id:          "jrn-<base36-ts>-<rand>",
 *     ts:          number,                              // ms epoch
 *     accountId:   string | null,
 *     server:      string | null,
 *     airline:     string | null,
 *     action:      "override-save" | "note-save" | "watchlist-toggle"
 *                | "apply-decision" | "weight-change",
 *     route:       "<HUB>-<DEST>" | null,
 *     before:      <action-shaped> | null,
 *     after:       <action-shaped> | null,
 *     source:      "passive" | "apply-pipeline" | "learn" | "panel",
 *     reasonText:  string | null,                       // ≤200 chars; settable post-hoc
 *     // Phase 2/3 reserved slots (undefined in v1, must NOT be repurposed):
 *     voiceMemoId: undefined,
 *     outcomeRef:  undefined,
 *     tags:        undefined
 *   }
 *
 * Public API (window.AesStrategyJournal):
 *   record(opts)             → Promise<entry>
 *   addReason(id, text)      → Promise<entry | null>
 *   loadAll(accountId?)      → Promise<entry[]>            (newest first)
 *   clear(accountId?)        → Promise<void>
 *   init()                   → void                        (idempotent)
 *   bus                      → {on, off, emit}             (entry-recorded / reason-updated)
 *
 * Subscription model is HYBRID:
 *   - PASSIVE via chrome.storage.onChanged for override / note / watchlist
 *     writes (the storage event already carries enough context).
 *   - ACTIVE via direct record() calls from apply-pipeline.js (per
 *     applied decision) and learn.js (per weight change). These two sites
 *     own rich semantic context (rationale strings, gradient values) that
 *     would be lost if reconstructed from oldValue / newValue diffs.
 *
 * Account-scoping rule (Class B per North Star §4.14): each airline's
 * journal is isolated; sister airlines never see each other's narrative.
 * accountId is derived from the storage key's `:acct:<id>:` segment for
 * passive sources, or computed via AesAccountRegistry for active sources.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyJournal) return

    const KEY      = "aesStrategy:journal"
    const RING_CAP = 750
    const REASON_MAX = 200

    const ACTIONS = new Set([
        "override-save", "note-save", "watchlist-toggle",
        "apply-decision", "weight-change"
    ])

    // ── Tiny event bus (mirrors modules/aircraft-flight-plan/host.js:63) ─
    function _createBus() {
        const handlers = new Map()
        return {
            on(name, h) {
                if (typeof h !== "function") return
                let set = handlers.get(name)
                if (!set) { set = new Set(); handlers.set(name, set) }
                set.add(h)
            },
            off(name, h) {
                const set = handlers.get(name)
                if (set) set.delete(h)
            },
            emit(name, payload) {
                const set = handlers.get(name)
                if (!set) return
                for (const h of Array.from(set)) {
                    try { h(payload) } catch (e) {
                        console.warn("[AesStrategyJournal] bus handler threw for '" + name + "'", e)
                    }
                }
            }
        }
    }
    const bus = _createBus()

    // ── Helpers ─────────────────────────────────────────────────────────
    function _entryId() {
        return "jrn-" + Date.now().toString(36) + "-"
            + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
    }
    function _scopedKey(accountId) {
        return accountId ? KEY + ":acct:" + accountId : KEY
    }
    function _resolveAccountId(arg) {
        if (typeof arg === "string" && arg) return arg
        if (typeof window !== "undefined" && window.__aesAccountId) return window.__aesAccountId
        return null
    }
    /**
     * Pull the accountId out of a scoped storage key. Returns null for
     * legacy unscoped keys; callers can fall through to the registry then.
     */
    function _accountIdFromKey(key) {
        if (typeof key !== "string") return null
        const m = key.match(/:acct:([^:]+)/)
        return m ? m[1] : null
    }
    function _trimReason(text) {
        if (text == null) return null
        const s = String(text).trim()
        if (!s) return null
        return s.length > REASON_MAX ? s.slice(0, REASON_MAX) : s
    }

    // ── Storage IO ──────────────────────────────────────────────────────
    async function loadAll(accountId) {
        try {
            const id  = _resolveAccountId(accountId)
            const key = _scopedKey(id)
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key].slice() : []
            if (ring.length || !id) return ring
            // Scoped miss → read legacy ring once so prior entries surface
            // for the active account during the rollout window.
            const fb = await chrome.storage.local.get([KEY])
            return Array.isArray(fb[KEY]) ? fb[KEY].slice() : []
        } catch (e) {
            console.warn("[AesStrategyJournal] loadAll failed", e)
            return []
        }
    }

    async function _save(ring, accountId) {
        try {
            const writes = {}
            if (accountId) {
                writes[_scopedKey(accountId)] = ring
            } else {
                writes[KEY] = ring
            }
            await chrome.storage.local.set(writes)
        } catch (e) {
            console.warn("[AesStrategyJournal] save failed", e)
        }
    }

    /**
     * Build a clean, schema-locked entry. Any extra keys callers pass are
     * dropped — the schema is the contract Phase 2's lesson miner reads.
     */
    function _normalize(opts) {
        const o = opts || {}
        if (!ACTIONS.has(o.action)) {
            throw new Error("AesStrategyJournal.record: invalid action " + o.action)
        }
        return {
            id:         o.id || _entryId(),
            ts:         Number(o.ts) > 0 ? Number(o.ts) : Date.now(),
            accountId:  o.accountId != null ? String(o.accountId) : null,
            server:     o.server  != null ? String(o.server)  : null,
            airline:    o.airline != null ? String(o.airline) : null,
            action:     o.action,
            route:      o.route   != null ? String(o.route)   : null,
            before:     o.before  != null ? o.before          : null,
            after:      o.after   != null ? o.after           : null,
            source:     typeof o.source === "string" && o.source ? o.source : "panel",
            reasonText: _trimReason(o.reasonText)
        }
    }

    async function record(opts) {
        const entry = _normalize(opts)
        // accountId resolution for active sources that didn't pass one in:
        // fall back to the page-scope id so single-airline installs land
        // in the scoped ring once bootstrap resolves.
        const accountId = entry.accountId || _resolveAccountId(null)
        if (accountId && !entry.accountId) entry.accountId = accountId

        const ring = await loadAll(accountId)
        ring.unshift(entry)
        if (ring.length > RING_CAP) ring.length = RING_CAP
        await _save(ring, accountId)
        bus.emit("journal:entry-recorded", entry)
        return entry
    }

    async function addReason(id, text, accountId) {
        if (!id) return null
        const acct = _resolveAccountId(accountId)
        const ring = await loadAll(acct)
        const i = ring.findIndex(e => e && e.id === id)
        if (i < 0) return null
        ring[i] = Object.assign({}, ring[i], {reasonText: _trimReason(text)})
        await _save(ring, acct)
        bus.emit("journal:reason-updated", ring[i])
        return ring[i]
    }

    async function clear(accountId) {
        try {
            const acct = _resolveAccountId(accountId)
            const keys = acct ? [KEY, _scopedKey(acct)] : [KEY]
            await chrome.storage.local.remove(keys)
        } catch (e) {
            console.warn("[AesStrategyJournal] clear failed", e)
        }
    }

    // ── Passive subscriber ──────────────────────────────────────────────
    /**
     * Translate a chrome.storage.onChanged event for one of the three
     * passive sources into a journal entry. Returns null when the key
     * isn't one we track or the diff carries no meaningful change.
     */
    function _interpretChange(key, change) {
        if (typeof key !== "string") return null
        const oldV = change && change.oldValue
        const newV = change && change.newValue
        const accountId = _accountIdFromKey(key)

        // route-overrides-store → routeAssistant:override(:acct:<id>)?:<HUB>-<DEST>
        let m = key.match(/^routeAssistant:override(?::acct:[^:]+)?:([A-Z0-9]{3,4}-[A-Z0-9]{3,4})$/)
        if (m) {
            return {
                action:    "override-save",
                route:     m[1],
                before:    oldV ? _cleanOverride(oldV) : null,
                after:     newV ? _cleanOverride(newV) : null,
                accountId: accountId,
                source:    "passive"
            }
        }

        // route-note-store → routeAssistant:routeNote(:acct:<id>)?:<HUB>-<DEST>
        m = key.match(/^routeAssistant:routeNote(?::acct:[^:]+)?:([A-Z0-9]{3,4}-[A-Z0-9]{3,4})$/)
        if (m) {
            return {
                action:    "note-save",
                route:     m[1],
                before:    oldV && oldV.text ? {text: String(oldV.text).slice(0, REASON_MAX)} : null,
                after:     newV && newV.text ? {text: String(newV.text).slice(0, REASON_MAX)} : null,
                accountId: accountId,
                source:    "passive"
            }
        }

        // watchlist-store → routeAssistant:watchlist(:acct:<id>)?
        m = key.match(/^routeAssistant:watchlist(?::acct:[^:]+)?$/)
        if (m) {
            const oldRoutes = (oldV && Array.isArray(oldV.routes)) ? oldV.routes.map(_routeId) : []
            const newRoutes = (newV && Array.isArray(newV.routes)) ? newV.routes.map(_routeId) : []
            const oldSet = new Set(oldRoutes), newSet = new Set(newRoutes)
            const added   = newRoutes.find(r => r && !oldSet.has(r))
            const removed = oldRoutes.find(r => r && !newSet.has(r))
            if (added) {
                return {action: "watchlist-toggle", route: added,
                        before: {starred: false}, after: {starred: true},
                        accountId: accountId, source: "passive"}
            }
            if (removed) {
                return {action: "watchlist-toggle", route: removed,
                        before: {starred: true}, after: {starred: false},
                        accountId: accountId, source: "passive"}
            }
            return null
        }
        return null
    }

    function _cleanOverride(rec) {
        if (!rec || typeof rec !== "object") return null
        const out = {}
        for (const k of ["paxLF", "cargoLF", "yieldPerKm", "cargoYieldPerKgKm", "expiresAt"]) {
            if (typeof rec[k] === "number" && isFinite(rec[k])) out[k] = rec[k]
        }
        if (typeof rec.note === "string" && rec.note) out.note = rec.note.slice(0, REASON_MAX)
        return Object.keys(out).length ? out : null
    }
    function _routeId(r) {
        if (!r || typeof r !== "object") return null
        if (r.hub && r.dest) return r.hub + "-" + r.dest
        if (r.route) return String(r.route)
        return null
    }

    function _onChanged(changes, area) {
        if (area !== "local") return
        for (const key of Object.keys(changes)) {
            const partial = _interpretChange(key, changes[key])
            if (!partial) continue
            // Fire and forget; record() handles its own errors. Synthesize
            // server/airline are unknown for passive sources — leave null.
            record(partial).catch(_ => {})
        }
    }

    let _subscriberAttached = false
    function _attachSubscriber() {
        if (_subscriberAttached) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        try {
            chrome.storage.onChanged.addListener(_onChanged)
            _subscriberAttached = true
        } catch (e) {
            console.warn("[AesStrategyJournal] failed to attach storage subscriber", e)
        }
    }

    // ── Catch-up scan ───────────────────────────────────────────────────
    /**
     * On first init, back-fill journal entries for override / note writes
     * that happened while no strategy-loaded tab was open. Cheap because
     * we only scan two key prefixes and only re-record records whose
     * `updatedAt` is newer than the journal's most-recent entry of that
     * action.
     */
    async function _catchUpScan() {
        try {
            const acct = _resolveAccountId(null)
            const ring = await loadAll(acct)
            const lastByAction = {}
            for (const e of ring) {
                if (!lastByAction[e.action] || e.ts > lastByAction[e.action]) {
                    lastByAction[e.action] = e.ts
                }
            }
            const all = await chrome.storage.local.get(null)
            const overrides = []
            const notes = []
            for (const k of Object.keys(all)) {
                if (/^routeAssistant:override(?::acct:[^:]+)?:[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(k)) {
                    overrides.push({key: k, val: all[k]})
                } else if (/^routeAssistant:routeNote(?::acct:[^:]+)?:[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(k)) {
                    notes.push({key: k, val: all[k]})
                }
            }
            const sinceOverride = lastByAction["override-save"] || 0
            for (const {key, val} of overrides) {
                const updatedAt = (val && val.updatedAt) || 0
                if (!updatedAt || updatedAt <= sinceOverride) continue
                const m = key.match(/:([A-Z0-9]{3,4}-[A-Z0-9]{3,4})$/)
                if (!m) continue
                await record({
                    action:     "override-save",
                    route:      m[1],
                    before:     null,
                    after:      _cleanOverride(val),
                    accountId:  _accountIdFromKey(key),
                    source:     "passive",
                    ts:         updatedAt
                })
            }
            const sinceNote = lastByAction["note-save"] || 0
            for (const {key, val} of notes) {
                const updatedAt = (val && val.updatedAt) || 0
                if (!updatedAt || updatedAt <= sinceNote) continue
                const m = key.match(/:([A-Z0-9]{3,4}-[A-Z0-9]{3,4})$/)
                if (!m) continue
                await record({
                    action:     "note-save",
                    route:      m[1],
                    before:     null,
                    after:      val && val.text ? {text: String(val.text).slice(0, REASON_MAX)} : null,
                    accountId:  _accountIdFromKey(key),
                    source:     "passive",
                    ts:         updatedAt
                })
            }
        } catch (e) {
            console.warn("[AesStrategyJournal] catch-up scan failed", e)
        }
    }

    let _catchUpRan = false
    function init() {
        _attachSubscriber()
        if (!_catchUpRan) {
            _catchUpRan = true
            // Defer one tick so the page bootstrap has a chance to set
            // window.__aesAccountId before we resolve it.
            setTimeout(() => { _catchUpScan() }, 0)
        }
    }

    window.AesStrategyJournal = {
        record:     record,
        addReason:  addReason,
        loadAll:    loadAll,
        clear:      clear,
        init:       init,
        bus:        bus,
        KEY:        KEY,
        RING_CAP:   RING_CAP,
        ACTIONS:    Array.from(ACTIONS),
        // Pure helpers exposed for ?aes-debug smoke + future tests.
        _interpretChange: _interpretChange,
        _entryId:         _entryId,
        _trimReason:      _trimReason
    }

    // Auto-init at load. The strategy bundle loads on dashboard + fleets;
    // either page mounting is enough to start catching writes from any
    // other tab via chrome.storage.onChanged.
    init()

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const id = _entryId()
            console.assert(/^jrn-[0-9a-z]+-[0-9a-z]{4}$/.test(id), "[smoke journal] id shape")
            console.assert(_trimReason("  ") === null,             "[smoke journal] empty reason → null")
            console.assert(_trimReason("a".repeat(300)).length === REASON_MAX,
                "[smoke journal] reason capped at " + REASON_MAX)

            const ovChange = _interpretChange("routeAssistant:override:acct:abc:JFK-LAX",
                {oldValue: {paxLF: 0.8}, newValue: {paxLF: 0.85}})
            console.assert(ovChange && ovChange.action === "override-save"
                        && ovChange.route === "JFK-LAX" && ovChange.accountId === "abc"
                        && ovChange.after.paxLF === 0.85,
                "[smoke journal] override change parsed")

            const nChange = _interpretChange("routeAssistant:routeNote:JFK-LAX",
                {oldValue: null, newValue: {text: "watchlist"}})
            console.assert(nChange && nChange.action === "note-save"
                        && nChange.route === "JFK-LAX" && nChange.accountId === null
                        && nChange.after.text === "watchlist",
                "[smoke journal] note change parsed (legacy unscoped)")

            const wAdd = _interpretChange("routeAssistant:watchlist:acct:zz",
                {oldValue: {routes: [{hub: "JFK", dest: "LAX"}]},
                 newValue: {routes: [{hub: "JFK", dest: "LAX"}, {hub: "ORD", dest: "DFW"}]}})
            console.assert(wAdd && wAdd.action === "watchlist-toggle" && wAdd.route === "ORD-DFW"
                        && wAdd.after.starred === true,
                "[smoke journal] watchlist add detected")

            const wRem = _interpretChange("routeAssistant:watchlist",
                {oldValue: {routes: [{hub: "JFK", dest: "LAX"}, {hub: "ORD", dest: "DFW"}]},
                 newValue: {routes: [{hub: "JFK", dest: "LAX"}]}})
            console.assert(wRem && wRem.route === "ORD-DFW" && wRem.after.starred === false,
                "[smoke journal] watchlist remove detected")

            const ignored = _interpretChange("routeAssistant:somethingElse:JFK-LAX",
                {oldValue: 1, newValue: 2})
            console.assert(ignored === null, "[smoke journal] unrelated key ignored")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
