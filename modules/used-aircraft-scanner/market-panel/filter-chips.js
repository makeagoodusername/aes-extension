/**
 * Filter chip bar + sort dropdown for the in-page panel. Multi-select chips
 * (deal class, age bracket, price bracket, special toggles) plus a free-text
 * search input. Reactive: every change calls cb.onChange(state) which the
 * panel debounces into a re-filter+render.
 *
 * State lives on the panel; this module renders against the supplied
 * `state` object and surfaces toggles. Pure rendering — no internal state.
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

    static SORT_OPTIONS = [
        {key: "score-desc",        label: "Score ↓",      field: "dealScore",     dir: -1},
        {key: "pricePerSeat-asc",  label: "$/seat ↑",     field: "pricePerSeat",  dir: 1},
        {key: "ageYears-asc",      label: "Age ↑",        field: "ageYears",      dir: 1},
        {key: "conditionPct-desc", label: "Condition ↓",  field: "conditionPct",  dir: -1},
        {key: "bidIntervalMs-asc", label: "Closing soon", field: "bidIntervalMs", dir: 1},
        {key: "nextBid-asc",       label: "Next bid ↑",   field: "nextBid",       dir: 1}
    ]

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

    static render(host, state, cb) {
        host.innerHTML = ""
        host.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:6px;"
            + "background:var(--aes-bone);border-bottom:1px solid var(--aes-paper-rule);"

        host.append(MarketPanelFilterChips._row(
            MarketPanelFilterChips.classChips().map(c => MarketPanelFilterChips._chip(
                c.label,
                state.classes && state.classes.has(c.key),
                () => MarketPanelFilterChips._toggleSet(state, "classes", c.key, cb)
            ))
        ))

        host.append(MarketPanelFilterChips._row(
            MarketPanelFilterChips.AGE_BRACKETS.map(b => MarketPanelFilterChips._chip(
                b.label,
                state.ageBracket === b.key,
                () => MarketPanelFilterChips._toggleScalar(state, "ageBracket", b.key, cb)
            ))
        ))

        host.append(MarketPanelFilterChips._row(
            MarketPanelFilterChips.PRICE_BRACKETS.map(b => MarketPanelFilterChips._chip(
                b.label,
                state.priceBracket === b.key,
                () => MarketPanelFilterChips._toggleScalar(state, "priceBracket", b.key, cb)
            ))
        ))

        host.append(MarketPanelFilterChips._row([
            MarketPanelFilterChips._chip("Fits fleet", !!state.fitsFleet,
                () => MarketPanelFilterChips._toggleBool(state, "fitsFleet", cb)),
            MarketPanelFilterChips._chip("Closing <6h", !!state.expiringSoon,
                () => MarketPanelFilterChips._toggleBool(state, "expiringSoon", cb)),
            MarketPanelFilterChips._chip("Has $/seat history", !!state.hasHistory,
                () => MarketPanelFilterChips._toggleBool(state, "hasHistory", cb))
        ]))

        const lastRow = document.createElement("div")
        lastRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;"
        const search = document.createElement("input")
        search.type = "search"
        search.className = "aes-input"
        search.placeholder = "Search type / reg / owner / location"
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
    }

    static _row(children) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
        for (const c of children) row.append(c)
        return row
    }

    static _chip(label, active, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.className = "aes-chip" + (active ? " aes-chip--active" : "")
        b.addEventListener("click", onClick)
        return b
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
     * Apply the chip state to a row set. Returns the filtered + sorted
     * subset. Pure — does not mutate input rows or state.
     */
    static apply(rows, state) {
        const classes = state.classes instanceof Set ? state.classes : null
        const ageBracket = MarketPanelFilterChips.AGE_BRACKETS.find(b => b.key === state.ageBracket) || null
        const priceBracket = MarketPanelFilterChips.PRICE_BRACKETS.find(b => b.key === state.priceBracket) || null
        const search = (state.search || "").trim().toLowerCase()
        const filtered = rows.filter(r => {
            if (classes && classes.size && !classes.has(r.dealClass)) return false
            if (ageBracket && !ageBracket.test(numOrNullChip(r.ageYears))) return false
            if (priceBracket && !priceBracket.test(MarketPanelFilterChips._acqPrice(r))) return false
            if (state.fitsFleet && !r.fleetOwned) return false
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
                    r.aircraftType, r.familyName, r.registration, r.owner, r.location
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

    static _acqPrice(r) {
        return MarketScanDealMetrics.acquisitionPrice(r)
    }
}

function numOrNullChip(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelFilterChips
