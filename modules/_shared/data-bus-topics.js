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
 *   `cleared`   — bulk delete (DevTools / reset)
 *   `migrated`  — schema/key shape changed (rare)
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
    }

    // Slices 2 + 3 will add: data:schedule-management:store:saved,
    // data:schedule-management:presets:saved, data:scanner:scan:finished, etc.
]
