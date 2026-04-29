"use strict"

/**
 * Canonical topic registry for `AesDataBus`. Read by humans (this is the
 * single source of truth for topic names) and by the slice-2 dashboard tile
 * (which renders the registry as a tree). Imported nowhere — `data-bus.js`
 * does not enforce these names; the convention is enforced socially.
 *
 * **Topic grammar:** `data:<module>:<slice>:<verb>` — three colon-segments.
 * Verbs:
 *   `saved`     — a settings-style blob was written
 *   `updated`   — a periodic cache was refreshed (scrape, derive)
 *   `appended`  — a ringbuffer/history-style record was added
 *   `applied`   — an applier successfully posted a change to AS (post-write)
 *   `concluded` — a long-running record (experiment, dispatch) reached terminal state
 *   `diff`      — a structural delta was computed between two snapshots
 *   `cleared`   — bulk delete (DevTools / reset)
 *   `migrated`  — schema/key shape changed (rare)
 *
 * **Signal topics.** A second namespace `signal:<module>:<kind>` carries
 * cross-feature reaction hints (crew pressure, competitor threat, cash
 * runway, wear pressure). Consumers decide whether to act; producers do
 * not gate on subscribers. Same payload contract as `data:` topics.
 *
 * **Payload contract:** minimal — `{at, topic, source: "local"|"storage",
 * key?, suffix?, accountId?, ...hint}`. Hints are tiny primitives the
 * subscriber needs to decide whether to act; subscribers re-fetch via the
 * producer's existing `get()` to avoid stale-snapshot bugs.
 *
 * **Coalescing rule:** writers that touch many keys in a tight loop (e.g.
 * `saveCountryAirports` writing 50 demand records) emit ONCE with a count
 * in the hint, NOT N events. The data-bus storage-echo bridge also dedupes
 * within a single onChanged batch.
 *
 * **Exception:** `data:route-assistant:fuel-price:updated` carries the
 * scalar `{value, unit}` because every subscriber will read it AND it's
 * tiny. This is the only exception to the minimal-payload rule.
 *
 * **Value cache (`publish`/`last`).** Topics with `valueShape` are produced
 * via `AesDataBus.publish(topic, value)` and read via `AesDataBus.last(topic)`
 * (sync) or `AesDataBus.peek(topic, fetcher)` (cold-start fallback).
 * `valueShape` is a documentation-only field describing the cached value;
 * subscribers can still re-fetch via the producer's `get()` if they prefer.
 */
