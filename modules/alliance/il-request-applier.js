"use strict"

/**
 * Alliance / IL request applier — POST a contractual-partner request to
 * the partner's enterprise page (Slice 12).
 *
 * AS exposes IL agreements through `/app/info/enterprises/<id>?tab=1`
 * ("Contractual partners"). The bilateral nature of the protocol means
 * one party submits a request and the other accepts; this applier handles
 * the *send* side only. Per spec: "engine can't unilaterally form" — the
 * partner still has to accept on their side.
 *
 * Pattern follows route-assistant/service-profile-applier.js +
 * crew-management/pay-tier-applier.js: GET the partner's tab=1, harvest
 * the form context (Wicket hidden inputs, action URL, submit button name),
 * build a body, POST, verify by re-parsing the response. Two gates per
 * NORTH-STAR §4.1:
 *   - applyEnabled  — user kill switch (settings.alliance.apply.enabled)
 *   - dryRunOnly    — codebase-readiness gate; **default TRUE** because
 *                     the AS form structure for IL requests has not been
 *                     calibrated against a live AS instance in this slice.
 *                     Manual verification of the form's submit-button name
 *                     and required hidden fields is required before
 *                     flipping `dryRunOnly:false` in default-settings.js.
 *
 * Both gates must be cleared for any POST to reach the wire. While
 * dryRunOnly is on, the applier still runs the full GET → parse → body
 * build → audit-log path and returns status:"dry-run" with bodyPreview,
 * giving the user a complete preview of what would be sent.
 *
 * Public API:
 *   const a = new AllianceIlRequestApplier(server, {applyLog, applyEnabled, dryRunOnly})
 *   const env = await a.apply(partnerEnterpriseId, {source, requestType?})
 *
 * Result envelope:
 *   {status: "dry-run"|"posted"|"verified"|"failed"|"noop",
 *    partnerEnterpriseId, ts, source, fingerprint,
 *    requestType,                       // "INTERLINING" | "CODESHARE" | "ALLIANCE"
 *    bodyPreview?, httpStatus?,
 *    formAvailable: bool,               // did we find the request form?
 *    error?:{code, message, httpStatus?}, warning?, logId?}
 */
class AllianceIlRequestApplier {
    static PAGE_EXPIRED_RE   = /PageExpiredException|Wicket\.PageExpiredException/i
    static AUTHENTICATION_RE = /<form[^>]+action=["'][^"']*\/login/i
    // Substrings we'll accept as evidence of a "request agreement" form.
    // The exact action string varies per AS deployment; this list is a
    // best-guess detector that errs on the side of dry-run-only when
    // unsure. Manual verification adds entries on calibration.
    static REQUEST_ACTION_HINTS = [
        "agreement", "interline", "interlining", "codeshare",
        "request", "contractualPartners", "partner"
    ]

    /**
     * @param {string} server
     * @param {object} [opts]
     * @param {AllianceIlRequestApplyLog} [opts.applyLog]
     * @param {boolean} [opts.applyEnabled=true]
     * @param {boolean} [opts.dryRunOnly=true]   — codebase gate; default ON
     */
    constructor(server, opts) {
        if (!server) throw new Error("AllianceIlRequestApplier: server required")
        opts = opts || {}
        this.server       = server
        this.applyLog     = opts.applyLog || null
        this.applyEnabled = opts.applyEnabled !== false
        this.dryRunOnly   = opts.dryRunOnly !== false
    }

    static _baseUrl(server) {
        return "https://" + server + ".airlinesim.aero"
    }

    static _partnerPageUrl(server, partnerEnterpriseId) {
        return AllianceIlRequestApplier._baseUrl(server)
            + "/app/info/enterprises/"
            + encodeURIComponent(String(partnerEnterpriseId)) + "?tab=1"
    }

    static fingerprint(partnerEnterpriseId, requestType) {
        return "ilreq:" + String(partnerEnterpriseId) + ":" + (requestType || "INTERLINING")
    }

    /**
     * Pure parser. Walks the partner's tab=1 HTML for a form whose
     * action URL contains one of the request hints. Returns the form
     * skeleton (action URL, hidden fields, submit button) or null when
     * the page lacks an actionable request form (most common case —
     * partners we already have agreements with don't render the form).
     */
    static parseRequestForm(html) {
        if (!html) return null
        let doc
        try { doc = new DOMParser().parseFromString(html, "text/html") }
        catch (_) { return null }

        let form = null
        for (const f of doc.querySelectorAll("form")) {
            const action = (f.getAttribute("action") || "").toLowerCase()
            if (!action) continue
            for (const hint of AllianceIlRequestApplier.REQUEST_ACTION_HINTS) {
                if (action.indexOf(hint) >= 0) { form = f; break }
            }
            if (form) break
        }
        if (!form) return null

        const actionUrl = form.getAttribute("action") || ""
        const hidden = {}
        for (const inp of form.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) hidden[name] = inp.getAttribute("value") || ""
        }
        let submit = null
        const submitEl = form.querySelector(
            "button[type='submit'][name], input[type='submit'][name], "
            + "button[name][type=submit], button[name]:not([type='button'])"
        )
        if (submitEl) {
            submit = {
                name:  submitEl.getAttribute("name"),
                value: submitEl.getAttribute("value") || "1"
            }
        }
        return {actionUrl, hidden, submit, capturedAt: Date.now()}
    }

