"use strict"

/**
 * Bulk "open stations" modal launched from the Schedule Management panel.
 *
 * Aggregates airports the user has already surfaced through other modules:
 *   - Top routes      (routeAssistant:topRoutes — last Route Assistant render)
 *   - Watchlist       (routeAssistant:watchlist — starred routes)
 *   - FlightsFrom     (flightsFrom:<IATA>.routes[].destIata — real-world destinations)
 *   - Demand store    (routeAssistant:demand:<IATA> — pax/cargo above thresholds)
 *
 * Multiple sources hitting the same IATA stack into a single row whose source
 * chips reveal the overlap. The user reviews, optionally toggles airports
 * off, and confirms — the modal then groups by country and writes one
 * StationAutomationStorage queue entry per country, each carrying an
 * `airportWhitelist` so the worker only opens the chosen airports (thresholds
 * are bypassed).
 *
 * Existing stations the airline already operates are filtered out before the
 * list renders, so the user never sees noise from a partial earlier run.
 */
class OpenStationsModal {
    static SOURCE_LABELS = {
        demand: {label: "demand", color: "#3b82f6"},
        ff:     {label: "ff",     color: "#10b981"},
        watch:  {label: "watch",  color: "#f59e0b"},
        top:    {label: "top",    color: "#a855f7"},
    }

    constructor({server, airlineCode, currentHub} = {}) {
        if (!server || !airlineCode) {
            throw new Error("OpenStationsModal: server + airlineCode required")
        }
        this.server      = server
        this.airlineCode = airlineCode
        this.currentHub  = currentHub ? String(currentHub).toUpperCase() : null

        this._overlay   = null
        this._body      = null
        this._footer    = null
        this._candidates = new Map()    // IATA → candidate record
        this._countries  = new Map()    // countryId → {name, code}
        this._selected   = new Set()    // IATA values
        this._collapsed  = new Set()    // countryId values
        this._existingIatas = new Set()
        this._hiddenExisting = 0
        this._resolveOpen = null

        this._filters = {
            useDemand:    true,
            useFf:        true,
            useWatch:     true,
            useTop:       true,
            paxMin:       5,
            cargoMin:     0,
            currentHubOnlyWatch: !!this.currentHub,
            hideExisting: true,
        }
    }

    open() {
        this._buildOverlay()
        this._setStatus("Loading scraped airports…")
        this._refresh().catch(err => {
            console.error("[AES OpenStationsModal] open failed", err)
            this._setStatus("Failed to load: " + (err && err.message || err), "bad")
        })
        return new Promise(resolve => { this._resolveOpen = resolve })
    }

    // ---------- Aggregation ----------

