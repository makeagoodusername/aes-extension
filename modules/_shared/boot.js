"use strict"

/**
 * AES page bootstrap.
 *
 * Content scripts can be injected more than once on overlapping AirlineSim
 * URL patterns or after an extension reload. This registry gives each page
 * initializer a stable id, normalizes shared context once, waits briefly for
 * Wicket-rendered anchors, and isolates init failures so one feature cannot
 * abort the rest of the extension substrate.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesBoot && window.AesBoot.__aesBoot) {
        try { window.AesBoot._noteDuplicate && window.AesBoot._noteDuplicate("AesBoot") }
        catch (_) { /* noop */ }
        return
    }

    const DEFAULT_ANCHOR_TIMEOUT_MS = 8000
    const DEFAULT_DEP_TIMEOUT_MS = 8000
    const POLL_MS = 100

    const registry = new Map()
    const onceRuns = new Map()
    const duplicateCounts = new Map()
    const warnings = new Set()
    let contextPromise = null
    let contextValue = null
    let runScheduled = false

    function nowIso() {
        try { return new Date().toISOString() } catch (_) { return "" }
    }

    function warnOnce(key, message, detail) {
        if (warnings.has(key)) return
        warnings.add(key)
        try {
            if (detail !== undefined) console.warn("[AES boot] " + message, detail)
            else console.warn("[AES boot] " + message)
        } catch (_) { /* noop */ }
    }

    function recordDegraded(label, detail) {
        try {
            if (window.AesInit && typeof window.AesInit.record === "function") {
                window.AesInit.record("boot." + label, detail)
            }
        } catch (_) { /* noop */ }
    }

    function noteDuplicate(id) {
        const next = (duplicateCounts.get(id) || 0) + 1
        duplicateCounts.set(id, next)
        const rec = registry.get(id)
        if (rec) rec.duplicateCount = next
        return next
    }

    function cloneSerializable(value) {
        if (value === undefined) return undefined
        try { return JSON.parse(JSON.stringify(value)) }
        catch (_) {
            if (Array.isArray(value)) return value.slice()
            if (value && typeof value === "object") return Object.assign({}, value)
            return value
        }
    }

    function isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value)
    }

    function storageGet(keys) {
        return new Promise((resolve) => {
            try {
                if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
                    resolve({})
                    return
                }
                const maybe = chrome.storage.local.get(keys, (result) => {
                    const err = chrome.runtime && chrome.runtime.lastError
                    if (err) {
                        warnOnce("storage:get:" + keys, "storage read failed; using defaults", err)
                        resolve({})
                        return
                    }
                    resolve(result || {})
                })
                if (maybe && typeof maybe.then === "function") {
                    maybe.then(resolve).catch((err) => {
                        warnOnce("storage:get:promise:" + keys, "storage read failed; using defaults", err)
                        resolve({})
                    })
                }
            } catch (err) {
                warnOnce("storage:get:throw:" + keys, "storage read threw; using defaults", err)
                resolve({})
            }
        })
    }

    function normalizeSettings(raw) {
        if (!isPlainObject(raw)) {
            if (raw !== undefined) warnOnce("settings:invalid", "settings cache was invalid; using defaults")
            if (raw !== undefined) recordDegraded("settings.invalid", "settings cache was invalid; using defaults")
            try { return AES.defaultSettings() } catch (_) { return {} }
        }
        try {
            return AES.normalizeSettings(raw)
        } catch (err) {
            warnOnce("settings:normalize", "settings normalization failed; using defaults", err)
            recordDegraded("settings.normalize", err)
            try { return AES.defaultSettings() } catch (_) { return {} }
        }
    }

    function waitForDomReady() {
        if (document.readyState !== "loading") return Promise.resolve()
        return new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, {once: true}))
    }

    function detectPageKind(url) {
        const href = String(url || "")
        const path = window.location && window.location.pathname ? window.location.pathname : ""
        if (/^https:\/\/www\.flightsfrom\.com\//i.test(href)) return "flightsFrom"
        if (/\/app\/enterprise\/dashboard/.test(path)) return "dashboard"
        if (/\/app\/enterprise\/settings/.test(path)) return "settings"
        if (/\/app\/com\/inventory\//.test(path)) return "inventory"
        if (/\/app\/fleets\/aircraft\/[^/]+\/0/.test(path)) return "aircraftFlightPlan"
        if (/\/app\/fleets\/aircraft\/[^/]+\/1/.test(path)) return "aircraftFlights"
        if (/\/app\/fleets/.test(path)) return "fleetHub"
        if (/\/app\/com\/scheduling/.test(path)) return "scheduling"
        if (/\/app\//.test(path)) return "airlineSimApp"
        if (/\/action\//.test(path)) return "airlineSimAction"
        return "unknown"
    }

    async function prepareContext() {
        if (contextValue) return contextValue
        if (contextPromise) return contextPromise
        contextPromise = (async () => {
            await waitForDomReady()

            const storage = await storageGet(["settings"])
            const settings = normalizeSettings(storage.settings)
            let server = ""
            let airline = {name: "", code: ""}
            let airlineIdentity = ""
            try { server = AES.getServerName ? AES.getServerName() : "" }
            catch (err) { warnOnce("ctx:server", "server detection failed", err) }
            try { airlineIdentity = AES.getAirlineIdentity ? (AES.getAirlineIdentity() || "") : "" }
            catch (err) { warnOnce("ctx:identity", "airline identity detection failed", err) }
            try { airline = AES.getAirlineCode ? AES.getAirlineCode() : airline }
            catch (err) { warnOnce("ctx:airline", "airline code detection failed", err) }
            if (!airline || typeof airline !== "object") airline = {name: "", code: ""}
            if (!airline.name && airlineIdentity) airline.name = airlineIdentity
            if (!airline.code && airlineIdentity) airline.code = airlineIdentity

            contextValue = {
                url: window.location.href,
                pageKind: detectPageKind(window.location.href),
                settings,
                server,
                airline,
                airlineIdentity,
                domReady: document.readyState !== "loading",
                preparedAt: nowIso()
            }
            return contextValue
        })()
        return contextPromise
    }

    function matchOne(match, ctx) {
        if (!match) return true
        if (typeof match === "function") return !!match(ctx)
        if (match instanceof RegExp) return match.test(ctx.url)
        if (typeof match === "string") {
            if (match === ctx.pageKind) return true
            return ctx.url.indexOf(match) !== -1
        }
        return false
    }

    function matchesPage(rec, ctx) {
        const matches = rec.matches
        if (!matches || (Array.isArray(matches) && !matches.length)) return true
        const list = Array.isArray(matches) ? matches : [matches]
        return list.some(match => matchOne(match, ctx))
    }

    function getPath(root, path) {
        const parts = String(path || "").split(".")
        let cur = root
        for (const part of parts) {
            if (!part) continue
            if (cur == null) return undefined
            cur = cur[part]
        }
        return cur
    }

    function depReady(dep, ctx) {
        if (!dep) return true
        if (typeof dep === "function") return !!dep(ctx)
        if (typeof dep === "string") {
            if (registry.has(dep)) return registry.get(dep).state === "ready"
            return getPath(window, dep) !== undefined
        }
        if (dep.id) return registry.has(dep.id) && registry.get(dep.id).state === "ready"
        if (dep.global) return getPath(window, dep.global) !== undefined
        if (dep.ready && typeof dep.ready === "function") return !!dep.ready(ctx)
        return true
    }

    function depLabel(dep) {
        if (typeof dep === "string") return dep
        if (typeof dep === "function") return dep.name || "anonymous dependency"
        if (dep && dep.id) return dep.id
        if (dep && dep.global) return dep.global
        if (dep && dep.label) return dep.label
        return "dependency"
    }

    function collectDeps(rec) {
        const deps = rec.deps || []
        return Array.isArray(deps) ? deps : [deps]
    }

    function resolveAnchor(anchor, ctx) {
        if (!anchor) return document.documentElement
        if (typeof anchor === "function") return anchor(ctx)
        if (typeof anchor === "string") return document.querySelector(anchor)
        if (anchor.selector) return document.querySelector(anchor.selector)
        if (anchor.find && typeof anchor.find === "function") return anchor.find(ctx)
        return null
    }

    function anchorLabel(anchor) {
        if (typeof anchor === "string") return anchor
        if (typeof anchor === "function") return anchor.name || "custom anchor"
        if (anchor && anchor.label) return anchor.label
        if (anchor && anchor.selector) return anchor.selector
        return "anchor"
    }

    function collectAnchors(rec) {
        const anchors = rec.anchors || rec.anchor || []
        if (!anchors) return []
        return Array.isArray(anchors) ? anchors : [anchors]
    }

    function waitFor(check, timeoutMs) {
        const started = Date.now()
        return new Promise((resolve) => {
            const tick = () => {
                let result = null
                try { result = check() }
                catch (_) { result = null }
                if (result) {
                    resolve(result)
                    return
                }
                if (Date.now() - started >= timeoutMs) {
                    resolve(null)
                    return
                }
                setTimeout(tick, POLL_MS)
            }
            tick()
        })
    }

    async function waitDeps(rec, ctx) {
        const deps = collectDeps(rec)
        if (!deps.length) return {ok: true}
        const missing = await waitFor(() => {
            const outstanding = deps.filter(dep => !depReady(dep, ctx)).map(depLabel)
            return outstanding.length ? null : true
        }, rec.depTimeoutMs || DEFAULT_DEP_TIMEOUT_MS)
        if (missing) return {ok: true}
        return {
            ok: false,
            missing: deps.filter(dep => !depReady(dep, ctx)).map(depLabel)
        }
    }

    async function waitAnchors(rec, ctx) {
        const anchors = collectAnchors(rec)
        if (!anchors.length) return {ok: true, anchors: []}
        const found = []
        for (const anchor of anchors) {
            const node = await waitFor(() => resolveAnchor(anchor, ctx), rec.anchorTimeoutMs || DEFAULT_ANCHOR_TIMEOUT_MS)
            if (!node) {
                return {ok: false, missing: anchorLabel(anchor), anchors: found}
            }
            found.push(node)
        }
        return {ok: true, anchors: found}
    }

    async function startRecord(rec, ctx) {
        if (rec.state === "ready" || rec.state === "running"
                || rec.state === "failed" || rec.state === "skipped") return rec
        if (!matchesPage(rec, ctx)) {
            rec.state = "skipped"
            rec.reason = "page mismatch"
            rec.completedAt = nowIso()
            return rec
        }

        rec.state = "running"
        rec.startedAt = nowIso()
        const deps = await waitDeps(rec, ctx)
        if (!deps.ok) {
            rec.state = rec.optional ? "skipped" : "failed"
            rec.reason = "missing dependencies: " + deps.missing.join(", ")
            rec.completedAt = nowIso()
            warnOnce("module:deps:" + rec.id, rec.id + " skipped: " + rec.reason)
            recordDegraded(rec.id, rec.reason)
            return rec
        }

        const anchors = await waitAnchors(rec, ctx)
        if (!anchors.ok) {
            rec.state = "skipped"
            rec.reason = "missing anchor: " + anchors.missing
            rec.skippedAnchor = anchors.missing
            rec.completedAt = nowIso()
            warnOnce("module:anchor:" + rec.id, rec.id + " skipped: " + rec.reason)
            recordDegraded(rec.id, rec.reason)
            return rec
        }

        try {
            const result = rec.init ? rec.init(ctx, {anchors: anchors.anchors, module: rec, boot: AesBoot}) : undefined
            rec.result = await Promise.resolve(result)
            rec.state = "ready"
            rec.reason = ""
            rec.completedAt = nowIso()
        } catch (err) {
            rec.state = "failed"
            rec.error = err && err.stack ? err.stack : (err && err.message ? err.message : String(err))
            rec.completedAt = nowIso()
            warnOnce("module:init:" + rec.id, rec.id + " init failed", err)
            recordDegraded(rec.id, err)
        }
        return rec
    }

    function scheduleRun() {
        if (runScheduled) return
        runScheduled = true
        setTimeout(() => {
            runScheduled = false
            AesBoot.runPage().catch(err => warnOnce("runPage", "runPage failed", err))
        }, 0)
    }

    function register(definition) {
        const def = definition || {}
        const id = String(def.id || "").trim()
        if (!id) throw new Error("AesBoot.register requires a stable id")
        if (registry.has(id)) {
            noteDuplicate(id)
            return registry.get(id)
        }
        const rec = {
            id,
            matches: def.matches,
            deps: def.deps || [],
            anchor: def.anchor,
            anchors: def.anchors,
            anchorTimeoutMs: def.anchorTimeoutMs,
            depTimeoutMs: def.depTimeoutMs,
            init: typeof def.init === "function" ? def.init : null,
            teardown: typeof def.teardown === "function" ? def.teardown : null,
            optional: !!def.optional,
            state: "pending",
            reason: "",
            error: null,
            duplicateCount: duplicateCounts.get(id) || 0,
            registeredAt: nowIso(),
            startedAt: null,
            completedAt: null,
            skippedAnchor: null
        }
        registry.set(id, rec)
        scheduleRun()
        return rec
    }

    function runPage() {
        return prepareContext().then(async (ctx) => {
            const runnable = Array.from(registry.values()).filter(rec => rec.state === "pending")
            await Promise.all(runnable.map(rec => startRecord(rec, ctx)))
            return status()
        })
    }

    function once(id, fn) {
        const key = String(id || "").trim()
        if (!key) throw new Error("AesBoot.once requires a stable id")
        if (onceRuns.has(key)) {
            noteDuplicate(key)
            return onceRuns.get(key)
        }
        const rec = {id: key, state: "running", duplicateCount: duplicateCounts.get(key) || 0}
        onceRuns.set(key, rec)
        try {
            rec.value = typeof fn === "function" ? fn() : undefined
            rec.state = "ready"
        } catch (err) {
            rec.state = "failed"
            rec.error = err && err.stack ? err.stack : (err && err.message ? err.message : String(err))
            warnOnce("once:" + key, key + " once block failed", err)
            recordDegraded(key, err)
        }
        return rec.value
    }

    function status() {
        const modules = Array.from(registry.values()).map(rec => ({
            id: rec.id,
            state: rec.state,
            reason: rec.reason,
            duplicateCount: rec.duplicateCount || 0,
            error: rec.error,
            skippedAnchor: rec.skippedAnchor,
            registeredAt: rec.registeredAt,
            startedAt: rec.startedAt,
            completedAt: rec.completedAt
        }))
        const once = Array.from(onceRuns.values()).map(rec => ({
            id: rec.id,
            state: rec.state,
            duplicateCount: duplicateCounts.get(rec.id) || rec.duplicateCount || 0,
            error: rec.error || null
        }))
        const failed = modules.filter(rec => rec.state === "failed")
        const skipped = modules.filter(rec => rec.state === "skipped")
        return {
            url: window.location.href,
            pageKind: contextValue ? contextValue.pageKind : detectPageKind(window.location.href),
            registeredModules: modules.length,
            loadedModules: modules.filter(rec => rec.state === "ready").map(rec => rec.id),
            modules,
            once,
            failures: failed,
            failed,
            skipped,
            skippedAnchors: skipped.filter(rec => rec.skippedAnchor).map(rec => ({
                id: rec.id,
                anchor: rec.skippedAnchor
            })),
            duplicates: Array.from(duplicateCounts.entries()).map(([id, count]) => ({id, count}))
        }
    }

    const AesBoot = {
        __aesBoot: true,
        register,
        runPage,
        prepareContext,
        status,
        once,
        _noteDuplicate: noteDuplicate,
        warnOnce
    }

    window.AesBoot = AesBoot
})()
