"use strict"

/**
 * CH-W1 — Tile salience scorer.
 *
 * The dashboard currently sorts tiles by hand-tuned `priority` ascending.
 * That ranks by author intent, not user attention. The cascade overhaul
 * (Cascade plan, slice CH-W1) replaces that with a single auditable
 * salience function whose inputs are observable at runtime:
 *
 *   - base priority (existing field, normalized + inverted so lower = louder)
 *   - pinnedTiles membership (huge bonus — user lifted this to the top)
 *   - recentTiles ring position (decaying bonus from most-recent first)
 *   - HubFeed unread count for tile-id-keyed feeds (already on the bus)
 *   - Conductor signal density across the tile's salienceDomains[]
 *     (signals are typed `<domain>.<event>.changed`; a tile claims one
 *      or more domains in its registration)
 *   - tileOrder explicit override (when set, wins absolutely — for
 *     users who want a static layout regardless of signal weather)
 *
 * Pure module — no IO at score time. The shell pre-loads the inputs once
 * per render pass and hands them to `salienceFor(tile, ctx)`. Tunable via
 * `centralHub:settings.salienceWeights`. Defaults are documented inline.
 *
 * Invariant CH-W1-A (NORTH-STAR §4.18 — no silent default flips): the
 * default weight set is fixed and stored in DEFAULT_WEIGHTS. The user's
 * weights are merged on top via _normalizeWeights — unknown keys are
 * dropped, missing keys take the default.
 *
 * Invariant CH-W1-B: when `tileOrder[tileId]` is a finite number, salience
 * returns Number.POSITIVE_INFINITY - tileOrder[tileId] so manual ordering
 * is monotonic and beats every signal-driven score.
 */
