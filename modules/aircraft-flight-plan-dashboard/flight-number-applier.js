"use strict"

/**
 * AFP Dashboard — programmatic-POST applier for AS's "New Flight Number"
 * form.
 *
 * MIRRORS `RouteAssistantPricingApplier` (modules/route-assistant/pricing-applier.js).
 * Same `dryRunOnly` / `applyEnabled` double-gate, same fingerprint dedup,
 * same audit-log integration. Live writes are the default; pass
 * `{dryRunOnly: true}` or `apply(..., {dryRun: true})` to rehearse without
 * posting.
 *
 * SAFETY INVARIANT (HANDOVER §10):
 *   - This applier never runs on the AFP page itself. The dashboard only
 *     mounts on `/app/fleets*` (Fleet Hub).
 *   - `modules/aircraft-flight-plan/form-driver.js` (Slice D) remains
 *     read-only on the AFP page; this applier is a SEPARATE module that
 *     proxies a GET, parses the form, and (eventually) POSTs from the
 *     fleet list view. The AFP form-driver invariant is unchanged.
 *
 * Public API:
 *   const applier = new AesAfpFnApplier(server, {applyLog})
 *   const result  = await applier.apply(aircraftId, leg, {source})
 *   // → {status:"verified"|"posted"|"dry-run"|"failed"|"aborted", ...}
 *
 * Static helpers (pure):
 *   AesAfpFnApplier.parseFormContext(html)
 *     → {formActionUrl, formActionPath, hiddenFields,
 *        originOptions, destOptions, hoursOptions, minutesOptions,
 *        priceOptions, serviceOptions,
 *        submitName, submitValue,
 *        currentLocationIata, registration, equipment, typeId,
 *        existingFlightNumberDests}
 *   AesAfpFnApplier.buildBody({formContext, leg})  → URLSearchParams
 *   AesAfpFnApplier.fingerprint(aircraftId, leg)   → string
 */
class AesAfpFnApplier {
    static FIELD_NAMES = {
        origin:      "origin",
        destination: "destination",
        hours:       "departure:hours",
        minutes:     "departure:minutes",
        price:       "price",
        service:     "service"
    }

