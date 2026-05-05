"use strict"

/**
 * AesShared.mountWhenAnchor — DOM anchor wait + mount scaffolding.
 *
 * Extracted from the 5 `content_finance_*.js` entrypoints (audit/streamline-A11
 * recommendation #2). Each finance content script repeated the same pattern:
 *
 *   1. Resolve an anchor element via a `findAnchor()` selector probe.
 *   2. If present now, call `mountFn(el)` immediately.
 *   3. Otherwise, observe `document.body` with a MutationObserver and
 *      retry the probe on every mutation; on first hit, call `mountFn(el)`
 *      and disconnect.
 *   4. Hard-timeout fallback so a partial render still gets the panel.
 *
 * Two call shapes are supported so callers can pass either a CSS selector
 * string OR a custom resolver function (some pages use multi-fallback
 * selectors that don't fit a single `querySelector` string):
 *
 *   AesShared.mountWhenAnchor("table.income-statement", el => mount(el))
 *   AesShared.mountWhenAnchor(() => findAnchorMulti(), el => mount(el))
 *
 * Options:
 *   - timeoutMs (default 5000): disconnect+invoke `mountFn(null)` if no
 *     match by then. Pass `0` to disable the timeout. The original finance
 *     scripts used 5s; passing `null` to mountFn lets the caller decide
 *     whether to mount with a degraded anchor or bail.
 *   - subtree (default true), childList (default true): MutationObserver
 *     options forwarded as-is.
 *   - onTimeout (optional): if provided, invoked instead of `mountFn(null)`
 *     when the timeout fires. Useful for a "give up cleanly" path.
 *
 * The helper is idempotent: multiple calls with different selectors run
 * independent observers. Each call returns a `cancel()` function the caller
 * can invoke to disconnect early (e.g. on page-unload).
 *
 * Defensive: if `document.body` is missing (run_at: document_start without
 * DOMContentLoaded), the helper waits for `DOMContentLoaded` before wiring.
 */
;(function () {
    if (typeof window === "undefined") return
    window.AesShared = window.AesShared || {}
    if (window.AesShared.mountWhenAnchor) return

    const DEFAULT_TIMEOUT_MS = 5000

    function _resolve(anchor) {
        if (typeof anchor === "function") {
            try { return anchor() || null } catch (_) { return null }
        }
        if (typeof anchor === "string" && anchor.length > 0) {
            try { return document.querySelector(anchor) } catch (_) { return null }
        }
        return null
    }

    function mountWhenAnchor(anchor, mountFn, opts) {
        if (typeof mountFn !== "function") {
            console.warn("[AesShared.mountWhenAnchor] mountFn is required")
            return function noopCancel() {}
        }
        const options = opts || {}
        const timeoutMs = Number.isFinite(options.timeoutMs)
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS
        const subtree = options.subtree !== false
        const childList = options.childList !== false
        const onTimeout = typeof options.onTimeout === "function"
            ? options.onTimeout
            : null

        let done = false
        let observer = null
        let timeoutId = null

        function cancel() {
            if (done) return
            done = true
            if (observer) {
                try { observer.disconnect() } catch (_) { /* noop */ }
            }
            if (timeoutId !== null) {
                try { clearTimeout(timeoutId) } catch (_) { /* noop */ }
            }
        }

        function fireMount(el) {
            if (done) return
            done = true
            if (observer) {
                try { observer.disconnect() } catch (_) { /* noop */ }
            }
            if (timeoutId !== null) {
                try { clearTimeout(timeoutId) } catch (_) { /* noop */ }
            }
            try {
                mountFn(el)
            } catch (err) {
                console.warn("[AesShared.mountWhenAnchor] mountFn threw", err)
            }
        }

        function fireTimeout() {
            if (done) return
            done = true
            if (observer) {
                try { observer.disconnect() } catch (_) { /* noop */ }
            }
            timeoutId = null
            if (onTimeout) {
                try {
                    onTimeout()
                } catch (err) {
                    console.warn("[AesShared.mountWhenAnchor] onTimeout threw", err)
                }
            } else {
                // Fallback parity with legacy finance scripts: invoke mountFn
                // with the best-effort current resolution (may be null).
                try {
                    mountFn(_resolve(anchor))
                } catch (err) {
                    console.warn("[AesShared.mountWhenAnchor] mountFn threw on timeout", err)
                }
            }
        }

        function wire() {
            if (done) return
            const now = _resolve(anchor)
            if (now) { fireMount(now); return }

            if (!document.body) {
                // Edge case: script ran before body exists. Defer.
                document.addEventListener("DOMContentLoaded", wire, {once: true})
                return
            }

            observer = new MutationObserver(() => {
                if (done) return
                const el = _resolve(anchor)
                if (el) fireMount(el)
            })
            try {
                observer.observe(document.body, {childList: childList, subtree: subtree})
            } catch (err) {
                console.warn("[AesShared.mountWhenAnchor] observe failed", err)
                // Best-effort: invoke mountFn with whatever we have so the caller can decide.
                fireMount(_resolve(anchor))
                return
            }

            if (timeoutMs > 0) {
                timeoutId = setTimeout(fireTimeout, timeoutMs)
            }
        }

        wire()
        return cancel
    }

    window.AesShared.mountWhenAnchor = mountWhenAnchor
})()
