"use strict"

/**
 * Drill-down aircraft type picker for the Used Aircraft Scanner.
 *
 * Layout (top → bottom):
 *   1. Selected chips strip — removable per-type chips, color-coded by family
 *      category, "Clear all" affordance, and a "+N more" overflow chip that
 *      scrolls to the first selected family disclosure.
 *   2. Category filter row — chips for All / Commuter / Turboprop / Regional /
 *      Narrowbody / Widebody / Custom, plus "Select all in view" / "Clear view"
 *      that operate on whatever's currently visible.
 *   3. Search + custom-add row — search filter on the left, custom AS-label
 *      adder on the right.
 *   4. Summary — count + ETA.
 *   5. Per-family disclosures — one collapsible row per family in scope. Click
 *      to expand/collapse the type checklist. Auto-expand on search; auto-
 *      expand families with selections after setSelectedTypes when there are
 *      fewer than `AUTO_EXPAND_LIMIT` of them (so a typical preset opens its
 *      relevant families pre-expanded without flooding the panel).
 *
 * Public API (unchanged from prior version):
 *   const grid = new MarketScanFamilyGrid(targetEl, {
 *       onChange:    (types) => { ... },
 *       concurrency: 6,        // for scan-time estimate (optional)
 *       staggerMs:   2000      // for scan-time estimate (optional)
 *   })
 *   grid.setSelectedTypes(["Airbus A320-200", ...])  // load from preset
 *   grid.getSelectedTypes()  → ["Airbus A320-200", ...]
 *   grid.setScanParams(concurrency, staggerMs)       // live-update estimate
 *
 * Single instance is created once by the dashboard and reused across preset
 * switches — switch-time state (active category, expanded families, search)
 * is intentionally in-memory only, scoped to the panel session.
 */

const MARKETSCAN_AUTO_EXPAND_LIMIT = 4
const MARKETSCAN_CHIP_OVERFLOW     = 12

// Real categories from TypeFamilyMap, in display order. "all" / "custom" are
// meta-filters added separately when the chip row is built.
const MARKETSCAN_CATEGORIES = ["commuter", "turboprop", "regional", "narrowbody", "widebody"]

class MarketScanFamilyGrid {
    constructor(targetEl, options) {
        this.target      = targetEl
        this.onChange    = (options && options.onChange) || function() {}
        this.concurrency = (options && options.concurrency) || 6
        this.staggerMs   = (options && options.staggerMs) || 2000

        this.selected         = new Set()    // selected AS labels
        this.customTypes      = []           // labels not in TypeFamilyMap
        this.searchQuery      = ""
        this.activeCategory   = "all"        // all | <category> | custom
        this.expandedFamilies = new Set()    // family-name → expanded

        this._overrides  = (options && options.typeFamilyOverrides) || null
        this._index      = TypeFamilyMap.familyList(this._overrides)
        this._knownTypes = this._buildKnownTypeMap()

        // Cached element refs populated in _draw(); section refreshers read
        // these so we can update sub-regions without rebuilding the entire
        // panel on every checkbox tick.
        this._chipsEl    = null
        this._catBtns    = {}
        this._summaryEl  = null
        this._listEl     = null

        this._draw()
    }

    /**
     * Replace the selected set from a preset's `types` array. Custom types
     * (labels not present in TypeFamilyMap) are tracked in this.customTypes
     * so they survive a load/save cycle and stay tickable in the Custom card.
     *
     * Auto-expands the disclosures of families with selections — but only when
     * there are few enough (< AUTO_EXPAND_LIMIT) that the panel doesn't flood.
     * Larger presets stay collapsed and lean on the chips strip for context.
     */
    setSelectedTypes(types) {
        const next = new Set()
        const unknown = []
        for (const raw of types || []) {
            const t = String(raw || "").trim()
            if (!t) continue
            next.add(t)
            if (!this._knownTypes.has(t)) unknown.push(t)
        }
        this.selected    = next
        this.customTypes = Array.from(new Set(unknown)).sort()

        const familiesWithSelections = new Set()
        for (const fam of this._index) {
            if (fam.types.some(t => this.selected.has(t))) {
                familiesWithSelections.add(fam.family)
            }
        }
        if (this.customTypes.length) familiesWithSelections.add("Custom")

        this.expandedFamilies = (familiesWithSelections.size > 0
            && familiesWithSelections.size < MARKETSCAN_AUTO_EXPAND_LIMIT)
            ? familiesWithSelections
            : new Set()

        this._draw()
    }

