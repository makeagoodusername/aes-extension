"use strict"

;(function () {
    function run() {
        try {
            const Scraper = window.CrewMgmtStaffOverviewScraper
            const Store   = window.CrewMgmtStaffOverviewStore
            if (!Scraper || !Store) return

            const record = Scraper.scrape(document)
            if (!record) return

            // Slice 8 — harvest the salary-form skeleton so the pay-tier
            // applier can dispatch a POST without an extra GET when the
            // user is already on this page. Optional: applier always falls
            // back to its own fetch when formContext is missing or stale.
            try {
                const PayTier = window.CrewMgmtPayTierScraper
                if (PayTier && typeof PayTier.captureFormContext === "function") {
                    const formContext = PayTier.captureFormContext(document)
                    if (formContext) record.formContext = formContext
                }
            } catch (_) { /* never block the main save on form-context errors */ }

            Store.save(record).then(() => {
                if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                    window.AesDataBus.emit("data:crewMgmt:staffOverview:saved", {
                        weekId:        record.weekId,
                        weeklyTotal:   record.totals && record.totals.weeklyTotal,
                        nextWeekTotal: record.totals && record.totals.nextWeekTotal
                    })
                    const pressure = _derivePressure(record)
                    if (pressure && pressure.severity > 0) {
                        window.AesDataBus.emit("signal:strategy:crew-pressure", {
                            severity:        pressure.severity,
                            shortPositions:  pressure.shortPositions,
                            worstShortfallPct: pressure.worstShortfallPct
                        })
                    }
                }
            }).catch(err => console.warn("[AES staffOverview] save failed", err))
        } catch (err) {
            console.warn("[AES staffOverview] capture failed", err)
        }
    }

    function _derivePressure(record) {
        if (!record || !Array.isArray(record.sections)) return null
        let worst = 0
        const shortPositions = []
        for (const sec of record.sections) {
            if (!sec || !Array.isArray(sec.roles)) continue
            for (const role of sec.roles) {
                const required = Number(role && role.required)
                const employed = Number(role && role.employed)
                if (!Number.isFinite(required) || required <= 0) continue
                if (!Number.isFinite(employed)) continue
                if (employed >= required) continue
                const shortfallPct = (required - employed) / required
                if (shortfallPct > worst) worst = shortfallPct
                shortPositions.push(role.positionId || role.label)
            }
        }
        if (worst <= 0) return null
        // Severity scales linearly to 1.0 at 50% shortfall.
        const severity = Math.min(1, worst / 0.5)
        return {severity, shortPositions, worstShortfallPct: worst}
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, {once: true})
    } else {
        run()
    }
})()
