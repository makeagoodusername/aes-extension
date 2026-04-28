"use strict"

/**
 * Service-profile applier — POST write-back to the AS serviceChange form.
 *
 * Mirrors the pricing-applier handshake: GET the detail page → harvest
 * hidden fields + per-radio-group state via parseFormContext → build a
 * URL-encoded body that round-trips every radio group at its current value
 * except the ones the caller wants to change → POST → re-parse the
 * response to verify the new radio states stuck.
 *
 * Public API:
 *   const applier = new RouteAssistantServiceProfileApplier(server, {applyLog, applyEnabled})
 *   const snapshot = await applier.fetchFormSnapshot(profileId)
 *   const result   = await applier.apply(profileId, {drinks: {Y: 3}, snacks: {C: 4}}, {source})
 *
 * Static helpers (pure):
 *   parseFormContext(html)       → {actionUrl, hidden, radiosByName, prefixToCategory, submit}
 *   buildBody(formContext, ch)   → URLSearchParams
 *   fingerprint(profileId, ch)   → string
 *   normaliseChanges(ctx, ch)    → trimmed-changes object (drops no-op entries)
 *
 * Result envelope:
 *   {status: "posted"|"failed"|"noop", profileId, ts, source, fingerprint,
 *    requestedChanges, prevValues, newValues, verifiedValues?, verified,
 *    error?: {code, message, httpStatus?}, warning?, bodyPreview?, logId?}
 */
class RouteAssistantServiceProfileApplier {
    static CLASS_LETTER_TO_KEY = {y: "Y", c: "C", f: "F"}
    static FORM_ACTION_RE   = /serviceChange/i
    static PAGE_EXPIRED_RE  = /PageExpiredException|Wicket\.PageExpiredException/i
    static AUTHENTICATION_RE = /<form[^>]+action=["'][^"']*\/login/i

    /**
     * @param {string} server  — `free1`, `tristar`, etc.
     * @param {object} [opts]
     * @param {RouteAssistantServiceProfileApplyLog} [opts.applyLog]
     * @param {boolean} [opts.applyEnabled=true]   — set false → return noop without POST
     * @param {boolean} [opts.dryRunOnly=false]    — true → log status:"dry-run" and skip POST
     *                                                (mirrors pricing-applier.js Tier 3.1)
     */
    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantServiceProfileApplier: server required")
        opts = opts || {}
        this.server = server
        this.applyLog = opts.applyLog || null
        this.applyEnabled = opts.applyEnabled !== false
        this.dryRunOnly   = !!opts.dryRunOnly
    }

    static _baseUrl(server) {
        return "https://" + server + ".airlinesim.aero"
    }

    static _detailUrl(server, profileId) {
        return RouteAssistantServiceProfileApplier._baseUrl(server)
            + "/action/enterprise/serviceProfile?id=" + Number(profileId)
    }

    // ------------------------------------------------------------------
    // Pure parsing / building helpers
    // ------------------------------------------------------------------

    /**
     * Walk the detail page, find the serviceChange form, and harvest
     * everything needed to rebuild it as a POST body.
     *
     * Returns null when the form is missing (page format changed, login
     * wall, etc.). Caller surfaces a "noFormContext" failure.
     */
    static parseFormContext(html) {
        if (!html) return null
        const doc = new DOMParser().parseFromString(html, "text/html")

        let form = null
        for (const f of doc.querySelectorAll("form")) {
            const action = f.getAttribute("action") || ""
            if (RouteAssistantServiceProfileApplier.FORM_ACTION_RE.test(action)) {
                form = f
                break
            }
        }
        if (!form) return null

        const actionUrl = form.getAttribute("action") || ""

        const hidden = {}
        for (const inp of form.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) hidden[name] = inp.getAttribute("value") || ""
        }

        // Build prefix → category in document order: each <h4> precedes its
        // category's radios, so the first-seen radio after a heading claims
        // that heading's slug. Mirrors service-profile-scraper.parseDetailFromDoc.
        const prefixToCategory = {}
        let currentCategory = null
        for (const node of form.querySelectorAll("h4, input[type='radio']")) {
            if (node.tagName && node.tagName.toLowerCase() === "h4") {
                currentCategory = RouteAssistantServiceProfileApplier._slugifyCategory(
                    (node.textContent || "").trim()
                )
                continue
            }
            const name = node.getAttribute("name") || ""
            if (name.length < 3) continue
            const prefix = name.slice(0, 2).toLowerCase()
            if (currentCategory && !prefixToCategory[prefix]) {
                prefixToCategory[prefix] = currentCategory
            }
        }

