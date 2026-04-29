"use strict"

/**
 * FleetRoutineOrchestrator — execute a routine against a matched aircraft
 * set.
 *
 * A "run" is the bounded operation triggered by the Apply button on a
 * routine row in the Aircraft Plans panel. It does two things per
 * matched aircraft, sequentially per aircraft but parallel across
 * aircraft (capped concurrency to keep the proxy fetcher polite):
 *
 *   1. Generate a wave draft using AesAfpCandidatePipeline against the
 *      routine's preset (or, when null, the per-hub default).
 *   2. If the routine's strategy policy enables `scheduleApplyEnabled`,
 *      mark every pending leg of the freshly-generated draft as applied
 *      via AesAfpActiveDraftStore.setApplied (Tier-1 mark — the actual
 *      AS submit still happens through the AFP page's wave-applier).
 *
 * Strategy moves beyond schedule (service / price / crew / route
 * creation) are NOT executed in v1. The routine.strategyPolicy.domains
 * flags are passed through for future integration with apply-pipeline.js
 * once we have a clean way to scope the apply window.
 *
 * Per-aircraft skipDomains overrides take precedence over the routine's
 * fleet-wide policy — a routine that enables schedule apply but lists
 * `["schedule"]` in skipDomains for one aircraft will NOT apply on that
 * tail.
 *
 * Public API:
 *   const report = await FleetRoutineOrchestrator.run(routine, ctx)
 *
 * ctx shape:
 *   {
 *     server, airlineCode,
 *     rows,     // FleetHubAircraftAggregator.enrich() output
 *     tags,     // AircraftTagsStore.load() block (.byAircraftId)
 *     presets,  // SchedulePresets.load() block (.presets)
 *     concurrency: 2,                  // optional
 *     onAircraftStart(aircraftId, ix, total)?,
 *     onAircraftDone(aircraftId, ix, total, outcome)?
 *   }
 *
 * report shape (also persisted on the routine via FleetRoutinesStore.markApplied):
 *   {
 *     startedAt, finishedAt,
 *     matchedAircraftIds: string[],
 *     perAircraft: {[id]: {ok:bool, error?:string, generatedLegs?:int, appliedLegs?:int}},
 *     totals: {ok:int, fail:int, generated:int, applied:int}
 *   }
 */
class FleetRoutineOrchestrator {

    static DEFAULT_CONCURRENCY = 2

    static async run(routine, ctx) {
        if (!routine) return FleetRoutineOrchestrator._emptyReport(["noRoutine"])
        if (!ctx || !ctx.server) return FleetRoutineOrchestrator._emptyReport(["noCtx"])

        const startedAt = Date.now()

        // Phase 5 — sister-airline scope. Resolve which accounts this run
        // covers. The orchestrator can only execute against the current
        // account in v1 (the AFP candidate pipeline + proxy fetcher need
        // a live AS session); other accountIds are recorded as deferred
        // outcomes so the user knows to visit those airlines.
        const currentId = (typeof window !== "undefined" && window.__aesAccountId) || null
        const accountIds = (Array.isArray(routine.accountIds) && routine.accountIds.length)
            ? routine.accountIds.slice()
            : (currentId ? [currentId] : [])
        const deferredAccountIds = currentId
            ? accountIds.filter(id => id && id !== currentId)
            : []

        const matched = FleetRoutineOrchestrator._matchAircraft(routine, ctx)
        const perAircraft = {}
        const totals = {ok: 0, fail: 0, generated: 0, applied: 0, deferred: 0}

        if (!matched.length) {
            return {
                startedAt, finishedAt: Date.now(),
                matchedAircraftIds: [],
                perAircraft, totals,
                error: "noMatch"
            }
        }

        // Build the concrete generate/apply task for one aircraft. Closes
        // over `routine` + `ctx` so the worker pool stays generic.
        const total = matched.length
        const queue = matched.slice()
        let started = 0

        const next = async () => {
            const row = queue.shift()
            if (!row) return
            const aircraftId = String(row.aircraftId)
            const ix = ++started
            if (typeof ctx.onAircraftStart === "function") {
                try { ctx.onAircraftStart(aircraftId, ix, total) } catch (_) { /* noop */ }
            }
            const outcome = await FleetRoutineOrchestrator._runOne(routine, ctx, row)
            perAircraft[aircraftId] = outcome
            if (outcome.ok) {
                totals.ok++
                totals.generated += outcome.generatedLegs || 0
                totals.applied   += outcome.appliedLegs   || 0
            } else {
                totals.fail++
            }
            if (typeof ctx.onAircraftDone === "function") {
                try { ctx.onAircraftDone(aircraftId, ix, total, outcome) } catch (_) { /* noop */ }
            }
            return next()  // pull the next task off the shared queue
        }

        const concurrency = Math.max(1, Number(ctx.concurrency) || FleetRoutineOrchestrator.DEFAULT_CONCURRENCY)
        const workers = []
        for (let i = 0; i < Math.min(concurrency, matched.length); i++) workers.push(next())
        await Promise.all(workers)

        // Surface deferred sister accounts in the report so the UI can
        // show which airlines need a follow-up visit.
        totals.deferred = deferredAccountIds.length
        const report = {
            startedAt,
            finishedAt: Date.now(),
            matchedAircraftIds: matched.map(r => String(r.aircraftId)),
            perAircraft,
            totals,
            executedAccountId: currentId,
            deferredAccountIds
        }

        // Persist outcome on the routine. Best-effort — store failure
        // doesn't invalidate the run.
        if (typeof window.FleetRoutinesStore !== "undefined" && routine.id) {
            try { await window.FleetRoutinesStore.markApplied(routine.id, report) }
            catch (e) { console.warn("[AES Fleet Routine] markApplied failed", e) }
        }
        return report
    }

