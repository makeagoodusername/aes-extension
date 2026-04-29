"use strict"

/**
 * CentralInventoryQuickPriceApplier — one-shot single-class price update
 * against the AS inventory page's settings form.
 *
 * Mirrors `modules/route-assistant/pricing-applier.js`'s GET → parse →
 * build → POST → verify pipeline but is intentionally narrower:
 *   - drives one class price; carries the other three forward unchanged
 *   - forces scope to `settings:airportPair` only
 *   - no audit/log persistence (the central-hub tile uses toasts instead)
 *
 * The inventory settings form is structurally a near-twin of the markets
 * pricing form (same field names `classes:prices:N:newPrice`, same scope
 * checkbox set, same submit-button names). The form's `action` URL ends
 * in `~panel-settings-settings~form` — that suffix is what disambiguates
 * it from other forms on the page.
 *
 * Public API:
 *   const applier = new CentralInventoryQuickPriceApplier({applyEnabled})
 *   const result = await applier.apply({hub, dest, classKey, newPrice, server,
 *                                       dryRun?, onPreflight?})
 *   // → {status: "dry-run"|"posted"|"verified"|"failed"|"aborted",
 *   //    hub, dest, classKey, prev?, new?, verified?, httpStatus?, error?}
 */
class CentralInventoryQuickPriceApplier {
    static FIELD_NAMES = {
        prices: {
            Y:     "classes:prices:0:newPrice",
            C:     "classes:prices:1:newPrice",
            F:     "classes:prices:2:newPrice",
            Cargo: "classes:prices:3:newPrice"
        },
        scope: {
            airportPair:         "settings:airportPair",
            flightNumbers:       "settings:flightNumbers",
            returnAirportPair:   "settings:returnAirportPair",
            returnFlightNumbers: "settings:returnFlightNumbers"
        }
    }
    static SUBMIT_BUTTON     = "submit-prices"
    static FORM_ACTION_SUFFIX = "~panel-settings-settings~form"

