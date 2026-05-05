"use strict"

/**
 * Reactive view engine for cross-module derived data.
 *
 * Module authors stop hand-writing the subscribe-debounce-recompute glue
 * pattern that's been multiplying across the codebase. Instead, they declare
 * a view as a pure function of its dependencies; the engine recomputes when
 * any dependency emits, caches the result, and re-emits as
 * `view:<name>:computed` so other views and consumers can chain off it.
 *
 *   AesView.declare({
 *     name:       "scanner:fuel-decorated-rows",
 *     deps:       ["data:route-assistant:settings:saved",
 *                  "data:route-assistant:fuel-price:updated",
 *                  "view:scanner:raw-rows"],
 *     compute:    async () => { ...read stores, return value... },
 *     debounceMs: 150,           // optional, default 0
 *     eager:      false          // optional, compute at declare time
 *   })
 *
 *   AesView.get(name)             → cached value | undefined when never computed
 *   AesView.subscribe(name, cb)   → off; cb({name, value, at, deps, durMs, error?})
 *   AesView.invalidate(name)      → forces a recompute on next tick
 *   AesView.list()                → [{name, deps, computedAt, computedMs, error?, hasValue}]
 *   AesView.dependents(name)      → topic-or-view names that listen to this view
 *
 * **Composition.** A view's deps can be bus topics OR other views (their
 * `view:<name>:computed` topic). The engine resolves chains automatically;
 * cycle detection is best-effort (logs and breaks the cycle on first
 * recurrence, doesn't crash). Views are ALWAYS async on recompute — even if
 * compute is synchronous it's wrapped in a microtask so a chain doesn't
 * smash the call stack on cascade.
 *
 * **Idempotent + deduped.** Multiple deps firing in the same tick coalesce
 * into one recompute (per debounce window or per microtask batch).
 *
 * **Failure isolation.** A throwing compute logs, surfaces error in the
 * computed event payload, and keeps the previous cached value. Subscribers
 * decide whether to fall back.
 *
 * Loaded via the wildcard shared content_scripts block. Depends on
 * `AesDataBus` (data-bus.js, listed before this file).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesView) return
    if (typeof window.AesDataBus === "undefined") {
        console.warn("[AES view-engine] AesDataBus missing — view-engine inert")
        return
    }
    const bus = window.AesDataBus

    // name → {deps, compute, debounceMs, value, computedAt, computedMs, error,
    //         pendingTimer, recomputing, hasValue, busOffs}
    const views = new Map()

    // Per-recompute cycle guard — when a view's compute synchronously triggers
    // another view that depends back on it, we want to break the cycle rather
    // than overflow the stack. This stack tracks the chain of in-flight
    // recomputes by name.
    const computeStack = []

    function declare(opts) {
        if (!opts || typeof opts.name !== "string" || !opts.name) {
            throw new Error("AesView.declare: opts.name (string) required")
        }
        if (typeof opts.compute !== "function") {
            throw new Error("AesView.declare: opts.compute (function) required")
        }
        const name = opts.name
        const deps = Array.isArray(opts.deps) ? opts.deps.slice() : []

        // Re-declaring overwrites — useful in dev. Tear down old subscriptions.
        const prev = views.get(name)
        if (prev && prev.busOffs) {
            for (const off of prev.busOffs) try { off() } catch (_) {}
            if (prev.pendingTimer) clearTimeout(prev.pendingTimer)
        }

        const view = {
            name:        name,
            deps:        deps,
            compute:     opts.compute,
            debounceMs:  Number(opts.debounceMs) || 0,
            value:       undefined,
            hasValue:    false,
            computedAt:  null,
            computedMs:  null,
            error:       null,
            pendingTimer: null,
            recomputing: false,
            rerunRequested: null,
            busOffs:     []
        }
        views.set(name, view)

        // Subscribe to every dep — either a bus topic name OR another view's
        // `view:<name>:computed` topic. The view doesn't need to know which —
        // both flow through the bus.
        for (const dep of deps) {
            const topic = depToTopic(dep)
            const off = bus.on(topic, () => schedule(name, "dep:" + dep))
            view.busOffs.push(off)
        }

        if (opts.eager) schedule(name, "eager")
        return name
    }

    /**
     * Bus topics pass through unchanged. View names without `view:` prefix
     * are normalized to `view:<name>:computed`. Already-prefixed view topics
     * also pass through.
     */
    function depToTopic(dep) {
        if (typeof dep !== "string" || !dep) return ""
        if (dep.indexOf("data:") === 0)  return dep
        if (dep.indexOf("view:") === 0)  return dep
        // Plain view name shorthand.
        return "view:" + dep + ":computed"
    }

    function schedule(name, reason) {
        const view = views.get(name)
        if (!view) return
        if (view.recomputing) {
            view.rerunRequested = reason || "reentrant"
            return
        }
        if (view.debounceMs > 0) {
            if (view.pendingTimer) clearTimeout(view.pendingTimer)
            view.pendingTimer = setTimeout(() => {
                view.pendingTimer = null
                runCompute(name, reason).catch(() => {})
            }, view.debounceMs)
            return
        }
        // Microtask coalescing — multiple deps firing this tick collapse into
        // one compute. We set a flag and let the microtask drain before
        // running.
        if (view.pendingTimer === "microtask") return
        view.pendingTimer = "microtask"
        Promise.resolve().then(() => {
            if (view.pendingTimer !== "microtask") return  // cancelled
            view.pendingTimer = null
            runCompute(name, reason).catch(() => {})
        })
    }

    async function runCompute(name, reason) {
        const view = views.get(name)
        if (!view) return
        if (view.recomputing) {
            // Re-entrant trigger during compute — remember that another pass is
            // needed, but do not schedule a microtask while the current async
            // compute is still awaiting storage. The old immediate microtask
            // loop could peg a renderer when a large chrome.storage read was
            // in flight and the dependency fired again.
            view.rerunRequested = reason || "reentrant"
            return
        }
        if (computeStack.indexOf(name) >= 0) {
            console.warn("[AES view-engine] cycle detected — breaking", computeStack.concat(name).join(" → "))
            return
        }

        view.recomputing = true
        computeStack.push(name)
        const t0 = Date.now()
        try {
            const value = await view.compute()
            const durMs = Date.now() - t0
            view.value      = value
            view.hasValue   = true
            view.computedAt = t0
            view.computedMs = durMs
            view.error      = null
            // Emit on the bus so chained views + UI subscribers wake.
            bus.emit("view:" + name + ":computed", {
                view:   name,
                durMs:  durMs,
                reason: reason || null,
                hasValue: true
            })
        } catch (err) {
            const durMs = Date.now() - t0
            view.computedAt = t0
            view.computedMs = durMs
            view.error      = String(err && err.message ? err.message : err)
            console.warn("[AES view-engine] compute failed", name, err)
            bus.emit("view:" + name + ":computed", {
                view:   name,
                durMs:  durMs,
                reason: reason || null,
                error:  view.error,
                hasValue: view.hasValue  // previous value preserved
            })
        } finally {
            view.recomputing = false
            const rerunReason = view.rerunRequested
            view.rerunRequested = null
            const idx = computeStack.indexOf(name)
            if (idx >= 0) computeStack.splice(idx, 1)
            if (rerunReason) schedule(name, "rerun:" + rerunReason)
        }
    }

    function get(name) {
        const view = views.get(name)
        return view && view.hasValue ? view.value : undefined
    }

    function subscribe(name, cb) {
        if (typeof cb !== "function") return () => {}
        // Subscribers register on the underlying bus topic. The handler
        // receives the bus payload + the freshly-computed value spliced in.
        const off = bus.on("view:" + name + ":computed", (rec) => {
            const view = views.get(name)
            try {
                cb({
                    name:       name,
                    value:      view ? view.value : undefined,
                    at:         rec.at,
                    durMs:      rec.durMs || null,
                    reason:     rec.reason || null,
                    error:      rec.error || null,
                    hasValue:   !!(view && view.hasValue)
                })
            } catch (e) {
                console.warn("[AES view-engine] subscribe cb threw", name, e)
            }
        })
        return off
    }

    function invalidate(name) {
        schedule(name, "invalidate")
    }

    function list() {
        const out = []
        for (const [name, v] of views) {
            out.push({
                name:        name,
                deps:        v.deps.slice(),
                computedAt:  v.computedAt,
                computedMs:  v.computedMs,
                error:       v.error,
                hasValue:    v.hasValue,
                debounceMs:  v.debounceMs,
                recomputing: v.recomputing,
                rerunRequested: v.rerunRequested
            })
        }
        out.sort((a, b) => a.name.localeCompare(b.name))
        return out
    }

    /**
     * Returns the names of views/topics that depend on `name` — i.e. anything
     * whose deps list resolves to view:<name>:computed (or directly to the
     * given topic name when name starts with `data:` or `view:`).
     */
    function dependents(name) {
        const topic = depToTopic(name)
        const out = []
        for (const [n, v] of views) {
            if (v.deps.some(d => depToTopic(d) === topic)) out.push(n)
        }
        return out.sort()
    }

    window.AesView = {
        declare:    declare,
        get:        get,
        subscribe:  subscribe,
        invalidate: invalidate,
        list:       list,
        dependents: dependents
    }
})()
