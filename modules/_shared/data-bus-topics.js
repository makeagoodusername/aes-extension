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
    // -- shared settings plumbing --
    {
        topic:    "data:settings:area:saved",
        emittedBy: "modules/_shared/settings-bridge.js",
        hint:     "{area, accountId, scoped, sections: string[]}",
        notes:    "generic write-through signal for AesSettings.saveArea/saveAreaScoped; domain stores may still emit richer module-specific topics"
    },
    {
        topic:    "data:init:startup:failed",
        emittedBy: "modules/_shared/init-guard.js",
        hint:     "{label, name, message, url, firstAt, lastAt, count}",
        notes:    "tab-local startup guard diagnostic; emitted when a boot slice degrades instead of throwing during content-script startup"
    },

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
        topic:    "data:route-assistant:ors:health",
        emittedBy: "modules/route-assistant/ors-intelligence.js",
        hint:     "{server, accountId, updatedAt, coverage?, lastRun?, breaker?}",
        notes:    "fired by saveHealth on every coverage / sync write; subscribers refresh ORS dashboards + banners"
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
    },
    {
        topic:    "data:strategy:company-reputation:saved",
        emittedBy: "modules/strategy/company-reputation-store.js  // save",
        hint:     "{displayName?, airlineCode?, ratingLabel?, ...rec}",
        notes:    "fired after AesCompanyReputationStore.save persists the cleaned record; subscribers refetch via loadLatest(). Subscriber wiring is follow-up — registered now to clear auditTopics() drift list."
    },
    {
        topic:    "fleet-optimizer:target-changed",
        emittedBy: "modules/strategy/fleet-optimizer-settings.js  // save (dual-emits to CentralHubBus + AesStrategy.bus)",
        hint:     "{before, after, changedKeys: string[]}",
        notes:    "non-canonical topic name (legacy — does not follow data:<module>:<slice>:<verb>); fired after save() persists fleetOptimizer settings. Subscriber wiring is follow-up — registered now to clear auditTopics() drift list."
    },

    // -- conductor K11 / K14 --
    {
        topic:    "data:conductor:trust:updated",
        emittedBy: "modules/conductor/trust-driver.js  // _onOutcomeApplied",
        hint:     "{scenarioId, tq, lcb, tier, n}",
        notes:    "fired after a terminal verdict updates the per-scenario Beta posterior; consumers re-fetch via AesConductorTrustStore.get()"
    },
    {
        topic:    "signal:conductor:tier:promoted",
        emittedBy: "modules/conductor/trust-driver.js",
        hint:     "{scenarioId, fromTier, toTier, reason}",
        notes:    "transition event — fires only when the cached entry.tier changes between two record() calls. Consumers: K11 tile, future K6 history strip"
    },
    {
        topic:    "signal:conductor:drift",
        emittedBy: "modules/conductor/drift-driver.js",
        hint:     "{scenarioId, polarity, magnitude}",
        notes:    "K14 CUSUM drift detection — emitted when residual stream trips the h-threshold; drift-driver also writes a proposal record + clamps K11 tier ceiling"
    },
    {
        topic:    "data:conductor:drift:proposal:created",
        emittedBy: "modules/conductor/drift-driver.js",
        hint:     "{scenarioId, key, current, proposed}",
        notes:    "fired when drift-driver records a threshold-patch proposal; consumed by drift-tile detail modal"
    },
    {
        topic:    "data:conductor:threshold:applied",
        emittedBy: "modules/conductor/threshold-store.js  // apply",
        hint:     "{scenarioId, key, before, after, source}",
        notes:    "fired after a user accepts a drift threshold proposal (live or dry-run); rationale strings on subsequent fires reference the overlay"
    },

    // -- strategy slice 21 — scenario forks --
    {
        topic:    "data:strategy:fork:created",
        emittedBy: "modules/strategy/fork-store.js",
        hint:     "{forkId, baseRev, namedAs}",
        notes:    "fired after AesStrategyForkStore.create() persists a new fork; consumed by counterfactual-lab-tile"
    },
    {
        topic:    "data:strategy:fork:simulated",
        emittedBy: "modules/strategy/forward-simulator.js",
        hint:     "{forkId, weeks, durationMs}",
        notes:    "fired after simulateForward() finishes; payload carries summary stats only — full result via AesStrategyForkStore.get(forkId).lastResult"
    },
    {
        topic:    "data:strategy:fork:promoted",
        emittedBy: "modules/strategy/fork-store.js  // promote",
        hint:     "{forkId, dispatchId}",
        notes:    "fired when a fork's intervention is promoted into decision-dispatch (still through the existing two-gate)"
    },

    // -- central-hub feed bridges + account bootstrap --
    {
        topic:    "data:account:bootstrapped",
        emittedBy: "modules/central-hub/shell.js + modules/central-hub/feed/index.js",
        hint:     "{accountId, server?, airline?, at?}",
        notes:    "fired once per page after AesAccountRegistry resolves __aesAccountId; both shell and feed/index gate on window.__aesAccountBootstrapEmitted so a single emit lands. Consumed by store-cache (acct rebind) and HubFeed cash/strategy slices."
    },
    {
        topic:    "data:accounting:weekly:saved",
        emittedBy: "modules/central-hub/feed/index.js  // substring bridge on 'accounting:' writes",
        hint:     "{key}  // raw chrome.storage.local key that triggered the bridge",
        notes:    "coalesced one-per-onChanged-batch from any accounting:* write (e.g. 'ZB:1234:accounting:index'); cash-feed slice reads via deps[]"
    },
    {
        topic:    "data:strategy:applied:saved",
        emittedBy: "modules/central-hub/feed/index.js  // bridgeStorage(prefix='aesStrategy:plan:applied')",
        hint:     "{key, suffix?, source: 'storage'}",
        notes:    "bridge translates legacy 'aesStrategy:plan:applied' storage writes into a bus topic; consumed by strategy-feed slice via deps[]"
    },
    {
        topic:    "data:strategy:settings:saved",
        emittedBy: "modules/central-hub/feed/index.js  // bridgeStorage(prefix='settings', single=true)",
        hint:     "{key: 'settings', source: 'storage'}",
        notes:    "RA + strategy settings live in the shared 'settings' blob; bridge fires once per onChanged batch. Consumed by strategy-feed slice via deps[]"
    },

    // -- command-palette telemetry (Slice 16) --
    {
        topic:    "data:command-palette:opened",
        emittedBy: "modules/command-palette/host.js  // _emitBus('opened')",
        hint:     "{scope, at}",
        notes:    "fired when the palette opens. No subscriber today; registered for data-flow-inspector visibility + auditTopics() truth"
    },
    {
        topic:    "data:command-palette:closed",
        emittedBy: "modules/command-palette/host.js  // _emitBus('closed')",
        hint:     "{scope, at}",
        notes:    "fired when the palette closes (Esc / dispatch / backdrop click). No subscriber today; registered for inspector visibility"
    },
    {
        topic:    "data:command-palette:invoked",
        emittedBy: "modules/command-palette/host.js  // _emitBus('invoked', {id})",
        hint:     "{scope, at, id}",
        notes:    "fired immediately before AESCommandRegistry.dispatch(id). No subscriber today; registered for inspector visibility + future analytics"
    },

    // -- strategy:layered stores (published with valueShape; subscribers may use last/peek) --
    {
        topic:      "data:strategy:layered:division-changed",
        emittedBy:  "modules/strategy/layered/division-store.js  // _emit",
        hint:       "{event, …}  // event-shape per division-store internals",
        valueShape: "{event: 'created'|'updated'|'deleted'|'restored', divisionId?, def?}",
        notes:      "published (cached) — subscribers use AesDataBus.last() or peek() to read; CentralHubBus also carries the plain 'strategy:layered:division-changed' event"
    },
    {
        topic:      "data:strategy:layered:family-changed",
        emittedBy:  "modules/strategy/layered/family-store.js  // _emit",
        hint:       "{event, …}  // event-shape per family-store internals",
        valueShape: "{event: 'created'|'updated'|'deleted'|'restored', familyId?, def?}",
        notes:      "published (cached) — see division-changed for read pattern"
    },
    {
        topic:      "data:strategy:layered:fleet-changed",
        emittedBy:  "modules/strategy/layered/fleet-store.js  // _emit",
        hint:       "{event, …}  // event-shape per fleet-store internals",
        valueShape: "{event: 'created'|'updated'|'deleted'|'restored', fleetId?, def?}",
        notes:      "published (cached) — see division-changed for read pattern"
    },
    {
        topic:      "data:strategy:layered:route-extras-changed",
        emittedBy:  "modules/strategy/layered/route-extras-store.js  // _emit",
        hint:       "{event, …}  // event-shape per route-extras-store internals",
        valueShape: "{event: 'saved'|'deleted'|'restored', routeKey?, blob?}",
        notes:      "published (cached) — see division-changed for read pattern"
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
