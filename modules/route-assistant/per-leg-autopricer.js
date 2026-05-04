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
 * Renders suggestions by default and can, on an explicit user click, send the
 * current visible leg through RouteAssistantPricingApplier's existing
 * `endpoint: "flightNumbers"` write path. No auto-on-open writes.
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

    const OWN_SCOPE      = "routeAssistant:markets:ownPricing"
    const FN_PRICE_SCOPE = "routeAssistant:flightNumbers:pricing"
    const OWN_KEY        = OWN_SCOPE + ":"
    const COMP_KEY       = "routeAssistant:markets:competitors:"
    const HIST_KEY       = "routeAssistant:markets:historic:"
    const DEMAND_KEY     = "routeAssistant:demand:"
    const ORS_KEY        = "routeAssistant:ors:"
    const YIELD_KEY      = "routeAssistant:yieldHistory:"

    let _lastApplyState = null
    let _confirmApplyKey = null
    let _applyInFlight = false

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

    function _parseNumbersUrl(loc) {
        const l = loc || (typeof location !== "undefined" ? location : {}) || {}
        const path = String(l.pathname || "")
        const m = NUMBERS_PATH_RE.exec(path)
        if (!m) return null
        let legIndex = m[2] != null && m[2] !== "" ? parseInt(m[2], 10) : null
        if (legIndex == null || !isFinite(legIndex)) {
            const search = String(l.search || "")
            const sm = /(?:[?&])segment=(\d+)/i.exec(search)
            legIndex = sm ? parseInt(sm[1], 10) : 0
        }
        if (!isFinite(legIndex) || legIndex < 0) legIndex = 0
        return {
            flightNumberId: String(m[1]),
            legIndex: Math.max(0, legIndex),
            path
        }
    }

    function _serverFromLocation(loc) {
        const l = loc || (typeof location !== "undefined" ? location : {}) || {}
        const host = String(l.hostname || "")
        const m = /^([^.]+)\.airlinesim\.aero$/i.exec(host)
        return m ? m[1] : null
    }

    function _formatPriceForClass(cls, value) {
        const n = Number(value)
        if (!isFinite(n)) return ""
        return cls === "Cargo"
            ? (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "")
            : String(Math.round(n))
    }

    function _normaliseSuggestedPrice(cls, value) {
        const n = Number(value)
        if (!isFinite(n)) return null
        if (typeof window !== "undefined"
                && window.RouteAssistantPricingPlumbing
                && typeof window.RouteAssistantPricingPlumbing.normalisePriceForClass === "function") {
            const p = window.RouteAssistantPricingPlumbing.normalisePriceForClass(cls, n)
            return isFinite(p) ? p : null
        }
        return cls === "Cargo" ? Math.round(n * 100) / 100 : Math.round(n)
    }

    function _suggestionsToPriceMap(suggestionsByCls) {
        const out = {}
        const src = suggestionsByCls || {}
        for (const cls of CLASSES) {
            const sug = src[cls]
            if (!sug || sug.skipReason) continue
            const price = _normaliseSuggestedPrice(cls, sug.newPrice)
            if (price == null || price <= 0) continue
            out[cls] = price
        }
        return out
    }

    function _applyRequestKey(route, target, prices) {
        const r = route || {}
        const t = target || {}
        const p = prices || {}
        return [
            _u(r.hub),
            _u(r.dest),
            t.flightNumberId || "",
            t.legIndex == null ? 0 : t.legIndex,
            CLASSES.map(cls => cls + "=" + (p[cls] == null ? "" : _formatPriceForClass(cls, p[cls]))).join(",")
        ].join("|")
    }

    function _pairKey(routeOrHub, dest) {
        if (typeof routeOrHub === "object" && routeOrHub) {
            return _u(routeOrHub.hub) + "-" + _u(routeOrHub.dest)
        }
        return _u(routeOrHub) + "-" + _u(dest)
    }

    function _cleanPriceMap(prices) {
        const out = {}
        const src = prices || {}
        for (const cls of CLASSES) {
            if (src[cls] == null || src[cls] === "") continue
            const n = _normaliseSuggestedPrice(cls, src[cls])
            if (n != null && isFinite(n)) out[cls] = n
        }
        return out
    }

    function _legacyScopedKey(scope, suffix) {
        return String(scope || "") + ":" + String(suffix || "")
    }

    function _acctScopedKey(scope, suffix) {
        if (typeof window !== "undefined"
                && window.AesAccountKey
                && typeof window.AesAccountKey.acctKey === "function") {
            try { return window.AesAccountKey.acctKey(scope, suffix) }
            catch (_) { /* fall through */ }
        }
        if (typeof acctKey === "function") {
            try { return acctKey(scope, suffix) }
            catch (_) { /* fall through */ }
        }
        return _legacyScopedKey(scope, suffix)
    }

    function _flightSlotKey(server, target) {
        const t = target || {}
        return [
            server || _serverFromLocation(typeof location !== "undefined" ? location : null) || "unknown",
            t.flightNumberId || "",
            t.legIndex == null ? 0 : t.legIndex
        ].join(":")
    }

    function _pruneFlightNumberSlots(slots, maxSlots) {
        const src = slots && typeof slots === "object" ? Object.assign({}, slots) : {}
        const keys = Object.keys(src)
        const limit = isFinite(maxSlots) ? Math.max(1, Number(maxSlots)) : 20
        if (keys.length <= limit) return src
        keys.sort((a, b) => ((src[b] && src[b].scrapedAt) || 0) - ((src[a] && src[a].scrapedAt) || 0))
        const out = {}
        for (const k of keys.slice(0, limit)) out[k] = src[k]
        return out
    }

    function _storageGet(keys) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local
                || typeof chrome.storage.local.get !== "function") {
            return Promise.resolve({})
        }
        return new Promise(resolve => {
            try {
                chrome.storage.local.get(keys, v => {
                    const err = chrome.runtime && chrome.runtime.lastError
                    resolve(err ? {} : (v || {}))
                })
            } catch (_) {
                resolve({})
            }
        })
    }

    function _storageSet(items) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local
                || typeof chrome.storage.local.set !== "function") {
            return Promise.resolve(false)
        }
        return new Promise(resolve => {
            try {
                chrome.storage.local.set(items, () => {
                    const err = chrome.runtime && chrome.runtime.lastError
                    resolve(!err)
                })
            } catch (_) {
                resolve(false)
            }
        })
    }

    function _compactSuggestions(suggestionsByCls) {
        const out = {}
        const src = suggestionsByCls || {}
        for (const cls of CLASSES) {
            const s = src[cls]
            if (!s) continue
            if (s.skipReason) {
                out[cls] = {skipReason: String(s.skipReason).slice(0, 160)}
                continue
            }
            out[cls] = {
                newPrice: s.newPrice,
                deltaPct: s.deltaPct,
                loadFactor: s.loadFactor,
                competitorMedian: s.competitorMedian
            }
        }
        return out
    }

    function _skipReasonsByClass(suggestionsByCls) {
        const out = {}
        const src = suggestionsByCls || {}
        for (const cls of CLASSES) {
            const reason = src[cls] && src[cls].skipReason
            if (reason) out[cls] = String(reason).slice(0, 160)
        }
        return out
    }

    async function _persistVisiblePricingSnapshot(route, priceCtx, target, server, routeSignals) {
        if (!route || !route.hub || !route.dest || !priceCtx || !priceCtx.prices) return null
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null

        const prices = _cleanPriceMap(priceCtx.prices)
        if (!Object.keys(prices).length) return null

        const pair = _pairKey(route)
        const ts = Date.now()
        const srv = server || _serverFromLocation(typeof location !== "undefined" ? location : null) || null
        const t = target || _parseNumbersUrl(typeof location !== "undefined" ? location : null) || {}
        const pagePath = typeof location !== "undefined"
            ? String(location.pathname || "") + String(location.search || "")
            : (t.path || null)
        const fnSlotKey = _flightSlotKey(srv, t)
        const fnSlot = {
            server: srv,
            hub: _u(route.hub),
            dest: _u(route.dest),
            pair,
            flightNumberId: t.flightNumberId || null,
            legIndex: t.legIndex == null ? 0 : t.legIndex,
            pagePath,
            routeSource: route.source || null,
            scrapedAt: ts,
            source: "flightNumbers:visible",
            prices
        }

        const legacyOwnKey = _legacyScopedKey(OWN_SCOPE, pair)
        const scopedOwnKey = _acctScopedKey(OWN_SCOPE, pair)
        const legacyFnKey = _legacyScopedKey(FN_PRICE_SCOPE, fnSlotKey)
        const scopedFnKey = _acctScopedKey(FN_PRICE_SCOPE, fnSlotKey)
        const reads = Array.from(new Set([legacyOwnKey, scopedOwnKey, legacyFnKey, scopedFnKey]))
        const prev = await _storageGet(reads)

        const prevOwn = prev[scopedOwnKey] || prev[legacyOwnKey] || {}
        const nextSlots = _pruneFlightNumberSlots(Object.assign(
            {},
            prevOwn.flightNumbers || {},
            {[fnSlotKey]: fnSlot}
        ), 20)
        const ownRec = Object.assign({}, prevOwn, {
            hub: _u(route.hub),
            dest: _u(route.dest),
            server: srv || prevOwn.server || null,
            scrapedAt: ts,
            source: "flightNumbers:visible",
            prices: Object.assign({}, prevOwn.prices || {}, prices),
            flightNumbers: nextSlots
        })
        if (routeSignals && routeSignals.labels && routeSignals.labels.length) {
            ownRec.lastSignalLabels = routeSignals.labels.slice(0, 12)
        }

        const prevFn = prev[scopedFnKey] || prev[legacyFnKey] || {}
        const fnRec = Object.assign({}, prevFn, fnSlot)
        const writes = {}
        writes[legacyOwnKey] = ownRec
        if (scopedOwnKey !== legacyOwnKey) writes[scopedOwnKey] = ownRec
        writes[legacyFnKey] = fnRec
        if (scopedFnKey !== legacyFnKey) writes[scopedFnKey] = fnRec

        await _storageSet(writes)

        if (typeof window !== "undefined" && window.AesDataBus
                && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:route-assistant:markets:updated", {
                hub: ownRec.hub,
                dest: ownRec.dest,
                keysTouched: ["ownPricing"],
                source: "flightNumbers"
            })
            window.AesDataBus.emit("data:route-assistant:flight-number-pricing:updated", {
                server: srv,
                hub: ownRec.hub,
                dest: ownRec.dest,
                flightNumberId: fnRec.flightNumberId,
                legIndex: fnRec.legIndex,
                keysTouched: ["ownPricing", "flightNumberPricing"]
            })
        }

        return {ownPricing: ownRec, flightNumberPricing: fnRec, keys: Object.keys(writes)}
    }

    async function _recordPriceFunnel(route, priceCtx, suggestionsByCls, movedClasses, skipped, routeSignals, target, snapshot) {
        if (typeof window === "undefined" || !window.AesPriceDiagnostics) return
        if (!route || !route.hub || !route.dest) return
        const prices = _cleanPriceMap(priceCtx && priceCtx.prices)
        const proposal = _suggestionsToPriceMap(suggestionsByCls)
        const context = {
            source: "flight-number-leg",
            currentPrices: prices,
            suggestedPrices: proposal,
            movedClasses: (movedClasses || []).slice(0, 8),
            skippedClasses: (skipped || []).slice(0, 8),
            skipReasonsByClass: _skipReasonsByClass(suggestionsByCls),
            suggestions: _compactSuggestions(suggestionsByCls),
            routeSource: route.source || null,
            flightNumberId: target && target.flightNumberId || null,
            legIndex: target && target.legIndex != null ? target.legIndex : null,
            signalLabels: routeSignals && routeSignals.labels ? routeSignals.labels.slice(0, 12) : [],
            snapshotKeys: snapshot && snapshot.keys ? snapshot.keys.slice(0, 6) : []
        }
        try {
            if (typeof window.AesPriceDiagnostics.recordContext === "function") {
                await window.AesPriceDiagnostics.recordContext({hub: route.hub, dest: route.dest, context})
            }
            if (Object.keys(proposal).length && typeof window.AesPriceDiagnostics.recordProposal === "function") {
                await window.AesPriceDiagnostics.recordProposal({
                    hub: route.hub,
                    dest: route.dest,
                    reason: "flight-number leg autopricer",
                    prices: proposal,
                    context
                })
            } else if (!Object.keys(proposal).length && typeof window.AesPriceDiagnostics.recordSkip === "function") {
                await window.AesPriceDiagnostics.recordSkip({
                    hub: route.hub,
                    dest: route.dest,
                    reason: "flight-number leg autopricer: no class moved"
                })
            }
        } catch (e) {
            console.warn("[AES per-leg autopricer] diagnostics funnel failed", e)
        }
    }

    function _routeFromForm() {
        // Probe in priority order. Each source returns at most two IATAs;
        // first two found win. Sources, best → fallback:
        //   1. <a href="/app/info/airports/.../IATA"> link pairs anywhere on page
        //   2. route action links (scheduling/inventory/markets/<AAA><BBB>)
        //   3. active segment tab spans ("AAA - BBB")
        //   4. Pricing fieldset text (markets-style "Route: AAA → BBB" header)
        //   5. Page <h1>/<h2>/<h3>
        //   6. document.title
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

        // 2. Explicit route links on AS flight-number pages are the most
        // reliable fallback when airport anchors only contain numeric ids.
        const hrefPair = _routePairFromLinks()
        if (hrefPair) return hrefPair

        // 3. Active segment tab uses separate spans: <span>JFK</span> - <span>PUJ</span>.
        const tabPair = _routePairFromSegmentTabs()
        if (tabPair) return tabPair

        // 4/5/6 — text scrape with explicit O&D markers
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

    function _routePairFromLinks() {
        const anchors = Array.from(document.querySelectorAll("a[href]"))
        for (const a of anchors) {
            const href = a.getAttribute("href") || ""
            const pair = _routePairFromHref(href)
            if (pair) return {hub: pair[0], dest: pair[1], source: "route-link"}
        }
        return null
    }

    function _routePairFromHref(href) {
        const s = String(href || "").toUpperCase()
        const m = /(?:^|\/)(?:SCHEDULING|INVENTORY|MARKETS)\/([A-Z]{6})(?:[/?#]|$)/.exec(s)
        if (!m) return null
        const hub = m[1].slice(0, 3)
        const dest = m[1].slice(3, 6)
        return /^[A-Z]{3}$/.test(hub) && /^[A-Z]{3}$/.test(dest) ? [hub, dest] : null
    }

    function _routePairFromSegmentTabs() {
        const tabs = Array.from(document.querySelectorAll(
            ".nav-tabs li.active a, .nav-tabs a.active, a[href*='segment']"
        ))
        for (const tab of tabs) {
            const spans = Array.from(tab.querySelectorAll("span"))
                .map(s => String(s.textContent || "").trim().toUpperCase())
                .filter(s => /^[A-Z]{3}$/.test(s))
            if (spans.length >= 2 && spans[0] !== spans[1]) {
                return {hub: spans[0], dest: spans[1], source: "segment-tab"}
            }
            const text = (tab.innerText || tab.textContent || "").trim()
            const pair = _routePairFromText(text)
            if (pair) return {hub: pair[0], dest: pair[1], source: "segment-tab"}
        }
        return null
    }

    function _routePairFromText(text) {
        const m = /\b([A-Z]{3})\s*(?:→|[-–—]>?|to)\s*([A-Z]{3})\b/i.exec(String(text || ""))
        if (!m) return null
        return [m[1].toUpperCase(), m[2].toUpperCase()]
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
        if (typeof window !== "undefined"
                && window.RouteAssistantSettings
                && typeof window.RouteAssistantSettings.load === "function") {
            try { return await window.RouteAssistantSettings.load() }
            catch (_) { /* fall through to legacy read */ }
        }
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return {}
        const acct = window.__aesAccountId || ""
        const keys = [
            "settings",
            "routeAssistantSettings",
            acct ? "routeAssistantSettings:acct:" + acct : null
        ].filter(Boolean)
        try {
            const v = await new Promise((res) => chrome.storage.local.get(keys, res))
            const settings = v.settings || {}
            const scoped = acct && settings.acct && settings.acct[acct] && settings.acct[acct].routeAssistant
            const canonical = scoped || settings.routeAssistant || null
            if (canonical && typeof canonical === "object") return canonical
            const legacy = v.routeAssistantSettings || {}
            const scopedLegacy = acct ? (v["routeAssistantSettings:acct:" + acct] || {}) : {}
            return Object.assign({}, legacy, scopedLegacy)
        } catch (_) { return {} }
    }

    function _applyCfg(settings) {
        return settings && settings.pricing && settings.pricing.apply || {}
    }

    function _resolveApplyGate(settings, forceDryRun) {
        const apply = _applyCfg(settings)
        if (typeof window !== "undefined"
                && window.RouteAssistantPricingPlumbing
                && typeof window.RouteAssistantPricingPlumbing.resolveApplyGate === "function") {
            return window.RouteAssistantPricingPlumbing.resolveApplyGate(apply, "manual", {forceDryRun: !!forceDryRun})
        }
        const enabled = apply.enabled !== false
        const dryRunOnly = apply.dryRunOnly !== false
        const liveScopes = apply.liveScopes && typeof apply.liveScopes === "object" ? apply.liveScopes : {}
        const scopeLiveAllowed = liveScopes.manual === true
        const forcedDryRun = !!forceDryRun
        const dryRun = forcedDryRun || dryRunOnly || !enabled || !scopeLiveAllowed
        return {
            applyEnabled: enabled,
            dryRunOnly,
            scopeName: "manual",
            scopeLiveAllowed,
            forcedDryRun,
            dryRun,
            liveWrites: !dryRun,
            reason: forcedDryRun ? "forced-dry-run"
                : dryRunOnly ? "dry-run-only"
                : !enabled ? "apply-disabled"
                : !scopeLiveAllowed ? "scope-disabled:manual"
                : "live"
        }
    }

    function _makeApplyLog(settings) {
        const Ctor = typeof window !== "undefined" && window.RouteAssistantPricingApplyLog
        if (!Ctor) return null
        const apply = _applyCfg(settings)
        try {
            return new Ctor({
                limit:          apply.pricingApplyLogLimit || 200,
                perRouteLimit:  apply.perRouteApplyLogLimit || 20,
                dedupWindowMin: isFinite(apply.pricingApplyLogDedupWindowMin)
                    ? apply.pricingApplyLogDedupWindowMin
                    : 5
            })
        } catch (_) {
            return null
        }
    }

    async function _lastSuccessForRoute(log, hub, dest) {
        if (!log || typeof log.getForRoute !== "function") return null
        try {
            const rec = await log.getForRoute(hub, dest)
            const entries = rec && Array.isArray(rec.entries) ? rec.entries : []
            for (const e of entries) {
                if (e && (e.status === "verified" || e.status === "posted")) return e.ts || null
            }
        } catch (_) { return null }
        return null
    }

    async function _lastSuccessGlobal(log) {
        if (!log || typeof log.getLastSuccessGlobal !== "function") return null
        try { return await log.getLastSuccessGlobal() }
        catch (_) { return null }
    }

    async function _persistBreakerPatch(settings, patch) {
        if (!settings || !settings.pricing || !settings.pricing.apply) return
        Object.assign(settings.pricing.apply, patch || {})
        if (typeof window !== "undefined"
                && window.RouteAssistantSettings
                && typeof window.RouteAssistantSettings.save === "function") {
            try { await window.RouteAssistantSettings.save({pricing: settings.pricing}) }
            catch (_) { /* settings persistence is best-effort here */ }
        }
    }

    function _makePricingApplier(server, settings, log) {
        const Ctor = typeof window !== "undefined" && window.RouteAssistantPricingApplier
        if (!Ctor) return null
        const apply = _applyCfg(settings)
        const gate = _resolveApplyGate(settings, false)
        try {
            return new Ctor(server, {
                dryRunOnly:               gate.dryRunOnly,
                applyEnabled:             gate.applyEnabled,
                liveScopes:               apply.liveScopes || {},
                cooldownMinPerRoute:      apply.cooldownMinPerRoute,
                cooldownMinGlobal:        apply.cooldownMinGlobal,
                warnAboveDeltaPct:        apply.warnAboveDeltaPct,
                applyLog:                 log,
                circuitBreakerThreshold:  apply.circuitBreakerThreshold,
                circuitBreakerCooldownMs: apply.circuitBreakerCooldownMs,
                circuitBreakerTrippedAt:  apply.circuitBreakerTrippedAt,
                onBreakerTrip:            (reason, trippedAt) => _persistBreakerPatch(settings, {
                    circuitBreakerTrippedAt: trippedAt,
                    circuitBreakerHaltReason: String(reason || "")
                }),
                onBreakerReset:           () => _persistBreakerPatch(settings, {
                    circuitBreakerTrippedAt: null,
                    circuitBreakerHaltReason: null
                })
            })
        } catch (_) {
            return null
        }
    }

    function _statusFromResult(result, fallbackMessage) {
        const r = result || {}
        const preflight = r.preflight || {}
        const err = r.error || {}
        const blockers = []
        const warnings = []
        if (Array.isArray(preflight.blockers)) blockers.push(...preflight.blockers)
        if (Array.isArray(err.blockers)) blockers.push(...err.blockers)
        if (Array.isArray(preflight.warnings)) warnings.push(...preflight.warnings)
        return {
            status: r.status || "failed",
            message: err.message || r.warning || fallbackMessage || "",
            applyGate: r.applyGate || null,
            blockers,
            warnings,
            result: r
        }
    }

    function _statusText(state) {
        if (!state) return ""
        const status = state.status || "pending"
        const parts = [status]
        if (state.applyGate && state.applyGate.reason && status !== "pending") {
            parts.push("gate " + state.applyGate.reason)
        }
        if (state.message) parts.push(state.message)
        const blockers = Array.isArray(state.blockers) ? state.blockers : []
        const warnings = Array.isArray(state.warnings) ? state.warnings : []
        if (blockers.length) parts.push("blockers: " + blockers.map(b => b.message || b.code || String(b)).join("; "))
        if (warnings.length) parts.push("warnings: " + warnings.map(w => w.message || w.code || String(w)).join("; "))
        return parts.join(" · ")
    }

    function _renderApplyStatus(host, state) {
        if (!host) return null
        let el = host.querySelector ? host.querySelector(".aes-perleg-status") : null
        if (!el) {
            el = document.createElement("div")
            el.className = "aes-perleg-status"
            if (host.appendChild) host.appendChild(el)
        }
        if (!state) {
            el.textContent = ""
            if (el.style) el.style.display = "none"
            return el
        }
        if (el.style) el.style.display = ""
        el.setAttribute && el.setAttribute("data-status", state.status || "pending")
        el.textContent = _statusText(state)
        return el
    }

    function _renderCurrentApplyStatus() {
        const banner = document.querySelector && document.querySelector(".aes-perleg-banner")
        if (banner) _renderApplyStatus(banner, _lastApplyState)
    }

    function _syncDomPrices(rowsByCls, prices) {
        const p = prices || {}
        for (const cls of CLASSES) {
            if (p[cls] == null) continue
            const row = rowsByCls && rowsByCls[cls]
            if (!row) continue
            const formatted = _formatPriceForClass(cls, p[cls])
            if (row.currentCell) row.currentCell.textContent = formatted + " AS$"
            if (row.newInput) {
                row.newInput.value = formatted
                row.originalInputValue = formatted
            }
        }
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
            .aes-perleg-actions button:disabled { opacity:.55; cursor:not-allowed; }
            .aes-perleg-actions .aes-perleg-apply-all { border-color:#64748b; color:#334155; }
            .aes-perleg-actions .aes-perleg-live-apply { border-color:#1d4ed8; color:#1d4ed8; font-weight:600; }
            .aes-perleg-actions .aes-perleg-live-apply:hover,
            .aes-perleg-actions .aes-perleg-apply-all:hover { background:#dbeafe; }
            .aes-perleg-actions .aes-perleg-dry-run { border-color:#a16207; color:#92400e; }
            .aes-perleg-status { margin-top:6px; padding:4px 6px; border-radius:3px; font-size:11px;
                line-height:1.35; background:#f8fafc; color:#334155; border:1px solid #cbd5e1; }
            .aes-perleg-status[data-status="verified"] { background:#dcfce7; color:#166534; border-color:#86efac; }
            .aes-perleg-status[data-status="posted"] { background:#e0f2fe; color:#075985; border-color:#7dd3fc; }
            .aes-perleg-status[data-status="dry-run"] { background:#fef3c7; color:#92400e; border-color:#fcd34d; }
            .aes-perleg-status[data-status="aborted"] { background:#fff7ed; color:#9a3412; border-color:#fdba74; }
            .aes-perleg-status[data-status="failed"] { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
            .aes-perleg-status[data-status="pending"] { background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe; }
        `
        document.head.appendChild(s)
    }

    function _renderRowSuggestion(row, suggestion, applyClick, opts) {
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
            const noSignals = !!(opts && opts.noSignals)
            const deltaSkip = /^\|Δ\|/.test(suggestion.skipReason)
            chip.title = (noSignals && deltaSkip)
                ? "No cached competitor / demand / ORS / history data for this route. Open the Route Assistant panel and click 'Sync route data' once to populate signals."
                : suggestion.skipReason
            chip.textContent = (noSignals && deltaSkip) ? "no data" : "—"
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

    async function _applySuggestedPrices(state, opts) {
        opts = opts || {}
        if (_applyInFlight) return {status: "aborted", error: {code: "applyInFlight", message: "Apply already running"}}
        const route = state && state.route
        const suggestions = state && state.suggestions || {}
        const rowsByCls = state && state.rowsByCls || {}
        const prices = _suggestionsToPriceMap(suggestions)
        const target = _parseNumbersUrl(opts.location || (typeof location !== "undefined" ? location : null))
        const server = opts.server || _serverFromLocation(typeof location !== "undefined" ? location : null)
        const forceDryRun = !!opts.dryRun

        if (!route || !route.hub || !route.dest) {
            _lastApplyState = {status: "failed", message: "No detected route for this leg.", blockers: [], warnings: []}
            _renderCurrentApplyStatus()
            return {status: "failed", error: {code: "noRoute", message: _lastApplyState.message}}
        }
        if (!target || !target.flightNumberId) {
            _lastApplyState = {status: "failed", message: "No flight-number id in the current URL.", blockers: [], warnings: []}
            _renderCurrentApplyStatus()
            return {status: "failed", error: {code: "noFlightNumberId", message: _lastApplyState.message}}
        }
        if (!server) {
            _lastApplyState = {status: "failed", message: "Could not detect the AirlineSim server from this page.", blockers: [], warnings: []}
            _renderCurrentApplyStatus()
            return {status: "failed", error: {code: "noServer", message: _lastApplyState.message}}
        }
        if (!Object.keys(prices).length) {
            _lastApplyState = {status: "aborted", message: "No non-skipped suggestions to apply.", blockers: [], warnings: []}
            _renderCurrentApplyStatus()
            return {status: "aborted", error: {code: "noSuggestedPrices", message: _lastApplyState.message}}
        }

        const settings = state.settings || await _loadPricingCfg()
        const apply = _applyCfg(settings)
        const gate = _resolveApplyGate(settings, forceDryRun)
        const willLive = !gate.dryRun
        const requestKey = _applyRequestKey(route, target, prices)
        const confirmed = _confirmApplyKey === requestKey
        const log = opts.applyLog || _makeApplyLog(settings)
        const applier = opts.applier || _makePricingApplier(server, settings, log)
        if (!applier || typeof applier.apply !== "function") {
            _lastApplyState = {status: "failed", message: "RouteAssistantPricingApplier is not loaded.", blockers: [], warnings: []}
            _renderCurrentApplyStatus()
            return {status: "failed", error: {code: "noPricingApplier", message: _lastApplyState.message}}
        }

        _applyInFlight = true
        _lastApplyState = {
            status: "pending",
            message: (forceDryRun ? "Dry-run" : (willLive ? "Live apply" : "Apply-gated dry-run")) + " in progress.",
            applyGate: gate,
            blockers: [],
            warnings: []
        }
        _renderCurrentApplyStatus()

        let result = null
        try {
            const lastApplyAt = opts.lastApplyAt !== undefined
                ? opts.lastApplyAt
                : await _lastSuccessForRoute(log, route.hub, route.dest)
            const lastApplyAtGlobal = opts.lastApplyAtGlobal !== undefined
                ? opts.lastApplyAtGlobal
                : await _lastSuccessGlobal(log)
            result = await applier.apply(route.hub, route.dest, prices, {
                endpoint: "flightNumbers",
                flightNumberId: target.flightNumberId,
                legIndex: target.legIndex,
                source: "manual",
                dryRun: forceDryRun,
                submitButton: apply.submitButton || "submit-prices",
                reason: "flight-number leg autopricer",
                classGates: apply.classes || null,
                lastApplyAt,
                lastApplyAtGlobal,
                onPreflight: (preflight) => {
                    const warnings = preflight && Array.isArray(preflight.warnings) ? preflight.warnings : []
                    const blockers = preflight && Array.isArray(preflight.blockers) ? preflight.blockers : []
                    if (!willLive || blockers.length || !warnings.length || confirmed) return true
                    _confirmApplyKey = requestKey
                    _lastApplyState = {
                        status: "aborted",
                        message: "Preflight warnings require confirmation. Click Confirm apply to continue.",
                        applyGate: gate,
                        blockers: [],
                        warnings
                    }
                    _renderCurrentApplyStatus()
                    return {abort: true, reason: "Preflight warnings require confirmation"}
                }
            })
        } catch (e) {
            result = {status: "failed", error: {code: "applierThrew", message: String(e && e.message || e)}}
        } finally {
            _applyInFlight = false
        }

        _lastApplyState = _statusFromResult(result)
        const warnedAbort = result && result.status === "aborted"
            && result.error && result.error.code === "userAborted"
            && result.preflight && Array.isArray(result.preflight.warnings)
            && result.preflight.warnings.length
        if (warnedAbort && willLive) {
            _confirmApplyKey = requestKey
            _lastApplyState.message = "Preflight warnings require confirmation. Click Confirm apply to continue."
        } else if (result && result.status !== "failed") {
            _confirmApplyKey = null
        }

        if (result && (result.status === "verified" || result.status === "posted")) {
            _syncDomPrices(rowsByCls, result.verifiedPrices || result.newPrices)
        }
        if (!opts.suppressRerun) {
            try { await run() }
            catch (_) { _renderCurrentApplyStatus() }
        } else {
            _renderCurrentApplyStatus()
        }
        return result
    }

    function _renderBanner(panel, route, summary, suggestionsByCls, rowsByCls, originalPrices, routeSignals, settings) {
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
        if (!movable.length) {
            _renderApplyStatus(banner, _lastApplyState)
            return
        }

        const actions = document.createElement("div")
        actions.className = "aes-perleg-actions"
        const priceMap = _suggestionsToPriceMap(suggestionsByCls)
        const target = _parseNumbersUrl(typeof location !== "undefined" ? location : null)
        const requestKey = _applyRequestKey(route, target, priceMap)

        const applyAll = document.createElement("button")
        applyAll.type = "button"
        applyAll.className = "btn btn-xs aes-perleg-apply-all"
        applyAll.textContent = "Copy all (" + movable.length + ")"
        applyAll.title = "Copy all " + movable.join("/") + " suggestions into the New Price fields. "
            + "You still click AS's native Apply button to submit."
        applyAll.addEventListener("click", () => {
            for (const cls of movable) _writePriceInto(rowsByCls[cls], suggestionsByCls[cls])
        })

        const liveApply = document.createElement("button")
        liveApply.type = "button"
        liveApply.className = "btn btn-xs aes-perleg-live-apply"
        liveApply.textContent = _confirmApplyKey === requestKey ? "Confirm apply" : "Apply suggested prices"
        liveApply.title = "Apply these suggested prices to this visible flight-number leg through the Route Assistant pricing applier."
        liveApply.disabled = _applyInFlight
        liveApply.addEventListener("click", () => {
            _applySuggestedPrices({
                route,
                suggestions: suggestionsByCls,
                rowsByCls,
                settings
            }).catch(e => {
                _lastApplyState = {status: "failed", message: String(e && e.message || e), blockers: [], warnings: []}
                _renderCurrentApplyStatus()
            })
        })

        const dryRun = document.createElement("button")
        dryRun.type = "button"
        dryRun.className = "btn btn-xs aes-perleg-dry-run"
        dryRun.textContent = "Dry-run"
        dryRun.title = "Run the same applier pipeline with dryRun forced on and write an apply-log rehearsal entry."
        dryRun.disabled = _applyInFlight
        dryRun.addEventListener("click", () => {
            _applySuggestedPrices({
                route,
                suggestions: suggestionsByCls,
                rowsByCls,
                settings
            }, {dryRun: true}).catch(e => {
                _lastApplyState = {status: "failed", message: String(e && e.message || e), blockers: [], warnings: []}
                _renderCurrentApplyStatus()
            })
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
        actions.appendChild(liveApply)
        actions.appendChild(dryRun)
        actions.appendChild(restore)
        banner.appendChild(actions)
        _renderApplyStatus(banner, _lastApplyState)
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
        const target = _parseNumbersUrl(typeof location !== "undefined" ? location : null)
        const server = _serverFromLocation(typeof location !== "undefined" ? location : null)
        let snapshot = null
        try { snapshot = await _persistVisiblePricingSnapshot(route, priceCtx, target, server, null) }
        catch (e) { console.warn("[AES per-leg autopricer] visible price snapshot failed", e) }
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
        const noSignals = !(routeSignals.labels && routeSignals.labels.length)
        for (const row of priceCtx.rows) {
            const compMed = _combinedCompetitorMedian(row.cls, stored.competitors, routeSignals.orsPriceIndex)
            const gate = _classGate(row.cls, settings)
            const sug = _computeOne(row.cls, priceCtx.prices[row.cls], demand, compMed, gate, cfg, routeSignals)
            _renderRowSuggestion(row, sug, _writePriceInto, {noSignals})
            sugByCls[row.cls] = sug
            rowByCls[row.cls] = row
            if (sug.skipReason) skipped.push(row.cls)
            else movedClasses.push(row.cls)
        }
        await _recordPriceFunnel(route, priceCtx, sugByCls, movedClasses, skipped, routeSignals, target, snapshot)
        const oneline = movedClasses.length
            ? "Suggesting moves on " + movedClasses.join("/") + " · "
                + (skipped.length ? "holding " + skipped.join("/") : "all-class fit")
            : "No suggested moves (signals all hold)."
        _renderBanner(fieldset, route,
            oneline + " · " + route.hub + " → " + route.dest
                + (routeSignals.labels.length ? " · signals: " + routeSignals.labels.join("/") : "")
                + (stored.demand ? "" : " · no cached demand — run RA panel sync once"),
            sugByCls, rowByCls, originalPrices, routeSignals, settings)
        return {route, prices: priceCtx.prices, movedClasses, skipped, suggestions: sugByCls, rowsByCls: rowByCls, routeSignals, settings}
    }

    function _ready(fn) {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, {once: true})
        else fn()
    }

    window.AesPerLegAutopricer = {
        run,
        _readCurrentPrices,
        _routeFromForm,
        _parseNumbersUrl,
        _serverFromLocation,
        _suggestionsToPriceMap,
        _applySuggestedPrices,
        _resolveApplyGate,
        _statusFromResult,
        _statusText,
        _renderApplyStatus,
        _cleanPriceMap,
        _persistVisiblePricingSnapshot,
        _recordPriceFunnel,
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
