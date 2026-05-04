"use strict"

/**
 * Aircraft Flight Plan Assistant — Wicket form driver (Slice D).
 *
 * Takes a candidate IATA (from Slice C's row click, Slice E's per-leg
 * Apply, or a console call) and fills AS's "New Flight Number" form on
 * /app/fleets/aircraft/<id>/0 so the user can review and click Submit.
 *
 * SAFETY INVARIANT (also documented in HANDOVER §10 via Slice A's
 * fragment): the user-facing UI (toolbar buttons, candidate-selected bus
 * subscriber, wave-applier Apply) NEVER calls `submitBtn.click()` and
 * NEVER POSTs the form. Submit is the user's deliberate click on AS's
 * own green "Create new flight number" button. The `reverse()` method
 * MAY click the form's reverse-O/D anchor — that is a same-page UI
 * toggle, not a state-changing POST. `dryRun()` returns the would-be
 * POST body for inspection but does not fetch.
 *
 * SINGLE EXCEPTION: `fillAndSubmit(leg)` programmatically clicks Submit.
 * It is reachable ONLY through the background-tab submit pipeline
 * (background.js → tab message `aes:afp:fill-and-submit`). The Fleet Hub
 * overlay's per-leg Apply triggers it because the user is on a different
 * tab and can't click AS's button themselves. The in-page Apply on the
 * AFP sidebar still uses the bus path (pre-fill only).
 *
 * Public API (window.AesAfpFormDriver):
 *   setDayActive(dayIdx, enabled) → boolean
 *   ensureNewTabActive()           → Promise<formCtx | null>
 *   findForm()                 → FormHandles | null  (delegates to Slice A)
 *   setOrigin(iata)            → boolean
 *   setDestination(iata)       → boolean
 *   setDepartureTime(hhmm)     → boolean
 *   setPricePercent(pct)       → boolean
 *   setService(value)          → boolean
 *   setFlightNumber(text, opts?) → boolean
 *   findNextAvailableFlightNumber({after?}) → Promise<string|null>
     *   fill(leg)                  → {ok, set, missed}
 *   fillAndSubmit(leg)         → Promise<{ok, posting?, error?}>  (background-only)
 *   assignExistingFlight(leg)  → Promise<{ok, posting?, error?, flightNumberText?}> (background-only)
 *   verifyScheduledFlight(leg) → {ok, error?, flightNumberText?}
 *   reverse()                  → boolean
 *   clear()                    → boolean
 *   dryRun(leg)                → {url, body, missed, deferred?}
 *
 * Bus contract (consumed by Slice F's audit log):
 *   in:  candidate:selected {candidate, source, originIata?, depTime?}  → fill(...)
 *   out: form:filled {leg, set, missed, source}
 *   out: form:cleared {}
 *
 * Toast: NOT fired by this module. Slice F's audit-log subscribes to
 * `form:filled` and fires `RouteAssistantToast.info(...)`; firing here
 * would double-toast.
 */

