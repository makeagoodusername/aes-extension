"use strict"

/**
 * Tab-local registry of cache-cleanup callbacks. Cache stores `register()`
 * their `cleanup` function once at module load; the registry runs all of
 * them on first idle (so 50+ stores don't each spawn their own scheduling
 * machinery) and again on a periodic chrome.alarms tick from background.js.
 *
 *   AesCleanup.register(name, fn, {everyMs?})       // fn async; everyMs hint only
 *   AesCleanup.runAll({reason}) → [{name, ms, ok, error?, result?}]
 *   AesCleanup.runOne(name) → {name, ms, ok, error?, result?}
 *   AesCleanup.list() → [{name, lastRunAt, lastRunMs, lastResult, registeredAt}]
 *
 * `list()` is the input for the slice-2 dashboard tile — that's the only
 * reason `lastRunAt`/`lastRunMs`/`lastResult` are tracked.
 *
 * Loaded via the wildcard shared content_scripts block in tabs, and via
 * `importScripts` in background.js. In tabs, the registry triggers itself
 * once per page load via `requestIdleCallback` (with a setTimeout fallback).
 * In background.js, the alarm handler calls `runAll({reason:"alarm"})` —
 * that wiring lives in background.js, not here.
 *
 * `everyMs` is currently a hint only; the registry doesn't schedule
 * per-store cadences (the boot-time + alarm cadence covers everyone). Kept
 * in the API for slice-3+ if a store ever needs more aggressive cleanup.
 */
;(function () {
    if (typeof globalThis === "undefined") return
    const root = (typeof window !== "undefined") ? window : globalThis
    if (root.AesCleanup) return

    const entries = new Map()  // name → {fn, everyMs, registeredAt, lastRunAt, lastRunMs, lastResult}

    function register(name, fn, opts) {
        if (typeof name !== "string" || !name) {
            throw new Error("AesCleanup.register: name (string) required")
        }
        if (typeof fn !== "function") {
            throw new Error("AesCleanup.register: fn (function) required")
        }
        // Re-registering by name overwrites — modules that hot-reload during
        // dev shouldn't pile up duplicate handlers.
        entries.set(name, {
            fn:           fn,
            everyMs:      (opts && opts.everyMs) || null,
            registeredAt: Date.now(),
            lastRunAt:    null,
            lastRunMs:    null,
            lastResult:   null
        })
    }

    async function runOne(name) {
        const e = entries.get(name)
        if (!e) return {name: name, ms: 0, ok: false, error: "not registered"}
        const t0 = Date.now()
        try {
            const result = await e.fn()
            const ms = Date.now() - t0
            e.lastRunAt = t0
            e.lastRunMs = ms
            e.lastResult = result || null
            return {name: name, ms: ms, ok: true, result: result || null}
        } catch (err) {
            const ms = Date.now() - t0
            e.lastRunAt = t0
            e.lastRunMs = ms
            e.lastResult = {error: String(err)}
            return {name: name, ms: ms, ok: false, error: String(err)}
        }
    }

    async function runAll(opts) {
        const reason = (opts && opts.reason) || "manual"
        const out = []
        for (const name of entries.keys()) {
            out.push(await runOne(name))
        }
        // Skip the log when nothing's registered — the SW alarm fires every
        // 6h whether or not stores have wired up here, and we don't want
        // background-page console spam.
        if (out.length && reason !== "silent") {
            const ok   = out.filter(r => r.ok).length
            const fail = out.length - ok
            const totalMs = out.reduce((s, r) => s + (r.ms || 0), 0)
            console.log(`[AES cleanup] ${reason}: ${ok}/${out.length} ok in ${totalMs}ms${fail ? ` (${fail} failed)` : ""}`)
        }
        return out
    }

    function list() {
        const out = []
        for (const [name, e] of entries) {
            out.push({
                name:         name,
                everyMs:      e.everyMs,
                registeredAt: e.registeredAt,
                lastRunAt:    e.lastRunAt,
                lastRunMs:    e.lastRunMs,
                lastResult:   e.lastResult
            })
        }
        return out
    }

    root.AesCleanup = {
        register: register,
        runAll:   runAll,
        runOne:   runOne,
        list:     list
    }

    // In tabs (window context, NOT the service worker), schedule a one-shot
    // boot-time sweep on first idle. Skipped in background.js — that file
    // wires its own alarm-driven invocation.
    if (typeof window !== "undefined" && typeof document !== "undefined") {
        const fire = () => {
            if (!entries.size) return  // no stores registered (page doesn't use any cache)
            runAll({reason: "tab-idle"}).catch(() => {})
        }
        if (typeof requestIdleCallback === "function") {
            try { requestIdleCallback(fire, {timeout: 5000}) }
            catch (_) { setTimeout(fire, 2000) }
        } else {
            setTimeout(fire, 2000)
        }
    }
})()