    async _refresh() {
        this._candidates = new Map()
        this._selected = new Set()

        await this._ensureCountriesCache()

        const [topRoutes, watchMap, ffList, demandRecords, existingIatas] = await Promise.all([
            this._loadTopRoutes(),
            this._filters.useWatch  ? RouteAssistantWatchlistStore.loadAll() : Promise.resolve(new Map()),
            this._filters.useFf     ? FlightsFromStore.listAirports()        : Promise.resolve([]),
            this._filters.useDemand ? this._loadDemandRecords()              : Promise.resolve([]),
            CountryScraper.loadExistingStationIatas(this.server).catch(() => new Set()),
        ])
        this._existingIatas = existingIatas || new Set()

        if (this._filters.useTop && topRoutes && topRoutes.rows) {
            for (const r of topRoutes.rows) {
                if (!r || !r.destIata) continue
                this._addCandidate(r.destIata, "top", {
                    name:       r.destName || null,
                    paxScore:   typeof r.paxScore   === "number" ? r.paxScore   : null,
                    cargoScore: typeof r.cargoScore === "number" ? r.cargoScore : null,
                })
            }
        }

        if (this._filters.useWatch) {
            for (const key of watchMap.keys()) {
                const dash = key.indexOf("-")
                if (dash <= 0) continue
                const hub  = key.slice(0, dash).toUpperCase()
                const dest = key.slice(dash + 1).toUpperCase()
                if (!/^[A-Z]{3}$/.test(dest)) continue
                if (this._filters.currentHubOnlyWatch && this.currentHub && hub !== this.currentHub) continue
                this._addCandidate(dest, "watch", {})
            }
        }

        if (this._filters.useFf) {
            const hubs = ffList.map(a => a.iata).filter(Boolean)
            const records = await Promise.all(hubs.map(iata =>
                FlightsFromStore.loadAirport(iata).catch(() => null)
            ))
            for (const rec of records) {
                if (!rec || !rec.routes) continue
                for (const r of rec.routes) {
                    if (!r || !r.destIata) continue
                    this._addCandidate(r.destIata, "ff", {})
                }
            }
        }

        if (this._filters.useDemand) {
            for (const rec of demandRecords) {
                if (!rec || !rec.iata) continue
                const pax = typeof rec.paxScore === "number" ? rec.paxScore : 0
                const cargo = typeof rec.cargoScore === "number" ? rec.cargoScore : 0
                if (pax < this._filters.paxMin) continue
                if (cargo < this._filters.cargoMin) continue
                this._addCandidate(rec.iata, "demand", {
                    name:       rec.name      || null,
                    airportId:  rec.airportId || null,
                    countryId:  rec.countryId || null,
                    paxScore:   typeof rec.paxScore   === "number" ? rec.paxScore   : null,
                    cargoScore: typeof rec.cargoScore === "number" ? rec.cargoScore : null,
                })
            }
        }

        await this._resolveMissing()
        await this._loadDistances()

        this._hiddenExisting = this._applyExistingFilter()
        this._renderBody()
        this._renderFooter()
    }

    _addCandidate(iata, source, fields) {
        iata = String(iata || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(iata)) return
        let c = this._candidates.get(iata)
        if (!c) {
            c = {iata, sources: new Set(), name: null,
                 airportId: null, countryId: null, paxScore: null, cargoScore: null,
                 unresolved: false}
            this._candidates.set(iata, c)
        }
        c.sources.add(source)
        if (fields.name      && !c.name)      c.name      = fields.name
        if (fields.airportId && !c.airportId) c.airportId = fields.airportId
        if (fields.countryId && !c.countryId) c.countryId = fields.countryId
        if (fields.paxScore   != null && c.paxScore   == null) c.paxScore   = fields.paxScore
        if (fields.cargoScore != null && c.cargoScore == null) c.cargoScore = fields.cargoScore
    }

    async _loadTopRoutes() {
        // L3 — account-scoped key first; legacy un-scoped key as fallback.
        const acctId = (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function")
            ? globalThis.AesAccountScopedKey.currentAccountIdSync() : null
        const legacyKey = "routeAssistant:topRoutes"
        const scopedKey = (acctId && globalThis.AesAccountScopedKey)
            ? globalThis.AesAccountScopedKey.acctKey(legacyKey, acctId)
            : legacyKey
        const reqKeys = scopedKey === legacyKey ? [scopedKey] : [scopedKey, legacyKey]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scopedKey] || out[legacyKey] || null
    }