;(function () {
    if (typeof window === "undefined" || window.CentralHubSalience) return

    // Default weight set — every input contributes a normalized 0..1
    // value, then is multiplied by the weight. Salience is the sum.
    const DEFAULT_WEIGHTS = {
        priority:    1.0,    // base ordering (always present)
        pin:         5.0,    // user explicitly lifted — huge bump
        recent:      1.5,    // decays linearly across 5-slot ring
        hubFeed:     1.2,    // unread items from HubFeed slices
        signal:      2.0,    // Conductor fires in tile's salienceDomains
        pulse:       0.8     // tile-emitted bus pulse (reserved future)
    }

    // Conductor signal types are dotted strings like "maintenance.ratio.changed".
    // A tile's salienceDomain is matched as a prefix on the type string.
    // Prefix match is conservative — "maintenance" matches every
    // "maintenance.*" type but not "scrape.maintenance.*", so we anchor on
    // the dotted left.
    function _signalMatchesDomain(signalType, domain) {
        if (!signalType || !domain) return false
        const t = String(signalType)
        const d = String(domain)
        if (t === d) return true
        return t.length > d.length && t.charAt(d.length) === "." && t.indexOf(d) === 0
    }

    /**
     * Normalize the weights blob from settings — fill missing keys from
     * defaults, drop unknown keys, coerce non-finite to default.
     */
    function _normalizeWeights(input) {
        const out = Object.assign({}, DEFAULT_WEIGHTS)
        if (!input || typeof input !== "object") return out
        for (const k of Object.keys(DEFAULT_WEIGHTS)) {
            const v = input[k]
            if (typeof v === "number" && isFinite(v) && v >= 0) out[k] = v
        }
        return out
    }

    /**
     * Score a single tile. Returns a finite non-negative number
     * (POSITIVE_INFINITY when tileOrder pins it).
     *
     *   tile           — the tile spec from CentralHubTileRegistry. Reads
     *                    .id, .priority, .salienceDomains[].
     *   ctx            — pre-loaded inputs:
     *     pinnedSet         Set<tileId>
     *     recentList        string[] (most-recent first; cap 5 by convention)
     *     hubFeedUnread     Map<tileId, number>
     *     signalsByDomain   Map<domain, number> (count of signals in last
     *                       window matching the domain prefix)
     *     pulseByTileId     Map<tileId, number> (0..1, emitted by tiles
     *                       that opt in via the bus)
     *     tileOrder         {tileId: number} — when present, wins absolutely
     *     weights           output of _normalizeWeights, or null for defaults
     *     priorityFloor     numeric floor used to invert priority (default 100)
     *
     * Invariants:
     *   - Pure: same inputs → same output
     *   - Defensive: any missing input collapses to its zero contribution
     *   - Stable: inputs not mutated
     */
    function salienceFor(tile, ctx) {
        if (!tile || !tile.id) return 0
        ctx = ctx || {}

        const tileOrder = ctx.tileOrder || {}
        const explicit = tileOrder[tile.id]
        if (typeof explicit === "number" && isFinite(explicit)) {
            // Manual order: lower index = louder. POSITIVE_INFINITY - n
            // so a smaller n produces a strictly larger value.
            return Number.POSITIVE_INFINITY - explicit
        }

        const w = _normalizeWeights(ctx.weights)
        const floor = (typeof ctx.priorityFloor === "number" && ctx.priorityFloor > 0)
            ? ctx.priorityFloor : 100

        let score = 0

        // 1. Base priority — invert so lower priority value = higher
        //    salience. Clamp to floor so a stray priority: 9999 doesn't
        //    drag the score negative.
        const p = (typeof tile.priority === "number" && isFinite(tile.priority))
            ? Math.max(0, Math.min(floor, tile.priority)) : 50
        const priorityNorm = (floor - p) / floor    // 0..1
        score += w.priority * priorityNorm

        // 2. Pin — boolean bump.
        const pinSet = ctx.pinnedSet
        if (pinSet && typeof pinSet.has === "function" && pinSet.has(tile.id)) {
            score += w.pin
        }

        // 3. Recents ring — decaying contribution. recentList[0] = most
        //    recent. A tile not in the list contributes 0.
        const rl = Array.isArray(ctx.recentList) ? ctx.recentList : []
        const recentIdx = rl.indexOf(tile.id)
        if (recentIdx >= 0 && rl.length > 0) {
            const decay = (rl.length - recentIdx) / rl.length    // 1.0 at idx 0
            score += w.recent * decay
        }

        // 4. HubFeed unread — log-compress so a runaway feed doesn't
        //    dominate every other input. log(1+n)/log(11) ≈ 1 at n=10,
        //    saturates by n=100 at ~1.92.
        const feedMap = ctx.hubFeedUnread
        if (feedMap && typeof feedMap.get === "function") {
            const unread = feedMap.get(tile.id) || 0
            if (unread > 0) {
                const logged = Math.log(1 + unread) / Math.log(11)
                score += w.hubFeed * Math.min(2, logged)
            }
        }

        // 5. Conductor signals — sum the per-domain counts for every domain
        //    the tile claims. Same log compression as HubFeed.
        const sigMap = ctx.signalsByDomain
        const domains = Array.isArray(tile.salienceDomains) ? tile.salienceDomains : []
        if (sigMap && typeof sigMap.get === "function" && domains.length) {
            let sum = 0
            for (const d of domains) {
                const c = sigMap.get(d) || 0
                if (c > 0) sum += c
            }
            if (sum > 0) {
                const logged = Math.log(1 + sum) / Math.log(11)
                score += w.signal * Math.min(2, logged)
            }
        }

        // 6. Pulse — reserved channel for tiles to bump their own salience
        //    via a 0..1 score on the bus (e.g., a Conductor tile flagging
        //    a high-severity fire). pulseByTileId[tile.id] is read.
        const pulseMap = ctx.pulseByTileId
        if (pulseMap && typeof pulseMap.get === "function") {
            const pulse = pulseMap.get(tile.id)
            if (typeof pulse === "number" && pulse > 0) {
                score += w.pulse * Math.min(1, pulse)
            }
        }

        return score
    }

    /**
     * Sort an array of tile specs in place by descending salience.
     * Stable: ties break on tile.id ascending so the order is
     * reproducible across renders.
     */
    function rankTiles(tiles, ctx) {
        if (!Array.isArray(tiles)) return tiles || []
        const scored = tiles.map(t => ({tile: t, score: salienceFor(t, ctx)}))
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            const ai = String(a.tile.id || "")
            const bi = String(b.tile.id || "")
            return ai < bi ? -1 : ai > bi ? 1 : 0
        })
        return scored.map(s => s.tile)
    }

    /**
     * Build a Conductor signal-domain count map from the live ring buffer.
     * Filters by signals fired within `windowMs` (default 1 hour).
     *
     *   signals  — array of Signal records from AesConductorSignalStore
     *   windowMs — number; signals older than now-windowMs are skipped
     *
     * Returns Map<domain, count> where domain is the FIRST dotted token
     * of signal.type (e.g., "maintenance" from "maintenance.ratio.changed").
     * Tiles claim domains by these first-token names, so the lookup is O(1).
     */
    function signalsByDomainFromRing(signals, windowMs) {
        const out = new Map()
        if (!Array.isArray(signals) || !signals.length) return out
        const cutoff = Date.now() - (windowMs || 3600000)
        for (const s of signals) {
            if (!s || !s.type || !s.firedAt) continue
            if (s.firedAt < cutoff) continue
            const t = String(s.type)
            const dot = t.indexOf(".")
            const domain = dot > 0 ? t.slice(0, dot) : t
            out.set(domain, (out.get(domain) || 0) + 1)
        }
        return out
    }

    /**
     * Phase C2 — bucket recent `signal:<module>:<kind>` events from the
     * data-bus by their kind (last colon-segment). Tiles can declare a
     * `salienceDomains: ["crew-pressure", "cash-low", ...]` array to
     * pick up cross-feature reaction hints alongside the dotted
     * conductor signals. Returns Map<kind, count>; merges into the
     * same `signalsByDomain` map shell.js builds.
     */
    function signalsByDomainFromBus(busHistory, windowMs) {
        const out = new Map()
        if (!Array.isArray(busHistory) || !busHistory.length) return out
        const cutoff = Date.now() - (windowMs || 3600000)
        for (const ev of busHistory) {
            if (!ev || !ev.topic || !ev.at) continue
            if (ev.at < cutoff) continue
            const t = String(ev.topic)
            if (t.indexOf("signal:") !== 0) continue
            const last = t.lastIndexOf(":")
            if (last < 0 || last === t.length - 1) continue
            const kind = t.slice(last + 1)
            out.set(kind, (out.get(kind) || 0) + 1)
        }
        return out
    }

    function mergeSignalMaps(a, b) {
        if (!b || !b.size) return a || new Map()
        const out = new Map(a || [])
        for (const [k, v] of b) {
            out.set(k, (out.get(k) || 0) + v)
        }
        return out
    }

    window.CentralHubSalience = {
        salienceFor,
        rankTiles,
        signalsByDomainFromRing,
        signalsByDomainFromBus,
        mergeSignalMaps,
        DEFAULT_WEIGHTS,
        _normalizeWeights,         // exposed for testability
        _signalMatchesDomain       // exposed for testability
    }
})()
