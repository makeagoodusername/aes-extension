"use strict"

/**
 * AesRelay — small consumer-side helpers that close the common
 * "writer emits, reader doesn't subscribe" relay gaps catalogued in
 * audit/pathway-bus.md (G-014) and audit/pathway-storage.md.
 *
 * Three primitives:
 *
 *   AesRelay.subscribeWithReplay(bus, topic, handler) → unsubscribe
 *     bus.on(topic, handler) THEN synchronously bus.replay(topic). Closes the
 *     mount-order race where a tile subscribes after a cross-page intent
 *     (focus-route, focus-aircraft, open-tile, data:account:bootstrapped) has
 *     already fired. Works against AesDataBus, CentralHubBus, AesAfp.bus,
 *     AesStrategy.bus — all expose `on` + `replay`.
 *
 *   AesRelay.onSettingsArea(area, handler) → unsubscribe
 *     Subscribe to "data:settings:area:saved" and forward only the records
 *     whose hint.area matches. Replays the last record on attach so a
 *     consumer that mounts after a settings flip still re-applies.
 *
 *   AesRelay.onStorageKey(prefix, handler) → unsubscribe
 *     Wrap chrome.storage.local.onChanged and call handler({key, suffix,
 *     newValue, oldValue}) for any change to a key starting with prefix. The
 *     missing primitive for cross-tab data relay (chrome.storage fires across
 *     tabs; the tab-local AesDataBus does not). Use single:true to match an
 *     exact key.
 *
 * Each helper returns an unsubscribe function. All three tolerate missing
 * dependencies (no bus, no chrome.storage) by no-oping with the handler
 * never invoked — content scripts may load on pages without the dependency.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesRelay) return

    function subscribeWithReplay(bus, topic, handler) {
        if (!bus || typeof bus.on !== "function") return function () {}
        if (typeof topic !== "string" || !topic)  return function () {}
        if (typeof handler !== "function")        return function () {}
        const off = bus.on(topic, handler) || function () {}
        if (typeof bus.replay === "function") {
            try {
                const last = bus.replay(topic)
                if (last) handler(last)
            } catch (e) { /* replay handler threw — leave subscription alive */ }
        }
        return typeof off === "function" ? off : function () { bus.off && bus.off(topic, handler) }
    }

    function onSettingsArea(area, handler) {
        if (typeof area !== "string" || !area)     return function () {}
        if (typeof handler !== "function")         return function () {}
        const bus = window.AesDataBus
        if (!bus || typeof bus.on !== "function")  return function () {}
        const wrapped = function (record) {
            if (!record || record.area !== area) return
            try { handler(record) }
            catch (e) { try { console.warn("[AesRelay] settings handler threw", area, e) } catch (_) {} }
        }
        return subscribeWithReplay(bus, "data:settings:area:saved", wrapped)
    }

    function onStorageKey(prefix, handler, opts) {
        if (typeof prefix !== "string" || !prefix) return function () {}
        if (typeof handler !== "function")         return function () {}
        const single = !!(opts && opts.single)
        const api = (window.chrome && chrome.storage && chrome.storage.onChanged) || null
        if (!api || typeof api.addListener !== "function") return function () {}
        const listener = function (changes, areaName) {
            if (areaName !== "local") return
            for (const key in changes) {
                const matches = single ? (key === prefix) : (key.indexOf(prefix) === 0)
                if (!matches) continue
                const ch = changes[key]
                try {
                    handler({
                        key:      key,
                        suffix:   single ? null : key.substring(prefix.length),
                        newValue: ch && ch.newValue,
                        oldValue: ch && ch.oldValue
                    })
                } catch (e) { try { console.warn("[AesRelay] storage handler threw", prefix, e) } catch (_) {} }
            }
        }
        try { api.addListener(listener) }
        catch (_) { return function () {} }
        return function () {
            try { api.removeListener(listener) } catch (_) {}
        }
    }

    window.AesRelay = {
        subscribeWithReplay: subscribeWithReplay,
        onSettingsArea:      onSettingsArea,
        onStorageKey:        onStorageKey
    }
})()
