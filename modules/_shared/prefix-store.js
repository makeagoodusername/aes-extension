"use strict"

/**
 * Tiny CRUD primitive for chrome.storage.local stores keyed by a shared
 * prefix. The factory replaces the hand-rolled "build full key, get/set,
 * walk all keys filtered by prefix" pattern that's repeated across ~25
 * stores in the codebase.
 *
 * Use this for the **CRUD layer** of a domain store. Domain validation,
 * normalisation, bulk transformations, and account-scoping stay in the
 * domain class — this primitive is intentionally thin so it composes
 * cleanly underneath richer logic.
 *
 * Suitable when the storage shape is one chrome.storage key per record,
 * with the domain's record id as the key suffix (e.g. typeId, hub-dest
 * pair, aircraftId). Not suitable for stores that:
 *   - use L2 account-scoping via `acctKey` — wrap your own logic
 *   - persist a single blob under one key — call chrome.storage directly
 *   - need TTL expiry inside the read path — wrap your own
 *
 * Public API:
 *
 *   const store = createPrefixStore({prefix: "routeAssistant:typeSpec:"})
 *   await store.get(suffix)                    // record | null
 *   await store.set(suffix, value)             // value
 *   await store.delete(suffix)
 *   await store.bulkGet([suffix, …])           // Map<suffix, value>
 *   await store.getAll()                       // [{key, suffix, value}]
 *   const off = store.watch((suffix, newV, oldV) => …)
 *   off()                                      // unsubscribe
 *
 * Pass the prefix INCLUDING its trailing colon (or whatever delimiter the
 * existing store used) — the factory does string concatenation, no
 * normalisation. Keep it identical to the legacy prefix when migrating.
 *
 * Optional plumbing hooks:
 *   topic        AesDataBus topic to emit after set/delete
 *   publish      use AesDataBus.publish(topic, value, hint) instead of emit
 *   makePayload  (suffix, value, ctx) → event hint
 *   makeValue    (suffix, value, ctx) → publish value
 */
function createPrefixStore(opts) {
    const prefix = opts && opts.prefix
    if (!prefix || typeof prefix !== "string") {
        throw new Error("createPrefixStore: opts.prefix (string) required")
    }
    const fullKey = (suffix) => prefix + String(suffix)
    const topic = opts && opts.topic

    function _writer() {
        return (typeof window !== "undefined" && window.AesWriteThrough) || null
    }

    function _handleInvalidatedContext(err) {
        const msg = err && err.message ? err.message : String(err || "")
        if (!/Extension context invalidated/i.test(msg)) return false
        try {
            if (window.AESSiteSkin?.handleInvalidatedContext?.(err)) return true
        } catch (_) {}
        return true
    }

    function _eventOpts(suffix, value, op) {
        if (!topic) return null
        const ctx = {prefix: prefix, suffix: suffix, value: value, op: op}
        return {
            topic:   topic,
            publish: !!(opts && opts.publish),
            hint:    opts && typeof opts.makePayload === "function"
                ? () => opts.makePayload(suffix, value, ctx)
                : {suffix: suffix},
            value:   opts && typeof opts.makeValue === "function"
                ? () => opts.makeValue(suffix, value, ctx)
                : value
        }
    }

    return {
        prefix,

        async get(suffix) {
            if (suffix == null || suffix === "") return null
            const key = fullKey(suffix)
            const writer = _writer()
            if (writer && typeof writer.get === "function") {
                const value = await writer.get(key)
                return value === undefined ? null : value
            }
            let out
            try {
                out = await chrome.storage.local.get([key])
            } catch (e) {
                if (_handleInvalidatedContext(e)) return null
                throw e
            }
            return (key in out) ? out[key] : null
        },

        async set(suffix, value) {
            if (suffix == null || suffix === "") return null
            const key = fullKey(suffix)
            const writer = _writer()
            if (writer && typeof writer.put === "function") {
                await writer.put(key, value, _eventOpts(suffix, value, "set"))
            } else {
                try {
                    await chrome.storage.local.set({[key]: value})
                } catch (e) {
                    if (_handleInvalidatedContext(e)) return value
                    throw e
                }
                if (topic && typeof AesDataBus !== "undefined") {
                    AesDataBus.emit(topic, {suffix: suffix})
                }
            }
            return value
        },

        async delete(suffix) {
            if (suffix == null || suffix === "") return
            const key = fullKey(suffix)
            const writer = _writer()
            if (writer && typeof writer.remove === "function") {
                await writer.remove([key], _eventOpts(suffix, null, "delete"))
            } else {
                try {
                    await chrome.storage.local.remove([key])
                } catch (e) {
                    if (_handleInvalidatedContext(e)) return
                    throw e
                }
                if (topic && typeof AesDataBus !== "undefined") {
                    AesDataBus.emit(topic, {suffix: suffix, deleted: true})
                }
            }
        },

        async bulkGet(suffixes) {
            if (!Array.isArray(suffixes) || !suffixes.length) return new Map()
            const ids = suffixes.filter(s => s != null && s !== "")
            if (!ids.length) return new Map()
            const keys = ids.map(fullKey)
            const writer = _writer()
            let blob
            if (writer && typeof writer.getMany === "function") {
                blob = await writer.getMany(keys)
            } else {
                try {
                    blob = await chrome.storage.local.get(keys)
                } catch (e) {
                    if (_handleInvalidatedContext(e)) return new Map()
                    throw e
                }
            }
            const map = new Map()
            for (let i = 0; i < ids.length; i++) {
                if (keys[i] in blob) map.set(ids[i], blob[keys[i]])
            }
            return map
        },

        async getAll() {
            let all
            try {
                all = await chrome.storage.local.get(null)
            } catch (e) {
                if (_handleInvalidatedContext(e)) return []
                throw e
            }
            const out = []
            for (const k in all) {
                if (k.indexOf(prefix) !== 0) continue
                out.push({key: k, suffix: k.substring(prefix.length), value: all[k]})
            }
            return out
        },

        watch(cb) {
            if (typeof cb !== "function") return () => {}
            const handler = (changes, area) => {
                if (area !== "local") return
                for (const k in changes) {
                    if (k.indexOf(prefix) !== 0) continue
                    const suffix = k.substring(prefix.length)
                    try { cb(suffix, changes[k].newValue, changes[k].oldValue) }
                    catch (e) { console.warn("[AES prefix-store] watch handler threw", e) }
                }
            }
            try { chrome.storage.onChanged.addListener(handler) }
            catch (_) { return () => {} }
            return () => { try { chrome.storage.onChanged.removeListener(handler) } catch (_) {} }
        }
    }
}

if (typeof window !== "undefined") {
    window.createPrefixStore = createPrefixStore
}
