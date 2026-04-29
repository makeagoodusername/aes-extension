"use strict"

/**
 * CentralHubHeroStrip — six top-line KPI cards mounted between the hub's
 * top bar and the section split. Pure storage projection; never scrapes
 * AS, never writes — debounced refresh on chrome.storage.onChanged for
 * any of the watched key prefixes.
 *
 * Card click → CentralHubBus.emit("open-tile", {tileId, expand, …}) so the
 * shell can scroll + expand the relevant tile. Filter payloads (e.g.
 * {type: "fired-alerts"}) are reserved for CH-5d drill-ins; today's
 * receivers ignore unknown filter shapes.
 *
 * Cold-start safe: any card with no data renders em-dash + "no data"
 * with the muted palette. A single resolver failure never poisons the
 * other cards.
 */
class CentralHubHeroStrip {
    static REFRESH_DEBOUNCE_MS = 250

    constructor(opts) {
        this.server  = (opts && opts.server)  || ""
        this.airline = (opts && opts.airline) || ""
        this.root = null
        this._cardEls = new Map()  // id -> {root, valueEl, subEl}
        this._storageListener = null
        this._refreshTimer = null
        this._dirty = new Set()
        this._cards = CentralHubHeroStrip._cardSpecs()
        this._feedDisposers = []
    }

    static _cardSpecs() {
        return [
            {
                id:          "cash",
                label:       "Cash",
                // Cash card now reads via HubFeed (`hub:cash:weekly`) instead
                // of attaching its own chrome.storage.onChanged listener.
                // The prefixes array is left empty so the legacy storage path
                // is a no-op for this card; the feed subscription handles it.
                prefixes:    [],
                feedSlice:   "hub:cash:weekly",
                feedRender:  "_renderCashFromFeed",
                focusEvent:  "open-tile",
                focusPayload:{tileId: "accounting", expand: true, scrollIntoView: true, source: "hero-cash"}
            },
            {
                id:          "fleet",
                label:       "Fleet",
                prefixes:    ["aircraftFleet"],
                resolver:    "_resolveFleet",
                focusEvent:  "open-tile",
                focusPayload:{tileId: "fleet-hub", expand: true, scrollIntoView: true, source: "hero-fleet"}
            },
            {
                id:          "top-route",
                label:       "Top route",
                prefixes:    ["routeAssistant:topRoutes"],
                resolver:    "_resolveTopRoute",
                focusEvent:  "open-tile",
                focusPayload:{tileId: "route-assistant", expand: true, scrollIntoView: true, source: "hero-top-route"}
            },
            {
                id:          "alerts",
                label:       "Alerts",
                prefixes:    ["routeAssistant:alertRules"],
                resolver:    "_resolveAlerts",
                focusEvent:  "open-tile",
                focusPayload:{
                    tileId: "route-assistant",
                    expand: true, scrollIntoView: true,
                    filter: {type: "fired-alerts"},
                    source: "hero-alerts"
                }
            },
            {
                id:          "ors",
                label:       "ORS",
                prefixes:    ["routeAssistant:ors:", "routeAssistant:ors:acct:"],
                resolver:    "_resolveOrs",
                focusEvent:  "open-tile",
                focusPayload:{
                    tileId: "route-assistant",
                    expand: true, scrollIntoView: true,
                    filter: {type: "ors-low"},
                    source: "hero-ors"
                }
            },
            {
                id:          "maintenance",
                label:       "Maintenance",
                prefixes:    ["aircraftFlightPlan:wearObservations:"],
                resolver:    "_resolveMaintenance",
                focusEvent:  "open-tile",
                focusPayload:{
                    tileId: "aircraft-flight-plan",
                    expand: true, scrollIntoView: true,
                    filter: {type: "maintenance-risk"},
                    source: "hero-maintenance"
                }
            }
        ]
    }

    /** Builds the strip + attaches the storage listener; returns the root element. */
    mount() {
        const T = window.AESTokens

        const root = document.createElement("div")
        root.className = "aes-central-hub__hero"
        root.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(6, 1fr)",
            "gap:" + T.sp[3],
            "padding:" + T.sp[3] + " " + T.sp[4],
            "background:" + T.color.bone,
            "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide,
            "box-sizing:border-box"
        ].join(";")

