/** Shared logic */
class AES {
    static isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value)
    }

    static cloneValue(value) {
        if (value === undefined) return undefined
        try { return JSON.parse(JSON.stringify(value)) }
        catch (_) {
            if (Array.isArray(value)) return value.slice()
            if (AES.isPlainObject(value)) return Object.assign({}, value)
            return value
        }
    }

    static applyDefaults(defaults, raw) {
        const source = AES.isPlainObject(raw) ? raw : {}
        const out = {}
        for (const key of Object.keys(defaults || {})) {
            const def = defaults[key]
            const val = source[key]
            if (AES.isPlainObject(def)) {
                out[key] = AES.applyDefaults(def, val)
            } else if (Array.isArray(def)) {
                out[key] = Array.isArray(val) ? AES.cloneValue(val) : AES.cloneValue(def)
            } else {
                out[key] = val === undefined ? AES.cloneValue(def) : val
            }
        }
        for (const key of Object.keys(source)) {
            if (!(key in out)) out[key] = AES.cloneValue(source[key])
        }
        return out
    }

    static defaultInvPricingSettings() {
        const steps = [
            { min:  0, max:  40, name: "Drop High",    step: -8 },
            { min: 40, max:  60, name: "Drop Medium",  step: -4 },
            { min: 60, max:  70, name: "Drop Low",     step: -2 },
            { min: 70, max:  80, name: "Keep",         step:  0 },
            { min: 80, max:  90, name: "Raise Low",    step:  1 },
            { min: 90, max:  99, name: "Raise Medium", step:  2 },
            { min: 99, max: 100, name: "Raise High",   step:  5 }
        ]
        const recommendation = {}
        for (const cmp of ["Y", "C", "F", "Cargo"]) {
            recommendation[cmp] = {
                maxPrice: 200,
                minPrice: 60,
                steps: AES.cloneValue(steps)
            }
        }
        return {
            autoAnalysisSave: 1,
            autoPriceUpdate: 0,
            autoClose: 0,
            showReferenceRecommendation: 0,
            recommendation,
            historyTable: {
                showNow: 1,
                showOnlyPricing: 0,
                numberOfDates: "5"
            }
        }
    }

    static defaultSettings() {
        return {
            invPricing: AES.defaultInvPricingSettings(),
            general: { defaultDashboard: "general" },
            schedule: { autoExtract: 0 },
            stationAutomation: {
                defaultPaxThreshold: 0,
                defaultCargoThreshold: 0,
                thresholds: [0, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
                countriesCache: {}
            },
            usedAircraftScanner: {
                presets: [],
                typeFamilyOverrides: {},
                concurrency: 6,
                staggerMs: 2000,
                lastScanId: null
            },
            flightInfo: { autoClose: 0 },
            personelManagement: {
                value: 0,
                type: "absolute",
                auto: 0,
                alreadyUpdated: []
            }
        }
    }

    static normalizeSettings(raw) {
        return AES.applyDefaults(AES.defaultSettings(), raw)
    }

    /**
     * Returns the airline name and code from the dashboard
     * @returns {object} {name: string, code: string}
     */
    static getAirlineCode() {
        const factsTable = document.querySelector(".facts table")
        const nameElement = factsTable?.querySelector("tr:nth-child(1) td:last-child")
        const codeElement = factsTable?.querySelector("tr:nth-child(2) td:last-child")
        const name = (nameElement?.innerText || "").trim()
        const code = (codeElement?.innerText || "").trim()

        if (!name && !code) {
            const identity = AES.getAirlineIdentity()
            return {
                name: identity,
                code: identity
            }
        }

        return {
            name: name || code,
            code: code || name
        }
    }

    /**
     * Returns a stable per-airline identifier that works on every /app/* page.
     * The top-nav airline name is present on all pages (dashboard, airport,
     * stations, etc), so we prefer it over .facts — which only exists on the
     * enterprise dashboard — to keep storage keys consistent across pages.
     * @returns {string}
     */
    static getAirlineIdentity() {
        const navName = document.querySelector(".as-navbar-main a.name span:not(.caret)")
        if (navName?.innerText) return navName.innerText.trim()
        for (const el of document.querySelectorAll("a.name")) {
            const text = (el.innerText || "").trim()
            if (text) return text
        }
        const factsCell = document.querySelector(".facts table tr:nth-child(2) td:last-child")
        if (factsCell?.innerText) return factsCell.innerText.trim()
        return ""
    }
    
    /**
     * Returns the server name
     * @returns {string} server name
     */
    static getServerName() {
        const hostname = window.location.hostname
        const servername = hostname.split(".")[0]

        return servername
    }

    static getServer() {
        return AES.getServerName()
    }

    /**
     * Returns the storage key for a competitor-monitoring record.
     *
     * Backports upstream v0.7.5's owner-scoped competitor monitoring
     * (CHANGELOG: "Fixed Competitor Monitoring so each controlled airline
     * has its own competitor list instead of sharing one server-wide list").
     *
     * When `ownerAirlineId` is provided, returns the new owner-scoped key:
     *   `<server><ownerAirlineId>_<competitorAirlineId>competitorMonitoring`
     * When `ownerAirlineId` is falsy, returns the legacy unscoped key:
     *   `<server><competitorAirlineId>competitorMonitoring`
     *
     * Callers that want to dual-read should call this helper twice — once
     * with the owner id, once with `null` — and prefer the owner-scoped
     * blob if it exists. See content_dashboard.js for the read-side dual
     * lookup. Legacy unscoped blobs are never deleted by AES code.
     *
     * @param {string} server
     * @param {string|null} ownerAirlineId
     * @param {string} competitorAirlineId
     * @returns {string}
     */
    static getCompetitorMonitoringKey(server, ownerAirlineId, competitorAirlineId) {
        if (ownerAirlineId) {
            return `${server}${ownerAirlineId}_${competitorAirlineId}competitorMonitoring`
        }

        return `${server}${competitorAirlineId}competitorMonitoring`
    }

    /**
     * Returns the storage key for the owner-scoped competitor-monitoring
     * index. The index is an array of competitor airlineIds the user is
     * currently tracking under THIS controlled airline. The dashboard reads
     * the index to enumerate competitor blobs without grep-by-suffix
     * scanning all of chrome.storage.local.
     *
     * @param {string} server
     * @param {string} ownerAirlineId
     * @returns {string}
     */
    static getCompetitorMonitoringIndexKey(server, ownerAirlineId) {
        return `${server}${ownerAirlineId}competitorMonitoringIndex`
    }

    /**
     * Formats a currency value local standards
     * @param {integer} currency value
     * @param {string} alignment: "right" | "left"
     * @returns {HTMLElement} span with formatted value
     */
    static formatCurrency(value, alignment) {
        let container = document.createElement("span")
        let formattedValue = Intl.NumberFormat().format(value)
        let indicatorEl = document.createElement("span")
        let valueEl = document.createElement("span")
        let currencyEl = document.createElement("span")
        let containerClasses = "aes-no-text-wrap"
        
        if (alignment === "right") {
            containerClasses = "aes-text-right aes-no-text-wrap"
        }
        
        if (value > 0) {
            valueEl.classList.add("good")
            indicatorEl.classList.add("good")
            indicatorEl.innerText = "+"
        }
        
        if (value < 0) {
            valueEl.classList.add("bad")
            indicatorEl.classList.add("bad")
            indicatorEl.innerText = "-"
            formattedValue = formattedValue.replace("-", "")
        }
        
        valueEl.innerText = formattedValue
        currencyEl.innerText = " AS$"
        
        container.className = containerClasses
        container.append(indicatorEl, valueEl, currencyEl)
        
        return container
    }
    
    /**
     * Formats a date string to human readable format
     * @param {string} "20240524"
     * @returns {string} "2024-05-24" | "error: invalid format for AES.formatDateString"
     */
    static formatDateString(date) {
        if (!date) {
            return
        }
        
        const correctLength = date.length === 8
        const isInteger = Number.isInteger(parseInt(date))
        let result = "error: invalid format for AES.formatDateString"
        
        if (correctLength && isInteger) {
            const year = date.substring(0, 4)
            const month = date.substring(4, 6)
            const day = date.substring(6, 8)
            result = `${year}-${month}-${day}`
        }
        
        return result
    }
    /**
     * Returns a formatted date (week) string
     * @param {string} "212024"
     * @returns {string} "21/2014 | "error: invalid format for AES.formatDateStringWeek"
     */
    static formatDateStringWeek(date) {
        const correctLength = date.toString().length === 6
        const isInteger = Number.isInteger(parseInt(date))
        let result = "error: invalid format for AES.formatDateStringWeek"
        
        if (correctLength && isInteger) {
            const DateAsString = date.toString()
            const week = DateAsString.substring(0, 2)
            const year = DateAsString.substring(2, 6)
            
            result = `${week}/${year}`
        }
        
        return result
    }
    
    /**
     * Takes a number and adds “(day|days) ago”
     * @param {integer} - 0 | 1 | 256
     @ returns {string} - "0 days ago" | "1 day ago" | "256 days ago"
     */
    static formatDaysAgo(daysAgo) {
        let dayOrDays = "days"
        if (daysAgo === 1) {
            dayOrDays = "day"
        }
        const result = `${daysAgo} ${dayOrDays} ago`

        return result
    }
    
    /**
     * Gets the server’s current date and time
     * @returns {object} datetime - { date: "20240607", time: "16:24 UTC" }
     */
    static getServerDate() {
        const fallback = (reason) => {
            if (typeof window !== "undefined" && window.AesInit && typeof window.AesInit.record === "function") {
                window.AesInit.record("helpers.getServerDate", reason)
            } else {
                try { console.warn("[AES helpers] getServerDate degraded:", reason) } catch (_) {}
            }
            const now = new Date()
            const pad = (n) => String(n).padStart(2, "0")
            return {
                date: String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()),
                time: pad(now.getUTCHours()) + ":" + pad(now.getUTCMinutes()) + " UTC"
            }
        }

        const clockEl = document.querySelector(".as-navbar-bottom span:has(.fa-clock-o)")
            || document.querySelector(".as-navbar-bottom .fa-clock-o")?.closest("span")
        if (!clockEl) return fallback("server clock element missing")

        const source = (clockEl.innerText || clockEl.textContent || "").trim()
        if (!source) return fallback("server clock text missing")
        const sourceAsNumbers = source.toString().replace(/\D/g, "")
        
        // The source always consists of 12 numbers
        const expectedLength = 12
        if (sourceAsNumbers.length != expectedLength) {
            return fallback(`Unexpected length for source (${sourceAsNumbers.length}). There might've been a UI update. Check AES.getServerDate()`)
        }
        
        // Splits the date component from the data,
        // then splits that into an array for the year, month, and day
        let dateArray = source.split(" ")[0].split(/\D+/)
        if (dateArray[0].length === 2) {
            dateArray.reverse()
        }
        let date = dateArray[0]+dateArray[1]+dateArray[2]
        
        // Strip the date component from the data
        // leaving only the time
        let time = source.replace(/.{10}\s/, "")
        
        const datetime = {
            date: date,
            time: time
        }
        
        return datetime
    }
    
    /**
     * Returns the difference between dates in days
     * @param {array|string} ["20240520", "20240524"] | ["20240520"] | "20240520"
     * @returns {integer} 4
     */
    static getDateDiff(dates) {
        // If a string is passed:
        // Create an array with the string as its first item
        if (typeof dates === "string") {
            dates = [dates]
        }
        // If `dates` has only one item:
        // Prepend the server date
        if (dates?.length === 1) {
            dates = [AES.getServerDate().date, dates[0]]
        }
        let dateA = new Date(`${this.formatDateString(dates[0])}T12:00:00Z`)
        let dateB = new Date(`${this.formatDateString(dates[1])}T12:00:00Z`)
        let result = Math.round((dateA - dateB)/(1000 * 60 * 60 * 24))
        
        return result
    }
    
    /**
     * Cleans a string of punctuation to returns an integer
     * @param {string} value - "-2,000 AS$" | "2.000 AS$" | "256"
     * @returns {integer} -2000 | 2000 | 256
     */
    static cleanInteger(value) {
        // TODO: create separate function for cleaning currency values
        // value = value.trim()
        // const isExpectedFormat = Boolean(value.match(/^-?(\d+[.,]?)+ AS\$$/))
        //
        // if (!isExpectedFormat) {
        //     throw new Error("cleanInteger(): unexpected format for value")
        // }

        // Match any character that’s no a digit or a dash
        const result = value.replaceAll(/[^\d-]/g, "")
        return parseInt(result, 10)
    }
}

