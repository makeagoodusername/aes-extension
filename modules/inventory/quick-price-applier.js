"use strict"

/**
 * CentralInventoryQuickPriceApplier — one-shot single-class price update
 * against the AS inventory page's settings form.
 *
 * Mirrors `modules/route-assistant/pricing-applier.js`'s GET → parse →
 * build → POST → verify pipeline but is intentionally narrower:
 *   - drives one class price; carries the other three forward unchanged
 *   - applies to the airport pair and its flight numbers by default
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
    static DECIMAL_CLASS_KEYS = {Cargo: true}

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

    static _parseInteger(text) {
        const n = parseInt(String(text || "").replace(/[^\d-]/g, ""), 10)
        return isFinite(n) ? n : null
    }

    static _parsePrice(text, classKey) {
        if (!CentralInventoryQuickPriceApplier.DECIMAL_CLASS_KEYS[classKey]) {
            return CentralInventoryQuickPriceApplier._parseInteger(text)
        }
        const raw = String(text || "").trim().replace(/[^\d,.\-]/g, "")
        if (!raw || raw === "-") return null
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
        if (CentralInventoryQuickPriceApplier.DECIMAL_CLASS_KEYS[classKey]) {
            return Math.round(n * 100) / 100
        }
        return Math.round(n)
    }

    static _formatPriceForForm(classKey, value) {
        const n = CentralInventoryQuickPriceApplier._normalisePriceForClass(classKey, value)
        if (!isFinite(n)) return ""
        if (CentralInventoryQuickPriceApplier.DECIMAL_CLASS_KEYS[classKey]) {
            return n.toFixed(2).replace(/\.?0+$/, "")
        }
        return String(Math.round(n))
    }

    static _pricesEqual(classKey, a, b) {
        const left = CentralInventoryQuickPriceApplier._normalisePriceForClass(classKey, a)
        const right = CentralInventoryQuickPriceApplier._normalisePriceForClass(classKey, b)
        const tolerance = CentralInventoryQuickPriceApplier.DECIMAL_CLASS_KEYS[classKey] ? 0.005 : 0.5
        return isFinite(left) && isFinite(right) && Math.abs(left - right) < tolerance
    }

    static normalizeClassKey(label) {
        const raw = String(label || "").trim()
        if (!raw) return null
        const norm = raw.replace(/\s+/g, " ").toLowerCase()
        if (/^y$/i.test(raw) || /\b(economy|eco|tourist)\b/i.test(norm)) return "Y"
        if (/^c$/i.test(raw) || /\b(business|biz)\b/i.test(norm)) return "C"
        if (/^f$/i.test(raw) || /\b(first)\b/i.test(norm)) return "F"
        if (/^cargo$/i.test(raw) || /\b(cargo|freight|mail|fracht)\b/i.test(norm)) return "Cargo"
        return null
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
            const submit = f.querySelector("button[name='submit-prices']")
                || f.querySelector("input[name='submit-prices']")
            if (!submit) continue
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

        let pricingFieldset = null
        for (const fs of settingsForm.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (legend && /^pricing$/i.test((legend.textContent || "").trim())) {
                pricingFieldset = fs
                break
            }
        }
        if (pricingFieldset) {
            for (const tr of pricingFieldset.querySelectorAll("table tbody tr")) {
                const cells = tr.querySelectorAll("td")
                if (!cells || cells.length < 3) continue
                const cls = CentralInventoryQuickPriceApplier.normalizeClassKey(cells[0].textContent)
                if (!cls || observedFieldNames[cls]) continue
                const inp = cells[2].querySelector("input[type='text']")
                    || cells[2].querySelector("input")
                if (!inp) continue
                const name = inp.getAttribute("name")
                if (!name) continue
                const inputValue = CentralInventoryQuickPriceApplier._parsePrice(inp.getAttribute("value"), cls)
                const currentValue = CentralInventoryQuickPriceApplier._parsePrice(cells[1].textContent, cls)
                currentPrices[cls] = inputValue != null ? inputValue : currentValue
                observedFieldNames[cls] = name
                classOrder.push(cls)
            }
        }

        for (const spec of CentralInventoryQuickPriceApplier.CANONICAL_PRICE_FIELDS) {
            if (observedFieldNames[spec.cls]) continue
            const inp = settingsForm.querySelector("input[name='" + spec.name + "']")
            if (!inp) continue
            const n = CentralInventoryQuickPriceApplier._parsePrice(inp.getAttribute("value"), spec.cls)
            currentPrices[spec.cls] = n
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
     * value), every General Settings select unchanged, the requested scope
     * checkboxes, and the submit-prices button name.
     *
     * Wicket convention: unchecked checkboxes are absent from the body —
     * NOT sent as `off`.
     */
    static buildBody({formContext, classKey, newPrice, scope}) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()

        for (const k in formContext.hiddenFields) {
            body.set(k, formContext.hiddenFields[k])
        }

        const observed = formContext.observedFieldNames || {}
        const fallback = CentralInventoryQuickPriceApplier.FIELD_NAMES.prices
        const rounded = CentralInventoryQuickPriceApplier._normalisePriceForClass(classKey, newPrice)
        for (const cls of (formContext.classOrder || [])) {
            const fieldName = observed[cls] || fallback[cls]
            if (!fieldName) continue
            const value = (cls === classKey)
                ? rounded
                : formContext.currentPrices[cls]
            if (value == null || !isFinite(value)) continue
            body.set(fieldName, CentralInventoryQuickPriceApplier._formatPriceForForm(cls, value))
        }

        for (const fieldName in (formContext.generalSettings || {})) {
            body.set(fieldName, String(formContext.generalSettings[fieldName]))
        }

        const effectiveScope = Object.assign({
            airportPair:         true,
            flightNumbers:       true,
            returnAirportPair:   false,
            returnFlightNumbers: false
        }, scope || {})
        const scopeFields = CentralInventoryQuickPriceApplier.FIELD_NAMES.scope
        for (const k in scopeFields) {
            if (effectiveScope[k]) body.set(scopeFields[k], "on")
        }
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
        const rounded = CentralInventoryQuickPriceApplier._normalisePriceForClass(classKey, newPrice)
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

        const body = CentralInventoryQuickPriceApplier.buildBody({
            formContext,
            classKey,
            newPrice,
            scope: args.scope
        })

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

        if (verified != null && CentralInventoryQuickPriceApplier._pricesEqual(classKey, verified, rounded)) {
            await this._syncVerifiedOwnPricingCache({
                server,
                hub,
                dest,
                classKey,
                verified: rounded,
                formContext
            })
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

    async _syncVerifiedOwnPricingCache(args) {
        if (!args || !args.hub || !args.dest || !args.classKey) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return
        const pair = String(args.hub).toUpperCase() + "-" + String(args.dest).toUpperCase()
        const legacyKey = "routeAssistant:markets:ownPricing:" + pair
        let scopedKey = legacyKey
        if (typeof window !== "undefined" && window.AesAccountKey
                && typeof window.AesAccountKey.acctKey === "function") {
            scopedKey = window.AesAccountKey.acctKey("routeAssistant:markets:ownPricing", pair)
        } else if (typeof acctKey !== "undefined" && typeof acctKey === "function") {
            scopedKey = acctKey("routeAssistant:markets:ownPricing", pair)
        }

        const formPrices = Object.assign({}, (args.formContext && args.formContext.currentPrices) || {})
        formPrices[args.classKey] = CentralInventoryQuickPriceApplier._normalisePriceForClass(args.classKey, args.verified)
        const cleanPrices = {}
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const n = Number(formPrices[cls])
            if (isFinite(n)) cleanPrices[cls] = CentralInventoryQuickPriceApplier._normalisePriceForClass(cls, n)
        }
        if (!Object.keys(cleanPrices).length) return

        try {
            const reads = scopedKey === legacyKey ? [legacyKey] : [scopedKey, legacyKey]
            const cur = await chrome.storage.local.get(reads)
            const prev = cur[scopedKey] || cur[legacyKey] || {}
            const next = Object.assign({}, prev, {
                hub: String(args.hub).toUpperCase(),
                dest: String(args.dest).toUpperCase(),
                server: args.server || prev.server || null,
                scrapedAt: Date.now(),
                source: "inventoryQuickPrice:verified",
                prices: Object.assign({}, prev.prices || {}, cleanPrices)
            })
            if (args.formContext && args.formContext.generalSettings) {
                next.generalSettings = Object.assign(
                    {},
                    prev.generalSettings || {},
                    args.formContext.generalSettings
                )
            }
            const writes = {}
            writes[legacyKey] = next
            if (scopedKey !== legacyKey) writes[scopedKey] = next
            await chrome.storage.local.set(writes)
            if (typeof window !== "undefined" && window.AesDataBus
                    && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit("data:route-assistant:markets:updated", {
                    hub: next.hub,
                    dest: next.dest,
                    keysTouched: ["ownPricing"]
                })
            }
        } catch (e) {
            console.warn("[AES inventory quick price] verified price cache sync failed", e)
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
