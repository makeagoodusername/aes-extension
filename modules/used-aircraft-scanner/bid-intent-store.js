/**
 * Tracks "the user clicked Open best on this offer" — a lightweight
 * signal of bid intent so the next scan can answer questions the diff
 * alone can't: "is the offer I eyed yesterday still there?", "did its
 * price drop while I was deciding?", "did it sell while I waited?".
 *
 * The intent record is per-offer (keyed by the same dedup triple
 * panel.js:_dedup uses), not per-model — multiple offers of the same
 * model can carry independent intents. The store is intentionally tiny:
 * one storage entry per intent, no aggregation.
 *
 * Storage shape:
 *   <server>marketScan:intent:<key>  →  IntentRecord
 *
 * IntentRecord = {
 *   key,                  // (typeId|registration|owner)
 *   aircraftType,
 *   registration, owner, typeId, offerUrl,
 *   firstSeenAt,          // ms epoch — first recordOpen
 *   lastOpenedAt,         // ms epoch — most recent recordOpen
 *   openCount,            // total Open clicks
 *   lastSeenPps,          // pricePerSeat at first sight (so we can diff)
 *   lastSeenDealClass,
 *   lastSeenScanId        // tracks which scan we last reconciled against
 * }
 *
 * Records older than `MAX_AGE_MS` are dropped lazily on `loadAll()` —
 * 30 days is long enough that a serious-but-deferred bid stays tracked,
 * short enough that the bucket doesn't accumulate forever.
 */
class BidIntentStore {
    static PREFIX = "marketScan:intent:"
    static MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000   // 30 days
    static SIGNIFICANT_DROP = 0.05                  // 5% — anything smaller is noise

    static _key(server, intentKey) {
        return server + BidIntentStore.PREFIX + intentKey
    }

    static rowKey(r) {
        if (!r) return null
        return (r.typeId || r.aircraftType || "?")
            + "|" + (r.registration || "?")
            + "|" + (r.owner || "?")
    }

    /**
     * Stamp (or update) an intent record for a row the user has clicked
     * "Open best" on. Idempotent — repeat opens just bump openCount and
     * lastOpenedAt. firstSeenAt is preserved across opens so "you've
     * been watching this for 3 days" stays accurate.
     */
    static async recordOpen(server, row) {
        if (!server || !row) return null
        const key = BidIntentStore.rowKey(row)
        if (!key) return null
        const storageKey = BidIntentStore._key(server, key)
        const now = Date.now()
        let rec
        try {
            const existing = await chrome.storage.local.get([storageKey])
            rec = existing[storageKey] || null
        } catch (_) { rec = null }
        if (rec) {
            rec.lastOpenedAt = now
            rec.openCount    = (rec.openCount || 0) + 1
            rec.offerUrl     = row.offerUrl || rec.offerUrl
        } else {
            rec = {
                key:               key,
                aircraftType:      row.aircraftType || "",
                registration:      row.registration || "",
                owner:             row.owner || "",
                typeId:            row.typeId || null,
                offerUrl:          row.offerUrl || null,
                firstSeenAt:       now,
                lastOpenedAt:      now,
                openCount:         1,
                lastSeenPps:       BidIntentStore._numOrNull(row.pricePerSeat),
                lastSeenDealClass: row.dealClass || null,
                lastSeenScanId:    null
            }
        }
        try { await chrome.storage.local.set({[storageKey]: rec}) }
        catch (_) { /* best-effort */ }
        return rec
    }

    static async loadByKey(server, key) {
        if (!server || !key) return null
        const storageKey = BidIntentStore._key(server, key)
        try {
            const data = await chrome.storage.local.get([storageKey])
            return data[storageKey] || null
        } catch (_) { return null }
    }

