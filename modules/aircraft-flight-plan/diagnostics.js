"use strict"

/**
 * AFP Phase 1 diagnostics — wraps the bus + exposes slot inspection so we
 * can see which slice is silently bailing on a given aircraft page.
 *
 * Off by default. Enable per-tab via URL `?aes-debug` (mirrored to
 * localStorage["aes-afp-debug"]="1" so it survives the next reload), or
 * disable explicitly with `?aes-debug=0`. When off, this module loads but
 * does nothing — zero console noise, no bus wrapping, no perf cost.
 *
 * Loads after host.js (so AesAfp.bus exists) and before audit-log.js +
 * the other slices (so we wrap `on` before any subscriber registers).
 *
 * Public API (when enabled):
 *   AesAfpDiagnostics.summary()       -> {enabled, slots, ctx, recentEvents, subs}
 *   AesAfpDiagnostics.events          -> Array<{t, kind, name, payload?}>
 *   AesAfpDiagnostics.record(kind, payload)         -> push a custom event
 *   AesAfpDiagnostics.runSelfTest()   -> Array<{purpose, selector, ok, count, note}>
 *   AesAfpDiagnostics.memo            -> {candidate, lastFill}  last seen
 *   AesAfpDiagnostics.forceResync()   -> re-emit memo.candidate as candidate:selected
 *   AesAfpDiagnostics.clearLog()      -> empty events ring
 *   AesAfpDiagnostics.SELECTORS       -> slice-1d table; consumed by runSelfTest()
 */
