"use strict"

/**
 * AES Strategy — service-experiment store (Slice 7 A/B layer).
 *
 * Persists active + concluded service-profile A/B experiments. Each record
 * tracks a base profile, the perturbation profile we cloned from it, the
 * route partition (assigned vs. control), the current state, and (once the
 * window elapses) the per-arm outcome deltas the tuner reads to declare a
 * winner.
 *
 * Storage key (per account):
 *   aesStrategy:serviceExperiments:acct:<id>
 *   aesStrategy:serviceExperiments  ← legacy / pre-account fallback
 *
 * Ring cap 32 — covers a year of weekly experiments at one-per-week
 * cadence with headroom for concurrent ones. Oldest evicted on overflow,
 * favouring concluded/consolidated/rolled-back records before active ones.
 *
 * Record shape:
 *   {
 *     experimentId:           "se-<base36-ts>-<rand>",
 *     baseProfileId:          number,
 *     baseProfileName:        string,
 *     perturbationProfileId:  number | null,
 *     perturbationProfileName:string | null,
 *     perturbationChanges:    {<categoryKey>: {Y?, C?, F?}},
 *     assignedRouteKeys:      ["HUB-DEST", ...],
 *     controlRouteKeys:       ["HUB-DEST", ...],
 *     startedAt:              ms epoch,
 *     expectedConcludeAt:     ms epoch,
 *     state:                  "active" | "concluded" | "consolidated"
 *                            | "rolled-back" | "cancelled",
 *     outcome:                null | {orsDeltaAssigned, orsDeltaControl,
 *                                     profitDelta, lfDelta, confidence,
 *                                     winner: "perturbation"|"base"|"tie",
 *                                     measuredAt},
 *     accountId:              string | null,
 *     server:                 string | null,
 *     airlineCode:            string | null,
 *     history:                [{ts, transition, reason}]
 *   }
 *
 * Public API (window.AesServiceExperimentStore):
 *   append(record, ctx?)           → Promise<record>
 *   update(experimentId, patch, ctx?)→ Promise<record|null>
 *   all(ctx?)                       → Promise<record[]>
 *   active(ctx?)                    → Promise<record[]>
 *   findByProfile(baseProfileId, ctx?)→ Promise<record|null>
 *   findById(experimentId, ctx?)    → Promise<record|null>
 *   clear(ctx?)                     → Promise<void>
 *   newExperimentId()               → string
 *
 * `ctx` is `{accountId?}` — caller passes the resolved account id when
 * known to scope the read/write; missing ctx falls back to legacy slot.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesServiceExperimentStore) return

    const KEY      = "aesStrategy:serviceExperiments"
    const RING_CAP = 32

    // Phase B4 — durable outcomes ring. Concluded experiments are copied
    // here in addition to the active ring so they survive eviction past
    // RING_CAP. Append-only; larger cap covers ~4 years of weekly
    // experiments. Read by Phase D2's weekly-review tile.
    const OUTCOMES_KEY     = "aesStrategy:serviceExperiments:outcomes"
    const OUTCOMES_CAP     = 200

    const ACTIVE_STATE = "active"
    const TERMINAL_STATES = ["concluded", "consolidated", "rolled-back", "cancelled"]

    function _scopedKey(accountId) {
        return accountId ? KEY + ":acct:" + accountId : KEY
    }

    function _outcomesKey(accountId) {
        return accountId ? OUTCOMES_KEY + ":acct:" + accountId : OUTCOMES_KEY
    }

    async function _appendOutcome(record, accountId) {
        if (!record || TERMINAL_STATES.indexOf(record.state) < 0) return
        if (!record.outcome) return
        try {
            const key = _outcomesKey(accountId)
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key].slice() : []
            const idx = ring.findIndex(r => r && r.experimentId === record.experimentId)
            const slim = {
                experimentId:           record.experimentId,
                baseProfileId:          record.baseProfileId,
                baseProfileName:        record.baseProfileName,
                perturbationProfileId:  record.perturbationProfileId,
                perturbationProfileName:record.perturbationProfileName,
                state:                  record.state,
                startedAt:              record.startedAt,
                concludedAt:            Date.now(),
                outcome:                record.outcome,
                accountId:              record.accountId || accountId || null,
                server:                 record.server || null
            }
            if (idx >= 0) ring[idx] = slim
            else ring.unshift(slim)
            if (ring.length > OUTCOMES_CAP) ring.length = OUTCOMES_CAP
            await chrome.storage.local.set({[key]: ring})
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit("data:strategy:serviceExperiment:concluded", {
                    experimentId: record.experimentId,
                    state:        record.state,
                    winner:       record.outcome.winner || null
                })
            }
        } catch (e) {
            console.warn("[AesServiceExperimentStore] appendOutcome failed", e)
        }
    }

    function _newId() {
        return "se-" + Date.now().toString(36) + "-"
            + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
    }

    async function _readRing(accountId) {
        try {
            const key = _scopedKey(accountId)
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key].slice() : []
            if (ring.length || !accountId) return ring
            const fb = await chrome.storage.local.get([KEY])
            return Array.isArray(fb[KEY]) ? fb[KEY].slice() : []
        } catch (e) {
            console.warn("[AesServiceExperimentStore] readRing failed", e)
            return []
        }
    }

    async function _writeRing(ring, accountId) {
        try {
            const writes = {}
            writes[_scopedKey(accountId)] = ring
            if (!accountId) writes[KEY] = ring
            await chrome.storage.local.set(writes)
        } catch (e) {
            console.warn("[AesServiceExperimentStore] writeRing failed", e)
        }
    }

    function _evict(ring) {
        if (ring.length <= RING_CAP) return ring
        const terminal = []
        const active   = []
        for (const r of ring) {
            if (r && TERMINAL_STATES.indexOf(r.state) >= 0) terminal.push(r)
            else active.push(r)
        }
        terminal.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
        active.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
        const next = active.concat(terminal)
        if (next.length > RING_CAP) next.length = RING_CAP
        next.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        return next
    }

    async function append(record, ctx) {
        if (!record || !record.baseProfileId) {
            throw new Error("AesServiceExperimentStore.append: baseProfileId required")
        }
        const accountId = (ctx && ctx.accountId) || record.accountId || null
        const ring = await _readRing(accountId)
        const stamped = Object.assign({
            experimentId: _newId(),
            state:        ACTIVE_STATE,
            startedAt:    Date.now(),
            outcome:      null,
            history:      []
        }, record, {accountId: accountId})
        if (!stamped.history.length) {
            stamped.history = [{
                ts:         stamped.startedAt,
                transition: "spawned",
                reason:     record._reason || "tuner-evaluate"
            }]
        }
        delete stamped._reason
        ring.unshift(stamped)
        const next = _evict(ring)
        await _writeRing(next, accountId)
        return stamped
    }

    async function update(experimentId, patch, ctx) {
        if (!experimentId) return null
        const accountId = (ctx && ctx.accountId) || null
        const ring = await _readRing(accountId)
        const idx = ring.findIndex(r => r && r.experimentId === experimentId)
        if (idx < 0) return null
        const prev = ring[idx]
        const next = Object.assign({}, prev, patch || {})
        if (patch && patch.state && patch.state !== prev.state) {
            const hist = Array.isArray(prev.history) ? prev.history.slice() : []
            hist.push({
                ts:         Date.now(),
                transition: prev.state + " → " + patch.state,
                reason:     patch._reason || null
            })
            next.history = hist
        }
        delete next._reason
        ring[idx] = next
        await _writeRing(ring, accountId)
        // Phase B4 — copy concluded outcomes to the durable ring so the
        // weekly review (Phase D2) keeps them past the 32-cap eviction.
        if (TERMINAL_STATES.indexOf(next.state) >= 0 && next.state !== prev.state) {
            await _appendOutcome(next, accountId)
        }
        return next
    }

    /**
     * Phase B4 — read durable outcomes (concluded experiments only).
     * Independent of the active 32-cap ring so a long-running review
     * tile or post-hoc analysis can pull months of history.
     */
    async function outcomes(ctx) {
        const accountId = (ctx && ctx.accountId) || null
        try {
            const key = _outcomesKey(accountId)
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key].slice() : []
            if (ring.length || !accountId) return ring
            const fb = await chrome.storage.local.get([OUTCOMES_KEY])
            return Array.isArray(fb[OUTCOMES_KEY]) ? fb[OUTCOMES_KEY].slice() : []
        } catch (e) {
            console.warn("[AesServiceExperimentStore] outcomes failed", e)
            return []
        }
    }

    async function all(ctx) {
        const accountId = (ctx && ctx.accountId) || null
        const ring = await _readRing(accountId)
        return ring.slice()
    }

    async function active(ctx) {
        const ring = await all(ctx)
        return ring.filter(r => r && r.state === ACTIVE_STATE)
    }

    async function findByProfile(baseProfileId, ctx) {
        if (baseProfileId == null) return null
        const want = Number(baseProfileId)
        const ring = await all(ctx)
        for (const r of ring) {
            if (r && Number(r.baseProfileId) === want && r.state === ACTIVE_STATE) return r
        }
        return null
    }

    async function findById(experimentId, ctx) {
        if (!experimentId) return null
        const ring = await all(ctx)
        return ring.find(r => r && r.experimentId === experimentId) || null
    }

    async function clear(ctx) {
        const accountId = (ctx && ctx.accountId) || null
        const keys = [_scopedKey(accountId)]
        if (!accountId) keys.push(KEY)
        try { await chrome.storage.local.remove(keys) }
        catch (e) { console.warn("[AesServiceExperimentStore] clear failed", e) }
    }

    window.AesServiceExperimentStore = {
        append:          append,
        update:          update,
        all:             all,
        active:          active,
        outcomes:        outcomes,
        findByProfile:   findByProfile,
        findById:        findById,
        clear:           clear,
        newExperimentId: _newId,
        KEY:             KEY,
        OUTCOMES_KEY:    OUTCOMES_KEY,
        RING_CAP:        RING_CAP,
        OUTCOMES_CAP:    OUTCOMES_CAP,
        ACTIVE_STATE:    ACTIVE_STATE,
        TERMINAL_STATES: TERMINAL_STATES.slice()
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            ;(async function () {
                await clear()
                const r1 = await append({
                    baseProfileId: 1, baseProfileName: "Base",
                    perturbationProfileId: 99, perturbationProfileName: "Base+s7",
                    perturbationChanges: {drinks: {Y: 3}},
                    assignedRouteKeys: ["FRA-LHR"], controlRouteKeys: ["FRA-CDG"],
                    expectedConcludeAt: Date.now() + 7 * 86400000
                })
                console.assert(r1 && r1.experimentId && r1.state === "active",
                    "[smoke se-store] append returns active record with id")
                const found = await findByProfile(1)
                console.assert(found && found.experimentId === r1.experimentId,
                    "[smoke se-store] findByProfile returns the active record")
                const u1 = await update(r1.experimentId, {state: "concluded",
                    outcome: {orsDeltaAssigned: 0.04, orsDeltaControl: 0.01,
                              profitDelta: 12000, lfDelta: 0.02,
                              confidence: "medium", winner: "perturbation",
                              measuredAt: Date.now()},
                    _reason: "window-elapsed"})
                console.assert(u1 && u1.state === "concluded" && u1.outcome.winner === "perturbation",
                    "[smoke se-store] update transitions to concluded with outcome")
                console.assert(u1.history.length >= 2,
                    "[smoke se-store] history records the transition")
                const stillActive = await active()
                console.assert(stillActive.length === 0,
                    "[smoke se-store] concluded experiment dropped from active()")
                await clear()
            })().catch(e => console.warn("[smoke se-store] threw", e))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
