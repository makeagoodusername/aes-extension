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
 */
function createPrefixStore(opts) {
    const prefix = opts && opts.prefix
    if (!prefix || typeof prefix !== "string") {
        throw new Error("createPrefixStore: opts.prefix (string) required")
    }
    const fullKey = (suffix) => prefix + String(suffix)

    return {
        prefix,

        async get(suffix) {
            if (suffix == null || suffix === "") return null
            const key = fullKey(suffix)
            const out = await chrome.storage.local.get([key])
            return (key in out) ? out[key] : null
        },

        async set(suffix, value) {
            if (suffix == null || suffix === "") return null
            await chrome.storage.local.set({[fullKey(suffix)]: value})
            return value
        },

        async delete(suffix) {
            if (suffix == null || suffix === "") return
            await chrome.storage.local.remove([fullKey(suffix)])
        },

        async bulkGet(suffixes) {
            if (!Array.isArray(suffixes) || !suffixes.length) return new Map()
            const ids = suffixes.filter(s => s != null && s !== "")
            if (!ids.length) return new Map()
            const keys = ids.map(fullKey)
            const blob = await chrome.storage.local.get(keys)
            const map = new Map()
            for (let i = 0; i < ids.length; i++) {
                if (keys[i] in blob) map.set(ids[i], blob[keys[i]])
            }
            return map
        },

        async getAll() {
            const all = await chrome.storage.local.get(null)
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
