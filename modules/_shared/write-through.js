"use strict"

/**
 * AesWriteThrough — one plumbing path for chrome.storage.local writes.
 *
 * Domain stores still own validation and key shape. This helper owns the
 * mechanical side effects every storage write tends to need:
 *
 *   - write/remove the chrome.storage.local key(s)
 *   - update or invalidate AesStoreCache when present
 *   - emit/publish one or more AesDataBus topics after the commit
 *   - serialize read/modify/write mutations per key in this realm
 *
 * The API is intentionally thin so stores can adopt it incrementally without
 * changing their persisted data shape.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesWriteThrough) return

    const queues = new Map()
    const history = []
    const counters = {
        gets:        0,
        cacheHits:   0,
        cacheMisses: 0,
        sets:        0,
        removes:     0,
        mutates:     0,
        events:      0,
        lastWriteAt: null
    }
    const HISTORY_MAX = 50

    function _storage() {
        try {
            return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
                ? chrome.storage.local
                : null
        } catch (e) {
            if (_handleInvalidatedContext(e)) return null
            throw e
        }
    }

    function _handleInvalidatedContext(err) {
        const msg = err && err.message ? err.message : String(err || "")
        if (!/Extension context invalidated/i.test(msg)) return false
        try {
            if (window.AESSiteSkin?.handleInvalidatedContext?.(err)) return true
        } catch (_) {}
        return true
    }

    function _asKeyList(keys) {
        if (keys == null) return []
        if (Array.isArray(keys)) return keys.filter(k => typeof k === "string" && k)
        if (typeof keys === "string" && keys) return [keys]
        return []
    }

    function _eventSpecs(opts) {
        if (!opts) return []
        if (Array.isArray(opts.events)) return opts.events
        if (opts.topic) {
            return [{
                topic:   opts.topic,
                hint:    opts.hint,
                publish: !!opts.publish,
                value:   opts.value
            }]
        }
        return []
    }

    function _resolve(maybeFn, ctx) {
        return (typeof maybeFn === "function") ? maybeFn(ctx) : maybeFn
    }

    function _emitEvents(opts, ctx) {
        const specs = _eventSpecs(opts)
        if (!specs.length) return
        const bus = window.AesDataBus
        if (!bus || typeof bus.emit !== "function") return
        for (const spec of specs) {
            if (!spec || typeof spec.topic !== "string" || !spec.topic) continue
            const hint = _resolve(spec.hint, ctx) || {}
            if (spec.publish && typeof bus.publish === "function") {
                bus.publish(spec.topic, _resolve(spec.value, ctx), hint)
            } else {
                bus.emit(spec.topic, hint)
            }
            counters.events++
        }
    }

    function _remember(op, keys, opts) {
        const topics = _eventSpecs(opts).map(e => e && e.topic).filter(Boolean)
        const rec = {
            op:     op,
            keys:   _asKeyList(keys),
            topics: topics,
            at:     Date.now()
        }
        history.push(rec)
        if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX)
        counters.lastWriteAt = rec.at
    }

    function _cacheSet(key, value, source) {
        const cache = window.AesStoreCache
        if (!cache || typeof cache.setMem !== "function") return
        try { cache.setMem(key, value, source || "write") } catch (_) {}
    }

    function _cacheRemove(key) {
        const cache = window.AesStoreCache
        if (!cache || typeof cache.invalidate !== "function") return
        try { cache.invalidate(key) } catch (_) {}
    }

    function _cacheGet(key) {
        const cache = window.AesStoreCache
        if (!cache || typeof cache.getMem !== "function") return undefined
        try { return cache.getMem(key) } catch (_) { return undefined }
    }

    function _recordHit(hit) {
        if (hit) counters.cacheHits++
        else counters.cacheMisses++
        const cache = window.AesStoreCache
        if (!cache) return
        try {
            if (hit && typeof cache.recordHit === "function") cache.recordHit()
            if (!hit && typeof cache.recordMiss === "function") cache.recordMiss()
        } catch (_) {}
    }

    async function get(key, opts) {
        if (typeof key !== "string" || !key) return undefined
        counters.gets++
        if (!(opts && opts.fresh)) {
            const cached = _cacheGet(key)
            if (cached) {
                _recordHit(true)
                return cached.value
            }
        }
        _recordHit(false)
        const storage = _storage()
        if (!storage) return undefined
        let out
        try {
            out = await storage.get([key])
        } catch (e) {
            if (_handleInvalidatedContext(e)) return undefined
            throw e
        }
        const value = out ? out[key] : undefined
        if (value !== undefined) _cacheSet(key, value, "read")
        return value
    }

    async function getMany(keys, opts) {
        const list = _asKeyList(keys)
        const out = {}
        if (!list.length) return out
        const missing = []
        if (!(opts && opts.fresh)) {
            for (const key of list) {
                const cached = _cacheGet(key)
                if (cached) {
                    _recordHit(true)
                    out[key] = cached.value
                } else {
                    _recordHit(false)
                    missing.push(key)
                }
            }
        } else {
            missing.push.apply(missing, list)
        }
        if (missing.length) {
            const storage = _storage()
            if (!storage) return out
            let blob
            try {
                blob = await storage.get(missing)
            } catch (e) {
                if (_handleInvalidatedContext(e)) return out
                throw e
            }
            for (const key of missing) {
                if (blob && Object.prototype.hasOwnProperty.call(blob, key)) {
                    out[key] = blob[key]
                    _cacheSet(key, blob[key], "read")
                }
            }
        }
        return out
    }

    async function set(writes, opts) {
        if (!writes || typeof writes !== "object" || Array.isArray(writes)) return {keys: [], writes: {}}
        const keys = Object.keys(writes)
        if (!keys.length) return {keys: [], writes: {}}
        const storage = _storage()
        if (!storage) throw new Error("AesWriteThrough.set: chrome.storage.local unavailable")
        try {
            await storage.set(writes)
        } catch (e) {
            if (_handleInvalidatedContext(e)) return {op: "set", keys: keys, writes: writes, skipped: true}
            throw e
        }
        for (const key of keys) _cacheSet(key, writes[key], "write")
        const ctx = {op: "set", keys: keys, writes: writes}
        counters.sets++
        _remember("set", keys, opts)
        _emitEvents(opts, ctx)
        return ctx
    }

    async function put(key, value, opts) {
        if (typeof key !== "string" || !key) return null
        return set({[key]: value}, opts)
    }

    async function remove(keys, opts) {
        const list = _asKeyList(keys)
        if (!list.length) return {op: "remove", keys: []}
        const storage = _storage()
        if (!storage) throw new Error("AesWriteThrough.remove: chrome.storage.local unavailable")
        try {
            await storage.remove(list)
        } catch (e) {
            if (_handleInvalidatedContext(e)) return {op: "remove", keys: list, skipped: true}
            throw e
        }
        for (const key of list) _cacheRemove(key)
        const ctx = {op: "remove", keys: list}
        counters.removes++
        _remember("remove", list, opts)
        _emitEvents(opts, ctx)
        return ctx
    }

    function _enqueue(scope, fn) {
        const key = String(scope || "global")
        const prior = queues.get(key) || Promise.resolve()
        const run = prior.catch(() => {}).then(fn)
        const tail = run.catch(() => {})
        queues.set(key, tail)
        return run.finally(() => {
            if (queues.get(key) === tail) queues.delete(key)
        })
    }

    async function mutate(key, mutator, opts) {
        if (typeof key !== "string" || !key) return null
        if (typeof mutator !== "function") throw new Error("AesWriteThrough.mutate: mutator function required")
        counters.mutates++
        return _enqueue((opts && opts.queueKey) || key, async () => {
            const before = await get(key, {fresh: true})
            const next = await mutator(before)
            if (next === undefined && opts && opts.removeOnUndefined) {
                await remove([key], opts)
                return {key: key, before: before, after: undefined, removed: true}
            }
            await put(key, next, opts)
            return {key: key, before: before, after: next, removed: false}
        })
    }

    window.AesWriteThrough = {
        get:     get,
        getMany: getMany,
        set:     set,
        put:     put,
        remove:  remove,
        mutate:  mutate,
        stats:   () => Object.assign({pendingQueues: queues.size, recent: history.slice().reverse()}, counters),
        _queues: queues
    }
})()