    getSelectedTypes() {
        return Array.from(this.selected)
    }

    /**
     * Live-update the scan-time estimate when the user changes concurrency /
     * stagger in the dashboard's Advanced settings.
     */
    setScanParams(concurrency, staggerMs) {
        this.concurrency = concurrency || this.concurrency
        this.staggerMs   = staggerMs   || this.staggerMs
        this._refreshSummary()
    }

    // ---------- internals ----------

    _buildKnownTypeMap() {
        const out = new Map()
        for (const fam of this._index) {
            for (const t of fam.types) out.set(t, fam.family)
        }
        return out
    }

    _draw() {
        this.target.innerHTML = ""
        const wrap = document.createElement("div")
        wrap.style.fontSize = "90%"

        this._chipsEl   = this._buildChipsContainer()
        const catRow    = this._buildCategoryRow()
        const searchRow = this._buildSearchRow()
        this._summaryEl = this._buildSummaryEl()
        this._listEl    = this._buildListContainer()

        wrap.append(this._chipsEl, catRow, searchRow, this._summaryEl, this._listEl)
        this.target.append(wrap)

        this._refreshChips()
        this._refreshCategoryActive()
        this._refreshSummary()
        this._refreshFamilyList()
    }

    // ---------- chips strip ----------

    _buildChipsContainer() {
        const row = document.createElement("div")
        Object.assign(row.style, {
            display:      "flex",
            flexWrap:     "wrap",
            gap:          "4px",
            alignItems:   "center",
            padding:      "8px 10px",
            border:       "1px solid #ddd",
            borderRadius: "4px",
            background:   "#fafafa",
            minHeight:    "42px",
            marginBottom: "8px"
        })
        return row
    }

    _refreshChips() {
        const row = this._chipsEl
        if (!row) return
        row.innerHTML = ""

        if (!this.selected.size) {
            const empty = document.createElement("span")
            empty.style.color = "#888"
            empty.style.fontStyle = "italic"
            empty.innerText = "No types selected — pick a category below to drill in."
            row.append(empty)
            return
        }

        // Group by family in display order so chips of the same family sit
        // together and inherit the same color rail.
        const familyOrder = this._index.map(f => f.family).concat(["Custom"])
        const grouped = {}
        for (const t of this.selected) {
            const fam = this._familyForType(t) || "Custom"
            if (!grouped[fam]) grouped[fam] = []
            grouped[fam].push(t)
        }

        const flat = []
        for (const fam of familyOrder) {
            const list = grouped[fam]
            if (!list || !list.length) continue
            list.sort()
            for (const t of list) flat.push({type: t, family: fam})
        }

        const visible = flat.slice(0, MARKETSCAN_CHIP_OVERFLOW)
        for (const c of visible) {
            const cat   = c.family === "Custom" ? "other" : TypeFamilyMap.category(c.family)
            const color = TypeFamilyMap.categoryColor(cat)
            row.append(this._buildChip(c.type, color))
        }

        if (flat.length > MARKETSCAN_CHIP_OVERFLOW) {
            const overflow = flat.length - MARKETSCAN_CHIP_OVERFLOW
            const firstHidden = flat[MARKETSCAN_CHIP_OVERFLOW]
            const moreBtn = document.createElement("button")
            moreBtn.type = "button"
            moreBtn.className = "btn btn-default btn-xs"
            moreBtn.innerText = "+" + overflow + " more"
            moreBtn.title = "Scroll to the first hidden selection"
            moreBtn.addEventListener("click", () => {
                if (firstHidden && firstHidden.family) {
                    this.expandedFamilies.add(firstHidden.family)
                    this._refreshFamilyList()
                    const target = this._listEl.querySelector(
                        '[data-family="' + cssEscape(firstHidden.family) + '"]')
                    if (target && target.scrollIntoView) {
                        target.scrollIntoView({block: "nearest"})
                    }
                }
            })
            row.append(moreBtn)
        }

        const spacer = document.createElement("span")
        spacer.style.flex = "1"
        row.append(spacer)

        const clearBtn = document.createElement("button")
        clearBtn.type = "button"
        clearBtn.className = "btn btn-default btn-xs"
        clearBtn.innerText = "Clear all"
        clearBtn.addEventListener("click", () => {
            this.selected = new Set()
            this._refreshAll()
            this._fire()
        })
        row.append(clearBtn)
    }

