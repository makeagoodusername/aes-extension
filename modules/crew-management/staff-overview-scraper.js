"use strict"

/**
 * Scrapes /action/enterprise/staffOverview into a per-role salary record.
 * Page detection via <html data-aes-page="staff"> (set by site-skin/bootstrap.js
 * routing — see modules/site-skin/bootstrap.js:36). Returns null when the
 * marker is absent so the content script can no-op safely on stray injections.
 *
 * Output shape:
 *   {
 *     scrapedAt:   epoch-ms,
 *     weekId:      "YYYY-Www" derived from scrapedAt (page has no week strip),
 *     sections: [{
 *       group:    "Flight crew" | "Cabin crew" | "Ground crew",
 *       roles: [{
 *         label, positionId,
 *         employed, active, required,
 *         salaryPerEmployee, salaryTotal,
 *         nextWeekSalaryPerEmployee, nextWeekSalaryTotal,
 *         countryAverage, redundant,
 *         moodDigit, moodTrend, pendingChange
 *       }]
 *     }],
 *     totals: {employed, weeklyTotal, nextWeekTotal}
 *   }
 *
 * Salary forward commitment: `nextWeekSalaryPerEmployee` is the value the
 * user has staged in the per-row form input (post-submit but pre-tick), not
 * a system projection. The income-statement Salaries line lags by one tick,
 * so this field is the earliest signal that the user has already locked in
 * a pay change. `pendingChange` flips true when current ≠ next.
 */
class CrewMgmtStaffOverviewScraper {
    static STORAGE_KEY_LATEST  = "crewMgmt:staffOverview:latest"
    static STORAGE_KEY_HISTORY = "crewMgmt:staffOverview:history"

    /** Pure parser. Returns null when the page is not the staffOverview page. */
    static scrape(root = document) {
        const html = root.documentElement || (root.ownerDocument && root.ownerDocument.documentElement)
        if (!html || html.dataset.aesPage !== "staff") return null

        const table = CrewMgmtStaffOverviewScraper._findTable(root)
        if (!table) return null

        const sections = []
        for (const tbody of table.querySelectorAll(":scope > tbody")) {
            const headerRow = tbody.querySelector(":scope > tr > th[colspan]")
            if (!headerRow) continue
            const group = (headerRow.textContent || "").trim()
            if (!group) continue

            const roles = []
            for (const tr of tbody.querySelectorAll(":scope > tr")) {
                if (tr.querySelector(":scope > th")) continue
                const role = CrewMgmtStaffOverviewScraper._parseRoleRow(tr)
                if (role) roles.push(role)
            }
            if (roles.length) sections.push({group, roles})
        }

        const totals = CrewMgmtStaffOverviewScraper._readTotals(table, sections)
        const scrapedAt = Date.now()

        return {
            scrapedAt,
            weekId: CrewMgmtStaffOverviewScraper._weekIdFromTimestamp(scrapedAt),
            sections,
            totals
        }
    }

    static _findTable(root) {
        const candidates = root.querySelectorAll("table.aes-skin-sticky, table.table-bordered.table-striped")
        for (const t of candidates) {
            const headText = (t.tHead && t.tHead.textContent) || ""
            if (/Salary\s*\/\s*Employee/i.test(headText) && /Country average/i.test(headText)) return t
        }
        // Fallback: any data table containing the salary form action.
        const formTable = root.querySelector("form[action*='/action/enterprise/staffOverview'] input[name='action'][value='salary']")
        if (formTable) {
            const t = formTable.closest("table")
            if (t) return t
        }
        return null
    }

