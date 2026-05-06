/**
 * Filter chip bar + sort dropdown for the in-page panel. Multi-select chips
 * (deal class, age bracket, cost bracket, category) plus multi-select
 * dropdowns (manufacturer / family / type) sourced from TypeFamilyMap so
 * every dimension is selectable up-front — not gated on whether the current
 * scan happens to include that label. A free-text search input matches
 * across type / family / category / manufacturer / registration / owner /
 * location.
 *
 * State lives on the panel; this module renders against the supplied
 * `state` object and surfaces toggles. Pure rendering — no internal state
 * other than the `_pendingOpen` field used to re-open a multi-select
 * dropdown after the parent triggers a state-driven re-render.
 *
 * Cost bracket uses `MarketScanDealMetrics.effectiveAcquisitionCost(row,
 * leaseConfig)` so lease-only offers are bracketed by their lease
 * contract value rather than dropped because purchase price is null.
 */
class MarketPanelFilterChips {
    static AGE_BRACKETS = [
        {key: "lt5",   label: "≤5y",    test: a => a !== null && a <= 5},
        {key: "5to15", label: "5–15y",  test: a => a !== null && a > 5 && a <= 15},
        {key: "gt15",  label: ">15y",   test: a => a !== null && a > 15}
    ]

    static PRICE_BRACKETS = [
        {key: "lt1m",  label: "<AS$1M",   test: p => p !== null && p < 1e6},
        {key: "1to5",  label: "1–5M",     test: p => p !== null && p >= 1e6 && p < 5e6},
        {key: "5to20", label: "5–20M",    test: p => p !== null && p >= 5e6 && p < 20e6},
        {key: "gt20",  label: ">20M",     test: p => p !== null && p >= 20e6}
    ]

    // Order matches the family-grid: small → large. Chips render in this
    // order regardless of which categories happen to be present.
    static CATEGORIES = [
        {key: "commuter",   label: "Commuter"},
        {key: "turboprop",  label: "Turboprop"},
        {key: "regional",   label: "Regional"},
        {key: "narrowbody", label: "Narrowbody"},
        {key: "widebody",   label: "Widebody"},
        {key: "other",      label: "Other"}
    ]

    static SORT_OPTIONS = [
        {key: "score-desc",        label: "Score ↓",      field: "dealScore",     dir: -1},
        {key: "pricePerSeat-asc",  label: "$/seat ↑",     field: "pricePerSeat",  dir: 1},
        {key: "ageYears-asc",      label: "Age ↑",        field: "ageYears",      dir: 1},
        {key: "conditionPct-desc", label: "Condition ↓",  field: "conditionPct",  dir: -1},
        {key: "bidIntervalMs-asc", label: "Closing soon", field: "bidIntervalMs", dir: 1},
        {key: "nextBid-asc",       label: "Next bid ↑",   field: "nextBid",       dir: 1}
    ]

    /**
     * Stashes the keyed multi-select dropdown that was open right before a
     * toggle-driven re-render, so `render()` can re-open it with restored
     * scroll + filter input. Cleared as soon as it's consumed.
     */
    static _pendingOpen = null

    static lookupSort(key) {
        return MarketPanelFilterChips.SORT_OPTIONS.find(o => o.key === key)
            || MarketPanelFilterChips.SORT_OPTIONS[0]
    }

    /**
     * Pulls filterable deal classes from the classifier so chip metadata
     * stays in sync with badge metadata. Pass-class is excluded (filtering
     * for "only Pass deals" isn't a useful affordance).
     */
    static classChips() {
        if (typeof MarketScanDealClassifier === "undefined") return []
        return MarketScanDealClassifier.CLASSES.filter(c => c.filterable)
    }

