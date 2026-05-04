"use strict"

/**
 * AirlineSim scheduling page hook — mounts the Route Assistant side panel
 * once the Wicket editor is visible.
 *
 * The scheduling editor is Wicket-rendered and its origin-airport selector
 * isn't a stable DOM anchor, so we try a handful of selectors to find the
 * current "from" airport; users can also override via the panel's Refresh
 * button after changing the origin in the editor.
 */

const AES_FF_SCHED = {
    // First non-null result wins. Looks for an IATA code (3 uppercase letters)
    // in several common AirlineSim scheduler anchors.
    ORIGIN_IATA_LOOKUPS: [
        () => readIataFromUrl(),
        () => readIataFromSelectedOption("select[name*='origin']"),
        () => readIataFromSelectedOption("select[name*='departure']"),
        () => readIataFromSelectedOption("select[name*='from']"),
        () => readIataFromText(".origin, .from, [class*='origin'], [class*='departure']"),
        () => readIataFromAncestorLabel("Origin"),
        () => readIataFromAncestorLabel("From")
    ]
}

function readIataFromSelectedOption(selectSelector) {
    const el = document.querySelector(selectSelector)
    if (!el) return null
    const opt = el.options[el.selectedIndex]
    if (!opt) return null
    return matchIata(opt.textContent) || matchIata(opt.value)
}

function readIataFromText(selector) {
    for (const el of document.querySelectorAll(selector)) {
        const hit = matchIata(el.textContent)
        if (hit) return hit
    }
    return null
}

function readIataFromAncestorLabel(labelText) {
    const labels = Array.from(document.querySelectorAll("label, .control-label, th, dt"))
    for (const lbl of labels) {
        if (!new RegExp("\\b" + labelText + "\\b", "i").test(lbl.textContent || "")) continue
        const sibling = lbl.nextElementSibling || lbl.parentElement
        if (!sibling) continue
        const hit = matchIata(sibling.textContent)
        if (hit) return hit
    }
    return null
}

