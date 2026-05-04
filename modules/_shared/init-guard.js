"use strict"

/**
 * AesInit — startup guard for independently-mounted content-script slices.
 *
 * This file runs early and intentionally depends on nothing: no jQuery, no
 * data bus, no page anchors. Startup modules can wrap their boot paths in
 * `safe()` or `once()` so a local failure records diagnostics without
 * aborting the rest of the content-script chain.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesInit) return

    const TOPIC = "data:init:startup:failed"
    const failures = new Map()
    const onceResults = new Map()
    const pendingBus = []
    let seq = 0
    let flushTimer = null
    let flushAttempts = 0

    function nowIso(at) {
        try { return new Date(at).toISOString() } catch (_) { return "" }
    }

    function pageUrl() {
        try { return String(window.location && window.location.href || "") }
        catch (_) { return "" }
    }

    function errorInfo(error) {
        if (error instanceof Error) {
            return {
                name: error.name || "Error",
                message: error.message || String(error),
                stack: error.stack || ""
            }
        }
        if (typeof error === "string") {
            return {name: "StartupDegradation", message: error, stack: ""}
        }
        try {
            return {
                name: error && error.name ? String(error.name) : "StartupDegradation",
                message: error && error.message ? String(error.message) : JSON.stringify(error),
                stack: error && error.stack ? String(error.stack) : ""
            }
        } catch (_) {
            return {name: "StartupDegradation", message: String(error), stack: ""}
        }
    }

    function cloneFailure(entry) {
        return {
            id: entry.id,
            label: entry.label,
            name: entry.name,
            message: entry.message,
            stack: entry.stack,
            url: entry.url,
            at: entry.at,
            iso: entry.iso,
            count: entry.count,
            lastAt: entry.lastAt,
            lastIso: entry.lastIso
        }
    }

    function flushBus() {
        flushTimer = null
        const bus = window.AesDataBus
        if (!bus || typeof bus.emit !== "function") {
            if (pendingBus.length && flushAttempts < 80) {
                flushAttempts += 1
                flushTimer = setTimeout(flushBus, 250)
            }
            return
        }
        flushAttempts = 0
        while (pendingBus.length) {
            const entry = pendingBus.shift()
            try {
                bus.emit(TOPIC, {
                    label: entry.label,
                    name: entry.name,
                    message: entry.message,
                    stack: entry.stack,
                    url: entry.url,
                    firstAt: entry.at,
                    lastAt: entry.lastAt,
                    count: entry.count
                })
            } catch (_) {
                break
            }
        }
        if (pendingBus.length && !flushTimer) {
            flushTimer = setTimeout(flushBus, 250)
        }
    }

    function scheduleFlush() {
        if (flushTimer) return
        flushTimer = setTimeout(flushBus, 0)
    }

    function notify(entry) {
        try {
            window.dispatchEvent(new CustomEvent("aes:init:health", {
                detail: cloneFailure(entry)
            }))
        } catch (_) { /* noop */ }
    }

    function record(label, error) {
        const key = String(label || "startup")
        const info = errorInfo(error)
        const at = Date.now()
        let entry = failures.get(key)
        if (!entry) {
            entry = {
                id: ++seq,
                label: key,
                name: info.name,
                message: info.message || "Unknown startup failure",
                stack: info.stack,
                url: pageUrl(),
                at: at,
                iso: nowIso(at),
                count: 0,
                lastAt: at,
                lastIso: nowIso(at)
            }
            failures.set(key, entry)
            pendingBus.push(entry)
        } else {
            entry.name = info.name || entry.name
            entry.message = info.message || entry.message
            entry.stack = info.stack || entry.stack
            entry.url = pageUrl() || entry.url
            entry.lastAt = at
            entry.lastIso = nowIso(at)
        }
        entry.count += 1
        try { console.warn("[AES init] " + key + " degraded:", info.message || error) }
        catch (_) { /* noop */ }
        notify(entry)
        scheduleFlush()
        return cloneFailure(entry)
    }

    function safe(label, fn) {
        if (typeof fn !== "function") return undefined
        try {
            const out = fn()
            if (out && typeof out.then === "function") {
                return out.catch(function (err) {
                    record(label, err)
                    return undefined
                })
            }
            return out
        } catch (err) {
            record(label, err)
            return undefined
        }
    }

    function once(key, fn) {
        const k = String(key || "startup")
        if (onceResults.has(k)) return onceResults.get(k)
        const result = safe(k, fn)
        onceResults.set(k, result)
        return result
    }

    function health() {
        const records = Array.from(failures.values()).map(cloneFailure)
        return {
            ok: records.length === 0,
            count: records.length,
            failures: records,
            records: records,
            url: pageUrl()
        }
    }

    window.AesInit = {
        safe: safe,
        once: once,
        record: record,
        health: health
    }
})()
