"use strict"

/**
 * Pay-tier applier — POST write-back to the staffOverview salary form
 * (Slice 8).
 *
 * Pattern: route-assistant/service-profile-applier.js. The salary form on
 * /action/enterprise/staffOverview takes one role at a time: a hidden
 * `action=salary`, the row's `id` (positionId), and the new `amount` in
 * AS$. We GET the page, harvest the form context via
 * CrewMgmtPayTierScraper, build a body that copies every hidden input
 * verbatim, sets the changed amount, and POSTs. Then we re-parse the
 * response and confirm the new `nextWeekSalaryPerEmployee` matches our
 * request.
 *
 * Two-gate (NORTH-STAR §4.1):
 *   - applyEnabled  — user kill switch (settings.crewPay.apply.enabled)
 *   - dryRunOnly    — codebase readiness gate (default TRUE; set false in
 *                     settings.crewPay.apply.dryRunOnly only after manual
 *                     verification per §4.18)
 * Both must be cleared before any POST reaches the wire.
 *
 * Public API:
 *   const applier = new CrewMgmtPayTierApplier(server, {applyLog, applyEnabled, dryRunOnly})
 *   const env = await applier.apply(positionId, newSalaryAS$, {source, formContext?, payTierPp?})
 *
 * Result envelope:
 *   {status: "posted"|"verified"|"failed"|"noop"|"dry-run",
 *    positionId, ts, source, fingerprint,
 *    requestedSalary, payTierPp,
 *    prevValues:     {salaryPerEmployee, nextWeekSalaryPerEmployee, countryAverage},
 *    newValues:      {nextWeekSalaryPerEmployee},
 *    verifiedValues?:{nextWeekSalaryPerEmployee},
 *    verified, httpStatus?, error?:{code, message, httpStatus?}, warning?, bodyPreview?, logId?}
 */
class CrewMgmtPayTierApplier {
    static PAGE_EXPIRED_RE   = /PageExpiredException|Wicket\.PageExpiredException/i
    static AUTHENTICATION_RE = /<form[^>]+action=["'][^"']*\/login/i
    static FORM_CACHE_TTL_MS = 5 * 60 * 1000

    /**
     * @param {string} server
     * @param {object} [opts]
     * @param {CrewMgmtPayTierApplyLog} [opts.applyLog]
     * @param {boolean} [opts.applyEnabled=true]
     * @param {boolean} [opts.dryRunOnly=true]   — codebase gate; default ON
     */
    constructor(server, opts) {
        if (!server) throw new Error("CrewMgmtPayTierApplier: server required")
        opts = opts || {}
        this.server       = server
        this.applyLog     = opts.applyLog || null
        this.applyEnabled = opts.applyEnabled !== false
        this.dryRunOnly   = opts.dryRunOnly !== false
    }

    static _baseUrl(server) {
        return "https://" + server + ".airlinesim.aero"
    }

    static _pageUrl(server) {
        return CrewMgmtPayTierApplier._baseUrl(server)
            + "/action/enterprise/staffOverview"
    }

    /**
     * Build the deterministic apply-log fingerprint.
     */
    static fingerprint(positionId, newSalary) {
        return "pos=" + String(positionId) + "|amt=" + Number(newSalary)
    }

    /**
     * Body builder. Copies every hidden input verbatim, sets
     * action=salary, id=<positionId>, amount=<newSalary>, and the form's
     * submit button name → value (Wicket disambiguates handlers by which
     * submit name is in the body).
     */
    static buildBody(formContext, positionId, newSalary) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()
        for (const k in formContext.hidden) body.set(k, formContext.hidden[k])
        body.set("action", "salary")
        body.set("id", String(positionId))
        body.set("amount", String(Math.round(Number(newSalary))))
        if (formContext.submit && formContext.submit.name) {
            body.set(formContext.submit.name, formContext.submit.value || "1")
        }
        return body
    }

