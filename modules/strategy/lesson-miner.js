"use strict"

/**
 * AES Strategy — Lesson Miner (Slice 26 Phase 2).
 *
 * Joins `aesStrategy:journal:acct:<id>` × `aesStrategy:learn:outcomes(:acct:<id>)`
 * via the journal entry's reserved `outcomeRef` slot. Buckets every
 * `apply-decision` entry by route attributes (distance band, incumbent
 * band, hub, equipment family), counts favourable / unfavourable
 * outcomes per bucket, and ranks lifts by `|lift| × √n`. Returns the top
 * K lessons.
 *
 * The miner is a pure function — no DOM, no I/O, no chrome.storage. Caller
 * persists the result to `aesStrategy:lessons:<acctKey>` and emits
 * `data:strategy:lesson:mined` on the bus.
 *
 * The `outcomeRef` field on journal entries is stamped by
 * `apply-pipeline.js` after `AesStrategyOutcomes.record()` returns the
 * fresh `outcomeId`. Earlier (Phase 1) journal entries have undefined
 * outcomeRef; they fall through to the global pool only.
 *
 * Public API (window.AesStrategyLessonMiner):
 *   .mine({journal, outcomes, opts}) → {lessons[], stats}        (pure)
 *   .loadAll(accountId?)             → Promise<lesson[]>
 *   .runOnce(accountId?)             → Promise<{count, top}>     (driver tick)
 *   .init()                          → void                      (idempotent driver)
 *   .KEY                             → "aesStrategy:lessons"
 *
 * Lesson record shape:
 *   {
 *     lessonId:           "lsn-<base36-ts>-<rand>",
 *     ts:                 ms epoch,
 *     attrCluster:        {distanceBand, incumbentBand, hub?, equipFamily?},
 *     n:                  number,        // applied decisions in bucket
 *     supportFavorable:   number,
 *     supportUnfavorable: number,
 *     lift:               number,        // (fav/n) - (globalFav/globalN)
 *     score:              number,        // |lift| * sqrt(n)  — ranking
 *     sampleEntries:      string[]       // up to 5 jrn-* ids
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLessonMiner) return

    const KEY      = "aesStrategy:lessons"
    const RING_CAP = 50
    const TOP_K    = 10
    const MIN_BUCKET_N = 3
    const DEBOUNCE_MS  = 30 * 1000

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _lessonId() {
        return "lsn-" + Date.now().toString(36) + "-"
            + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
    }

    function _scopedKey(accountId) {
        return accountId ? KEY + ":acct:" + accountId : KEY
    }

    // ── Bucketing ───────────────────────────────────────────────────────
    function _distanceBand(km) {
        if (!isFinite(km) || km <= 0) return "unknown"
        if (km < 800)  return "short"
        if (km < 2400) return "medium"
        return "long"
    }
    function _incumbentBand(n) {
        if (!isFinite(n) || n < 0) return "unknown"
        if (n <= 2) return "low"
        if (n <= 5) return "mid"
        return "high"
    }
    function _bucketKey(c) {
        return [c.distanceBand, c.incumbentBand, c.hub || "*", c.equipFamily || "*"].join("|")
    }

    function _attrCluster(entry) {
        const a = (entry && entry.after) || {}
        const route = entry && entry.route
        const hub = (route && /^([A-Z0-9]{3,4})-/.exec(route) || [])[1] || null
        return {
            distanceBand:  _distanceBand(_num(a.distanceKm, NaN)),
            incumbentBand: _incumbentBand(_num(a.incumbentCount, NaN)),
            hub:           hub,
            equipFamily:   typeof a.equipFamily === "string" ? a.equipFamily : null
        }
    }

    /**
     * `outcome.after.favourable` is the canonical Slice 5 / K10 verdict
     * boolean; Slice 5 also carries `weeklyResult` deltas. We treat any
     * positive favourable bit as a "win", any explicit `false` as a loss,
     * and `null` (window not yet captured) as neither.
     */
    function _favourable(outcome) {
        const after = outcome && outcome.after
        if (!after) return null
        if (typeof after.favourable === "boolean") return after.favourable
        if (isFinite(after.weeklyResult) && isFinite(outcome.before && outcome.before.weeklyResult)) {
            return after.weeklyResult > outcome.before.weeklyResult
        }
        return null
    }

    // ── Pure miner ──────────────────────────────────────────────────────
    function mine(args) {
        const journal  = (args && args.journal)  || []
        const outcomes = (args && args.outcomes) || []
        const opts     = (args && args.opts)     || {}
        const topK     = _num(opts.topK, TOP_K)

        const outcomeById = new Map()
        for (const o of outcomes) {
            if (o && o.outcomeId) outcomeById.set(o.outcomeId, o)
        }

        let globalN = 0
        let globalFav = 0
        const buckets = new Map()

        for (const e of journal) {
            if (!e || e.action !== "apply-decision") continue
            const outcome = e.outcomeRef ? outcomeById.get(e.outcomeRef) : null
            const fav = outcome ? _favourable(outcome) : null
            if (fav === null) continue
            globalN++
            if (fav) globalFav++
            const cluster = _attrCluster(e)
            const k = _bucketKey(cluster)
            let b = buckets.get(k)
            if (!b) {
                b = {cluster: cluster, n: 0, fav: 0, samples: []}
                buckets.set(k, b)
            }
            b.n++
            if (fav) b.fav++
            if (b.samples.length < 5 && e.id) b.samples.push(e.id)
        }

        if (globalN === 0) return {lessons: [], stats: {globalN: 0, globalFav: 0, bucketCount: 0}}
        const globalRate = globalFav / globalN
        const lessons = []
        for (const b of buckets.values()) {
            if (b.n < MIN_BUCKET_N) continue
            const rate = b.fav / b.n
            const lift = rate - globalRate
            const score = Math.abs(lift) * Math.sqrt(b.n)
            lessons.push({
                lessonId:           _lessonId(),
                ts:                 Date.now(),
                attrCluster:        b.cluster,
                n:                  b.n,
                supportFavorable:   b.fav,
                supportUnfavorable: b.n - b.fav,
                lift:               lift,
                score:              score,
                sampleEntries:      b.samples.slice()
            })
        }
        lessons.sort((a, b) => b.score - a.score)
        return {
            lessons: lessons.slice(0, topK),
            stats:   {globalN: globalN, globalFav: globalFav, bucketCount: buckets.size}
        }
    }

    // ── Storage IO ──────────────────────────────────────────────────────
    async function loadAll(accountId) {
        try {
            const id = accountId || (typeof window !== "undefined" && window.__aesAccountId) || null
            const key = _scopedKey(id)
            const got = await chrome.storage.local.get([key])
            return Array.isArray(got[key]) ? got[key].slice() : []
        } catch (e) {
            console.warn("[AesStrategyLessonMiner] loadAll failed", e)
            return []
        }
    }

    async function _save(lessons, accountId) {
        try {
            const id  = accountId
            const key = _scopedKey(id)
            const ring = lessons.slice(0, RING_CAP)
            await chrome.storage.local.set({[key]: ring})
        } catch (e) {
            console.warn("[AesStrategyLessonMiner] save failed", e)
        }
    }

    async function _readJournal(accountId) {
        try {
            if (window.AesStrategyJournal
                    && typeof window.AesStrategyJournal.loadAll === "function") {
                return await window.AesStrategyJournal.loadAll(accountId)
            }
        } catch (_) {}
        return []
    }
    async function _readOutcomes(accountId) {
        try {
            if (window.AesStrategyOutcomes
                    && typeof window.AesStrategyOutcomes.loadAll === "function") {
                return await window.AesStrategyOutcomes.loadAll(accountId)
            }
        } catch (_) {}
        return []
    }

    // ── Driver ──────────────────────────────────────────────────────────
    let _running = false
    let _lastTickTs = 0

    async function runOnce(accountIdArg) {
        if (_running) return {skipped: "running"}
        _running = true
        try {
            const accountId = accountIdArg
                || (typeof window !== "undefined" && window.__aesAccountId) || null
            const [journal, outcomes] = await Promise.all([
                _readJournal(accountId),
                _readOutcomes(accountId)
            ])
            const result = mine({journal, outcomes})
            if (!result.lessons.length) {
                _lastTickTs = Date.now()
                return {count: 0, top: []}
            }
            await _save(result.lessons, accountId)
            const topThree = result.lessons.slice(0, 3).map(l => ({
                lessonId: l.lessonId, lift: l.lift, n: l.n,
                hub: l.attrCluster.hub, distanceBand: l.attrCluster.distanceBand
            }))
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                    window.CentralHubBus.emit("data:strategy:lesson:mined",
                        {accountId: accountId, count: result.lessons.length, topThree: topThree})
                }
            } catch (_) {}
            _lastTickTs = Date.now()
            return {count: result.lessons.length, top: topThree}
        } finally {
            _running = false
        }
    }

    let _debounceHandle = null
    function _scheduleTick() {
        if (_debounceHandle) clearTimeout(_debounceHandle)
        _debounceHandle = setTimeout(() => {
            _debounceHandle = null
            runOnce().catch(e => console.warn("[AesStrategyLessonMiner] tick failed", e))
        }, DEBOUNCE_MS)
    }

    let _initialized = false
    function init() {
        if (_initialized) return
        _initialized = true
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            // Trigger when outcomes (after capture) or journal (apply-decision) changes.
            for (const key of Object.keys(changes)) {
                if (/^aesStrategy:learn:outcomes(?::acct:[^:]+)?$/.test(key)
                        || /^aesStrategy:journal(?::acct:[^:]+)?$/.test(key)) {
                    _scheduleTick()
                    return
                }
            }
        })
    }

    window.AesStrategyLessonMiner = {
        mine:    mine,
        loadAll: loadAll,
        runOnce: runOnce,
        init:    init,
        KEY:     KEY,
        RING_CAP: RING_CAP,
        // Expose pure helpers for the smoke test.
        _attrCluster:   _attrCluster,
        _favourable:    _favourable,
        _distanceBand:  _distanceBand,
        _incumbentBand: _incumbentBand
    }

    init()

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const e1 = {id: "j1", action: "apply-decision", outcomeRef: "o1",
                        route: "JFK-LAX", after: {distanceKm: 500, incumbentCount: 1, equipFamily: "narrow"}}
            const e2 = {id: "j2", action: "apply-decision", outcomeRef: "o2",
                        route: "JFK-LAX", after: {distanceKm: 500, incumbentCount: 1, equipFamily: "narrow"}}
            const e3 = {id: "j3", action: "apply-decision", outcomeRef: "o3",
                        route: "JFK-LAX", after: {distanceKm: 500, incumbentCount: 1, equipFamily: "narrow"}}
            const o1 = {outcomeId: "o1", after: {favourable: true},  before: null}
            const o2 = {outcomeId: "o2", after: {favourable: true},  before: null}
            const o3 = {outcomeId: "o3", after: {favourable: false}, before: null}
            const r = mine({journal: [e1, e2, e3], outcomes: [o1, o2, o3]})
            console.assert(r.stats.globalN === 3,        "[smoke lesson-miner] globalN")
            console.assert(r.stats.globalFav === 2,      "[smoke lesson-miner] globalFav")
            console.assert(r.lessons.length === 1,       "[smoke lesson-miner] one bucket")
            console.assert(r.lessons[0].n === 3,         "[smoke lesson-miner] n=3")
            console.assert(_distanceBand(500)   === "short",   "[smoke lesson-miner] short band")
            console.assert(_distanceBand(2000)  === "medium",  "[smoke lesson-miner] medium band")
            console.assert(_incumbentBand(6)    === "high",    "[smoke lesson-miner] high incumbent band")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