        for (const spec of this._cards) {
            const card = this._buildCardEl(spec)
            root.appendChild(card.root)
            this._cardEls.set(spec.id, card)
        }

        this.root = root
        this._attachStorageListener()
        this._attachFeedSubscriptions()
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
        if (this._feedDisposers && this._feedDisposers.length) {
            for (const off of this._feedDisposers) {
                try { off() } catch (_) { /* noop */ }
            }
            this._feedDisposers = []
        }
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root)
        }
        this.root = null
        this._cardEls.clear()
    }

    _buildCardEl(spec) {
        const T = window.AESTokens
        const root = document.createElement("button")
        root.type = "button"
        root.className = "aes-central-hub__hero-card"
        root.dataset.cardId = spec.id
        root.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "justify-content:space-between",
            "gap:" + T.sp[1],
            "padding:" + T.sp[2] + " " + T.sp[3],
            "min-height:90px",
            "background:" + T.color.bone2,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "text-align:left",
            "cursor:pointer",
            "transition:" + T.tr.fast,
            "box-sizing:border-box"
        ].join(";")
        root.addEventListener("mouseenter", () => { root.style.borderColor = T.color.rust })
        root.addEventListener("mouseleave", () => {
            const kind = root.dataset.kind || "muted"
            const pal = window.CentralHubStatusBadges._palette(kind)
            root.style.borderColor = pal.border
        })
        root.addEventListener("click", (e) => {
            e.preventDefault()
            if (!window.CentralHubBus) return
            window.CentralHubBus.emit(spec.focusEvent, spec.focusPayload)
        })

        const labelEl = document.createElement("div")
        labelEl.textContent = spec.label.toUpperCase()
        labelEl.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.slate
        ].join(";")

        const valueEl = document.createElement("div")
        valueEl.className = "aes-central-hub__hero-value"
        valueEl.textContent = "—"
        valueEl.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide,
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis"
        ].join(";")

        const subEl = document.createElement("div")
        subEl.className = "aes-central-hub__hero-sub"
        subEl.textContent = "no data"
        subEl.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "color:" + T.color.slate,
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis"
        ].join(";")

        root.append(labelEl, valueEl, subEl)
        this._applyKind(root, "muted")
        return {root, valueEl, subEl}
    }

    _applyKind(rootEl, kind) {
        const pal = window.CentralHubStatusBadges._palette(kind || "muted")
        rootEl.dataset.kind = kind || "muted"
        rootEl.style.background  = pal.bg
        rootEl.style.color       = pal.fg
        rootEl.style.borderColor = pal.border
    }

    _setCard(id, {value, sub, kind}) {
        const card = this._cardEls.get(id)
        if (!card) return
        card.valueEl.textContent = value || "—"
        card.subEl.textContent = sub || ""
        this._applyKind(card.root, kind || "muted")
    }

    async _refreshAll() {
        for (const spec of this._cards) {
            // Feed-driven cards paint via HubFeed subscriptions; the cold
            // value (if any) is set in _attachFeedSubscriptions, and updates
            // arrive through the bus. Skip the legacy resolver to avoid the
            // momentary "no data" flicker before the subscription fires.
            if (spec.feedSlice) continue
            this._refreshCard(spec).catch(() => { /* never throw at strip level */ })
        }
    }

    async _refreshCard(spec) {
        try {
            const result = await this[spec.resolver]()
            if (result) this._setCard(spec.id, result)
        } catch (err) {
            console.warn("[AES Hub hero] resolver failed", spec.id, err)
            this._setCard(spec.id, {value: "—", sub: "no data", kind: "muted"})
        }
    }

    /**
     * Cards declaring `feedSlice` subscribe to HubFeed instead of joining the
     * shared storage listener. The feed compute owns the data shape; the
     * mapper (`feedRender`) translates it into the {value, sub, kind} card
     * triple. Keeps fallback resolvers untouched for cards still on the
     * legacy storage path.
     */
    _attachFeedSubscriptions() {
        if (typeof window.HubFeed === "undefined") return
        for (const spec of this._cards) {
            if (!spec.feedSlice) continue
            const off = window.HubFeed.subscribe(spec.feedSlice, (e) => {
                this._refreshFeedCard(spec, e)
            })
            if (typeof off === "function") this._feedDisposers.push(off)
            // Cold-paint: HubFeed views are eager by default but the first
            // value may not be cached yet when mount runs. Read what's there;
            // when undefined, leave the placeholder until the subscription fires.
            const cached = window.HubFeed.read(spec.feedSlice)
            if (cached !== undefined) {
                this._refreshFeedCard(spec, {value: cached, hasValue: true})
            }
        }
    }

    _refreshFeedCard(spec, e) {
        if (!e || !e.hasValue) return
        const fn = this[spec.feedRender]
        if (typeof fn !== "function") return
        try {
            const card = fn.call(this, e.value)
            if (card) this._setCard(spec.id, card)
        } catch (err) {
            console.warn("[AES Hub hero] feed-render failed", spec.id, err)
            this._setCard(spec.id, {value: "—", sub: "no data", kind: "muted"})
        }
    }

    _renderCashFromFeed(value) {
        if (!value || !value.hasSnapshot || !Number.isFinite(value.value)) {
            return {value: "—", sub: value ? value.label : "no data", kind: "muted"}
        }
        return {
            value: CentralHubHeroStrip._formatCompactAS(value.value),
            sub:   value.label || "",
            kind:  value.kind  || "ok"
        }
    }

    _attachStorageListener() {
        if (this._storageListener) return
        const allPrefixes = []
        for (const spec of this._cards) {
            for (const p of spec.prefixes) allPrefixes.push({id: spec.id, prefix: p})
        }
        this._storageListener = (changes, area) => {
            if (area !== "local") return
            for (const k in changes) {
                for (const entry of allPrefixes) {
                    if (k === entry.prefix || k.indexOf(entry.prefix) === 0) {
                        this._dirty.add(entry.id)
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
                for (const id of dirty) {
                    const spec = this._cards.find(c => c.id === id)
                    if (spec) this._refreshCard(spec).catch(() => {})
                }
            }, CentralHubHeroStrip.REFRESH_DEBOUNCE_MS)
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    // ------------------------------------------------------------------
    // Resolvers — one per card. Each returns {value, sub, kind} or null.
    // ------------------------------------------------------------------

    async _resolveCash() {
        const airline = this._airlineKey()
        if (!this.server || !airline) return {value: "—", sub: "no airline", kind: "muted"}
        const indexKey = this.server + airline + "accounting:index"
        const blob = await chrome.storage.local.get([indexKey])
        const index = Array.isArray(blob[indexKey]) ? blob[indexKey] : []
        if (!index.length) return {value: "—", sub: "no snapshots", kind: "muted"}

        const newest = index[0]
        const week = newest.weekId || newest.weekClosesAt || ""
        const keys = ["bank", "income"].map(t => this.server + airline + "accounting:" + t + ":" + week)
        const recs = await chrome.storage.local.get(keys)
        const bank   = recs[keys[0]] && recs[keys[0]].payload
        const income = recs[keys[1]] && recs[keys[1]].payload

        if (bank && Number.isFinite(bank.cashBalance)) {
            const cash = bank.cashBalance
            return {
                value: CentralHubHeroStrip._formatCompactAS(cash),
                sub:   "cash · " + week,
                kind:  cash >= 0 ? "ok" : "alert"
            }
        }
        if (income && income.totals) {
            const net = (income.totals.ebt && income.totals.ebt.current) ?? (income.totals.ebit && income.totals.ebit.current)
            if (Number.isFinite(net)) {
                return {
                    value: CentralHubHeroStrip._formatCompactAS(net),
                    sub:   "weekly net · " + week,
                    kind:  net >= 0 ? "ok" : "alert"
                }
            }
        }
        return {value: "—", sub: "open /finance/accounting", kind: "muted"}
    }

    async _resolveFleet() {
        if (!this.server) return {value: "—", sub: "no server", kind: "muted"}
        const all = await chrome.storage.local.get(null)
        let aircraft = []
        const suffix = "aircraftFleet"
        for (const key in all) {
            if (key.indexOf(this.server) !== 0) continue
            if (key.lastIndexOf(suffix) !== key.length - suffix.length) continue
            const rec = all[key]
            if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
            if (rec.fleet.length > aircraft.length) aircraft = rec.fleet
        }
        if (!aircraft.length) return {value: "—", sub: "no fleet record", kind: "muted"}

        let utilSum = 0, utilCount = 0
        for (const a of aircraft) {
            const u = Number(a && (a.utilization ?? a.util))
            if (Number.isFinite(u) && u >= 0 && u <= 200) { utilSum += u; utilCount++ }
        }
        const avgUtil = utilCount ? Math.round(utilSum / utilCount) : null
        const sub = avgUtil != null ? avgUtil + "% util" : aircraft.length + " aircraft"
        const kind = avgUtil == null ? "info" : (avgUtil >= 80 ? "ok" : (avgUtil >= 60 ? "warn" : "alert"))
        return {value: String(aircraft.length), sub, kind}
    }

    async _resolveTopRoute() {
        const all = await chrome.storage.local.get(null)
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
        if (!best) return {value: "—", sub: "open RA on a hub", kind: "muted"}

        const value = String(bestHub || "?") + "→" + String(best.destIata || "?")
        const profit = Number(best.profitPerWeek)
        const sub = "★" + Math.round(best.score)
            + (Number.isFinite(profit) ? " · " + CentralHubHeroStrip._formatCompactAS(profit) + "/wk" : "")
        return {value, sub, kind: "ok"}
    }

    async _resolveAlerts() {
        const all = await chrome.storage.local.get(null)
        const prefix = "routeAssistant:alertRules"
        let rules = []
        for (const k in all) {
            if (k !== prefix && k.indexOf(prefix + ":") !== 0) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.rules)) continue
            if (rec.rules.length > rules.length) rules = rec.rules
        }
        if (!rules.length) return {value: "0", sub: "no rules", kind: "muted"}

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
        if (!firedRoutes.size) {
            return {value: "0", sub: activeRules + " rules · 24h", kind: "ok"}
        }
        const kind = firedRoutes.size >= 5 ? "alert" : "warn"
        return {value: String(firedRoutes.size), sub: "firing · 24h", kind}
    }

    async _resolveOrs() {
        const all = await chrome.storage.local.get(null)
        let total = 0
        let low = 0
        for (const k in all) {
            if (k.indexOf("routeAssistant:ors:") !== 0) continue
            // Skip namespaced sub-keys that aren't ORS records (e.g. settings).
            const rec = all[k]
            if (!rec || typeof rec !== "object") continue
            const rank = Number(rec.rankAny)
            if (!Number.isFinite(rank)) continue
            total++
            if (rank >= 4) low++
        }
        if (!total) return {value: "—", sub: "no ORS scrapes", kind: "muted"}
        const kind = low === 0 ? "ok" : (low >= Math.max(3, Math.ceil(total * 0.25)) ? "alert" : "warn")
        return {value: String(low), sub: "below rank 3 · of " + total, kind}
    }

    async _resolveMaintenance() {
        if (!this.server) return {value: "—", sub: "no server", kind: "muted"}
        const all = await chrome.storage.local.get(null)
        const prefix = "aircraftFlightPlan:wearObservations:" + this.server + ":"
        let total = 0
        let risk = 0
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.samples) || !rec.samples.length) continue
            total++
            const latest = rec.samples[0]
            const ratio = Number(latest && latest.ratio)
            if (Number.isFinite(ratio) && ratio < 1) risk++
        }
        if (!total) return {value: "—", sub: "no wear samples", kind: "muted"}
        const kind = risk === 0 ? "ok" : (risk >= 3 ? "alert" : "warn")
        return {value: String(risk), sub: "at risk · of " + total, kind}
    }

    _airlineKey() {
        try {
            const a = AES.getAirlineCode()
            if (a && a.code) return a.code
        } catch (_) { /* fall through */ }
        return this.airline || ""
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
    window.CentralHubHeroStrip = CentralHubHeroStrip
}
