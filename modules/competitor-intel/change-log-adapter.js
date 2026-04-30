"use strict"

/**
 * Competitor-intel adapter for the cross-domain change log.
 *
 * Walks every `competitorIntel:snapshots:<server>:<eid>` ring buffer in
 * storage, calls `AesCompetitorDiff.compare(prev, curr)` between adjacent
 * snapshots, and normalises each typed event into the UnifiedEntry shape
 * that `AesChangeLogAggregator` consumes.
 *
 * Public surface: `window.AesCompetitorChangeLogAdapter.load(opts)` —
 * returns `Promise<UnifiedEntry[]>`. Wired into the aggregator's ADAPTERS
 * map under the domain key `"competitor-intel"`.
 *
 * Green-marker styling: status is "growth" for events that mean the
 * competitor *expanded* (route.entered, hub.added, fleet.gained,
 * fleet.type.added), "contraction" for the inverse, "structural" for
 * alliance / baseCountry / rating shifts. The change-log modal already
 * colors "growth" green via its statusColor() switch (we use the
 * "applied" alias).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorChangeLogAdapter) return

    const SNAP_PREFIX = "competitorIntel:snapshots:"
    const ENT_PREFIX  = "competitorIntel:enterprise:"

    const TYPE_GLYPH = {
        "alliance.changed":   "✦",
        "baseCountry.changed":"⚑",
        "fleet.gained":       "+",
        "fleet.retired":      "−",
        "fleet.type.added":   "✚",
        "fleet.type.removed": "✕",
        "fleet.size.changed": "↻",
        "hub.added":          "★",
        "hub.retreated":      "✗",
        "route.entered":      "→",
        "route.exited":       "←",
        "employees.changed":  "👥",
        "pax.changed":        "👤",
        "cargo.changed":      "📦",
        "rating.changed":     "★",
        "competitor.observed":"●"
    }

    const TYPE_STATUS = {
        "alliance.changed":   "structural",
        "baseCountry.changed":"structural",
        "fleet.gained":       "applied",       // green via statusColor("applied")
        "fleet.retired":      "skipped",
        "fleet.type.added":   "applied",
        "fleet.type.removed": "skipped",
        "fleet.size.changed": "posted",
        "hub.added":          "applied",
        "hub.retreated":      "skipped",
        "route.entered":      "applied",
        "route.exited":       "skipped",
        "employees.changed":  "posted",
        "pax.changed":        "posted",
        "cargo.changed":      "posted",
        "rating.changed":     "posted",
        "competitor.observed":"queued"
    }

    /**
     * Load competitor-intel change-log entries.
     *
     * @param {object} [opts]
     *   sinceMs:  number  — drop events older than this
     *   limit:    number  — cap returned entries (sorted ts desc)
     *   server:   string  — restrict to one server
     */
    async function load(opts) {
        opts = opts || {}
        const since = isFinite(opts.sinceMs) ? opts.sinceMs : 0
        const all = await chrome.storage.local.get(null).catch(() => ({}))
        if (!window.AesCompetitorDiff) return []

        // Build a map of enterpriseId → enterprise meta (for friendly
        // names in summaries) and a list of snapshot buffers to walk.
        const enterpriseMeta = new Map()
        const snapshotBufs = []
        for (const k in all) {
            const v = all[k]
            if (!v || typeof v !== "object") continue
            if (k.startsWith(ENT_PREFIX) && v.enterpriseId) {
                enterpriseMeta.set(_metaKey(v.server, v.enterpriseId), v)
            } else if (k.startsWith(SNAP_PREFIX) && Array.isArray(v.snapshots)) {
                if (opts.server && v.server !== opts.server) continue
                snapshotBufs.push(v)
            }
        }

        const out = []
        for (const buf of snapshotBufs) {
            const meta = enterpriseMeta.get(_metaKey(buf.server, buf.enterpriseId)) || null
            const snaps = buf.snapshots
            for (let i = 0; i < snaps.length; i++) {
                const prev = i === 0 ? null : snaps[i - 1]
                const curr = snaps[i]
                if (!curr || !isFinite(curr.at)) continue
                if (since > 0 && curr.at < since) continue
                const events = window.AesCompetitorDiff.compare(prev, curr)
                if (!events || !events.length) continue
                for (const ev of events) {
                    out.push(_normalise(ev, buf, meta, curr))
                }
            }
        }
        return out
    }

    function _normalise(ev, buf, meta, snapshot) {
        const enterpriseName = (meta && meta.name) || buf.enterpriseId
        const summary = _summary(ev, enterpriseName)
        const id = "competitor-intel:" + buf.server + ":" + buf.enterpriseId
            + ":" + snapshot.at + ":" + ev.type
        return {
            id,
            ts:       snapshot.at,
            domain:   "competitor-intel",
            source:   "snapshot-diff",
            scope:    {
                server:       buf.server || null,
                enterpriseId: buf.enterpriseId || null,
                hub:          ev.payload && ev.payload.hub || null,
                dest:         ev.payload && ev.payload.dest || null
            },
            status:   TYPE_STATUS[ev.type] || "queued",
            summary,
            prev:     null,
            next:     ev.payload || null,
            reason:   null,
            dryRun:   false,
            count:    1,
            raw:      ev
        }
    }

    function _summary(ev, enterpriseName) {
        const glyph = TYPE_GLYPH[ev.type] || "•"
        const p = ev.payload || {}
        switch (ev.type) {
            case "alliance.changed":
                return `${glyph} ${enterpriseName} ${p.direction || "moved"} alliance`
                    + (p.currAllianceName ? ` → ${p.currAllianceName}` : "")
                    + (p.prevAllianceName && !p.currAllianceName ? ` (was ${p.prevAllianceName})` : "")
            case "baseCountry.changed":
                return `${glyph} ${enterpriseName} relocated base ${p.prev || "?"} → ${p.curr || "?"}`
            case "fleet.gained": {
                const types = (p.types || []).map(t => `${t.typeCode || t.typeId} +${t.delta}`).join(", ")
                return `${glyph} ${enterpriseName} fleet gained: ${types}`
            }
            case "fleet.retired": {
                const types = (p.types || []).map(t => `${t.typeCode || t.typeId} ${t.delta}`).join(", ")
                return `${glyph} ${enterpriseName} fleet retired: ${types}`
            }
            case "fleet.type.added": {
                const types = (p.types || []).map(t => `${t.typeCode || t.typeId} (${t.count})`).join(", ")
                return `${glyph} ${enterpriseName} added new aircraft type: ${types}`
            }
            case "fleet.type.removed": {
                const types = (p.types || []).map(t => `${t.typeCode || t.typeId} (was ${t.count})`).join(", ")
                return `${glyph} ${enterpriseName} retired aircraft type: ${types}`
            }
            case "fleet.size.changed":
                return `${glyph} ${enterpriseName} fleet ${p.prev}→${p.curr} (${p.delta >= 0 ? "+" : ""}${p.delta})`
            case "hub.added": {
                const list = (p.iatas || []).join(", ")
                return `${glyph} ${enterpriseName} opened hub${p.iatas && p.iatas.length > 1 ? "s" : ""}: ${list}`
            }
            case "hub.retreated": {
                const list = (p.iatas || []).join(", ")
                return `${glyph} ${enterpriseName} retreated from: ${list}`
            }
            case "route.entered": {
                const n = (p.routes || []).length
                const sample = (p.routes || []).slice(0, 3).join(", ")
                return `${glyph} ${enterpriseName} entered ${n} route${n === 1 ? "" : "s"}: ${sample}`
                    + (n > 3 ? ` +${n - 3} more` : "")
            }
            case "route.exited": {
                const n = (p.routes || []).length
                const sample = (p.routes || []).slice(0, 3).join(", ")
                return `${glyph} ${enterpriseName} exited ${n} route${n === 1 ? "" : "s"}: ${sample}`
                    + (n > 3 ? ` +${n - 3} more` : "")
            }
            case "employees.changed":
                return `${glyph} ${enterpriseName} employees ${p.prev}→${p.curr} (${p.delta >= 0 ? "+" : ""}${p.delta})`
            case "pax.changed":
                return `${glyph} ${enterpriseName} pax carried ${p.prev}→${p.curr}`
            case "cargo.changed":
                return `${glyph} ${enterpriseName} cargo carried ${p.prev}→${p.curr}`
            case "rating.changed":
                return `${glyph} ${enterpriseName} rating ${p.prev || "?"} → ${p.curr || "?"}`
            case "competitor.observed":
                return `${glyph} ${enterpriseName} first observed (${p.routeCount || 0} routes, ${p.fleetCount || 0} aircraft)`
            default:
                return `${glyph} ${enterpriseName} · ${ev.type}`
        }
    }

    function _metaKey(server, eid) { return (server || "?") + ":" + String(eid) }

    window.AesCompetitorChangeLogAdapter = {
        load,
        TYPE_GLYPH,
        TYPE_STATUS,
        SOURCE_KEY_PREFIX: SNAP_PREFIX
    }
})()
