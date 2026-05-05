"use strict"

/**
 * Menu route-and-open dispatcher.
 *
 * The AES navbar menu is mounted on every AirlineSim app page, but the
 * panels it surfaces (Strategy, Hub Designer, Layered Overrides, Strategy
 * Journal) only load on dashboard + fleets pages. Loading the full strategy
 * bundle on every page would balloon the per-page script weight; instead we
 * stash the user's intent in sessionStorage, navigate to the canonical host
 * page, and replay the intent once the target panel registers itself on the
 * destination page.
 *
 * Public API (window.AesMenuRouteAndOpen):
 *   dispatch({kind, args}) -> bool
 *     If the target global is already present on this page, opens it now.
 *     Otherwise stashes the intent and navigates to the host URL. Returns
 *     true if the intent was recognised, false if `kind` is unknown.
 *
 * Consumer:
 *   On every page load, reads `aes:menu:pending` from sessionStorage. If a
 *   recent intent is present, polls (up to ~8s) for the target global to
 *   appear and then dispatches.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesMenuRouteAndOpen) return

    const PENDING_KEY = "aes:menu:pending"
    const MAX_AGE_MS = 5 * 60 * 1000
    const POLL_MS = 200
    const POLL_BUDGET_MS = 8000

    function _enterpriseDashboardUrl() {
        return window.location.origin + "/app/enterprise/dashboard"
    }

    function _fleetsUrl() {
        return window.location.origin + "/app/fleets"
    }

    function _aircraftFlightPlanUrl(aircraftId) {
        const id = String(aircraftId || "").match(/\d+/)
        return id ? window.location.origin + "/app/fleets/aircraft/" + id[0] + "/0" : null
    }

    function _currentAircraftIdFromPath() {
        const m = window.location.pathname.match(/\/app\/fleets\/aircraft\/(\d+)\b/)
        return m ? m[1] : null
    }

    function _firstAircraftIdFromPage() {
        const links = document.querySelectorAll('a[href*="/app/fleets/aircraft/"]')
        for (const a of links) {
            const href = a.getAttribute("href") || ""
            const m = href.match(/\/app\/fleets\/aircraft\/(\d+)\b/)
            if (m) return m[1]
        }
        return null
    }

    function _firstAircraftIdFromStoredFleet() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            return Promise.resolve(null)
        }
        return new Promise(resolve => {
            try {
                chrome.storage.local.get(null, all => {
                    if (chrome.runtime && chrome.runtime.lastError) {
                        resolve(null)
                        return
                    }
                    let best = null
                    for (const key in (all || {})) {
                        if (key.lastIndexOf("aircraftFleet") !== key.length - "aircraftFleet".length) continue
                        const rec = all[key]
                        const fleet = rec && Array.isArray(rec.fleet) ? rec.fleet : []
                        if (!fleet.length) continue
                        if (!best || fleet.length > best.fleet.length) best = {fleet}
                    }
                    const first = best && best.fleet.find(a => a && a.aircraftId != null)
                    resolve(first ? String(first.aircraftId) : null)
                })
            } catch (_) {
                resolve(null)
            }
        })
    }

    async function _routePlannerTargetUrl(intent) {
        const argId = intent && intent.args && intent.args.aircraftId
        const fromArgs = _aircraftFlightPlanUrl(argId)
        if (fromArgs) return fromArgs

        const fromPath = _aircraftFlightPlanUrl(_currentAircraftIdFromPath())
        if (fromPath) return fromPath

        const fromPage = _aircraftFlightPlanUrl(_firstAircraftIdFromPage())
        if (fromPage) return fromPage

        const fromStorage = _aircraftFlightPlanUrl(await _firstAircraftIdFromStoredFleet())
        return fromStorage || _fleetsUrl()
    }

    const intents = {
        "strategy:open": {
            target: _enterpriseDashboardUrl,
            global: "AesStrategyPanel",
            method: "open"
        },
        "strategy:hub-designer": {
            target: _enterpriseDashboardUrl,
            global: "AesStrategyHubDesignerModal",
            method: "open"
        },
        "strategy:layered": {
            target: _enterpriseDashboardUrl,
            global: "AesStrategyLayeredPanel",
            method: "open"
        },
        "route-planner:open": {
            target: _routePlannerTargetUrl,
            global: "AesAfpRoutePlannerPanel",
            method: "open"
        }
    }

    function _isOnTarget(targetUrl) {
        try {
            const u = new URL(targetUrl, window.location.href)
            return window.location.pathname.indexOf(u.pathname) === 0
        } catch (_) { return false }
    }

    function _tryOpenNow(intent) {
        const def = intents[intent.kind]
        if (!def) return false
        const obj = window[def.global]
        if (!obj || typeof obj[def.method] !== "function") return false
        try {
            const ret = (intent.args == null)
                ? obj[def.method]()
                : obj[def.method](intent.args)
            if (ret && typeof ret.catch === "function") {
                ret.catch(e => console.warn("[AES menu route] open rejected", intent.kind, e))
            }
            return true
        } catch (e) {
            console.warn("[AES menu route] open threw", intent.kind, e)
            return false
        }
    }

    function _clearPending() {
        try { sessionStorage.removeItem(PENDING_KEY) } catch (_) { /* private mode */ }
    }

    function _pollAndOpen(intent) {
        const start = Date.now()
        const tick = () => {
            if (_tryOpenNow(intent)) {
                _clearPending()
                return
            }
            if (Date.now() - start > POLL_BUDGET_MS) {
                // Don't clear here — when the user is mid-navigation (e.g.
                // fleets list → an aircraft page) the target global only
                // appears on the final hop. The MAX_AGE_MS check in
                // _consumeOnLoad bounds how long we hold the intent.
                return
            }
            setTimeout(tick, POLL_MS)
        }
        setTimeout(tick, 0)
    }

    function _pollRoutePlannerTargetThenOpen(intent) {
        const start = Date.now()
        const tick = () => {
            if (_tryOpenNow(intent)) {
                _clearPending()
                return
            }
            _routePlannerTargetUrl(intent).then(nextUrl => {
                const fp = _aircraftFlightPlanUrl(_currentAircraftIdFromPath())
                if (fp && _isOnTarget(fp)) {
                    _pollAndOpen(intent)
                    return
                }
                if (nextUrl && /\/app\/fleets\/aircraft\/\d+\/0\b/.test(nextUrl)) {
                    window.location.href = nextUrl
                    return
                }
                if (Date.now() - start > POLL_BUDGET_MS) return
                setTimeout(tick, POLL_MS)
            }).catch(() => {
                if (Date.now() - start > POLL_BUDGET_MS) return
                setTimeout(tick, POLL_MS)
            })
        }
        setTimeout(tick, 0)
    }

    function dispatch(opts) {
        const kind = opts && opts.kind
        const def = intents[kind]
        if (!def) return false

        const intent = {kind: kind, args: opts.args || null}
        if (_tryOpenNow(intent)) return true

        _stashAndRoute(intent, def)
        return true
    }

    function _stashIntent(intent) {
        try {
            sessionStorage.setItem(PENDING_KEY, JSON.stringify({
                kind: intent.kind,
                args: intent.args,
                ts: Date.now()
            }))
        } catch (_) { /* private mode */ }
    }

    function _resolveTargetUrl(def, intent) {
        const target = (typeof def.target === "function") ? def.target(intent) : def.target
        return Promise.resolve(target)
            .then(url => url || window.location.href)
            .catch(e => {
                console.warn("[AES menu route] target resolution failed", intent.kind, e)
                return window.location.href
            })
    }

    function _routeOrPoll(intent, def) {
        _resolveTargetUrl(def, intent).then(targetUrl => {
            if (_tryOpenNow(intent)) {
                _clearPending()
                return
            }
            if (_isOnTarget(targetUrl)) {
                if (intent.kind === "route-planner:open"
                        && !/\/app\/fleets\/aircraft\/\d+\/0\b/.test(window.location.pathname)) {
                    _pollRoutePlannerTargetThenOpen(intent)
                } else {
                    _pollAndOpen(intent)
                }
            } else {
                window.location.href = targetUrl
            }
        })
    }

    function _stashAndRoute(intent, def) {
        _stashIntent(intent)
        _routeOrPoll(intent, def)
    }

    function _consumeOnLoad() {
        let raw
        try { raw = sessionStorage.getItem(PENDING_KEY) } catch (_) { return }
        if (!raw) return

        let pending
        try { pending = JSON.parse(raw) } catch (_) {
            _clearPending()
            return
        }

        if (!pending || !pending.kind || !intents[pending.kind]) {
            _clearPending()
            return
        }
        if (Date.now() - (pending.ts || 0) > MAX_AGE_MS) {
            _clearPending()
            return
        }

        _routeOrPoll({kind: pending.kind, args: pending.args}, intents[pending.kind])
    }

    window.AesMenuRouteAndOpen = {
        dispatch: dispatch,
        intents: Object.keys(intents)
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _consumeOnLoad, {once: true})
    } else {
        _consumeOnLoad()
    }
})()