;(function () {
    if (window.AesAfpDiagnostics) return

    const LS_KEY = "aes-afp-debug"
    const PREFIX = "[AES AFP debug]"
    const SLOTS  = ["header", "spec", "audit", "tools", "candidates", "driver", "wave"]
    const MAX_EVENTS = 200
    const OVERLAY_POLL_MS = 500
    const OVERLAY_ATTR = "data-aes-afp-debug-overlay"

    function readEnabled() {
        try {
            const url = new URL(window.location.href)
            const q = url.searchParams.get("aes-debug")
            if (q !== null) {
                const on = q === "" || q === "1" || q === "true"
                try {
                    if (on) localStorage.setItem(LS_KEY, "1")
                    else    localStorage.removeItem(LS_KEY)
                } catch (_) { /* private mode */ }
                return on
            }
        } catch (_) { /* malformed URL */ }
        try { return localStorage.getItem(LS_KEY) === "1" }
        catch (_) { return false }
    }

    const enabled = readEnabled()
    const events  = []
    const subs    = Object.create(null)
    const memo    = {candidate: null, lastFill: null, lastFillAt: null}

    /** Push an entry into the events ring. No-op when diagnostics is
     *  disabled — keeps the production cost of `_diag` callers at zero.
     *  - 2-arg form: record("commit-select", {...})
     *  - 3-arg form: record("emit", "candidate:selected", {...}) — used by wrapBus */
    function record(kind, nameOrPayload, payload) {
        if (!enabled) return
        let name, p
        if (arguments.length >= 3) { name = nameOrPayload; p = payload }
        else                       { name = null;          p = nameOrPayload }
        events.push({t: Date.now(), kind, name, payload: previewPayload(p)})
        if (events.length > MAX_EVENTS) events.shift()
    }

    function previewPayload(payload) {
        if (payload == null) return payload
        if (typeof payload !== "object") return payload
        try {
            const json = JSON.stringify(payload, (_, v) =>
                (v && typeof v === "object" && v.nodeType) ? "[Element]" : v
            )
            return json.length > 240 ? json.slice(0, 237) + "…" : JSON.parse(json)
        } catch (_) { return "[unserializable]" }
    }

    function wrapBus() {
        if (!window.AesAfp || !AesAfp.bus || AesAfp.bus.__aesDiagWrapped) return false
        const bus = AesAfp.bus
        const origEmit = bus.emit.bind(bus)
        const origOn   = bus.on.bind(bus)
        const origOff  = bus.off.bind(bus)

        bus.emit = function (name, payload) {
            record("emit", name, payload)
            console.groupCollapsed(PREFIX + " emit " + name + " (subs: " + (subs[name] || 0) + ")")
            console.log("payload:", previewPayload(payload))
            console.groupEnd()
            return origEmit(name, payload)
        }
        bus.on = function (name, h) {
            if (typeof h === "function") {
                record("on", name)
                subs[name] = (subs[name] || 0) + 1
                console.log(PREFIX + " on " + name + " (now " + subs[name] + ")")
            }
            return origOn(name, h)
        }
        bus.off = function (name, h) {
            record("off", name)
            subs[name] = Math.max(0, (subs[name] || 0) - 1)
            return origOff(name, h)
        }
        bus.__aesDiagWrapped = true
        return true
    }

    function attachMemos() {
        if (!window.AesAfp || !AesAfp.bus) return false
        const bus = AesAfp.bus
        bus.on("candidate:selected", (payload) => {
            memo.candidate = payload
        })
        bus.on("form:filled", (payload) => {
            memo.lastFill   = payload
            memo.lastFillAt = Date.now()
        })
        bus.on("form:cleared", () => {
            memo.lastFill   = {cleared: true}
            memo.lastFillAt = Date.now()
        })
        return true
    }

    function summary() {
        const slots = {}
        if (window.AesAfp && typeof AesAfp.slot === "function") {
            for (const name of SLOTS) {
                const el = AesAfp.slot(name)
                slots[name] = el
                    ? {present: true, empty: !el.children.length, text: (el.textContent || "").trim().slice(0, 80)}
                    : {present: false}
            }
        }
        return {
            enabled,
            ctx:          (window.AesAfp && AesAfp.ctx) || null,
            slots,
            subs:         Object.assign({}, subs),
            recentEvents: events.slice(-30)
        }
    }

    // ── Selector table (slice 1d) ───────────────────────────────────────────
    // Format: {purpose, selector, scope, note?}. `scope`:
    //   "form" — resolved against the form root from findNewFlightForm()
    //   "tabs" — special-cased to findFormTabs() (text-match, not querySelector)
    //   "page" — document-level
    // Mirrored in modules/aircraft-flight-plan/SELECTORS.md.
    const SELECTORS = [
        {scope: "page", purpose: "Form root",
         selector: "form[action*='aircraft.newflight.number']",
         note: "Wicket id reshuffles every render — match by action substring"},
        {scope: "page", purpose: "Submit button",
         selector: "input[type='submit'][value*='Create new flight']",
         note: "Anchors findNewFlightForm; also disambiguates from Transfer-flight-plan"},
        {scope: "form", purpose: "Origin select",
         selector: "select[name='origin']",
         note: "select2 v3 — class 'select2-offscreen' is the v3 marker; option values are airport ids"},
        {scope: "form", purpose: "Destination select",
         selector: "select[name='destination']",
         note: "select2 v3 — same as Origin"},
        {scope: "form", purpose: "Hours select",
         selector: "select[name='departure:hours']",
         note: "Native; option values 0..23 (unpadded)"},
        {scope: "form", purpose: "Minutes select",
         selector: "select[name='departure:minutes']",
         note: "Native; option values 0,5,10,...,55"},
        {scope: "form", purpose: "Price select",
         selector: "select[name='price']",
         note: "Native; option values are price-percent strings"},
        {scope: "form", purpose: "Service select",
         selector: "select[name='service']",
         note: "Native"},
        {scope: "form", purpose: "Reverse O/D anchor",
         selector: "a.btn.btn-default[href*='toggle~stations']",
         note: "Fallback: text-match /reverse/i — host.js does both"},
        {scope: "tabs", purpose: "New Flight Number tab",
         selector: "a (text 'New Flight Number')",
         note: "Text-match preferred; href fallback uses 'newFlightNumber' or 'toggle~new'"},
        {scope: "tabs", purpose: "Existing Flight Number tab",
         selector: "a (text 'Existing Flight Number')",
         note: "Text-match preferred; href fallback uses 'existingFlightNumber' or 'toggle~existing'"},
        {scope: "form", purpose: "Hidden Wicket fields",
         selector: "div.hidden-fields[hidden]",
         note: "Wicket-managed (CSRF / form state) — do not modify"},

        // ── Track 7 — Visual Flight Plan blocks (slice 7a) ────────────────────
        {scope: "page", purpose: "VFP container",
         selector: ".as-panel.visual-flight-plan",
         note: "Slice 7a — empty when aircraft has no schedule yet"},
        {scope: "page", purpose: "VFP day rows",
         selector: ".as-panel.visual-flight-plan .vfp.vfp-main .day",
         note: "7 expected on a populated AFP page (Mon..Sun)"},
        {scope: "page", purpose: "VFP flight blocks",
         selector: ".as-panel.visual-flight-plan .day .blocks .block.flight",
         note: "Pre-7a reader read only these; 7a's vfp-reader walks all six kinds"},
        {scope: "page", purpose: "VFP location blocks",
         selector: ".as-panel.visual-flight-plan .day .blocks .block.location",
         note: "Carry .outbound / .inbound IATA spans"},
        {scope: "page", purpose: "VFP turnaround blocks",
         selector: ".as-panel.visual-flight-plan .day .blocks .block.turnaround",
         note: "Each contains a .modal#ta-NN popover (slice 7b)"},
        {scope: "page", purpose: "VFP maintenance blocks",
         selector: ".as-panel.visual-flight-plan .day .blocks .block.maintenance",
         note: "Width = downtime minutes; consumed by slice 7d's allocator"},
        {scope: "page", purpose: "Flight overlay anchors",
         selector: ".as-panel.visual-flight-plan .block.flight .overlay a[href]",
         note: "info / edit / delete CTAs revealed on hover"},

        // ── Track 7 — Turnaround popover (slice 7b) ───────────────────────────
        {scope: "page", purpose: "Turnaround popover modal",
         selector: ".as-panel.visual-flight-plan .block.turnaround .modal[id^='ta-']",
         note: "One per turnaround; activity table inside .modal-body"},
        {scope: "page", purpose: "Turnaround activity table",
         selector: ".as-panel.visual-flight-plan .block.turnaround .modal table.table",
         note: "Three tbodies: Inbound / Outbound / Split Turnaround"},

        // ── Track 7 — Planning matrix (slice 7b) ──────────────────────────────
        {scope: "page", purpose: "Planning-matrix form",
         selector: "form[action*='flight.planning.form']",
         note: "Absent on Existing-Flight tab and on aircraft with no flights"},
        {scope: "page", purpose: "Planning-matrix table",
         selector: "table.flight-planning-matrix",
         note: "7-column day grid; per-segment + per-airport rows"},
        {scope: "page", purpose: "Day-selection checkboxes",
         selector: "form[action*='flight.planning.form'] input[type='checkbox'][name*='daySelection:'][name*=':ticked']",
         note: "7 expected (Mon..Sun)"},
        {scope: "page", purpose: "Per-segment base-departure hours",
         selector: "form[action*='flight.planning.form'] select[name*='segmentSettings:'][name$=':newDeparture:hours']",
         note: "One per segment; option values 0..23 unpadded"},
        {scope: "page", purpose: "Per-segment base-departure minutes",
         selector: "form[action*='flight.planning.form'] select[name*='segmentSettings:'][name$=':newDeparture:minutes']",
         note: "Option values 0..59"},
        {scope: "page", purpose: "Per-day departure offset selects",
         selector: "form[action*='flight.planning.form'] select[name*='departure-offsets']",
         note: "(segment × day) — values -60..+60 minutes"},
        {scope: "page", purpose: "Per-day fixed-arrival checkboxes",
         selector: "form[action*='flight.planning.form'] input[type='checkbox'][name*='fixedArrivalSelection']",
         note: "(segment × day)"},
        {scope: "page", purpose: "Per-day arrival hours selects",
         selector: "form[action*='flight.planning.form'] select[name*='newArrivals'][name$=':newArrival:hours']",
         note: "(segment × day)"}
    ]

    function runSelfTest() {
        const out = []
        const formCtx = (window.AesAfp && typeof AesAfp.getNewFlightForm === "function")
            ? AesAfp.getNewFlightForm() : null
        const tabsCtx = (window.AesAfp && typeof AesAfp.getFormTabs === "function")
            ? AesAfp.getFormTabs() : null
        for (const def of SELECTORS) {
            let found = null, count = 0, note = def.note || ""
            try {
                if (def.scope === "form") {
                    if (!formCtx) { note = "form not in DOM (active tab not 'new'?)" }
                    else {
                        found = formCtx.form ? formCtx.form.querySelector(def.selector) : null
                        count = formCtx.form ? formCtx.form.querySelectorAll(def.selector).length : 0
                    }
                } else if (def.scope === "tabs") {
                    if (!tabsCtx) { note = "tab nav not found" }
                    else {
                        // The tabs scope's "found" is the live anchor in the tabs ctx.
                        if      (def.purpose === "New Flight Number tab")      found = tabsCtx.newTab
                        else if (def.purpose === "Existing Flight Number tab") found = tabsCtx.existingTab
                        else found = document.querySelector(def.selector)
                        count = found ? 1 : 0
                    }
                } else {
                    found = document.querySelector(def.selector)
                    count = document.querySelectorAll(def.selector).length
                }
            } catch (e) { note = "selector threw: " + String(e) }
            out.push({purpose: def.purpose, selector: def.selector, scope: def.scope || "page", ok: !!found, count, note})
        }
        return out
    }

    function forceResync() {
        if (!memo.candidate) return false
        if (!window.AesAfp || !AesAfp.bus) return false
        try { AesAfp.bus.emit("candidate:selected", memo.candidate); return true }
        catch (_) { return false }
    }

    function clearLog() { events.length = 0 }

    // ── Overlay UI ──────────────────────────────────────────────────────────
    function _styleEl(el, css) { el.style.cssText = css; return el }

    let _overlayPoll = null

    function _formatTimeAgo(t) {
        const ms = Date.now() - t
        if (ms < 1000)  return Math.round(ms) + "ms"
        if (ms < 60000) return (ms / 1000).toFixed(1) + "s"
        return Math.round(ms / 60000) + "m"
    }

    function _readChipText(sel) {
        if (!sel) return null
        if (sel.classList && sel.classList.contains("select2-offscreen")) {
            const chosen = sel.parentElement && sel.parentElement.querySelector(".select2-chosen")
            return chosen ? (chosen.textContent || "").trim() : "(no chip)"
        }
        const opt = sel.options ? sel.options[sel.selectedIndex] : null
        return opt ? opt.text : null
    }

    function _readFormState() {
        const form = (window.AesAfp && typeof AesAfp.getNewFlightForm === "function")
            ? AesAfp.getNewFlightForm() : null
        if (!form) {
            const tabs = (window.AesAfp && typeof AesAfp.getFormTabs === "function")
                ? AesAfp.getFormTabs() : null
            return {missing: true, activeTab: tabs ? tabs.activeTab : "unknown"}
        }
        const fields = [
            {key: "origin",      sel: form.originSelect},
            {key: "destination", sel: form.destSelect},
            {key: "dep:hours",   sel: form.hoursSelect},
            {key: "dep:minutes", sel: form.minsSelect},
            {key: "price",       sel: form.priceSelect},
            {key: "service",     sel: form.serviceSelect}
        ]
        return {
            missing: false,
            rows: fields.map(f => ({
                key:   f.key,
                value: f.sel ? f.sel.value : null,
                chip:  _readChipText(f.sel),
                option: f.sel && f.sel.options[f.sel.selectedIndex] ? f.sel.options[f.sel.selectedIndex].text : null
            }))
        }
    }

    function _renderFormState(tbody) {
        tbody.innerHTML = ""
        const state = _readFormState()
        if (state.missing) {
            const tr = document.createElement("tr")
            const td = document.createElement("td")
            td.colSpan = 3
            td.style.cssText = "padding:6px;color:#fca5a5;text-align:center;"
            td.textContent = "form not in DOM (active tab: " + state.activeTab + ")"
            tr.appendChild(td)
            tbody.appendChild(tr)
            return
        }
        for (const r of state.rows) {
            const tr = document.createElement("tr")
            const tdK = document.createElement("td")
            tdK.style.cssText = "padding:2px 6px;color:#9ca3af;"
            tdK.textContent = r.key
            const tdV = document.createElement("td")
            tdV.style.cssText = "padding:2px 6px;color:#e2e8f0;"
            tdV.textContent = r.value == null ? "—" : String(r.value)
            const tdC = document.createElement("td")
            tdC.style.cssText = "padding:2px 6px;color:" + (r.chip && r.chip !== "Choose One" ? "#a7f3d0" : "#fca5a5") + ";"
            tdC.textContent = r.chip == null ? "—" : r.chip
            tr.append(tdK, tdV, tdC)
            tbody.appendChild(tr)
        }
    }

    function _renderRecentEvents(box) {
        box.innerHTML = ""
        const recent = events.slice(-8).reverse()
        if (!recent.length) {
            box.textContent = "(no events yet)"
            box.style.color = "#6b7280"
            return
        }
        box.style.color = "#cbd5e1"
        for (const e of recent) {
            const line = document.createElement("div")
            line.style.cssText = "font-family:ui-monospace,monospace;font-size:10px;line-height:1.5;"
            const t = document.createElement("span")
            t.style.color = "#6b7280"
            t.textContent = _formatTimeAgo(e.t).padStart(5) + " "
            const k = document.createElement("span")
            k.style.color = "#fde68a"
            k.textContent = e.kind + (e.name ? ":" + e.name : "")
            line.append(t, k)
            if (e.payload != null && typeof e.payload === "object") {
                const p = document.createElement("span")
                p.style.color = "#94a3b8"
                p.textContent = " " + JSON.stringify(e.payload).slice(0, 80)
                line.appendChild(p)
            }
            box.appendChild(line)
        }
    }

    function _renderLastFill(box) {
        box.innerHTML = ""
        if (!memo.lastFill) {
            box.textContent = "(no fill yet)"
            box.style.color = "#6b7280"
            return
        }
        const ageStr = memo.lastFillAt ? "  · " + _formatTimeAgo(memo.lastFillAt) + " ago" : ""
        const head = document.createElement("div")
        head.style.cssText = "color:#cbd5e1;font-size:10px;margin-bottom:2px;"
        head.textContent = (memo.lastFill.cleared ? "form cleared" : ("source: " + (memo.lastFill.source || "?"))) + ageStr
        box.appendChild(head)
        const pre = document.createElement("pre")
        pre.style.cssText = "margin:0;padding:4px 6px;background:#0f1419;color:#e2e8f0;"
            + "font-family:ui-monospace,monospace;font-size:10px;line-height:1.4;"
            + "max-height:80px;overflow:auto;border-radius:3px;"
        pre.textContent = JSON.stringify(memo.lastFill, null, 2)
        box.appendChild(pre)
    }

    function _renderSelfTest(box, results) {
        box.innerHTML = ""
        if (!results.length) {
            box.textContent = "SELECTORS table is empty (slice 1d not yet shipped)"
            box.style.color = "#fde68a"
            return
        }
        const passN = results.filter(r => r.ok).length
        const head = document.createElement("div")
        head.style.cssText = "color:" + (passN === results.length ? "#a7f3d0" : "#fde68a") + ";font-size:10px;margin-bottom:2px;"
        head.textContent = "self-test " + passN + " / " + results.length + " passed"
        box.appendChild(head)
        for (const r of results) {
            const line = document.createElement("div")
            line.style.cssText = "font-family:ui-monospace,monospace;font-size:10px;line-height:1.4;"
                + "color:" + (r.ok ? "#a7f3d0" : "#fca5a5") + ";"
            const tag = r.ok ? "✓ " : "✗ "
            const note = r.note ? " — " + r.note : ""
            line.textContent = tag + r.purpose + " (" + r.selector + ")" + note
            box.appendChild(line)
        }
    }

    function mountOverlay() {
        if (!enabled) return
        if (document.querySelector("[" + OVERLAY_ATTR + "]")) return
        if (!document.body) {
            document.addEventListener("DOMContentLoaded", mountOverlay, {once: true})
            return
        }

        const root = _styleEl(document.createElement("div"),
            "position:fixed;top:8px;right:8px;width:380px;max-height:80vh;"
          + "z-index:999999;background:rgba(15,20,25,0.96);color:#e2e8f0;"
          + "border:1px solid #334155;border-radius:6px;padding:8px;"
          + "font-family:system-ui,sans-serif;font-size:11px;line-height:1.4;"
          + "box-shadow:0 4px 16px rgba(0,0,0,0.4);overflow:auto;"
        )
        root.setAttribute(OVERLAY_ATTR, "")

        // Header.
        const header = _styleEl(document.createElement("div"),
            "display:flex;justify-content:space-between;align-items:center;"
          + "margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #334155;"
        )
        const title = _styleEl(document.createElement("span"),
            "font-weight:600;color:#fde68a;"
        )
        title.textContent = "AES AFP debug"
        const closeBtn = _styleEl(document.createElement("button"),
            "background:transparent;border:none;color:#9ca3af;cursor:pointer;font-size:14px;padding:0 4px;"
        )
        closeBtn.type = "button"
        closeBtn.title = "Close (set ?aes-debug=0 or remove the localStorage flag to disable)"
        closeBtn.textContent = "×"
        closeBtn.addEventListener("click", () => {
            try { localStorage.setItem(LS_KEY, "0") } catch (_) {}
            if (_overlayPoll) { clearInterval(_overlayPoll); _overlayPoll = null }
            root.remove()
        })
        header.append(title, closeBtn)
        root.appendChild(header)

        // Live form state table.
        const stateLabel = _styleEl(document.createElement("div"),
            "font-size:10px;color:#9ca3af;margin:4px 0 2px;text-transform:uppercase;letter-spacing:0.04em;"
        )
        stateLabel.textContent = "Form state"
        root.appendChild(stateLabel)

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:10px;"
        const thead = document.createElement("thead")
        const trh = document.createElement("tr")
        for (const h of ["field", "value", "chip"]) {
            const th = document.createElement("th")
            th.style.cssText = "text-align:left;padding:2px 6px;color:#9ca3af;font-weight:500;border-bottom:1px solid #1f2937;"
            th.textContent = h
            trh.appendChild(th)
        }
        thead.appendChild(trh)
        const tbody = document.createElement("tbody")
        table.append(thead, tbody)
        root.appendChild(table)

        // Last fill section.
        const fillLabel = stateLabel.cloneNode(true)
        fillLabel.textContent = "Last fill"
        root.appendChild(fillLabel)
        const fillBox = _styleEl(document.createElement("div"), "margin-bottom:4px;")
        root.appendChild(fillBox)

        // Recent events section.
        const evLabel = stateLabel.cloneNode(true)
        evLabel.textContent = "Recent events"
        root.appendChild(evLabel)
        const evBox = _styleEl(document.createElement("div"), "max-height:120px;overflow:auto;")
        root.appendChild(evBox)

        // Buttons.
        const btnRow = _styleEl(document.createElement("div"),
            "display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;"
        )
        const btnCss = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:4px 8px;font-size:10px;cursor:pointer;"

        const resyncBtn = _styleEl(document.createElement("button"), btnCss)
        resyncBtn.type = "button"
        resyncBtn.textContent = "Force re-sync"
        resyncBtn.title = "Re-emit the last candidate:selected payload through the bus."
        resyncBtn.addEventListener("click", () => {
            const ok = forceResync()
            if (!ok) console.warn(PREFIX + " no memoed candidate to resync")
        })

        const stestBtn = _styleEl(document.createElement("button"), btnCss)
        stestBtn.type = "button"
        stestBtn.textContent = "Run self-test"
        stestBtn.title = "Walk the SELECTORS table and report which selectors resolve on this page."
        const stestBox = _styleEl(document.createElement("div"), "margin-top:6px;")
        stestBtn.addEventListener("click", () => {
            _renderSelfTest(stestBox, runSelfTest())
        })

        const clearBtn = _styleEl(document.createElement("button"), btnCss)
        clearBtn.type = "button"
        clearBtn.textContent = "Clear log"
        clearBtn.title = "Empty the recorded events ring."
        clearBtn.addEventListener("click", () => { clearLog(); _renderRecentEvents(evBox) })

        btnRow.append(resyncBtn, stestBtn, clearBtn)
        root.append(btnRow, stestBox)

        document.body.appendChild(root)

        const tick = () => {
            _renderFormState(tbody)
            _renderLastFill(fillBox)
            _renderRecentEvents(evBox)
        }
        tick()
        _overlayPoll = setInterval(tick, OVERLAY_POLL_MS)
    }

    if (enabled) {
        // host.js executes its IIFE synchronously and publishes window.AesAfp
        // before this script runs (manifest order), so wrapping is immediate.
        // The retry loop is a defensive backstop for extension reloads where
        // script order is briefly disturbed.
        const tryWire = () => {
            const wrapped = wrapBus()
            if (wrapped) attachMemos()
            return wrapped
        }
        if (!tryWire()) {
            let n = 0
            const t = setInterval(() => {
                if (tryWire() || ++n > 20) clearInterval(t)
            }, 50)
        }
        mountOverlay()
        console.log(PREFIX + " enabled. Run AesAfpDiagnostics.summary() in console to inspect slots + events.")
    }

    window.AesAfpDiagnostics = {
        enabled, summary, events, subs, memo,
        record, runSelfTest, forceResync, clearLog,
        SELECTORS
    }
})()