    async _loadDemandRecords() {
        const all = await chrome.storage.local.get(null)
        const prefix = RouteAssistantDemandStore.KEY_PREFIX
        const out = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (rec && rec.iata) out.push(rec)
        }
        return out
    }

    async _resolveMissing() {
        const missing = []
        for (const c of this._candidates.values()) {
            if (!c.airportId || !c.countryId) missing.push(c.iata)
        }
        if (!missing.length) return
        const got = await RouteAssistantDemandStore.getMany(missing).catch(() => new Map())
        for (const iata of missing) {
            const rec = got.get(iata)
            const c = this._candidates.get(iata)
            if (!c) continue
            if (rec) {
                if (!c.name      && rec.name)      c.name      = rec.name
                if (!c.airportId && rec.airportId) c.airportId = rec.airportId
                if (!c.countryId && rec.countryId) c.countryId = rec.countryId
                if (c.paxScore   == null && typeof rec.paxScore   === "number") c.paxScore   = rec.paxScore
                if (c.cargoScore == null && typeof rec.cargoScore === "number") c.cargoScore = rec.cargoScore
            }
            if (!c.airportId || !c.countryId) c.unresolved = true
        }
    }

    async _loadDistances() {
        // Distances are only meaningful when launched from the scheduling
        // page (a hub is active). Read-only against the resolver's persistent
        // cache — no network. Resolver lives in the route-assistant bundle
        // and isn't loaded on the dashboard route, so guard the symbol.
        if (!this.currentHub) return
        if (typeof RouteAssistantDistanceResolver === "undefined") return
        const pairs = []
        for (const c of this._candidates.values()) pairs.push([this.currentHub, c.iata])
        if (!pairs.length) return
        const cache = await RouteAssistantDistanceResolver.bulkLoadCache(pairs).catch(() => new Map())
        for (const c of this._candidates.values()) {
            const key = RouteAssistantDistanceResolver._pairKey(this.currentHub, c.iata)
            const rec = cache.get(key)
            if (rec && typeof rec.distanceKm === "number") c.distanceKm = rec.distanceKm
        }
    }

    _applyExistingFilter() {
        if (!this._filters.hideExisting) return 0
        let hidden = 0
        for (const iata of Array.from(this._candidates.keys())) {
            if (this._existingIatas.has(iata)) {
                this._candidates.delete(iata)
                hidden++
            }
        }
        return hidden
    }

    async _ensureCountriesCache() {
        const out = await chrome.storage.local.get(["settings"])
        const settings = (out && out.settings) || {}
        const cached = settings.stationAutomation && settings.stationAutomation.countriesCache
        if (cached && cached.length) {
            this._countries = new Map(cached.map(c => [c.id, {name: c.name, code: c.code}]))
            return
        }
        this._setStatus("Fetching country list (one-time)…")
        const fresh = await CountryScraper.loadCountriesList(this.server).catch(() => [])
        if (fresh.length) {
            settings.stationAutomation = settings.stationAutomation || {}
            settings.stationAutomation.countriesCache = fresh
            await chrome.storage.local.set({settings})
            this._countries = new Map(fresh.map(c => [c.id, {name: c.name, code: c.code}]))
        }
    }

    // ---------- Rendering ----------

    _buildOverlay() {
        const overlay = document.createElement("div")
        overlay.className = "aes-osm-overlay"
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);"
            + "z-index:9999;display:flex;align-items:center;justify-content:center;"
        overlay.addEventListener("click", e => { if (e.target === overlay) this._close() })

        const dialog = document.createElement("div")
        dialog.style.cssText = "background:#1f2937;color:#e5e7eb;width:min(880px,92vw);"
            + "max-height:90vh;display:flex;flex-direction:column;border-radius:6px;"
            + "box-shadow:0 12px 40px rgba(0,0,0,0.5);font-size:13px;"
        overlay.append(dialog)

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;padding:12px 16px;"
            + "border-bottom:1px solid #374151;gap:12px;"
        const title = document.createElement("h4")
        title.textContent = "Open stations at scraped airports"
        title.style.cssText = "margin:0;font-size:15px;flex:1;color:#f3f4f6;"
        const closeX = document.createElement("button")
        closeX.type = "button"
        closeX.textContent = "×"
        closeX.style.cssText = "background:transparent;color:#9ca3af;border:none;font-size:22px;"
            + "cursor:pointer;line-height:1;padding:0 4px;"
        closeX.addEventListener("click", () => this._close())
        header.append(title, closeX)
        dialog.append(header)

        const filters = this._buildFilters()
        dialog.append(filters)

        const status = document.createElement("div")
        status.className = "aes-osm-status"
        status.style.cssText = "padding:8px 16px;color:#9ca3af;font-size:12px;border-bottom:1px solid #374151;"
        dialog.append(status)
        this._statusEl = status

        const body = document.createElement("div")
        body.style.cssText = "flex:1;overflow:auto;padding:8px 16px;"
        dialog.append(body)
        this._body = body

        const footer = document.createElement("div")
        footer.style.cssText = "display:flex;align-items:center;padding:12px 16px;"
            + "border-top:1px solid #374151;gap:12px;"
        dialog.append(footer)
        this._footer = footer

        document.body.append(overlay)
        this._overlay = overlay

        this._escHandler = (e) => { if (e.key === "Escape") this._close() }
        document.addEventListener("keydown", this._escHandler)
    }

    _buildFilters() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px 16px;border-bottom:1px solid #374151;"
            + "display:flex;flex-wrap:wrap;gap:14px 18px;align-items:center;font-size:12px;"

        const sourceCb = (label, key) => {
            const lab = document.createElement("label")
            lab.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = this._filters[key]
            cb.addEventListener("change", () => {
                this._filters[key] = cb.checked
                this._refresh().catch(err => console.error(err))
            })
            const span = document.createElement("span")
            span.textContent = label
            lab.append(cb, span)
            return lab
        }
        wrap.append(
            sourceCb("Demand",       "useDemand"),
            sourceCb("FlightsFrom",  "useFf"),
            sourceCb("Watchlist",    "useWatch"),
            sourceCb("Top routes",   "useTop"),
        )

        const numIn = (label, key, min, max) => {
            const lab = document.createElement("label")
            lab.style.cssText = "display:flex;align-items:center;gap:4px;color:#9ca3af;"
            const span = document.createElement("span"); span.textContent = label
            const input = document.createElement("input")
            input.type  = "number"
            input.min   = String(min); input.max = String(max)
            input.value = String(this._filters[key])
            input.style.cssText = "width:48px;background:#111827;color:#e5e7eb;"
                + "border:1px solid #374151;border-radius:3px;padding:2px 4px;"
            input.addEventListener("change", () => {
                const n = parseInt(input.value, 10)
                this._filters[key] = isNaN(n) ? 0 : Math.max(min, Math.min(max, n))
                input.value = String(this._filters[key])
                this._refresh().catch(err => console.error(err))
            })
            lab.append(span, input)
            return lab
        }
        wrap.append(numIn("Pax ≥", "paxMin", 0, 10))
        wrap.append(numIn("Cargo ≥", "cargoMin", 0, 10))

        if (this.currentHub) {
            const lab = document.createElement("label")
            lab.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;color:#9ca3af;"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = this._filters.currentHubOnlyWatch
            cb.addEventListener("change", () => {
                this._filters.currentHubOnlyWatch = cb.checked
                this._refresh().catch(err => console.error(err))
            })
            const span = document.createElement("span")
            span.textContent = `Watchlist: ${this.currentHub} only`
            lab.append(cb, span)
            wrap.append(lab)
        }

        const lab2 = document.createElement("label")
        lab2.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;color:#9ca3af;"
        const cb2 = document.createElement("input")
        cb2.type = "checkbox"
        cb2.checked = this._filters.hideExisting
        cb2.addEventListener("change", () => {
            this._filters.hideExisting = cb2.checked
            this._refresh().catch(err => console.error(err))
        })
        const span2 = document.createElement("span"); span2.textContent = "Hide already-open"
        lab2.append(cb2, span2)
        wrap.append(lab2)

        return wrap
    }

    _renderBody() {
        this._body.innerHTML = ""

        if (!this._candidates.size) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:32px 16px;text-align:center;color:#9ca3af;"
            empty.innerHTML = "<p style=\"margin:0 0 6px 0;\">No candidate airports.</p>"
                + "<p style=\"margin:0;font-size:12px;\">Try lowering thresholds, enabling more sources, "
                + "or seeding countries from the Route Assistant.</p>"
            this._body.append(empty)
            const summary = []
            if (this._hiddenExisting) summary.push(`${this._hiddenExisting} already-open hidden`)
            this._setStatus(summary.join(" · ") || "Empty")
            return
        }

        const groups = new Map()  // countryId → array of candidates
        const unresolved = []
        for (const c of this._candidates.values()) {
            if (c.unresolved || !c.countryId) { unresolved.push(c); continue }
            if (!groups.has(c.countryId)) groups.set(c.countryId, [])
            groups.get(c.countryId).push(c)
        }

        const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
            const an = (this._countries.get(a[0])?.name || a[0]).toLowerCase()
            const bn = (this._countries.get(b[0])?.name || b[0]).toLowerCase()
            return an.localeCompare(bn)
        })

        for (const [countryId, list] of sortedGroups) {
            list.sort((a, b) => a.iata.localeCompare(b.iata))
            this._body.append(this._renderCountryGroup(countryId, list))
        }

        if (unresolved.length) this._body.append(this._renderUnresolvedGroup(unresolved))

        const resolvedCount = this._candidates.size - unresolved.length
        const summary = [`${resolvedCount} airport${resolvedCount === 1 ? "" : "s"} across ${groups.size} ${groups.size === 1 ? "country" : "countries"}`]
        if (unresolved.length)    summary.push(`${unresolved.length} unresolved`)
        if (this._hiddenExisting) summary.push(`${this._hiddenExisting} already-open hidden`)
        this._setStatus(summary.join(" · "))
    }

    _renderCountryGroup(countryId, list) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:1px solid #374151;border-radius:4px;margin-bottom:8px;background:#111827;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;padding:6px 10px;cursor:pointer;"
            + "user-select:none;border-bottom:1px solid #374151;gap:8px;"
        const country = this._countries.get(countryId)
        const countryLabel = country ? `${country.name}${country.code ? " (" + country.code + ")" : ""}` : `Country #${countryId}`

        const chevron = document.createElement("span")
        chevron.style.cssText = "color:#9ca3af;width:12px;display:inline-block;"
        chevron.textContent = this._collapsed.has(countryId) ? "▸" : "▾"

        const title = document.createElement("span")
        title.style.cssText = "font-weight:600;color:#f3f4f6;flex:1;"
        title.textContent = countryLabel

        const groupCb = document.createElement("input")
        groupCb.type = "checkbox"
        const allSelected = list.every(c => this._selected.has(c.iata))
        const someSelected = list.some(c => this._selected.has(c.iata))
        groupCb.checked = allSelected
        groupCb.indeterminate = !allSelected && someSelected
        groupCb.title = "Select / deselect all in this country"
        groupCb.addEventListener("click", e => e.stopPropagation())
        groupCb.addEventListener("change", () => {
            for (const c of list) {
                if (groupCb.checked) this._selected.add(c.iata)
                else this._selected.delete(c.iata)
            }
            this._renderBody()
            this._renderFooter()
        })

        const count = document.createElement("span")
        count.style.cssText = "color:#9ca3af;font-size:11px;"
        count.textContent = `${list.length}`

        head.append(chevron, title, count, groupCb)
        head.addEventListener("click", () => {
            if (this._collapsed.has(countryId)) this._collapsed.delete(countryId)
            else this._collapsed.add(countryId)
            this._renderBody()
        })
        wrap.append(head)

        if (!this._collapsed.has(countryId)) {
            const rows = document.createElement("div")
            rows.style.cssText = "padding:4px 0;"
            for (const c of list) rows.append(this._renderAirportRow(c))
            wrap.append(rows)
        }
        return wrap
    }

    _renderAirportRow(c) {
        const row = document.createElement("label")
        row.style.cssText = "display:flex;align-items:center;padding:4px 12px;gap:8px;"
            + "cursor:pointer;border-bottom:1px solid rgba(55,65,81,0.4);"

        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.checked = this._selected.has(c.iata)
        cb.addEventListener("change", () => {
            if (cb.checked) this._selected.add(c.iata)
            else this._selected.delete(c.iata)
            this._renderFooter()
        })

        const iata = document.createElement("span")
        iata.style.cssText = "font-family:monospace;font-weight:600;color:#f3f4f6;width:40px;"
        iata.textContent = c.iata

        const name = document.createElement("span")
        name.style.cssText = "flex:1;color:#d1d5db;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        name.textContent = c.name || ""

        const scores = document.createElement("span")
        scores.style.cssText = "color:#9ca3af;font-size:11px;width:80px;flex-shrink:0;"
        const px = c.paxScore   != null ? c.paxScore   : "—"
        const cg = c.cargoScore != null ? c.cargoScore : "—"
        scores.textContent = `P${px} / C${cg}`

        const distance = document.createElement("span")
        distance.style.cssText = "color:#9ca3af;font-size:11px;width:64px;flex-shrink:0;text-align:right;"
        if (this.currentHub) {
            distance.textContent = c.distanceKm != null
                ? `${Math.round(c.distanceKm).toLocaleString()} km`
                : "—"
            distance.title = c.distanceKm != null
                ? `${Math.round(c.distanceKm)} km from ${this.currentHub}`
                : `Distance not cached — open the route in Route Assistant to resolve`
        }

        const chips = document.createElement("span")
        chips.style.cssText = "display:flex;gap:3px;flex-shrink:0;"
        const ordered = ["demand", "ff", "watch", "top"]
        for (const k of ordered) {
            if (!c.sources.has(k)) continue
            const meta = OpenStationsModal.SOURCE_LABELS[k]
            const chip = document.createElement("span")
            chip.textContent = meta.label
            chip.style.cssText = `font-size:10px;padding:1px 5px;border-radius:8px;`
                + `background:${meta.color}33;color:${meta.color};border:1px solid ${meta.color}66;`
            chips.append(chip)
        }

        row.append(cb, iata, name, scores)
        if (this.currentHub) row.append(distance)
        row.append(chips)
        return row
    }

    _renderUnresolvedGroup(list) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:1px dashed #374151;border-radius:4px;margin-top:12px;"
            + "padding:8px 10px;background:rgba(146,64,14,0.12);"
        const title = document.createElement("div")
        title.style.cssText = "color:#fbbf24;font-size:12px;margin-bottom:6px;"
        title.innerHTML = `<strong>${list.length} unresolved</strong> — these IATAs have no `
            + `cached airportId/countryId. Run "Seed all countries" in Route Assistant first, `
            + `then reopen this modal.`
        wrap.append(title)
        const codes = document.createElement("div")
        codes.style.cssText = "font-family:monospace;font-size:11px;color:#9ca3af;line-height:1.5;"
        codes.textContent = list.map(c => c.iata).sort().join(", ")
        wrap.append(codes)
        return wrap
    }

    _renderFooter() {
        this._footer.innerHTML = ""

        const counter = document.createElement("span")
        counter.style.cssText = "flex:1;color:#9ca3af;font-size:12px;"
        const selectedList = Array.from(this._selected)
        const countriesTouched = new Set()
        for (const iata of selectedList) {
            const c = this._candidates.get(iata)
            if (c && c.countryId) countriesTouched.add(c.countryId)
        }
        counter.textContent = selectedList.length
            ? `${selectedList.length} selected · ${countriesTouched.size} ${countriesTouched.size === 1 ? "country" : "countries"}`
            : "Nothing selected"
        this._footer.append(counter)

        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.className = "btn btn-default btn-sm"
        cancelBtn.textContent = "Cancel"
        cancelBtn.addEventListener("click", () => this._close())
        this._footer.append(cancelBtn)

        const confirmBtn = document.createElement("button")
        confirmBtn.type = "button"
        confirmBtn.className = "btn btn-primary btn-sm"
        confirmBtn.textContent = "Add to queue"
        confirmBtn.disabled = selectedList.length === 0
        confirmBtn.addEventListener("click", () => this._onConfirm(confirmBtn))
        this._footer.append(confirmBtn)
    }

    // ---------- Confirm / enqueue ----------

    async _onConfirm(btn) {
        btn.disabled = true
        const selectedList = Array.from(this._selected)
        const byCountry = new Map()
        for (const iata of selectedList) {
            const c = this._candidates.get(iata)
            if (!c || !c.countryId) continue
            if (!byCountry.has(c.countryId)) byCountry.set(c.countryId, [])
            byCountry.get(c.countryId).push(iata)
        }
        if (!byCountry.size) {
            this._setStatus("No resolvable airports to enqueue.", "bad")
            btn.disabled = false
            return
        }

        const beforeRecord = await StationAutomationStorage.load(this.server, this.airlineCode)
        const baseLength   = (beforeRecord.queue || []).length
        const addedIatas   = []

        for (const [countryId, iatas] of byCountry) {
            const meta = this._countries.get(countryId) || {}
            const countryName = meta.name
                ? meta.name + (meta.code ? " (" + meta.code + ")" : "")
                : "Country #" + countryId
            const entry = {
                countryId,
                countryCode: meta.code || "",
                countryName,
                paxThreshold: 0,
                cargoThreshold: 0,
                exceptions: [],
                airportWhitelist: iatas,
            }
            await StationAutomationStorage.enqueue(this.server, this.airlineCode, entry)
            addedIatas.push(...iatas)
        }

        const totalAirports = addedIatas.length
        const message = `Queued ${totalAirports} airport${totalAirports === 1 ? "" : "s"} `
            + `across ${byCountry.size} ${byCountry.size === 1 ? "country" : "countries"}.`

        this._close()

        // Undo strategy: trust positional indices. Queue inserts are
        // append-only and only mutated from the dashboard, so drop the trailing
        // N entries we appended. If the queue length doesn't match (the user
        // ran the worker, or removed entries by hand between confirm and undo),
        // bail out with an error toast — safer than a partial revert.
        const expected = baseLength + byCountry.size
        const undo = async () => {
            const rec = await StationAutomationStorage.load(this.server, this.airlineCode)
            if (!rec.queue || rec.queue.length !== expected) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.show("Can't undo — queue changed since confirm.", {type: "warn"})
                }
                return
            }
            rec.queue = rec.queue.slice(0, baseLength)
            await StationAutomationStorage.save(rec)
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.show("Removed " + byCountry.size + " queue entries.", {type: "info"})
            }
        }

        if (typeof RouteAssistantToast !== "undefined") {
            RouteAssistantToast.show(message, {
                type:     "success",
                duration: 7000,
                action:   {label: "Undo", fn: undo},
            })
        } else {
            console.log("[AES OpenStationsModal] " + message)
        }
    }

    // ---------- Lifecycle ----------

    _setStatus(text, kind) {
        if (!this._statusEl) return
        this._statusEl.textContent = text || ""
        this._statusEl.style.color = kind === "bad"     ? "#fca5a5"
                                  : kind === "warn"    ? "#fbbf24"
                                  : kind === "good"    ? "#86efac"
                                  : "#9ca3af"
    }

    _close() {
        if (this._escHandler) document.removeEventListener("keydown", this._escHandler)
        if (this._overlay && this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay)
        this._overlay = null
        if (this._resolveOpen) { this._resolveOpen(); this._resolveOpen = null }
    }
}