window.AES_DATA_BUS_TOPICS = [
    // -- route-assistant --
    {
        topic:    "data:route-assistant:settings:saved",
        emittedBy: "modules/route-assistant/settings-store.js",
        hint:     "{accountId, sections: string[]}",
        notes:    "fired on every RouteAssistantSettings.save(partial); sections lists the top-level keys touched"
    },
    {
        topic:      "data:route-assistant:fuel-price:updated",
        emittedBy:  "modules/route-assistant/fuel-price-scraper.js",
        hint:       "{value, unit}  // scalar carried by exception",
        valueShape: "{value: number, unit: string, scrapedAt: number}",
        notes:      "fuel price scrape success; published via AesDataBus.publish — read with AesDataBus.last() or peek()"
    },
    {
        topic:    "data:route-assistant:demand:saved",
        emittedBy: "modules/route-assistant/demand-store.js",
        hint:     "{iata?, countryId?, count?}  // single record OR coalesced bulk",
        notes:    "saveCountryAirports emits once with count; save(record) emits once with iata"
    },

    // -- used-aircraft-scanner --
    {
        topic:    "data:scanner:price-history:appended",
        emittedBy: "modules/used-aircraft-scanner/price-history-store.js",
        hint:     "{server, typeIds: string[]}",
        notes:    "fired after recordRows; typeIds are the types whose history grew this batch"
    },

    // -- crew-management --
    {
        topic:    "data:crewMgmt:staffOverview:saved",
        emittedBy: "modules/crew-management/content-staff-overview.js",
        hint:     "{weekId, weeklyTotal, nextWeekTotal}",
        notes:    "fired after staffOverview scrape + store; subscribers refetch via CrewMgmtStaffOverviewStore.loadLatest() / loadHistory()"
    },
    {
        topic:    "data:crewMgmt:payTier:applied",
        emittedBy: "modules/crew-management/pay-tier-applier.js",
        hint:     "{positionId, requestedSalary, verified}",
        notes:    "fired only on terminal-success status (verified|posted); subscribers refetch via CrewMgmtPayTierApplyLog.getRecent()"
    },

    // -- route-assistant scrapers --
    {
        topic:    "data:route-assistant:markets:updated",
        emittedBy: "modules/route-assistant/markets-page-scraper.js",
        hint:     "{hub, dest, keysTouched: string[]}  // coalesced one event per route per scrape, not per family",
        notes:    "fired by saveAllRecords; subscribers reload via RouteAssistantMarketsPageScraper.loadAll(hub, dest)"
    },
    {
        topic:    "data:route-assistant:serviceProfile:updated",
        emittedBy: "modules/route-assistant/service-profile-scraper.js",
        hint:     "{kind: 'list'|'detail', count?, id?}",
        notes:    "list saves carry count; detail saves carry id"
    },
    {
        topic:    "data:route-assistant:ors:updated",
        emittedBy: "modules/route-assistant/ors-scraper.js",
        hint:     "{hub, dest}",
        notes:    "single key per route; subscribers refetch via RouteAssistantOrsScraper.loadRecord"
    },
    {
        topic:    "data:route-assistant:schedule:updated",
        emittedBy: "modules/route-assistant/schedule-page-scraper.js",
        hint:     "{hub, dest}",
        notes:    "fired by saveRecord (live-read or fetch path)"
    },
    {
        topic:    "data:route-assistant:airportOverview:updated",
        emittedBy: "modules/route-assistant/airport-overview-scraper.js",
        hint:     "{stationId, pairCount}",
        notes:    "alliance + traffic snapshot for one airport"
    },

    // -- route-assistant appliers --
    {
        topic:    "data:route-assistant:pricing:applied",
        emittedBy: "modules/route-assistant/pricing-applier.js",
        hint:     "{hub, dest, classes: string[], verified}",
        notes:    "fired only on terminal-success status (verified|posted); subscribers refetch via RouteAssistantPricingApplyLog"
    },
    {
        topic:    "data:route-assistant:serviceProfile:applied",
        emittedBy: "modules/route-assistant/service-profile-applier.js",
        hint:     "{profileId, verified}",
        notes:    "fired only on terminal-success status posted; subscribers refetch via RouteAssistantServiceProfileApplyLog"
    },

    // -- competitor-intel --
    {
        topic:    "data:competitor-intel:enterprise:updated",
        emittedBy: "modules/competitor-intel/snapshot-store.js",
        hint:     "{server, eid}",
        notes:    "fired only when projection differs from prior; subscribers refetch via AesCompetitorSnapshotStore.loadLatest"
    },
    {
        topic:    "data:competitor-intel:enterprise:diff",
        emittedBy: "modules/competitor-intel/snapshot-store.js  // (uses AesCompetitorDiff.compare internally)",
        hint:     "{server, eid, eventCount, types: string[]}",
        notes:    "fired when prior exists AND diff produced events; consumers (e.g. auto-driver) read types to decide whether to fire signal:strategy:competitor-threat"
    },

    // -- aircraft-flight-plan --
    {
        topic:    "data:afp:maintenance:updated",
        emittedBy: "modules/aircraft-flight-plan/maintenance-store.js",
        hint:     "{server, aircraftId, ratioStatus}",
        notes:    "wear-ratio status hint lets subscribers cheap-skip when nothing critical changed"
    },
    {
        topic:    "data:afp:flightLog:appended",
        emittedBy: "modules/aircraft-flight-plan/flight-log-store.js",
        hint:     "{server, aircraftId, flightCount}",
        notes:    "per-aircraft flight history; consumed by wear-model and context.js"
    },

    // -- accounting --
    {
        topic:    "data:accounting:snapshot:updated",
        emittedBy: "modules/accounting/snapshot-store.js",
        hint:     "{server, airline, weekId?, type, sister?}",
        notes:    "weekly tab saves carry weekId; sister-page saves carry sister:true; subscribers refetch via AccountingSnapshotStore.loadLatest"
    },
    // -- signal:strategy:* (cross-feature reaction hints, Phase A2) --
    {
        topic:    "signal:strategy:crew-pressure",
        emittedBy: "modules/crew-management/content-staff-overview.js  // post-save derivator",
        hint:     "{severity: 0..1, shortPositions: string[], worstShortfallPct: number}",
        notes:    "fired when employed<required for any role; severity scales linearly to 1.0 at 50% shortfall. Consumed by price-moves/service-moves to dampen aggressive moves; by salience scorer to boost crew tile."
    },
    {
        topic:    "signal:strategy:competitor-threat",
        emittedBy: "modules/competitor-intel/snapshot-store.js  // alongside :diff event",
        hint:     "{server, eid, kind: 'newRoute'|'capacityHike', routes: string[]}",
        notes:    "fired when diff yields route.entered or fleet.gained/type.added events. Consumed by auto-driver to fire ad-hoc tick scoped to affected route + price domain."
    },
    {
        topic:    "signal:strategy:cash-low",
        emittedBy: "modules/strategy/context.js  // _summarizeCash",
        hint:     "{runwayWeeks, bankBalance, weeklyResult}",
        notes:    "fired when computed runway < 8 weeks. Consumed by auto-driver to veto routeCreation; by pricing-compass to render 'gated by cash' callout."
    },
    {
        topic:    "signal:strategy:wear-pressure",
        emittedBy: "modules/aircraft-flight-plan/maintenance-store.js",
        hint:     "{server, aircraftId, severity: 0..1, ratio?}",
        notes:    "fired when ratioStatus is 'warn' (severity 0.5) or 'bad' (severity 1.0). Consumed by auto-driver to drop schedule-domain candidates; by salience scorer to boost fleet/maintenance tile."
    },

    // -- strategy outcomes --
    {
        topic:    "data:strategy:serviceExperiment:concluded",
        emittedBy: "modules/strategy/service-experiment-store.js  // _appendOutcome",
        hint:     "{experimentId, state, winner: 'perturbation'|'base'|'tie'|null}",
        notes:    "fired on first transition to a terminal state with a non-null outcome. Consumed by Phase D2's weekly-review tile."
    },
    {
        topic:    "data:strategy:dispatch:pending",
        emittedBy: "modules/strategy/decision-dispatch.js  // composeMove",
        hint:     "{hub, dest, classKey, source}",
        notes:    "fired when a compose request lands. Strategy panel reads aesStrategy:dispatchPending via readPending() to scroll/select."
    },
    {
        topic:    "data:strategy:dispatch:applied",
        emittedBy: "modules/strategy/decision-dispatch.js  // applyPending",
        hint:     "{hub, dest, classKey, decisionId, appliedAt}",
        notes:    "fired only on successful direct-apply via applyPending(). Consumed by review tile to flag the dispatch as resolved."
    }

    // Slices 2 + 3 will add: data:schedule-management:store:saved,
    // data:schedule-management:presets:saved, data:scanner:scan:finished, etc.
]

// Self-register every documented topic with the bus on load. This is what
// turns the array above from documentation-only into a queryable contract:
// `AesDataBus.auditTopics()` now distinguishes registered (in this file) from
// discovered (emitted somewhere but not in this file — the drift list).
// Loaded after data-bus.js per manifest order; defensive if the bus didn't
// initialise (Service worker context, alternative load orders, etc.).
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesDataBus || typeof window.AesDataBus.register !== "function") return
    for (const entry of window.AES_DATA_BUS_TOPICS) {
        if (!entry || typeof entry.topic !== "string") continue
        try { window.AesDataBus.register(entry.topic, entry) }
        catch (_) { /* noop — never break load on a bad entry */ }
    }
})()