    static PAGE_EXPIRED_RE   = /PageExpiredException|Wicket\.PageExpiredException/i
    static AUTHENTICATION_RE = /<form[^>]+action=["'][^"']*\/login/i

    static VALID_CLASS_KEYS = ["Y", "C", "F", "Cargo"]
    static CANONICAL_PRICE_FIELDS = [
        {cls: "Y",     name: "classes:prices:0:newPrice"},
        {cls: "C",     name: "classes:prices:1:newPrice"},
        {cls: "F",     name: "classes:prices:2:newPrice"},
        {cls: "Cargo", name: "classes:prices:3:newPrice"}
    ]

    constructor(opts) {
        opts = opts || {}
        this.dryRunOnly   = !!opts.dryRunOnly
        this.applyEnabled = opts.applyEnabled !== false
        this.verifyAfter  = opts.verifyAfter !== false
    }

    static _baseUrl(server) {
        return "https://" + server + ".airlinesim.aero"
    }

    static _invUrl(server, hub, dest) {
        return CentralInventoryQuickPriceApplier._baseUrl(server)
            + "/app/com/inventory/"
            + String(hub).toUpperCase() + String(dest).toUpperCase()
    }

    /**
     * Locate the inventory settings form, harvest hidden inputs + every
     * `classes:prices:N:newPrice` value + the General Settings selects so
     * a price-only POST doesn't accidentally clear the user's terminal /
     * profile selections.
     *
     * Returns null when the form can't be found (page format changed,
     * user not on a real inventory page, route doesn't exist).
     */
    static parseFormContext(html) {
        if (!html) return null
        let doc
        try { doc = new DOMParser().parseFromString(html, "text/html") }
        catch (e) { return null }
        if (!doc || !doc.body) return null

        let sessionId = null
        const baseUrlScript = doc.getElementById("wicket-ajax-base-url")
        if (baseUrlScript && baseUrlScript.textContent) {
            const m = /Wicket\.Ajax\.baseUrl\s*=\s*["'][^?"']+\?(\d+)/i.exec(baseUrlScript.textContent)
            if (m) sessionId = m[1]
        }

        let settingsForm = null
        for (const f of doc.querySelectorAll("form[method='post']")) {
            const action = f.getAttribute("action") || ""
            if (action.indexOf(CentralInventoryQuickPriceApplier.FORM_ACTION_SUFFIX) < 0) continue
            if (!f.querySelector("button[name='submit-prices'], input[name='submit-prices']")) continue
            settingsForm = f
            break
        }
        if (!settingsForm) return null

        const formAction = settingsForm.getAttribute("action") || ""
        const actionMatch = /\?([^"'#]+)$/.exec(formAction)
        const formActionPath = actionMatch ? actionMatch[1] : null
        if (!formActionPath) return null

        const hiddenFields = {}
        for (const inp of settingsForm.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) hiddenFields[name] = inp.getAttribute("value") || ""
        }

        const currentPrices = {}
        const observedFieldNames = {}
        const classOrder = []
        for (const spec of CentralInventoryQuickPriceApplier.CANONICAL_PRICE_FIELDS) {
            const inp = settingsForm.querySelector("input[name='" + spec.name + "']")
            if (!inp) continue
            const raw = inp.getAttribute("value")
            const n = parseInt((raw || "").replace(/[^\d-]/g, ""), 10)
            currentPrices[spec.cls] = isFinite(n) ? n : null
            observedFieldNames[spec.cls] = spec.name
            classOrder.push(spec.cls)
        }

        const generalSettings = {}
        for (const fs of settingsForm.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (!legend || !/^general\s*settings$/i.test((legend.textContent || "").trim())) continue
            for (const sel of fs.querySelectorAll("select")) {
                const name = sel.getAttribute("name") || ""
                if (!name) continue
                const opt = sel.options[sel.selectedIndex]
                generalSettings[name] = opt ? (opt.getAttribute("value") || "") : ""
            }
            break
        }

        return {
            sessionId,
            formActionPath,
            hiddenFields,
            currentPrices,
            observedFieldNames,
            classOrder,
            generalSettings
        }
    }

    /**
     * Build the URL-encoded body. Emits all four class prices (the target
     * class at `newPrice`, the others carried forward at their parsed
     * value), every General Settings select unchanged, the airport-pair
     * scope checkbox, and the submit-prices button name.
     *
     * Wicket convention: unchecked checkboxes are absent from the body —
     * NOT sent as `off`. So we deliberately omit flightNumbers,
     * returnAirportPair, returnFlightNumbers.
     */
    static buildBody({formContext, classKey, newPrice}) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()

        for (const k in formContext.hiddenFields) {
            body.set(k, formContext.hiddenFields[k])
        }

        const observed = formContext.observedFieldNames || {}
        const fallback = CentralInventoryQuickPriceApplier.FIELD_NAMES.prices
        const rounded = Math.round(Number(newPrice))
        for (const cls of (formContext.classOrder || [])) {
            const fieldName = observed[cls] || fallback[cls]
            if (!fieldName) continue
            const value = (cls === classKey)
                ? rounded
                : formContext.currentPrices[cls]
            if (value == null || !isFinite(value)) continue
            body.set(fieldName, String(value))
        }

        for (const fieldName in (formContext.generalSettings || {})) {
            body.set(fieldName, String(formContext.generalSettings[fieldName]))
        }

        body.set(CentralInventoryQuickPriceApplier.FIELD_NAMES.scope.airportPair, "on")
        body.set(CentralInventoryQuickPriceApplier.SUBMIT_BUTTON, "1")

        return body
    }

    /**
     * @param {{hub, dest, classKey, newPrice, server,
     *          dryRun?, onPreflight?}} args
     * @returns {Promise<object>}
     */
    async apply(args) {
        args = args || {}
        const hub      = String(args.hub  || "").toUpperCase()
        const dest     = String(args.dest || "").toUpperCase()
        const server   = String(args.server || "")
        const classKey = args.classKey
        const newPrice = Number(args.newPrice)

        const baseEnvelope = {hub, dest, classKey}

        if (CentralInventoryQuickPriceApplier.VALID_CLASS_KEYS.indexOf(classKey) < 0) {
            return Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {code: "invalidClassKey",
                        message: "classKey must be one of Y/C/F/Cargo, got " + classKey}
            })
        }
        if (!isFinite(newPrice) || newPrice < 0) {
            return Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {code: "invalidPrice",
                        message: "newPrice must be a non-negative number, got " + args.newPrice}
            })
        }
        if (!hub || !dest || !server) {
            return Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {code: "invalidArgs",
                        message: "hub, dest, server are required"}
            })
        }

        const dryRun = !!args.dryRun || this.dryRunOnly || !this.applyEnabled
        const url = CentralInventoryQuickPriceApplier._invUrl(server, hub, dest)

        let html = null
        let httpStatus = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            httpStatus = resp.status
            if (!resp.ok) {
                return Object.assign({}, baseEnvelope, {
                    status: "failed",
                    httpStatus,
                    error: {code: "fetchFailed",
                            message: "GET " + url + " returned HTTP " + resp.status,
                            httpStatus}
                })
            }
            html = await resp.text()
        } catch (e) {
            return Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {code: "fetchThrew",
                        message: "GET threw: " + (e && e.message || String(e))}
            })
        }
        if (CentralInventoryQuickPriceApplier.AUTHENTICATION_RE.test(html)) {
            return Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {code: "notLoggedIn",
                        message: "Inventory page returned a login form — sign into AS in this browser tab and retry."}
            })
        }

        const formContext = CentralInventoryQuickPriceApplier.parseFormContext(html)
        if (!formContext) {
            return Object.assign({}, baseEnvelope, {
                status: "failed",
                error: {code: "noFormContext",
                        message: "Couldn't locate the inventory settings form on " + url
                              + ". The route may not exist or AS markup may have changed."}
            })
        }

        const prev = formContext.currentPrices[classKey]
        const rounded = Math.round(newPrice)
        const envelope = Object.assign({}, baseEnvelope, {prev: prev != null ? prev : null, new: rounded})

        if (typeof args.onPreflight === "function") {
            try {
                const verdict = await args.onPreflight({prev, requested: rounded, hub, dest, classKey}, envelope)
                if (verdict === false || (verdict && verdict.abort)) {
                    return Object.assign({}, envelope, {
                        status: "aborted",
                        error: {code: "userAborted",
                                message: (verdict && verdict.reason) || "User aborted at preflight"}
                    })
                }
            } catch (e) {
                return Object.assign({}, envelope, {
                    status: "failed",
                    error: {code: "preflightThrew",
                            message: "Preflight callback threw: " + (e && e.message || String(e))}
                })
            }
        }

        const body = CentralInventoryQuickPriceApplier.buildBody({formContext, classKey, newPrice})

        if (dryRun) {
            return Object.assign({}, envelope, {status: "dry-run"})
        }

        const postUrl = url + "?" + formContext.formActionPath
        let respHtml = null
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
                return Object.assign({}, envelope, {
                    status: "failed",
                    httpStatus,
                    error: {code: "postFailed",
                            message: "POST " + postUrl + " returned HTTP " + resp.status,
                            httpStatus}
                })
            }
        } catch (e) {
            return Object.assign({}, envelope, {
                status: "failed",
                error: {code: "postThrew",
                        message: "POST threw: " + (e && e.message || String(e))}
            })
        }

        if (CentralInventoryQuickPriceApplier.PAGE_EXPIRED_RE.test(respHtml)) {
            return Object.assign({}, envelope, {
                status: "failed",
                error: {code: "pageExpired",
                        message: "Wicket session expired between GET and POST — retry."}
            })
        }

        if (!this.verifyAfter) {
            return Object.assign({}, envelope, {status: "posted", httpStatus})
        }

        let verified = null
        const respCtx = CentralInventoryQuickPriceApplier.parseFormContext(respHtml)
        if (respCtx && respCtx.currentPrices && respCtx.currentPrices[classKey] != null) {
            verified = respCtx.currentPrices[classKey]
        } else {
            verified = await this._verifyOne(server, hub, dest, classKey)
        }

        if (verified != null && Math.round(verified) === rounded) {
            return Object.assign({}, envelope, {status: "verified", verified, httpStatus})
        }
        return Object.assign({}, envelope, {status: "posted", verified, httpStatus})
    }

    async _verifyOne(server, hub, dest, classKey) {
        try {
            const url = CentralInventoryQuickPriceApplier._invUrl(server, hub, dest)
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            const html = await resp.text()
            const ctx = CentralInventoryQuickPriceApplier.parseFormContext(html)
            return ctx && ctx.currentPrices ? ctx.currentPrices[classKey] : null
        } catch (e) {
            return null
        }
    }

    /**
     * Slice 9 — batch apply mode. Sequentially apply a list of price
     * updates against the inventory form. Sequential (not parallel) so AS
     * doesn't see two concurrent submits for the same airline. Each entry
     * is the full `apply()` shape: `{hub, dest, classKey, newPrice, server,
     * dryRun?, onPreflight?}`.
     *
     * Options:
     *   interMs:      delay between submits (default 250ms — keeps AS
     *                 happy without slowing the user too much).
     *   stopOnError:  when true, abort the batch on first non-dry-run
     *                 failure. Defaults to false so a per-route hiccup
     *                 doesn't drop the whole batch.
     *   onProgress:   `(idx, total, lastResult) → void` per-entry hook.
     *
     * Returns `{results: [...], summary: {ok, failed, dryRun, aborted}}`.
     * `results[i].status` mirrors the per-entry `apply()` envelope; if
     * the batch aborted mid-way, trailing entries get `{status: "skipped",
     * reason: "aborted"}` so caller indices stay aligned with input.
     */
    async applyBatch(entries, opts) {
        opts = opts || {}
        const interMs = Math.max(0, Number(opts.interMs) || 250)
        const stopOnError = !!opts.stopOnError
        const onProgress = (typeof opts.onProgress === "function") ? opts.onProgress : null
        const list = Array.isArray(entries) ? entries : []
        const results = new Array(list.length)
        const summary = {ok: 0, failed: 0, dryRun: 0, aborted: false, total: list.length}
        let aborted = false

        for (let i = 0; i < list.length; i++) {
            if (aborted) {
                results[i] = {status: "skipped", reason: "aborted",
                              hub: list[i] && list[i].hub, dest: list[i] && list[i].dest,
                              classKey: list[i] && list[i].classKey}
                continue
            }
            let r
            try {
                r = await this.apply(list[i] || {})
            } catch (e) {
                r = {status: "failed", error: (e && e.message) || String(e),
                     hub: list[i] && list[i].hub, dest: list[i] && list[i].dest,
                     classKey: list[i] && list[i].classKey}
            }
            results[i] = r
            if (r.status === "verified" || r.status === "posted") summary.ok++
            else if (r.status === "dry-run") summary.dryRun++
            else if (r.status === "failed" || r.status === "aborted") summary.failed++

            if (onProgress) {
                try { onProgress(i, list.length, r) } catch (_) { /* hook optional */ }
            }
            if (stopOnError && (r.status === "failed" || r.status === "aborted")) {
                aborted = true
                summary.aborted = true
                continue
            }
            if (interMs > 0 && i < list.length - 1 && !aborted) {
                await new Promise(res => setTimeout(res, interMs))
            }
        }
        return {results: results, summary: summary}
    }
}

if (typeof window !== "undefined") {
    window.CentralInventoryQuickPriceApplier = CentralInventoryQuickPriceApplier
}
