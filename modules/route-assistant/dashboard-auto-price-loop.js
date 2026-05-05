"use strict"

/**
 * Dashboard 5-second auto-pricing loop.
 *
 * The heavy pricing logic remains in AesRoutePriceAutomator. This small
 * dashboard-only bridge gives the Central Hub a live cadence without changing
 * the existing write gates. The automator's runTickIfDue owns dedup and gate
 * checks, so the bridge can wake every 5s without double-posting alongside
 * the tile refresh or background alarm.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesRoutePriceAutomatorDashboardLoop) return

    const INTERVAL_MS = 5000
    let _timer = null
    let _kickoffTimer = null
    let _running = false

    function _isDashboardPage() {
        try {
            return /\/app\/enterprise\/dashboard(?:$|[/?#])/.test(
                String(window.location && window.location.href || "")
            )
        } catch (_) {
            return false
        }
    }

    function _hostFromPage() {
        const host = {server: "", airline: ""}
        try { if (typeof AES !== "undefined" && AES.getServerName) host.server = AES.getServerName() || "" } catch (_) {}
        try {
            if (typeof AES !== "undefined" && AES.getAirlineCode) {
                const code = AES.getAirlineCode()
                host.airline = code && (code.code || code.name) || ""
            }
        } catch (_) {}
        try {
            if (!host.airline && typeof AES !== "undefined" && AES.getAirlineIdentity) {
                host.airline = AES.getAirlineIdentity() || ""
            }
        } catch (_) {}
        return host
    }

    async function tick() {
        if (_running) return {skipped: "running"}
        if (!window.AesRoutePriceAutomator
                || typeof window.AesRoutePriceAutomator.runTickIfDue !== "function") {
            return {skipped: "automator-missing"}
        }
        _running = true
        try {
            return await window.AesRoutePriceAutomator.runTickIfDue(_hostFromPage(), {
                source: "dashboard-auto-5s"
            })
        } catch (e) {
            console.warn("[AES route-price-auto] dashboard 5s tick failed", e)
            return {skipped: "threw", error: String(e && e.message || e)}
        } finally {
            _running = false
        }
    }

    function start() {
        if (!_isDashboardPage()) return false
        if (_timer) return true
        _kickoffTimer = setTimeout(() => {
            _kickoffTimer = null
            tick().catch(() => {})
        }, INTERVAL_MS)
        if (_kickoffTimer && typeof _kickoffTimer.unref === "function") _kickoffTimer.unref()
        _timer = setInterval(() => { tick().catch(() => {}) }, INTERVAL_MS)
        if (_timer && typeof _timer.unref === "function") _timer.unref()
        return true
    }

    function stop() {
        if (!_timer && !_kickoffTimer) return false
        if (_kickoffTimer) {
            clearTimeout(_kickoffTimer)
            _kickoffTimer = null
        }
        clearInterval(_timer)
        _timer = null
        return true
    }

    function _bootstrap() {
        if (typeof document === "undefined") return
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", start, {once: true})
        } else {
            start()
        }
    }

    window.AesRoutePriceAutomatorDashboardLoop = {
        INTERVAL_MS,
        start,
        stop,
        tick,
        _private: {
            _isDashboardPage,
            _hostFromPage
        }
    }

    _bootstrap()
})()
