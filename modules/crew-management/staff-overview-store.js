"use strict"

/**
 * Persistence for CrewMgmtStaffOverviewScraper records.
 *
 * Two storage shapes via window.AesAccountKey.acctKey():
 *   - :latest  — full snapshot (overwritten each save)
 *   - :history — ring of summary records (52 weeks; one game-year)
 *
 * The history ring stores per-group rollups, NOT per-role rows. A full
 * snapshot is ~25 KB at the airline sizes the saved fixture demonstrates;
 * 52 of those would burn ~1.3 MB of chrome.storage.local for trend lines
 * the panel doesn't need at role granularity. Per-role detail stays on the
 * :latest pointer where the panel fetches it for the current-week view.
 */
class CrewMgmtStaffOverviewStore {
    static MAX_HISTORY = 52

    static _key(suffix) {
        const ak = (typeof window !== "undefined") && window.AesAccountKey
        if (ak && typeof ak.acctKey === "function") {
            return ak.acctKey("crewMgmt", "staffOverview:" + suffix)
        }
        return "crewMgmt:staffOverview:" + suffix
    }

    /** Persists the full record at :latest and appends a summary to :history. */
    static async save(record) {
        if (!record || !record.scrapedAt) return
        const latestKey  = CrewMgmtStaffOverviewStore._key("latest")
        const historyKey = CrewMgmtStaffOverviewStore._key("history")

        const blob = await chrome.storage.local.get([historyKey])
        const ring = Array.isArray(blob[historyKey]) ? blob[historyKey].slice() : []

        const summary = CrewMgmtStaffOverviewStore._summarise(record)

        // Idempotent on weekId: replace head if the most-recent entry shares
        // the week so a re-visit during the same financial week doesn't
        // double-count the trend line.
        if (ring.length && ring[0].weekId === summary.weekId) {
            ring[0] = summary
        } else {
            ring.unshift(summary)
        }
        if (ring.length > CrewMgmtStaffOverviewStore.MAX_HISTORY) {
            ring.length = CrewMgmtStaffOverviewStore.MAX_HISTORY
        }

        await chrome.storage.local.set({
            [latestKey]:  record,
            [historyKey]: ring
        })
    }

    static async loadLatest() {
        const key = CrewMgmtStaffOverviewStore._key("latest")
        const blob = await chrome.storage.local.get([key])
        return blob[key] || null
    }

    static async loadHistory() {
        const key = CrewMgmtStaffOverviewStore._key("history")
        const blob = await chrome.storage.local.get([key])
        return Array.isArray(blob[key]) ? blob[key] : []
    }

    static async clear() {
        await chrome.storage.local.remove([
            CrewMgmtStaffOverviewStore._key("latest"),
            CrewMgmtStaffOverviewStore._key("history")
        ])
    }

    static _summarise(record) {
        const sectionsSummary = (record.sections || []).map(s => {
            let weeklyTotal = 0
            let nextWeekTotal = 0
            let headcount = 0
            let redundant = 0
            for (const r of s.roles || []) {
                weeklyTotal   += r.salaryTotal         || 0
                nextWeekTotal += r.nextWeekSalaryTotal || 0
                headcount     += r.employed            || 0
                redundant     += r.redundant           || 0
            }
            return {group: s.group, weeklyTotal, nextWeekTotal, headcount, redundant}
        })
        return {
            weekId:         record.weekId,
            scrapedAt:      record.scrapedAt,
            totals:         record.totals,
            sectionsSummary
        }
    }
}

if (typeof window !== "undefined") {
    window.CrewMgmtStaffOverviewStore = CrewMgmtStaffOverviewStore
}
