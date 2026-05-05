"use strict"

/**
 * Scrapes /action/enterprise/staffPilots into chrome.storage.local under
 * the key "crewMgmt:pilots". Each record has the shape:
 *
 *   {
 *     server:    string,
 *     scrapedAt: epoch-ms,
 *     categories: [{
 *       skillId:             string,   // value attribute on the hire-form radio
 *       label:               string,   // e.g. "B737"
 *       group:               string,   // e.g. "Narrow-body pilots"
 *       employed:            number,
 *       active:              number,
 *       required:            number,
 *       reserve:             number,
 *       missing:             number,
 *       jobMarketAvailable:  number    // sourced from the hire-form row
 *     }]
 *   }
 *
 * Two entry points: instance scrape(server) does fetch + parse + save;
 * static parseDoc(doc) is a pure parser used by the content script which
 * already has document for the live page.
 */
class CrewMgmtStaffPilotsScraper {
    static STORAGE_KEY = "crewMgmt:pilots"

    async scrape(server) {
        if (!server) throw new Error("CrewMgmtStaffPilotsScraper: server required")
        const url = "https://" + server + ".airlinesim.aero/action/enterprise/staffPilots"
        let resp
        try {
            resp = await fetch(url, {credentials: "include"})
        } catch (e) {
            const err = new Error("fetch failed: " + e.message)
            err.code = "fetchFailed"
            throw err
        }
        if (!resp.ok) {
            const err = new Error("HTTP " + resp.status)
            err.code = "httpError"
            err.httpStatus = resp.status
            throw err
        }
        const html = await resp.text()
        const doc = new DOMParser().parseFromString(html, "text/html")
        const parsed = CrewMgmtStaffPilotsScraper.parseDoc(doc)
        const record = Object.assign({server: server}, parsed)
        await chrome.storage.local.set({[CrewMgmtStaffPilotsScraper.STORAGE_KEY]: record})
        return record
    }

    static parseDoc(doc) {
        if (doc.querySelector("form[action*='/login']")) {
            const err = new Error("login redirect")
            err.code = "notLoggedIn"
            throw err
        }

        const labelToHire = new Map()
        for (const radio of doc.querySelectorAll("input[type='radio'][name='skillId']")) {
            const tr = radio.closest("tr")
            if (!tr) continue
            const tds = tr.querySelectorAll("td")
            if (tds.length < 3) continue
            const label = (tds[1].textContent || "").trim()
            const market = parseNumber(tds[2].textContent)
            if (label) labelToHire.set(label, {skillId: radio.getAttribute("value") || "", jobMarketAvailable: market})
        }

        const overviewTable = findOverviewTable(doc)
        const categories = []
        if (overviewTable) {
            for (const tbody of overviewTable.querySelectorAll("tbody")) {
                const headerRow = tbody.querySelector(":scope > tr > th[colspan]")
                const group = headerRow ? (headerRow.textContent || "").trim() : ""
                for (const tr of tbody.querySelectorAll(":scope > tr")) {
                    if (tr.querySelector("th")) continue
                    const tds = tr.querySelectorAll(":scope > td")
                    if (tds.length < 5) continue
                    if (tds[0].hasAttribute("colspan")) continue
                    const labelRaw = (tds[0].textContent || "").trim()
                    const label = labelRaw.replace(/\s*\(.*\)\s*$/, "").trim()
                    if (!label) continue
                    const reserveSpan = tds[4].querySelector("span.good")
                    const missingSpan = tds[4].querySelector("span.bad")
                    const hire = labelToHire.get(label) || {skillId: "", jobMarketAvailable: 0}
                    categories.push({
                        skillId:            hire.skillId,
                        label:              label,
                        group:              group,
                        employed:           parseNumber(tds[1].textContent),
                        active:             parseNumber(tds[2].textContent),
                        required:           parseNumber(tds[3].textContent),
                        reserve:            reserveSpan ? parseNumber(reserveSpan.textContent) : 0,
                        missing:            missingSpan ? parseNumber(missingSpan.textContent) : 0,
                        jobMarketAvailable: hire.jobMarketAvailable
                    })
                }
            }
        }

        return {categories: categories, scrapedAt: Date.now()}
    }
}

function parseNumber(s) {
    const n = parseInt(String(s || "").replace(/[^0-9-]/g, ""), 10)
    return Number.isFinite(n) ? n : 0
}

function findOverviewTable(doc) {
    const headings = doc.querySelectorAll("h3")
    for (const h of headings) {
        const text = (h.textContent || "").toLowerCase()
        if (text.indexOf("pilot overview") !== -1) {
            let el = h.nextElementSibling
            while (el) {
                const t = el.querySelector && el.querySelector("table")
                if (t) return t
                el = el.nextElementSibling
            }
            const parent = h.closest(".col-md-7") || h.parentElement
            if (parent) {
                const t = parent.querySelector("table")
                if (t) return t
            }
        }
    }
    return doc.querySelector(".col-md-7 table")
}

if (typeof window !== "undefined") {
    window.CrewMgmtStaffPilotsScraper = CrewMgmtStaffPilotsScraper
}