function readIataFromUrl() {
    const pathHit = /\/app\/com\/scheduling\/([A-Z]{3})([A-Z]{3})(?:[/?#]|$)/i.exec(window.location.pathname)
    if (pathHit) return pathHit[1].toUpperCase()
    const m = /[?&]origin=([A-Z]{3})\b/i.exec(window.location.href)
    return m ? m[1].toUpperCase() : null
}

function matchIata(text) {
    if (!text) return null
    // Prefer a code in parentheses — "London Heathrow (LHR)" — since options
    // often contain the city name first and a non-IATA three-letter token.
    const paren = /\(([A-Z]{3})\)/.exec(text)
    if (paren) return paren[1]
    const m = /\b([A-Z]{3})\b/.exec(text)
    return m ? m[1] : null
}

;(function aesRouteAssistantMain() {
    // Wait briefly for the Wicket editor to render before mounting.
    const start = Date.now()
    const tryMount = () => {
        const editorReady = document.querySelector("select, .as-panel, .scheduling, form") != null
        if (editorReady || Date.now() - start > 15000) {
            const panel = new RouteAssistantPanel({
                resolveOriginIata: () => {
                    for (const fn of AES_FF_SCHED.ORIGIN_IATA_LOOKUPS) {
                        try {
                            const out = fn()
                            if (out) return out.toUpperCase()
                        } catch (e) { /* noop */ }
                    }
                    return null
                }
            })
            panel.mount()
            captureLivePriceIfRoutePage()
            return
        }
        setTimeout(tryMount, 500)
    }
    tryMount()
})()

/**
 * If the current URL is a specific-route scheduling page
 * (`/app/com/scheduling/<HUB><DEST>` — 6 uppercase letters), run the
 * ticket-price scraper against the live DOM and write the result into the
 * cache. Free per-route capture organic to the user's navigation. The
 * route-assistant panel picks up the value on its next refresh.
 */
function captureLivePriceIfRoutePage() {
    if (typeof RouteAssistantSchedulePageScraper === "undefined") return
    const m = /\/app\/com\/scheduling\/([A-Z]{3})([A-Z]{3})(?:[/?#]|$)/.exec(window.location.pathname)
    if (!m) return
    const hub  = m[1]
    const dest = m[2]

    // Wicket pages can render async — give the DOM a moment to settle so
    // the scraper sees the populated fares/ORS rows. 1.5 s is long enough
    // in practice without making the read feel laggy.
    setTimeout(() => {
        try {
            const fields = RouteAssistantSchedulePageScraper.parseFromDoc(document)
            // Only persist if we actually parsed something useful, else
            // we'd overwrite a good cached record with all-nulls on a
            // Wicket sub-page that lacks the schedule table.
            const haveSomething = fields && (
                (fields.flights && fields.flights.length)
                || fields.cruiseSpeedKmh
                || fields.ourPrice !== null
                || fields.ourYield !== null
                || fields.orsRank !== null
            )
            if (!haveSomething) return
            RouteAssistantSchedulePageScraper.saveRecord(hub, dest, fields, "live").then(() => {
                console.log("[AES priceScraper] live-captured", hub + "→" + dest, fields)
            })
        } catch (e) {
            console.warn("[AES priceScraper] live capture failed", e)
        }
    }, 1500)
}

;(function aesSchedulingApplyBridge() {
    if (window.AesSchedulingApplyBridge) return

    const DEFAULT_DAY_MASK = [true, true, true, true, true, true, true]

    function _normIata(value) {
        const m = String(value || "").toUpperCase().match(/\b([A-Z0-9]{3})\b/)
        return m ? m[1] : ""
    }

    function _text(el) {
        return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim()
    }

    function _parseTime(hhmm) {
        const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h = parseInt(m[1], 10)
        const mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return null
        return {hours: String(h), minutes: String(mn)}
    }

    function _normaliseDayMask(mask) {
        return Array.isArray(mask) && mask.length >= 7
            ? mask.slice(0, 7).map(Boolean)
            : DEFAULT_DAY_MASK.slice()
    }

    function _dispatch(el) {
        if (!el) return
        try { el.dispatchEvent(new Event("input", {bubbles: true})) } catch (_) {}
        try { el.dispatchEvent(new Event("change", {bubbles: true})) } catch (_) {}
        try { el.dispatchEvent(new Event("blur", {bubbles: true})) } catch (_) {}
    }

    function _findForm() {
        return document.querySelector('form[action*="flight.planning.form"]')
    }

    function _selectByValue(select, value) {
        if (!select) return null
        const wanted = String(value)
        for (const opt of Array.from(select.options || [])) {
            if (String(opt.value) === wanted) {
                select.value = opt.value
                _dispatch(select)
                return opt
            }
        }
        return null
    }

    function _selectByNumericValue(select, value) {
        const opt = _selectByValue(select, value)
        if (opt) return opt
        const wanted = parseInt(String(value), 10)
        if (!isFinite(wanted)) return null
        for (const candidate of [String(wanted), String(wanted).padStart(2, "0")]) {
            const hit = _selectByValue(select, candidate)
            if (hit) return hit
        }
        return null
    }

    function _selectAircraft(form, req) {
        const select = form.querySelector('select[name="aircraft:flight.planning.form.aircraft.select"], select[name*="aircraft"][name*="select"]')
        if (!select) return {ok: false, error: "aircraft select not found"}

        if (req && req.aircraftValue != null) {
            const byValue = _selectByValue(select, req.aircraftValue)
            if (byValue) return {ok: true, value: byValue.value, label: _text(byValue)}
        }

        const needles = []
        if (req && req.registration) needles.push(String(req.registration).toUpperCase())
        if (req && req.aircraftRegistration) needles.push(String(req.aircraftRegistration).toUpperCase())
        if (req && req.tail) needles.push(String(req.tail).toUpperCase())
        for (const needle of needles.filter(Boolean)) {
            for (const opt of Array.from(select.options || [])) {
                const label = _text(opt).toUpperCase()
                if (label && label.indexOf(needle) !== -1) {
                    select.value = opt.value
                    _dispatch(select)
                    return {ok: true, value: opt.value, label: _text(opt)}
                }
            }
        }

        return {ok: false, error: "aircraft option not found for " + (needles[0] || "requested tail")}
    }

    function _setDays(form, mask) {
        const boxes = Array.from(form.querySelectorAll(
            'input[type="checkbox"][name*="daySelection:"][name*=":ticked"]'
        ))
        const byIdx = new Map()
        for (const cb of boxes) {
            const name = cb.name || ""
            const m = /daySelection:(\d+):ticked/.exec(name)
            const idx = m ? parseInt(m[1], 10) : byIdx.size
            if (idx >= 0 && idx < 7) byIdx.set(idx, cb)
        }
        if (byIdx.size < 7) {
            return {ok: false, error: "day selection checkboxes not found"}
        }
        const out = []
        for (let i = 0; i < 7; i++) {
            const cb = byIdx.get(i)
            if (!cb) return {ok: false, error: "day checkbox " + i + " not found"}
            const wanted = !!mask[i]
            if (cb.checked !== wanted) {
                cb.checked = wanted
                _dispatch(cb)
            }
            out[i] = wanted
        }
        return {ok: true, dayMask: out}
    }

    function _setDeparture(form, depTime) {
        const t = _parseTime(depTime)
        if (!t) return {ok: false, error: "invalid depTime"}
        const hours = form.querySelector('select[name="segmentSettings:0:newDeparture:hours"], select[name*="newDeparture:hours"]')
        const mins  = form.querySelector('select[name="segmentSettings:0:newDeparture:minutes"], select[name*="newDeparture:minutes"]')
        if (!hours || !mins) return {ok: false, error: "departure time selects not found"}
        const hOpt = _selectByNumericValue(hours, t.hours)
        const mOpt = _selectByNumericValue(mins, t.minutes)
        if (!hOpt || !mOpt) return {ok: false, error: "departure time option not found"}
        return {ok: true, depTime: String(parseInt(t.hours, 10)).padStart(2, "0") + ":" + String(parseInt(t.minutes, 10)).padStart(2, "0")}
    }

    function _routeMatches(req) {
        const origin = _normIata(req && req.origin)
        const dest = _normIata(req && req.destination)
        const m = /\/app\/com\/scheduling\/([A-Z0-9]{3})([A-Z0-9]{3})(?:[/?#]|$)/i.exec(location.pathname)
        if (!m || !origin || !dest) return {ok: true}
        const hereOrigin = m[1].toUpperCase()
        const hereDest = m[2].toUpperCase()
        if (hereOrigin === origin && hereDest === dest) return {ok: true}
        return {ok: false, error: "wrong scheduling route (expected " + origin + dest + ", got " + hereOrigin + hereDest + ")"}
    }

    function _submitWithButton(form, button) {
        if (button && typeof form.requestSubmit === "function") {
            form.requestSubmit(button)
            return
        }
        if (button && typeof button.click === "function") {
            button.click()
            return
        }
        form.submit()
    }

    function applyFlightPlan(req) {
        const route = _routeMatches(req || {})
        if (!route.ok) return route

        const form = _findForm()
        if (!form) return {ok: false, error: "flight planning form not found"}

        const aircraft = _selectAircraft(form, req || {})
        if (!aircraft.ok) return aircraft

        const dayMask = _normaliseDayMask(req && req.dayMask)
        const days = _setDays(form, dayMask)
        if (!days.ok) return days

        const departure = _setDeparture(form, (req && (req.depTime || req.depTimeLocal)) || "09:00")
        if (!departure.ok) return departure

        const submit = form.querySelector('input[type="submit"][name="button-submit"], button[type="submit"][name="button-submit"], input[type="submit"][value*="Apply schedule settings"]')
        if (!submit) return {ok: false, error: "Apply schedule settings button not found"}

        setTimeout(() => _submitWithButton(form, submit), 0)
        return {
            ok: true,
            posting: true,
            set: {aircraft, dayMask: days.dayMask, depTime: departure.depTime}
        }
    }

    function removeFlightPlanDays(req) {
        const route = _routeMatches(req || {})
        if (!route.ok) return route

        const rawMask = req && req.dayMask
        if (!Array.isArray(rawMask) || rawMask.length < 7) {
            return {ok: false, error: "remove-flight-plan-days: explicit dayMask required"}
        }
        const dayMask = rawMask.slice(0, 7).map(Boolean)
        if (!dayMask.some(Boolean)) {
            return {ok: false, error: "remove-flight-plan-days: dayMask has no selected days"}
        }

        const form = _findForm()
        if (!form) return {ok: false, error: "flight planning form not found"}

        const days = _setDays(form, dayMask)
        if (!days.ok) return days

        const remove = form.querySelector('input[type="submit"][name="button-remove"], button[type="submit"][name="button-remove"], input[type="submit"][value*="Remove selected days"]')
        if (!remove) return {ok: false, error: "Remove selected days button not found"}

        setTimeout(() => _submitWithButton(form, remove), 0)
        return {ok: true, posting: true, set: {dayMask: days.dayMask}}
    }

    window.AesSchedulingApplyBridge = {applyFlightPlan, removeFlightPlanDays}

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (!msg) return false
            if (msg.type !== "aes:scheduling:apply-flight-plan"
                    && msg.type !== "aes:scheduling:remove-flight-plan-days") return false
            try {
                sendResponse(msg.type === "aes:scheduling:remove-flight-plan-days"
                    ? removeFlightPlanDays(msg)
                    : applyFlightPlan(msg))
            }
            catch (e) { sendResponse({ok: false, error: (e && e.message) || String(e)}) }
            return false
        })
    }
})()