    static _parseRoleRow(tr) {
        const tds = tr.querySelectorAll(":scope > td")
        if (tds.length < 11) return null
        if (tds[0].hasAttribute("colspan")) return null

        const label = (tds[0].textContent || "").trim().replace(/\s+/g, " ")
        if (!label) return null

        const employed          = CrewMgmtStaffOverviewScraper._int(tds[1].textContent)
        const active            = CrewMgmtStaffOverviewScraper._int(tds[2].textContent)
        const required          = CrewMgmtStaffOverviewScraper._int(tds[3].textContent)
        const salaryPerEmployee = CrewMgmtStaffOverviewScraper._int(tds[4].textContent)
        const salaryTotal       = CrewMgmtStaffOverviewScraper._int(tds[5].textContent)

        const moodImg   = tds[6] && tds[6].querySelector("img")
        const moodDigit = CrewMgmtStaffOverviewScraper._moodDigit(moodImg)
        const moodTrend = CrewMgmtStaffOverviewScraper._moodTrend(tds[7])

        const positionInput = tds[8] && tds[8].querySelector("input[name='id']")
        const amountInput   = tds[8] && tds[8].querySelector("input[name='amount']")
        const positionId    = positionInput ? (positionInput.value || "") : ""
        const nextWeekSalaryPerEmployee = amountInput
            ? CrewMgmtStaffOverviewScraper._int(amountInput.value)
            : null

        const countryAverage    = CrewMgmtStaffOverviewScraper._int(tds[9].textContent)
        const nextWeekSalaryTotal = CrewMgmtStaffOverviewScraper._int(tds[10].textContent)

        const redundantText = tds[11] ? (tds[11].textContent || "").trim() : ""
        const redundant = (!redundantText || redundantText === "--")
            ? 0
            : CrewMgmtStaffOverviewScraper._int(redundantText)

        // pp vs country average — the unitless value crew-tuner / pay-perception
        // reason about. Undefined when countryAverage is missing or zero
        // (schema-drift safe: §4.8 graceful-null).
        const payTierPctVsCountry = (countryAverage > 0 && salaryPerEmployee != null)
            ? Math.round((salaryPerEmployee / countryAverage) * 100)
            : null
        const nextPayTierPctVsCountry = (countryAverage > 0 && nextWeekSalaryPerEmployee != null)
            ? Math.round((nextWeekSalaryPerEmployee / countryAverage) * 100)
            : null

        return {
            label,
            positionId,
            employed,
            active,
            required,
            salaryPerEmployee,
            salaryTotal,
            nextWeekSalaryPerEmployee,
            nextWeekSalaryTotal,
            countryAverage,
            payTierPctVsCountry,
            nextPayTierPctVsCountry,
            redundant,
            moodDigit,
            moodTrend,
            pendingChange: nextWeekSalaryPerEmployee != null
                && nextWeekSalaryPerEmployee !== salaryPerEmployee
        }
    }

    static _readTotals(table, sections) {
        // Authoritative tfoot row: see saved HTML lines 1350-1372. Format:
        // <tr><td>Total</td><td class="number">188</td><td colspan="3">&nbsp;</td>
        //     <td class="number">133,680 AS$</td>...</tr>
        let employed = null
        let weeklyTotal = null
        const footRows = table.querySelectorAll(":scope > tfoot > tr")
        for (const tr of footRows) {
            const numCells = tr.querySelectorAll("td.number")
            if (numCells.length >= 2) {
                employed    = CrewMgmtStaffOverviewScraper._int(numCells[0].textContent)
                weeklyTotal = CrewMgmtStaffOverviewScraper._int(numCells[1].textContent)
                break
            }
        }
        if (employed == null || weeklyTotal == null) {
            // Fallback: sum from sections.
            employed    = 0
            weeklyTotal = 0
            for (const s of sections) for (const r of s.roles) {
                employed    += r.employed    || 0
                weeklyTotal += r.salaryTotal || 0
            }
        }
        let nextWeekTotal = 0
        for (const s of sections) for (const r of s.roles) {
            nextWeekTotal += r.nextWeekSalaryTotal || 0
        }
        return {employed, weeklyTotal, nextWeekTotal}
    }

    static _moodDigit(img) {
        if (!img) return null
        const src = img.getAttribute("src") || ""
        const m = src.match(/(\d+)\.png(?:[?#]|$)/)
        return m ? parseInt(m[1], 10) : null
    }

    static _moodTrend(td) {
        if (!td) return 0
        if (td.querySelector("span.fa-chevron-circle-up"))   return 1
        if (td.querySelector("span.fa-chevron-circle-down")) return -1
        return 0
    }

    static _int(value) {
        if (value == null) return 0
        const text = String(value)
        if (typeof AES !== "undefined" && typeof AES.cleanInteger === "function") {
            const n = AES.cleanInteger(text)
            return Number.isFinite(n) ? n : 0
        }
        const cleaned = text.replace(/[^\d-]/g, "")
        const n = parseInt(cleaned, 10)
        return Number.isFinite(n) ? n : 0
    }

    static _weekIdFromTimestamp(ts) {
        // ISO week: YYYY-Www. Used as the dedup key in the history ring;
        // matches the income-statement weekId convention closely enough that
        // operating-leverage can compare staffOverview vs income on weekId.
        const d = new Date(ts)
        const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        const dayNum = utc.getUTCDay() || 7
        utc.setUTCDate(utc.getUTCDate() + 4 - dayNum)
        const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
        const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7)
        return utc.getUTCFullYear() + "-W" + String(week).padStart(2, "0")
    }
}

if (typeof window !== "undefined") {
    window.CrewMgmtStaffOverviewScraper = CrewMgmtStaffOverviewScraper
}
