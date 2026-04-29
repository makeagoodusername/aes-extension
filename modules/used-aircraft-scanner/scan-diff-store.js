/**
 * Persistent compact-row digests for the Used Aircraft Scanner, plus the
 * diff compute that turns "scan finished" into "here's what changed".
 *
 * Why a separate store: `MarketScanSession` GCs old sessions on the next
 * scan start (`scan-controller.js:cleanupOld`), so the previous scan's
 * row data is gone before a follow-up scan can diff against it. We keep
 * a one-slot-per-preset digest of just the fields the diff needs, so a
 * scheduled rescan can answer "what's new since last time?" indefinitely.
 *
 * Storage shape:
 *   <server>marketScan:digest:<presetId>  →  Digest
 *
 * Digest = {
 *   scanId, presetId, presetName, finishedAt,
 *   rows: [DigestRow]
 * }
 *
 * DigestRow = {
 *   key,                 // (typeId|registration|owner) — same triple
 *                        // panel.js:_dedup uses, stable across scans
 *   typeId, registration, owner, aircraftType,
 *   pps,                 // pricePerSeat — number|null
 *   dealClass,           // "steal" | "great" | ...
 *   dealScore,           // number|null
 *   offerUrl
 * }
 */
class MarketScanDiffStore {
    static CLASS_RANK = {steal: 4, great: 3, good: 2, fair: 1, pass: 0}
    static EPSILON_PPS = 1   // ignore sub-AS$ rounding wobble in price-drop detection

    static _key(server, presetId) {
        return server + "marketScan:digest:" + presetId
    }

    /**
     * Project a panel row down to a DigestRow. Strips everything the diff
     * doesn't need so the persisted blob stays small even on big scans.
     */
    static rowToDigest(r) {
        if (!r) return null
        const key = (r.typeId || r.aircraftType || "?")
            + "|" + (r.registration || "?")
            + "|" + (r.owner || "?")
        return {
            key:           key,
            typeId:        r.typeId || null,
            registration:  r.registration || "",
            owner:         r.owner || "",
            aircraftType:  r.aircraftType || "",
            pps:           MarketScanDiffStore._numOrNull(r.pricePerSeat),
            dealClass:     r.dealClass || null,
            dealScore:     MarketScanDiffStore._numOrNull(r.dealScore),
            offerUrl:      r.offerUrl || null
        }
    }

    static buildDigest(session, rows, presetId, presetName) {
        const out = []
        for (const r of rows || []) {
            const d = MarketScanDiffStore.rowToDigest(r)
            if (d) out.push(d)
        }
        return {
            scanId:      session && session.scanId || null,
            presetId:    presetId || null,
            presetName:  presetName || "",
            finishedAt:  (session && session.finishedAt) || Date.now(),
            rows:        out
        }
    }

    static async loadDigest(server, presetId) {
        if (!server || !presetId) return null
        const key = MarketScanDiffStore._key(server, presetId)
        try {
            const data = await chrome.storage.local.get([key])
            return data[key] || null
        } catch (_) { return null }
    }

    static async saveDigest(server, digest) {
        if (!server || !digest || !digest.presetId) return
        const key = MarketScanDiffStore._key(server, digest.presetId)
        try { await chrome.storage.local.set({[key]: digest}) }
        catch (_) { /* swallow — digest is best-effort */ }
    }

    /**
     * List every persisted digest for a server. Used by the central-hub
     * tile to surface a multi-preset "top STEALs" view without knowing
     * which preset to ask for first.
     */
    static async loadAllDigests(server) {
        if (!server) return []
        const prefix = server + "marketScan:digest:"
        try {
            const all = await chrome.storage.local.get(null)
            const out = []
            for (const k in all) {
                if (k.indexOf(prefix) !== 0) continue
                if (all[k]) out.push(all[k])
            }
            // Newest first so callers can pick "the latest scan" cheaply.
            out.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
            return out
        } catch (_) { return [] }
    }

    /**
     * Diff two digests. Returns {newOffers, gone, priceDrops,
     * classImprovements} where each entry is a DigestRow (with prev-state
     * fields tagged on for the comparison fields). Pure — no I/O.
     *
     * `prev` may be null (first scan of a preset) — returns an empty diff
     * with `firstScan: true` so callers can render "baseline captured"
     * instead of "nothing changed".
     */
    static compute(prev, next) {
        if (!next || !Array.isArray(next.rows)) {
            return MarketScanDiffStore._emptyDiff(true)
        }
        if (!prev || !Array.isArray(prev.rows)) {
            return Object.assign(MarketScanDiffStore._emptyDiff(true), {firstScan: true})
        }
        const prevByKey = new Map()
        for (const r of prev.rows) prevByKey.set(r.key, r)
        const nextByKey = new Map()
        for (const r of next.rows) nextByKey.set(r.key, r)

        const newOffers = []
        const priceDrops = []
        const classImprovements = []
        for (const r of next.rows) {
            const before = prevByKey.get(r.key)
            if (!before) { newOffers.push(r); continue }
            if (typeof before.pps === "number" && typeof r.pps === "number"
                && r.pps + MarketScanDiffStore.EPSILON_PPS < before.pps) {
                priceDrops.push(Object.assign({}, r, {prevPps: before.pps}))
            }
            const wasRank = MarketScanDiffStore.CLASS_RANK[before.dealClass] || 0
            const isRank  = MarketScanDiffStore.CLASS_RANK[r.dealClass]      || 0
            if (isRank > wasRank) {
                classImprovements.push(Object.assign({}, r, {prevClass: before.dealClass}))
            }
        }
        const gone = []
        for (const r of prev.rows) if (!nextByKey.has(r.key)) gone.push(r)

        return {
            firstScan:          false,
            newOffers:          newOffers,
            gone:               gone,
            priceDrops:         priceDrops,
            classImprovements:  classImprovements,
            prevFinishedAt:     prev.finishedAt || null,
            nextFinishedAt:     next.finishedAt || null
        }
    }

    /**
     * Compact summary string — at most ~50 chars — suitable for chrome
     * notifications and tile badges. Ordering puts the most exciting
     * change first ("STEAL improved" > "new" > "price drop" > "gone").
     */
    static summarise(diff) {
        if (!diff || diff.firstScan) return "first scan · baseline captured"
        const bits = []
        if (diff.classImprovements.length) bits.push(diff.classImprovements.length + " improved")
        if (diff.newOffers.length)         bits.push(diff.newOffers.length + " new")
        if (diff.priceDrops.length)        bits.push(diff.priceDrops.length + " cheaper")
        if (diff.gone.length)              bits.push(diff.gone.length + " gone")
        return bits.length ? bits.join(" · ") : "no changes"
    }

    static isEmpty(diff) {
        if (!diff) return true
        return !diff.newOffers.length && !diff.priceDrops.length
            && !diff.classImprovements.length && !diff.gone.length
    }

    static _emptyDiff(firstScan) {
        return {
            firstScan:         !!firstScan,
            newOffers:         [],
            gone:              [],
            priceDrops:        [],
            classImprovements: [],
            prevFinishedAt:    null,
            nextFinishedAt:    null
        }
    }

    static _numOrNull(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketScanDiffStore
