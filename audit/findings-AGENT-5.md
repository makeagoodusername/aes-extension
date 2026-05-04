# Findings — Agent 5

Territory: UAS, World View, dashboard intelligence tiles
(`modules/used-aircraft-scanner/**`, `modules/world-view/**`,
`modules/central-hub/tiles/{world-view,fleet-hub,fleet-command,fleet-optimizer,competitor-monitoring,route-launcher,data-flow-inspector,alliance,used-aircraft-scanner}-tile.js`,
`content_dashboard.js`, `content_marketScan.js`)

---

## Phase 1 audit — pre-fix mapping

Phase 1 ran read-only against the on-disk state. No edits were made; no live
verification done yet (will follow after the user gates Phase 2).

### Pre-existing fixes confirmed present on disk

The earlier port-9228 work in `claims.log` (F-9228-200…204 UAS tile,
F-9228-400…405 World View, F-9228-704…706 fleet tiles) is all present in the
current source. Spot-checked each annotated comment block; no regressions.

The CONSOLIDATION-SUMMARY.md "Round 5 / Intelligence/World" line claims 4
fixes already shipped (competitor-monitoring filter, station-automation
watchedStorageKeys, etc.). All visible in current code.

### F-DASH-501 (live)

- `[OBSERVATION]` `competitor-monitoring-tile.js:73-83` — re-renders on
  `data:competitor-intel:enterprise:diff` and `…:updated`. Looks intentional
  and consistent with the bus topic registry. No issue.

### F-DASH-101/102 already FIXED per claims.log

- Marked FIXED at port-fleet-aircraft. Verified in code (lines visible in
  `used-aircraft-scanner-tile.js` + `aircraft-profitability-tile.js`).

---

## Findings — new this session

### F-DASH-501 [BUG] — World View network cache ignores snapshot freshness

**File:** `modules/central-hub/tiles/world-view-tile.js:132-144`

`_buildOrLoadNetwork()` decides whether the cached `WorldViewNetwork` is
fresh by comparing `cached.sourceFreshness.allianceTs` against the live
alliance scrape time, plus a partner-cache size sanity check. It does NOT
compare `cached.sourceFreshness.snapshotTs` against `snapshot.ts`.

Effect: when `AesStrategy.snapshot()` advances (a new market scrape lands
through schedule-page-scraper or strategy hubs are re-scraped) but the
alliance + partner-cache haven't changed, the World View serves a
network whose `competition.flightCount`/`seatCount`/`dominantEnterpriseId`
are derived from a **stale** snapshot for up to the cache TTL (1h
default).

Fix shape (minimal): add `snapshotTs <= cachedSnapshotTs` to the same gate.

```js
const cachedSnapshotTs = (cached.sourceFreshness && cached.sourceFreshness.snapshotTs) || 0
const liveSnapshotTs = (snapshot && snapshot.ts) || 0
if (allianceTs <= cachedAt + 1000 && liveSameSize && liveSnapshotTs <= cachedSnapshotTs + 1000) return cached
```

Severity: low — TTL still bounds it to 1h, and competition data isn't
load-bearing for any apply path. Worth fixing because the World View is
the user's "cross-network at-a-glance" surface and silently stale data
on the bubble pressure colors is confusing.

### F-DASH-502 [BUG] — `_renderRecommendationsPlaceholder` is dead code

**File:** `modules/central-hub/tiles/world-view-tile.js:374-376, 404-418`

Falls back to a "RECOMMENDATIONS · alliance + interline recommendations
land in slice W4" message when `WorldViewRecommendationsPane.render`
isn't loaded. The pane is in the dashboard manifest block (per
HANDOVER.md §1 World View entry) and always loads on
`/app/enterprise/dashboard*`. The placeholder cannot fire under any
configuration that ships today.

Severity: cosmetic. Either delete the helper + its branch, or convert to
a real "loading…" surface that fires while the recommendations are still
being computed (the `onPickEnterprise` async work currently shows nothing
on first paint).

### F-DASH-503 [QUESTION] — competitor-monitoring tile does full-storage `get(null)` per render

**File:** `modules/central-hub/tiles/competitor-monitoring-tile.js:93`

`_loadCompetitors()` runs `await chrome.storage.local.get(null)` then
filters in JS. This is called from `loadStatus()` and `renderBody()`, and
the `watchedStorageKeys` server-prefix listener triggers `refresh()` (and
thus another full scan) on every storage write that starts with the
server prefix — which on a busy dashboard is dozens per minute (RA writes,
strategy snapshots, AFP drafts, all share the server prefix).

The comment at line 31-35 explains the constraint (the storage shape
`<server><competitorEnterpriseId>competitorMonitoring` doesn't have a
shared prefix that matches only competitors). Fair, but the consequence
is real: the tile contributes O(N) work per storage tick where N is the
full chrome.storage.local size.

Mitigation candidates (Phase 2 if priority):
- Cache the filtered list keyed off a hash of competitor keys, invalidate
  only when a key matching the actual competitor shape changes.
- Replace `get(null)` with `chrome.storage.local.getKeys?` filtered by
  suffix (`endsWith("competitorMonitoring")`).

Severity: not a bug — works correctly. Performance flag only.

### F-DASH-504 [BUG] — content_marketScan.js `MAX_PAGES` only protects against runaway, not against actual full-family scrapes silently truncating

**File:** `content_marketScan.js:53` (`MAX_PAGES: 200`)

The constant was raised from 50→200 per the comment. With 25 offers/page
this is a 5000-offer ceiling per type. On a peak season for popular
families (737-800, A320-200) this can be hit; the natural exit (no
"next" link) is the *primary* break, and the cap is the *secondary*. But
the "AES marketScan: max pages reached" log isn't currently surfaced in
the dashboard UI — the user would see a truncated result count without
warning.

Verification: `grep "max pages\|MAX_PAGES" content_marketScan.js` —
review surface vs the result writer.

Severity: low. The cap is generous, and silent truncation is unlikely on
typical worlds. Worth noting in HANDOVER.md §10 invariants.

### F-DASH-505 [BUG candidate] — route-launcher-tile focus-aircraft handler relies on cross-module bus subscriber

**File:** `modules/central-hub/tiles/route-launcher-tile.js:79-84`

```js
this.subscribeBus("focus-aircraft", ({aircraftId}) => {
    if (!aircraftId) return
    if (!this.expanded) this.toggle()
    if (this.root) this.root.scrollIntoView({behavior: "smooth", block: "start"})
})
```

The handler does NOT call `RouteLauncher.setActive({aircraftId})`. The
expectation per `modules/route-launcher/controller.js:42` is that the
controller's own focus-aircraft subscription does the setActive. That
controller subscription only attaches in the controller's `init()` —
which is called lazily from `loadStatus()` / `renderBody()`. If the user
fires focus-aircraft BEFORE the route-launcher tile has ever rendered,
the controller hasn't init'd and the event is dropped.

Reproduction guess: cold dashboard load, user clicks an aircraft chip in
fleet-optimizer-tile (which emits focus-aircraft per
`fleet-optimizer-tile.js:196`) before the route-launcher tile has
expanded once. The route-launcher will scroll/expand but the picker
stays on whatever was active before.

Verification: live-test in Chrome before fix attempt.

Severity: medium — repeats friction once per session per user.

### F-DASH-506 [INVARIANT-RISK] — recommend-alliance.js docstring claims `openHref`, code doesn't return it

**File:** `modules/world-view/recommend-alliance.js:21-23`

Docstring:
> Returns top-N {id, name, members, reach, feedersAtHub, overlapHubs,
> contestedAt, score, rationale, isMine, openHref}.

Actual return at lines 154-169 omits `openHref`. The recommendations
pane (`views/recommendations-pane.js`) doesn't read `openHref` on the
alliance card; only the member chip's `enterpriseId` triggers
`onPickEnterprise`. So nothing breaks today.

But the docstring suggests an unbuilt or removed feature. Either remove
the claim from the docstring (preferred) or wire `openHref` to
`/app/info/alliances/<id>` if that's a useful surface. Could be a
deferred or a doc bug.

Severity: documentation drift; flag to Agent 8 for HANDOVER.md
consolidation.

### F-DASH-508 [BUG] — `recommend-alliance.isMine` is universally false in production

**File:** `modules/world-view/recommend-alliance.js:30-35, 130-151`
**Locked by:** `audit/tests/dashboard/recommend-alliance.test.js` (smoke surfaced
the bug; test pinned to the buggy behaviour with a follow-on test that documents
the fix path).

`_bucketByAlliance` keys each alliance record by `String(rec.alliance.id)` first
(numeric AS alliance id like "42"), falling back to `"name:" + name` only when
id is absent. `enterprise-scraper` populates `alliance: {id, name}` from the
enterprise detail page, so id is virtually always present.

The "is this MY alliance?" check at lines 130-151 uses two paths:

1. **Primary** (line 130-131, 149): `myAllianceKey = "name:" + myAlliance.name.toLowerCase()`.
   This is compared against the bucket key. Bucket keys for entries with an
   id are like `"42"`, never `"name:..."` — comparison always false.
2. **Fallback** (line 150-151): `slot.id && network.myAlliance.id != null && String(slot.id) === String(network.myAlliance.id)`.
   But `AllianceOverviewScraper` (the only writer of `myAlliance`) produces
   `{allianceName, members, scrapedAt}` — see `alliance-overview-scraper.js:105`
   and the network-builder mirror at `modules/world-view/network-builder.js:160-166`.
   `myAlliance.id` is *always* `undefined` in production, so this fallback
   short-circuits at the `!= null` check.

**Effect:** the `isMine` field on every alliance recommendation card is `false`,
even when the user's own alliance is in the recommendation list. The
recommendations pane uses `isMine` to badge / suppress the user's own alliance,
so the user's own alliance can show up as a "join this!" recommendation —
visibly absurd on the dashboard.

**Fix path (Phase 2 candidate, three options):**
- Cleanest: `network-builder` cross-references the partner cache or
  `enterprise-scraper` cache for the user's own enterprise, looks up the
  matching `alliance.id` by name, and stamps it onto `myAlliance.id`. Then the
  existing fallback at line 150-151 starts working. No new comparison logic.
- Local: make `_allianceKey` always return `"name:" + name.toLowerCase()` and
  ignore id. Simple but throws away id information that may be useful for
  rationale links later.
- Defensive: add a third comparison path that case-normalises name on both
  sides without the `"name:"` prefix.

**Severity:** medium — visible on the dashboard, confusing rather than data
losing. No write path involved.

### F-DASH-507 [OBSERVATION] — wave-pane.js variable name `route` actually receives `hubIata`

**File:** `modules/world-view/views/wave-pane.js:255-259`

```js
window.RouteAssistantWaveOverlay.renderGantt(ganttHost, build, {
    hubIata: network.hub,
    onFlightClick: (flight, route) => {
        if (opts && typeof opts.onFlightClick === "function") {
            try { opts.onFlightClick(flight, route) } catch (_) {}
        }
    }
})
```

`modules/route-assistant/wave-overlay.js:590` actually invokes
`ctx.onFlightClick(f, ctx.hubIata)`. The forwarded callback's second
arg is the hub IATA, not a route object. The world-view-tile
(`modules/central-hub/tiles/world-view-tile.js:312-319`) receives it
correctly as `hubIata`.

Behavior is correct. Variable naming is misleading and could trip up a
future maintainer who adds bugs here. Two-line rename, no behavior change.

Severity: cosmetic only; note for cleanup.

---

## Verification status

- Static `node --check` on territory files: not yet run (Phase 2).
- Live verification in Chrome: BLOCKED on auth wall (port 9227 chrome-aes-5
  on AS login page; not attempting cdp-login per Agent 2's 10:50 report).
- Pure-function smokes under `audit/tests/dashboard/`: 6 files, 46 tests, all
  passing as of 2026-05-01 (deal-metrics, network-builder, recommend-alliance,
  recommend-interline, airport-coords, world-map). Run via
  `node audit/tests/dashboard/run-all.js`.

---

## Phase 1 summary (re-verified 2026-05-01 in fresh session)

**Findings: 8** (6 bugs · 1 question · 1 observation · 1 invariant-risk
counted across categories)

Category breakdown:
- `[BUG]` × 5 — F-DASH-501, 502, 504, 505, 508
- `[INVARIANT-RISK]` × 1 — F-DASH-506
- `[QUESTION]` × 1 — F-DASH-503
- `[OBSERVATION]` × 1 — F-DASH-507

All eight findings re-verified against current on-disk code at the start of
this session — line numbers and stated conditions still hold.

Top 3-5 to fix first (Phase 2 candidates):

1. **F-DASH-508** — `recommend-alliance.isMine` always false in production.
   Most user-visible (own alliance shows up in recommendations).
   Fix in `network-builder.js`: stamp `myAlliance.id` from cross-referenced
   enterprise/partner cache. Already test-locked.
2. **F-DASH-501** — World View cache freshness ignores `snapshot.ts`.
   Targeted ~6-line patch in `world-view-tile.js`. Low risk.
3. **F-DASH-505** — route-launcher focus-aircraft cold-start race.
   Add explicit `RouteLauncher.setActive({aircraftId})` in the tile
   handler so it doesn't depend on the controller's lazy init. Two-line
   patch. Live-verifiable (when auth unblocks).
4. **F-DASH-506** — `openHref` docstring drift. Drop the docstring claim
   (preferred — minimal surface) since no caller reads `openHref`.
5. **F-DASH-502** — Drop dead `_renderRecommendationsPlaceholder` helper.
   Pure cleanup; one-block deletion.

F-DASH-503 (storage scan) and F-DASH-504 (MAX_PAGES) are noted but not
in the top batch — perf and operational notes, no user-visible breakage.
F-DASH-507 (variable rename) is cosmetic; bundle with F-DASH-501 if I'm
in the world-view tile anyway.

## Open questions for the user

- Is "World View cache should track snapshot.ts" something you want
  fixed now, or do you want the 1h TTL to govern (current behavior)?
- For F-DASH-505, do you have a fleet-optimizer click → route-launcher
  shift workflow you exercise? If so, that's the reproduction I'd lean
  on. If not, this is a synthetic concern — can be deferred.

## Out-of-territory findings flagged

None this pass — all findings are in my listed scope.

## Handoff notes

Phase 1 audit complete. Awaiting user gate on Phase 2.