    /**
     * Body builder. Copies every hidden input verbatim and adds the
     * submit button name → value. Wicket forms route to the right
     * server-side handler via the submit button's name; without it
     * the POST silently no-ops.
     */
    static buildBody(formContext) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()
        for (const k in formContext.hidden) body.set(k, formContext.hidden[k])
        if (formContext.submit && formContext.submit.name) {
            body.set(formContext.submit.name, formContext.submit.value || "1")
        }
        return body
    }

    /**
     * Send a request. Returns the audit envelope.
     */
    async apply(partnerEnterpriseId, opts) {
        opts = opts || {}
        const startedAt = Date.now()
        const partnerId = String(partnerEnterpriseId)
        const requestType = opts.requestType || "INTERLINING"
        const fingerprint = AllianceIlRequestApplier.fingerprint(partnerId, requestType)

        const baseEnvelope = {
            ts:                  startedAt,
            partnerEnterpriseId: partnerId,
            partnerName:         opts.partnerName || null,
            requestType:         requestType,
            source:              opts.source || "panel",
            fingerprint:         fingerprint,
            formAvailable:       false
        }
        if (!partnerId) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "badPartnerId",
                message: "partnerEnterpriseId required"
            })
        }

        // Step 1 — GET partner's tab=1 page.
        const url = AllianceIlRequestApplier._partnerPageUrl(this.server, partnerId)
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                return await this._completeAsFailure(baseEnvelope, {
                    code: "fetchFailed",
                    message: "GET " + url + " returned HTTP " + resp.status,
                    httpStatus: resp.status
                })
            }
            html = await resp.text()
        } catch (e) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "fetchThrew",
                message: "GET threw: " + (e && e.message || String(e))
            })
        }
        if (AllianceIlRequestApplier.AUTHENTICATION_RE.test(html)) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "notLoggedIn",
                message: "Partner page returned a login form — sign into AS in this tab and retry."
            })
        }

        // Step 2 — locate form. Most partners we already have agreements
        // with won't render the request form; "noop" with formAvailable:
        // false is the right outcome (the proposer should have filtered
        // them but defensive against stale partner cache).
        const formContext = AllianceIlRequestApplier.parseRequestForm(html)
        if (!formContext) {
            return await this._completeAsNoop(Object.assign({}, baseEnvelope, {
                warning: "no IL-request form found on " + url
                    + " — partner likely already in a contractual relationship."
            }))
        }
        baseEnvelope.formAvailable = true

        // Step 3 — body. Capture the bodyPreview before gate checks so a
        // dry-run audit entry surfaces what would have been posted.
        const body = AllianceIlRequestApplier.buildBody(formContext)
        baseEnvelope.bodyPreview = AllianceIlRequestApplier._summariseBody(body)

        // Tier gate — codebase readiness. Default ON (NORTH-STAR §4.18).
        if (this.dryRunOnly) {
            return await this._completeAsDryRun(Object.assign({}, baseEnvelope, {
                warning: "dryRunOnly=true — POST suppressed (audit logged as dry-run);"
                    + " manually verify form structure before flipping the codebase gate"
            }))
        }
        // User kill switch.
        if (!this.applyEnabled) {
            return await this._completeAsNoop(Object.assign({}, baseEnvelope, {
                warning: "applyEnabled=false — POST suppressed"
            }))
        }

        // Step 4 — POST.
        let postUrl
        try { postUrl = new URL(formContext.actionUrl, url).toString() }
        catch (_) {
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
        if (AllianceIlRequestApplier.PAGE_EXPIRED_RE.test(respHtml)) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "pageExpired",
                message: "Wicket session expired between GET and POST — retry."
            })
        }

        // Step 5 — verify. The "request sent" confirmation typically
        // makes the form disappear (replaced with a "Pending" notice).
        // We treat a successful POST + form-no-longer-present as
        // verified. If the form is still there the request didn't take.
        let verified = false
        const verifyForm = AllianceIlRequestApplier.parseRequestForm(respHtml)
        if (!verifyForm) verified = true
        baseEnvelope.verified   = verified
        baseEnvelope.httpStatus = httpStatus
        if (!verified) {
            baseEnvelope.warning = "POST returned " + httpStatus
                + " but the request form is still present — the request likely didn't submit."
            return await this._writeLog(Object.assign({}, baseEnvelope, {status: "posted"}))
        }
        return await this._writeLog(Object.assign({}, baseEnvelope, {status: "verified"}))
    }

    // ── Result writers (mirror pay-tier-applier) ─────────────────────

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
                console.warn("[AES ilRequestApplier] apply-log write failed", e)
            }
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