;(function () {
    if (window.AesAfpFormDriver) return

    const HARDCODED_DEFAULTS = {
        defaultPricePct:      100,
        defaultService:       "",
        defaultDepartureTime: "09:00"   // not in settings.aircraftFlightPlan; Slice D-internal
    }
    const DEFAULT_DAY_MASK = [true, true, true, true, true, true, true]
    const POLL_MS         = 100
    const POLL_MAX_TRIES  = 50          // 5s — Slice A is in the same content_scripts block
    const FLIGHT_NUMBER_ROSTER_PATH = "/app/com/numbers"
    const ROSTER_FETCH_TIMEOUT_MS   = 5000
    const EXISTING_TAB_ACTIVATE_MAX_TRIES = 30
    const PLANNING_FORM_MAX_TRIES         = 150

    let _lastCandidate    = null        // last candidate object from candidate:selected
    let _lastLeg          = null        // last normalised leg passed to fill()
    let _lastSource       = null        // last source string from candidate:selected
    let _cachedSettings   = null        // populated after first AesAfpSettings.load()
    let _attached         = false

    // ── Settings cache ─────────────────────────────────────────────────────
    function _loadSettings() {
        if (typeof window.AesAfpSettings === "undefined") return
        try {
            const p = window.AesAfpSettings.load()
            if (p && typeof p.then === "function") {
                p.then(s => { _cachedSettings = s }).catch(() => { /* keep stale */ })
            }
        } catch (_) { /* swallow — fall back to hardcoded */ }
    }

    function _readDefaults() {
        const s = _cachedSettings || {}
        return {
            defaultPricePct:      Number.isFinite(s.defaultPricePct)        ? s.defaultPricePct        : HARDCODED_DEFAULTS.defaultPricePct,
            defaultService:       (typeof s.defaultService === "string")    ? s.defaultService         : HARDCODED_DEFAULTS.defaultService,
            defaultDepartureTime: (typeof s.defaultDepartureTime === "string") ? s.defaultDepartureTime : HARDCODED_DEFAULTS.defaultDepartureTime
        }
    }

    // ── Select helpers ─────────────────────────────────────────────────────
    function _findOptByIata(sel, iata) {
        if (!sel || !iata) return null
        const wanted = String(iata).toUpperCase()
        // \b<IATA>\b is safe because option text is "City, Region (IATA)" —
        // city names are mixed case so the case-sensitive uppercase token only
        // matches the parenthetical IATA. Escape regex metas defensively even
        // though valid IATAs are A-Z only.
        const re = new RegExp("\\b" + wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b")
        for (const opt of sel.options) {
            if (re.test(opt.textContent || "")) return opt
        }
        return null
    }

    function _findOptByValue(sel, value) {
        if (!sel) return null
        const wanted = String(value)
        for (const opt of sel.options) {
            if (opt.value === wanted) return opt
        }
        return null
    }

    /** Detect the select2 build the page loaded. v3 exposes `defaults.matcher`,
     *  v4 was rewritten on top of the AMD loader and exposes `select2.amd`.
     *  AS uses v3 today (origin/destination selects carry `select2-offscreen`,
     *  a v3-only class). Returns null when select2 isn't loaded. */
    function _detectSelect2Version() {
        const $ = window.jQuery
        if (!$ || !$.fn || typeof $.fn.select2 !== "function") return null
        if ($.fn.select2.amd) return "v4"
        if ($.fn.select2.defaults && $.fn.select2.defaults.matcher) return "v3"
        return "unknown"
    }

    /** Forward an event to the diagnostics module when it's enabled. No-op
     *  otherwise — the shim costs one property lookup per commit in production. */
    function _diag(kind, payload) {
        const d = window.AesAfpDiagnostics
        if (d && typeof d.record === "function") {
            try { d.record(kind, payload) } catch (_) { /* never let diag break form fill */ }
        }
    }

    function _cleanFlightNumberSuffix(raw) {
        const s = String(raw == null ? "" : raw).trim()
        if (!s) return null
        const m = s.match(/(?:^|\s)(\d{1,4})$/)
        if (!m) return null
        const n = parseInt(m[1], 10)
        return (n > 0 && n < 10000) ? n : null
    }

    function _collectRosterNumbers(doc) {
        const seen = new Set()
        if (!doc || !doc.querySelectorAll) return []
        for (const tr of doc.querySelectorAll("tr")) {
            const cells = tr.cells ? Array.from(tr.cells) : []
            if (!cells.length) continue
            for (const cell of cells) {
                const txt = (cell.innerText || cell.textContent || "").trim()
                if (!/^\d{1,4}$/.test(txt)) continue
                const n = _cleanFlightNumberSuffix(txt)
                if (n) seen.add(n)
                break
            }
        }
        return Array.from(seen).sort((a, b) => a - b)
    }

    function _expectedRosterCount(doc) {
        const text = doc && doc.body ? (doc.body.innerText || doc.body.textContent || "") : ""
        let max = 0
        const re = /flight numbers\s*\((\d+)\)/gi
        let m
        while ((m = re.exec(text))) max = Math.max(max, parseInt(m[1], 10) || 0)
        return max || null
    }

    function _smallestUnusedFlightNumber(nums, extraUsed) {
        const used = new Set()
        for (const n of nums || []) {
            const v = parseInt(n, 10)
            if (v > 0 && v < 10000) used.add(v)
        }
        for (const raw of extraUsed || []) {
            const v = _cleanFlightNumberSuffix(raw)
            if (v) used.add(v)
        }
        for (let n = 1; n < 10000; n++) if (!used.has(n)) return String(n)
        return null
    }

    function _activeHubIata() {
        try {
            const hub = window.AesAfp && typeof window.AesAfp.getActiveHub === "function"
                ? window.AesAfp.getActiveHub()
                : null
            if (hub && /^[A-Z]{3}$/.test(String(hub).toUpperCase())) return String(hub).toUpperCase()
        } catch (_) { /* fall back to ctx */ }
        const ctxOrigin = (window.AesAfp && window.AesAfp.ctx && window.AesAfp.ctx.currentLocationIata) || null
        return (ctxOrigin && /^[A-Z]{3}$/.test(String(ctxOrigin).toUpperCase()))
            ? String(ctxOrigin).toUpperCase()
            : null
    }

    async function _fetchRosterNumbers() {
        if (typeof fetch !== "function" || typeof DOMParser === "undefined") return null
        let timer = null
        const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null
        if (ctrl) timer = setTimeout(() => ctrl.abort(), ROSTER_FETCH_TIMEOUT_MS)
        try {
            const res = await fetch(FLIGHT_NUMBER_ROSTER_PATH, {
                credentials: "include",
                cache:       "no-store",
                signal:      ctrl ? ctrl.signal : undefined
            })
            if (!res || !res.ok) return null
            const html = await res.text()
            const doc = new DOMParser().parseFromString(html, "text/html")
            const nums = _collectRosterNumbers(doc)
            const expected = _expectedRosterCount(doc)
            if (!nums.length) return null
            // If AS paginates or hides additional groups, do not trust a
            // partial page; fall back to AS's own Ajax helper instead.
            if (expected && nums.length < expected) {
                _diag("find-next-roster-partial", {count: nums.length, expected})
                return null
            }
            return nums
        } catch (e) {
            _diag("find-next-roster-error", {err: String(e)})
            return null
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    /** Legacy page-world bridge (unused). Kept only because manifest.json
     *  registers modules/aircraft-flight-plan/page-bridge.js in MAIN world;
     *  removing the listener over there is a cosmetic cleanup. The current
     *  _commitSelect path doesn't dispatch the bridge event, so no Wicket
     *  Ajax fires from us. */
    function _ensurePageBridge() {
        if (document.documentElement.dataset.aesAfpBridge === "1") return
        document.documentElement.dataset.aesAfpBridge = "1"
        // Listener attaches to document and reads the desired value off the
        // event target's data-attribute. CustomEvent.detail does NOT cross
        // the isolated/main world boundary reliably in Chrome — DOM nodes
        // and their attributes do. So we stash the value on the select
        // itself and dispatch on the select; ev.target reaches the bridge.
        const code = "(" + function () {
            if (window.__aesAfpInlineBridge) return
            window.__aesAfpInlineBridge = true
            document.addEventListener("aes:afp:commit-select", function (ev) {
                try {
                    const sel = ev.target
                    if (!sel || !sel.tagName || sel.tagName !== "SELECT") return
                    const value = sel.getAttribute("data-aes-pending-value")
                    if (value == null) return
                    sel.removeAttribute("data-aes-pending-value")
                    sel.value = value
                    const $ = window.jQuery || window.$
                    if ($ && $.fn && typeof $.fn.select2 === "function") {
                        const $sel = $(sel)
                        let committed = false
                        try { $sel.select2("val", value, true); committed = true } catch (_) {}
                        if (!committed) {
                            try { $sel.val(value).trigger("change"); committed = true } catch (_) {}
                        }
                        if (!committed) sel.dispatchEvent(new Event("change", {bubbles: true}))
                    } else {
                        sel.dispatchEvent(new Event("change", {bubbles: true}))
                    }
                } catch (e) { console.warn("[AES afp bridge] commit failed", e) }
            }, true)
        }.toString() + ")()"
        try {
            const s = document.createElement("script")
            s.textContent = code
            ;(document.head || document.documentElement).appendChild(s)
            s.remove()
        } catch (_) { /* CSP may block; main-world bridge in manifest covers it */ }
    }

    /** Update the visible select2 v3 chip text without firing any change event.
     *  AS uses Wicket DropDownChoice with AjaxFormComponentUpdatingBehavior on
     *  "change" — every fired change triggers a server round-trip that
     *  re-renders the form panel. fill() commits 6 selects, so firing change
     *  on each races 6 round-trips and the last response replaces the DOM,
     *  clobbering the others. We sidestep all of that: the form POST on
     *  Submit serializes <select>.value directly, so updating sel.value plus
     *  the chip's <span class="select2-chosen"> text (sibling of the select,
     *  inside #s2id_<select.id>) is sufficient AND visually correct. */
    function _updateSelect2Chip(sel) {
        if (!sel || !sel.id) return
        const container = document.getElementById("s2id_" + sel.id)
        if (!container) return
        const chip = container.querySelector(".select2-chosen")
        if (!chip) return
        const opt = sel.options[sel.selectedIndex]
        chip.textContent = opt ? opt.text : ""
    }

    /** Commit a value WITHOUT firing change. See _updateSelect2Chip rationale. */
    function _commitSelect(sel, value) {
        if (!sel) return false
        sel.value = value
        _updateSelect2Chip(sel)
        _diag("commit-select", {
            name:  sel.name,
            value,
            label: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null,
            path:  "no-change"
        })
        return true
    }

    function _setSelectByIata(sel, iata) {
        const opt = _findOptByIata(sel, iata)
        if (!opt) return false
        return _commitSelect(sel, opt.value)
    }

    function _setSelectByValue(sel, value) {
        const opt = _findOptByValue(sel, value)
        if (!opt) return false
        return _commitSelect(sel, opt.value)
    }

    function _parseTime(hhmm) {
        const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h = parseInt(m[1], 10), mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return null
        return {hours: String(h), minutes: String(mn)}   // AS option values are unpadded ("9", "0")
    }

    function _parseExistingFlightOption(opt) {
        const text = (opt && (opt.textContent || opt.innerText) || "").trim().replace(/\s+/g, " ")
        const prefix = text.match(/^(\d{1,4}):/)
        const iatas = []
        const re = /\(([A-Z]{3})\)/g
        let m
        while ((m = re.exec(text))) iatas.push(m[1])
        const time = text.match(/(\d{1,2}:\d{2})\s*$/)
        return {
            opt,
            value: opt ? opt.value : "",
            text,
            flightNumberText: prefix ? prefix[1] : "",
            origin: iatas[0] || "",
            destination: iatas[1] || "",
            depTime: time ? time[1] : ""
        }
    }

    function _findExistingFlightSelect() {
        const selects = Array.from(document.querySelectorAll("select"))
        return selects.find(sel => {
            const name = sel.name || ""
            return name.indexOf("existingNumber") >= 0 && name.indexOf("numbers_body") >= 0
        }) || selects.find(sel => {
            return Array.from(sel.options || []).some(o => /^\s*\d{1,4}:/.test(o.textContent || ""))
        }) || null
    }

    function _findPlanningForm() {
        return document.querySelector("form[action*='flight.planning.form']")
    }

    function _planningSubmitButton(form) {
        if (!form) return null
        return form.querySelector("input[type='submit'][name='button-submit']")
            || form.querySelector("input[type='submit'][value='Apply schedule settings']")
            || form.querySelector("button[type='submit'][name='button-submit']")
    }

    function _normaliseHHMM(value) {
        const t = _parseTime(value)
        if (!t) return ""
        const h = parseInt(t.hours, 10)
        const m = parseInt(t.minutes, 10)
        return (h < 10 ? "0" + h : String(h)) + ":" + (m < 10 ? "0" + m : String(m))
    }

    function _sameHHMM(a, b) {
        const aa = _normaliseHHMM(a)
        const bb = _normaliseHHMM(b)
        return !!aa && !!bb && aa === bb
    }

    function _normaliseDayMask(mask) {
        return Array.isArray(mask) && mask.length >= 7
            ? mask.slice(0, 7).map(Boolean)
            : DEFAULT_DAY_MASK.slice()
    }

    function _normaliseLeg(leg) {
        const l = leg || {}
        const d = _readDefaults()
        const ctxOrigin = _activeHubIata()
        return {
            origin:           l.origin      || ctxOrigin,
            destination:      l.destination || null,
            depTime:          l.depTime     || d.defaultDepartureTime,
            dayMask:          _normaliseDayMask(l.dayMask),
            pricePct:         Number.isFinite(l.pricePct)         ? l.pricePct         : d.defaultPricePct,
            service:          (typeof l.service === "string")     ? l.service          : d.defaultService,
            flightNumberText: (typeof l.flightNumberText === "string" && l.flightNumberText.length)
                                ? l.flightNumberText.replace(/[^0-9]/g, "").slice(0, 4)
                                : ""
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────
    function findForm() {
        return (window.AesAfp && typeof window.AesAfp.getNewFlightForm === "function")
            ? window.AesAfp.getNewFlightForm()
            : null
    }

    /** Ensure the "New Flight Number" tab is active before filling. The
     *  form's submit button only exists in that tab's panel, so when the
     *  user is on the "Existing Flight Number" tab findForm() returns null
     *  and fill bails. We click the New tab's anchor (Wicket swaps the
     *  panel via XHR) and poll until findForm() returns a context, up to
     *  1.5s. Returns the form context on success, null on timeout / no tab. */
    const TAB_ACTIVATE_INTERVAL_MS = 100
    const TAB_ACTIVATE_MAX_TRIES   = 50
    async function _ensureNewTabActive() {
        let form = findForm()
        if (form) return form
        const getTabs = window.AesAfp && window.AesAfp.getFormTabs
        if (typeof getTabs !== "function") return null
        const tabs = getTabs()
        if (!tabs || !tabs.newTab) return null
        if (tabs.activeTab !== "new") {
            _diag("tab-activate", {from: tabs.activeTab})
            try { tabs.newTab.click() }
            catch (e) {
                _diag("tab-activate-error", {err: String(e)})
                return null
            }
        } else {
            _diag("tab-active-wait-form", {})
        }
        for (let i = 0; i < TAB_ACTIVATE_MAX_TRIES; i++) {
            await new Promise(r => setTimeout(r, TAB_ACTIVATE_INTERVAL_MS))
            form = findForm()
            if (form) {
                _diag("tab-activate-ok", {waitedMs: (i + 1) * TAB_ACTIVATE_INTERVAL_MS})
                return form
            }
        }
        _diag("tab-activate-timeout", {})
        return null
    }

    async function _ensureExistingTabActive() {
        let sel = _findExistingFlightSelect()
        if (sel) return sel
        const getTabs = window.AesAfp && window.AesAfp.getFormTabs
        if (typeof getTabs !== "function") return null
        const tabs = getTabs()
        if (!tabs || !tabs.existingTab) return null
        _diag("existing-tab-activate", {from: tabs.activeTab})
        try { tabs.existingTab.click() }
        catch (e) {
            _diag("existing-tab-activate-error", {err: String(e)})
            return null
        }
        for (let i = 0; i < EXISTING_TAB_ACTIVATE_MAX_TRIES; i++) {
            await new Promise(r => setTimeout(r, TAB_ACTIVATE_INTERVAL_MS))
            sel = _findExistingFlightSelect()
            if (sel) {
                _diag("existing-tab-activate-ok", {waitedMs: (i + 1) * TAB_ACTIVATE_INTERVAL_MS})
                return sel
            }
        }
        _diag("existing-tab-activate-timeout", {})
        return null
    }

    function _findExistingFlightOption(sel, norm) {
        if (!sel) return null
        const opts = Array.from(sel.options || [])
            .map(_parseExistingFlightOption)
            .filter(o => o && o.flightNumberText)
        const wantedNumber = _cleanFlightNumberSuffix(norm.flightNumberText)
        if (wantedNumber) {
            return opts.find(o => String(o.flightNumberText) === String(wantedNumber)) || null
        }
        const origin = String(norm.origin || "").toUpperCase()
        const destination = String(norm.destination || "").toUpperCase()
        const depTime = _normaliseHHMM(norm.depTime)
        const matches = opts.filter(o => {
            if (origin && o.origin !== origin) return false
            if (destination && o.destination !== destination) return false
            if (depTime && !_sameHHMM(o.depTime, depTime)) return false
            return true
        })
        matches.sort((a, b) => (parseInt(b.flightNumberText, 10) || 0) - (parseInt(a.flightNumberText, 10) || 0))
        return matches[0] || null
    }

    async function _selectExistingFlightOption(sel, optInfo) {
        if (!sel || !optInfo || !optInfo.opt) return false
        sel.value = optInfo.opt.value
        try { sel.dispatchEvent(new Event("change", {bubbles: true})) }
        catch (_) {}
        for (let i = 0; i < PLANNING_FORM_MAX_TRIES; i++) {
            await new Promise(r => setTimeout(r, 100))
            if (_findPlanningForm()) return true
        }
        return false
    }

    function _setPlanningDayMask(form, dayMask) {
        if (!form) return {ok: false, error: "planning form not found"}
        const inputs = Array.from(form.querySelectorAll(
            "input[type='checkbox'][name*='daySelection:'][name*=':ticked']"))
        if (!inputs.length) return {ok: false, error: "planning day-selection checkboxes not found"}
        const mask = _normaliseDayMask(dayMask)
        for (let i = 0; i < 7; i++) {
            const cb = inputs[i]
            if (!cb) return {ok: false, error: "planning day-selection checkbox missing for day " + i}
            cb.checked = !!mask[i]
        }
        return {ok: true, dayMask: mask}
    }

    function _validatePlanningFormForLeg(form, norm, optInfo) {
        if (!form) return {ok: false, error: "planning form not found"}
        const origin = String(norm.origin || "").toUpperCase()
        const dest = String(norm.destination || "").toUpperCase()
        const captions = Array.from(form.querySelectorAll("td.caption, th, td"))
            .map(el => (el.textContent || "").trim().replace(/\s+/g, " "))
        const hasRouteCaption = captions.some(t => {
            return origin && dest && (
                t === origin + " - " + dest
                || t.indexOf(origin + " - " + dest) >= 0
            )
        })
        if (origin && dest && !hasRouteCaption) {
            return {ok: false, error: "planning matrix route mismatch for " + origin + " - " + dest}
        }
        const t = _parseTime(norm.depTime)
        const hours = form.querySelector("select[name*='segmentSettings:0:newDeparture:hours']")
            || form.querySelector("select[name*='newDeparture:hours']")
        const minutes = form.querySelector("select[name*='segmentSettings:0:newDeparture:minutes']")
            || form.querySelector("select[name*='newDeparture:minutes']")
        if (t && hours && minutes && (String(hours.value) !== t.hours || String(minutes.value) !== t.minutes)) {
            return {
                ok: false,
                error: "planning matrix departure mismatch for flight "
                    + ((optInfo && optInfo.flightNumberText) || "?")
                    + " (expected " + _normaliseHHMM(norm.depTime) + ")"
            }
        }
        return {ok: true}
    }

    function setOrigin(iata)         { const f = findForm(); return _setSelectByIata(f && f.originSelect, iata) }
    function setDestination(iata)    { const f = findForm(); return _setSelectByIata(f && f.destSelect,   iata) }

    async function _setDestinationEventually(iata) {
        if (setDestination(iata)) return true
        // On a freshly-opened AS tab, changing origin can trigger a Wicket /
        // Select2 refresh of the destination select. The background submit
        // pipeline must wait for that refresh instead of declaring the leg
        // incomplete on the first stale option list. Cold-start Wicket AJAX
        // for the destination list can run 4–6s on the first hit; budget 8s
        // so we cover the slow path without making the user wait forever.
        for (let i = 0; i < 80; i++) {
            await new Promise(r => setTimeout(r, 100))
            if (setDestination(iata)) return true
        }
        return false
    }

    /**
     * Toggle the planning-matrix day-selection checkbox for a given day
     * index (0=Mon … 6=Sun). Same selector planning-matrix-reader uses
     * (line 139); inputs are document-ordered Mon→Sun.
     *
     * Dispatches a bubbling `change` event so AS's Wicket handler refreshes
     * the matrix (Time window / Departure time validity rows repaint).
     * Never POSTs — toggling a checkbox is a client-side mutation; the user
     * still has to click "Apply schedule settings" to persist.
     */
    function _commitDayActive(dayIdx, enabled, dispatchChange) {
        if (typeof dayIdx !== "number" || dayIdx < 0 || dayIdx > 6) return false
        const inputs = document.querySelectorAll(
            "form input[type='checkbox'][name*='daySelection:'][name*=':ticked']")
        const cb = inputs[dayIdx]
        if (!cb) return false
        const next = !!enabled
        if (cb.checked === next) return true
        cb.checked = next
        if (dispatchChange) cb.dispatchEvent(new Event("change", {bubbles: true}))
        _diag("set-day-active", {dayIdx, enabled: next})
        return true
    }
    function setDayActive(dayIdx, enabled) {
        return _commitDayActive(dayIdx, enabled, true)
    }

    function setDepartureTime(hhmm) {
        const f = findForm()
        if (!f || !f.hoursSelect || !f.minsSelect) return false
        const t = _parseTime(hhmm)
        if (!t) return false
        return _setSelectByValue(f.hoursSelect, t.hours) && _setSelectByValue(f.minsSelect, t.minutes)
    }

    function setPricePercent(pct) {
        const f = findForm()
        if (!f || !f.priceSelect) return false
        const v = (pct == null || pct === "") ? "" : String(pct)
        return _setSelectByValue(f.priceSelect, v)
    }

    function setService(value) {
        const f = findForm()
        if (!f || !f.serviceSelect) return false
        return _setSelectByValue(f.serviceSelect, String(value == null ? "" : value))
    }

    /** Write the integer flight-number suffix into AS's `<input
     *  name="number:number_body:input">`. Do not fire the onblur Wicket
     *  validator by default: AS re-renders the New Flight form from its
     *  server-side model, and our select commits intentionally avoid Wicket
     *  Ajax round-trips. Triggering blur after a Studio fill can therefore
     *  reset origin/destination/departure before Apply submits. The final
     *  AS form POST still validates the number. Pass `{validate:true}` only
     *  for flows that explicitly want the pre-submit Wicket check. Empty
     *  string clears the input — equivalent to letting AS auto-assign. */
    function setFlightNumber(text, opts) {
        const f = findForm()
        if (!f || !f.flightNumberInput) return false
        const inp = f.flightNumberInput
        const cleaned = String(text == null ? "" : text).replace(/[^0-9]/g, "").slice(0, 4)
        const validate = !!(opts && opts.validate === true)
        if (inp.value !== cleaned) {
            inp.value = cleaned
            try { inp.dispatchEvent(new Event("input",  {bubbles: true})) } catch (_) {}
        }
        if (validate) {
            try { inp.dispatchEvent(new Event("change", {bubbles: true})) } catch (_) {}
            try { inp.dispatchEvent(new Event("blur",   {bubbles: true})) } catch (_) {}
        }
        _diag("commit-flight-number", {value: cleaned, validate})
        return true
    }

    /** Click AS's flight-number lookup anchor and read the input's value
     *  back once the Wicket-Ajax response lands. Blank input uses AS's
     *  "find first available"; populated input uses "find available" so
     *  repeated Studio Next clicks advance instead of jumping back to the
     *  first free number. Returns null if the anchor isn't on the page
     *  (e.g. user is on Existing tab) or if AS doesn't populate the input
     *  within ~2s. The promise never throws. */
    const FIND_NEXT_POLL_MS  = 100
    const FIND_NEXT_MAX_TRIES = 20  // 2s
    async function findNextAvailableFlightNumber(opts) {
        const f = await _ensureNewTabActive()
        if (!f || !f.flightNumberInput) return null
        const inp  = f.flightNumberInput
        const requestedAfter = opts && opts.after != null
            ? String(opts.after).replace(/[^0-9]/g, "").slice(0, 4)
            : ""

        const rosterNums = await _fetchRosterNumbers()
        if (rosterNums && rosterNums.length) {
            const rosterNext = _smallestUnusedFlightNumber(rosterNums, requestedAfter ? [requestedAfter] : [])
            if (rosterNext) {
                setFlightNumber(rosterNext)
                _diag("find-next-roster-ok", {
                    value: rosterNext,
                    count: rosterNums.length,
                    max: Math.max.apply(null, rosterNums)
                })
                return rosterNext
            }
        }

        if (requestedAfter && inp.value !== requestedAfter) {
            inp.value = requestedAfter
            try { inp.dispatchEvent(new Event("input",  {bubbles: true})) } catch (_) {}
            try { inp.dispatchEvent(new Event("change", {bubbles: true})) } catch (_) {}
            try { inp.dispatchEvent(new Event("blur",   {bubbles: true})) } catch (_) {}
        }
        const before = inp.value || ""
        const beforeNum = parseInt(before, 10)
        const lookupBtn = before
            ? f.flightNumberFindBtn
            : (f.flightNumberFindFirstBtn || f.flightNumberFindBtn)
        if (!lookupBtn) return null
        try { lookupBtn.click() }
        catch (e) { _diag("find-next-error", {err: String(e)}); return null }
        for (let i = 0; i < FIND_NEXT_MAX_TRIES; i++) {
            await new Promise(r => setTimeout(r, FIND_NEXT_POLL_MS))
            // Wicket replaces the input subtree on response — re-resolve.
            const nf = findForm()
            const ni = nf && nf.flightNumberInput
            if (ni && ni.value && ni.value !== before) {
                const nextNum = parseInt(ni.value, 10)
                if (before && isFinite(beforeNum) && isFinite(nextNum) && nextNum <= beforeNum) {
                    _diag("find-next-non-advancing", {before, value: ni.value})
                    return null
                }
                _diag("find-next-ok", {value: ni.value, waitedMs: (i + 1) * FIND_NEXT_POLL_MS})
                return ni.value
            }
        }
        _diag("find-next-timeout", {})
        return null
    }

    async function fill(leg) {
        const form = await _ensureNewTabActive()
        if (!form) {
            const r = {ok: false, set: {}, missed: ["form-not-found"]}
            _renderHint({kind: "error", message: "Form not found — switch to AS's 'New Flight Number' tab and try again."})
            _emit("form:filled", {leg: leg || {}, set: r.set, missed: r.missed, source: _lastSource})
            return r
        }
        const norm = _normaliseLeg(leg)
        if (!norm.destination) {
            const r = {ok: false, set: {}, missed: ["destination"]}
            _renderHint({kind: "error", message: "No destination provided."})
            _emit("form:filled", {leg: norm, set: r.set, missed: r.missed, source: _lastSource})
            return r
        }
        const set = {}, missed = []
        if (norm.origin && setOrigin(norm.origin))            set.origin      = norm.origin
        else                                                  missed.push("origin")
        if (await _setDestinationEventually(norm.destination)) set.destination = norm.destination
        else                                                  missed.push("destination")
        if (setDepartureTime(norm.depTime))                   set.depTime     = norm.depTime
        else                                                  missed.push("depTime")
        if (Array.isArray(norm.dayMask)) {
            const inputs = document.querySelectorAll(
                "form input[type='checkbox'][name*='daySelection:'][name*=':ticked']")
            if (!inputs.length) {
                // The aircraft "New Flight Number" form only creates the
                // record. Operating days live on /app/com/scheduling/<OD>.
                set.dayMaskDeferred = norm.dayMask.slice()
            } else {
                const daySet = []
                let dayOk = true
                for (let i = 0; i < 7; i++) {
                    const enabled = !!norm.dayMask[i]
                    if (_commitDayActive(i, enabled, false)) daySet[i] = enabled
                    else dayOk = false
                }
                if (dayOk && daySet.length === 7) set.dayMask = daySet
                else missed.push("dayMask")
            }
        }
        if (setPricePercent(norm.pricePct))                   set.pricePct    = norm.pricePct
        else                                                  missed.push("price")
        if (setService(norm.service))                         set.service     = norm.service
        else                                                  missed.push("service")
        // Flight-number text input is optional — empty leaves AS to auto-
        // assign on submit. Only flag as missed when the leg explicitly
        // requested a number and the input wasn't on the page.
        if (norm.flightNumberText) {
            if (setFlightNumber(norm.flightNumberText)) set.flightNumberText = norm.flightNumberText
            else                                        missed.push("flightNumberText")
        }

        _lastLeg = norm
        const result = {ok: missed.length === 0, set: set, missed: missed}
        _renderHint({kind: "filled", leg: norm, set: set, missed: missed})
        _updateButtonStates()
        // Slice F's audit-log subscribes to this and fires the toast — don't
        // fire one here (would double-toast).
        _emit("form:filled", {leg: norm, set: set, missed: missed, source: _lastSource})
        return result
    }

    /**
     * Fill the form, then click AS's "Create new flight number" Submit
     * button. The ONLY caller is the background-tab pipeline reached via
     * the `aes:afp:fill-and-submit` chrome.runtime message — wired up in
     * content_aircraftFlightPlan.js. The user-facing fill() / Apply paths
     * never call this.
     *
     * Returns immediately after the click is scheduled (a microtask) so
     * the response can travel back to background.js BEFORE the AS form
     * POST navigates the page away (which would tear down the content
     * script and lose any reply still in-flight). Background.js confirms
     * the actual POST landed by watching chrome.tabs.onUpdated for the
     * page reload.
     *
     * Track 5 slice 5c — accepts an optional `leg._batch = {idx, total,
     * batchId, aircraftId}` metadata bag for diagnostics + UI hints.
     * The batching itself lives in `background.js:_afpRunBatchSubmit`
     * because each per-leg AS POST reloads the page and tears down the
     * content script — the form-driver instance can't carry state
     * between legs. Defensive: a top-level `{batch: [legs, ...]}` shape
     * is rejected with a clear error pointing the caller at the
     * `aes:afp:apply-batch` background message.
     */
    async function fillAndSubmit(leg) {
        if (leg && Array.isArray(leg.batch)) {
            return {
                ok: false,
                error: "fillAndSubmit got batch[] — drive batches via the "
                    + "background-tab 'aes:afp:apply-batch' pipeline, not the "
                    + "in-page form-driver (the page reloads between legs)."
            }
        }
        const batchInfo = (leg && leg._batch) || null
        if (batchInfo) {
            _diag("batch-leg", {
                idx:        batchInfo.idx,
                total:      batchInfo.total,
                batchId:    batchInfo.batchId,
                aircraftId: batchInfo.aircraftId,
                seq:        leg.seq != null ? leg.seq : null
            })
        }
        const filled = await fill(leg)
        if (!filled.ok) {
            return {
                ok: false,
                error: "fill incomplete: missed " + (filled.missed || []).join(", ")
            }
        }
        const f = findForm()
        if (!f || !f.submitBtn) {
            return {ok: false, error: "submit button not found"}
        }
        // Defer the click so the resolved promise's .then can send the reply
        // before the form POST navigates the page (microtask before macrotask).
        // Use the native form submit path for New Flight Number creation:
        // AS's Wicket/Select2 click handlers can re-serialise stale select2
        // state in hidden tabs, while the plain form POST carries the select
        // values this driver just wrote.
        setTimeout(() => {
            try {
                if (f.form && window.HTMLFormElement && HTMLFormElement.prototype.submit) {
                    HTMLFormElement.prototype.submit.call(f.form)
                } else {
                    f.submitBtn.click()
                }
            }
            catch (e) { console.warn("[AFP-D] submit click threw", e) }
        }, 0)
        return {ok: true, posting: true}
    }

    async function assignExistingFlight(leg) {
        const norm = _normaliseLeg(leg)
        if (!norm.destination) {
            return {ok: false, error: "assign-existing-flight: destination missing"}
        }
        const sel = await _ensureExistingTabActive()
        if (!sel) {
            return {ok: false, error: "assign-existing-flight: Existing Flight Number tab/select not found"}
        }
        const optInfo = _findExistingFlightOption(sel, norm)
        if (!optInfo) {
            const fn = _cleanFlightNumberSuffix(norm.flightNumberText)
            const target = fn
                ? ("#" + fn)
                : ((norm.origin || "?") + " → " + norm.destination + " " + _normaliseHHMM(norm.depTime))
            return {ok: false, error: "assign-existing-flight: flight number option not found for " + target}
        }
        const selected = await _selectExistingFlightOption(sel, optInfo)
        if (!selected) {
            return {
                ok: false,
                error: "assign-existing-flight: planning matrix did not render for flight #" + optInfo.flightNumberText
            }
        }
        const form = _findPlanningForm()
        const validation = _validatePlanningFormForLeg(form, norm, optInfo)
        if (!validation.ok) return validation
        const days = _setPlanningDayMask(form, norm.dayMask)
        if (!days.ok) return days
        const submitBtn = _planningSubmitButton(form)
        if (!submitBtn) {
            return {ok: false, error: "assign-existing-flight: Apply schedule settings button not found"}
        }
        setTimeout(() => {
            try { submitBtn.click() }
            catch (e) { console.warn("[AFP-D] planning submit click threw", e) }
        }, 75)
        return {
            ok: true,
            posting: true,
            flightNumberText: optInfo.flightNumberText,
            optionText: optInfo.text
        }
    }

    function verifyScheduledFlight(leg) {
        const norm = _normaliseLeg(leg)
        const fn = _cleanFlightNumberSuffix(norm.flightNumberText)
        if (!fn) return {ok: false, error: "verify-scheduled-flight: flightNumberText missing"}
        const dep = _normaliseHHMM(norm.depTime)
        try {
            const schedule = window.AesAfp && typeof window.AesAfp.getCurrentSchedule === "function"
                ? window.AesAfp.getCurrentSchedule()
                : null
            if (Array.isArray(schedule) && schedule.length) {
                const origin = String(norm.origin || "").toUpperCase()
                const dest = String(norm.destination || "").toUpperCase()
                const match = schedule.find(row => {
                    const rOrigin = String(row && (row.origin || row.originIata || row.from || row.fromIata) || "").toUpperCase()
                    const rDest = String(row && (row.destination || row.destIata || row.dest || row.to || row.toIata) || "").toUpperCase()
                    const rDep = _normaliseHHMM(row && (row.depTimeLocal || row.depTime || row.departureTime) || "")
                    const rFn = _cleanFlightNumberSuffix(row && (row.flightNumber || row.flightCode) || "")
                    return (!origin || rOrigin === origin)
                        && (!dest || rDest === dest)
                        && (!dep || rDep === dep)
                        && (!fn || String(rFn) === String(fn))
                })
                if (match) return {ok: true, flightNumberText: String(fn)}
                return {
                    ok: false,
                    error: "verify-scheduled-flight: parsed visual plan does not show "
                        + (origin || "?") + " #" + fn + " " + (dest || "?")
                        + (dep ? " at " + dep : "")
                }
            }
        } catch (_) { /* fall back to text scan */ }
        const vfp = document.querySelector(".visual-flight-plan")
        if (!vfp) return {ok: false, error: "verify-scheduled-flight: visual flight plan not found"}
        const text = (vfp.innerText || vfp.textContent || "").replace(/\s+/g, " ")
        const origin = String(norm.origin || "").toUpperCase()
        const dest = String(norm.destination || "").toUpperCase()
        const parts = []
        if (origin) parts.push(origin)
        parts.push(String(fn))
        if (dest) parts.push(dest)
        let pos = 0
        for (const p of parts) {
            const idx = text.indexOf(p, pos)
            if (idx < 0) {
                return {
                    ok: false,
                    error: "verify-scheduled-flight: visual flight plan does not show "
                        + (origin || "?") + " #" + fn + " " + (dest || "?")
                }
            }
            pos = idx + p.length
        }
        return {ok: true, flightNumberText: String(fn)}
    }

    function reverse() {
        const f = findForm()
        const btn = f && f.reverseBtn       // Slice A's locator includes a text-fallback
        if (!btn) return false
        try { btn.click(); return true } catch (_) { return false }
    }

    function clear() {
        const f = findForm()
        if (!f) return false
        if (f.originSelect)  _setSelectByValue(f.originSelect,  "")
        if (f.destSelect)    _setSelectByValue(f.destSelect,    "")
        if (f.hoursSelect)   _setSelectByValue(f.hoursSelect,   "0")
        if (f.minsSelect)    _setSelectByValue(f.minsSelect,    "0")
        if (f.priceSelect)   _setSelectByValue(f.priceSelect,   "")
        if (f.serviceSelect) _setSelectByValue(f.serviceSelect, "")
        _renderHint({kind: "cleared"})
        _emit("form:cleared", {})
        return true
    }

    function dryRun(leg) {
        const form = findForm()
        const result = {url: null, body: {}, missed: [], deferred: {}}
        if (!form || !form.form) {
            result.missed.push("form-not-found")
            _renderDryRun(result)
            return result
        }
        result.url = form.form.action || ""
        const norm = _normaliseLeg(leg || _lastLeg || {})

        const tryIata  = (sel, iata, key) => {
            if (!iata)                     { result.missed.push(key); return }
            const opt = _findOptByIata(sel, iata)
            if (opt) result.body[key] = opt.value
            else     result.missed.push(key)
        }
        const tryValue = (sel, val, key) => {
            const opt = _findOptByValue(sel, val)
            if (opt) result.body[key] = opt.value
            else     result.missed.push(key)
        }

        tryIata(form.originSelect, norm.origin,      "origin")
        tryIata(form.destSelect,   norm.destination, "destination")
        const t = _parseTime(norm.depTime)
        if (t) {
            tryValue(form.hoursSelect, t.hours,   "departure:hours")
            tryValue(form.minsSelect,  t.minutes, "departure:minutes")
        } else {
            result.missed.push("depTime")
        }
        tryValue(form.priceSelect,   (norm.pricePct == null || norm.pricePct === "") ? "" : String(norm.pricePct), "price")
        tryValue(form.serviceSelect, String(norm.service == null ? "" : norm.service),                              "service")

        // Flight-number text input. Empty value is fine (AS auto-assigns).
        if (form.flightNumberInput && form.flightNumberInput.name) {
            result.body[form.flightNumberInput.name] = norm.flightNumberText || ""
        }
        if (Array.isArray(norm.dayMask)) {
            const inputs = form.form.querySelectorAll(
                "input[type='checkbox'][name*='daySelection:'][name*=':ticked']")
            if (inputs.length) {
                for (let i = 0; i < 7; i++) {
                    const cb = inputs[i]
                    if (!cb || !cb.name) {
                        result.missed.push("dayMask")
                        continue
                    }
                    if (norm.dayMask[i]) result.body[cb.name] = cb.value || "on"
                }
            } else {
                result.deferred.dayMask = norm.dayMask.slice()
            }
        }

        // Hidden Wicket fields are empty at page load but may be injected at
        // submit time (CSRF tokens). Surface what's there now for honesty.
        for (const inp of form.form.querySelectorAll("input[type='hidden']")) {
            if (inp.name) result.body[inp.name] = inp.value
        }
        _renderDryRun(result)
        return result
    }

    // ── Bus + slot ─────────────────────────────────────────────────────────
    function _emit(name, payload) {
        const bus = window.AesAfp && window.AesAfp.bus
        if (bus && typeof bus.emit === "function") {
            try { bus.emit(name, payload) } catch (_) { /* bus self-isolates handlers */ }
        }
    }

    function _slot() {
        try {
            return (window.AesAfp && typeof window.AesAfp.slot === "function")
                ? window.AesAfp.slot("driver")
                : null
        } catch (_) { return null }
    }

    // ── Toolbar ────────────────────────────────────────────────────────────
    function _mkBtn(label, cls, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.className = "btn btn-xs btn-default " + cls
        b.textContent = label
        b.style.fontSize = "11px"
        b.addEventListener("click", onClick)
        return b
    }

    function _renderToolbar() {
        const host = _slot()
        if (!host) return
        host.innerHTML = ""

        const wrap = document.createElement("div")
        wrap.className = "aes-afp-driver"
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:8px 0;"

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;"
        btnRow.append(
            _mkBtn("Fill latest pick",   "aes-afp-btn-fill",    () => {
                if (!_lastCandidate || !_lastCandidate.destIata) return
                fill({destination: _lastCandidate.destIata})
            }),
            _mkBtn("Reverse O/D",        "aes-afp-btn-reverse", () => {
                if (!reverse()) _renderHint({kind: "error", message: "AS's reverse-O/D link not detected — use AS's controls directly."})
            }),
            _mkBtn("Clear",              "aes-afp-btn-clear",   clear),
            _mkBtn("Show what'd post",   "aes-afp-btn-dry",     () => {
                const target = _lastLeg || (_lastCandidate ? {destination: _lastCandidate.destIata} : null)
                if (!target) { _renderHint({kind: "error", message: "Fill once before previewing."}); return }
                dryRun(target)
                const det = host.querySelector("details.aes-afp-dry")
                if (det) det.open = true
            })
        )
        wrap.append(btnRow)

        const hint = document.createElement("div")
        hint.className = "aes-afp-driver-hint"
        hint.style.cssText = "font-size:11px;color:#9ca3af;line-height:1.4;"
        wrap.append(hint)

        const dry = document.createElement("details")
        dry.className = "aes-afp-dry"
        dry.style.marginTop = "4px"
        const sum = document.createElement("summary")
        sum.textContent = "Dry-run output"
        sum.style.cssText = "cursor:pointer;font-size:11px;color:#9ca3af;"
        const pre = document.createElement("pre")
        pre.className = "aes-afp-dry-body"
        pre.style.cssText = "margin:4px 0 0;padding:6px;background:#0f1419;color:#e2e8f0;font-size:10px;line-height:1.4;overflow:auto;max-height:200px;border-radius:3px;"
        pre.textContent = "(no dry-run yet)"
        dry.append(sum, pre)
        wrap.append(dry)

        host.append(wrap)
        _renderHint({kind: "idle"})
        _updateButtonStates()
    }

    function _updateButtonStates() {
        const host = _slot()
        if (!host) return
        const f = findForm()
        const fillBtn    = host.querySelector(".aes-afp-btn-fill")
        const reverseBtn = host.querySelector(".aes-afp-btn-reverse")
        const dryBtn     = host.querySelector(".aes-afp-btn-dry")
        if (fillBtn) {
            const can = !!(_lastCandidate && _lastCandidate.destIata)
            fillBtn.disabled = !can
            fillBtn.title    = can ? "" : "Pick a candidate first"
        }
        if (reverseBtn) {
            const can = !!(f && f.reverseBtn)
            reverseBtn.disabled = !can
            reverseBtn.title    = can ? "" : "AS's reverse link not detected on this page"
        }
        if (dryBtn) {
            const can = !!(_lastLeg || _lastCandidate)
            dryBtn.disabled = !can
            dryBtn.title    = can ? "" : "Fill once before previewing"
        }
    }

    function _renderHint(state) {
        const host = _slot()
        if (!host) return
        const el = host.querySelector(".aes-afp-driver-hint")
        if (!el) return
        if (state.kind === "idle") {
            el.style.color = "#9ca3af"
            el.textContent = "Pick a destination from the candidate list above to fill the form."
            return
        }
        if (state.kind === "cleared") {
            el.style.color = "#9ca3af"
            el.textContent = "Form cleared."
            return
        }
        if (state.kind === "error") {
            el.style.color = "#fca5a5"
            el.textContent = state.message
            return
        }
        if (state.kind === "filled") {
            const leg = state.leg || {}, set = state.set || {}, missed = state.missed || []
            const orig = set.origin      || leg.origin      || "?"
            const dest = set.destination || leg.destination || "?"
            const time = set.depTime     || leg.depTime     || ""
            const pct  = (set.pricePct != null) ? set.pricePct : (leg.pricePct != null ? leg.pricePct : "")
            const svc  = (set.service != null && set.service !== "") ? "service " + set.service : "default service"
            const fn   = (set.flightNumberText || leg.flightNumberText || "").toString()
            const fnTxt = fn ? " · #" + fn : " · #auto"
            const partial = missed.length ? " (missed: " + missed.join(", ") + ")" : ""
            el.innerHTML = ""
            const summary = document.createElement("div")
            summary.style.color   = missed.length ? "#fde68a" : "#a7f3d0"
            summary.textContent   = "Pre-filled: " + orig + " → " + dest + " · " + time + " · " + pct + "% · " + svc + fnTxt + partial
            const cta = document.createElement("div")
            cta.style.color       = "#fde68a"
            cta.style.marginTop   = "2px"
            cta.textContent       = "👉 Click \"Create new flight number\" below to confirm"
            el.append(summary, cta)
            return
        }
    }

    function _renderDryRun(result) {
        const host = _slot()
        if (!host) return
        const pre = host.querySelector(".aes-afp-dry-body")
        if (!pre) return
        const lines = ["POST " + (result.url || "(unknown)"), ""]
        const keys = Object.keys(result.body).sort()
        if (!keys.length) lines.push("(no fields)")
        else {
            const max = Math.max.apply(null, keys.map(k => k.length))
            for (const k of keys) lines.push(k.padEnd(max) + " = " + result.body[k])
        }
        if (result.missed && result.missed.length) {
            lines.push("", "missed: " + result.missed.join(", "))
        }
        if (result.deferred && Object.keys(result.deferred).length) {
            const labels = []
            if (Array.isArray(result.deferred.dayMask)) labels.push("dayMask via scheduling page")
            lines.push("", "deferred: " + labels.join(", "))
        }
        pre.textContent = lines.join("\n")
    }

    // ── Wire-up ────────────────────────────────────────────────────────────
    function attach() {
        if (_attached) return
        const bus = window.AesAfp && window.AesAfp.bus
        if (!bus) return
        _attached = true
        bus.on("ctx:ready", () => { _loadSettings(); _renderToolbar() })
        bus.on("candidate:selected", (payload) => {
            const p = payload || {}
            const c = p.candidate
            if (!c || !c.destIata) return
            _lastCandidate = c
            _lastSource    = p.source || null
            // wave-leg events carry a `__wave` hint bag with the leg's
            // origin/destination (which may differ from the aircraft's
            // current location for inbound legs) and depTime. Forward it into
            // fill() so the form lines up with the leg the user clicked
            // — the no-submit invariant is preserved (fill() never
            // clicks Submit).
            const leg = {destination: c.destIata}
            const origin = p.originIata || p.origin || c.originIata || c.origin
            if (origin && /^[A-Z]{3}$/.test(String(origin).toUpperCase())) {
                leg.origin = String(origin).toUpperCase()
            }
            // Track 7 follow-up: route-candidates' per-row HH:MM picker
            // sends payload.depTime on every candidate-list click. Honour
            // it when present; the wave-leg branch below only fills in
            // a depTime when the picker didn't.
            if (typeof p.depTime === "string") leg.depTime = p.depTime
            if (p.source === "wave-leg" && c.__wave) {
                if (c.__wave.origin)  leg.origin  = c.__wave.origin
                if (c.__wave.destination) leg.destination = c.__wave.destination
                if (c.__wave.depTime && !leg.depTime) leg.depTime = c.__wave.depTime
            }
            fill(leg)
        })
        _loadSettings()
    }

    // Public namespace.
    window.AesAfpFormDriver = {
        findForm, setOrigin, setDestination, setDepartureTime,
        setPricePercent, setService, setFlightNumber, findNextAvailableFlightNumber,
        setDayActive,
        ensureNewTabActive: _ensureNewTabActive,
        fill, fillAndSubmit, assignExistingFlight, verifyScheduledFlight,
        reverse, clear, dryRun
    }

    // Late-load guard: Slice A may not have published the bus yet (manifest
    // ordering puts host.js first but parse-vs-execute timing isn't strict).
    if (window.AesAfp && window.AesAfp.bus) {
        attach()
        if (window.AesAfp.ctx) _renderToolbar()
    } else {
        let tries = 0
        const id = setInterval(() => {
            if (window.AesAfp && window.AesAfp.bus) {
                clearInterval(id)
                attach()
                if (window.AesAfp.ctx) _renderToolbar()
            } else if (++tries > POLL_MAX_TRIES) {
                clearInterval(id)
            }
        }, POLL_MS)
    }
})()