    static render(host, state, cb, rows, leaseConfig, overrides, scopeSummary) {
        host.innerHTML = ""
        host.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:6px;"
            + "background:var(--aes-bone);border-bottom:1px solid var(--aes-paper-rule);"

        // Active-filter pill bar — every selection across every dimension
        // (scope + view) shown at the top with × to remove, plus "Clear
        // all" when ≥2 active. Hidden when nothing is selected so it
        // doesn't cost a row on a fresh panel.
        MarketPanelFilterChips._pillBar(host, state, cb)

        // SCAN SCOPE section — dimensions that define what gets scanned
        // and can be saved as a preset. When a scan is loaded these chips
        // also narrow visible rows (apply() is dimension-agnostic), so
        // selecting AIRBUS narrows both the next scan and the current view.
        const scopeHint = scopeSummary && scopeSummary.count
            ? scopeSummary.count + " type" + (scopeSummary.count === 1 ? "" : "s")
                + " · click Scan to fetch"
            : "Pick categories / manufacturers / families / types to define a scan"
        host.append(MarketPanelFilterChips._sectionHeader("Scan scope", scopeHint, {first: true}))

        // Category chips (small static list).
        host.append(MarketPanelFilterChips._row(MarketPanelFilterChips.CATEGORIES.map(c =>
            MarketPanelFilterChips._chip(
                c.label,
                state.categories && state.categories.has(c.key),
                () => MarketPanelFilterChips._toggleSet(state, "categories", c.key, cb)
            )
        )))

        // Only narrow to the live type dropdown when AS's family filter is
        // "any"; otherwise the type dropdown is family-scoped and would hide
        // the rest of the catalog. `marketDimensions` reads AS's <select>s once.
        const dim = TypeFamilyMap.marketDimensions(overrides)
        const allFamilies      = dim.familyOptions
        const allManufacturers = TypeFamilyMap.allManufacturers()
        const liveTypes        = dim.liveTypeSet
        const selectedTypes    = state.types instanceof Set ? state.types : null
        const allTypes         = liveTypes
            ? dim.typeOptions.filter(e => liveTypes.has(e.type)
                || (selectedTypes && selectedTypes.has(e.type)))
            : dim.typeOptions

        // Per-option live counts. Each map is computed against state with
        // its own dimension cleared, so the count reads as "rows that match
        // every other active filter when this option is the dimension's
        // sole pick" — comparable across options within the dropdown.
        const mfrCounts  = MarketPanelFilterChips._countsFor(rows, state, leaseConfig, "manufacturers")
        const famCounts  = MarketPanelFilterChips._countsFor(rows, state, leaseConfig, "families")
        const typeCounts = MarketPanelFilterChips._countsFor(rows, state, leaseConfig, "types")

        const scopeRow = document.createElement("div")
        scopeRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;"
        scopeRow.append(MarketPanelFilterChips._multiSelect(
            "Manufacturer",
            allManufacturers,
            state.manufacturers,
            v => MarketPanelFilterChips._toggleSet(state, "manufacturers", v, cb),
            {
                key:      "manufacturer",
                countFor: v => mfrCounts.get(v) || 0
            }
        ))
        scopeRow.append(MarketPanelFilterChips._multiSelect(
            "Family",
            allFamilies,
            state.families,
            v => MarketPanelFilterChips._toggleSet(state, "families", v, cb),
            {
                key:      "family",
                labelFor: e => e.family,
                valueFor: e => e.family,
                groupBy:  e => MarketPanelFilterChips._categoryLabel(e.category),
                countFor: e => famCounts.get(e.family) || 0
            }
        ))
        scopeRow.append(MarketPanelFilterChips._multiSelect(
            "Type",
            allTypes,
            state.types,
            v => MarketPanelFilterChips._toggleSet(state, "types", v, cb),
            {
                key:      "type",
                labelFor: e => e.type,
                valueFor: e => e.type,
                groupBy:  e => e.family,
                countFor: e => typeCounts.get(e.type) || 0
            }
        ))
        host.append(scopeRow)

        // VIEW FILTERS section — narrow already-scanned rows; never affect
        // the next scan's scope.
        host.append(MarketPanelFilterChips._sectionHeader("View filters",
            "Narrow visible rows from the current scan"))

        // Class · age · cost packed with extra spacing between the three
        // sub-dimensions so each group reads as a unit.
        const r1 = document.createElement("div")
        r1.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;"
        r1.append(MarketPanelFilterChips._chipGroup(
            MarketPanelFilterChips.classChips().map(c => MarketPanelFilterChips._chip(
                c.label,
                state.classes && state.classes.has(c.key),
                () => MarketPanelFilterChips._toggleSet(state, "classes", c.key, cb)
            ))
        ))
        r1.append(MarketPanelFilterChips._chipGroup(
            MarketPanelFilterChips.AGE_BRACKETS.map(b => MarketPanelFilterChips._chip(
                b.label,
                state.ageBracket === b.key,
                () => MarketPanelFilterChips._toggleScalar(state, "ageBracket", b.key, cb)
            ))
        ))
        r1.append(MarketPanelFilterChips._chipGroup(
            MarketPanelFilterChips.PRICE_BRACKETS.map(b => MarketPanelFilterChips._chip(
                b.label,
                state.priceBracket === b.key,
                () => MarketPanelFilterChips._toggleScalar(state, "priceBracket", b.key, cb)
            ))
        ))
        host.append(r1)

        // Booleans.
        host.append(MarketPanelFilterChips._row([
            MarketPanelFilterChips._chip("Fits fleet", !!state.fitsFleet,
                () => MarketPanelFilterChips._toggleBool(state, "fitsFleet", cb)),
            MarketPanelFilterChips._chip("Fits cash", !!state.fitsCash,
                () => MarketPanelFilterChips._toggleBool(state, "fitsCash", cb)),
            MarketPanelFilterChips._chip("Closing <6h", !!state.expiringSoon,
                () => MarketPanelFilterChips._toggleBool(state, "expiringSoon", cb)),
            MarketPanelFilterChips._chip("Has $/seat history", !!state.hasHistory,
                () => MarketPanelFilterChips._toggleBool(state, "hasHistory", cb))
        ]))

        // Search + sort.
        const lastRow = document.createElement("div")
        lastRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;"
        const search = document.createElement("input")
        search.type = "search"
        search.className = "aes-input"
        search.placeholder = "Search type / family / mfr / reg / owner / location"
        search.value = state.search || ""
        search.style.cssText = "flex:1 1 160px;min-width:120px;font-size:var(--aes-fs-small);"
        let searchTimer = null
        search.addEventListener("input", () => {
            if (searchTimer) clearTimeout(searchTimer)
            searchTimer = setTimeout(() => {
                state.search = search.value
                cb.onChange(state)
            }, 250)
        })
        lastRow.append(search)

        const sortSelect = document.createElement("select")
        sortSelect.className = "aes-select"
        sortSelect.style.cssText = "flex:0 0 auto;font-size:var(--aes-fs-small);"
        for (const o of MarketPanelFilterChips.SORT_OPTIONS) {
            const opt = document.createElement("option")
            opt.value = o.key
            opt.textContent = o.label
            if (state.sort === o.key) opt.selected = true
            sortSelect.append(opt)
        }
        sortSelect.addEventListener("change", () => {
            state.sort = sortSelect.value
            cb.onChange(state)
        })
        lastRow.append(sortSelect)

        host.append(lastRow)

        // After a toggle-driven re-render, re-open whichever dropdown was
        // open before the toggle, with its previous scroll and filter text.
        const pending = MarketPanelFilterChips._pendingOpen
        if (pending) {
            MarketPanelFilterChips._pendingOpen = null
            const trigger = host.querySelector('[data-aes-msel="' + pending.key + '"]')
            if (trigger && typeof trigger._aesOpen === "function") {
                trigger._aesOpen(pending)
            }
        }
    }

