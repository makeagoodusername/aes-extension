"use strict"

/**
 * CentralHubHeroPolyhedron — CB1 (FACET overhaul, opt-in via cubistMode).
 *
 * Replaces CentralHubHeroStrip's 6-column orthogonal grid with one fused
 * polyhedral artifact: a wide TODAY facet wrapped in a GhostLayer (past
 * sepia + forecast wireframe) plus four small angular facets to the right
 * (Alerts wedge · ORS lozenge · Maintenance pentagon · World pentagon).
 *
 * Same data sources as CentralHubHeroStrip — pure storage projection,
 * never scrapes, never writes. Same CentralHubBus.emit("open-tile", …)
 * drill-in pattern. Same shape of options ({server, airline}), so the
 * shell can swap between strip and polyhedron with a single conditional.
 *
 * YESTERDAY layer pulls the second-most-recent accounting snapshot when
 * available; FORECAST layer is a wireframe placeholder pending Strategy
 * Slice 22 (probabilistic demand fans). Both degrade to em-dash without
 * throwing if the underlying stores are empty.
 *
 * Foundation: requires AESCubistPrimitives + AESCubistTokens (CB0).
 * Activates only under body.aes-cubist.
 */
class CentralHubHeroPolyhedron {
    static REFRESH_DEBOUNCE_MS = 250

    constructor(opts) {
        this.server  = (opts && opts.server)  || ""
        this.airline = (opts && opts.airline) || ""
        this.root = null

        // Layer DOM — one element trio per "today" column (cash · fleet · top route)
        // and one per small facet (alerts · ors · maint · world).
        this._present = {cash: null, fleet: null, topRoute: null}
        this._past    = {cash: null, fleet: null, topRoute: null}
        this._forecast= {cash: null, fleet: null, topRoute: null}
        this._small   = new Map()  // id -> {root, valueEl, subEl}

        this._storageListener = null
        this._refreshTimer = null
        this._dirty = new Set()
        this._smallSpecs = CentralHubHeroPolyhedron._smallSpecs()
        this._storageAllPromise = null
    }

    static _smallSpecs() {
        return [
            {
                id: "alerts", label: "Alerts", shape: "wedge-tr",
                prefixes: ["routeAssistant:alertRules"],
                resolver: "_resolveAlerts",
                focusPayload: {
                    tileId: "route-assistant", expand: true, scrollIntoView: true,
                    filter: {type: "fired-alerts"}, source: "hero-cubist-alerts"
                }
            },
            {
                id: "ors", label: "ORS", shape: "lozenge-c",
                prefixes: ["routeAssistant:ors:", "routeAssistant:ors:acct:"],
                resolver: "_resolveOrs",
                focusPayload: {
                    tileId: "route-assistant", expand: true, scrollIntoView: true,
                    filter: {type: "ors-low"}, source: "hero-cubist-ors"
                }
            },
            {
                id: "maint", label: "Maint", shape: "pentagon-r",
                prefixes: ["aircraftFlightPlan:wearObservations:"],
                resolver: "_resolveMaintenance",
                focusPayload: {
                    tileId: "aircraft-flight-plan", expand: true, scrollIntoView: true,
                    filter: {type: "maintenance-risk"}, source: "hero-cubist-maint"
                }
            },
            {
                id: "world", label: "World", shape: "pentagon-l",
                prefixes: ["alliance:overview"],
                resolver: "_resolveWorld",
                focusPayload: {
                    tileId: "alliance", expand: true, scrollIntoView: true,
                    source: "hero-cubist-world"
                }
            }
        ]
    }

