"use strict"

;(function () {
    function run() {
        try {
            const Scraper = window.CrewMgmtStaffOverviewScraper
            const Store   = window.CrewMgmtStaffOverviewStore
            if (!Scraper || !Store) return

            const record = Scraper.scrape(document)
            if (!record) return

            Store.save(record).then(() => {
                if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                    window.AesDataBus.emit("data:crewMgmt:staffOverview:saved", {
                        weekId:        record.weekId,
                        weeklyTotal:   record.totals && record.totals.weeklyTotal,
                        nextWeekTotal: record.totals && record.totals.nextWeekTotal
                    })
                }
            }).catch(err => console.warn("[AES staffOverview] save failed", err))
        } catch (err) {
            console.warn("[AES staffOverview] capture failed", err)
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, {once: true})
    } else {
        run()
    }
})()