/**
 * IL-request apply-log store. FIFO ring per account, cap 50, dedup window
 * 5 min on the (partnerId, requestType) fingerprint. Mirrors
 * crew-management/pay-tier-apply-log.js — same shape, only the record
 * fields specialise.
 *
 * L1–L3 scoping: when `window.__aesAccountId` is set, the active key is
 * `alliance:ilRequestApplyLog:acct:<accountId>`. Reads fall back to the
 * legacy unscoped `alliance:ilRequestApplyLog` key once when the scoped
 * key misses (one-shot, read-only — no migration write since the cooldown
 * ring self-heals on the next add()). Writes always land on the scoped
 * key when an accountId is available, else on the legacy key (single-
 * account / pre-bootstrap installs).
 */
class AllianceIlRequestApplyLog {
    static LEGACY_KEY    = "alliance:ilRequestApplyLog"
    static GLOBAL_KEY    = "alliance:ilRequestApplyLog"   // back-compat alias
    static DEFAULT_LIMIT = 50

    constructor(opts) {
        opts = opts || {}
        this.limit = isFinite(opts.limit)
            ? Math.max(10, opts.limit)
            : AllianceIlRequestApplyLog.DEFAULT_LIMIT
    }

    static _accountId() {
        try {
            if (typeof window !== "undefined" && window.AesAccountKey
                    && typeof window.AesAccountKey.currentAccountIdSync === "function") {
                return window.AesAccountKey.currentAccountIdSync() || null
            }
            if (typeof currentAccountIdSync === "function") return currentAccountIdSync() || null
        } catch (_) { /* fall through */ }
        return null
    }

