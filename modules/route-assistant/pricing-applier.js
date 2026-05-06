"use strict"

/**
 * Auto-Pricing Tier 3 — POST write-back to the AS markets-page pricing form.
 *
 * Reads `/app/com/markets/<HUB><DEST>` to harvest the per-route Wicket
 * session + form action + slider ranges + current prices, then posts new
 * prices via the same form. Mirrors `ors-scraper.js`'s GET → POST handshake
 * — Wicket page-version IDs invalidate per interaction, so every apply
 * does its own fresh handshake and never reuses a session across calls.
 *
 * Current behavior: live POST is the default for every proven pricing scope
 * unless the caller explicitly sets `dryRunOnly:true`, `applyEnabled:false`,
 * `opts.dryRun:true`, or disables that scope in `liveScopes`.
 *
 * Storage of per-apply records is in pricing-apply-log.js. This file
 * stays focused on the network handshake + parsing + body construction.
 * Pure parsing is exposed as static methods so unit-testing the
 * brittle Wicket bits doesn't need a live AS session.
 *
 * Public API:
 *   const applier = new RouteAssistantPricingApplier(server, {dryRunOnly, applyEnabled, ...})
 *   const result = await applier.apply(hub, dest, {Y, C, F, Cargo}, {
 *     scope:        {airportPair, flightNumbers, returnAirportPair, returnFlightNumbers},
 *     source:       "manual" | "sandbox" | "batch" | "silent-auto",
 *     dryRun:       <bool — overrides the instance dryRunOnly only when truthy>,
 *     submitButton: "submit-prices" | "p::submit" | "submit-settings",
 *     reason:       <string, optional, persisted to apply log>,
 *     endpoint:     "markets" (default) | "flightNumbers" — when "flightNumbers",
 *                   targets `/app/com/numbers/<flightNumberId>/<legIndex>` instead
 *                   of the route-level markets page. Per-leg writes only affect
 *                   that one flight number; scope checkboxes are absent on the
 *                   leg form so `scope` is ignored in that mode.
 *     flightNumberId: required when `endpoint==="flightNumbers"` — AS flight
 *                   number id (the integer in `/app/com/numbers/<id>`).
 *     legIndex:     defaults to 0 when `endpoint==="flightNumbers"` (the
 *                   outbound leg). Multi-stop legs are out-of-scope for this slice.
 *     sandboxScenario: <object, optional>,
 *     projectedDelta:  <object, optional>,
 *     preApplySync:    <{scheduleAt, orsAt, halted}, optional> — captured
 *                      by the panel from the route-sync orchestrator's
 *                      pre-apply pass; threaded straight into the apply
 *                      log so the audit trail records whether this apply
 *                      was data-refreshed beforehand. Applier itself does
 *                      not inspect.
 *     onPreflight:  fn(preflightResult) — called BEFORE POST; can
 *                   abort by returning `false` or {abort: true, reason}
 *   })
 *   // → {status: "dry-run"|"posted"|"verified"|"failed", logId, prevPrices, newPrices,
 *   //    blockers?, warnings?, error?}
 *
 * Static helpers (pure):
 *   RouteAssistantPricingApplier.parseFormContext(html)
 *     → {sessionId, formActionPath, formId, hiddenFields, currentPrices,
 *        defaults, sliderRanges, generalSettings, classOrder}
 *   RouteAssistantPricingApplier.buildBody({formContext, prices, settings, scope, submitButton})
 *     → URLSearchParams
 *   RouteAssistantPricingApplier.fingerprint(hub, dest, prices, scope)
 *     → string (deterministic hash for idempotency dedup)
 */
class RouteAssistantPricingApplier {
    // Wicket form-input names. Stable across the snapshots we have. If AS
    // changes any of these the parser will silently drop the unrecognised
    // field and the body-builder will skip emitting it; preflight surfaces
    // a warning if the snapshot's `currentPrices` is empty.
    static FIELD_NAMES = {
        prices: {
            // index → form-field name. Order matches AS's class order in
            // the pricing fieldset (Y first, Cargo last).
            Y:     "classes:prices:0:newPrice",
            C:     "classes:prices:1:newPrice",
            F:     "classes:prices:2:newPrice",
            Cargo: "classes:prices:3:newPrice"
        },
        settings: {
            originTerminal:      "originTerminal-group:originTerminal-group_body:originTerminal",
            destinationTerminal: "destinationTerminal-group:destinationTerminal-group_body:destinationTerminal",
            serviceProfile:      "serviceProfile-group:serviceProfile-group_body:serviceProfile",
            boardingPreference:  "boardingPreference-group:boardingPreference-group_body:boardingPreference",
            cargoPreference:     "cargoPreference-group:cargoPreference-group_body:cargoPreference"
        },
        scope: {
            airportPair:         "settings:airportPair",
            flightNumbers:       "settings:flightNumbers",
            returnAirportPair:   "settings:returnAirportPair",
            returnFlightNumbers: "settings:returnFlightNumbers"
        }
    }

    static SUBMIT_BUTTONS = {
        pricesOnly:        "submit-prices",
        pricesAndSettings: "p::submit",
        settingsOnly:      "submit-settings"
    }

    static DEFAULT_SUBMIT = "submit-prices"

    // Endpoint mode — "markets" is the default route-level form at
    // `/app/com/markets/<HUB><DEST>`; "flightNumbers" targets the
    // per-leg form at `/app/com/numbers/<flightNumberId>/<legIndex>`.
    // Forms are structurally identical (same FIELD_NAMES.prices, same
    // submit-prices button, same slider ranges) — only the URL, the
    // form-action suffix, and the absence of scope checkboxes differ.
    static FORM_ACTION_SUFFIXES = {
        markets:       "panel-settings-settings~form",
        flightNumbers: "panel-leg~settings~form"
    }
    static DEFAULT_ENDPOINT = "markets"

