"use strict"

/**
 * Per-leg autopricer suggester for the AS flight-number detail page.
 *
 * Mounts on /app/com/numbers/<flightNumberId>{/<leg>}?segment=N — the page
 * the route-assistant pricing-applier targets via endpointMode "flightNumbers".
 * Self-contained: parses the visible per-class form, reads cached demand /
 * competitor / inventory signals from chrome.storage.local, computes a
 * Y/C/F/Cargo suggestion using the same math as silent-auto-proposer-per-class,
 * and renders the suggestion next to each row's "New Price" input.
 *
 * Suggest-only — never POSTs. Submission stays the user's deliberate click on
 * AS's native "Apply changes" button. Preserves CLAUDE.md §3 rule 1
 * (no new write paths).
 *
 * Class differentiation per CLAUDE.md request:
 *   - Y / C / F / Cargo each get their own elasticity, demand pool, LF, and
 *     competitor-median signals (defensive defaults when a signal is missing)
 *   - Cargo runs on its own demand curve (cargoElasticity, cargoDemandPool)
 *   - Per-class apply gates (pricing.apply.classes.<cls>.enabled) suppress
 *     suggestions before they render — defense-in-depth with the applier.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesPerLegAutopricer) return

    const NUMBERS_PATH_RE = /^\/app\/com\/numbers\/(\d+)(?:\/(\d+))?\/?$/i
    const CLASSES = ["Y", "C", "F", "Cargo"]
    const LF_ANCHOR = 0.65
    const DEFAULT_MIN_DELTA_PCT = 3
    const DEFAULT_MAX_STEP_PCT = 10
    const DEFAULT_ELASTICITY = -1.2
    const DEFAULT_MIN_DEMAND = {Y: 50, C: 10, F: 5, Cargo: 1000}

    const OWN_KEY    = "routeAssistant:markets:ownPricing:"
    const COMP_KEY   = "routeAssistant:markets:competitors:"
    const HIST_KEY   = "routeAssistant:markets:historic:"
    const DEMAND_KEY = "routeAssistant:demand:"
    const ORS_KEY    = "routeAssistant:ors:"
    const YIELD_KEY  = "routeAssistant:yieldHistory:"

    function _u(s) { return String(s == null ? "" : s).toUpperCase() }
    function _num(v) {
        if (v == null || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function _normaliseClassKey(raw) {
        const s = String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, " ")
        if (!s) return null
        if (s === "Y" || s === "ECONOMY" || s === "ECONOMY CLASS") return "Y"
        if (s === "C" || s === "BUSINESS" || s === "BUSINESS CLASS") return "C"
        if (s === "F" || s === "FIRST" || s === "FIRST CLASS") return "F"
        if (/^(CARGO|FREIGHT|MAIL|FRACHT)$/.test(s)) return "Cargo"
        return null
    }

    function _parsePrice(text, cls) {
        const s = String(text == null ? "" : text).replace(/[^\d.,-]/g, "").replace(",", ".")
        if (!s) return null
        const n = Number(s)
        if (!isFinite(n)) return null
        return cls === "Cargo" ? n : Math.round(n)
    }

    function _routeFromForm() {
        // Probe in priority order. Each source returns at most two IATAs;
        // first two found win. Sources, best → fallback:
        //   1. <a href="/app/info/airports/.../IATA"> link pairs anywhere on page
        //   2. Pricing fieldset text (markets-style "Route: AAA → BBB" header)
        //   3. Page <h1>/<h2>/<h3>
        //   4. document.title
        // The airport-link approach is robust: AS always anchors origin /
        // destination with full airport-info links, even when the heading
        // is just the flight-number's nickname.
        const out = []
        const pushIata = (raw) => {
            const code = String(raw || "").toUpperCase()
            if (/^[A-Z]{3}$/.test(code) && out.indexOf(code) < 0) out.push(code)
        }

        // 1. airport-info anchor pairs — most reliable
        // Code priority: parenthesized IATA in anchor text (most specific) →
        // 3-letter token anywhere in the href (catches both /airports/JFK
        // and /airports/123/JFK shapes) → null (skip).
        const anchorIatas = []
        for (const a of document.querySelectorAll('a[href*="/app/info/airports/"], a[href*="/info/airports/"]')) {
            const href = a.getAttribute("href") || ""
            const text = (a.textContent || "").trim()
            const fromText = /\(([A-Z]{3})\)/.exec(text) || /\b([A-Z]{3})\b/.exec(text)
            let code = fromText ? fromText[1] : null
            if (!code) {
                const hrefMatches = href.match(/\b([A-Z]{3})\b/g) || []
                if (hrefMatches.length) code = hrefMatches[hrefMatches.length - 1]
            }
            if (code && /^[A-Z]{3}$/.test(code.toUpperCase())) {
                anchorIatas.push(code.toUpperCase())
                if (anchorIatas.length >= 4) break
            }
        }
        for (const c of anchorIatas) {
            pushIata(c)
            if (out.length >= 2) break
        }
        if (out.length >= 2) return {hub: out[0], dest: out[1], source: "anchor"}

        // 2/3/4 — text scrape with explicit O&D markers
        const fs = _findPricingFieldset()
        const sources = [
            fs ? (fs.innerText || fs.textContent || "") : "",
            (() => {
                const panels = Array.from(document.querySelectorAll("fieldset, .as-panel, .panel"))
                const hit = panels.find(el => /route\s*map|[A-Z]{3}\s*[-–—→]\s*[A-Z]{3}/i.test(el.innerText || el.textContent || ""))
                return hit ? (hit.innerText || hit.textContent || "") : ""
            })(),
            (() => { const h = document.querySelector("h1, h2, h3"); return h ? (h.innerText || h.textContent || "") : "" })(),
            document.title || "",
            document.body ? (document.body.innerText || document.body.textContent || "") : ""
        ]
        const arrowRe = /\b([A-Z]{3})\s*(?:→|[-–—]>?|to)\s*([A-Z]{3})\b/i
        for (const src of sources) {
            const m = arrowRe.exec(src)
            if (m) { pushIata(m[1]); pushIata(m[2]); break }
            // Loose fallback: parenthesized IATA pairs in order
            const parenRe = /\(([A-Z]{3})\)/g
            let pm
            while ((pm = parenRe.exec(src))) {
                pushIata(pm[1])
                if (out.length >= 2) break
            }
            if (out.length >= 2) break
        }
        if (out.length < 2) return null
        return {hub: out[0], dest: out[1], source: out.length >= 2 ? "text" : "partial"}
    }

    function _findPricingFieldset() {
        for (const fs of document.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (legend && /^pricing$/i.test((legend.textContent || "").trim())) return fs
        }
        return null
    }

    function _readCurrentPrices() {
        const fs = _findPricingFieldset()
        if (!fs) return null
        const out = {}
        const rows = []
        for (const tr of fs.querySelectorAll("table tbody tr")) {
            const cells = tr.querySelectorAll("td")
            if (cells.length < 3) continue
            const cls = _normaliseClassKey(cells[0].textContent)
            if (!cls) continue
            const cur = _parsePrice(cells[1].textContent, cls)
            const newInput = cells[2].querySelector("input[type='text']")
            const originalInputValue = newInput
                ? (newInput.value || newInput.getAttribute("value") || "")
                : null
            const editable = newInput
                ? _parsePrice(originalInputValue, cls)
                : null
            out[cls] = editable != null ? editable : cur
            rows.push({cls, tr, currentCell: cells[1], newInput, originalInputValue})
        }
        return Object.keys(out).length ? {prices: out, rows} : null
    }

    async function _readStorageRoute(hub, dest) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            return {ownPricing: null, competitors: null, historic: null, demand: null, ors: null, yieldHistory: null}
        }
        const pair = _u(hub) + "-" + _u(dest)
        let all = {}
        try { all = await new Promise((res, rej) => {
            chrome.storage.local.get(null, v => {
                if (chrome.runtime.lastError) rej(chrome.runtime.lastError)
                else res(v || {})
            })
        }) } catch (_) { return {ownPricing: null, competitors: null, historic: null, demand: null, ors: null, yieldHistory: null} }
        const acctId = window.__aesAccountId || null
        const pickFamily = (prefix) => {
            const scoped = acctId ? prefix + "acct:" + acctId + ":" + pair : null
            const legacy = prefix + pair
            if (scoped && all[scoped]) return all[scoped]
            if (all[legacy]) return all[legacy]
            const suffix = ":" + pair
            for (const k in all) {
                if (k.indexOf(prefix) !== 0) continue
                if (!k.endsWith(suffix)) continue
                if (k.indexOf(":acct:") !== -1 && (!acctId || k.indexOf(":acct:" + acctId + ":") < 0)) continue
                return all[k]
            }
            return null
        }
        return {
            ownPricing:  pickFamily(OWN_KEY),
            competitors: pickFamily(COMP_KEY),
            historic:    pickFamily(HIST_KEY),
            ors:         pickFamily(ORS_KEY),
            yieldHistory: pickFamily(YIELD_KEY),
            demand:      all[DEMAND_KEY + _u(dest)] || null
        }
    }

    function _competitorMedian(rec, cls) {
        if (!rec || !Array.isArray(rec.competitors)) return null
        const vals = []
        for (const c of rec.competitors) {
            if (!c || c.isOurs) continue
            const ck = c.isCargo === true
                ? "Cargo"
                : _normaliseClassKey(c.serviceClass || c.cabin || c.classKey || c["class"])
            if (ck !== cls) continue
            const p = _num(c.price != null ? c.price : c.fare)
            if (p != null && p > 0) vals.push(p)
        }
        if (!vals.length) return null
        vals.sort((a, b) => a - b)
        const mid = Math.floor(vals.length / 2)
        const raw = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
        return cls === "Cargo" ? Math.round(raw * 100) / 100 : Math.round(raw)
    }

    function _normaliseOrsPriceIndex(idx) {
        if (!idx || typeof idx !== "object") return null
        const classes = idx.classes || idx.byClass || {}
        const prices = Object.assign({}, idx.competitorPricesByClass || {})
        const counts = Object.assign({}, idx.competitorCountsByClass || {})
        for (const cls of CLASSES) {
            const c = classes && classes[cls]
            if (!c) continue
            const p = _num(c.competitorMedianPrice != null ? c.competitorMedianPrice
                : (c.competitorMedian != null ? c.competitorMedian : c.bestCompetitorPrice))
            const n = _num(c.competitorCount != null ? c.competitorCount : c.competitorConnectionCount)
            if (prices[cls] == null && p != null && p > 0 && (cls !== "Cargo" || p < 10)) {
                prices[cls] = cls === "Cargo" ? Math.round(p * 100) / 100 : Math.round(p)
            }
            if (counts[cls] == null && n != null) counts[cls] = n
        }
        return Object.assign({}, idx, {
            classes,
            byClass: idx.byClass || classes,
            competitorPricesByClass: prices,
            competitorCountsByClass: counts
        })
    }

    function _orsPriceIndex(rec, currentPrices) {
        if (!rec) return null
        const embedded = _normaliseOrsPriceIndex(rec.pricingIndex)
        if (embedded) return embedded
        if (typeof window === "undefined") return null
        if (window.RouteAssistantOrsPriceIndex
                && typeof window.RouteAssistantOrsPriceIndex.indexRecord === "function") {
            try { return _normaliseOrsPriceIndex(window.RouteAssistantOrsPriceIndex.indexRecord(rec, {currentPrices: currentPrices || {}})) }
            catch (_) { /* best-effort */ }
        }
        if (window.RouteAssistantOrsScraper
                && typeof window.RouteAssistantOrsScraper.buildPricingIndex === "function") {
            try { return _normaliseOrsPriceIndex(window.RouteAssistantOrsScraper.buildPricingIndex(rec)) }
            catch (_) { /* best-effort */ }
        }
        return null
    }

    function _combinedCompetitorMedian(cls, competitorRec, orsIndex) {
        const market = _competitorMedian(competitorRec, cls)
        const orsMap = orsIndex && orsIndex.competitorPricesByClass || {}
        const ors = _num(orsMap[cls])
        if (market != null && ors != null && ors > 0) {
            const blended = market * 0.6 + ors * 0.4
            return cls === "Cargo" && Math.abs(blended) < 10
                ? Math.round(blended * 100) / 100
                : Math.round(blended)
        }
        return market != null ? market : (ors != null && ors > 0 ? ors : null)
    }

    function _classElasticity(cls, demand) {
        if (!demand) return DEFAULT_ELASTICITY
        if (cls === "Cargo") {
            const v = _num(demand.cargoElasticity)
            if (v != null && v < 0) return v
            return DEFAULT_ELASTICITY
        }
        const byCls = demand.priceElasticityByClass
        if (byCls && byCls[cls] != null) {
            const v = _num(byCls[cls])
            if (v != null && v < 0) return v
        }
        const v = _num(demand.paxElasticity)
        if (v != null && v < 0) return v
        return DEFAULT_ELASTICITY
    }

    function _classDemandPool(cls, demand) {
        if (!demand) return null
        const byCls = demand.demandPoolByClass
        if (byCls && byCls[cls] != null) {
            const v = _num(byCls[cls])
            if (v != null) return v
        }
        if (cls === "Cargo") return _num(demand.cargoDemandPool)
        return _num(demand.paxDemandPool)
    }

    function _classRmTightness(cls, demand) {
        if (!demand) return null
        const byCls = demand.rmTightnessByClass
        if (byCls && byCls[cls] != null) {
            const v = _num(byCls[cls])
            if (v != null) return v
        }
        return _num(demand.rmTightness)
    }

    function _loadSignal(rmTightness) {
        const t = _num(rmTightness)
        if (t == null) return 0
        const clamped = Math.max(0, Math.min(1, t))
        return (clamped - LF_ANCHOR) * 80
    }

    function _elasticityScale(eps) {
        const e = _num(eps)
        if (e == null || e >= 0) return 0.5
        return 1 / (1 + Math.abs(e))
    }

    function _classGate(cls, settings) {
        const cls_apply = settings && settings.pricing && settings.pricing.apply
            && settings.pricing.apply.classes && settings.pricing.apply.classes[cls]
        if (cls_apply && cls_apply.enabled === false) return {enabled: false}
        const cap = cls_apply && _num(cls_apply.maxMove)
        return {enabled: true, cap: cap != null && cap > 0 ? cap : null}
    }

    function _roundForClass(cls, current, deltaPct) {
        const raw = current * (1 + deltaPct / 100)
        const scale = cls === "Cargo" && current < 10 ? 100 : 1
        const rounded = deltaPct > 0
            ? Math.floor(raw * scale) / scale
            : deltaPct < 0
                ? Math.ceil(raw * scale) / scale
                : Math.round(raw * scale) / scale
        const minPrice = scale === 1 ? 1 : 1 / scale
        return Math.max(minPrice, rounded)
    }

    function _orsClassKeys(classKey) {
        switch (String(classKey || "")) {
            case "Y": return ["ECONOMY", "Y"]
            case "C": return ["BUSINESS", "C"]
            case "F": return ["FIRST", "F"]
            case "Cargo": return ["CARGO", "Cargo"]
            default: return []
        }
    }

    function _orsPrimary(rec, classKey) {
        if (!rec) return null
        const byClass = rec.byClass && typeof rec.byClass === "object" ? rec.byClass : null
        let primary = null
        if (byClass) {
            const preferred = _orsClassKeys(classKey)
            for (const k of preferred) {
                if (byClass[k]) { primary = byClass[k]; break }
            }
            if (!primary && preferred.length) return null
            if (!primary) primary = byClass.ECONOMY || byClass.Y || byClass.BUSINESS || byClass.FIRST || null
        }
        const from = primary || rec
        const rank = _num(from && from.rankAny != null ? from.rankAny : rec.rankAny)
        const gap = _num(from && from.ratingGapToTop != null ? from.ratingGapToTop : rec.ratingGapToTop)
        const our = _num(from && from.ourTopRating != null ? from.ourTopRating : rec.ourTopRating)
        const top = _num(from && from.topCompetitorRating != null ? from.topCompetitorRating : rec.topCompetitorRating)
        const ratingGap = gap != null ? gap : (our != null && top != null ? our - top : null)
        if (rank == null && ratingGap == null) return null
        return {
            rankAny: rank,
            ratingGapToTop: ratingGap,
            scrapedAt: _num(rec.scrapedAt),
            weak: (rank != null && rank >= 8) || (ratingGap != null && ratingGap <= -6),
            severe: (rank != null && rank >= 15) || (ratingGap != null && ratingGap <= -12),
            strong: (rank != null && rank <= 3) || (ratingGap != null && ratingGap >= -2)
        }
    }

    function _orsByPriceClass(rec) {
        if (!rec || !rec.byClass) return null
        const out = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const summary = _orsPrimary(rec, cls)
            if (summary) out[cls] = summary
        }
        return Object.keys(out).length ? out : null
    }

    function _yieldSummary(rec) {
        if (!rec || !Array.isArray(rec.snapshots) || !rec.snapshots.length) return null
        const snapshots = rec.snapshots.slice()
            .filter(Boolean)
            .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
        if (!snapshots.length) return null
        const latest = snapshots[snapshots.length - 1]
        let prev = null
        for (let i = snapshots.length - 2; i >= 0; i--) {
            if (_num(snapshots[i].profitPerFlight) != null) { prev = snapshots[i]; break }
        }
        const latestProfitPerFlight = _num(latest.profitPerFlight)
        const previousProfitPerFlight = _num(prev && prev.profitPerFlight)
        const recent = snapshots.slice(Math.max(0, snapshots.length - 4))
            .map(s => _num(s.profitPerFlight))
            .filter(v => v != null)
        const avgProfitPerFlight = recent.length
            ? recent.reduce((sum, v) => sum + v, 0) / recent.length
            : null
        let trendPct = null
        if (latestProfitPerFlight != null && previousProfitPerFlight != null
                && Math.abs(previousProfitPerFlight) > 1) {
            trendPct = ((latestProfitPerFlight - previousProfitPerFlight)
                / Math.abs(previousProfitPerFlight)) * 100
        }
        const lossMaking = (latestProfitPerFlight != null && latestProfitPerFlight < 0)
            || (avgProfitPerFlight != null && avgProfitPerFlight < 0)
        const profitable = (latestProfitPerFlight != null && latestProfitPerFlight > 0)
            || (avgProfitPerFlight != null && avgProfitPerFlight > 0)
        return {
            sampleCount: snapshots.length,
            lastSnapshotAt: latest.timestamp || rec.lastSnapshotAt || null,
            latestProfitPerFlight,
            avgProfitPerFlight,
            trendPct,
            lossMaking,
            profitable,
            deteriorating: trendPct != null && trendPct <= -15,
            improving: trendPct != null && trendPct >= 15,
            attributionMode: latest.attributionMode || latest.mode || null
        }
    }

    function _routeSignals(stored, priceContext, currentPrices) {
        const orsByClass = _orsByPriceClass(stored && stored.ors)
        const ors = _orsPrimary(stored && stored.ors)
            || (orsByClass && (orsByClass.Y || orsByClass.C || orsByClass.F || orsByClass.Cargo))
            || null
        const orsPriceIndex = _orsPriceIndex(stored && stored.ors, currentPrices || {})
        const yieldHistory = _yieldSummary(stored && stored.yieldHistory)
        return {
            ors,
            orsByClass,
            orsPriceIndex,
            yieldHistory,
            priceContext: priceContext || null,
            labels: [
                stored && stored.demand ? "demand" : null,
                stored && stored.competitors ? "competition" : null,
                orsPriceIndex ? "ORS-price" : null,
                stored && stored.historic ? "historic" : null,
                yieldHistory ? "yield" : null,
                (ors || orsByClass) ? "ORS" : null,
                priceContext && priceContext.signals && priceContext.signals.schedule ? "schedule" : null
            ].filter(Boolean)
        }
    }

    function _historyPriceSignal(cls, current, demand, routeSignals) {
        const ctx = routeSignals && routeSignals.priceContext
        const hist = ctx && ctx.historyByClass && ctx.historyByClass[cls]
        const avg = hist && _num(hist.avgPrice)
        if (current == null || current <= 0 || avg == null || avg <= 0) return null
        let delta = ((avg - current) / current) * 100
        if (!isFinite(delta)) return null
        delta = Math.max(-12, Math.min(12, delta))
        const lf = _classRmTightness(cls, demand)
        const dampedForWeakLoad = delta > 0 && lf != null && lf < 0.55
        if (dampedForWeakLoad) delta *= 0.35
        return {
            avgPrice: avg,
            lastPrice: hist.lastPrice,
            deltaPct: delta,
            trendPct: hist.priceTrendPct,
            dampedForWeakLoad
        }
    }

    function _routeSignalPolicy(cls, rawDelta, routeSignals) {
        const notes = []
        let factor = 1
        let block = null
        const ors = routeSignals && routeSignals.ors
        const y = routeSignals && routeSignals.yieldHistory
        const passenger = cls !== "Cargo"
        if (rawDelta > 0) {
            if (passenger && ors && ors.severe) {
                factor *= 0.45
                notes.push("poor ORS")
            } else if (passenger && ors && ors.weak) {
                factor *= 0.70
                notes.push("weak ORS")
            }
            if (y && (y.lossMaking || y.deteriorating)) {
                factor *= 0.75
                notes.push("weak yield history")
            }
            if (passenger && ors && ors.weak && y && y.lossMaking) {
                block = "weak ORS plus negative yield history"
            }
        } else if (rawDelta < 0) {
            if (passenger && ors && ors.strong) {
                factor *= 0.80
                notes.push("strong ORS")
            }
            if (y && y.profitable && !y.deteriorating) {
                factor *= 0.85
                notes.push("profitable yield history")
            }
        }
        return {factor, notes, block}
    }

    function _computeOne(cls, current, demand, competitorMedian, gate, cfg, routeSignals) {
        if (current == null || current <= 0) return {skipReason: "no current price"}
        if (!gate.enabled) return {skipReason: cls + " disabled by per-class apply gate"}
        const pool = _classDemandPool(cls, demand)
        const minDemand = DEFAULT_MIN_DEMAND[cls] || 0
        if (pool != null && pool <= minDemand) {
            return {skipReason: "demand pool " + Math.round(pool) + " ≤ " + minDemand}
        }
        const eps = _classElasticity(cls, demand)
        const lf  = _classRmTightness(cls, demand)
        let raw = _elasticityScale(eps) * _loadSignal(lf)
        let usedComp = false
        if (competitorMedian != null && competitorMedian > 0) {
            const compDelta = ((competitorMedian - current) / current) * 100
            raw = 0.5 * raw + 0.5 * compDelta
            usedComp = true
        }
        const classSignals = routeSignals && routeSignals.orsByClass && routeSignals.orsByClass[cls]
            ? Object.assign({}, routeSignals, {ors: routeSignals.orsByClass[cls]})
            : (routeSignals || null)
        const historySignal = _historyPriceSignal(cls, current, demand, classSignals)
        if (historySignal) {
            raw = 0.75 * raw + 0.25 * historySignal.deltaPct
        }
        const signalPolicy = _routeSignalPolicy(cls, raw, classSignals)
        if (signalPolicy.block) {
            return {skipReason: "route signals blocked move: " + signalPolicy.block}
        }
        raw *= signalPolicy.factor
        const minDelta = _num(cfg.minDeltaPct) != null ? cfg.minDeltaPct : DEFAULT_MIN_DELTA_PCT
        if (Math.abs(raw) + 1e-9 < minDelta) {
            return {skipReason: "|Δ| " + raw.toFixed(1) + "% < min " + minDelta + "%"}
        }
        const cap = gate.cap != null ? gate.cap
            : (_num(cfg.maxStepPct) != null ? cfg.maxStepPct : DEFAULT_MAX_STEP_PCT)
        const clamped = Math.max(-cap, Math.min(cap, raw))
        const newPrice = _roundForClass(cls, current, clamped)
        if (Math.abs(newPrice - current) < (cls === "Cargo" && current < 10 ? 0.005 : 0.5)) {
            return {skipReason: "after clamp + round, no change"}
        }
        return {
            newPrice,
            deltaPct: clamped,
            elasticity: eps,
            loadFactor: lf,
            demandPool: pool,
            competitorMedian: usedComp ? competitorMedian : null,
            historyAvgPrice: historySignal && historySignal.avgPrice != null ? historySignal.avgPrice : null,
            historyDeltaPct: historySignal && historySignal.deltaPct != null ? historySignal.deltaPct : null,
            historyDampedForWeakLoad: !!(historySignal && historySignal.dampedForWeakLoad),
            cap,
            routeSignalFactor: signalPolicy.factor,
            routeSignalNotes: signalPolicy.notes
        }
    }

    async function _loadPricingCfg() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return {}
        const acct = window.__aesAccountId || ""
        const keys = [
            "routeAssistantSettings",
            acct ? "routeAssistantSettings:acct:" + acct : null
        ].filter(Boolean)
        try {
            const v = await new Promise((res) => chrome.storage.local.get(keys, res))
            const merged = Object.assign({}, v[keys[0]] || {}, v[keys[1]] || {})
            return merged
        } catch (_) { return {} }
    }

    function _injectStyles() {
        if (document.getElementById("aes-perleg-autopricer-style")) return
        const s = document.createElement("style")
        s.id = "aes-perleg-autopricer-style"
        s.textContent = `
            .aes-perleg-suggest { display:inline-block; margin-left:8px; padding:1px 6px; font-size:11px;
                border:1px solid #2563eb; color:#1d4ed8; background:#eff6ff; border-radius:3px;
                cursor:pointer; vertical-align:middle; user-select:none; }
            .aes-perleg-suggest:hover { background:#dbeafe; }
            .aes-perleg-suggest[data-state="skip"] { color:#92400e; background:#fef3c7; border-color:#f59e0b; cursor:help; }
            .aes-perleg-suggest[data-state="error"] { color:#991b1b; background:#fee2e2; border-color:#dc2626; }
            .aes-perleg-applied { color:#065f46; background:#d1fae5; border-color:#10b981; }
            .aes-perleg-banner { padding:6px 10px; margin:6px 0; border:1px solid #cbd5e1; background:#f1f5f9;
                font-size:12px; line-height:1.4; border-radius:3px; }
            .aes-perleg-banner b { color:#0f172a; }
            .aes-perleg-actions { margin-top:6px; display:flex; gap:6px; }
            .aes-perleg-actions button { font-size:11px; padding:2px 8px; border-radius:3px;
                border:1px solid #94a3b8; background:#fff; color:#0f172a; cursor:pointer; }
            .aes-perleg-actions button:hover { background:#f1f5f9; }
            .aes-perleg-actions .aes-perleg-apply-all { border-color:#1d4ed8; color:#1d4ed8; }
            .aes-perleg-actions .aes-perleg-apply-all:hover { background:#dbeafe; }
        `
        document.head.appendChild(s)
    }

    function _renderRowSuggestion(row, suggestion, applyClick) {
        let chip = row.tr.querySelector(".aes-perleg-suggest")
        if (!chip) {
            chip = document.createElement("span")
            chip.className = "aes-perleg-suggest"
            const targetCell = row.newInput && row.newInput.parentElement || row.tr.cells[2]
            if (targetCell) targetCell.appendChild(chip)
        }
        chip.removeAttribute("data-state")
        if (suggestion.skipReason) {
            chip.dataset.state = "skip"
            chip.title = suggestion.skipReason
            chip.textContent = "—"
            chip.onclick = null
            return
        }
        const sign = suggestion.deltaPct > 0 ? "+" : ""
        chip.textContent = "→ " + (row.cls === "Cargo"
            ? Number(suggestion.newPrice).toFixed(suggestion.newPrice < 10 ? 2 : 0)
            : Math.round(suggestion.newPrice))
            + " (" + sign + suggestion.deltaPct.toFixed(1) + "%)"
        chip.title = "Click to copy into the New Price field. "
            + "ε=" + (suggestion.elasticity != null ? suggestion.elasticity.toFixed(2) : "?")
            + ", LF=" + (suggestion.loadFactor != null ? Math.round(suggestion.loadFactor * 100) + "%" : "?")
            + (suggestion.competitorMedian != null ? ", comp=" + suggestion.competitorMedian : "")
            + (suggestion.historyAvgPrice != null ? ", histAvg=" + suggestion.historyAvgPrice : "")
            + (suggestion.historyDampedForWeakLoad ? " (history raise damped by low load)" : "")
            + (suggestion.routeSignalNotes && suggestion.routeSignalNotes.length
                ? ", controls=" + suggestion.routeSignalNotes.join("/")
                : "")
            + ", cap=±" + suggestion.cap + "%"
        chip.onclick = () => applyClick(row, suggestion)
    }

    function _writePriceInto(row, suggestion) {
        if (!row.newInput) return false
        const v = row.cls === "Cargo"
            ? (Math.round(Number(suggestion.newPrice) * 100) / 100).toFixed(2).replace(/\.?0+$/, "")
            : String(Math.round(Number(suggestion.newPrice)))
        row.newInput.value = v
        row.newInput.dispatchEvent(new Event("input", {bubbles: true}))
        row.newInput.dispatchEvent(new Event("change", {bubbles: true}))
        const chip = row.tr.querySelector(".aes-perleg-suggest")
        if (chip) chip.classList.add("aes-perleg-applied")
        return true
    }

    function _formatSharedContextLine(routeSignals) {
        const ctx = routeSignals && routeSignals.priceContext
        if (!ctx) return ""
        const parts = []
        const signals = ctx.signals && ctx.signals.labels || []
        if (signals.length) parts.push("context: " + signals.join("/"))
        if (ctx.ors && ctx.ors.rankAny != null) parts.push("ORS rank " + ctx.ors.rankAny)
        if (ctx.yieldHistory && ctx.yieldHistory.latestProfitPerFlight != null) {
            parts.push("history $" + ctx.yieldHistory.latestProfitPerFlight + "/flt")
        }
        if (ctx.schedule && ctx.schedule.weeklyFlights != null) {
            parts.push(ctx.schedule.weeklyFlights + "/wk scheduled")
        }
        const advice = ctx.adviceByClass || {}
        const adviceBits = []
        for (const cls of CLASSES) {
            if (!advice[cls] || advice[cls].stance === "hold") continue
            adviceBits.push(cls + ":" + advice[cls].stance)
        }
        if (adviceBits.length) parts.push(adviceBits.join(" "))
        return parts.join(" · ")
    }

    function _renderBanner(panel, route, summary, suggestionsByCls, rowsByCls, originalPrices, routeSignals) {
        let banner = panel.querySelector(".aes-perleg-banner")
        if (!banner) {
            banner = document.createElement("div")
            banner.className = "aes-perleg-banner"
            panel.insertBefore(banner, panel.firstChild)
        }
        banner.innerHTML = ""
        const headline = document.createElement("div")
        headline.className = "aes-perleg-headline"
        const b = document.createElement("b")
        b.textContent = "AES per-class autopricer"
        headline.appendChild(b)
        const txt = document.createElement("span")
        txt.style.marginLeft = "8px"
        txt.textContent = summary
        headline.appendChild(txt)
        banner.appendChild(headline)

        const ctxLine = _formatSharedContextLine(routeSignals)
        if (ctxLine) {
            const ctx = document.createElement("div")
            ctx.className = "aes-perleg-context"
            ctx.style.cssText = "margin-top:3px;color:#475569;font-size:11px;"
            ctx.textContent = ctxLine
            banner.appendChild(ctx)
        }

        const movable = Object.keys(suggestionsByCls).filter(k => suggestionsByCls[k] && !suggestionsByCls[k].skipReason)
        if (!movable.length) return

        const actions = document.createElement("div")
        actions.className = "aes-perleg-actions"

        const applyAll = document.createElement("button")
        applyAll.type = "button"
        applyAll.className = "btn btn-xs aes-perleg-apply-all"
        applyAll.textContent = "Apply all (" + movable.length + ")"
        applyAll.title = "Copy all " + movable.join("/") + " suggestions into the New Price fields. "
            + "You still click AS's native Apply button to submit."
        applyAll.addEventListener("click", () => {
            for (const cls of movable) _writePriceInto(rowsByCls[cls], suggestionsByCls[cls])
        })

        const restore = document.createElement("button")
        restore.type = "button"
        restore.className = "btn btn-xs aes-perleg-restore"
        restore.textContent = "Restore"
        restore.title = "Reset every New Price field back to what AS had on page load"
        restore.addEventListener("click", () => {
            for (const cls of Object.keys(rowsByCls)) {
                const row = rowsByCls[cls]
                if (!row || !row.newInput) continue
                const orig = originalPrices[cls]
                if (orig == null) continue
                const v = row.originalInputValue != null && row.originalInputValue !== ""
                    ? row.originalInputValue
                    : cls === "Cargo"
                        ? (Math.round(Number(orig) * 100) / 100).toFixed(2).replace(/\.?0+$/, "")
                        : String(Math.round(Number(orig)))
                row.newInput.value = v
                row.newInput.dispatchEvent(new Event("input", {bubbles: true}))
                row.newInput.dispatchEvent(new Event("change", {bubbles: true}))
                const chip = row.tr.querySelector(".aes-perleg-suggest")
                if (chip) chip.classList.remove("aes-perleg-applied")
            }
        })

        actions.appendChild(applyAll)
        actions.appendChild(restore)
        banner.appendChild(actions)
    }

    async function run() {
        const m = NUMBERS_PATH_RE.exec(location.pathname)
        if (!m) return null
        const fieldset = _findPricingFieldset()
        if (!fieldset) return null
        const route = _routeFromForm()
        if (!route) {
            console.warn("[AES per-leg autopricer] could not detect O&D from form; skipping")
            return null
        }
        const priceCtx = _readCurrentPrices()
        if (!priceCtx) return null
        const settings = await _loadPricingCfg()
        const cfg = {
            minDeltaPct: settings && settings.pricing && settings.pricing.silentAutoMinDeltaPct,
            maxStepPct:  settings && settings.pricing && settings.pricing.silentAutoMaxStepPct
        }
        const stored = await _readStorageRoute(route.hub, route.dest)
        let priceContext = null
        try {
            if (window.AesPriceDiagnostics && typeof window.AesPriceDiagnostics.buildRouteContext === "function") {
                priceContext = await window.AesPriceDiagnostics.buildRouteContext(route.hub, route.dest)
            }
        } catch (_) { priceContext = null }
        const routeSignals = _routeSignals(stored, priceContext, priceCtx.prices)
        const demand = stored.demand || {}
        const movedClasses = []
        const skipped = []
        const sugByCls = {}
        const rowByCls = {}
        const originalPrices = Object.assign({}, priceCtx.prices)
        _injectStyles()
        for (const row of priceCtx.rows) {
            const compMed = _combinedCompetitorMedian(row.cls, stored.competitors, routeSignals.orsPriceIndex)
            const gate = _classGate(row.cls, settings)
            const sug = _computeOne(row.cls, priceCtx.prices[row.cls], demand, compMed, gate, cfg, routeSignals)
            _renderRowSuggestion(row, sug, _writePriceInto)
            sugByCls[row.cls] = sug
            rowByCls[row.cls] = row
            if (sug.skipReason) skipped.push(row.cls)
            else movedClasses.push(row.cls)
        }
        const oneline = movedClasses.length
            ? "Suggesting moves on " + movedClasses.join("/") + " · "
                + (skipped.length ? "holding " + skipped.join("/") : "all-class fit")
            : "No suggested moves (signals all hold)."
        _renderBanner(fieldset, route,
            oneline + " · " + route.hub + " → " + route.dest
                + (routeSignals.labels.length ? " · signals: " + routeSignals.labels.join("/") : "")
                + (stored.demand ? "" : " · no cached demand — run RA panel sync once"),
            sugByCls, rowByCls, originalPrices, routeSignals)
        return {route, prices: priceCtx.prices, movedClasses, skipped, suggestions: sugByCls, routeSignals}
    }

    function _ready(fn) {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, {once: true})
        else fn()
    }

    window.AesPerLegAutopricer = {
        run,
        _readCurrentPrices,
        _routeFromForm,
        _classElasticity,
        _classDemandPool,
        _classRmTightness,
        _loadSignal,
        _elasticityScale,
        _computeOne,
        _routeSignals,
        _historyPriceSignal,
        _orsPrimary,
        _orsByPriceClass,
        _orsPriceIndex,
        _combinedCompetitorMedian,
        _yieldSummary,
        _routeSignalPolicy,
        _normaliseClassKey,
        CLASSES,
        LF_ANCHOR
    }

    _ready(() => {
        if (NUMBERS_PATH_RE.test(location.pathname)) {
            run().catch(e => console.warn("[AES per-leg autopricer] run failed", e))
        }
    })
})()