    /** Build the polyhedron + attach storage listener; return root element. */
    mount() {
        const T = window.AESTokens
        const P = window.AESCubistPrimitives
        if (!P || typeof P.Facet !== "function") {
            // Defensive — CB0 primitives missing means cubist mode is broken.
            // Render an empty placeholder rather than throwing.
            const empty = document.createElement("div")
            empty.style.cssText = "min-height:140px;background:" + (T && T.color.bone)
            this.root = empty
            return empty
        }

        const root = document.createElement("div")
        root.className = "aes-central-hub__hero aes-central-hub__hero--cubist"
        root.style.cssText = [
            "display:grid",
            "grid-template-columns:3fr 1fr 1fr 1fr 1fr",
            "gap:" + T.sp[3],
            "padding:" + T.sp[3] + " " + T.sp[4],
            "background:" + T.color.bone,
            "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide,
            "min-height:140px",
            "box-sizing:border-box"
        ].join(";")

        root.appendChild(this._buildTodayPolyhedron())
        for (const spec of this._smallSpecs) {
            root.appendChild(this._buildSmallFacet(spec))
        }

        this.root = root
        this._attachStorageListener()
        this._refreshAll()
        return root
    }

    dispose() {
        if (this._storageListener) {
            try { chrome.storage.onChanged.removeListener(this._storageListener) }
            catch (_) { /* noop */ }
            this._storageListener = null
        }
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer)
            this._refreshTimer = null
        }
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root)
        }
        this.root = null
        this._small.clear()
    }

    // ------------------------------------------------------------------
    // TODAY polyhedron — the GhostLayer-wrapped trapezoid with 3 columns
    // ------------------------------------------------------------------

    _buildTodayPolyhedron() {
        const T = window.AESTokens
        const P = window.AESCubistPrimitives

        const presentInner = this._buildTodayInner("present")
        const pastInner    = this._buildTodayInner("past")
        const forecastInner= this._buildTodayInner("forecast")

        const presentFacet = P.Facet({
            shape: "trapezoid-t",
            perspective: "today",
            label: "Today's pulse",
            content: presentInner
        })
        presentFacet.style.cssText += ";cursor:pointer;background:" + T.color.bone
            + ";border:" + T.geom.bw2 + " solid " + T.color.oxide
            + ";padding:" + T.sp[3] + " " + T.sp[4]
            + ";min-height:120px"
            + ";display:flex;align-items:center;gap:" + T.sp[4]
        presentFacet.addEventListener("click", () => {
            if (!window.CentralHubBus) return
            window.CentralHubBus.emit("open-tile", {
                tileId: "accounting", expand: true, scrollIntoView: true,
                source: "hero-cubist-today"
            })
        })

        const pastFacet = P.Facet({
            shape: "trapezoid-t",
            perspective: "yesterday",
            label: "Yesterday",
            content: pastInner
        })
        pastFacet.style.cssText += ";background:" + T.color.bone
            + ";padding:" + T.sp[3] + " " + T.sp[4]
            + ";min-height:120px"
            + ";display:flex;align-items:center;gap:" + T.sp[4]

        const forecastFacet = P.Facet({
            shape: "trapezoid-t",
            perspective: "forecast",
            label: "Forecast",
            content: forecastInner
        })
        forecastFacet.style.cssText += ";background:" + T.color.bone
            + ";padding:" + T.sp[3] + " " + T.sp[4]
            + ";min-height:120px"
            + ";display:flex;align-items:center;gap:" + T.sp[4]

        const ghost = P.GhostLayer({
            present:  presentFacet,
            past:     pastFacet,
            forecast: forecastFacet
        })
        ghost.style.gridColumn = "1"
        return ghost
    }

    _buildTodayInner(layer) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(3, 1fr)",
            "gap:" + T.sp[4],
            "width:100%",
            "align-items:end"
        ].join(";")

        const columns = [
            {key: "cash",     label: "Cash"},
            {key: "fleet",    label: "Fleet"},
            {key: "topRoute", label: "Top Route"}
        ]

        const target = layer === "present" ? this._present
            : layer === "past" ? this._past
            : this._forecast

        for (const col of columns) {
            const colEl = document.createElement("div")
            colEl.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0"

            const lbl = document.createElement("div")
            lbl.textContent = col.label.toUpperCase()
            if (layer === "forecast") {
                // Stencil label for the wireframe layer — collage juxtaposition.
                lbl.className = "aes-stencil"
                lbl.style.cssText = "font-size:" + T.fs.micro
            } else {
                lbl.style.cssText = [
                    "font-family:" + T.font.display,
                    "font-size:" + T.fs.micro,
                    "font-weight:" + T.fw.display,
                    "letter-spacing:" + T.track.caps,
                    "text-transform:uppercase",
                    "color:" + T.color.slate
                ].join(";")
            }

            const value = document.createElement("div")
            value.textContent = "—"
            value.style.cssText = [
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.h3,
                "font-weight:" + T.fw.display,
                "letter-spacing:" + T.track.mono,
                "color:" + T.color.oxide,
                "white-space:nowrap",
                "overflow:hidden",
                "text-overflow:ellipsis"
            ].join(";")

            const sub = document.createElement("div")
            sub.textContent = layer === "forecast" ? "queued · slice 22" : "no data"
            sub.style.cssText = [
                "font-family:" + T.font.display,
                "font-size:" + T.fs.micro,
                "color:" + T.color.slate,
                "white-space:nowrap",
                "overflow:hidden",
                "text-overflow:ellipsis"
            ].join(";")

            colEl.append(lbl, value, sub)
            wrap.appendChild(colEl)
            target[col.key] = {valueEl: value, subEl: sub}
        }

        return wrap
    }

    // ------------------------------------------------------------------
    // Small facets — wedge / lozenge / pentagon corners
    // ------------------------------------------------------------------

    _buildSmallFacet(spec) {
        const T = window.AESTokens
        const P = window.AESCubistPrimitives

        const inner = document.createElement("div")
        inner.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "justify-content:center",
            "align-items:center",
            "gap:2px",
            "padding:" + T.sp[3],
            "min-height:120px",
            "text-align:center",
            "box-sizing:border-box"
        ].join(";")

        const label = document.createElement("div")
        label.textContent = spec.label.toUpperCase()
        label.className = "aes-stencil"
        label.style.cssText = "font-size:" + T.fs.micro

        const value = document.createElement("div")
        value.textContent = "—"
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.h2,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide,
            "line-height:" + T.lh.tight
        ].join(";")

        const sub = document.createElement("div")
        sub.textContent = "no data"
        sub.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "color:" + T.color.slate
        ].join(";")

        inner.append(label, value, sub)

        const facet = P.Facet({
            shape: spec.shape,
            perspective: spec.id,
            label: spec.label,
            content: inner
        })
        facet.style.cssText += [
            ";cursor:pointer",
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "transition:" + T.tr.fast
        ].join(";")
        facet.addEventListener("mouseenter", () => {
            facet.style.background = T.color.bone
        })
        facet.addEventListener("mouseleave", () => {
            facet.style.background = T.color.bone2
        })
        facet.addEventListener("click", (e) => {
            e.preventDefault()
            if (!window.CentralHubBus) return
            window.CentralHubBus.emit("open-tile", spec.focusPayload)
        })

        this._small.set(spec.id, {root: facet, valueEl: value, subEl: sub})
        return facet
    }

    // ------------------------------------------------------------------
    // Refresh + storage listener
    // ------------------------------------------------------------------

    async _refreshAll() {
        this._storageAllPromise = null
        const tasks = [
            this._refreshToday().catch(() => {}),
            ...this._smallSpecs.map(spec => this._refreshSmall(spec).catch(() => {}))
        ]
        await Promise.all(tasks)
        this._storageAllPromise = null
    }

    async _refreshToday() {
        const [cashNow, cashPast, fleet, top] = await Promise.all([
            this._resolveCashLayer("present").catch(() => null),
            this._resolveCashLayer("past").catch(() => null),
            this._resolveFleet().catch(() => null),
            this._resolveTopRoute().catch(() => null)
        ])
        this._setLayer("present",  "cash",     cashNow)
        this._setLayer("past",     "cash",     cashPast)
        this._setLayer("present",  "fleet",    fleet)
        this._setLayer("past",     "fleet",    fleet)  // no historical fleet snapshot — clone
        this._setLayer("present",  "topRoute", top)
        this._setLayer("past",     "topRoute", top)    // no historical top-route — clone
        // Forecast stays wireframe placeholder until Slice 22 wires forecast values.
        this._setLayer("forecast", "cash",     {value: "—", sub: "queued · slice 22"})
        this._setLayer("forecast", "fleet",    {value: "—", sub: "queued · slice 22"})
        this._setLayer("forecast", "topRoute", {value: "—", sub: "queued · slice 22"})
    }

    async _refreshSmall(spec) {
        try {
            const result = await this[spec.resolver]()
            if (result) this._setSmall(spec.id, result)
        } catch (err) {
            console.warn("[AES Hub hero-polyhedron] resolver failed", spec.id, err)
            this._setSmall(spec.id, {value: "—", sub: "no data"})
        }
    }

    _setLayer(layer, colKey, result) {
        const target = layer === "present" ? this._present
            : layer === "past" ? this._past
            : this._forecast
        const cell = target[colKey]
        if (!cell) return
        cell.valueEl.textContent = (result && result.value) || "—"
        cell.subEl.textContent   = (result && result.sub)   || ""
    }

    _setSmall(id, result) {
        const card = this._small.get(id)
        if (!card) return
        card.valueEl.textContent = (result && result.value) || "—"
        card.subEl.textContent   = (result && result.sub)   || ""
    }

    _attachStorageListener() {
        if (this._storageListener) return
        const allPrefixes = [
            // TODAY columns
            {kind: "today", contains: "accounting:"},
            {kind: "today", suffix: "aircraftFleet"},
            {kind: "today", prefix: "routeAssistant:topRoutes"}
        ]
        for (const spec of this._smallSpecs) {
            for (const p of spec.prefixes) {
                allPrefixes.push({kind: "small", id: spec.id, prefix: p})
            }
        }

        this._storageListener = (changes, area) => {
            if (area !== "local") return
            for (const k in changes) {
                for (const entry of allPrefixes) {
                    if (CentralHubHeroPolyhedron._storageEntryMatches(k, entry)) {
                        this._dirty.add(entry.kind === "today" ? "today" : entry.id)
                        break
                    }
                }
            }
            if (!this._dirty.size) return
            if (this._refreshTimer) return
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null
                const dirty = Array.from(this._dirty)
                this._dirty.clear()
                if (dirty.indexOf("today") >= 0) {
                    this._refreshToday().catch(() => {})
                }
                for (const id of dirty) {
                    if (id === "today") continue
                    const spec = this._smallSpecs.find(s => s.id === id)
                    if (spec) this._refreshSmall(spec).catch(() => {})
                }
            }, CentralHubHeroPolyhedron.REFRESH_DEBOUNCE_MS)
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    // ------------------------------------------------------------------
    // Resolvers — mirror hero-strip patterns; layer-aware for cash.
    // ------------------------------------------------------------------

    async _resolveCashLayer(layer) {
        const airline = this._airlineKey()
        if (!this.server || !airline) return {value: "—", sub: "no airline"}
        const indexKey = this.server + airline + "accounting:index"
        const blob = await chrome.storage.local.get([indexKey])
        const index = Array.isArray(blob[indexKey]) ? blob[indexKey] : []
        if (!index.length) return {value: "—", sub: "no snapshots"}

        // present → newest; past → second newest (fallback to newest if only one).
        const targetIdx = layer === "past" && index.length > 1 ? 1 : 0
        const snap = index[targetIdx]
        const week = snap.weekId || snap.weekClosesAt || ""

        const keys = ["bank", "income"].map(t => this.server + airline + "accounting:" + t + ":" + week)
        const recs = await chrome.storage.local.get(keys)
        const bank   = recs[keys[0]] && recs[keys[0]].payload
        const income = recs[keys[1]] && recs[keys[1]].payload

        if (bank && Number.isFinite(bank.cashBalance)) {
            return {
                value: CentralHubHeroPolyhedron._formatCompactAS(bank.cashBalance),
                sub:   "cash · " + week
            }
        }
        if (income && income.totals) {
            const net = (income.totals.ebt && income.totals.ebt.current)
                ?? (income.totals.ebit && income.totals.ebit.current)
            if (Number.isFinite(net)) {
                return {
                    value: CentralHubHeroPolyhedron._formatCompactAS(net),
                    sub:   "weekly net · " + week
                }
            }
        }
        return {value: "—", sub: "open /finance/accounting"}
    }

    async _resolveFleet() {
        if (!this.server) return {value: "—", sub: "no server"}
        const all = await this._loadStorageAll()
        const airline = this._airlineKey()
        let chosen = null
        const suffix = "aircraftFleet"
        for (const key in all) {
            if (key.indexOf(this.server) !== 0) continue
            if (key.lastIndexOf(suffix) !== key.length - suffix.length) continue
            const rec = all[key]
            if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
            if (airline) {
                if (this._fleetRecordMatchesAirline(key, rec, airline)) {
                    chosen = rec
                    break
                }
                continue
            }
            if (!chosen || rec.fleet.length > chosen.fleet.length) chosen = rec
        }
        const aircraft = chosen && Array.isArray(chosen.fleet) ? chosen.fleet : []
        if (!aircraft.length) return {value: "—", sub: "no fleet record"}

        let utilSum = 0, utilCount = 0
        for (const a of aircraft) {
            const u = Number(a && (a.utilization ?? a.util))
            if (Number.isFinite(u) && u >= 0 && u <= 200) { utilSum += u; utilCount++ }
        }
        const avgUtil = utilCount ? Math.round(utilSum / utilCount) : null
        const sub = avgUtil != null ? avgUtil + "% util" : aircraft.length + " aircraft"
        return {value: String(aircraft.length), sub}
    }

    async _resolveTopRoute() {
        const all = await this._loadStorageAll()
        const prefix = "routeAssistant:topRoutes:"
        let best = null
        let bestHub = null
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const blob = all[k]
            if (!blob || !Array.isArray(blob.rows)) continue
            for (const r of blob.rows) {
                const score = Number(r && r.score)
                if (!Number.isFinite(score)) continue
                if (!best || score > best.score) {
                    best = {score, destIata: r.destIata, profitPerWeek: r.profitPerWeek}
                    bestHub = blob.hub || k.substring(prefix.length)
                }
            }
        }
        if (!best) return {value: "—", sub: "open RA on a hub"}

        const value = String(bestHub || "?") + "→" + String(best.destIata || "?")
        const profit = Number(best.profitPerWeek)
        const sub = "★" + Math.round(best.score)
            + (Number.isFinite(profit) ? " · " + CentralHubHeroPolyhedron._formatCompactAS(profit) + "/wk" : "")
        return {value, sub}
    }

    async _resolveAlerts() {
        const all = await this._loadStorageAll()
        const prefix = "routeAssistant:alertRules"
        let rules = []
        for (const k in all) {
            if (k !== prefix && k.indexOf(prefix + ":") !== 0) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.rules)) continue
            if (rec.rules.length > rules.length) rules = rec.rules
        }
        if (!rules.length) return {value: "0", sub: "no rules"}

        const cutoff = Date.now() - 24 * 3600 * 1000
        const firedRoutes = new Set()
        let activeRules = 0
        for (const rule of rules) {
            if (rule && rule.enabled === false) continue
            activeRules++
            const fired = rule && rule.lastFiredByRoute
            if (!fired || typeof fired !== "object") continue
            for (const route in fired) {
                const t = Number(fired[route])
                if (Number.isFinite(t) && t >= cutoff) firedRoutes.add(route)
            }
        }
        if (!firedRoutes.size) return {value: "0", sub: activeRules + " rules · 24h"}
        return {value: String(firedRoutes.size), sub: "firing · 24h"}
    }

    async _resolveOrs() {
        let records = null
        let svc = null
        if (typeof RouteAssistantOrsIntelligence !== "undefined"
                && typeof RouteAssistantOrsIntelligence.listCachedRoutes === "function") {
            svc = new RouteAssistantOrsIntelligence(this.server)
            const map = await RouteAssistantOrsIntelligence.listCachedRoutes(this.server)
            records = Array.from(map.values())
        }
        if (!records) {
            const all = await this._loadStorageAll()
            records = []
            for (const k in all) {
                if (k.indexOf("routeAssistant:ors:") !== 0) continue
                const rec = all[k]
                if (rec && typeof rec === "object") records.push(rec)
            }
        }
        let total = 0, low = 0
        for (const rec of records) {
            if (!rec || typeof rec !== "object") continue
            const rank = this._orsRankFromRecord(rec, svc)
            if (!Number.isFinite(rank)) continue
            total++
            if (rank >= 4) low++
        }
        if (!total) return {value: "—", sub: "no ORS scrapes"}
        return {value: String(low), sub: "below rank 3 · of " + total}
    }

    _orsRankFromRecord(rec, svc) {
        if (svc && rec && (rec.byClass || rec.orsByClass)) {
            try {
                const composite = svc.getComposite({orsByClass: rec.byClass || rec.orsByClass})
                const rank = composite && (composite.rankAny != null ? composite.rankAny : composite.rankNonstop)
                if (Number.isFinite(Number(rank))) return Number(rank)
            } catch (_) { /* legacy fallback below */ }
        }
        const rank = rec && (rec.rankAny != null ? rec.rankAny : rec.rankNonstop)
        return Number(rank)
    }

    async _resolveMaintenance() {
        if (!this.server) return {value: "—", sub: "no server"}
        const all = await this._loadStorageAll()
        const prefix = "aircraftFlightPlan:wearObservations:" + this.server + ":"
        let total = 0, risk = 0
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.samples) || !rec.samples.length) continue
            total++
            const latest = rec.samples[0]
            const ratio = Number(latest && latest.ratio)
            if (Number.isFinite(ratio) && ratio < 1) risk++
        }
        if (!total) return {value: "—", sub: "no wear samples"}
        return {value: String(risk), sub: "at risk · of " + total}
    }

    async _loadStorageAll() {
        if (!this._storageAllPromise) {
            this._storageAllPromise = chrome.storage.local.get(null).catch(() => ({}))
        }
        return await this._storageAllPromise || {}
    }

    async _resolveWorld() {
        const blob = await chrome.storage.local.get(["alliance:overview"])
        const rec = blob["alliance:overview"]
        if (rec && rec.payload) {
            const members = Array.isArray(rec.payload.members) ? rec.payload.members.length : 0
            if (members > 0) {
                return {value: String(members), sub: "alliance members"}
            }
            if (rec.payload.name) {
                return {value: String(rec.payload.name).slice(0, 6).toUpperCase(), sub: "alliance"}
            }
        }
        return {value: "—", sub: "no alliance data"}
    }

    _airlineKey() {
        try {
            if (typeof AES !== "undefined" && typeof AES.getAirlineIdentity === "function") {
                const id = AES.getAirlineIdentity()
                if (id) return id
            }
        } catch (_) { /* fall through */ }
        try {
            const a = AES.getAirlineCode()
            if (a && a.code) return a.code
        } catch (_) { /* fall through */ }
        return this.airline || ""
    }

    _fleetRecordMatchesAirline(key, rec, airline) {
        const want = CentralHubHeroPolyhedron._normaliseAirlineKey(airline)
        if (!want) return false
        if (CentralHubHeroPolyhedron._normaliseAirlineKey(rec && rec.airline) === want) return true
        const suffix = "aircraftFleet"
        const rawKeyAirline = String(key || "").slice(
            String(this.server || "").length,
            Math.max(String(this.server || "").length, String(key || "").length - suffix.length)
        )
        return CentralHubHeroPolyhedron._normaliseAirlineKey(rawKeyAirline) === want
    }

    static _normaliseAirlineKey(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    }

    static _storageEntryMatches(key, entry) {
        if (!entry) return false
        if (entry.prefix && (key === entry.prefix || key.indexOf(entry.prefix) === 0)) return true
        if (entry.suffix && key.lastIndexOf(entry.suffix) === key.length - entry.suffix.length) return true
        if (entry.contains && key.indexOf(entry.contains) >= 0) return true
        return false
    }

    static _formatCompactAS(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return "—"
        const sign = n < 0 ? "-" : ""
        const abs = Math.abs(n)
        if (abs >= 1e9) return sign + "AS$" + (abs / 1e9).toFixed(2) + "B"
        if (abs >= 1e6) return sign + "AS$" + (abs / 1e6).toFixed(2) + "M"
        if (abs >= 1e3) return sign + "AS$" + (abs / 1e3).toFixed(1) + "k"
        return sign + "AS$" + Math.round(abs)
    }
}

if (typeof window !== "undefined") {
    window.CentralHubHeroPolyhedron = CentralHubHeroPolyhedron
}
