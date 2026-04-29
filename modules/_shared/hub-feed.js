"use strict"

/**
 * HubFeed — unified read layer for the central-hub dashboard.
 *
 * Tiles call HubFeed instead of `chrome.storage.local.get(...)` directly.
 * Each "slice" is an `AesView.declare` underneath plus a TTL/freshness
 * wrapper so the tile header can render a stale-data dot without each tile
 * re-implementing the staleness check.
 *
 * Public API:
 *   HubFeed.declare({name, deps, compute, ttlMs?, debounceMs?, eager?})
 *     — registers a slice. `name` must start with `hub:`. The compute
 *       function returns the value tiles read; HubFeed adds `computedAt`
 *       and the per-slice ttlMs is consulted by `freshness()`.
 *
 *   HubFeed.read(name)               → cached value | undefined when never computed
 *   HubFeed.readAsync(name)          → resolves once first compute lands
 *   HubFeed.subscribe(name, cb)      → off; cb({value, at, fresh, stale, error, ageMs})
 *   HubFeed.freshness(name)          → {at, ttlMs, isStale, ageMs} | null
 *   HubFeed.invalidate(name)         → forces recompute
 *   HubFeed.list()                   → diagnostic snapshot of all slices
 *
 * Composition with existing primitives:
 *   - AesView handles dedup, debounce, cycle-break, error isolation.
 *   - AesDataBus.last/peek give the underlying compute fast-path access to
 *     producer values without storage round-trips.
 *   - createTtlCache `freshnessField` semantics inform the staleness flag.
 *
 * Backward compatibility:
 *   Tiles can opt in by overriding `feedSlices()` (added to CentralHubTile).
 *   The legacy `watchedStorageKeys()` path stays untouched. Both can fire
 *   refresh() on the same tile during migration; refresh is idempotent.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.HubFeed) return
    if (typeof window.AesView === "undefined" || typeof window.AesDataBus === "undefined") {
        console.warn("[AES hub-feed] AesView/AesDataBus missing — hub-feed inert")
        return
    }

    // name → {ttlMs, lastReadAt}
    const meta = new Map()

    function declare(opts) {
        if (!opts || typeof opts.name !== "string" || opts.name.indexOf("hub:") !== 0) {
            throw new Error("HubFeed.declare: opts.name must start with 'hub:'")
        }
        if (typeof opts.compute !== "function") {
            throw new Error("HubFeed.declare: opts.compute (function) required")
        }
        const name = opts.name
        const ttlMs = Number(opts.ttlMs) || 0  // 0 = never marked stale by age
        meta.set(name, {ttlMs: ttlMs})
        AesView.declare({
            name:       name,
            deps:       Array.isArray(opts.deps) ? opts.deps.slice() : [],
            compute:    opts.compute,
            debounceMs: Number(opts.debounceMs) || 0,
            eager:      opts.eager !== false  // hub feeds default eager: tiles want fast first paint
        })
        return name
    }

    function read(name) {
        return AesView.get(name)
    }

    function readAsync(name) {
        const v = AesView.get(name)
        if (v !== undefined) return Promise.resolve(v)
        return new Promise((resolve) => {
            const off = AesView.subscribe(name, (e) => {
                if (!e || !e.hasValue) return
                off()
                resolve(e.value)
            })
            AesView.invalidate(name)
        })
    }

    function freshness(name) {
        const m = meta.get(name)
        if (!m) return null
        const list = AesView.list().find((v) => v.name === name)
        if (!list || !list.computedAt) return {at: null, ttlMs: m.ttlMs, isStale: true, ageMs: null}
        const ageMs = Date.now() - list.computedAt
        return {
            at:      list.computedAt,
            ttlMs:   m.ttlMs,
            ageMs:   ageMs,
            isStale: m.ttlMs > 0 ? ageMs > m.ttlMs : false
        }
    }

    function subscribe(name, cb) {
        if (typeof cb !== "function") return () => {}
        return AesView.subscribe(name, (e) => {
            const f = freshness(name)
            try {
                cb({
                    name:    name,
                    value:   e.value,
                    at:      e.at,
                    error:   e.error || null,
                    fresh:   !!(f && !f.isStale && e.hasValue),
                    stale:   !!(f && f.isStale),
                    ageMs:   f ? f.ageMs : null,
                    hasValue: !!e.hasValue
                })
            } catch (err) { console.warn("[AES hub-feed] subscribe cb threw", name, err) }
        })
    }

    function invalidate(name) {
        AesView.invalidate(name)
    }

    function list() {
        const views = AesView.list().filter((v) => v.name.indexOf("hub:") === 0)
        return views.map((v) => {
            const f = freshness(v.name)
            return {
                name:       v.name,
                hasValue:   v.hasValue,
                error:      v.error || null,
                computedAt: v.computedAt,
                computedMs: v.computedMs,
                ttlMs:      f ? f.ttlMs : 0,
                isStale:    f ? f.isStale : false,
                ageMs:      f ? f.ageMs  : null
            }
        })
    }

    window.HubFeed = {
        declare:    declare,
        read:       read,
        readAsync:  readAsync,
        subscribe:  subscribe,
        freshness:  freshness,
        invalidate: invalidate,
        list:       list
    }
})()
