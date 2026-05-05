"use strict"

/**
 * TTL-aware cache primitive that composes over `createPrefixStore`.
 *
 * Folds the dozen+ ad-hoc `MAX_AGE_MS` constants and copy-pasted freshness
 * checks scattered across the codebase into one shape. Callers get a thin
 * wrapper around chrome.storage.local that:
 *
 *   - stamps a freshness timestamp on every write (default key: `scrapedAt`)
 *   - returns null from `get()` when an entry is older than `ttlMs`
 *   - exposes `getStale()` for diagnostics + a `{includeStale: true}` shape
 *     on `get()` matching `RouteAssistantDemandStore.get`'s existing API
 *   - has an opt-in `cleanup()` that's intended to be registered with the
 *     shared cleanup-registry rather than called inline by every consumer
 *
 * Three exports cover the three shapes that show up in the codebase today:
 *
 *   createTtlCache({prefix, ttlMs, ...})  // many keys, one prefix
 *   wrapSingleKey(key, ttlMs, ...)        // one well-known storage key
 *   trimEntries(entries, opts)            // ring-buffer history trim helper
 *
 * Storage shape is unchanged — domain stores migrate by replacing internals,
 * not by re-keying. That's why TTL is read-time, not write-time.
 *
 * Loaded into every AS page via the wildcard shared content_scripts block
 * (manifest.json:51-102). Depends on `createPrefixStore` from prefix-store.js,
 * which is also in that block and listed before this file.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.createTtlCache) return

    const DEFAULT_FRESHNESS_FIELD = "scrapedAt"

    function isFreshRecord(rec, ttlMs, freshnessField) {
        if (!rec || typeof rec !== "object") return false
        if (!ttlMs || ttlMs <= 0) return true
        const ts = Number(rec[freshnessField])
        if (!isFinite(ts) || ts <= 0) return false
        return Date.now() - ts <= ttlMs
    }

    function handleInvalidatedContext(err) {
        const msg = err && err.message ? err.message : String(err || "")
        if (!/Extension context invalidated/i.test(msg)) return false
        try {
            if (window.AESSiteSkin?.handleInvalidatedContext?.(err)) return true
        } catch (_) {}
        return true
    }

    /**
     * @param {object} opts
     *   prefix          chrome.storage key prefix INCLUDING delimiter
     *   ttlMs           freshness window (0/null = never expires)
     *   maxEntries      optional cap; oldest by freshnessField evicted on cleanup
     *   freshnessField  default "scrapedAt"
     *   accountScoped   reserved for slice 3 — not consulted yet
     */
    function createTtlCache(opts) {
        const prefix         = opts && opts.prefix
        const ttlMs          = (opts && opts.ttlMs) || 0
        const maxEntries     = (opts && opts.maxEntries) || 0
        const freshnessField = (opts && opts.freshnessField) || DEFAULT_FRESHNESS_FIELD
        if (!prefix || typeof prefix !== "string") {
            throw new Error("createTtlCache: opts.prefix (string) required")
        }
        const inner = window.createPrefixStore({prefix})

        async function get(suffix, getOpts) {
            const rec = await inner.get(suffix)
            if (!rec) return null
            if (getOpts && getOpts.includeStale) return rec
            return isFreshRecord(rec, ttlMs, freshnessField) ? rec : null
        }

        async function set(suffix, value) {
            if (!value || typeof value !== "object") return inner.set(suffix, value)
            // Don't overwrite an explicit caller-supplied freshness field — some
            // stores (price-history) use a domain timestamp like observedAt
            // that means more than "when chrome.storage saw this".
            if (value[freshnessField] == null) value[freshnessField] = Date.now()
            return inner.set(suffix, value)
        }

        async function bulkGet(suffixes, getOpts) {
            const map = await inner.bulkGet(suffixes)
            if (getOpts && getOpts.includeStale) return map
            for (const [k, v] of map) {
                if (!isFreshRecord(v, ttlMs, freshnessField)) map.delete(k)
            }
            return map
        }

        async function cleanup() {
            const all = await inner.getAll()
            const drops = []
            const fresh = []
            for (const e of all) {
                if (isFreshRecord(e.value, ttlMs, freshnessField)) fresh.push(e)
                else drops.push(e.suffix)
            }
            // Apply maxEntries cap to the surviving fresh set — keep newest by
            // freshnessField. Entries with a missing/invalid timestamp sort to
            // the bottom.
            if (maxEntries > 0 && fresh.length > maxEntries) {
                fresh.sort((a, b) => {
                    const av = Number(a.value && a.value[freshnessField]) || 0
                    const bv = Number(b.value && b.value[freshnessField]) || 0
                    return bv - av
                })
                for (const e of fresh.slice(maxEntries)) drops.push(e.suffix)
            }
            for (const suffix of drops) await inner.delete(suffix)
            return {removed: drops.length, kept: all.length - drops.length}
        }

        return {
            prefix:         prefix,
            ttlMs:          ttlMs,
            maxEntries:     maxEntries,
            freshnessField: freshnessField,
            get:            get,
            getStale:       (suffix) => inner.get(suffix),
            set:            set,
            delete:         (suffix) => inner.delete(suffix),
            bulkGet:        bulkGet,
            getAll:         () => inner.getAll(),
            cleanup:        cleanup,
            watch:          (cb) => inner.watch(cb)
        }
    }

    /**
     * Wraps a single well-known chrome.storage key with TTL semantics.
     * For 1-key caches like `routeAssistant:fuelPriceIndex`. Returns the same
     * `{get, getStale, set, cleanup}` surface as createTtlCache so consumers
     * have one mental model. `watch(cb)` fires for any change to the key.
     */
    function wrapSingleKey(key, ttlMs, fOpts) {
        if (!key || typeof key !== "string") {
            throw new Error("wrapSingleKey: key (string) required")
        }
        const freshnessField = (fOpts && fOpts.freshnessField) || DEFAULT_FRESHNESS_FIELD

        function writer() {
            return (typeof window !== "undefined" && window.AesWriteThrough) || null
        }

        async function getStale() {
            const w = writer()
            if (w && typeof w.get === "function") {
                const value = await w.get(key)
                return value || null
            }
            let out
            try {
                out = await chrome.storage.local.get([key])
            } catch (e) {
                if (handleInvalidatedContext(e)) return null
                throw e
            }
            return out[key] || null
        }

        async function get(getOpts) {
            const rec = await getStale()
            if (!rec) return null
            if (getOpts && getOpts.includeStale) return rec
            return isFreshRecord(rec, ttlMs, freshnessField) ? rec : null
        }

        async function set(value) {
            const toStore = (value && typeof value === "object")
                ? Object.assign({}, value)
                : value
            if (toStore && typeof toStore === "object" && toStore[freshnessField] == null) {
                toStore[freshnessField] = Date.now()
            }
            const w = writer()
            if (w && typeof w.put === "function") await w.put(key, toStore)
            else {
                try {
                    await chrome.storage.local.set({[key]: toStore})
                } catch (e) {
                    if (handleInvalidatedContext(e)) return toStore
                    throw e
                }
            }
            return toStore
        }

        async function cleanup() {
            const rec = await getStale()
            if (rec && !isFreshRecord(rec, ttlMs, freshnessField)) {
                const w = writer()
                if (w && typeof w.remove === "function") await w.remove([key])
                else {
                    try {
                        await chrome.storage.local.remove([key])
                    } catch (e) {
                        if (handleInvalidatedContext(e)) return {removed: 0, kept: 0}
                        throw e
                    }
                }
                return {removed: 1, kept: 0}
            }
            return {removed: 0, kept: rec ? 1 : 0}
        }

        function watch(cb) {
            if (typeof cb !== "function") return () => {}
            const handler = (changes, area) => {
                if (area !== "local") return
                if (!(key in changes)) return
                try { cb(changes[key].newValue, changes[key].oldValue) }
                catch (e) { console.warn("[AES ttl-cache] singleKey watch threw", e) }
            }
            try { chrome.storage.onChanged.addListener(handler) }
            catch (_) { return () => {} }
            return () => { try { chrome.storage.onChanged.removeListener(handler) } catch (_) {} }
        }

        return {
            key:            key,
            ttlMs:          ttlMs,
            freshnessField: freshnessField,
            get:            get,
            getStale:       getStale,
            set:            set,
            cleanup:        cleanup,
            watch:          watch
        }
    }

    /**
     * Ring-buffer trim for stores that pack many records into a single
     * chrome.storage value (e.g. price-history's `entries: []`, accounting
     * index). Drops entries older than `ttlMs`, then enforces `maxEntries`
     * by keeping the most-recent (newest at the END of the returned array,
     * matching the existing shape in price-history-store.js:_trim).
     *
     * Pure function — caller writes the returned array back to storage.
     */
    function trimEntries(entries, opts) {
        if (!Array.isArray(entries)) return []
        const ttlMs          = (opts && opts.ttlMs) || 0
        const maxEntries     = (opts && opts.maxEntries) || 0
        const freshnessField = (opts && opts.freshnessField) || "observedAt"
        const cutoff = ttlMs > 0 ? Date.now() - ttlMs : 0
        const fresh = entries.filter(e => {
            if (!e) return false
            if (cutoff <= 0) return true
            const ts = Number(e[freshnessField])
            return isFinite(ts) && ts >= cutoff
        })
        if (maxEntries > 0 && fresh.length > maxEntries) {
            return fresh.slice(fresh.length - maxEntries)
        }
        return fresh
    }

    window.createTtlCache = createTtlCache
    window.wrapSingleKey  = wrapSingleKey
    window.trimEntries    = trimEntries
})()