if (typeof window !== "undefined") {
    window.AES = AES
}

/**
 * HTML-escape a string for safe insertion via innerHTML. Coerces null/undefined
 * to "" so callers can pass possibly-missing fields directly. Defined as a
 * top-level helper so any module loaded after helpers.js (which is in the /app
 * + /action content-script block — i.e. every page on airlinesim.aero) can use
 * it without redefining its own copy.
 */
function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

// ── L1 + L2.2 account-registry bootstrap ───────────────────────────────
//
// Once the manifest content-script chain has loaded (deferred via
// setTimeout 0 to clear the synchronous load phase), kick off the
// account-registry bootstrap. It reads (server, airline) from the
// page DOM, computes the canonical id, sets `window.__aesAccountId`,
// and fires a single `aes:account:touch` message so background.js
// upserts the registry. See modules/_shared/account-registry.js.
//
// After the touch resolves, run the L2.2 legacy-migration shim. It's
// a no-op once `migrationVersion >= 1`; on first run it copies the
// pre-L2 Class C/D legacy keys into the namespaced slot for the
// active account (or flags `migrationPending` for multi-account users
// — the L2.2.c modal handles those). Failures inside the shim are
// caught and logged; the legacy-fallback path in every refactored
// store keeps working until the next mount retries.
//
// Harmless when the registry module / migration shim / background
// handler / manifest entries aren't all wired yet — each layer guards
// for typeof undefined and silently bails.
;(function _aesL1ScheduleAccountBootstrap() {
    setTimeout(async function () {
        const boot = async function () {
            if (typeof AesAccountRegistry === "undefined") return
            await AesAccountRegistry.bootstrapFromPage()
            if (typeof AesMigrateLegacy !== "undefined") {
                await AesMigrateLegacy.runIfNeeded()
            }
        }
        if (typeof window !== "undefined" && window.AesInit && typeof window.AesInit.safe === "function") {
            await window.AesInit.safe("account.bootstrap", boot)
        } else {
            try { await boot() }
            catch (err) { console.warn("[AES account] bootstrap failed", err) }
        }
    }, 0)
})()