    /**
     * Apply a new salary for one role. Returns the audit envelope.
     */
    async apply(positionId, newSalary, opts) {
        opts = opts || {}
        const startedAt = Date.now()
        const numAmount = Math.round(Number(newSalary))
        const fingerprint = CrewMgmtPayTierApplier.fingerprint(positionId, numAmount)

        const baseEnvelope = {
            ts:              startedAt,
            positionId:      String(positionId),
            label:           opts.label || null,
            source:          opts.source || "panel",
            fingerprint:     fingerprint,
            requestedSalary: numAmount,
            payTierPp:       isFinite(opts.payTierPp) ? Number(opts.payTierPp) : null
        }

        if (!isFinite(numAmount) || numAmount <= 0) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "badAmount",
                message: "newSalary must be a positive integer (got " + newSalary + ")"
            })
        }
        if (positionId == null || String(positionId) === "") {
            return await this._completeAsFailure(baseEnvelope, {
                code: "badPositionId",
                message: "positionId required"
            })
        }

        // Step 1 — resolve a fresh form context. Prefer caller-provided
        // (e.g. content-staff-overview cached on :latest); fall back to
        // own GET when stale or absent. The applier never reads
        // chrome.storage directly — that coupling lives in callers so the
        // applier stays testable in isolation.
        let formContext = opts.formContext || null
        let pageUrl = CrewMgmtPayTierApplier._pageUrl(this.server)
        let getResponseHtml = null

        if (!formContext || !this._isFresh(formContext)) {
            const fetched = await this._fetchFormContext(pageUrl)
            if (!fetched) {
                return await this._completeAsFailure(baseEnvelope, {
                    code: "noFormContext",
                    message: "Couldn't fetch or parse the staffOverview salary form."
                })
            }
            if (fetched.kind === "login") {
                return await this._completeAsFailure(baseEnvelope, {
                    code: "notLoggedIn",
                    message: "staffOverview returned a login form — sign into AS in this tab and retry."
                })
            }
            if (fetched.kind === "fetchFailed") {
                return await this._completeAsFailure(baseEnvelope, fetched.error)
            }
            formContext = fetched.formContext
            getResponseHtml = fetched.html
        }

        const row = formContext.perRow && formContext.perRow[String(positionId)]
        if (!row) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "positionNotInForm",
                message: "positionId " + positionId + " not present in current staffOverview form."
            })
        }
        baseEnvelope.prevValues = {salaryPerEmployee: null,
            nextWeekSalaryPerEmployee: row.currentAmount != null ? Number(row.currentAmount) : null}
        baseEnvelope.newValues  = {nextWeekSalaryPerEmployee: numAmount}

        // Noop short-circuit — same amount as already staged means nothing
        // to POST. Audit logged so the panel doesn't think the applier is
        // broken.
        if (row.currentAmount != null && Number(row.currentAmount) === numAmount) {
            return await this._completeAsNoop(Object.assign({}, baseEnvelope, {
                warning: "no-op: requested salary matches the currently-staged value"
            }))
        }

        // Step 2 — body. bodyPreview is captured before gate checks so a
        // dry-run audit entry surfaces what would have been posted.
        const body = CrewMgmtPayTierApplier.buildBody(formContext, positionId, numAmount)
        baseEnvelope.bodyPreview = CrewMgmtPayTierApplier._summariseBody(body)

        // Tier gate — codebase readiness. Audit logged as dry-run so the
        // user can preview the would-be POST without firing it.
        if (this.dryRunOnly) {
            return await this._completeAsDryRun(Object.assign({}, baseEnvelope, {
                warning: "dryRunOnly=true — POST suppressed (audit logged as dry-run)"
            }))
        }
        // User kill switch.
        if (!this.applyEnabled) {
            return await this._completeAsNoop(Object.assign({}, baseEnvelope, {
                warning: "applyEnabled=false — POST suppressed"
            }))
        }

        // Step 3 — POST. The form action URL contains a Wicket page-id
        // query suffix that varies per render; resolving against pageUrl
        // (the GET URL) keeps absolute and relative actions both working.
        let postUrl
        try {
            postUrl = new URL(formContext.actionUrl, pageUrl).toString()
        } catch (_) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "badActionUrl",
                message: "Form action '" + formContext.actionUrl + "' could not be resolved."
            })
        }

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
            respHtml = await resp.text()
            if (!resp.ok) {
                return await this._completeAsFailure(baseEnvelope, {
                    code: "postFailed",
                    message: "POST " + postUrl + " returned HTTP " + resp.status,
                    httpStatus
                })
            }
        } catch (e) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "postThrew",
                message: "POST threw: " + (e && e.message || String(e))
            })
        }
        if (CrewMgmtPayTierApplier.PAGE_EXPIRED_RE.test(respHtml)) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "pageExpired",
                message: "Wicket session expired between GET and POST — retry."
            })
        }

        // Step 4 — verify. The POST response is the staffOverview page
        // re-rendered with the new amount; re-parse the row and confirm
        // the new value matches. When the response doesn't expose the form
        // (e.g. AS redirected to a flash page), re-fetch.
        let verifyContext = window.CrewMgmtPayTierScraper
            ? window.CrewMgmtPayTierScraper.parseHtml(respHtml)
            : null
        if (!verifyContext) {
            const re = await this._fetchFormContext(pageUrl)
            if (re && re.kind !== "fetchFailed" && re.kind !== "login") {
                verifyContext = re.formContext
            }
        }
        let verifiedValues = null
        let verified = false
        if (verifyContext && verifyContext.perRow) {
            const verifiedRow = verifyContext.perRow[String(positionId)]
            if (verifiedRow && verifiedRow.currentAmount != null) {
                verifiedValues = {nextWeekSalaryPerEmployee: Number(verifiedRow.currentAmount)}
                verified = Number(verifiedRow.currentAmount) === numAmount
            }
        }
        baseEnvelope.verifiedValues = verifiedValues
        baseEnvelope.verified       = verified
        baseEnvelope.httpStatus     = httpStatus
        if (!verified) {
            baseEnvelope.warning = "POST returned " + httpStatus
                + " but post-write verification didn't match expected amount."
            return await this._writeLog(Object.assign({}, baseEnvelope, {status: "posted"}))
        }
        return await this._writeLog(Object.assign({}, baseEnvelope, {status: "verified"}))
    }

    _isFresh(formContext) {
        if (!formContext || !formContext.capturedAt) return false
        return (Date.now() - formContext.capturedAt) < CrewMgmtPayTierApplier.FORM_CACHE_TTL_MS
    }

    /**
     * GET pageUrl and parse the form context. Returns one of:
     *   {kind: "ok",          formContext, html}
     *   {kind: "login"}
     *   {kind: "fetchFailed", error: {code, message, httpStatus?}}
     *   null                                  // parse miss with no specific cause
     */
    async _fetchFormContext(pageUrl) {
        let html = null
        try {
            const resp = await fetch(pageUrl, {credentials: "include"})
            if (!resp.ok) {
                return {kind: "fetchFailed", error: {
                    code: "fetchFailed",
                    message: "GET " + pageUrl + " returned HTTP " + resp.status,
                    httpStatus: resp.status
                }}
            }
            html = await resp.text()
        } catch (e) {
            return {kind: "fetchFailed", error: {
                code: "fetchThrew",
                message: "GET threw: " + (e && e.message || String(e))
            }}
        }
        if (CrewMgmtPayTierApplier.AUTHENTICATION_RE.test(html)) {
            return {kind: "login"}
        }
        const formContext = window.CrewMgmtPayTierScraper
            ? window.CrewMgmtPayTierScraper.parseHtml(html)
            : null
        if (!formContext) return null
        return {kind: "ok", formContext, html}
    }

    // ---- Result writers --------------------------------------------------

    async _completeAsFailure(envelope, error) {
        return await this._writeLog(Object.assign({}, envelope, {status: "failed", error}))
    }

    async _completeAsNoop(envelope) {
        return await this._writeLog(Object.assign({}, envelope, {status: "noop"}))
    }

    async _completeAsDryRun(envelope) {
        return await this._writeLog(Object.assign({}, envelope, {status: "dry-run"}))
    }

    async _writeLog(record) {
        if (this.applyLog && typeof this.applyLog.add === "function") {
            try {
                const saved = await this.applyLog.add(record)
                if (saved && saved.id) record.logId = saved.id
            } catch (e) {
                console.warn("[AES payTierApplier] apply-log write failed", e)
            }
        }
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function"
                && (record.status === "verified" || record.status === "posted")) {
            window.AesDataBus.emit("data:crewMgmt:payTier:applied", {
                positionId:      record.positionId,
                requestedSalary: record.requestedSalary,
                verified:        !!record.verified
            })
        }
        return record
    }

    static _summariseBody(body) {
        const out = []
        for (const [k, v] of body.entries()) {
            const vs = String(v)
            out.push(k + "=" + (vs.length > 80 ? vs.substring(0, 77) + "…" : vs))
        }
        return out.join("&")
    }
}

if (typeof window !== "undefined") {
    window.CrewMgmtPayTierApplier = CrewMgmtPayTierApplier
}
