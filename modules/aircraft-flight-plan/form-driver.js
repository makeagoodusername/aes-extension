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
 *   findForm()                 → FormHandles | null  (delegates to Slice A)
 *   setOrigin(iata)            → boolean
 *   setDestination(iata)       → boolean
 *   setDepartureTime(hhmm)     → boolean
 *   setPricePercent(pct)       → boolean
 *   setService(value)          → boolean
 *   fill(leg)                  → {ok, set, missed}
 *   fillAndSubmit(leg)         → Promise<{ok, posting?, error?}>  (background-only)
 *   reverse()                  → boolean
 *   clear()                    → boolean
 *   dryRun(leg)                → {url, body, missed}
 *
 * Bus contract (consumed by Slice F's audit log):
 *   in:  candidate:selected {candidate, source}  → fill(...)
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
    const POLL_MS         = 100
    const POLL_MAX_TRIES  = 50          // 5s — Slice A is in the same content_scripts block

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

    /** Inject a page-world helper once. Content scripts run in an isolated
     *  world where `window.jQuery` is undefined, so the select2 chip never
     *  repaints from here — and Wicket's pipeline re-reads the chip on
     *  submit. The injected helper listens for `aes:afp:commit-select` on
     *  document and runs `$(sel).select2("val", value, true)` in the page's
     *  own jQuery, which both updates the chip and fires Wicket's onchange
     *  Ajax. Idempotent: a flag on document.documentElement gates re-injection. */
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

    /** Commit a value + repaint the select2 chip via the page-world bridge.
     *  Setting sel.value alone is insufficient — Wicket and select2 v3 both
     *  drive their state from jQuery events, which only the page's jQuery
     *  fires. Falls back to a native change dispatch if the bridge isn't
     *  reachable (extension reload mid-session, etc). */
    function _commitSelect(sel, value) {
        _ensurePageBridge()
        sel.value = value
        try {
            sel.setAttribute("data-aes-pending-value", String(value))
            sel.dispatchEvent(new Event("aes:afp:commit-select", {bubbles: true}))
            _diag("commit-select", {
                name:  sel.name,
                value,
                label: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null,
                path:  "page-bridge"
            })
            return true
        } catch (_) { /* fall through to legacy path */ }
        const $ = window.jQuery
        let path = "native"
        if ($) {
            try {
                const $sel = $(sel)
                if (typeof $sel.select2 === "function") {
                    const v = _detectSelect2Version()
                    try {
                        if (v === "v3") {
                            $sel.select2("val", value, true)
                        } else if (v === "v4") {
                            $sel.val(value).trigger("change")
                        } else {
                            try { $sel.select2("val", value, true) } catch (_) { /* probe v3 */ }
                            $sel.val(value).trigger("change")
                        }
                        path = "select2-" + (v || "unknown")
                    } catch (e) {
                        _diag("commit-select-error", {name: sel.name, value, version: v, err: String(e)})
                        path = "select2-fallback"
                    }
                }
                $sel.trigger("change")
                _diag("commit-select", {
                    name:  sel.name,
                    value,
                    label: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null,
                    path
                })
                return true
            } catch (_) { /* jQuery itself threw — fall through to native */ }
        }
        sel.dispatchEvent(new Event("change", {bubbles: true}))
        _diag("commit-select", {name: sel.name, value, path: "native"})
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

    function _normaliseLeg(leg) {
        const l = leg || {}
        const d = _readDefaults()
        const ctxOrigin = (window.AesAfp && window.AesAfp.ctx && window.AesAfp.ctx.currentLocationIata) || null
        return {
            origin:      l.origin      || ctxOrigin,
            destination: l.destination || null,
            depTime:     l.depTime     || d.defaultDepartureTime,
            pricePct:    Number.isFinite(l.pricePct)            ? l.pricePct : d.defaultPricePct,
            service:     (typeof l.service === "string")        ? l.service  : d.defaultService
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
    const TAB_ACTIVATE_MAX_TRIES   = 15
    async function _ensureNewTabActive() {
        let form = findForm()
        if (form) return form
        const getTabs = window.AesAfp && window.AesAfp.getFormTabs
        if (typeof getTabs !== "function") return null
        const tabs = getTabs()
        if (!tabs || !tabs.newTab || tabs.activeTab === "new") return null
        _diag("tab-activate", {from: tabs.activeTab})
        try { tabs.newTab.click() }
        catch (e) {
            _diag("tab-activate-error", {err: String(e)})
            return null
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

    function setOrigin(iata)         { const f = findForm(); return _setSelectByIata(f && f.originSelect, iata) }
    function setDestination(iata)    { const f = findForm(); return _setSelectByIata(f && f.destSelect,   iata) }

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
        if (setDestination(norm.destination))                 set.destination = norm.destination
        else                                                  missed.push("destination")
        if (setDepartureTime(norm.depTime))                   set.depTime     = norm.depTime
        else                                                  missed.push("depTime")
        if (setPricePercent(norm.pricePct))                   set.pricePct    = norm.pricePct
        else                                                  missed.push("price")
        if (setService(norm.service))                         set.service     = norm.service
        else                                                  missed.push("service")

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
        setTimeout(() => {
            try { f.submitBtn.click() }
            catch (e) { console.warn("[AFP-D] submit click threw", e) }
        }, 0)
        return {ok: true, posting: true}
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
        const result = {url: null, body: {}, missed: []}
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
            const partial = missed.length ? " (missed: " + missed.join(", ") + ")" : ""
            el.innerHTML = ""
            const summary = document.createElement("div")
            summary.style.color   = missed.length ? "#fde68a" : "#a7f3d0"
            summary.textContent   = "Pre-filled: " + orig + " → " + dest + " · " + time + " · " + pct + "% · " + svc + partial
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
            // origin (which may differ from the aircraft's current
            // location for inbound legs) and depTime. Forward both into
            // fill() so the form lines up with the leg the user clicked
            // — the no-submit invariant is preserved (fill() never
            // clicks Submit).
            const leg = {destination: c.destIata}
            // Track 7 follow-up: route-candidates' per-row HH:MM picker
            // sends payload.depTime on every candidate-list click. Honour
            // it when present; the wave-leg branch below only fills in
            // a depTime when the picker didn't.
            if (typeof p.depTime === "string") leg.depTime = p.depTime
            if (p.source === "wave-leg" && c.__wave) {
                if (c.__wave.origin)  leg.origin  = c.__wave.origin
                if (c.__wave.depTime && !leg.depTime) leg.depTime = c.__wave.depTime
            }
            fill(leg)
        })
        _loadSettings()
    }

    // Public namespace.
    window.AesAfpFormDriver = {
        findForm, setOrigin, setDestination, setDepartureTime,
        setPricePercent, setService, fill, fillAndSubmit, reverse, clear, dryRun
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