    static AUTHENTICATION_RE = /<form[^>]+action=["'][^"']*\/login/i
    static PAGE_EXPIRED_RE   = /PageExpiredException|Wicket\.PageExpiredException/i

    constructor(server, opts) {
        if (!server) throw new Error("AesAfpFnApplier: server required")
        opts = opts || {}
        const liveMode = opts.permanentLiveMode !== false
        this.server = server
        this.dryRunOnly   = liveMode ? false : opts.dryRunOnly === true
        this.applyEnabled = liveMode ? true : opts.applyEnabled !== false
        this.cooldownMinPerAircraft = isFinite(opts.cooldownMinPerAircraft)
            ? Math.max(0, Number(opts.cooldownMinPerAircraft))
            : 5
        this.applyLog     = opts.applyLog || null
    }

    static aircraftPageUrl(server, aircraftId) {
        return "https://" + server + ".airlinesim.aero/app/fleets/aircraft/" + aircraftId + "/0"
    }

    // ------------------------------------------------------------------
    // Pure parsing — lifts host.js:findNewFlightForm() logic onto a static
    // helper so it works against a DOMParser doc (off-page) as well as
    // live document. Identifying selectors are unchanged.
    // ------------------------------------------------------------------

    /**
     * Locate the New Flight Number form on a parsed AFP page response and
     * extract everything we need to compose a POST body without re-fetching.
     *
     * Returns null when the form isn't on the page (retired aircraft,
     * permissions issue, AS markup shift). Caller surfaces a clear error.
     */
    static parseFormContext(html) {
        if (!html) return null
        const doc = new DOMParser().parseFromString(html, "text/html")

        // Anchor on the green "Create new flight number" submit. Matches
        // host.js:findNewFlightForm — value text is unique on the page
        // (sidebar Transfer + Settings buttons say "Transfer..." / "Apply...").
        const submitBtn = doc.querySelector("input[type='submit'][value*='Create new flight']")
        if (!submitBtn) return null
        const form = submitBtn.closest("form")
        if (!form) return null

        const originSelect  = form.querySelector("select[name='origin']")
                           || form.querySelector("select[name*='origin']")
        const destSelect    = form.querySelector("select[name='destination']")
                           || form.querySelector("select[name*='destination']")
        const hoursSelect   = form.querySelector("select[name='departure:hours']")
        const minsSelect    = form.querySelector("select[name='departure:minutes']")
        const priceSelect   = form.querySelector("select[name='price']")
        const serviceSelect = form.querySelector("select[name='service']")

        if (!originSelect || !destSelect || !hoursSelect || !minsSelect) {
            // Required selects missing — the page is showing a different
            // tab or AS reordered the form. Bail rather than build a
            // half-formed body.
            return null
        }

        // Form action — full URL on AS. Strip the host so we can rebuild the
        // POST without re-encoding the airline. Wicket page-version IDs are
        // baked into the query string (?<v>-<form-path>) and rotate per GET,
        // so we must always round-trip the action URL we just observed.
        const formActionUrl = form.getAttribute("action") || ""
        // Mirror pricing-applier's `actionPath` extraction so a future
        // off-page POST has a clean (host, path) split.
        const actionMatch = /\?([^"'#]+)$/.exec(formActionUrl)
        const formActionPath = actionMatch ? actionMatch[1] : null

        const hiddenFields = {}
        for (const inp of form.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) hiddenFields[name] = inp.getAttribute("value") || ""
        }

        const submitName  = submitBtn.getAttribute("name")  || null
        const submitValue = submitBtn.getAttribute("value") || ""

        // Parse aircraft context from the page's H1 + sidebar location row
        // so the dashboard can show what aircraft we're talking about
        // without a second round-trip.
        let registration = null, equipment = null
        const h1Spans = doc.querySelectorAll(".as-page-aircraft h1 span")
        if (h1Spans.length >= 1) registration = (h1Spans[0].textContent || "").trim() || null
        if (h1Spans.length >= 2) equipment    = (h1Spans[1].textContent || "").trim() || null

        let currentLocationIata = null
        const sidebar = doc.querySelector(".as-page-aircraft .col-md-2 .as-table-well table")
        if (sidebar) {
            for (const tr of sidebar.querySelectorAll("tr")) {
                const th = tr.querySelector("th")
                if (!th) continue
                if (/^last airport/i.test((th.textContent || "").trim())) {
                    const a = tr.querySelector("td a")
                    if (a) currentLocationIata = ((a.textContent || a.innerText || "").trim() || null)
                    break
                }
            }
        }

        // Try to read typeId from any link to /app/specs/aircraft/<id> in
        // the spec block. Optional — falls back to null when AS hasn't
        // surfaced the link in this page snapshot.
        let typeId = null
        const specLink = doc.querySelector(".as-page-aircraft a[href*='/app/specs/aircraft/']")
        if (specLink) {
            const m = /\/app\/specs\/aircraft\/(\d+)/.exec(specLink.getAttribute("href") || "")
            if (m) typeId = parseInt(m[1], 10)
        }

        // Existing flight-number destinations — used by the candidate
        // pipeline to filter out routes already in the schedule. Visual
        // Flight Plan blocks list each destination's IATA inside the
        // .visual-flight-plan widget.
        const existingDests = new Set()
        const existingDestCounts = {}
        for (const block of doc.querySelectorAll(".as-panel.visual-flight-plan .vfp .day .blocks > *")) {
            const m = /\b([A-Z]{3})\b/.exec(block.textContent || "")
            if (m) {
                existingDests.add(m[1])
                existingDestCounts[m[1]] = (existingDestCounts[m[1]] || 0) + 1
            }
        }

        return {
            formActionUrl,
            formActionPath,
            hiddenFields,
            originOptions:    AesAfpFnApplier._readOptions(originSelect),
            destOptions:      AesAfpFnApplier._readOptions(destSelect),
            hoursOptions:     AesAfpFnApplier._readOptions(hoursSelect),
            minutesOptions:   AesAfpFnApplier._readOptions(minsSelect),
            priceOptions:     priceSelect   ? AesAfpFnApplier._readOptions(priceSelect)   : [],
            serviceOptions:   serviceSelect ? AesAfpFnApplier._readOptions(serviceSelect) : [],
            submitName,
            submitValue,
            currentLocationIata,
            registration,
            equipment,
            typeId,
            existingFlightNumberDests: Array.from(existingDests),
            existingFlightNumberDestCounts: existingDestCounts
        }
    }

    static _readOptions(sel) {
        if (!sel) return []
        const out = []
        for (const opt of sel.querySelectorAll("option")) {
            out.push({
                value: opt.getAttribute("value") || "",
                text:  (opt.textContent || "").trim()
            })
        }
        return out
    }

    // ------------------------------------------------------------------
    // Body composition — replicates form-driver.js's option-matching so
    // off-page builds align byte-for-byte with what an in-page fill+submit
    // would produce. IATA matching uses \b<IATA>\b on option text (option
    // text format: "City, Region (IATA)"); time + price + service match
    // by exact value.
    // ------------------------------------------------------------------

    static _findOptByIata(options, iata) {
        if (!options || !iata) return null
        const wanted = String(iata).toUpperCase()
        const re = new RegExp("\\b" + wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b")
        for (const opt of options) {
            if (re.test(opt.text || "")) return opt
        }
        return null
    }

    static _findOptByValue(options, value) {
        if (!options) return null
        const wanted = String(value)
        for (const opt of options) {
            if (opt.value === wanted) return opt
        }
        return null
    }

    static _parseTime(hhmm) {
        const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h = parseInt(m[1], 10), mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return null
        return {hours: String(h), minutes: String(mn)}  // AS option values unpadded
    }

    /**
     * Compose the URL-encoded body for one leg. Returns
     *   {body: URLSearchParams, missed: string[]}
     * — missed is a list of fields whose AS option couldn't be matched.
     * The dashboard surfaces missed as preflight blockers so the user
     * can see exactly which select was the holdout.
     */
    static buildBody({formContext, leg}) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()
        const missed = []

        for (const k in (formContext.hiddenFields || {})) {
            body.set(k, formContext.hiddenFields[k])
        }

        const F = AesAfpFnApplier.FIELD_NAMES

        const norm = AesAfpFnApplier._normaliseLeg(leg, formContext)

        const oOpt = AesAfpFnApplier._findOptByIata(formContext.originOptions, norm.origin)
        if (oOpt) body.set(F.origin, oOpt.value); else missed.push("origin")

        const dOpt = AesAfpFnApplier._findOptByIata(formContext.destOptions, norm.destination)
        if (dOpt) body.set(F.destination, dOpt.value); else missed.push("destination")

        const t = AesAfpFnApplier._parseTime(norm.depTime)
        if (t) {
            const hOpt = AesAfpFnApplier._findOptByValue(formContext.hoursOptions, t.hours)
            const mOpt = AesAfpFnApplier._findOptByValue(formContext.minutesOptions, t.minutes)
            if (hOpt) body.set(F.hours,   hOpt.value); else missed.push("departure:hours")
            if (mOpt) body.set(F.minutes, mOpt.value); else missed.push("departure:minutes")
        } else {
            missed.push("depTime")
        }

        const priceVal = (norm.pricePct == null || norm.pricePct === "") ? "" : String(norm.pricePct)
        const pOpt = AesAfpFnApplier._findOptByValue(formContext.priceOptions, priceVal)
        if (pOpt) body.set(F.price, pOpt.value); else missed.push("price")

        const svcVal = String(norm.service == null ? "" : norm.service)
        const sOpt = AesAfpFnApplier._findOptByValue(formContext.serviceOptions, svcVal)
        if (sOpt) body.set(F.service, sOpt.value); else missed.push("service")

        // Submit button — Wicket disambiguates by submit name in the body.
        if (formContext.submitName) {
            body.set(formContext.submitName, formContext.submitValue || "1")
        }

        return {body, missed}
    }

    static _normaliseLeg(leg, formContext) {
        const l = leg || {}
        return {
            origin:      l.origin      || (formContext && formContext.currentLocationIata) || null,
            destination: l.destination || null,
            depTime:     l.depTime     || "09:00",
            pricePct:    (l.pricePct == null) ? 100 : l.pricePct,
            service:     (typeof l.service === "string") ? l.service : ""
        }
    }

    static fingerprint(aircraftId, leg) {
        const l = leg || {}
        const parts = [
            "ac="   + String(aircraftId || ""),
            "o="    + String(l.origin      || "").toUpperCase(),
            "d="    + String(l.destination || "").toUpperCase(),
            "t="    + String(l.depTime     || ""),
            "p="    + (l.pricePct == null ? "" : String(l.pricePct)),
            "svc="  + String(l.service == null ? "" : l.service)
        ]
        return parts.join("|")
    }

    static _summariseBody(body) {
        const out = []
        for (const [k, v] of body.entries()) {
            const vs = String(v)
            out.push(k + "=" + (vs.length > 80 ? vs.substring(0, 77) + "…" : vs))
        }
        return out.join("&")
    }

    static _resolvePostUrl(server, aircraftId, formContext) {
        const base = AesAfpFnApplier.aircraftPageUrl(server, aircraftId)
        const raw = (formContext && formContext.formActionUrl) || ""
        if (raw) {
            try { return new URL(raw, base).toString() }
            catch (_) { /* fall through */ }
        }
        if (formContext && formContext.formActionPath) {
            return base + "?" + formContext.formActionPath
        }
        return base
    }

    static _destCount(formContext, dest) {
        if (!formContext || !dest) return 0
        const key = String(dest).toUpperCase()
        const counts = formContext.existingFlightNumberDestCounts || {}
        if (isFinite(counts[key])) return Number(counts[key])
        return Array.isArray(formContext.existingFlightNumberDests)
            && formContext.existingFlightNumberDests.indexOf(key) >= 0
            ? 1 : 0
    }

    static _successStatus(status) {
        return status === "dry-run" || status === "verified" || status === "posted"
    }

    // ------------------------------------------------------------------
    // Apply pipeline — compose the AS form body, optionally dry-run, then
    // POST and verify the aircraft's VFP destination count changed.
    // ------------------------------------------------------------------

    /**
     * Compose the POST body for one leg against a freshly-fetched form
     * context. Always returns a result envelope; the apply log is written
     * once per call, including dry-run entries.
     *
     * @param {string|number} aircraftId
     * @param {object} leg     {origin, destination, depTime, pricePct, service}
     * @param {object} [opts]  {source, formContext, reason, dryRun}
     */
    async apply(aircraftId, leg, opts) {
        opts = opts || {}
        const source    = opts.source || "manual"
        const reason    = (opts.reason || "").toString().slice(0, 240) || null
        const startedAt = Date.now()
        const dryRun    = opts.dryRun === true || this.dryRunOnly || !this.applyEnabled

        const fingerprint = AesAfpFnApplier.fingerprint(aircraftId, leg)

        const baseEnvelope = {
            ok:           false,
            ts:           startedAt,
            server:       this.server,
            aircraftId:   String(aircraftId || ""),
            registration: null,
            equipment:    null,
            status:       "unknown",
            source,
            leg:          Object.assign({}, leg || {}),
            postUrl:      null,
            submitButton: null,
            bodyPreview:  null,
            fingerprint,
            blockers:     null,
            warnings:     null,
            error:        null,
            reason,
            httpStatus:   null,
            verifyAt:     null
        }

        // formContext can be passed through (avoids a second proxy GET when
        // the panel already pre-fetched). Otherwise we'd require Tier 2's
        // proxy fetcher right here; the dashboard pre-fetches in panel.js.
        const formContext = opts.formContext || null
        if (!formContext) {
            const fail = Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {
                    code:    "noFormContext",
                    message: "apply() called without a pre-fetched formContext (T1 panel responsibility)"
                }
            })
            return await this._writeLog(fail)
        }
        baseEnvelope.registration = formContext.registration || null
        baseEnvelope.equipment    = formContext.equipment    || null
        baseEnvelope.postUrl      = formContext.formActionUrl || null
        baseEnvelope.submitButton = formContext.submitName    || null

        // Preflight: dest must exist in the option list; depTime must parse.
        // Cooldown is read from apply-log when present (defensive — T1 has
        // no cooldown active, but the slot is wired so T2 inherits it).
        const blockers = []
        const warnings = []

        if (!leg || !leg.destination) {
            blockers.push({code: "noDestination", message: "Leg has no destination"})
        } else {
            const dOpt = AesAfpFnApplier._findOptByIata(formContext.destOptions, leg.destination)
            if (!dOpt) {
                blockers.push({
                    code:    "destinationNotInOptions",
                    message: leg.destination + " is not a selectable destination on this aircraft's form (no station / route license / out of range)"
                })
            }
        }
        if (leg && leg.depTime && !AesAfpFnApplier._parseTime(leg.depTime)) {
            blockers.push({code: "badDepTime", message: "depTime '" + leg.depTime + "' is not HH:MM"})
        }
        if (formContext.existingFlightNumberDests
            && leg && leg.destination
            && formContext.existingFlightNumberDests.indexOf(String(leg.destination).toUpperCase()) >= 0) {
            warnings.push({
                code:    "alreadyScheduled",
                message: leg.destination + " already appears in the Visual Flight Plan — duplicate flight numbers are allowed by AS but you may not want one."
            })
        }
        if (!dryRun && this.applyLog && this.cooldownMinPerAircraft > 0
                && typeof this.applyLog.getLastSuccessAt === "function") {
            try {
                const lastSuccess = await this.applyLog.getLastSuccessAt(this.server, aircraftId)
                if (lastSuccess) {
                    const minsSince = (Date.now() - lastSuccess) / 60000
                    if (minsSince < this.cooldownMinPerAircraft) {
                        blockers.push({
                            code: "cooldownActive",
                            message: "A flight-number apply landed "
                                + Math.round(minsSince) + " min ago on this aircraft; cooldown is "
                                + this.cooldownMinPerAircraft + " min.",
                            remainingMin: Math.ceil(this.cooldownMinPerAircraft - minsSince)
                        })
                    }
                }
            } catch (e) {
                warnings.push({
                    code: "cooldownCheckFailed",
                    message: "Could not read last apply cooldown: " + ((e && e.message) || String(e))
                })
            }
        }

        if (blockers.length) {
            const fail = Object.assign({}, baseEnvelope, {
                status:   "aborted",
                blockers,
                warnings: warnings.length ? warnings : null,
                error: {
                    code:    "preflightBlocked",
                    message: "Preflight blockers: " + blockers.map(b => b.code).join(", ")
                }
            })
            return await this._writeLog(fail)
        }

        // Compose body (always, even in dry-run, so the audit log shows
        // what would have been sent).
        let bodyResult
        try {
            bodyResult = AesAfpFnApplier.buildBody({formContext, leg})
        } catch (e) {
            const fail = Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {
                    code:    "buildBodyThrew",
                    message: "buildBody threw: " + ((e && e.message) || String(e))
                }
            })
            return await this._writeLog(fail)
        }

        const {body, missed} = bodyResult
        if (missed && missed.length) {
            // Treat missed selects as additional blockers — without them
            // the body is incomplete and AS would reject it.
            for (const f of missed) blockers.push({code: "missingField", message: "Could not match form field: " + f, field: f})
            const fail = Object.assign({}, baseEnvelope, {
                status:   "aborted",
                blockers,
                warnings: warnings.length ? warnings : null,
                bodyPreview: AesAfpFnApplier._summariseBody(body),
                error: {
                    code:    "preflightBlocked",
                    message: "Body composition incomplete: " + missed.join(", ")
                }
            })
            return await this._writeLog(fail)
        }

        baseEnvelope.bodyPreview = AesAfpFnApplier._summariseBody(body)
        baseEnvelope.warnings    = warnings.length ? warnings : null

        if (dryRun) {
            const final = Object.assign({}, baseEnvelope, {status: "dry-run"})
            return await this._writeLog(final)
        }

        const postUrl = AesAfpFnApplier._resolvePostUrl(this.server, aircraftId, formContext)
        baseEnvelope.postUrl = postUrl
        const dest = leg && leg.destination ? String(leg.destination).toUpperCase() : ""
        const beforeCount = AesAfpFnApplier._destCount(formContext, dest)
        let respHtml = null
        let httpStatus = null
        try {
            const resp = await fetch(postUrl, {
                method:      "POST",
                credentials: "include",
                headers:     {"Content-Type": "application/x-www-form-urlencoded"},
                body:        body.toString(),
                referrer:    AesAfpFnApplier.aircraftPageUrl(this.server, aircraftId)
            })
            httpStatus = resp.status
            baseEnvelope.httpStatus = httpStatus
            respHtml = await resp.text()
            if (!resp.ok) {
                return await this._writeLog(Object.assign({}, baseEnvelope, {
                    status: "failed",
                    error: {
                        code: "postFailed",
                        message: "POST " + postUrl + " returned HTTP " + resp.status,
                        httpStatus
                    }
                }))
            }
        } catch (e) {
            return await this._writeLog(Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {
                    code: "postThrew",
                    message: "POST threw: " + ((e && e.message) || String(e))
                }
            }))
        }

        if (AesAfpFnApplier.AUTHENTICATION_RE.test(respHtml || "")) {
            return await this._writeLog(Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {
                    code: "notLoggedIn",
                    message: "POST returned a login form — sign into AS in this browser tab and retry."
                }
            }))
        }
        if (AesAfpFnApplier.PAGE_EXPIRED_RE.test(respHtml || "")) {
            return await this._writeLog(Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {
                    code: "pageExpired",
                    message: "Wicket session expired between GET and POST — retry."
                }
            }))
        }

        let verifyContext = AesAfpFnApplier.parseFormContext(respHtml)
        if (!verifyContext) {
            try {
                const verifyResp = await fetch(AesAfpFnApplier.aircraftPageUrl(this.server, aircraftId), {
                    credentials: "include"
                })
                const verifyHtml = await verifyResp.text()
                if (verifyResp.ok && !AesAfpFnApplier.AUTHENTICATION_RE.test(verifyHtml)) {
                    verifyContext = AesAfpFnApplier.parseFormContext(verifyHtml)
                }
            } catch (_) { /* posted-unverified is still a useful terminal state */ }
        }

        baseEnvelope.verifyAt = Date.now()
        if (verifyContext) {
            baseEnvelope.verifiedFlightNumberDests = verifyContext.existingFlightNumberDests || null
        }
        const afterCount = AesAfpFnApplier._destCount(verifyContext, dest)
        if (dest && afterCount > beforeCount) {
            return await this._writeLog(Object.assign({}, baseEnvelope, {status: "verified"}))
        }
        return await this._writeLog(Object.assign({}, baseEnvelope, {
            status: "posted",
            warning: "POST returned " + (httpStatus || "OK")
                + " but the follow-up VFP count did not prove the new destination."
        }))
    }

    async _writeLog(record) {
        record = record || {}
        record.ok = AesAfpFnApplier._successStatus(record.status)
        if (this.applyLog && typeof this.applyLog.add === "function") {
            try {
                const saved = await this.applyLog.add(record)
                if (saved && saved.id) record.logId = saved.id
            } catch (e) {
                console.warn("[AES afp-dashboard] apply-log write failed", e)
            }
        }
        return record
    }
}

if (typeof window !== "undefined") {
    window.AesAfpFnApplier = AesAfpFnApplier
}