    _buildChip(type, color) {
        const chip = document.createElement("span")
        Object.assign(chip.style, {
            display:        "inline-flex",
            alignItems:     "center",
            gap:            "4px",
            padding:        "2px 4px 2px 8px",
            background:     "#fff",
            border:         "1px solid " + color,
            borderLeft:     "4px solid " + color,
            borderRadius:   "3px",
            fontSize:       "85%"
        })
        const label = document.createElement("span")
        label.innerText = type
        const x = document.createElement("button")
        x.type = "button"
        x.innerText = "×"
        x.title = "Remove " + type
        x.setAttribute("aria-label", "Remove " + type)
        Object.assign(x.style, {
            border:     "none",
            background: "transparent",
            cursor:     "pointer",
            fontWeight: "bold",
            fontSize:   "120%",
            padding:    "0 2px",
            lineHeight: "1",
            color:      color
        })
        x.addEventListener("click", () => {
            this.selected.delete(type)
            this._refreshAll()
            this._fire()
        })
        chip.append(label, x)
        return chip
    }

    // ---------- category filter row ----------

    _buildCategoryRow() {
        const row = document.createElement("div")
        Object.assign(row.style, {
            display:      "flex",
            flexWrap:     "wrap",
            gap:          "4px",
            alignItems:   "center",
            marginBottom: "8px"
        })

        const cats = [{key: "all", label: "All", color: "#555"}]
        for (const cat of MARKETSCAN_CATEGORIES) {
            cats.push({
                key:   cat,
                label: cat[0].toUpperCase() + cat.slice(1),
                color: TypeFamilyMap.categoryColor(cat)
            })
        }
        cats.push({key: "custom", label: "Custom", color: TypeFamilyMap.categoryColor("other")})

        this._catBtns = {}
        for (const c of cats) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.dataset.cat = c.key
            Object.assign(btn.style, {
                padding:      "4px 10px",
                border:       "1px solid " + c.color,
                borderLeft:   "4px solid " + c.color,
                borderRadius: "3px",
                background:   "#fff",
                cursor:       "pointer",
                fontSize:     "85%",
                fontWeight:   "500"
            })
            btn.innerText = c.label
            btn.addEventListener("click", () => {
                this.activeCategory = c.key
                this._refreshCategoryActive()
                this._refreshFamilyList()
            })
            row.append(btn)
            this._catBtns[c.key] = btn
        }

        const spacer = document.createElement("span")
        spacer.style.flex = "1"
        row.append(spacer)

        const selAllBtn = document.createElement("button")
        selAllBtn.type = "button"
        selAllBtn.className = "btn btn-default btn-xs"
        selAllBtn.innerText = "Select all in view"
        selAllBtn.addEventListener("click", () => {
            for (const fam of this._visibleFamilies()) {
                for (const t of fam.types) this.selected.add(t)
            }
            this._refreshAll()
            this._fire()
        })

        const clrViewBtn = document.createElement("button")
        clrViewBtn.type = "button"
        clrViewBtn.className = "btn btn-default btn-xs"
        clrViewBtn.innerText = "Clear view"
        clrViewBtn.addEventListener("click", () => {
            for (const fam of this._visibleFamilies()) {
                for (const t of fam.types) this.selected.delete(t)
            }
            this._refreshAll()
            this._fire()
        })

