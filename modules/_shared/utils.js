"use strict"

/**
 * AesUtils — pure-function helpers shared across modules.
 *
 * Every function here is pure (no I/O, no DOM, no chrome.storage), idempotent,
 * and safe to call from render loops. Existing modules carry private copies of
 * these helpers (e.g. `function _num(v, f)` repeated across ~14 strategy
 * files); this module is the canonical home so future migrations can replace
 * those copies one file at a time. Defensive consumers should still keep a
 * `?? localFallback` shim so the file mounts even when this module hasn't
 * loaded yet (ordering edge case during the rollout window).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesUtils) return

    function _num(v, fallback) {
        const n = Number(v)
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback)
    }

    function _clamp(v, min, max) {
        const n = _num(v, min)
        if (n < min) return min
        if (n > max) return max
        return n
    }

    function _pct(value, total) {
        const v = _num(value, 0)
        const t = _num(total, 0)
        if (t === 0) return 0
        return (v / t) * 100
    }

    function _debounce(fn, ms) {
        let t = null
        return function debounced() {
            const args = arguments
            const ctx  = this
            if (t) clearTimeout(t)
            t = setTimeout(function () { t = null; fn.apply(ctx, args) }, ms)
        }
    }

    function _throttle(fn, ms) {
        let last = 0
        let pending = null
        return function throttled() {
            const now = Date.now()
            const args = arguments
            const ctx  = this
            const remaining = ms - (now - last)
            if (remaining <= 0) {
                if (pending) { clearTimeout(pending); pending = null }
                last = now
                fn.apply(ctx, args)
            } else if (!pending) {
                pending = setTimeout(function () {
                    last = Date.now()
                    pending = null
                    fn.apply(ctx, args)
                }, remaining)
            }
        }
    }

    /**
     * Compact money formatter — picks $X / $XK / $X.XM / $X.XB based on
     * magnitude. Lifted from wave-overlay.js's `_formatMoneyShort` to be the
     * one canonical implementation. Negative numbers get a leading minus.
     */
    function _formatMoney(n, opts) {
        const value = _num(n, 0)
        const sign  = value < 0 ? "-" : ""
        const abs   = Math.abs(value)
        const prefix = (opts && opts.prefix === false) ? "" : "$"
        if (abs >= 1e9) return sign + prefix + (abs / 1e9).toFixed(1) + "B"
        if (abs >= 1e6) return sign + prefix + (abs / 1e6).toFixed(1) + "M"
        if (abs >= 1e3) return sign + prefix + Math.round(abs / 1e3) + "K"
        return sign + prefix + Math.round(abs)
    }

    /**
     * Relative date formatter — "just now" / "5m ago" / "3h ago" /
     * "yesterday" / "Mar 14". For UI surfaces where the absolute date is less
     * useful than the freshness signal.
     */
    function _formatDateRel(ts, nowMs) {
        const t = _num(ts, 0)
        if (t <= 0) return "never"
        const now = _num(nowMs, Date.now())
        const ms  = now - t
        if (ms < 0) return "just now"
        const sec = Math.floor(ms / 1000)
        if (sec < 45) return "just now"
        const min = Math.floor(sec / 60)
        if (min < 60) return min + "m ago"
        const hr = Math.floor(min / 60)
        if (hr < 24) return hr + "h ago"
        const day = Math.floor(hr / 24)
        if (day === 1) return "yesterday"
        if (day < 7)   return day + "d ago"
        const d = new Date(t)
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        return months[d.getMonth()] + " " + d.getDate()
    }

    window.AesUtils = {
        _num, _clamp, _pct,
        _debounce, _throttle,
        _formatMoney, _formatDateRel
    }
})()
