"use strict"

/**
 * AesConductorRiskRegister — K12 shared helper.
 *
 * Builds a per-(server, airline) "risk register": Conductor scenario fires
 * grouped by category (financial / operational / competitive / regulatory)
 * plus the most-recent K14 drift proposals.
 *
 * Lifted out of `modules/strategy/briefing.js` so the standalone risk-
 * dashboard tile and the briefing modal share one implementation. Briefing
 * keeps a thin shim that delegates to this module.
 *
 * Public API (window.AesConductorRiskRegister):
 *   build(host, opts) → Promise<{count, byCategory, fires, driftProposals}>
 *
 *   opts = {
 *     fireLimit?:           number,            // default 10
 *     proposalLimit?:       number,            // default 10
 *     includeFavourable?:   boolean,           // default false (only "interesting")
 *     includeInfo?:         boolean,           // default false
 *     filterCategory?:      string|null        // "financial" | "operational" | "competitive" | "regulatory"
 *   }
 *
 * Reads only — never POSTs, never writes.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorRiskRegister) return

    const SCENARIO_CATEGORY = {
        CashStep:               "financial",
        CashRunwayDefence:      "financial",
        CashCrunchForecast:     "financial",
        MaintenanceWatch:       "operational",
        ConditionWatch:         "operational",
        FleetIdle:              "operational",
        WaveStress:             "operational",
        CrewShortfall:          "operational",
        ProfitDecay:            "competitive",
        OrsRegression:          "competitive",
        CompetitorEntry:        "competitive",
        CompetitorExit:         "competitive",
        DemandShift:            "competitive",
        PricingSpiralRisk:      "competitive",
        ServiceDrift:           "operational",
        SisterCannibalisation:  "operational",
        HubImbalance:           "operational"
    }

    function _categoryOf(scenarioId) {
        return SCENARIO_CATEGORY[scenarioId] || "operational"
    }

    async function _safeConductorFires(host) {
        try {
            if (window.AesConductorScenarioStore
                    && typeof window.AesConductorScenarioStore.all === "function") {
                const r = await window.AesConductorScenarioStore.all(host)
                return Array.isArray(r) ? r : []
            }
            const key = "aesConductor:fires:" + host.server + ":" + (host.airline || "")
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return Array.isArray(v) ? v : []
        } catch (_) { return [] }
    }

    async function _safeDriftProposals(host) {
        try {
            const key = "aesConductor:driftProposals:" + host.server + ":" + (host.airline || "")
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return Array.isArray(v) ? v : []
        } catch (_) { return [] }
    }

    async function _safeTrustLoad(host) {
        try {
            if (window.AesConductorTrustStore && typeof window.AesConductorTrustStore.load === "function") {
                const r = await window.AesConductorTrustStore.load(host)
                return (r && typeof r === "object") ? r : {}
            }
        } catch (_) { /* noop */ }
        return {}
    }

    async function _safeFireUxSettings(host) {
        try {
            if (window.AesConductorAttention && typeof window.AesConductorAttention.readFireUxSettings === "function") {
                const r = await window.AesConductorAttention.readFireUxSettings(host)
                return r || {fireUx: {}}
            }
        } catch (_) { /* noop */ }
        return {fireUx: {}}
    }

    async function build(host, opts) {
        const out = {
            count:          0,
            byCategory:     {financial: 0, operational: 0, competitive: 0, regulatory: 0},
            fires:          [],
            driftProposals: []
        }
        if (!host || !host.server) return out
        const fireLimit       = (opts && typeof opts.fireLimit === "number" && opts.fireLimit > 0) ? opts.fireLimit : 10
        const proposalLimit   = (opts && typeof opts.proposalLimit === "number" && opts.proposalLimit > 0) ? opts.proposalLimit : 10
        const includeFavour   = !!(opts && opts.includeFavourable)
        const includeInfo     = !!(opts && opts.includeInfo)
        const filterCategory  = (opts && typeof opts.filterCategory === "string") ? opts.filterCategory : null

        const [fires, proposals, trustByScenario, fireUxSettings] = await Promise.all([
            _safeConductorFires(host),
            _safeDriftProposals(host),
            _safeTrustLoad(host),
            _safeFireUxSettings(host)
        ])

        const interesting = []
        for (const f of fires) {
            if (!f) continue
            if (f.dismissedAt) continue
            const sev = String(f.severity || "info")
            const fav = f.outcome && f.outcome.favourable === false
            const matchInteresting = fav || sev === "alert" || sev === "warn" || (includeInfo && sev === "info") || includeFavour
            if (!matchInteresting) continue
            const cat = _categoryOf(f.scenarioId)
            out.byCategory[cat] = (out.byCategory[cat] || 0) + 1
            if (filterCategory && cat !== filterCategory) continue
            interesting.push(f)
        }

        let ranked
        if (window.AesConductorAttention && typeof window.AesConductorAttention.sortFires === "function") {
            ranked = window.AesConductorAttention.sortFires(interesting, trustByScenario, fireUxSettings, Date.now())
        } else {
            const sevWeight = (s) => s === "alert" ? 3 : s === "warn" ? 2 : 1
            ranked = interesting.slice().sort((a, b) => {
                const sw = sevWeight(b.severity || "info") - sevWeight(a.severity || "info")
                if (sw !== 0) return sw
                return (b.firedAt || 0) - (a.firedAt || 0)
            })
        }

        out.fires = ranked.slice(0, fireLimit).map(f => ({
            fireId:       f.id,
            scenarioId:   f.scenarioId,
            label:        f.label || f.scenarioId,
            severity:     String(f.severity || "info"),
            category:     _categoryOf(f.scenarioId),
            rationale:    f.rationale || "",
            firedAt:      f.firedAt || 0,
            outcome:      f.outcome || null,
            tier:         f.tier || null,
            openUrl:      (f.payload && f.payload.openUrl) || null,
            payload:      f.payload || null
        }))
        out.count = interesting.length

        const recent = (proposals || []).slice(-proposalLimit).reverse()
        out.driftProposals = recent.map(p => ({
            scenarioId: p.scenarioId,
            key:        p.key,
            current:    p.current,
            proposed:   p.proposed,
            reason:     p.reason || "",
            createdAt:  p.createdAt || 0,
            accepted:   !!p.accepted
        }))
        return out
    }

    window.AesConductorRiskRegister = {
        build,
        SCENARIO_CATEGORY,
        categoryOf: _categoryOf
    }
})()