    // Watchful regexes for a few Wicket failure modes that return HTTP 200
    // bodies but represent silent failures. Same approach as ors-scraper.js.
    static PAGE_EXPIRED_RE      = /PageExpiredException|Wicket\.PageExpiredException/i
    static AUTHENTICATION_RE    = /<form[^>]+action=["'][^"']*\/login/i
    static APPLIED_OK_PHRASE_RE = /Pricing.*?(?:applied|saved|updated)/i

    /**
     * Default scope — apply to the airport pair AND all flight numbers
     * routed across it. Outbound only; the user opts into return on a
     * per-apply basis. Mirrors the page's checked checkboxes.
     */
    static DEFAULT_SCOPE = {
        airportPair:         true,
        flightNumbers:       true,
        returnAirportPair:   false,
        returnFlightNumbers: false
    }
    static DECIMAL_CLASS_KEYS = {Cargo: true}

    static _normaliseClassKey(label) {
        const raw = String(label || "").trim()
        if (!raw) return ""
        const compact = raw.toUpperCase().replace(/\s+/g, " ")
        if (compact === "Y" || compact === "ECONOMY" || compact === "ECONOMY CLASS") return "Y"
        if (compact === "C" || compact === "BUSINESS" || compact === "BUSINESS CLASS") return "C"
        if (compact === "F" || compact === "FIRST" || compact === "FIRST CLASS") return "F"
        if (compact === "CARGO" || compact === "FREIGHT" || compact === "MAIL") return "Cargo"
        return raw
    }

    /**
     * @param {string} server  — `free1`, `tristar`, etc.
     * @param {object} [opts]
     * @param {boolean} [opts.dryRunOnly=false]  — hard gate; when true, apply()
     *   never POSTs even if `dryRun` arg is false. Route Assistant settings
     *   pass their current `pricing.apply.dryRunOnly` value here.
     * @param {boolean} [opts.applyEnabled=true] — secondary gate. Set false
     *   to block live writes from this instance.
     * @param {object} [opts.liveScopes] — per-source live-write permissions
     *   from settings.routeAssistant.pricing.apply.liveScopes.
     * @param {number} [opts.cooldownMinPerRoute=60] — minutes; preflight
     *   blocks an apply for the same route within this window.
     * @param {number} [opts.cooldownMinGlobal=5] — minutes; preflight
     *   blocks an apply when ANY route was written in this window. 0
     *   disables. Floor-level throttle to catch rapid-fire chains.
     * @param {number} [opts.warnAboveDeltaPct=5]   — issues a preflight
     *   warning (NOT a blocker) when any class's |Δ%| exceeds this.
     * @param {RouteAssistantPricingApplyLog} [opts.applyLog] — log store
     *   instance. Optional — when omitted apply() only returns the
     *   in-memory result without persisting an audit trail.
     */
    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantPricingApplier: server required")
        opts = opts || {}
        this.server = server
        this.dryRunOnly         = opts.dryRunOnly === true
        this.applyEnabled       = opts.applyEnabled !== false
        this.liveScopes         = Object.assign(
            {manual: true, bulk: true, silentAuto: true, bulkRecommended: true},
            (opts.liveScopes && typeof opts.liveScopes === "object") ? opts.liveScopes : {}
        )
        this.cooldownMinPerRoute = isFinite(opts.cooldownMinPerRoute) ? Math.max(0, opts.cooldownMinPerRoute) : 60
        this.cooldownMinGlobal   = isFinite(opts.cooldownMinGlobal)   ? Math.max(0, opts.cooldownMinGlobal)   : 5
        this.warnAboveDeltaPct  = isFinite(opts.warnAboveDeltaPct) ? Math.max(0, opts.warnAboveDeltaPct) : 5
        this.applyLog           = opts.applyLog || null
        // Tier 3.2 — circuit breaker. Threshold/cooldown/trippedAt are read
        // from settings on every apply via the opts the panel threads in;
        // we keep an instance counter so consecutive failures within one
        // panel session add up across calls without a settings round-trip.
        this.circuitBreakerThreshold  = isFinite(opts.circuitBreakerThreshold)
            ? Math.max(1, opts.circuitBreakerThreshold)
            : 3
        this.circuitBreakerCooldownMs = isFinite(opts.circuitBreakerCooldownMs)
            ? Math.max(0, opts.circuitBreakerCooldownMs)
            : 600000
        this.circuitBreakerTrippedAt  = isFinite(opts.circuitBreakerTrippedAt) ? opts.circuitBreakerTrippedAt : null
        this.onBreakerTrip            = typeof opts.onBreakerTrip  === "function" ? opts.onBreakerTrip  : null
        this.onBreakerReset           = typeof opts.onBreakerReset === "function" ? opts.onBreakerReset : null
        this._consecutiveErrors       = 0
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _scopeNameForSource(source) {
        const s = String(source || "")
        if (s === "silent-auto" || s === "silent_auto") return "silentAuto"
        return s
    }

    static _routeToken(value) {
        return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
    }

    static _routePath(hub, dest) {
        let h = String(hub || "").trim().toUpperCase()
        let d = String(dest || "").trim().toUpperCase()
        const pair = h.match(/^([A-Z0-9]{3,4})[^A-Z0-9]+([A-Z0-9]{3,4})$/)
        const cleanDest = RouteAssistantPricingApplier._routeToken(d)
        if (pair && (!cleanDest || cleanDest === pair[2])) {
            h = pair[1]
            d = pair[2]
        }
        return RouteAssistantPricingApplier._routeToken(h)
            + RouteAssistantPricingApplier._routeToken(d)
    }

    static _baseUrl(server) {
        return "https://" + server + ".airlinesim.aero"
    }

    static _markUrl(server, hub, dest) {
        return RouteAssistantPricingApplier._baseUrl(server)
            + "/app/com/markets/" + RouteAssistantPricingApplier._routePath(hub, dest)
    }

    static _numbersUrl(server, flightNumberId, legIndex) {
        const leg = (legIndex == null || !isFinite(legIndex)) ? 0 : Math.max(0, parseInt(legIndex, 10))
        return RouteAssistantPricingApplier._baseUrl(server)
            + "/app/com/numbers/" + String(flightNumberId) + "/" + leg
    }

    static _endpointUrl(server, opts) {
        const o = opts || {}
        if (o.endpoint === "flightNumbers") {
            return RouteAssistantPricingApplier._numbersUrl(server, o.flightNumberId, o.legIndex)
        }
        return RouteAssistantPricingApplier._markUrl(server, o.hub, o.dest)
    }

    // ------------------------------------------------------------------
    // Form parsing — pure, static. Walks the GET response to harvest the
    // Wicket session, the form action URL, every hidden input, and the
    // current per-class prices + slider ranges.
    // ------------------------------------------------------------------

    /**
     * Locate the pricing form, parse out everything we need to reconstruct
     * it as a POST body.
     *
     * Returns null when we couldn't find the form (page format changed,
     * the user isn't logged in, the route doesn't exist, etc.). The
     * caller must handle null — preflight surfaces a `noFormContext`
     * blocker which the modal renders with a clear "couldn't locate
     * pricing form on AS — refresh the page and try again" hint.
     */
    static parseFormContext(html, opts) {
        if (!html) return null
        const doc = new DOMParser().parseFromString(html, "text/html")
        const endpoint = (opts && opts.endpoint) || RouteAssistantPricingApplier.DEFAULT_ENDPOINT
        const expectedSuffix = RouteAssistantPricingApplier.FORM_ACTION_SUFFIXES[endpoint] || null

        // Session ID lives in the wicket-ajax-base-url script. Same
        // structure as the ORS form. The number after the `?` is what we
        // need; the rest of the URL changes per interaction.
        let sessionId = null
        const baseUrlScript = doc.getElementById("wicket-ajax-base-url")
        if (baseUrlScript && baseUrlScript.textContent) {
            const m = /Wicket\.Ajax\.baseUrl\s*=\s*["'][^?"']+\?(\d+)/i.exec(baseUrlScript.textContent)
            if (m) sessionId = m[1]
        }

        // Locate the pricing form. Markets-page form's action ends in
        // `~panel-settings-settings~form`; the per-leg form on
        // `/app/com/numbers/<id>/<leg>` ends in `~panel-leg~settings~form`.
        // Both carry the same `submit-prices` button. Disambiguate first
        // by suffix when the caller specifies an endpoint, then fall
        // back to the submit-prices button check so older snapshots
        // (no suffix match yet) still parse.
        let pricingForm = null
        const candidates = []
        for (const f of doc.querySelectorAll("form[method='post']")) {
            const hasSubmitPrices = f.querySelector("button[name='submit-prices']")
                || f.querySelector("input[name='submit-prices']")
            if (!hasSubmitPrices) continue
            candidates.push(f)
        }
        if (expectedSuffix) {
            for (const f of candidates) {
                const action = f.getAttribute("action") || ""
                if (action.indexOf(expectedSuffix) !== -1) { pricingForm = f; break }
            }
        }
        if (!pricingForm && candidates.length) pricingForm = candidates[0]
        if (!pricingForm) return null

        const formAction = pricingForm.getAttribute("action") || ""
        // Action URL example:
        //   https://free1.airlinesim.aero/app/com/markets/JFKATL?869-1.-pair-pair~panel-settings-settings~form
        // We want the `869-1.-pair-pair~panel-settings-settings~form` portion
        // because the POST URL keeps the host-relative `/app/com/markets/<HUB><DEST>`
        // identical and only the query-string changes.
        const actionMatch = /\?([^"'#]+)$/.exec(formAction)
        const formActionPath = actionMatch ? actionMatch[1] : null
        if (!formActionPath) return null

        const formId = pricingForm.getAttribute("id") || null

        // Hidden fields. Wicket forms occasionally inject a CSRF-ish
        // hidden token in the form's `<div class="hidden-fields">`.
        // Sample shows the div empty, but harvest defensively so we
        // don't break if AS adds one.
        const hiddenFields = {}
        for (const inp of pricingForm.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) hiddenFields[name] = inp.getAttribute("value") || ""
        }

        // Current prices — parse the pricing fieldset. We need both the
        // class label (Y/C/F/Cargo) and the corresponding input's name
        // (`classes:prices:N:newPrice`) so a future AS reorder doesn't
        // silently misalign indices.
        const currentPrices = {}
        const defaults      = {}
        const sliderRanges  = {}
        const observedFieldNames = {}
        const classLabels   = {}
        const classOrder    = []   // ["Y", "C", "F", "Cargo"] in field-index order

        let pricingFs = null
        for (const fs of pricingForm.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (legend && /^pricing$/i.test((legend.textContent || "").trim())) {
                pricingFs = fs
                break
            }
        }
        if (pricingFs) {
            for (const tr of pricingFs.querySelectorAll("table tbody tr")) {
                const cells = tr.querySelectorAll("td")
                if (cells.length < 5) continue
                const rawCls = (cells[0].textContent || "").trim()
                const cls = RouteAssistantPricingApplier._normaliseClassKey(rawCls)
                const cur = RouteAssistantPricingApplier._parsePrice(cells[1].textContent, cls)
                const newInp = cells[2].querySelector("input[type='text']")
                const newName = newInp ? newInp.getAttribute("name") : null
                const newVal = newInp ? RouteAssistantPricingApplier._parsePrice(newInp.getAttribute("value"), cls) : cur
                const defSpan = cells[4].querySelector("span")
                const defVal = defSpan
                    ? RouteAssistantPricingApplier._parsePrice(defSpan.textContent, cls)
                    : RouteAssistantPricingApplier._parsePrice(cells[4].textContent, cls)
                if (!cls) continue
                if (classOrder.indexOf(cls) < 0) classOrder.push(cls)
                if (rawCls && rawCls !== cls) classLabels[cls] = rawCls
                currentPrices[cls] = newVal != null ? newVal : cur
                defaults[cls]      = defVal
                if (newName) {
                    // Track the actual field name AS used. We trust this
                    // over our static FIELD_NAMES map when building the
                    // body — guards against AS reordering the table.
                    observedFieldNames[cls] = newName
                }
            }
        }

        // Slider ranges (per-class min/max). Mirror of markets-page-scraper.js's
        // `_parseOwnPricing`. We need these for the preflight clamp check.
        const scriptText = RouteAssistantPricingApplier._collectScriptText(doc)
        const sliderRe = /slider\(\s*\{[^}]*?value:\s*(-?\d+(?:[.,]\d+)?)\s*,\s*min:\s*(-?\d+(?:[.,]\d+)?)\s*,\s*max:\s*(-?\d+(?:[.,]\d+)?)/g
        const sliderMatches = []
        let sm
        while ((sm = sliderRe.exec(scriptText)) !== null) {
            sliderMatches.push({
                value: RouteAssistantPricingApplier._parsePrice(sm[1], "Cargo"),
                min:   RouteAssistantPricingApplier._parsePrice(sm[2], "Cargo"),
                max:   RouteAssistantPricingApplier._parsePrice(sm[3], "Cargo")
            })
        }
        for (let i = 0; i < classOrder.length && i < sliderMatches.length; i++) {
            sliderRanges[classOrder[i]] = [sliderMatches[i].min, sliderMatches[i].max]
        }

        // General Settings — capture current selected values per <select>.
        // We round-trip these unchanged on price-only applies so the form
        // doesn't accidentally clear the user's terminal / service
        // profile / boarding selection.
        const generalSettings = {}
        let generalFs = null
        for (const fs of pricingForm.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (legend && /^general\s*settings$/i.test((legend.textContent || "").trim())) {
                generalFs = fs
                break
            }
        }
        if (generalFs) {
            for (const sel of generalFs.querySelectorAll("select")) {
                const name = sel.getAttribute("name") || ""
                if (!name) continue
                const opt = sel.options[sel.selectedIndex]
                generalSettings[name] = opt ? (opt.getAttribute("value") || "") : ""
            }
        }

        return {
            endpoint,
            sessionId,
            formActionPath,
            formId,
            hiddenFields,
            currentPrices,
            defaults,
            sliderRanges,
            generalSettings,
            classOrder,
            classLabels: Object.keys(classLabels).length ? classLabels : null,
            // Echo the per-class field names AS exposed in this snapshot.
            // Trusted over FIELD_NAMES.prices when both differ.
            observedFieldNames: Object.keys(observedFieldNames).length ? observedFieldNames : null
        }
    }

    /**
     * Build the URL-encoded form body. Submit-button name is included as
     * a body field per Wicket convention (the AS form uses native
     * <button name="..."> submits, so the body has to disambiguate).
     *
     * Designed to be reused by 3.2/3.3 — pass `prices` as a partial map;
     * any class missing from `prices` is sent at its current value
     * (round-trip preserves AS state for unspecified classes). This
     * matters when the user only wants to bump Y but the form expects
     * all four price fields.
     */
    static buildBody({formContext, prices, settings, scope, submitButton}) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()

        // Hidden inputs first.
        for (const k in formContext.hiddenFields) {
            body.set(k, formContext.hiddenFields[k])
        }

        // Per-class prices. Use the observed field name when available so
        // an AS reordering of the table doesn't misalign indices.
        const observed = formContext.observedFieldNames || {}
        const fallback = RouteAssistantPricingApplier.FIELD_NAMES.prices
        const merged = {}
        for (const cls of (formContext.classOrder || [])) {
            if (!cls) continue
            const fieldName = observed[cls] || fallback[cls]
            if (!fieldName) continue
            const desired = prices && prices[cls] != null ? prices[cls] : formContext.currentPrices[cls]
            const blank = typeof desired === "string" && desired.trim() === ""
            const numeric = blank ? NaN : Number(desired)
            if (desired == null || !isFinite(numeric)) continue
            merged[cls] = RouteAssistantPricingApplier._normalisePriceForClass(cls, numeric)
            body.set(fieldName, RouteAssistantPricingApplier._formatPriceForForm(cls, numeric))
        }

        // General settings — round-trip every <select> at its current
        // selected value unless the caller provides an override.
        const settingsMap = settings || {}
        for (const fieldName in formContext.generalSettings) {
            const override = settingsMap[fieldName]
            const value = override != null ? override : formContext.generalSettings[fieldName]
            body.set(fieldName, String(value))
        }

        // Scope checkboxes — Wicket only sends checked checkboxes on
        // <form>.submit(); unchecked boxes are absent from the body. Mirror that.
        // The per-leg form on `/app/com/numbers/<id>/<leg>` doesn't expose
        // these checkboxes — its scope is implicit (this leg, this flight
        // number). Only emit them on the markets-page form.
        const endpoint = (formContext && formContext.endpoint) || RouteAssistantPricingApplier.DEFAULT_ENDPOINT
        if (endpoint === "markets") {
            const eff = Object.assign({}, RouteAssistantPricingApplier.DEFAULT_SCOPE, scope || {})
            const scopeFields = RouteAssistantPricingApplier.FIELD_NAMES.scope
            for (const k in scopeFields) {
                if (eff[k]) body.set(scopeFields[k], "on")
            }
        }

        // Submit button. Required — Wicket disambiguates which submit
        // handler to invoke by which submit name is in the body.
        const sb = submitButton || RouteAssistantPricingApplier.DEFAULT_SUBMIT
        // Native browser form submission sends an empty value for these
        // Wicket buttons. Some AS handlers distinguish that from "1".
        body.set(sb, "")

        return body
    }

    /**
     * Deterministic fingerprint for (route + prices + scope). Used by
     * the apply log to dedup repeated identical applies (a misclick
     * within minutes shouldn't pollute the audit trail with two
     * identical entries). Sub-classes / future modes can extend the
     * input set.
     */
    static fingerprint(hub, dest, prices, scope, target) {
        const parts = []
        parts.push("h=" + String(hub || "").toUpperCase())
        parts.push("d=" + String(dest || "").toUpperCase())
        const p = prices || {}
        parts.push("Y=" + (p.Y != null     ? RouteAssistantPricingApplier._formatPriceForFingerprint("Y", p.Y)     : ""))
        parts.push("C=" + (p.C != null     ? RouteAssistantPricingApplier._formatPriceForFingerprint("C", p.C)     : ""))
        parts.push("F=" + (p.F != null     ? RouteAssistantPricingApplier._formatPriceForFingerprint("F", p.F)     : ""))
        parts.push("X=" + (p.Cargo != null ? RouteAssistantPricingApplier._formatPriceForFingerprint("Cargo", p.Cargo) : ""))
        const s = scope || {}
        parts.push("ap=" + (s.airportPair         ? 1 : 0))
        parts.push("fn=" + (s.flightNumbers       ? 1 : 0))
        parts.push("rap=" + (s.returnAirportPair  ? 1 : 0))
        parts.push("rfn=" + (s.returnFlightNumbers ? 1 : 0))
        // Endpoint targeting — fold in flight-number id + leg so a
        // dedup window doesn't collapse two distinct per-FN applies
        // that happen to ask for the same prices on the same route.
        const t = target || {}
        if (t.endpoint === "flightNumbers") {
            parts.push("ep=fn")
            parts.push("fnId=" + (t.flightNumberId != null ? t.flightNumberId : ""))
            parts.push("leg=" + (t.legIndex != null ? t.legIndex : 0))
        }
        return parts.join("|")
    }

    // ------------------------------------------------------------------
    // Apply pipeline — orchestrates GET handshake → preflight → POST.
    // ------------------------------------------------------------------

    /**
     * Warm the per-route own-pricing cache by issuing one GET to the
     * markets page and persisting the parsed `currentPrices` so subsequent
     * apply calls can read absolute prices without requiring the user to
     * navigate the page first. Delegates to the markets-page-scraper when
     * available (which writes the canonical `routeAssistant:markets:ownPricing:HUB-DEST`
     * record under the account-scoped key); falls back to a self-contained
     * GET + parseFormContext when the scraper module isn't loaded.
     *
     * Best-effort and idempotent — any error path returns `{ok: false}`
     * with a reason; callers should fall through to whatever they were
     * going to do without the cache.
     */
    async warmCache(hub, dest, opts) {
        if (!hub || !dest) return {ok: false, error: "hub/dest required"}
        const o = opts || {}
        const endpoint = o.endpoint === "flightNumbers" ? "flightNumbers" : "markets"
        // Markets-page scraper is the canonical writer for the
        // routeAssistant:markets:ownPricing cache; only consult it when
        // we're warming the markets endpoint. The flight-numbers page
        // is per-leg and shares the route's competitor band, so we
        // still write under the same HUB-DEST pair key but tag the
        // record's source so consumers know it came from the leg form.
        if (endpoint === "markets"
                && typeof RouteAssistantMarketsPageScraper !== "undefined"
                && typeof RouteAssistantMarketsPageScraper.prototype !== "undefined"
                && typeof RouteAssistantMarketsPageScraper.prototype.scrape === "function") {
            try {
                const scraper = new RouteAssistantMarketsPageScraper(this.server)
                const saved = await scraper.scrape(hub, dest)
                if (saved && saved.ownPricing && saved.ownPricing.prices
                        && Object.keys(saved.ownPricing.prices).length) {
                    return {ok: true, prices: saved.ownPricing.prices, source: "marketsScraper"}
                }
                return {ok: false, error: "scraper returned no ownPricing"}
            } catch (e) {
                return {ok: false, error: "scraper threw: " + (e && e.message || String(e))}
            }
        }
        try {
            const url = endpoint === "flightNumbers"
                ? RouteAssistantPricingApplier._numbersUrl(this.server, o.flightNumberId, o.legIndex)
                : RouteAssistantPricingApplier._markUrl(this.server, hub, dest)
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return {ok: false, error: "HTTP " + resp.status}
            const html = await resp.text()
            if (RouteAssistantPricingApplier.AUTHENTICATION_RE.test(html)) {
                return {ok: false, error: "notLoggedIn"}
            }
            const fc = RouteAssistantPricingApplier.parseFormContext(html, {endpoint})
            if (!fc || !fc.currentPrices || !Object.keys(fc.currentPrices).length) {
                return {ok: false, error: "noFormContext"}
            }
            const pair = RouteAssistantPricingApplier._pairKey(hub, dest)
            const rec = {
                hub:       String(hub).toUpperCase(),
                dest:      String(dest).toUpperCase(),
                scrapedAt: Date.now(),
                source:    endpoint === "flightNumbers" ? "warmCache:flightNumbers" : "warmCache",
                prices:    fc.currentPrices,
                defaults:  fc.defaults || null,
                sliderRanges: fc.sliderRanges || null,
                generalSettings: fc.generalSettings || null
            }
            const writes = {}
            const legacyKey = "routeAssistant:markets:ownPricing:" + pair
            writes[legacyKey] = rec
            if (typeof window !== "undefined" && window.AesAccountKey
                    && typeof window.AesAccountKey.acctKey === "function") {
                const scopedKey = window.AesAccountKey.acctKey("routeAssistant:markets:ownPricing", pair)
                if (scopedKey !== legacyKey) writes[scopedKey] = rec
            }
            await chrome.storage.local.set(writes)
            return {ok: true, prices: fc.currentPrices, source: endpoint === "flightNumbers" ? "warmCacheFallback:flightNumbers" : "warmCacheFallback"}
        } catch (e) {
            return {ok: false, error: "warmCache threw: " + (e && e.message || String(e))}
        }
    }

    /**
     * Tier 3.1 entry. Walks the full pipeline; in dry-run mode (the
     * default) skips the actual POST and returns a synthetic result so
     * the UI can show exactly what would have been sent.
     *
     * @param {string} hub
     * @param {string} dest
     * @param {object} prices  — partial map; missing classes round-trip
     * @param {object} [opts]
     * @returns {Promise<object>}  result envelope
     */
    async apply(hub, dest, prices, opts) {
        opts = opts || {}
        const pair = RouteAssistantPricingApplier._pairKey(hub, dest)
        const source = opts.source || "manual"
        const applyGate = RouteAssistantPricingApplier.resolveApplyGate({
            enabled:    this.applyEnabled,
            dryRunOnly: this.dryRunOnly,
            liveScopes: this.liveScopes
        }, RouteAssistantPricingApplier._scopeNameForSource(source), {forceDryRun: opts.dryRun})
        const dryRun = applyGate.dryRun
        const scope  = Object.assign({}, RouteAssistantPricingApplier.DEFAULT_SCOPE, opts.scope || {})
        const submitButton = opts.submitButton || RouteAssistantPricingApplier.DEFAULT_SUBMIT
        const reason = (opts.reason || "").toString().slice(0, 240) || null

        const endpoint = opts.endpoint === "flightNumbers" ? "flightNumbers" : RouteAssistantPricingApplier.DEFAULT_ENDPOINT
        const flightNumberId = endpoint === "flightNumbers" && opts.flightNumberId != null
            ? String(opts.flightNumberId)
            : null
        const legIndex = endpoint === "flightNumbers" && isFinite(opts.legIndex)
            ? Math.max(0, parseInt(opts.legIndex, 10))
            : (endpoint === "flightNumbers" ? 0 : null)

        const target = {endpoint, flightNumberId, legIndex}
        const fingerprint = RouteAssistantPricingApplier.fingerprint(hub, dest, prices, scope, target)
        const startedAt = Date.now()

        const baseEnvelope = {
            hub:              String(hub || "").toUpperCase(),
            dest:             String(dest || "").toUpperCase(),
            ts:               startedAt,
            source,
            scope,
            submitButton,
            endpoint,
            flightNumberId,
            legIndex,
            sandboxScenario:  opts.sandboxScenario || null,
            projectedDelta:   opts.projectedDelta  || null,
            preApplySync:     opts.preApplySync    || null,
            reason,
            fingerprint,
            requestedPrices:  prices,
            dryRun,
            applyGate,
            // Tier 3.4 — pass-through observability fields. All optional;
            // the applier doesn't act on them, just threads them onto the
            // log entry so the audit modal can group / annotate.
            batchId:          opts.batchId  || null,
            batchSize:        isFinite(opts.batchSize) ? opts.batchSize : null,
            undoOf:           opts.undoOf   || null,
            proposerStrategy: opts.proposerStrategy || null,
            rationale:        Array.isArray(opts.rationale) ? opts.rationale.slice(0, 12) : null,
            objective:        opts.objective || null
        }

        // Endpoint-mode preflight: flight-numbers writes need a target id.
        if (endpoint === "flightNumbers" && !flightNumberId) {
            return await this._completeAsAborted(baseEnvelope, {
                code:    "noFlightNumberForRoute",
                message: "endpointMode='flightNumbers' but no flightNumberId provided. "
                       + "Resolver couldn't find a flight number on " + pair
                       + "; either flip flightNumbersFallbackToMarkets on or revisit the aircraft pages so AES can scrape the per-tail roster."
            })
        }

        // Step 0 — circuit-breaker cooldown gate. Skip in dry-run; the
        // breaker exists to throttle real POST traffic, dry-run is a pure
        // GET + parse and is safe to run while AS is rate-limiting us.
        if (!dryRun && this.circuitBreakerTrippedAt && this.circuitBreakerCooldownMs > 0) {
            const elapsed = Date.now() - this.circuitBreakerTrippedAt
            if (elapsed < this.circuitBreakerCooldownMs) {
                const remaining = Math.ceil((this.circuitBreakerCooldownMs - elapsed) / 60000)
                return await this._completeAsAborted(baseEnvelope, {
                    code:         "breakerCooldown",
                    message:      "Circuit breaker tripped — cooling down (" + remaining + " min remaining). Reset in Settings → Auto-Pricing.",
                    remainingMin: remaining
                })
            }
        }

        // Step 1 — GET the pricing page so we have a fresh form context.
        // Endpoint dispatch — markets-page (route-level) vs flight-numbers
        // (per-leg). The form structure is identical apart from action
        // suffix + scope-checkbox absence.
        const url = endpoint === "flightNumbers"
            ? RouteAssistantPricingApplier._numbersUrl(this.server, flightNumberId, legIndex)
            : RouteAssistantPricingApplier._markUrl(this.server, hub, dest)
        let html = null
        let formContext = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.status === 429 || resp.status === 503) {
                return await this._handleRateLimit(baseEnvelope, "GET", resp.status)
            }
            if (!resp.ok) {
                return await this._completeAsFailure(baseEnvelope, {
                    code:    "fetchFailed",
                    message: "GET " + url + " returned HTTP " + resp.status,
                    httpStatus: resp.status
                })
            }
            html = await resp.text()
        } catch (e) {
            return await this._completeAsFailure(baseEnvelope, {
                code:    "fetchThrew",
                message: "GET threw: " + (e && e.message || String(e))
            })
        }
        if (RouteAssistantPricingApplier.AUTHENTICATION_RE.test(html)) {
            return await this._completeAsFailure(baseEnvelope, {
                code:    "notLoggedIn",
                message: (endpoint === "flightNumbers" ? "Flight-numbers" : "Markets")
                       + " page returned a login form — sign into AS in this browser tab and retry."
            })
        }
        formContext = RouteAssistantPricingApplier.parseFormContext(html, {endpoint})
        if (!formContext) {
            const where = endpoint === "flightNumbers"
                ? "/app/com/numbers/" + flightNumberId + "/" + legIndex
                : "/app/com/markets/" + pair.replace("-", "")
            return await this._completeAsFailure(baseEnvelope, {
                code:    "noFormContext",
                message: "Couldn't locate the pricing form on " + where
                       + ". AS markup may have changed; refresh the page and retry."
            })
        }

        // Step 2 — preflight. Pure-function, runs against the fetched
        // form context. Caller can short-circuit via `opts.onPreflight`
        // (the modal does this — confirmation step on warnings).
        const preflight = RouteAssistantPricingApplier.preflight({
            formContext,
            prices,
            warnAboveDeltaPct:   this.warnAboveDeltaPct,
            cooldownMinPerRoute: this.cooldownMinPerRoute,
            lastApplyAt:         opts.lastApplyAt || null,
            cooldownMinGlobal:   this.cooldownMinGlobal,
            lastApplyAtGlobal:   opts.lastApplyAtGlobal || null,
            // Per-class gates threaded through from the panel/silent-auto
            // call site. When unset, preflight behaves identically to before.
            classGates:          opts.classGates || null
        })
        baseEnvelope.preflight = preflight
        baseEnvelope.prevPrices = Object.assign({}, formContext.currentPrices)

        if (typeof opts.onPreflight === "function") {
            try {
                const verdict = await opts.onPreflight(preflight, baseEnvelope)
                if (verdict === false || (verdict && verdict.abort)) {
                    return await this._completeAsAborted(baseEnvelope, {
                        code:    "userAborted",
                        message: (verdict && verdict.reason) || "User aborted at preflight"
                    })
                }
            } catch (e) {
                return await this._completeAsFailure(baseEnvelope, {
                    code:    "preflightThrew",
                    message: "Preflight callback threw: " + (e && e.message || String(e))
                })
            }
        }
        if (preflight.blockers.length) {
            return await this._completeAsAborted(baseEnvelope, {
                code:    "preflightBlocked",
                message: "Preflight blockers: " + preflight.blockers.map(b => b.code).join(", "),
                blockers: preflight.blockers
            })
        }

        // Step 3 — build the body. Always built (even in dry-run) so the
        // log entry shows what would have been posted. Disabled classes
        // are dropped here so buildBody falls back to currentPrices for
        // them, leaving AS unchanged on those cabins.
        const filteredPrices = {}
        for (const cls in prices) {
            const gate = opts.classGates && opts.classGates[cls]
            if (gate && gate.enabled === false) continue
            filteredPrices[cls] = prices[cls]
        }

        // Step 3a — min-price floor clamp. Anchored to the AS-stated
        // Minimum Price scraped from the per-flight costing page (see
        // content_flightInfo.js). Caller threads in {Y,C,F,Cargo} via
        // opts.minPrices and the gate via opts.minPriceFloor; when
        // enabled, any class whose target lands below floor×(1+margin)
        // is bumped up to that floor and recorded on the envelope so
        // the audit log + UI can flag it. Belongs in the applier so
        // every caller (silent-auto, bulk panel, future surfaces) gets
        // the same protection.
        const clampResult = RouteAssistantPricingApplier._applyMinPriceFloor(
            filteredPrices, opts.minPrices, opts.minPriceFloor)
        baseEnvelope.minPriceClamps = clampResult.clamps
        baseEnvelope.clamped        = clampResult.clamped

        const body = RouteAssistantPricingApplier.buildBody({
            formContext,
            prices: filteredPrices,
            settings: opts.settings || null,
            scope,
            submitButton
        })
        baseEnvelope.bodyPreview = RouteAssistantPricingApplier._summariseBody(body)
        baseEnvelope.newPrices = RouteAssistantPricingApplier._extractPricesFromBody(body, formContext)

        // Step 4 — Tier 3.1 short-circuit. Dry-run → log + return without POST.
        if (dryRun) {
            return await this._completeAsDryRun(baseEnvelope)
        }

        // Live path. Both top-level gates have to be cleared:
        //   - this.dryRunOnly === false
        //   - this.applyEnabled === true
        // Callers can still force rehearsal with opts.dryRun=true.

        const postUrl = url + "?" + formContext.formActionPath
        let respHtml = null
        let httpStatus = null
        try {
            const resp = await fetch(postUrl, {
                method:      "POST",
                credentials: "include",
                headers:     {"Content-Type": "application/x-www-form-urlencoded"},
                body:        body.toString()
            })
            httpStatus = resp.status
            if (resp.status === 429 || resp.status === 503) {
                return await this._handleRateLimit(baseEnvelope, "POST", resp.status)
            }
            respHtml = await resp.text()
            if (!resp.ok) {
                return await this._completeAsFailure(baseEnvelope, {
                    code:    "postFailed",
                    message: "POST " + postUrl + " returned HTTP " + resp.status,
                    httpStatus
                })
            }
        } catch (e) {
            return await this._completeAsFailure(baseEnvelope, {
                code:    "postThrew",
                message: "POST threw: " + (e && e.message || String(e))
            })
        }

        if (RouteAssistantPricingApplier.PAGE_EXPIRED_RE.test(respHtml)) {
            return await this._completeAsFailure(baseEnvelope, {
                code:    "pageExpired",
                message: "Wicket session expired between GET and POST — retry."
            })
        }

        // Step 5 — verify by parsing the response (which is the same
        // markets/numbers page re-rendered with the new prices applied).
        // When the response doesn't carry the new values, fall back to a
        // separate verify() round-trip — Wicket sometimes returns just
        // a redirect-snippet response.
        let verifiedPrices = await this._verify(hub, dest, {endpoint, flightNumberId, legIndex})
        if (!verifiedPrices) {
            const respContext = RouteAssistantPricingApplier.parseFormContext(respHtml, {endpoint})
            if (respContext && respContext.currentPrices) verifiedPrices = respContext.currentPrices
        }
        const verifyOk = RouteAssistantPricingApplier._verifyMatches(baseEnvelope.newPrices, verifiedPrices)

        baseEnvelope.verifyAt        = Date.now()
        baseEnvelope.verifiedPrices  = verifiedPrices
        baseEnvelope.httpStatus      = httpStatus

        if (verifyOk) return await this._completeAsVerified(baseEnvelope)
        return await this._completeAsPostedUnverified(baseEnvelope)
    }

    /**
     * Pure-function preflight. Returns
     *   {blockers: [...], warnings: [...], deltas: {Y, C, F, Cargo}}
     * — caller decides what to do with each. The modal in panel.js
     * renders both lists; blockers disable the Apply button outright.
     */
    static preflight({formContext, prices, warnAboveDeltaPct,
                      cooldownMinPerRoute, lastApplyAt,
                      cooldownMinGlobal, lastApplyAtGlobal, now,
                      classGates}) {
        const out = {blockers: [], warnings: [], deltas: {}, percentDeltas: {}, skippedClasses: []}
        const nowMs = isFinite(now) ? Number(now) : Date.now()
        if (!formContext) {
            out.blockers.push({code: "noFormContext", message: "No form context"})
            return out
        }
        if (!prices || !Object.keys(prices).length) {
            out.blockers.push({code: "noPrices",      message: "No prices supplied"})
            return out
        }

        const cur = formContext.currentPrices || {}
        const ranges = formContext.sliderRanges || {}

        for (const cls in prices) {
            // Per-class gate: when the user has disabled this class via
            // settings.routeAssistant.pricing.apply.classes.<cls>.enabled = false,
            // skip preflight entirely. The body-builder will preserve the
            // current price at apply time (missing classes round-trip), so
            // the AS form receives an unchanged value for this cabin.
            const gate = classGates && classGates[cls]
            if (gate && gate.enabled === false) {
                out.skippedClasses.push({cls, reason: "disabledByUser"})
                continue
            }
            const newVal = prices[cls]
            const blank = typeof newVal === "string" && newVal.trim() === ""
            const numeric = blank ? NaN : Number(newVal)
            if (newVal == null || !isFinite(numeric)) {
                out.blockers.push({code: "invalidPrice", message: cls + " price is not a finite number", cls})
                continue
            }
            const requested = RouteAssistantPricingApplier._normalisePriceForClass(cls, numeric)
            if (requested < 0) {
                out.blockers.push({code: "negativePrice", message: cls + " price " + requested + " is negative", cls})
                continue
            }
            const r = ranges[cls]
            if (r && (requested < r[0] || requested > r[1])) {
                out.blockers.push({
                    code:    "outOfSliderRange",
                    message: cls + " price " + requested + " is outside AS slider range [" + r[0] + ", " + r[1] + "]",
                    cls,
                    sliderMin: r[0],
                    sliderMax: r[1],
                    requested
                })
            }
            const cv = cur[cls]
            if (cv != null && cv > 0) {
                const delta = requested - cv
                const pct = (delta / cv) * 100
                out.deltas[cls] = delta
                out.percentDeltas[cls] = pct
                // Per-class threshold takes precedence when set; falls back
                // to the route-level `warnAboveDeltaPct` so existing setups
                // keep their behaviour. `gate.maxMove` (when present) is a
                // hard ceiling — exceeding it produces a blocker, not a
                // warning, so the user's per-class trust contract holds.
                const classThreshold = gate && isFinite(Number(gate.deadband))
                    ? Math.max(0, Number(gate.deadband))
                    : (warnAboveDeltaPct || 5)
                if (Math.abs(pct) >= classThreshold) {
                    out.warnings.push({
                        code: "largeDelta",
                        message: cls + " price " + (pct > 0 ? "+" : "") + pct.toFixed(1)
                            + "% (from " + cv + " to " + requested + ")",
                        cls,
                        deltaPct: pct,
                        threshold: classThreshold
                    })
                }
                if (gate && isFinite(Number(gate.maxMove)) && Number(gate.maxMove) > 0
                        && Math.abs(pct) > Number(gate.maxMove)) {
                    out.blockers.push({
                        code:    "perClassMaxMoveExceeded",
                        message: cls + " price |Δ%| " + Math.abs(pct).toFixed(1)
                            + "% exceeds per-class max-move " + gate.maxMove + "%",
                        cls,
                        deltaPct: pct,
                        maxMove:  Number(gate.maxMove)
                    })
                }
            }
        }

        if (cooldownMinPerRoute > 0 && lastApplyAt) {
            const minsSince = (nowMs - lastApplyAt) / 60000
            if (minsSince < cooldownMinPerRoute) {
                const remaining = Math.ceil(cooldownMinPerRoute - minsSince)
                out.blockers.push({
                    code:    "cooldownActive",
                    message: "Last apply on this route was " + Math.round(minsSince)
                        + " min ago; cooldown is " + cooldownMinPerRoute + " min ("
                        + remaining + " min remaining).",
                    remainingMin: remaining
                })
            }
        }

        // Tier 3.2 — second-axis cooldown across every route.
        // Triggers when ANY successful apply landed within the global
        // window. Always evaluated alongside the per-route check so a
        // user who just wrote LAX→JFK can't immediately fire SFO→ORD
        // even though SFO→ORD has its own 0-minute history.
        if (cooldownMinGlobal > 0 && lastApplyAtGlobal) {
            const minsSinceG = (nowMs - lastApplyAtGlobal) / 60000
            if (minsSinceG < cooldownMinGlobal) {
                const remainingG = Math.ceil(cooldownMinGlobal - minsSinceG)
                out.blockers.push({
                    code:    "cooldownActiveGlobal",
                    message: "A successful apply landed " + Math.round(minsSinceG)
                        + " min ago somewhere in your network; global cooldown is "
                        + cooldownMinGlobal + " min (" + remainingG + " min remaining).",
                    remainingMin: remainingG
                })
            }
        }

        return out
    }

    static resolveApplyGate(apply, scopeName, opts) {
        if (typeof window !== "undefined" && window.RouteAssistantPricingPlumbing
                && typeof window.RouteAssistantPricingPlumbing.resolveApplyGate === "function") {
            return window.RouteAssistantPricingPlumbing.resolveApplyGate(apply, scopeName, opts)
        }
        const src = apply && typeof apply === "object" ? apply : {}
        const enabled = src.enabled !== false
        const dryRunOnly = false
        const liveScopes = Object.assign(
            {manual: true, bulk: true, silentAuto: true, bulkRecommended: true},
            src.liveScopes && typeof src.liveScopes === "object" ? src.liveScopes : {}
        )
        if (src.permanentLiveMode === true) {
            liveScopes.manual = true
            liveScopes.bulk = true
            liveScopes.silentAuto = true
            liveScopes.bulkRecommended = true
        }
        const scopeLiveAllowed = scopeName ? liveScopes[scopeName] !== false : true
        const forcedDryRun = !!(opts && opts.forceDryRun)
        const dryRun = forcedDryRun || dryRunOnly || !enabled || !scopeLiveAllowed
        return {
            applyEnabled: enabled,
            dryRunOnly,
            scopeName: scopeName || null,
            scopeLiveAllowed,
            forcedDryRun,
            dryRun,
            liveWrites: !dryRun,
            reason: forcedDryRun ? "forced-dry-run"
                : dryRunOnly ? "dry-run-only"
                : !enabled ? "apply-disabled"
                : !scopeLiveAllowed ? "scope-disabled:" + scopeName
                : "live"
        }
    }

    /**
     * Standalone verify — re-fetch the markets page and parse the
     * current prices without doing a POST. Used as a fallback when the
     * POST response doesn't carry the expected values, and exposed so
     * 3.2's Tier 3 batch can sweep verify across a list of routes.
     */
    async _verify(hub, dest, opts) {
        const o = opts || {}
        const endpoint = o.endpoint === "flightNumbers" ? "flightNumbers" : "markets"
        try {
            const url = endpoint === "flightNumbers"
                ? RouteAssistantPricingApplier._numbersUrl(this.server, o.flightNumberId, o.legIndex)
                : RouteAssistantPricingApplier._markUrl(this.server, hub, dest)
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            const html = await resp.text()
            const ctx = RouteAssistantPricingApplier.parseFormContext(html, {endpoint})
            return ctx ? ctx.currentPrices : null
        } catch (e) {
            return null
        }
    }

    static _verifyMatches(expected, actual) {
        if (!expected || !actual) return false
        for (const k in expected) {
            const e = expected[k]
            const a = actual[k]
            if (e == null || a == null) continue
            if (!RouteAssistantPricingApplier._pricesEqual(k, e, a)) return false
        }
        return true
    }

    /**
     * In-place clamp of `prices` against per-class minimums + safety
     * margin. Pure (apart from mutating its input map). Returns
     * `{clamped, clamps}` where `clamps[cls] = {from, to, floor, marginPct}`
     * lists every class that got bumped up. Disabled gate or missing
     * floor → no-op.
     *
     * @param {Object} prices       — partial {Y,C,F,Cargo} map; mutated.
     * @param {Object} minPrices    — partial {Y,C,F,Cargo} of AS-stated floors.
     * @param {Object} floorCfg     — {enabled, safetyMarginPct} from settings.
     */
    static _applyMinPriceFloor(prices, minPrices, floorCfg) {
        const out = {clamped: false, clamps: {}}
        if (!prices || !minPrices || !floorCfg || floorCfg.enabled === false) return out
        const margin = isFinite(floorCfg.safetyMarginPct) ? Math.max(0, Number(floorCfg.safetyMarginPct)) : 0
        const factor = 1 + margin / 100
        for (const cls in prices) {
            const requestedRaw = prices[cls]
            const requested = Number(requestedRaw)
            const floor = Number(minPrices[cls])
            if (!isFinite(requested) || !isFinite(floor) || floor <= 0) continue
            const effective = Math.ceil(floor * factor)
            if (requested < effective) {
                prices[cls] = effective
                out.clamped = true
                out.clamps[cls] = {from: requested, to: effective, floor, marginPct: margin}
            }
        }
        return out
    }

    // ------------------------------------------------------------------
    // Result envelope writers — every terminal path goes through one of
    // these so the apply log stays consistent across success / dry-run
    // / abort / failure.
    // ------------------------------------------------------------------

    async _completeAsDryRun(envelope) {
        const final = Object.assign({}, envelope, {status: "dry-run"})
        return await this._writeLog(final)
    }

    async _completeAsVerified(envelope) {
        this._resetBreakerCounter()
        await this._syncVerifiedOwnPricingCache(envelope)
        const final = Object.assign({}, envelope, {status: "verified"})
        const written = await this._writeLog(final)
        this._schedulePostApplyOrsArchive(written)
        return written
    }

    async _completeAsPostedUnverified(envelope) {
        this._resetBreakerCounter()
        const final = Object.assign({}, envelope, {
            status: "posted",
            warning: "POST returned 200 but post-write verification didn't match expected prices."
        })
        const written = await this._writeLog(final)
        this._schedulePostApplyOrsArchive(written)
        return written
    }

    /**
     * Velvet Cascade · PR 1B — schedule a post-apply ORS rescrape +
     * snapshot archive when the user has opted in via
     * `settings.ors.snapshotOnApply` (default true). Fire-and-forget; the
     * delay defaults to 5s to give AS time to lazy-refresh the ORS view.
     * Errors are swallowed — apply success is the user-visible outcome,
     * post-apply observation is best-effort instrumentation.
     */
    _schedulePostApplyOrsArchive(record) {
        if (!record || !record.hub || !record.dest) return
        if (record.status !== "verified" && record.status !== "posted") return
        const settings = this.settings || (typeof window !== "undefined"
            ? (window.RouteAssistantSettings && window.RouteAssistantSettings._cached) : null)
        const orsCfg   = settings && settings.ors
        if (orsCfg && orsCfg.snapshotOnApply === false) return
        const delayMs = (orsCfg && Number(orsCfg.postApplyRescrapeDelayMs)) || 5000

        setTimeout(async () => {
            try {
                const scraper = (typeof window !== "undefined") && window.RouteAssistantOrsScraper
                const store   = (typeof window !== "undefined") && window.RouteAssistantOrsSnapshotStore
                if (!scraper || !store) return
                let rec = null
                if (typeof scraper.scrape === "function") {
                    try { rec = await scraper.scrape(record.hub, record.dest, {refresh: true}) }
                    catch (_) { rec = null }
                }
                if (!rec && typeof scraper.loadRecord === "function") {
                    rec = await scraper.loadRecord(record.hub, record.dest)
                }
                if (!rec) return
                await store.archive(record.hub, record.dest, rec, {
                    reason: "post-apply",
                    label:  "after price apply " + (record.id || "")
                })
            } catch (e) {
                console.warn("[AES pricingApplier] post-apply ORS archive failed", e)
            }
        }, Math.max(0, delayMs))
    }

    async _completeAsFailure(envelope, error) {
        const final = Object.assign({}, envelope, {status: "failed", error})
        return await this._writeLog(final)
    }

    async _completeAsAborted(envelope, reason) {
        const final = Object.assign({}, envelope, {status: "aborted", error: reason})
        return await this._writeLog(final)
    }

    async _syncVerifiedOwnPricingCache(record) {
        if (!record || !record.hub || !record.dest) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return
        const verified = record.verifiedPrices || record.newPrices
        if (!verified || !Object.keys(verified).length) return
        const cleanPrices = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            if (verified[cls] === null || verified[cls] === undefined || verified[cls] === "") continue
            const n = RouteAssistantPricingApplier._normalisePriceForClass(cls, verified[cls])
            if (isFinite(n)) cleanPrices[cls] = n
        }
        if (!Object.keys(cleanPrices).length) return
        const pair = RouteAssistantPricingApplier._pairKey(record.hub, record.dest)
        const legacyKey = "routeAssistant:markets:ownPricing:" + pair
        let scopedKey = legacyKey
        if (typeof window !== "undefined" && window.AesAccountKey
                && typeof window.AesAccountKey.acctKey === "function") {
            scopedKey = window.AesAccountKey.acctKey("routeAssistant:markets:ownPricing", pair)
        }
        try {
            const reads = scopedKey === legacyKey ? [legacyKey] : [scopedKey, legacyKey]
            const cur = await chrome.storage.local.get(reads)
            const prev = cur[scopedKey] || cur[legacyKey] || {}
            const next = Object.assign({}, prev, {
                hub: String(record.hub).toUpperCase(),
                dest: String(record.dest).toUpperCase(),
                server: this.server,
                scrapedAt: Date.now(),
                source: "pricingApply:verified",
                prices: Object.assign({}, prev.prices || {}, cleanPrices)
            })
            const writes = {}
            writes[legacyKey] = next
            if (scopedKey !== legacyKey) writes[scopedKey] = next
            await chrome.storage.local.set(writes)
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit("data:route-assistant:markets:updated", {
                    hub: next.hub,
                    dest: next.dest,
                    keysTouched: ["ownPricing"]
                })
            }
        } catch (e) {
            console.warn("[AES pricingApplier] verified price cache sync failed", e)
        }
    }

    /**
     * 429/503 path. Increments the consecutive-error counter, trips the
     * breaker (persisting trippedAt via onBreakerTrip) when threshold is
     * met, and writes a "rateLimit" failure entry to the apply log so the
     * audit trail captures the rejection. The error envelope carries the
     * counter so the modal can surface "halted: HTTP 429 ×3" copy.
     */
    async _handleRateLimit(envelope, where, status) {
        this._consecutiveErrors += 1
        const tripped = this._consecutiveErrors >= this.circuitBreakerThreshold
        if (tripped) {
            this.circuitBreakerTrippedAt = Date.now()
            const reason = "HTTP " + status + " ×" + this._consecutiveErrors + " in a row at " + where
            if (this.onBreakerTrip) {
                try { await this.onBreakerTrip(reason, this.circuitBreakerTrippedAt) }
                catch (e) { console.warn("[AES pricingApplier] onBreakerTrip threw", e) }
            }
        }
        return await this._completeAsFailure(envelope, {
            code:               "rateLimit",
            message:            "AS responded HTTP " + status + " on " + where + ". Consecutive errors: " + this._consecutiveErrors + ".",
            httpStatus:         status,
            consecutiveErrors:  this._consecutiveErrors,
            breakerTripped:     tripped
        })
    }

    /**
     * Called on every non-rate-limit terminal path. Resets the consecutive
     * counter and, if the breaker was previously tripped, fires
     * onBreakerReset so the panel can null circuitBreakerTrippedAt in
     * settings — the next apply runs without the cooldown gate.
     */
    _resetBreakerCounter() {
        if (this._consecutiveErrors === 0 && !this.circuitBreakerTrippedAt) return
        this._consecutiveErrors = 0
        if (this.circuitBreakerTrippedAt && this.onBreakerReset) {
            this.circuitBreakerTrippedAt = null
            try { this.onBreakerReset() }
            catch (e) { console.warn("[AES pricingApplier] onBreakerReset threw", e) }
        } else if (this.circuitBreakerTrippedAt) {
            this.circuitBreakerTrippedAt = null
        }
    }

    async _writeLog(record) {
        if (this.applyLog && typeof this.applyLog.add === "function") {
            try {
                const saved = await this.applyLog.add(record)
                if (saved && saved.id) record.logId = saved.id
            } catch (e) {
                console.warn("[AES pricingApplier] apply-log write failed", e)
            }
        }
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function"
                && (record.status === "verified" || record.status === "posted")) {
            window.AesDataBus.emit("data:route-assistant:pricing:applied", {
                hub:      record.hub,
                dest:     record.dest,
                classes:  record.newPrices ? Object.keys(record.newPrices) : [],
                verified: record.status === "verified"
            })
        }
        return record
    }

    // ------------------------------------------------------------------
    // Static helpers
    // ------------------------------------------------------------------

    static _parseInt(text) {
        if (text == null) return null
        const m = /-?\d[\d,.]*/.exec(String(text).replace(/[^\d,.\-]/g, " "))
        if (!m) return null
        const n = parseInt(m[0].replace(/[,.\s]/g, ""), 10)
        return isFinite(n) ? n : null
    }

    static _parsePrice(text, classKey) {
        if (!RouteAssistantPricingApplier.DECIMAL_CLASS_KEYS[classKey]) {
            return RouteAssistantPricingApplier._parseInt(text)
        }
        if (text == null) return null
        const m = /-?\d[\d,.]*/.exec(String(text).replace(/[^\d,.\-]/g, " "))
        if (!m) return null
        const raw = m[0]
        const sign = raw.charAt(0) === "-" ? -1 : 1
        const body = sign < 0 ? raw.slice(1) : raw
        const sep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","))
        if (sep >= 0) {
            const whole = body.slice(0, sep).replace(/\D/g, "")
            const frac = body.slice(sep + 1).replace(/\D/g, "")
            if (frac.length > 0 && frac.length <= 2) {
                const n = Number((whole || "0") + "." + frac)
                return isFinite(n) ? sign * n : null
            }
        }
        const n = Number(body.replace(/\D/g, ""))
        return isFinite(n) ? sign * n : null
    }

    static _normalisePriceForClass(classKey, value) {
        const n = Number(value)
        if (!isFinite(n)) return NaN
        if (RouteAssistantPricingApplier.DECIMAL_CLASS_KEYS[classKey]) {
            return Math.round(n * 100) / 100
        }
        return Math.round(n)
    }

    static _formatPriceForForm(classKey, value) {
        const n = RouteAssistantPricingApplier._normalisePriceForClass(classKey, value)
        if (!isFinite(n)) return ""
        if (RouteAssistantPricingApplier.DECIMAL_CLASS_KEYS[classKey]) {
            return n.toFixed(2).replace(/\.?0+$/, "")
        }
        return String(Math.round(n))
    }

    static _formatPriceForFingerprint(classKey, value) {
        const n = RouteAssistantPricingApplier._normalisePriceForClass(classKey, value)
        if (!isFinite(n)) return ""
        return RouteAssistantPricingApplier.DECIMAL_CLASS_KEYS[classKey]
            ? n.toFixed(2).replace(/\.?0+$/, "")
            : String(Math.round(n))
    }

    static _pricesEqual(classKey, a, b) {
        const left = RouteAssistantPricingApplier._normalisePriceForClass(classKey, a)
        const right = RouteAssistantPricingApplier._normalisePriceForClass(classKey, b)
        const tolerance = RouteAssistantPricingApplier.DECIMAL_CLASS_KEYS[classKey] ? 0.005 : 0.5
        return isFinite(left) && isFinite(right) && Math.abs(left - right) < tolerance
    }

    static _collectScriptText(doc) {
        if (!doc) return ""
        const out = []
        for (const s of doc.querySelectorAll("script")) {
            if (s.textContent) out.push(s.textContent)
        }
        return out.join("\n")
    }

    static _summariseBody(body) {
        const out = []
        for (const [k, v] of body.entries()) {
            // Truncate long values so the audit trail stays readable.
            const vs = String(v)
            out.push(k + "=" + (vs.length > 80 ? vs.substring(0, 77) + "…" : vs))
        }
        return out.join("&")
    }

    static _extractPricesFromBody(body, formContext) {
        const out = {}
        const observed = formContext.observedFieldNames || {}
        const fallback = RouteAssistantPricingApplier.FIELD_NAMES.prices
        for (const cls of (formContext.classOrder || [])) {
            const fieldName = observed[cls] || fallback[cls]
            if (!fieldName) continue
            const raw = body.get(fieldName)
            if (raw == null) continue
            const n = RouteAssistantPricingApplier._parsePrice(raw, cls)
            if (isFinite(n)) out[cls] = n
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantPricingApplier = RouteAssistantPricingApplier
}