    static _row(children) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
        for (const c of children) row.append(c)
        return row
    }

    /**
     * Section divider used to split the chip bar into "Scan scope" and
     * "View filters" bands. Mirrors the typography of the panel's other
     * uppercase section labels (BEST CASES, SCORING) so the bands read as
     * peers, not as nested controls.
     */
    static _sectionHeader(label, hint, opts) {
        const wrap = document.createElement("div")
        const showRule = !(opts && opts.first)
        wrap.style.cssText = "display:flex;align-items:baseline;gap:8px;"
            + "padding:6px 0 2px;margin-top:2px;"
            + (showRule ? "border-top:1px solid var(--aes-paper-rule);" : "")
        const h = document.createElement("span")
        h.textContent = label
        h.style.cssText = "font:10px var(--aes-font-display);"
            + "font-weight:var(--aes-fw-bold);"
            + "text-transform:uppercase;"
            + "letter-spacing:var(--aes-tracking-caps);"
            + "color:var(--aes-ink);flex:0 0 auto;"
        wrap.append(h)
        if (hint) {
            const sub = document.createElement("span")
            sub.textContent = hint
            sub.style.cssText = "font-size:var(--aes-fs-small);"
                + "color:var(--aes-slate);font-style:italic;"
                + "flex:1 1 auto;text-transform:none;letter-spacing:0;"
            wrap.append(sub)
        }
        return wrap
    }

    static _chipGroup(children) {
        const g = document.createElement("div")
        g.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
        for (const c of children) g.append(c)
        return g
    }

    static _chip(label, active, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.className = "aes-chip" + (active ? " aes-chip--active" : "")
        b.addEventListener("click", onClick)
        return b
    }

    static _categoryLabel(key) {
        const c = MarketPanelFilterChips.CATEGORIES.find(c => c.key === key)
        return c ? c.label : (key || "Other")
    }

    /**
     * Multi-select dropdown. Returns a wrapper containing a chip-styled
     * trigger button; clicking the button opens a floating panel with a
     * filter input + checkbox list (optionally grouped). Each checkbox
     * click fires `onToggle(value)` immediately so the table re-filters
     * live; the dropdown re-opens automatically afterwards via the
     * `_pendingOpen` cursor on the class.
     *
     * opts:
     *   key      — string, used to persist open state across re-renders
     *   labelFor — option → display label (default: String)
     *   valueFor — option → set value (default: String)
     *   groupBy  — option → group name (optional; enables headers)
     */
    static _multiSelect(label, options, selectedSet, onToggle, opts) {
        opts = opts || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "position:relative;flex:0 0 auto;"

        const count = (selectedSet && selectedSet.size) || 0
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "aes-chip" + (count ? " aes-chip--active" : "")
        btn.textContent = count ? (label + " · " + count + " ▾") : (label + " ▾")
        if (opts.key) btn.setAttribute("data-aes-msel", opts.key)
        wrap.append(btn)

        let panel = null
        let bodyEl = null
        let searchInput = null
        let onDocClick = null
        let onKeydown = null

        const labelFor = typeof opts.labelFor === "function" ? opts.labelFor : (o => String(o))
        const valueFor = typeof opts.valueFor === "function" ? opts.valueFor : (o => String(o))
        const groupBy  = typeof opts.groupBy  === "function" ? opts.groupBy  : null

        function close() {
            if (!panel) return
            panel.remove()
            panel = null
            bodyEl = null
            searchInput = null
            if (onDocClick) document.removeEventListener("click", onDocClick, true)
            if (onKeydown) document.removeEventListener("keydown", onKeydown)
            onDocClick = null
            onKeydown = null
        }

        function redraw() {
            if (!bodyEl) return
            bodyEl.innerHTML = ""
            const f = (searchInput.value || "").trim().toLowerCase()
            const matches = f
                ? options.filter(o => {
                    if (labelFor(o).toLowerCase().indexOf(f) >= 0) return true
                    if (groupBy && groupBy(o).toLowerCase().indexOf(f) >= 0) return true
                    return false
                })
                : options
            if (!matches.length) {
                const e = document.createElement("div")
                e.textContent = "No matches"
                e.style.cssText = "padding:8px 10px;font-size:var(--aes-fs-small);"
                    + "color:var(--aes-slate);font-style:italic;"
                bodyEl.append(e)
                return
            }
            let lastG = null
            for (const opt of matches) {
                if (groupBy) {
                    const g = groupBy(opt)
                    if (g !== lastG) {
                        lastG = g
                        const h = document.createElement("div")
                        h.textContent = g
                        h.style.cssText = "padding:4px 10px;"
                            + "font:9px var(--aes-font-display);"
                            + "font-weight:var(--aes-fw-bold);"
                            + "text-transform:uppercase;"
                            + "letter-spacing:var(--aes-tracking-caps);"
                            + "color:var(--aes-slate);"
                            + "background:var(--aes-bone);"
                            + "border-top:1px solid var(--aes-paper-rule);"
                        bodyEl.append(h)
                    }
                }
                const v = valueFor(opt)
                const row = document.createElement("label")
                row.style.cssText = "display:flex;align-items:center;gap:8px;"
                    + "padding:3px 10px;cursor:pointer;font-size:var(--aes-fs-small);"
                    + "user-select:none;"
                row.addEventListener("mouseenter", () => row.style.background = "var(--aes-bone-2)")
                row.addEventListener("mouseleave", () => row.style.background = "")
                const cbx = document.createElement("input")
                cbx.type = "checkbox"
                cbx.checked = !!(selectedSet && selectedSet.has(v))
                cbx.style.cssText = "flex:0 0 auto;"
                cbx.addEventListener("change", (e) => {
                    e.stopPropagation()
                    if (opts.key) {
                        MarketPanelFilterChips._pendingOpen = {
                            key:       opts.key,
                            scrollTop: bodyEl ? bodyEl.scrollTop : 0,
                            filter:    searchInput ? searchInput.value : ""
                        }
                    }
                    onToggle(v)
                })
                row.append(cbx)
                const txt = document.createElement("span")
                txt.textContent = labelFor(opt)
                txt.style.cssText = "flex:1 1 auto;"
                row.append(txt)
                if (typeof opts.countFor === "function") {
                    const c = opts.countFor(opt)
                    if (typeof c === "number") {
                        const cnt = document.createElement("span")
                        cnt.textContent = c > 0 ? String(c) : "0"
                        cnt.style.cssText = "flex:0 0 auto;"
                            + "font:10px var(--aes-font-mono);"
                            + "letter-spacing:var(--aes-tracking-mono);"
                            + "color:var(--aes-slate);"
                            + (c === 0 ? "opacity:0.4;" : "")
                        row.append(cnt)
                        // 0-count rows still selectable — user might want
                        // to filter for an option absent from the current
                        // scan. We dim, not disable.
                        if (c === 0) row.style.opacity = "0.65"
                    }
                }
                bodyEl.append(row)
            }
        }

        function open(restore) {
            if (panel) return
            panel = document.createElement("div")
            panel.style.cssText = "position:absolute;top:calc(100% + 4px);left:0;"
                + "z-index:10001;min-width:240px;max-width:320px;max-height:320px;"
                + "background:var(--aes-paper);"
                + "border:1px solid var(--aes-paper-rule);"
                + "box-shadow:0 8px 24px rgba(0,0,0,0.18);"
                + "display:flex;flex-direction:column;"
            panel.addEventListener("click", (e) => e.stopPropagation())

            const head = document.createElement("div")
            head.style.cssText = "display:flex;gap:6px;padding:6px;"
                + "border-bottom:1px solid var(--aes-paper-rule);align-items:center;"
            searchInput = document.createElement("input")
            searchInput.type = "search"
            searchInput.placeholder = "Filter…"
            searchInput.className = "aes-input"
            searchInput.style.cssText = "flex:1 1 auto;font-size:var(--aes-fs-small);min-width:0;"
            searchInput.value = (restore && restore.filter) || ""
            searchInput.addEventListener("input", redraw)
            head.append(searchInput)

            const clearBtn = document.createElement("button")
            clearBtn.type = "button"
            clearBtn.textContent = "Clear"
            clearBtn.className = "aes-btn aes-btn--sm"
            clearBtn.style.cssText = "flex:0 0 auto;font-size:10px;"
            clearBtn.disabled = !(selectedSet && selectedSet.size)
            clearBtn.addEventListener("click", (e) => {
                e.stopPropagation()
                if (!selectedSet || !selectedSet.size) return
                if (opts.key) {
                    MarketPanelFilterChips._pendingOpen = {
                        key:       opts.key,
                        scrollTop: bodyEl ? bodyEl.scrollTop : 0,
                        filter:    searchInput.value
                    }
                }
                // Single batched onToggle call by clearing in-place then
                // emitting once would be tighter, but the existing toggle
                // handler is per-value — so iterate. The parent re-render
                // happens once per onToggle, but the dropdown re-opens via
                // _pendingOpen so the user just sees the count drop.
                const removed = Array.from(selectedSet)
                for (const v of removed) onToggle(v)
            })
            head.append(clearBtn)
            panel.append(head)

            bodyEl = document.createElement("div")
            bodyEl.style.cssText = "flex:1 1 auto;overflow:auto;padding:4px 0;"
            panel.append(bodyEl)

            wrap.append(panel)
            redraw()
            if (restore && typeof restore.scrollTop === "number") {
                bodyEl.scrollTop = restore.scrollTop
            }
            // Defer the dismiss handlers so the same click that opened the
            // panel doesn't immediately close it.
            setTimeout(() => {
                onDocClick = (e) => {
                    if (!panel) return
                    if (panel.contains(e.target) || btn.contains(e.target)) return
                    close()
                }
                onKeydown = (e) => { if (e.key === "Escape") close() }
                document.addEventListener("click", onDocClick, true)
                document.addEventListener("keydown", onKeydown)
            }, 0)
        }

        btn.addEventListener("click", (e) => {
            e.stopPropagation()
            if (panel) close(); else open()
        })

        // Render-driven re-open: filter-chips.render() invokes this when
        // it finds a matching `_pendingOpen.key` after a state change.
        btn._aesOpen = open

        return wrap
    }

    static _toggleSet(state, key, value, cb) {
        if (!(state[key] instanceof Set)) state[key] = new Set()
        if (state[key].has(value)) state[key].delete(value)
        else state[key].add(value)
        cb.onChange(state)
    }

    static _toggleScalar(state, key, value, cb) {
        state[key] = (state[key] === value) ? null : value
        cb.onChange(state)
    }

    static _toggleBool(state, key, cb) {
        state[key] = !state[key]
        cb.onChange(state)
    }

    /**
     * Active-filter pill bar. Renders one pill per active selection across
     * every dimension (classes, age/cost brackets, categories, families,
     * manufacturers, types, booleans, free-text search). Each pill has an
     * × suffix that removes its selection on click. A "Clear all" button
     * appears on the right when ≥2 pills are active.
     *
     * No-op when nothing is active so a fresh panel doesn't waste a row.
     */
    static _pillBar(host, state, cb) {
        const pills = []

        for (const k of (state.classes || [])) {
            const cls = MarketPanelFilterChips.classChips().find(c => c.key === k)
            pills.push({label: cls ? cls.label : k,
                remove: () => MarketPanelFilterChips._toggleSet(state, "classes", k, cb)})
        }
        if (state.ageBracket) {
            const b = MarketPanelFilterChips.AGE_BRACKETS.find(b => b.key === state.ageBracket)
            if (b) pills.push({label: b.label,
                remove: () => MarketPanelFilterChips._toggleScalar(state, "ageBracket", state.ageBracket, cb)})
        }
        if (state.priceBracket) {
            const b = MarketPanelFilterChips.PRICE_BRACKETS.find(b => b.key === state.priceBracket)
            if (b) pills.push({label: b.label,
                remove: () => MarketPanelFilterChips._toggleScalar(state, "priceBracket", state.priceBracket, cb)})
        }
        for (const k of (state.categories || [])) {
            const c = MarketPanelFilterChips.CATEGORIES.find(c => c.key === k)
            pills.push({label: c ? c.label : k,
                remove: () => MarketPanelFilterChips._toggleSet(state, "categories", k, cb)})
        }
        for (const k of (state.manufacturers || [])) {
            pills.push({label: k,
                remove: () => MarketPanelFilterChips._toggleSet(state, "manufacturers", k, cb)})
        }
        for (const k of (state.families || [])) {
            pills.push({label: k,
                remove: () => MarketPanelFilterChips._toggleSet(state, "families", k, cb)})
        }
        for (const k of (state.types || [])) {
            pills.push({label: k,
                remove: () => MarketPanelFilterChips._toggleSet(state, "types", k, cb)})
        }
        if (state.fitsFleet) pills.push({label: "Fits fleet",
            remove: () => MarketPanelFilterChips._toggleBool(state, "fitsFleet", cb)})
        if (state.fitsCash) pills.push({label: "Fits cash",
            remove: () => MarketPanelFilterChips._toggleBool(state, "fitsCash", cb)})
        if (state.expiringSoon) pills.push({label: "Closing <6h",
            remove: () => MarketPanelFilterChips._toggleBool(state, "expiringSoon", cb)})
        if (state.hasHistory) pills.push({label: "Has $/seat history",
            remove: () => MarketPanelFilterChips._toggleBool(state, "hasHistory", cb)})
        const trimmedSearch = (state.search || "").trim()
        if (trimmedSearch) pills.push({
            label: "🔍 " + trimmedSearch,
            remove: () => { state.search = ""; cb.onChange(state) }
        })

        if (!pills.length) return null

        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;"
            + "padding:4px 0;border-bottom:1px dashed var(--aes-paper-rule);"
            + "margin-bottom:2px;"

        for (const p of pills) {
            const pill = document.createElement("button")
            pill.type = "button"
            pill.className = "aes-chip aes-chip--active"
            pill.title = "Remove this filter"
            pill.setAttribute("aria-label", "Remove filter: " + p.label)
            pill.style.cssText = "display:inline-flex;align-items:center;gap:4px;"
            pill.append(document.createTextNode(p.label))
            const x = document.createElement("span")
            x.textContent = "×"
            x.setAttribute("aria-hidden", "true")
            x.style.cssText = "font-weight:bold;opacity:0.75;"
            pill.append(x)
            pill.addEventListener("click", p.remove)
            row.append(pill)
        }

        if (pills.length >= 2) {
            const clear = document.createElement("button")
            clear.type = "button"
            clear.className = "aes-btn aes-btn--sm"
            clear.textContent = "Clear all"
            clear.style.cssText = "margin-left:auto;font-size:10px;flex:0 0 auto;"
            clear.addEventListener("click", () => MarketPanelFilterChips._clearAll(state, cb))
            row.append(clear)
        }

        host.append(row)
        return row
    }

    static _clearAll(state, cb) {
        if (state.classes)       state.classes.clear()
        if (state.categories)    state.categories.clear()
        if (state.families)      state.families.clear()
        if (state.manufacturers) state.manufacturers.clear()
        if (state.types)         state.types.clear()
        state.ageBracket   = null
        state.priceBracket = null
        state.fitsFleet    = false
        state.fitsCash     = false
        state.expiringSoon = false
        state.hasHistory   = false
        state.search       = ""
        cb.onChange(state)
    }

    /**
     * Live per-option counts for a multi-select dimension. Re-runs `apply`
     * with that dimension cleared from `state`, then tallies the matching
     * rows by their dimension field. The result is comparable across
     * options inside the dropdown — each option's count reads as "rows
     * you'd see if this were the only pick in this dimension, with every
     * other active filter still applied".
     *
     * Cheap: O(rows) per dimension, called three times per render.
     */
    static _countsFor(rows, state, leaseConfig, dimension) {
        const fieldByDim = {
            manufacturers: r => r.manufacturer    || "",
            families:      r => r.familyName      || "",
            types:         r => r.aircraftType    || "",
            categories:    r => r.familyCategory  || "other"
        }
        const get = fieldByDim[dimension]
        if (!get) return new Map()
        const stateNoD = Object.assign({}, state)
        stateNoD[dimension] = new Set()
        const subset = MarketPanelFilterChips.apply(rows, stateNoD, leaseConfig)
        const counts = new Map()
        for (const r of subset) {
            const v = get(r)
            counts.set(v, (counts.get(v) || 0) + 1)
        }
        return counts
    }

    /**
     * Apply the chip state to a row set. Returns the filtered + sorted
     * subset. Pure — does not mutate input rows or state. `leaseConfig`
     * is forwarded into the cost bracket so lease-only offers are
     * bracketed by their lease-contract value rather than dropped.
     */
    static apply(rows, state, leaseConfig) {
        const classes       = state.classes       instanceof Set ? state.classes       : null
        const categories    = state.categories    instanceof Set ? state.categories    : null
        const families      = state.families      instanceof Set ? state.families      : null
        const manufacturers = state.manufacturers instanceof Set ? state.manufacturers : null
        const types         = state.types         instanceof Set ? state.types         : null
        const ageBracket   = MarketPanelFilterChips.AGE_BRACKETS.find(b => b.key === state.ageBracket) || null
        const priceBracket = MarketPanelFilterChips.PRICE_BRACKETS.find(b => b.key === state.priceBracket) || null
        const search = (state.search || "").trim().toLowerCase()
        const filtered = rows.filter(r => {
            if (classes       && classes.size       && !classes.has(r.dealClass)) return false
            if (categories    && categories.size    && !categories.has(r.familyCategory || "other")) return false
            if (families      && families.size      && !families.has(r.familyName || "")) return false
            if (manufacturers && manufacturers.size && !manufacturers.has(r.manufacturer || "")) return false
            if (types         && types.size         && !types.has(r.aircraftType || "")) return false
            if (ageBracket && !ageBracket.test(numOrNullChip(r.ageYears))) return false
            if (priceBracket && !priceBracket.test(MarketPanelFilterChips._effectiveCost(r, leaseConfig))) return false
            if (state.fitsFleet && !r.fleetOwned) return false
            // affordFits is decorated `true` when cash is unknown (graceful
            // degrade), so this check only filters when cost > known cash.
            if (state.fitsCash && r.affordFits === false) return false
            if (state.expiringSoon) {
                const ms = numOrNullChip(r.bidIntervalMs)
                if (ms === null || ms < 0 || ms > 6 * 60 * 60 * 1000) return false
            }
            if (state.hasHistory) {
                const hist = r.dealBreakdown && r.dealBreakdown.find(c => c.field === "pricePerSeat")
                if (!hist || hist.source !== "history") return false
            }
            if (search) {
                const haystack = [
                    r.aircraftType, r.familyName, r.familyCategory, r.manufacturer,
                    r.registration, r.owner, r.location
                ].filter(Boolean).join(" ").toLowerCase()
                if (haystack.indexOf(search) === -1) return false
            }
            return true
        })
        const sort = MarketPanelFilterChips.lookupSort(state.sort)
        filtered.sort((a, b) => {
            const va = numOrNullChip(a[sort.field])
            const vb = numOrNullChip(b[sort.field])
            if (va === null && vb === null) return 0
            if (va === null) return 1
            if (vb === null) return -1
            return (va - vb) * sort.dir
        })
        return filtered
    }

    /**
     * Lease-aware cost for the bracket filter. Returns the effective
     * acquisition cost from `MarketScanDealMetrics.effectiveAcquisitionCost`
     * (lease total = monthly × termMonths in lease mode, else purchase
     * price). Falls back to purchase-only when the metrics module isn't
     * loaded so legacy bundles don't crash.
     */
    static _effectiveCost(row, leaseConfig) {
        if (typeof MarketScanDealMetrics === "undefined") return null
        if (typeof MarketScanDealMetrics.effectiveAcquisitionCost === "function") {
            const eff = MarketScanDealMetrics.effectiveAcquisitionCost(row, leaseConfig)
            return eff ? eff.cost : null
        }
        return MarketScanDealMetrics.acquisitionPrice(row)
    }
}

function numOrNullChip(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelFilterChips
