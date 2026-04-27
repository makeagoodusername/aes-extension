"use strict"

/**
 * Alliance overview scraper — fetches `/app/alliance` and caches the
 * member roster for the Alliance hub tile.
 *
 * The AS alliance page renders the alliance name in an <h1> ("Your
 * alliance: ...") and the member roster in `table.members` with seven
 * columns: [logo | enterprise link | code | flag | country link | hq
 * link | remarks]. "Director" appears verbatim in the remarks cell for
 * board members; everything else goes into `remarks` as-is.
 *
 * Pending applications come from a separate fetch of
 * `/app/alliance?tabs=1` (the "Membership applications" tab), counting
 * tbody rows in whatever applications panel renders. If that fetch or
 * parse fails, `pendingApplications` is left at 0 — surfacing a stale
 * count is worse than a missing one.
 *
 * Cache (single record per profile, keyed without a server suffix
 * because dashboards are mounted per-airline-per-server already and
 * AS only ever has one alliance per airline):
 *   alliance:overview
 *     → {allianceName, members[], pendingApplications, scrapedAt,
 *        server, parserNotes?}
 */
class AllianceOverviewScraper {
    static CACHE_KEY = "alliance:overview"

    constructor(server) {
        if (!server) throw new Error("AllianceOverviewScraper: server required")
        this.server = server
    }

    static async loadRecord() {
        const out = await chrome.storage.local.get([AllianceOverviewScraper.CACHE_KEY])
        return out[AllianceOverviewScraper.CACHE_KEY] || null
    }

    static async saveRecord(record) {
        await chrome.storage.local.set({[AllianceOverviewScraper.CACHE_KEY]: record})
        return record
    }

    async scrape() {
        const overviewUrl = `https://${this.server}.airlinesim.aero/app/alliance`
        let html = null
        try {
            const resp = await fetch(overviewUrl, {credentials: "include"})
            if (resp.ok) html = await resp.text()
            else console.warn("[AES allianceScraper] overview fetch HTTP", resp.status)
        } catch (e) {
            console.warn("[AES allianceScraper] overview fetch failed:", e)
        }

        const parsed = AllianceOverviewScraper._parseOverviewHtml(html, this.server)
        const pendingApplications = await this._fetchPendingApplicationsCount()

        const record = {
            allianceName:        parsed.allianceName,
            members:             parsed.members,
            pendingApplications: pendingApplications,
            scrapedAt:           Date.now(),
            server:              this.server
        }
        if (parsed.parserNotes) record.parserNotes = parsed.parserNotes
        await AllianceOverviewScraper.saveRecord(record)
        return record
    }

    async _fetchPendingApplicationsCount() {
        const url = `https://${this.server}.airlinesim.aero/app/alliance?tabs=1`
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return 0
            const html = await resp.text()
            const doc = new DOMParser().parseFromString(html, "text/html")
            // The applications panel sits under the active .tab-pane on tabs=1.
            // Count rows in any tbody we can find on the page; if the panel is
            // absent or empty AS still renders the table shell, so we tolerate
            // the most permissive selector.
            const panel = doc.querySelector(".tab-pane.active table tbody")
                || doc.querySelector(".tab-content table tbody")
                || doc.querySelector("table tbody")
            if (!panel) return 0
            return panel.querySelectorAll("tr").length
        } catch (e) {
            console.warn("[AES allianceScraper] applications fetch failed:", e)
            return 0
        }
    }

    static _parseOverviewHtml(html, server) {
        const out = {allianceName: "", members: [], parserNotes: null}
        if (!html) { out.parserNotes = "fetch_failed"; return out }
        let doc
        try { doc = new DOMParser().parseFromString(html, "text/html") }
        catch (e) { out.parserNotes = "parse_failed"; return out }

        const h1 = doc.querySelector("h1")
        if (h1) {
            const txt = (h1.textContent || "").trim()
            // "Your alliance: United Alliance" → "United Alliance"
            const m = /^Your alliance:\s*(.+)$/i.exec(txt)
            out.allianceName = m ? m[1].trim() : txt
        }

        const table = doc.querySelector("table.members")
        if (!table) {
            out.parserNotes = (out.parserNotes ? out.parserNotes + "," : "") + "no_members_table"
            return out
        }

        const rows = table.querySelectorAll("tbody > tr")
        for (const row of rows) {
            const tds = row.querySelectorAll("td")
            if (tds.length < 7) continue

            const logoImg = tds[0].querySelector("img")
            const enterpriseLink = tds[1].querySelector("a")
            const code = (tds[2].textContent || "").trim()
            const countryLink = tds[4].querySelector("a")
            const hqLink = tds[5].querySelector("a")
            const remarksRaw = (tds[6].textContent || "").trim()

            const isDirector = remarksRaw === "Director"

            out.members.push({
                enterpriseName: enterpriseLink ? (enterpriseLink.textContent || "").trim() : "",
                code:           code,
                country:        countryLink ? (countryLink.textContent || "").trim() : "",
                hq:             hqLink ? (hqLink.textContent || "").trim() : "",
                role:           isDirector ? "Director" : null,
                remarks:        remarksRaw,
                enterpriseUrl:  enterpriseLink ? enterpriseLink.getAttribute("href") || "" : "",
                hqUrl:          hqLink ? hqLink.getAttribute("href") || "" : "",
                logoUrl:        AllianceOverviewScraper._absolutiseImg(logoImg, server)
            })
        }

        return out
    }

    static _absolutiseImg(img, server) {
        if (!img) return ""
        const src = img.getAttribute("src") || ""
        if (!src) return ""
        if (/^https?:\/\//i.test(src)) return src
        // AS serves logos from the application root; saved-page captures
        // emit relative `./XYZ_files/` paths that are useless in the
        // extension. Drop those rather than render broken images.
        if (/^\.\//.test(src)) return ""
        const base = `https://${server}.airlinesim.aero`
        return src.startsWith("/") ? base + src : base + "/" + src
    }
}

if (typeof window !== "undefined") {
    window.AllianceOverviewScraper = AllianceOverviewScraper
}
