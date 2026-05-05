"use strict"

/**
 * AES Strategy — Journal panel (Slice 26 Phase 1).
 *
 * Pure render fn the strategy modal calls into. Composes inline; owns no
 * modal of its own. State lives on the host DOM element so re-renders
 * triggered by the journal bus preserve filter / search / expanded.
 *
 * Public API (window.AesStrategyJournalPanel):
 *   render(host, opts) → void
 *
 * opts.accountId — scopes the journal load (defaults to current account).
 *
 * Live updates: each render attaches one bus listener per event
 * (`journal:entry-recorded`, `journal:reason-updated`); previous handlers
 * are detached first so closing + reopening the modal can't leak.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyJournalPanel) return

    const COLOR = {
        rule:    "#374151",
        text:    "#f3f4f6",
        muted:   "#9ca3af",
        accent:  "#a78bfa",
        ok:      "#10b981",
        warn:    "#f59e0b",
        err:     "#ef4444",
        chipBg:  "#111827"
    }

    const ACTION_LABEL = {
        "override-save":    "override",
        "note-save":        "note",
        "watchlist-toggle": "watchlist",
        "apply-decision":   "apply",
        "weight-change":    "weights"
    }
    const ACTION_TONE = {
        "override-save":    COLOR.accent,
        "note-save":        COLOR.muted,
        "watchlist-toggle": COLOR.warn,
        "apply-decision":   COLOR.ok,
        "weight-change":    COLOR.accent
    }
    const FILTER_OPTIONS = [
        ["all",              "All"],
        ["override-save",    "Overrides"],
        ["note-save",        "Notes"],
        ["watchlist-toggle", "Watchlist"],
        ["apply-decision",   "Applies"],
        ["weight-change",    "Weight changes"]
    ]
    const PAGE_SIZE = 50

    function _el(tag, cssText, text) {
        const e = document.createElement(tag)
        if (cssText) e.style.cssText = cssText
        if (text != null) e.textContent = String(text)
        return e
    }
    function _fmtTs(ts) {
        const d = new Date(ts)
        if (isNaN(d.getTime())) return "—"
        const pad = n => String(n).padStart(2, "0")
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
            + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
    }
    function _summarizeBeforeAfter(entry) {
        const a = entry && entry.action
        const b = entry && entry.before
        const t = entry && entry.after
        if (a === "override-save") {
            const fields = []
            for (const k of ["paxLF", "cargoLF", "yieldPerKm", "cargoYieldPerKgKm"]) {
                const oldV = b && typeof b[k] === "number" ? b[k] : null
                const newV = t && typeof t[k] === "number" ? t[k] : null
                if (oldV == null && newV == null) continue
                if (oldV === newV) continue
                fields.push(k + " " + (oldV == null ? "—" : _fmtNum(oldV))
                              + "→"   + (newV == null ? "—" : _fmtNum(newV)))
            }
            if (!fields.length && t && t.note) return "note set"
            return fields.length ? fields.join(", ") : "(no change)"
        }
        if (a === "note-save") {
            const txt = (t && t.text) || (b && b.text) || ""
            return txt ? "\"" + (txt.length > 60 ? txt.slice(0, 60) + "…" : txt) + "\"" : "(cleared)"
        }
        if (a === "watchlist-toggle") {
            return t && t.starred ? "starred" : "unstarred"
        }
        if (a === "apply-decision") {
            const okStr = t && t.ok === false ? "FAILED" : "ok"
            const dom = (t && t.domain) || (b && b.domain) || "?"
            const err = t && t.error ? " · " + String(t.error).slice(0, 60) : ""
            return okStr + " · " + dom + err
        }
        if (a === "weight-change") {
            const reason = (t && t.reason) || (b && b.reason) || "manual"
            const samples = t && typeof t.sampleCount === "number" ? " · " + t.sampleCount + " samples" : ""
            const step = t && typeof t.stepSize === "number" ? " · step " + _fmtNum(t.stepSize) : ""
            return reason + samples + step
        }
        return ""
    }
    function _fmtNum(n) {
        if (typeof n !== "number" || !isFinite(n)) return "—"
        const abs = Math.abs(n)
        if (abs >= 100) return n.toFixed(0)
        if (abs >= 1)   return n.toFixed(2)
        return n.toFixed(3)
    }
    function _filterEntries(entries, filter, search) {
        const q = (search || "").toLowerCase().trim()
        const out = []
        for (const e of entries) {
            if (filter && filter !== "all" && e.action !== filter) continue
            if (q) {
                const blob = (e.route || "") + " " + (e.reasonText || "") + " "
                           + (e.action || "") + " " + _summarizeBeforeAfter(e)
                if (blob.toLowerCase().indexOf(q) === -1) continue
            }
            out.push(e)
        }
        return out
    }

    function _buildHeader(state, totalCount) {
        const head = _el("div",
            "padding:8px 16px;display:flex;align-items:center;gap:10px;cursor:pointer;"
            + "background:" + COLOR.chipBg + ";"
            + "border-bottom:1px solid " + COLOR.rule + ";"
        )
        const arrow = _el("span", "color:" + COLOR.muted + ";font:14px sans-serif;width:14px;",
            state.expanded ? "▾" : "▸")
        const title = _el("span",
            "color:" + COLOR.accent + ";font:600 11px sans-serif;letter-spacing:0.06em;text-transform:uppercase;",
            "Journal")
        const count = _el("span",
            "color:" + COLOR.muted + ";font:11px sans-serif;margin-left:auto;",
            totalCount + " " + (totalCount === 1 ? "entry" : "entries"))
        head.append(arrow, title, count)
        return head
    }

    function _buildFilterRow(state, onChange) {
        const row = _el("div",
            "padding:8px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;"
            + "border-bottom:1px solid " + COLOR.rule + ";"
        )
        const sel = _el("select",
            "background:" + COLOR.chipBg + ";color:" + COLOR.text
            + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 6px;font:12px sans-serif;"
        )
        for (const [val, lbl] of FILTER_OPTIONS) {
            const o = document.createElement("option")
            o.value = val
            o.textContent = lbl
            if (state.filter === val) o.selected = true
            sel.appendChild(o)
        }
        sel.addEventListener("change", () => { state.filter = sel.value; onChange() })
        const search = _el("input",
            "background:" + COLOR.chipBg + ";color:" + COLOR.text
            + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 8px;font:12px sans-serif;"
            + "flex:1;min-width:160px;"
        )
        search.type = "search"
        search.placeholder = "Search route or reason…"
        search.value = state.search || ""
        let debounce = null
        search.addEventListener("input", () => {
            clearTimeout(debounce)
            debounce = setTimeout(() => { state.search = search.value; onChange() }, 150)
        })
        row.append(sel, search)
        return row
    }

    function _buildEntryRow(entry, state, accountId, onChange) {
        const row = _el("div",
            "padding:8px 16px;display:flex;align-items:flex-start;gap:10px;"
            + "border-bottom:1px solid " + COLOR.rule + ";font:12px sans-serif;color:" + COLOR.text + ";"
        )
        const ts = _el("span", "color:" + COLOR.muted + ";font-variant-numeric:tabular-nums;width:120px;flex:0 0 auto;",
            _fmtTs(entry.ts))
        const tag = _el("span",
            "color:" + (ACTION_TONE[entry.action] || COLOR.muted) + ";font-weight:600;width:80px;flex:0 0 auto;",
            ACTION_LABEL[entry.action] || entry.action)
        const route = _el("span",
            "color:" + COLOR.text + ";width:80px;flex:0 0 auto;",
            entry.route || "—")
        const summary = _el("span",
            "color:" + COLOR.muted + ";flex:1;min-width:0;word-break:break-word;",
            _summarizeBeforeAfter(entry))
        const reason = _buildReasonCell(entry, accountId, onChange)
        row.append(ts, tag, route, summary, reason)
        return row
    }

    function _buildReasonCell(entry, accountId, onChange) {
        const cell = _el("span",
            "color:" + (entry.reasonText ? COLOR.accent : COLOR.muted)
            + ";font-style:italic;cursor:pointer;width:200px;flex:0 0 auto;text-align:right;"
            + "border-bottom:1px dotted " + COLOR.rule + ";padding-bottom:1px;"
        )
        cell.title = "Click to add or edit reason"
        cell.textContent = entry.reasonText
            ? "\"" + (entry.reasonText.length > 30 ? entry.reasonText.slice(0, 30) + "…" : entry.reasonText) + "\" ✎"
            : "+ reason"
        cell.addEventListener("click", () => _openReasonEditor(cell, entry, accountId, onChange))
        return cell
    }

    function _openReasonEditor(cell, entry, accountId, onChange) {
        const ta = _el("textarea",
            "background:" + COLOR.chipBg + ";color:" + COLOR.text
            + ";border:1px solid " + COLOR.accent + ";border-radius:3px;padding:4px 6px;font:12px sans-serif;"
            + "width:100%;min-height:48px;resize:vertical;"
        )
        ta.maxLength = 200
        ta.value = entry.reasonText || ""
        ta.placeholder = "Why? (≤200 chars)"
        const wrap = _el("div", "width:200px;flex:0 0 auto;display:flex;flex-direction:column;gap:4px;")
        const btnRow = _el("div", "display:flex;gap:6px;justify-content:flex-end;")
        const save = _el("button",
            "background:" + COLOR.accent + ";color:#0f172a;border:none;border-radius:3px;"
            + "padding:3px 8px;font:600 11px sans-serif;cursor:pointer;",
            "Save")
        const cancel = _el("button",
            "background:transparent;color:" + COLOR.muted + ";border:1px solid " + COLOR.rule + ";"
            + "border-radius:3px;padding:3px 8px;font:11px sans-serif;cursor:pointer;",
            "Cancel")
        btnRow.append(cancel, save)
        wrap.append(ta, btnRow)
        cell.replaceWith(wrap)
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)

        const commit = async () => {
            const updated = await window.AesStrategyJournal.addReason(entry.id, ta.value, accountId)
            if (updated) onChange()
        }
        save.addEventListener("click", commit)
        cancel.addEventListener("click", () => onChange())
        ta.addEventListener("keydown", e => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit() }
            else if (e.key === "Escape") { e.preventDefault(); onChange() }
        })
    }

    function _detachBus(host) {
        if (!host || !host._aesJournalBusHandlers) return
        const ns = window.AesStrategyJournal
        if (ns && ns.bus) {
            for (const h of host._aesJournalBusHandlers) {
                ns.bus.off(h.name, h.fn)
            }
        }
        host._aesJournalBusHandlers = null
    }

    async function render(host, opts) {
        if (!host) return
        const accountId = (opts && opts.accountId) || null
        const ns = window.AesStrategyJournal
        if (!ns || typeof ns.loadAll !== "function") {
            host.textContent = ""
            host.appendChild(_el("p",
                "padding:12px 16px;color:" + COLOR.muted + ";font:12px sans-serif;font-style:italic;",
                "Journal store not loaded."))
            return
        }

        // State persists on the host across re-renders so search / filter
        // / expanded survive bus-driven refreshes.
        if (!host._aesJournalState) {
            host._aesJournalState = {expanded: false, filter: "all", search: ""}
        }
        const state = host._aesJournalState

        const all = await ns.loadAll(accountId)
        const filtered = state.expanded ? _filterEntries(all, state.filter, state.search) : all

        host.textContent = ""

        const onChange = () => render(host, opts)
        const head = _buildHeader(state, all.length)
        head.addEventListener("click", () => { state.expanded = !state.expanded; onChange() })
        host.appendChild(head)

        if (!state.expanded) {
            _attachBus(host, onChange)
            return
        }

        host.appendChild(_buildFilterRow(state, onChange))

        const list = _el("div", "max-height:280px;overflow-y:auto;")
        if (!filtered.length) {
            list.appendChild(_el("p",
                "padding:14px 16px;color:" + COLOR.muted + ";font:12px sans-serif;font-style:italic;text-align:center;",
                all.length ? "No entries match the current filter." : "No journal entries yet."))
        } else {
            const cap = Math.min(filtered.length, PAGE_SIZE)
            for (let i = 0; i < cap; i++) {
                list.appendChild(_buildEntryRow(filtered[i], state, accountId, onChange))
            }
            if (filtered.length > PAGE_SIZE) {
                list.appendChild(_el("p",
                    "padding:8px 16px;color:" + COLOR.muted + ";font:11px sans-serif;text-align:center;",
                    "Showing first " + PAGE_SIZE + " of " + filtered.length + " — refine the filter to narrow."))
            }
        }
        host.appendChild(list)

        _attachBus(host, onChange)
    }

    function _attachBus(host, onChange) {
        _detachBus(host)
        const ns = window.AesStrategyJournal
        if (!ns || !ns.bus) return
        host._aesJournalBusHandlers = []
        const handler = () => {
            // Bail out if the host has been detached (modal closed); the
            // strategy panel's close path replaces bodyHost.textContent.
            if (!host.isConnected) { _detachBus(host); return }
            onChange()
        }
        ns.bus.on("journal:entry-recorded", handler)
        ns.bus.on("journal:reason-updated", handler)
        host._aesJournalBusHandlers.push(
            {name: "journal:entry-recorded", fn: handler},
            {name: "journal:reason-updated", fn: handler}
        )
    }

    window.AesStrategyJournalPanel = {
        render: render
    }
})()
