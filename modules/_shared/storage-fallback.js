"use strict"

/**
 * Defensive storage shim for non-extension harnesses and degraded Chrome API
 * contexts. Real chrome.storage implementations are left untouched; only
 * missing pieces are backed by an in-memory area so dashboard launch code can
 * render a degraded UI instead of throwing at bootstrap.
 */
;(function (root) {
    if (!root) return

    const chromeObj = root.chrome = root.chrome || {}
    const storage = chromeObj.storage = chromeObj.storage || {}
    const listeners = root.__aesStorageFallbackListeners = root.__aesStorageFallbackListeners || []
    const areas = root.__aesStorageFallbackAreas = root.__aesStorageFallbackAreas || {
        local:   {},
        sync:    {},
        session: {}
    }
    const runtimeMessageListeners = root.__aesRuntimeFallbackMessageListeners
        = root.__aesRuntimeFallbackMessageListeners || []
    const runtimeInstalledListeners = root.__aesRuntimeFallbackInstalledListeners
        = root.__aesRuntimeFallbackInstalledListeners || []
    const runtimeStartupListeners = root.__aesRuntimeFallbackStartupListeners
        = root.__aesRuntimeFallbackStartupListeners || []
    const alarmListeners = root.__aesAlarmFallbackListeners
        = root.__aesAlarmFallbackListeners || []
    const notificationClickListeners = root.__aesNotificationFallbackClickListeners
        = root.__aesNotificationFallbackClickListeners || []
    const notificationButtonListeners = root.__aesNotificationFallbackButtonListeners
        = root.__aesNotificationFallbackButtonListeners || []

    const fallbackRootUrl = (function () {
        try {
            const src = root.document
                && root.document.currentScript
                && root.document.currentScript.src
            if (src) {
                return src.replace(/modules\/_shared\/storage-fallback\.js(?:[?#].*)?$/, "")
            }
        } catch (_) { /* noop */ }
        try { return root.location && root.location.href || "" }
        catch (_) { return "" }
    })()

    function clone(value) {
        if (value == null) return value
        try { return JSON.parse(JSON.stringify(value)) }
        catch (_) {
            if (Array.isArray(value)) return value.slice()
            if (typeof value === "object") return Object.assign({}, value)
            return value
        }
    }

    function finish(cb, value) {
        if (typeof cb === "function") {
            setTimeout(function () { cb(value) }, 0)
            return undefined
        }
        return Promise.resolve(value)
    }

    function makeEvent(list) {
        return {
            addListener: function (fn) {
                if (typeof fn === "function" && list.indexOf(fn) < 0) list.push(fn)
            },
            removeListener: function (fn) {
                const idx = list.indexOf(fn)
                if (idx >= 0) list.splice(idx, 1)
            },
            hasListener: function (fn) {
                return list.indexOf(fn) >= 0
            }
        }
    }

    function fallbackGetUrl(assetPath) {
        const cleanPath = String(assetPath || "").replace(/^\/+/, "")
        if (!fallbackRootUrl) return cleanPath
        try { return new URL(cleanPath, fallbackRootUrl).href }
        catch (_) { return cleanPath }
    }

    function readArea(area, keys) {
        const out = {}
        if (keys == null) {
            Object.keys(area).forEach(function (key) { out[key] = clone(area[key]) })
            return out
        }
        if (typeof keys === "string") {
            if (Object.prototype.hasOwnProperty.call(area, keys)) out[keys] = clone(area[keys])
            return out
        }
        if (Array.isArray(keys)) {
            keys.forEach(function (key) {
                if (Object.prototype.hasOwnProperty.call(area, key)) out[key] = clone(area[key])
            })
            return out
        }
        if (typeof keys === "object") {
            Object.keys(keys).forEach(function (key) {
                out[key] = Object.prototype.hasOwnProperty.call(area, key) ? clone(area[key]) : clone(keys[key])
            })
        }
        return out
    }

    function notify(changes, areaName) {
        listeners.slice().forEach(function (fn) {
            try { fn(changes, areaName) } catch (_) { /* listener isolation */ }
        })
    }

    function ensureArea(name) {
        const backing = areas[name] = areas[name] || {}
        const target = storage[name] = storage[name] || {}
        if (typeof target.get !== "function") {
            target.get = function (keys, cb) {
                return finish(cb, readArea(backing, keys))
            }
        }
        if (typeof target.set !== "function") {
            target.set = function (items, cb) {
                const changes = {}
                Object.keys(items || {}).forEach(function (key) {
                    const next = clone(items[key])
                    changes[key] = {oldValue: clone(backing[key]), newValue: clone(next)}
                    backing[key] = next
                })
                notify(changes, name)
                return finish(cb)
            }
        }
        if (typeof target.remove !== "function") {
            target.remove = function (keys, cb) {
                const arr = Array.isArray(keys) ? keys : [keys]
                const changes = {}
                arr.forEach(function (key) {
                    if (Object.prototype.hasOwnProperty.call(backing, key)) {
                        changes[key] = {oldValue: clone(backing[key]), newValue: undefined}
                        delete backing[key]
                    }
                })
                notify(changes, name)
                return finish(cb)
            }
        }
        if (typeof target.clear !== "function") {
            target.clear = function (cb) {
                const changes = {}
                Object.keys(backing).forEach(function (key) {
                    changes[key] = {oldValue: clone(backing[key]), newValue: undefined}
                    delete backing[key]
                })
                notify(changes, name)
                return finish(cb)
            }
        }
        if (typeof target.getBytesInUse !== "function") {
            target.getBytesInUse = function (_, cb) {
                return finish(cb, 0)
            }
        }
    }

    storage.onChanged = storage.onChanged || {}
    if (typeof storage.onChanged.addListener !== "function") {
        storage.onChanged.addListener = function (fn) {
            if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn)
        }
    }
    if (typeof storage.onChanged.removeListener !== "function") {
        storage.onChanged.removeListener = function (fn) {
            const idx = listeners.indexOf(fn)
            if (idx >= 0) listeners.splice(idx, 1)
        }
    }
    if (typeof storage.onChanged.hasListener !== "function") {
        storage.onChanged.hasListener = function (fn) {
            return listeners.indexOf(fn) >= 0
        }
    }

    ensureArea("local")
    ensureArea("sync")
    ensureArea("session")

    chromeObj.runtime = chromeObj.runtime || {}
    if (typeof chromeObj.runtime.getManifest !== "function") {
        chromeObj.runtime.getManifest = function () {
            return {
                name: "AES fallback",
                version: "0.0.0-fallback",
                version_name: "0.0.0-fallback",
                manifest_version: 3
            }
        }
    }
    if (typeof chromeObj.runtime.getURL !== "function") {
        chromeObj.runtime.getURL = fallbackGetUrl
    }
    if (typeof chromeObj.runtime.sendMessage !== "function") {
        chromeObj.runtime.sendMessage = function (_message, cb) {
            return finish(cb, {ok: false, reason: "chrome-runtime-fallback"})
        }
    }
    if (typeof chromeObj.runtime.openOptionsPage !== "function") {
        chromeObj.runtime.openOptionsPage = function (cb) {
            try {
                if (root.open) root.open(fallbackGetUrl("options.html"), "_blank")
            } catch (_) { /* noop */ }
            return finish(cb)
        }
    }
    chromeObj.runtime.onMessage = chromeObj.runtime.onMessage || makeEvent(runtimeMessageListeners)
    if (typeof chromeObj.runtime.onMessage.addListener !== "function") {
        chromeObj.runtime.onMessage = makeEvent(runtimeMessageListeners)
    }
    chromeObj.runtime.onInstalled = chromeObj.runtime.onInstalled || makeEvent(runtimeInstalledListeners)
    if (typeof chromeObj.runtime.onInstalled.addListener !== "function") {
        chromeObj.runtime.onInstalled = makeEvent(runtimeInstalledListeners)
    }
    chromeObj.runtime.onStartup = chromeObj.runtime.onStartup || makeEvent(runtimeStartupListeners)
    if (typeof chromeObj.runtime.onStartup.addListener !== "function") {
        chromeObj.runtime.onStartup = makeEvent(runtimeStartupListeners)
    }

    chromeObj.tabs = chromeObj.tabs || {}
    if (typeof chromeObj.tabs.query !== "function") {
        chromeObj.tabs.query = function (_queryInfo, cb) { return finish(cb, []) }
    }
    if (typeof chromeObj.tabs.create !== "function") {
        chromeObj.tabs.create = function (createProperties, cb) {
            const tab = {
                id: 0,
                url: createProperties && createProperties.url || "",
                active: !!(createProperties && createProperties.active)
            }
            try {
                if (tab.url && root.open) root.open(tab.url, "_blank")
            } catch (_) { /* noop */ }
            return finish(cb, tab)
        }
    }
    if (typeof chromeObj.tabs.update !== "function") {
        chromeObj.tabs.update = function (_tabId, updateProperties, cb) {
            return finish(cb, {id: 0, url: updateProperties && updateProperties.url || ""})
        }
    }
    if (typeof chromeObj.tabs.remove !== "function") {
        chromeObj.tabs.remove = function (_tabIds, cb) { return finish(cb) }
    }
    if (typeof chromeObj.tabs.sendMessage !== "function") {
        chromeObj.tabs.sendMessage = function (_tabId, _message, cb) {
            return finish(cb, {ok: false, reason: "chrome-tabs-fallback"})
        }
    }
    chromeObj.tabs.onUpdated = chromeObj.tabs.onUpdated || makeEvent([])
    chromeObj.tabs.onRemoved = chromeObj.tabs.onRemoved || makeEvent([])

    chromeObj.alarms = chromeObj.alarms || {}
    if (typeof chromeObj.alarms.create !== "function") chromeObj.alarms.create = function () {}
    if (typeof chromeObj.alarms.clear !== "function") {
        chromeObj.alarms.clear = function (_name, cb) { return finish(cb, true) }
    }
    if (typeof chromeObj.alarms.get !== "function") {
        chromeObj.alarms.get = function (_name, cb) { return finish(cb, null) }
    }
    if (typeof chromeObj.alarms.getAll !== "function") {
        chromeObj.alarms.getAll = function (cb) { return finish(cb, []) }
    }
    chromeObj.alarms.onAlarm = chromeObj.alarms.onAlarm || makeEvent(alarmListeners)
    if (typeof chromeObj.alarms.onAlarm.addListener !== "function") {
        chromeObj.alarms.onAlarm = makeEvent(alarmListeners)
    }

    chromeObj.notifications = chromeObj.notifications || {}
    if (typeof chromeObj.notifications.create !== "function") {
        chromeObj.notifications.create = function (_id, _options, cb) { return finish(cb, "") }
    }
    if (typeof chromeObj.notifications.clear !== "function") {
        chromeObj.notifications.clear = function (_id, cb) { return finish(cb, true) }
    }
    chromeObj.notifications.onClicked = chromeObj.notifications.onClicked || makeEvent(notificationClickListeners)
    if (typeof chromeObj.notifications.onClicked.addListener !== "function") {
        chromeObj.notifications.onClicked = makeEvent(notificationClickListeners)
    }
    chromeObj.notifications.onButtonClicked = chromeObj.notifications.onButtonClicked
        || makeEvent(notificationButtonListeners)
    if (typeof chromeObj.notifications.onButtonClicked.addListener !== "function") {
        chromeObj.notifications.onButtonClicked = makeEvent(notificationButtonListeners)
    }

    chromeObj.permissions = chromeObj.permissions || {}
    if (typeof chromeObj.permissions.contains !== "function") {
        chromeObj.permissions.contains = function (_permissions, cb) { return finish(cb, true) }
    }
})(typeof globalThis !== "undefined"
    ? globalThis
    : (typeof window !== "undefined" ? window : null))