    /**
     * Returns every intent record for the server, freshest first. Drops
     * records older than MAX_AGE_MS in passing — keeps the bucket bounded
     * without a separate GC sweep.
     */
    static async loadAll(server) {
        if (!server) return []
        const prefix = server + BidIntentStore.PREFIX
        let all
        try { all = await chrome.storage.local.get(null) }
        catch (_) { return [] }
        const now = Date.now()
        const keep = []
        const drop = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec) { drop.push(k); continue }
            const age = now - (rec.lastOpenedAt || rec.firstSeenAt || 0)
            if (age > BidIntentStore.MAX_AGE_MS) { drop.push(k); continue }
            keep.push(rec)
        }
        if (drop.length) {
            try { await chrome.storage.local.remove(drop) }
            catch (_) { /* best-effort */ }
        }
        keep.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
        return keep
    }

    /**
     * Compare every persisted intent for `server` against a fresh digest.
     * Returns {gone, cheaper, improved, unchanged}, each a list of
     * {intent, currentRow, ...delta-fields}. Caller is responsible for
     * deciding which transitions warrant a notification.
     *
     * Side effects: updates each intent's lastSeenPps / lastSeenDealClass
     * / lastSeenScanId so the next reconcile diffs against this scan, not
     * the original sighting. Removes "gone" intents older than 24h after
     * being detected gone — once an offer is gone for a day, the user has
     * either acted or moved on.
     */
    static async reconcile(server, digest) {
        const out = {gone: [], cheaper: [], improved: [], unchanged: []}
        if (!server || !digest || !Array.isArray(digest.rows)) return out
        const intents = await BidIntentStore.loadAll(server)
        if (!intents.length) return out
        const byKey = new Map()
        for (const r of digest.rows) byKey.set(r.key, r)
        const writes = {}
        const removals = []
        const CLASS_RANK = {steal: 4, great: 3, good: 2, fair: 1, pass: 0}
        for (const intent of intents) {
            // Skip intents we've already reconciled against this scan —
            // re-renders that loop _maybeComputeDiff shouldn't re-fire
            // notifications for the same transition.
            if (intent.lastSeenScanId && intent.lastSeenScanId === digest.scanId) {
                continue
            }
            const cur = byKey.get(intent.key)
            const next = Object.assign({}, intent, {lastSeenScanId: digest.scanId})
            if (!cur) {
                out.gone.push({intent: intent})
                next.goneAt = next.goneAt || Date.now()
                if (next.goneAt && (Date.now() - next.goneAt) > 24 * 60 * 60 * 1000) {
                    removals.push(BidIntentStore._key(server, intent.key))
                    continue
                }
                writes[BidIntentStore._key(server, intent.key)] = next
                continue
            }
            // Re-appeared after being marked gone — clear the gone flag.
            if (next.goneAt) delete next.goneAt
            const prevPps = BidIntentStore._numOrNull(intent.lastSeenPps)
            const curPps  = BidIntentStore._numOrNull(cur.pps)
            const prevRank = CLASS_RANK[intent.lastSeenDealClass] || 0
            const curRank  = CLASS_RANK[cur.dealClass]            || 0
            let category = "unchanged"
            const dropFraction = (prevPps !== null && curPps !== null && prevPps > 0)
                ? (prevPps - curPps) / prevPps
                : 0
            if (dropFraction >= BidIntentStore.SIGNIFICANT_DROP) {
                out.cheaper.push({intent: intent, currentRow: cur,
                    prevPps: prevPps, curPps: curPps,
                    dropPct: Math.round(dropFraction * 100)})
                category = "cheaper"
            } else if (curRank > prevRank) {
                out.improved.push({intent: intent, currentRow: cur,
                    prevClass: intent.lastSeenDealClass, curClass: cur.dealClass})
                category = "improved"
            } else {
                out.unchanged.push({intent: intent, currentRow: cur})
            }
            next.lastSeenPps       = curPps
            next.lastSeenDealClass = cur.dealClass || null
            writes[BidIntentStore._key(server, intent.key)] = next
        }
        try {
            if (Object.keys(writes).length) await chrome.storage.local.set(writes)
            if (removals.length)            await chrome.storage.local.remove(removals)
        } catch (_) { /* best-effort */ }
        return out
    }

    static _numOrNull(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = BidIntentStore
