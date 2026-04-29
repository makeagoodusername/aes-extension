"use strict"

/**
 * AesTools — descriptor registry for AES capabilities the future LLM
 * co-pilot (Slice 28) and the public read-only API (Slice 30) can call.
 *
 * Each tool is a {name, description, params, returns, sideEffects, run}
 * record. `run` is the actual function; the schema fields are
 * documentation that consumers (LLM tool-use, public API generator,
 * Cmd-K command palette extension) read to know what's safe to invoke
 * and how to call it.
 *
 *   AesTools.register({name, description, params?, returns?,
 *                      sideEffects?, run})
 *     — idempotent (re-register replaces); returns an unregister fn.
 *
 *   AesTools.list({tag?, sideEffectsOnly?}) → [descriptor (sans run)]
 *     — descriptor-only listing safe to expose externally; never returns
 *       the bound function.
 *
 *   AesTools.get(name) → full record (incl. run) | undefined
 *
 *   AesTools.invoke(name, args) → Promise<any> | any
 *     — throws if not registered; otherwise calls run(args). The thin
 *       indirection lets us add audit logging, rate limiting, or a
 *       confirm-before-side-effects gate later without changing call
 *       sites.
 *
 *   AesTools.tag(name, ...tags) — appends tags for query
 *
 * **Side-effects taxonomy.** Every tool declares one of:
 *   "read"          — pure read, no storage / network / DOM mutation
 *   "read-cached"   — reads cached value; may run a fetcher on cold start
 *   "write-storage" — mutates chrome.storage.local
 *   "write-as"      — POSTs to AS (gated; subject to two-gate model)
 *   "ui"            — opens a modal / overlays / focuses an element
 *   "vision"        — captures a screenshot or canvas frame
 *
 * The LLM co-pilot reads this taxonomy when deciding whether to ask
 * for confirmation before a tool call. `read` and `read-cached` are
 * always safe; `write-as` should always confirm; `vision` is safe but
 * the user might want to opt in for privacy.
 *
 * **Bootstrap registrations.** This module registers itself plus the
 * baseline capabilities on load:
 *   - vision.captureTab          → AesVision.captureTab
 *   - vision.frameOf             → AesVision.frameOf
 *   - bus.auditTopics            → AesDataBus.auditTopics
 *   - bus.history                → AesDataBus.history
 *   - bus.stats                  → AesDataBus.stats
 *   - gameTime.read              → AesGameTimeWatcher.read
 *   - gameTime.getLastSeen       → AesGameTimeWatcher.getLastSeen
 *   - meta.listTools             → self
 *
 * Other modules (read-API consumers, applier wrappers, future LLM
 * helpers) call AesTools.register from their own load paths.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesTools) return

    const tools = new Map()  // name → record

    function register(spec) {
        if (!spec || typeof spec.name !== "string" || !spec.name) {
            throw new Error("AesTools.register: spec.name (string) required")
        }
        if (typeof spec.run !== "function") {
            throw new Error("AesTools.register: spec.run (function) required")
        }
        const rec = {
            name:        spec.name,
            description: String(spec.description || ""),
            params:      spec.params || null,
            returns:     spec.returns || null,
            sideEffects: spec.sideEffects || "read",
            tags:        Array.isArray(spec.tags) ? spec.tags.slice() : [],
            run:         spec.run,
            registeredAt: Date.now()
        }
        tools.set(spec.name, rec)
        return () => { if (tools.get(spec.name) === rec) tools.delete(spec.name) }
    }

    function get(name) {
        return tools.get(name) || undefined
    }

    function _public(rec) {
        // Strip the bound function and registration timestamp. Consumers
        // get the descriptor; only invoke() can run the tool.
        return {
            name:        rec.name,
            description: rec.description,
            params:      rec.params,
            returns:     rec.returns,
            sideEffects: rec.sideEffects,
            tags:        rec.tags.slice()
        }
    }

    function list(opts) {
        const o = opts || {}
        const tag = typeof o.tag === "string" ? o.tag : null
        const seo = !!o.sideEffectsOnly
        const out = []
        for (const rec of tools.values()) {
            if (tag && !rec.tags.includes(tag)) continue
            if (seo && (rec.sideEffects === "read" || rec.sideEffects === "read-cached")) continue
            out.push(_public(rec))
        }
        out.sort((a, b) => a.name.localeCompare(b.name))
        return out
    }

    function tag(name, ...tags) {
        const rec = tools.get(name)
        if (!rec) return false
        for (const t of tags) {
            if (typeof t !== "string" || !t) continue
            if (!rec.tags.includes(t)) rec.tags.push(t)
        }
        return true
    }

    function invoke(name, args) {
        const rec = tools.get(name)
        if (!rec) throw new Error("AesTools.invoke: tool '" + name + "' not registered")
        return rec.run(args)
    }

    window.AesTools = {register, get, list, tag, invoke}

    // ─── Bootstrap registrations ─────────────────────────────────────
    // These wrap existing capabilities so AesTools.list() returns a
    // useful surface immediately on load. Defensive: each registration
    // checks for the underlying global and skips on miss (the bus may
    // be loaded but vision may not, etc.).

    function _registerBaseline() {
        if (window.AesVision && typeof window.AesVision.captureTab === "function") {
            register({
                name:        "vision.captureTab",
                description: "Capture the visible viewport of the active AS tab as a base64 PNG/JPEG data URL.",
                params:      {format: "'png'|'jpeg' (default 'png')", quality: "1..100 (jpeg only)"},
                returns:     "{ok, dataUrl, format, capturedAt} | {ok:false, error}",
                sideEffects: "vision",
                tags:        ["multimodal", "screenshot"],
                run:         (args) => window.AesVision.captureTab(args || {})
            })
            register({
                name:        "vision.frameOf",
                description: "Capture a <canvas> element by reference or selector as a data URL. Synchronous; faster than captureTab for AES-rendered visuals (schedule canvas, wave overlay, ORS sandbox sweep, billboard).",
                params:      {target: "Element | string (selector)", format: "'png'|'jpeg'", quality: "1..100"},
                returns:     "{ok, dataUrl, format, w, h, capturedAt} | {ok:false, error}",
                sideEffects: "vision",
                tags:        ["multimodal", "canvas"],
                run:         (args) => window.AesVision.frameOf(args && args.target, args || {})
            })
        }

        if (window.AesDataBus) {
            if (typeof window.AesDataBus.auditTopics === "function") {
                register({
                    name:        "bus.auditTopics",
                    description: "List every bus topic the data-bus has seen on this tab. `registered` came from data-bus-topics.js; `discovered` was emitted at runtime without prior registration (drift list).",
                    params:      null,
                    returns:     "{registered: [...], discovered: [...], both: [...]}",
                    sideEffects: "read",
                    tags:        ["bus", "introspection"],
                    run:         () => window.AesDataBus.auditTopics()
                })
            }
            if (typeof window.AesDataBus.history === "function") {
                register({
                    name:        "bus.history",
                    description: "Recent bus events (newest first). Filter by topic for targeted observability.",
                    params:      {topic: "string (optional filter)", limit: "number (default: all)"},
                    returns:     "[{topic, at, source, ...}]",
                    sideEffects: "read",
                    tags:        ["bus", "introspection"],
                    run:         (args) => window.AesDataBus.history(args || {})
                })
            }
            if (typeof window.AesDataBus.stats === "function") {
                register({
                    name:        "bus.stats",
                    description: "Per-topic emit count + last activity. Useful for 'what's quiet?' / 'what's chatty?' diagnostics.",
                    params:      null,
                    returns:     "[{topic, count, lastAt, lastSource, hasSubscribers}]",
                    sideEffects: "read",
                    tags:        ["bus", "introspection"],
                    run:         () => window.AesDataBus.stats()
                })
            }
        }

        if (window.AesGameTimeWatcher) {
            if (typeof window.AesGameTimeWatcher.read === "function") {
                register({
                    name:        "gameTime.read",
                    description: "Synchronous DOM read of the AS footer's game date + time (this tab's view).",
                    params:      null,
                    returns:     "{gameDate: 'YYYY-MM-DD', gameTime: 'HH:MM'} | null",
                    sideEffects: "read",
                    tags:        ["game-time", "introspection"],
                    run:         () => window.AesGameTimeWatcher.read()
                })
            }
            if (typeof window.AesGameTimeWatcher.getLastSeen === "function") {
                register({
                    name:        "gameTime.getLastSeen",
                    description: "Latest persisted game-time observation across all tabs (chrome.storage.local).",
                    params:      null,
                    returns:     "Promise<{gameDate, gameTime, seenAt} | null>",
                    sideEffects: "read-cached",
                    tags:        ["game-time", "introspection"],
                    run:         () => window.AesGameTimeWatcher.getLastSeen()
                })
            }
        }

        register({
            name:        "meta.listTools",
            description: "List every registered AES tool with its descriptor. Foundation for an LLM co-pilot's tool-discovery and the public read-only API spec.",
            params:      {tag: "string (optional)", sideEffectsOnly: "boolean (optional)"},
            returns:     "[{name, description, params, returns, sideEffects, tags}]",
            sideEffects: "read",
            tags:        ["meta"],
            run:         (args) => list(args || {})
        })
    }

    // Defer the baseline pass to a microtask so any sibling module that
    // also runs at content-script init has already attached its globals
    // by the time we look. Manifest order is supposed to handle this,
    // but some modules attach lazily on DOMContentLoaded — the microtask
    // catches both.
    queueMicrotask(_registerBaseline)
})()