    /**
     * Run one aircraft through the routine. Two steps: generate (always),
     * apply-pending (only when the policy enables schedule apply for this
     * aircraft after per-aircraft overrides are layered).
     */
    static async _runOne(routine, ctx, row) {
        const aircraftId = String(row.aircraftId)
        const out = {ok: false, generatedLegs: 0, appliedLegs: 0}

        // Resolve the effective settings for this aircraft. We don't
        // mutate AesStrategySettings — for v1 the only flag we consume
        // here is `scheduleApplyEnabled`. (Price/service/crew/route flags
        // are read but not acted on; they're recorded in the report for
        // observability and future apply-pipeline integration.)
        const baseSettings = (ctx.baseStrategySettings) || {}
        const eff = (typeof window.FleetRoutinesStore !== "undefined")
            ? window.FleetRoutinesStore.resolveEffectiveSettings(baseSettings, routine, aircraftId)
            : baseSettings

        // ── Step 1 — generate via AFP candidate pipeline ──────────────
        const pipelineNs = window.AesAfpCandidatePipeline
        const fetcherNs  = window.AesAfpProxyPageFetcher
        const draftNs    = window.AesAfpActiveDraftStore
        if (!pipelineNs || !fetcherNs || !draftNs) {
            out.error = "AFP modules not loaded"
            return out
        }
        if (!ctx._pipeline) {
            ctx._pipeline = new pipelineNs({server: ctx.server, airlineCode: ctx.airlineCode})
        }
        if (!ctx._fetcher) {
            ctx._fetcher = new fetcherNs({server: ctx.server, airlineCode: ctx.airlineCode})
        }

        try {
            const fc = await ctx._fetcher.fetchAircraftFormContext(aircraftId)
            if (!fc || !fc.ok) {
                out.error = (fc && fc.error && fc.error.message) || "fetch form context failed"
                return out
            }
            const presetId = routine.presetId
                || FleetRoutineOrchestrator._presetForHub(row.hub, ctx)
            const r = await ctx._pipeline.generateBuild({
                aircraftId,
                formContext: fc.formContext,
                presetId:    presetId,
                typeId:      row.typeId || null
            })
            if (!r || !r.ok) {
                out.error = (r && r.error && r.error.message) || "generate failed"
                return out
            }
            const flights = (r.build && r.build.flights) || []
            await draftNs.setFlights(ctx.server, aircraftId, {
                hub:         r.hub || row.hub || null,
                presetId:    r.preset ? r.preset.id : (presetId || null),
                flights,
                generatedAt: Date.now()
            })
            out.generatedLegs = flights.length

            // ── Step 2 — Tier-1 mark-applied for pending legs ─────────
            if (eff.scheduleApplyEnabled === true) {
                const newDraft = await draftNs.load(ctx.server, aircraftId)
                const applied  = newDraft.appliedLegs || {}
                const dismissed = newDraft.dismissedLegs || {}
                const pending  = (newDraft.flights || [])
                    .filter(f => f && f.seq != null && !applied[f.seq] && !dismissed[f.seq])
                let n = 0
                for (const f of pending) {
                    try {
                        await draftNs.setApplied(ctx.server, aircraftId, f.seq, Date.now())
                        n++
                    } catch (e) {
                        console.warn("[AES Fleet Routine] setApplied " + aircraftId + " seq=" + f.seq, e)
                    }
                }
                out.appliedLegs = n
            }
            out.ok = true
            return out
        } catch (err) {
            out.error = (err && err.message) || String(err)
            return out
        }
    }

    static _matchAircraft(routine, ctx) {
        const ns = window.AircraftTagsStore
        if (!ns) return ctx.rows || []
        const tags = (ctx.tags && ctx.tags.byAircraftId) || (ctx.tags) || {}
        return ns.match(ctx.rows || [], tags, (routine && routine.aircraftFilter) || {})
    }

    /** Mirror command-center's preset-by-hub fallback so the orchestrator
     *  picks the same preset the per-row Generate button would. */
    static _presetForHub(hub, ctx) {
        const presets = (ctx.presets && ctx.presets.presets)
            || (Array.isArray(ctx.presets) ? ctx.presets : [])
        if (!presets.length) return null
        const HUB = String(hub || "").toUpperCase()
        if (HUB) {
            const m = presets.find(p => String((p && p.hub) || "").toUpperCase() === HUB)
            if (m) return m.id
        }
        const dflt = ctx.presets && ctx.presets.defaultPresetId
        if (dflt) {
            const d = presets.find(p => p.id === dflt)
            if (d) return d.id
        }
        return presets[0].id
    }

    static _emptyReport(errors) {
        return {
            startedAt: Date.now(),
            finishedAt: Date.now(),
            matchedAircraftIds: [],
            perAircraft: {},
            totals: {ok: 0, fail: 0, generated: 0, applied: 0},
            error: (errors && errors[0]) || "empty"
        }
    }
}

if (typeof window !== "undefined") {
    window.FleetRoutineOrchestrator = FleetRoutineOrchestrator
}