    static _activeKey() {
        const id = AllianceIlRequestApplyLog._accountId()
        return id
            ? AllianceIlRequestApplyLog.LEGACY_KEY + ":acct:" + id
            : AllianceIlRequestApplyLog.LEGACY_KEY
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    async add(record, opts) {
        opts = opts || {}
        const dedupWindowMs = isFinite(opts.dedupWindowMs)
            ? opts.dedupWindowMs : 5 * 60 * 1000
        const ts = (record && record.ts) || Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = AllianceIlRequestApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || AllianceIlRequestApplyLog._newId(ts)

        const writeKey = AllianceIlRequestApplyLog._activeKey()
        const got = await chrome.storage.local.get([writeKey])
        const rec = got[writeKey] || {entries: [], updatedAt: 0}
        let entries = Array.isArray(rec.entries) ? rec.entries.slice() : []

        let merged = false
        if (fingerprint && entries.length) {
            const head = entries[0]
            if (head && head.fingerprint === fingerprint
                && head.status === cleaned.status
                && (ts - head.ts) < dedupWindowMs) {
                head.ts = ts
                head.count = (head.count || 1) + 1
                cleaned.id = head.id
                merged = true
            }
        }
        if (!merged) entries.unshift(cleaned)
        if (entries.length > this.limit) entries = entries.slice(0, this.limit)

        await chrome.storage.local.set({
            [writeKey]: {entries, updatedAt: ts}
        })
        return cleaned
    }

    async getRecent(n) {
        const writeKey = AllianceIlRequestApplyLog._activeKey()
        const got = await chrome.storage.local.get([writeKey])
        let rec = got[writeKey]
        // One-shot legacy fallback when the scoped key is empty for this
        // account — surfaces pre-L1 entries to the panel without a write.
        if ((!rec || !Array.isArray(rec.entries) || !rec.entries.length)
                && writeKey !== AllianceIlRequestApplyLog.LEGACY_KEY) {
            try {
                const legacy = await chrome.storage.local.get([AllianceIlRequestApplyLog.LEGACY_KEY])
                if (legacy[AllianceIlRequestApplyLog.LEGACY_KEY]) {
                    rec = legacy[AllianceIlRequestApplyLog.LEGACY_KEY]
                }
            } catch (_) {}
        }
        rec = rec || {entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return {
            entries:   isFinite(n) && n > 0 ? entries.slice(0, n) : entries,
            updatedAt: rec.updatedAt || 0
        }
    }

    async getLastSuccessAtFor(partnerEnterpriseId) {
        if (partnerEnterpriseId == null) return null
        const want = String(partnerEnterpriseId)
        const r = await this.getRecent()
        for (const e of r.entries) {
            if (!e) continue
            if (String(e.partnerEnterpriseId) !== want) continue
            if (e.status === "verified" || e.status === "posted") return e.ts || null
        }
        return null
    }

    async clear() {
        const writeKey = AllianceIlRequestApplyLog._activeKey()
        const keys = (writeKey === AllianceIlRequestApplyLog.LEGACY_KEY)
            ? [writeKey]
            : [writeKey, AllianceIlRequestApplyLog.LEGACY_KEY]
        await chrome.storage.local.remove(keys)
    }

    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:                  r.id || null,
            ts:                  r.ts || Date.now(),
            partnerEnterpriseId: r.partnerEnterpriseId != null
                ? String(r.partnerEnterpriseId) : null,
            partnerName:         r.partnerName || null,
            requestType:         r.requestType || "INTERLINING",
            status:              r.status || "unknown",
            source:              r.source || "panel",
            fingerprint:         r.fingerprint || null,
            formAvailable:       !!r.formAvailable,
            verified:            !!r.verified,
            httpStatus:          r.httpStatus || null,
            error:               r.error ? Object.assign({}, r.error) : null,
            warning:             r.warning ? String(r.warning).slice(0, 240) : null,
            bodyPreview:         r.bodyPreview ? String(r.bodyPreview).slice(0, 1500) : null,
            count:               isFinite(r.count) ? r.count : 1
        }
        for (const k in out) if (out[k] == null) delete out[k]
        return out
    }
}

if (typeof window !== "undefined") {
    window.AllianceIlRequestApplier = AllianceIlRequestApplier
    window.AllianceIlRequestApplyLog = AllianceIlRequestApplyLog
}