        // Group every radio by name → {checked: <stringValue>|null, values: [...]}
        const radiosByName = {}
        for (const radio of form.querySelectorAll("input[type='radio']")) {
            const name = radio.getAttribute("name") || ""
            if (!name) continue
            if (!radiosByName[name]) radiosByName[name] = {checked: null, values: []}
            const value = radio.getAttribute("value") || ""
            radiosByName[name].values.push(value)
            if (radio.hasAttribute("checked") && radiosByName[name].checked == null) {
                radiosByName[name].checked = value
            }
        }

        // Submit button — Wicket disambiguates handlers by which submit
        // name is in the body. Capture the first <button> or <input
        // type=submit> with a name attribute.
        let submit = null
        const submitEl = form.querySelector("button[type='submit'][name], input[type='submit'][name], button[name][type=submit], button[name]:not([type='button'])")
        if (submitEl) {
            submit = {
                name:  submitEl.getAttribute("name"),
                value: submitEl.getAttribute("value") || "1"
            }
        }

        return {actionUrl, hidden, radiosByName, prefixToCategory, submit}
    }

    /**
     * Drop entries from `changes` whose requested level matches the
     * currently-checked value. After normalisation an empty result means
     * the apply is a noop.
     *
     * `changes` shape: {<categoryKey>: {Y?: <level>, C?: <level>, F?: <level>}}
     */
    static normaliseChanges(formContext, changes) {
        const out = {}
        if (!formContext || !changes) return out
        const reverse = RouteAssistantServiceProfileApplier._reverseCategoryMap(formContext.prefixToCategory)
        for (const cat in changes) {
            const reqClasses = changes[cat] || {}
            for (const cls in reqClasses) {
                const reqVal = reqClasses[cls]
                if (reqVal == null) continue
                const radioName = RouteAssistantServiceProfileApplier._radioNameFor(reverse, cat, cls)
                if (!radioName) continue
                const group = formContext.radiosByName[radioName]
                if (!group) continue
                const reqStr = String(reqVal)
                if (group.values.indexOf(reqStr) < 0) continue   // value not offered
                if (group.checked === reqStr) continue           // no change
                if (!out[cat]) out[cat] = {}
                out[cat][cls] = reqVal
            }
        }
        return out
    }

    /**
     * URL-encoded body. Re-sends every hidden field + one field per radio
     * group: changed groups send the new value; unchanged groups send the
     * currently-checked value (round-trip preservation, Wicket convention).
     * Adds the form's submit button name → value (required so AS routes the
     * POST to the save handler).
     */
    static buildBody(formContext, changes) {
        if (!formContext) throw new Error("buildBody: formContext required")
        const body = new URLSearchParams()

        for (const k in formContext.hidden) {
            body.set(k, formContext.hidden[k])
        }

        const reverse = RouteAssistantServiceProfileApplier._reverseCategoryMap(formContext.prefixToCategory)
        const cleaned = changes || {}
        for (const name in formContext.radiosByName) {
            const group = formContext.radiosByName[name]
            if (name.length < 3) {
                if (group.checked != null) body.set(name, group.checked)
                continue
            }
            const prefix = name.slice(0, 2).toLowerCase()
            const clsLetter = name.slice(2, 3).toLowerCase()
            const category = formContext.prefixToCategory[prefix]
            const clsKey = RouteAssistantServiceProfileApplier.CLASS_LETTER_TO_KEY[clsLetter]
            const requested = category && clsKey
                && cleaned[category] && cleaned[category][clsKey] != null
                ? String(cleaned[category][clsKey])
                : null
            if (requested != null && group.values.indexOf(requested) >= 0) {
                body.set(name, requested)
            } else if (group.checked != null) {
                body.set(name, group.checked)
            } else {
                body.set(name, "")
            }
        }

        if (formContext.submit && formContext.submit.name) {
            body.set(formContext.submit.name, formContext.submit.value || "1")
        }

        return body
    }

    /**
     * Deterministic key for (profile, changes). Sorted so two equal
     * change-sets always produce the same string. Drives apply-log dedup.
     */
    static fingerprint(profileId, changes) {
        const parts = []
        parts.push("profile=" + Number(profileId))
        const cats = Object.keys(changes || {}).sort()
        for (const cat of cats) {
            const cls = changes[cat] || {}
            const clsKeys = Object.keys(cls).sort()
            for (const k of clsKeys) {
                if (cls[k] == null) continue
                parts.push(cat + "-" + k + "=" + cls[k])
            }
        }
        return parts.join("|")
    }

    // ------------------------------------------------------------------
    // Network handshake
    // ------------------------------------------------------------------

    /**
     * GET the detail page and parse it. Returns {formContext, html} or
     * null on HTTP error / parse miss. Used by the tile editor to render
     * radio groups with their full value ranges before the user saves.
     */
    async fetchFormSnapshot(profileId) {
        const url = RouteAssistantServiceProfileApplier._detailUrl(this.server, profileId)
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            const html = await resp.text()
            const formContext = RouteAssistantServiceProfileApplier.parseFormContext(html)
            if (!formContext) return null
            return {formContext, html}
        } catch (e) {
            console.warn("[AES serviceProfileApplier] snapshot fetch failed", e)
            return null
        }
    }

    /**
     * Apply `changes` (partial map) to the named profile.
     *
     * @returns {Promise<object>} envelope
     */
    async apply(profileId, changes, opts) {
        opts = opts || {}
        const startedAt = Date.now()
        const numId = Number(profileId)
        const fingerprint = RouteAssistantServiceProfileApplier.fingerprint(numId, changes)

        const baseEnvelope = {
            ts:               startedAt,
            profileId:        numId,
            source:           opts.source || "tile",
            fingerprint,
            requestedChanges: changes ? JSON.parse(JSON.stringify(changes)) : null
        }

        // Step 1 — GET fresh form context.
        const url = RouteAssistantServiceProfileApplier._detailUrl(this.server, numId)
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
        if (RouteAssistantServiceProfileApplier.AUTHENTICATION_RE.test(html)) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "notLoggedIn",
                message: "Service profile page returned a login form — sign into AS in this tab and retry."
            })
        }
        const formContext = RouteAssistantServiceProfileApplier.parseFormContext(html)
        if (!formContext) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "noFormContext",
                message: "Couldn't locate the serviceChange form for profile " + numId + "."
            })
        }

        // Step 2 — normalise. Empty after strip = noop.
        baseEnvelope.prevValues = RouteAssistantServiceProfileApplier._extractValues(formContext)
        const cleanChanges = RouteAssistantServiceProfileApplier.normaliseChanges(formContext, changes)
        if (!Object.keys(cleanChanges).length) {
            return await this._completeAsNoop(baseEnvelope)
        }

        // Step 3 — build body + project newValues.
        const body = RouteAssistantServiceProfileApplier.buildBody(formContext, cleanChanges)
        baseEnvelope.bodyPreview = RouteAssistantServiceProfileApplier._summariseBody(body)
        baseEnvelope.newValues = RouteAssistantServiceProfileApplier._projectValues(formContext, cleanChanges)

        // Tier 3.1 — explicit dry-run gate. Logs an audit entry with
        // status:"dry-run" so the user/strategy can preview what would
        // have been written without actually firing the POST.
        if (this.dryRunOnly) {
            return await this._completeAsDryRun(Object.assign({}, baseEnvelope, {
                warning: "dryRunOnly=true — POST suppressed (audit logged as dry-run)"
            }))
        }

        if (!this.applyEnabled) {
            return await this._completeAsNoop(Object.assign({}, baseEnvelope, {
                warning: "applyEnabled=false — POST suppressed (dry-run)"
            }))
        }

        // Step 4 — POST. Resolve actionUrl against the GET URL (Wicket
        // forms ship absolute or root-relative actions; URL() handles both).
        let postUrl
        try {
            postUrl = new URL(formContext.actionUrl, url).toString()
        } catch (e) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "badActionUrl",
                message: "Form action URL '" + formContext.actionUrl + "' could not be resolved."
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
        if (RouteAssistantServiceProfileApplier.PAGE_EXPIRED_RE.test(respHtml)) {
            return await this._completeAsFailure(baseEnvelope, {
                code: "pageExpired",
                message: "Wicket session expired between GET and POST — retry."
            })
        }

        // Step 5 — verify. Parse the response (which is the form
        // re-rendered with the new state). When the response doesn't
        // expose the form (e.g. AS redirected to a flash page), re-fetch.
        let verifiedValues = null
        let verifyContext = RouteAssistantServiceProfileApplier.parseFormContext(respHtml)
        if (!verifyContext) {
            const reFetch = await this.fetchFormSnapshot(numId)
            if (reFetch) verifyContext = reFetch.formContext
        }
        if (verifyContext) {
            verifiedValues = RouteAssistantServiceProfileApplier._extractValues(verifyContext)
        }
        const verified = RouteAssistantServiceProfileApplier._verifyMatches(
            baseEnvelope.newValues, verifiedValues
        )

        baseEnvelope.verifiedValues = verifiedValues
        baseEnvelope.verified = verified
        baseEnvelope.httpStatus = httpStatus
        if (!verified) {
            baseEnvelope.warning = "POST returned 200 but post-write verification didn't match expected values."
        }
        return await this._completeAsPosted(baseEnvelope)
    }

    // ------------------------------------------------------------------
    // Result writers
    // ------------------------------------------------------------------

    async _completeAsPosted(envelope) {
        const written = await this._writeLog(Object.assign({}, envelope, {status: "posted"}))
        this._schedulePostApplyOrsArchive(written)
        return written
    }

    /**
     * Velvet Cascade · PR 1B — fan out a post-apply ORS rescrape across
     * every route that mounts this profile. Service changes are batch
     * effects, so the calibration dataset needs an after-snapshot per
     * affected route. v1 reads the user's schedule to discover hub-dest
     * pairs and best-effort archives each. Errors swallow into a console
     * warn — the user's apply has already succeeded.
     */
    _schedulePostApplyOrsArchive(record) {
        if (!record || record.status !== "posted") return
        if (record.profileId == null) return
        const settings = this.settings || (typeof window !== "undefined"
            ? (window.RouteAssistantSettings && window.RouteAssistantSettings._cached) : null)
        const orsCfg = settings && settings.ors
        if (orsCfg && orsCfg.snapshotOnApply === false) return
        const delayMs = (orsCfg && Number(orsCfg.postApplyRescrapeDelayMs)) || 5000

        setTimeout(async () => {
            try {
                const scraper = (typeof window !== "undefined") && window.RouteAssistantOrsScraper
                const store   = (typeof window !== "undefined") && window.RouteAssistantOrsSnapshotStore
                if (!scraper || !store) return
                const pairs = await this._collectAffectedPairs(record.profileId)
                if (!pairs.length) return
                for (const [hub, dest] of pairs.slice(0, 12)) {
                    try {
                        let rec = null
                        if (typeof scraper.scrape === "function") {
                            try { rec = await scraper.scrape(hub, dest, {refresh: true}) }
                            catch (_) { rec = null }
                        }
                        if (!rec && typeof scraper.loadRecord === "function") {
                            rec = await scraper.loadRecord(hub, dest)
                        }
                        if (!rec) continue
                        await store.archive(hub, dest, rec, {
                            reason: "post-apply",
                            label:  "after profile #" + record.profileId + " apply " + (record.id || "")
                        })
                    } catch (e) {
                        console.warn("[AES serviceProfileApplier] per-route archive failed", hub, dest, e)
                    }
                }
            } catch (e) {
                console.warn("[AES serviceProfileApplier] post-apply ORS archive failed", e)
            }
        }, Math.max(0, delayMs))
    }

    /**
     * Discover (hub, dest) pairs that mount this profile. v1 walks the
     * user's schedule cache (the shape that ors-scraper uses to derive
     * `getOurFlightNumbers`) and surfaces every (origin, destination) it
     * sees. v2 will join against a per-aircraft profile assignment when
     * such a mapping is plumbed into the snapshot.
     */
    async _collectAffectedPairs(profileId) {
        const out = []
        const seen = new Set()
        try {
            if (typeof window === "undefined") return out
            // Walk every "<server><airline>schedule" key — there's only one
            // per active install but the prefix scan keeps us tolerant of
            // multi-airline canopy data without coupling to AccountRegistry.
            const all = await chrome.storage.local.get(null)
            for (const k in all) {
                if (!k.endsWith("schedule")) continue
                const rec = all[k]
                if (!rec || !rec.date) continue
                for (const day in rec.date) {
                    const sched = rec.date[day] && rec.date[day].schedule
                    if (!Array.isArray(sched)) continue
                    for (const route of sched) {
                        if (!route || !route.origin || !route.destination) continue
                        const pairKey = String(route.origin).toUpperCase() + "-"
                                      + String(route.destination).toUpperCase()
                        if (seen.has(pairKey)) continue
                        seen.add(pairKey)
                        out.push([route.origin, route.destination])
                    }
                }
            }
        } catch (_) {}
        return out
    }

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
                console.warn("[AES serviceProfileApplier] apply-log write failed", e)
            }
        }
        return record
    }

    // ------------------------------------------------------------------
    // Static helpers
    // ------------------------------------------------------------------

    static _slugifyCategory(text) {
        if (!text) return null
        const words = String(text).trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
        if (!words.length) return null
        return words.map((w, i) => {
            const lower = w.toLowerCase()
            return i === 0 ? lower : (lower.charAt(0).toUpperCase() + lower.slice(1))
        }).join("")
    }

    static _reverseCategoryMap(prefixToCategory) {
        const out = {}
        if (!prefixToCategory) return out
        for (const p in prefixToCategory) out[prefixToCategory[p]] = p
        return out
    }

    static _radioNameFor(reverseMap, category, classKey) {
        const prefix = reverseMap[category]
        if (!prefix) return null
        const clsLetter = String(classKey || "").toLowerCase()
        if (!clsLetter) return null
        return prefix + clsLetter
    }

    /**
     * Reduce a formContext to {category: {Y, C, F}} of currently-checked
     * radio values. Same shape the tile reads/writes.
     */
    static _extractValues(formContext) {
        const out = {}
        if (!formContext) return out
        for (const name in formContext.radiosByName) {
            if (name.length < 3) continue
            const group = formContext.radiosByName[name]
            const prefix = name.slice(0, 2).toLowerCase()
            const clsLetter = name.slice(2, 3).toLowerCase()
            const category = formContext.prefixToCategory[prefix]
            const clsKey = RouteAssistantServiceProfileApplier.CLASS_LETTER_TO_KEY[clsLetter]
            if (!category || !clsKey) continue
            if (!out[category]) out[category] = {}
            out[category][clsKey] = group.checked != null
                ? RouteAssistantServiceProfileApplier._toIntOr(group.checked)
                : null
        }
        return out
    }

    /**
     * Project the post-apply state by overlaying `cleanChanges` onto the
     * pre-apply extracted values. Used to compute newValues without
     * actually POSTing.
     */
    static _projectValues(formContext, cleanChanges) {
        const out = RouteAssistantServiceProfileApplier._extractValues(formContext)
        for (const cat in cleanChanges || {}) {
            const cls = cleanChanges[cat] || {}
            for (const k in cls) {
                if (cls[k] == null) continue
                if (!out[cat]) out[cat] = {}
                out[cat][k] = RouteAssistantServiceProfileApplier._toIntOr(cls[k])
            }
        }
        return out
    }

    static _verifyMatches(expected, actual) {
        if (!expected || !actual) return false
        for (const cat in expected) {
            const e = expected[cat]
            const a = actual[cat]
            if (!e || !a) return false
            for (const k in e) {
                if (e[k] == null) continue
                if (a[k] == null) return false
                if (Number(e[k]) !== Number(a[k])) return false
            }
        }
        return true
    }

    static _toIntOr(v) {
        const n = parseInt(String(v), 10)
        return isFinite(n) ? n : null
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
    window.RouteAssistantServiceProfileApplier = RouteAssistantServiceProfileApplier
}
