"use strict"

/**
 * Canonical view: `fleet:wear-rollup`
 *
 * One cached fleet-wide rollup of per-aircraft maintenance data, replacing
 * the per-tail storage walks scattered across:
 *   - modules/strategy/context.js _enrichWear (loops every snapshot tick)
 *   - modules/central-hub/tiles/fleet-optimizer-tile.js (rollup compute)
 *   - modules/central-hub/tiles/fleet-command-tile.js (per-aircraft load)
 *
 * Output shape:
 *   {
 *     scrapedAt:       number,             // max(maintenance.scrapedAt) across fleet
 *     totalTails:      number,
 *     fleetWearAvg:    number | null,      // avg ratio across tails with valid ratio
 *     wearStressCount: number,             // tails with ratio > 80
 *     oldestAgeYears:  number | null,
 *     byTail:          { [aircraftId]: {ratio, condition, ratioStatus, ageYears, scrapedAt} }
 *   }
 *
 * Cold mount returns `{totalTails: 0, byTail: {}, ...nulls}`. Producers that
 * have never run yield an inert shape; consumers should null-guard rather
 * than block.
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesView || !window.AesDataBus) return
    if (window.__aesViewFleetWearRollupDeclared) return
    window.__aesViewFleetWearRollupDeclared = true

    const STRESS_THRESHOLD = 80   // ratio % above which a tail counts as "stressed"

    AesView.declare({
        name:       "fleet:wear-rollup",
        deps:       [
            "data:afp:maintenance:updated",
            "data:afp:flightLog:appended",
            "data:account:bootstrapped"
        ],
        debounceMs: 100,
        compute:    async () => {
            const ctx = pickCtx()
            if (!ctx.server || !ctx.airline) return inert()
            if (typeof window.AesFleetRoster === "undefined") return inert()

            let roster
            try { roster = await window.AesFleetRoster.load(ctx.server, ctx.airline) }
            catch (_) { return inert() }
            const aircraft = (roster && Array.isArray(roster.aircraft)) ? roster.aircraft : []
            if (!aircraft.length) return inert()

            const hasMaint = typeof window.AesAfpMaintenanceStore !== "undefined"
            const byTail = {}
            let scrapedAt = 0
            let ratioSum = 0
            let ratioCount = 0
            let stressCount = 0
            let oldestAge = null

            for (const a of aircraft) {
                if (!a || a.aircraftId == null) continue
                const id = a.aircraftId
                let m = null
                if (hasMaint) {
                    try { m = await window.AesAfpMaintenanceStore.load(ctx.server, id) }
                    catch (_) { m = null }
                }
                const ratio = m && Number.isFinite(m.ratio) ? Number(m.ratio) : null
                if (ratio != null) {
                    ratioSum   += ratio
                    ratioCount += 1
                    if (ratio > STRESS_THRESHOLD) stressCount += 1
                }
                const ageYears = Number.isFinite(a.age) ? Number(a.age) : null
                if (ageYears != null && (oldestAge == null || ageYears > oldestAge)) {
                    oldestAge = ageYears
                }
                if (m && Number.isFinite(m.scrapedAt) && m.scrapedAt > scrapedAt) {
                    scrapedAt = m.scrapedAt
                }
                byTail[id] = {
                    ratio:           ratio,
                    condition:       m && Number.isFinite(m.condition) ? Number(m.condition) : null,
                    ratioStatus:     m && m.ratioStatus     || null,
                    conditionStatus: m && m.conditionStatus || null,
                    ageYears:        ageYears,
                    scrapedAt:       m && Number.isFinite(m.scrapedAt) ? m.scrapedAt : null
                }
            }

            return {
                scrapedAt:       scrapedAt || null,
                totalTails:      Object.keys(byTail).length,
                fleetWearAvg:    ratioCount ? (ratioSum / ratioCount) : null,
                wearStressCount: stressCount,
                oldestAgeYears:  oldestAge,
                byTail:          byTail
            }
        }
    })

    function inert() {
        return {
            scrapedAt:       null,
            totalTails:      0,
            fleetWearAvg:    null,
            wearStressCount: 0,
            oldestAgeYears:  null,
            byTail:          {}
        }
    }

    function pickCtx() {
        let server = "", airline = ""
        try {
            if (typeof AES !== "undefined") {
                if (AES.getServer)          server  = AES.getServer() || ""
                if (AES.getAirlineIdentity) airline = AES.getAirlineIdentity() || ""
            }
        } catch (_) {}
        return {server: server, airline: airline}
    }
})()