        row.append(selAllBtn, clrViewBtn)
        return row
    }

    _refreshCategoryActive() {
        for (const k in this._catBtns) {
            const btn = this._catBtns[k]
            if (k === this.activeCategory) {
                btn.style.background = "#e6effd"
                btn.style.fontWeight = "700"
            } else {
                btn.style.background = "#fff"
                btn.style.fontWeight = "500"
            }
        }
    }

    // ---------- search + custom-add ----------

    _buildSearchRow() {
        const row = document.createElement("div")
        Object.assign(row.style, {
            display:      "flex",
            gap:          "6px",
            alignItems:   "center",
            marginBottom: "6px",
            flexWrap:     "wrap"
        })

        const search = document.createElement("input")
        search.type        = "search"
        search.className   = "form-control input-sm"
        search.placeholder = "Filter types or families…"
        search.style.maxWidth = "260px"
        search.value = this.searchQuery
        search.addEventListener("input", () => {
            this.searchQuery = search.value || ""
            this._refreshFamilyList()
        })
        row.append(search)

        const spacer = document.createElement("span")
        spacer.style.flex = "1"
        row.append(spacer)

        const customInput = document.createElement("input")
        customInput.type        = "text"
        customInput.className   = "form-control input-sm"
        customInput.placeholder = "Custom type label (exact AS dropdown text)"
        customInput.style.maxWidth = "260px"

        const customBtn = document.createElement("button")
        customBtn.type = "button"
        customBtn.className = "btn btn-default btn-xs"
        customBtn.innerText = "Add custom"

        const commit = () => {
            const label = (customInput.value || "").trim()
            if (!label) return
            if (!this.customTypes.includes(label)) {
                this.customTypes = this.customTypes.concat([label]).sort()
            }
            this.selected.add(label)
            customInput.value = ""
            // Make the new chip discoverable: jump to Custom view + expand it.
            this.activeCategory = "custom"
            this.expandedFamilies.add("Custom")
            this._refreshAll()
            this._fire()
        }
        customBtn.addEventListener("click", commit)
        customInput.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); commit() }
        })

        row.append(customInput, customBtn)
        return row
    }

    // ---------- summary ----------

    _buildSummaryEl() {
        const el = document.createElement("div")
        Object.assign(el.style, {
            margin: "4px 0 8px 0",
            color:  "#555"
        })
        return el
    }

    _refreshSummary() {
        if (!this._summaryEl) return
        const total = this.selected.size
        if (total === 0) {
            this._summaryEl.innerText = "No types selected."
            return
        }
        const noun = total === 1 ? "type" : "types"
        const eta  = this._estimateScanSeconds(total)
        this._summaryEl.innerText = total + " " + noun + " selected · ~"
            + this._formatEta(eta) + " est. scan time"
    }

    // ---------- per-family disclosures ----------

    _buildListContainer() {
        const el = document.createElement("div")
        Object.assign(el.style, {
            display:        "flex",
            flexDirection:  "column",
            gap:            "4px",
            maxHeight:      "440px",
            overflow:       "auto",
            border:         "1px solid #ddd",
            borderRadius:   "4px",
            padding:        "6px",
            background:     "#fff"
        })
        return el
    }

    /**
     * Compute the family-row records to render given current category +
     * search. Each record is the TypeFamilyMap entry plus a `visibleTypes`
     * array containing only types matching the search (or the full list when
     * the family-name itself matches).
     */
    _visibleFamilies() {
        const q = (this.searchQuery || "").trim().toLowerCase()
        const matches = (text) => !q || (text || "").toLowerCase().indexOf(q) !== -1
        const out = []

        if (this.activeCategory !== "custom") {
            for (const fam of this._index) {
                if (this.activeCategory !== "all" && fam.category !== this.activeCategory) continue
                const familyMatches = matches(fam.family)
                const visibleTypes = familyMatches ? fam.types.slice() : fam.types.filter(matches)
                if (q && !familyMatches && !visibleTypes.length) continue
                out.push({
                    family:       fam.family,
                    category:     fam.category,
                    types:        fam.types.slice(),
                    visibleTypes: visibleTypes
                })
            }
        }

        if ((this.activeCategory === "custom" || this.activeCategory === "all") && this.customTypes.length) {
            const customMatches = matches("custom")
            const visibleCustom = customMatches ? this.customTypes.slice() : this.customTypes.filter(matches)
            if (!q || customMatches || visibleCustom.length) {
                out.push({
                    family:       "Custom",
                    category:     "other",
                    types:        this.customTypes.slice(),
                    visibleTypes: visibleCustom
                })
            }
        }
        return out
    }

    _refreshFamilyList() {
        const el = this._listEl
        if (!el) return
        el.innerHTML = ""

        const families = this._visibleFamilies()
        if (!families.length) {
            const empty = document.createElement("p")
            empty.className = "warning"
            empty.style.margin = "6px 8px"
            empty.innerText = this.activeCategory === "custom"
                ? "No custom types yet. Add one with the field above."
                : "No families match the current filter."
            el.append(empty)
            return
        }

        // Force-expand all matching families when the user is searching —
        // otherwise the search results would be hidden behind closed carets.
        const autoExpand = !!(this.searchQuery && this.searchQuery.trim())
        for (const fam of families) {
            el.append(this._buildFamilyRow(fam, autoExpand))
        }
    }

    _buildFamilyRow(fam, autoExpand) {
        const color    = TypeFamilyMap.categoryColor(fam.category)
        const expanded = autoExpand || this.expandedFamilies.has(fam.family)

        const row = document.createElement("div")
        row.dataset.family = fam.family
        Object.assign(row.style, {
            border:       "1px solid #ddd",
            borderLeft:   "4px solid " + color,
            borderRadius: "3px",
            background:   "#fafafa"
        })

        // ----- header (clickable area; All/Clear buttons stop-propagate) -----
        const head = document.createElement("div")
        Object.assign(head.style, {
            display:    "flex",
            alignItems: "center",
            gap:        "8px",
            padding:    "6px 10px",
            cursor:     "pointer",
            userSelect: "none"
        })

        const caret = document.createElement("span")
        caret.innerText = expanded ? "▾" : "▸"
        caret.style.color = color
        caret.style.fontWeight = "bold"
        caret.style.width = "1em"
        caret.style.textAlign = "center"

        const title = document.createElement("span")
        title.innerText = fam.family
        title.style.fontWeight = "600"
        title.style.color = "#333"

        const count = document.createElement("span")
        const sel = fam.types.reduce((n, t) => this.selected.has(t) ? n + 1 : n, 0)
        count.innerText = sel + "/" + fam.types.length
        count.style.fontSize = "85%"
        count.style.color = sel > 0 ? color : "#888"
        count.style.fontWeight = sel > 0 ? "600" : "normal"

        const fitPillHost = document.createElement("span")
        fitPillHost.style.cssText = "display:inline-flex;align-items:center"
        if (window.AesCanopyDnaFit && window.AesCanopyDnaStore) {
            this._attachFamilyDnaFitPill(fitPillHost, fam)
        }

        const spacer = document.createElement("span")
        spacer.style.flex = "1"

        const allBtn = document.createElement("button")
        allBtn.type = "button"
        allBtn.className = "btn btn-default btn-xs"
        allBtn.innerText = "All"
        allBtn.addEventListener("click", e => {
            e.stopPropagation()
            for (const t of fam.types) this.selected.add(t)
            this._refreshAll()
            this._fire()
        })

        const clrBtn = document.createElement("button")
        clrBtn.type = "button"
        clrBtn.className = "btn btn-default btn-xs"
        clrBtn.innerText = "Clear"
        clrBtn.addEventListener("click", e => {
            e.stopPropagation()
            for (const t of fam.types) this.selected.delete(t)
            this._refreshAll()
            this._fire()
        })

        head.append(caret, title, count, fitPillHost, spacer, allBtn, clrBtn)
        head.addEventListener("click", () => {
            if (this.expandedFamilies.has(fam.family)) {
                this.expandedFamilies.delete(fam.family)
            } else {
                this.expandedFamilies.add(fam.family)
            }
            this._refreshFamilyList()
        })
        row.append(head)

        // ----- body (only built when expanded; checkbox handlers update count
        // + chips + summary in place so we don't redraw the whole list on
        // every tick, which would lose user scroll position) -----
        if (expanded) {
            const body = document.createElement("div")
            Object.assign(body.style, {
                display:             "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap:                 "2px 12px",
                padding:             "0 10px 10px 28px"
            })
            for (const t of fam.visibleTypes) {
                const lab = document.createElement("label")
                Object.assign(lab.style, {
                    display:    "flex",
                    alignItems: "center",
                    gap:        "6px",
                    cursor:     "pointer",
                    fontWeight: "normal",
                    margin:     "0"
                })
                const cb = document.createElement("input")
                cb.type    = "checkbox"
                cb.checked = this.selected.has(t)
                cb.addEventListener("change", () => {
                    if (cb.checked) this.selected.add(t)
                    else this.selected.delete(t)
                    const newSel = fam.types.reduce((n, x) => this.selected.has(x) ? n + 1 : n, 0)
                    count.innerText = newSel + "/" + fam.types.length
                    count.style.color = newSel > 0 ? color : "#888"
                    count.style.fontWeight = newSel > 0 ? "600" : "normal"
                    this._refreshChips()
                    this._refreshSummary()
                    this._fire()
                })
                const span = document.createElement("span")
                span.innerText = t
                lab.append(cb, span)
                body.append(lab)
            }
            row.append(body)
        }

        return row
    }

    // ---------- helpers ----------

    _familyForType(type) {
        return this._knownTypes.get(type) || null
    }

    _refreshAll() {
        this._refreshChips()
        this._refreshSummary()
        this._refreshFamilyList()
    }

    _estimateScanSeconds(n) {
        if (n <= 0) return 0
        const perTabSec = 12
        const waves = Math.ceil(n / Math.max(1, this.concurrency))
        const launchOverheadSec = Math.max(0, n - 1) * (this.staggerMs / 1000)
        return Math.round(waves * perTabSec + launchOverheadSec)
    }

    _formatEta(seconds) {
        if (seconds < 60) return seconds + "s"
        const m = Math.floor(seconds / 60)
        const s = seconds % 60
        return s ? m + "m " + s + "s" : m + "m"
    }

    _fire() {
        try { this.onChange(this.getSelectedTypes()) }
        catch (e) { console.error("MarketScanFamilyGrid onChange error:", e) }
    }

    /**
     * Score the family against the global DNA template (per-account picker
     * deferred to L8) and append a fit pill to `host`. Best-effort — silent
     * on missing DNA stack or if scoring throws.
     */
    async _attachFamilyDnaFitPill(host, fam) {
        try {
            if (!MarketScanFamilyGrid._dnaTemplatePromise) {
                MarketScanFamilyGrid._dnaTemplatePromise = window.AesCanopyDnaStore.loadTemplate()
            }
            const dna = await MarketScanFamilyGrid._dnaTemplatePromise
            const candidate = {
                manufacturer: fam.family,
                sizeClass:    _famCategoryToSize(fam.category),
                isCargo:      false
            }
            const result = window.AesCanopyDnaFit.dnaFitScoreAircraft(dna, candidate)
            window.AesCanopyDnaFit.renderInto(host, result, {label: "Family fit vs DNA template"})
        } catch (_) {}
    }
}

function _famCategoryToSize(cat) {
    if (cat === "widebody") return "widebody"
    if (cat === "narrowbody") return "narrowbody"
    return "regional"
}

// CSS.escape isn't safe to assume in older Chromium; this fallback handles
// the family-name characters we actually emit (slashes, spaces, parens).
function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value)
    return String(value).replace(/["\\]/g, "\\$&")
}
