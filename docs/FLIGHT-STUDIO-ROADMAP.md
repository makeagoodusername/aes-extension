# Flight Studio Expansion — Roadmap (Slices F1 → F2 → F3)

Branch: `slice/e-integration` (continuing the "E slice" Flight Studio work).

The current Flight Studio is a single-leg composer that pushes one leg into the AS form, with auto-build / apply / continue helpers and a candidate table mounted directly below it. This roadmap lifts it from "single-leg form" to a richer integration surface that pulls demand, competitor, profit, template, and station context onto the same canvas — without breaking the dry-run / Apply contract that already ships.

Slices land in order, each shippable on its own. F1 is the smallest; F3 is the biggest and is split internally into 3a (tray) and 3b (drawer) so the multi-leg work doesn't block the station drawer.

---

## Slice F1 — Decision-support sidebar

**User value:** When FROM + TO are filled, the user sees the route distance, pax/cargo demand bars, top-3 current operators, and a static profit estimate — all without leaving Flight Studio. Answers "is this a good leg?" inline.

**Files:**
- `manifest.json` — add four entries to the AFP content-script block (`/app/fleets/aircraft/*/0*`) immediately before `flight-studio/panel.js`: `route-assistant/settings-store.js`, `route-assistant/demand-store.js`, `route-assistant/profit-estimator.js`, `flightsfrom/data-store.js`. None of these are currently loaded on AFP pages; F1 cannot run without them.
- `modules/aircraft-flight-plan/flight-studio/panel.js` — add `_buildDecisionSidebar()` plus `_renderSidebarFor(spec)`. Sidebar is appended as a sibling of `[data-aes-studio-body]` inside the `.aes-afp-studio` root, both wrapped in a flex container that lays them out side-by-side at ≥900 px panel width and stacks vertically below.
- (no new file — kept as a panel-internal helper.)

**Data sources (all already shipped, shape verified):**
- `RouteAssistantDemandStore.get(destIata)` → `{iata, name, paxScore, cargoScore, scrapedAt, ...}`. **No hourly data exists** — sidebar uses paxScore + cargoScore as 0–10 bars. Records older than 30 days return null; sidebar shows "No demand data" hint.
- `FlightsFromStore.loadAirport(originIata)` → `{routes: [{destIata, destName, weeklyFlights, distanceKm, airlines: [{name, code, frequency}], ...}], ...}`. Pick `routes.find(r => r.destIata === to)`; top-3 operators from `.airlines` sorted by `frequency` desc. `airlines` is optional (filled by the contractual-partners scrape) — fall back to "Carrier list not yet scanned" when undefined.
- `RouteAssistantProfitEstimator.estimate({distanceKm, spec, paxScore, cargoScore, economics, useDistanceFuel, fuelPriceASc, ...})` → `{fit, blockHours, profitPerFlight, profitPerWeek, breakdown, specOk, isCargoOnly}`. **The estimator does not consume `pricePct` or `service`** — F1's profit estimate is static at the configured economics; PRICE changes do not refresh the sidebar. Reference call site: `route-assistant/aggregator.js:~1700`.
- `RouteAssistantSettings.load()` → provides the `economics` block (loadFactor, yieldPerKm, fuelCostPerHour, falloffYieldMultiplier, etc.) the estimator requires.
- `window.AesAfpSpecResolver.last` → `{seats, range, speed, cargoCapacity, ...}` aircraft spec; reused for the estimator's `spec` input. Already populated by Slice B; bail to "Profit estimate unavailable (resolving spec)" when null.

**New UI elements:**
- **Header**: `<from> → <to> · <distanceKm> km · <blockHours> h block`.
- **Demand**: two stacked rows (Pax, Cargo). Each = label · 10-cell bar (filled cells = score) · numeric `7/10`. Stale badge when `Date.now() - scrapedAt > 7 * 86_400_000`.
- **Operators**: top 3 by frequency: `<code> <freq>×/wk`. Hint line if `airlines` undefined.
- **Profit**: `$<perFlight>/flight · $<perWeek>/week` formatted via `Intl.NumberFormat`; small grey `fit: optimal | falloff | oor` badge.

**Reactivity:** subscribe to `studio:draft-changed` (already debounced 300 ms upstream). Sidebar dedupes via a `_lastSidebarKey = "<from>:<to>"` so PRICE/SERVICE/FLIGHT# edits don't trigger refetches. An `AbortController` cancels in-flight fetches when the OD pair changes mid-request.

**Edge cases / fallback (each section fails soft — others still render):**
- Demand record missing or stale → demand row shows "No demand data" with a hint to run the route-assistant demand scan.
- FlightsFrom record empty for the hub → header distance is `—`, operators row says "Hub not yet scanned" with a pointer to ↻ Update / Scan flightsfrom.com.
- `airlines` array undefined → operators row says "Carrier list not yet scanned".
- `AesAfpSpecResolver.last` null → profit section shows "Profit estimate unavailable (resolving spec)".
- ProfitEstimator throws → log to console, render a dim "Profit estimate unavailable" line; never blow up the form.

**Verification (manual):**
1. Reload extension, open AFP page with Plan-from = JFK.
2. Fill Flight Studio FROM=JFK, TO=LHR → sidebar populates with distance, demand bars, operators, profit estimate within ~250 ms.
3. Change TO=MIA → sidebar refreshes to MIA data.
4. Change PRICE to 120 → sidebar does **not** refresh (correct; profit isn't PRICE-reactive — confirms reactivity scope).
5. Clear TO → sidebar collapses to placeholder ("Pick a destination to see decision context").
6. Open a hub with no demand cache → demand row shows "No demand data" hint while operators + profit still render against the FlightsFrom data.
7. `git status` shows exactly `manifest.json` and `flight-studio/panel.js` modified.

**Risks:**
- `airlines` array often undefined until the contractual-partners scrape has run — guard for it; render an actionable hint rather than a crash.
- `AesAfpSpecResolver.last` null on first mount; sidebar mirrors the studio's existing "wait for spec" pattern.
- Stale demand records (>7 days but <30) — render a stale badge; do not auto-trigger a fresh scan in F1 (deferred to F1.1 if requested).

---

## Slice F2 — Template / service profiles

**User value:** Save Flight Studio configurations ("Morning shuttle", "Long-haul evening", "Cargo overnight") as named templates and load them with one click. Templates parameterize `{pricePct, service, depTimeLocal, turnMin, notes}` and optionally a FROM hub. Cuts the repetitive form-filling for users who run consistent patterns.

**Files (new + modified):**
- New: `modules/aircraft-flight-plan/flight-studio/templates-store.js` — chrome.storage.local helper. Key `flightStudio:templates:<server>` → `Template[]` where `Template = {id, name, pricePct, service, depTimeLocal, turnMin, fromIata?, notes?, createdAt, updatedAt}`. APIs: `loadAll(server)`, `save(server, tmpl)`, `remove(server, id)`, `bulkLoad()` for cross-server export.
- Modified: `modules/aircraft-flight-plan/flight-studio/panel.js` — new `_buildTemplatesRow()` rendered above the form. Compact dropdown of saved templates + "Save as…" + "Manage" actions.
- Modified: `modules/aircraft-flight-plan/flight-studio/leg-spec.js` — add `applyTemplate(spec, tmpl)` pure helper that produces a new spec with the template's fields overlaid, preserving `legs[].origin/destination/depTimeLocal` (template never overwrites the OD pair, only the parametric fields).
- Modified: `manifest.json` — register `templates-store.js` in the AFP content-script block.

**Reactivity:** templates persist independently of any aircraft / hub; loading is per-server only. No bus events needed beyond a one-shot re-render of the templates row when a save/delete completes.

**UX details:**
- "Save as template" captures current spec → modal with name input → persists.
- Apply template → spec merges template fields into current leg(s) → existing `_pushAllToAsForm()` already mirrors to the AS form.
- "Manage" opens a small modal (mirroring `locked-confirm-modal.js` styling) listing all templates with rename / delete.
- Server-local templates only — no cross-server export in F2.

**Verification (manual):**
1. Set PRICE=110, SERVICE=Premium, TURN=45, click Save as template, name "Morning shuttle".
2. Reset form, click template chip "Morning shuttle" → PRICE/SERVICE/TURN restored; FROM/TO untouched.
3. Reload page — template still appears in the dropdown.
4. Open Manage → rename → delete → verify state survives reload.

**Risks:** the template field set may grow as F3 lands (multi-leg templates). The store carries `schemaVersion: 1` from day one so F3 can extend without migration drama.

---

## Slice F3 — Multi-leg tray + station drawer

Two independent sub-slices that share the F3 banner because they're conceptually "Flight Studio absorbs the related branches":

### F3a — Multi-leg tray (replaces single-leg form)

**User value:** Compose a sequence of legs in one canvas. Drag candidates from the table into the tray; reorder by drag; batch Preview / Apply runs the existing apply pipeline on the whole sequence.

**Files:**
- Modified: `modules/aircraft-flight-plan/flight-studio/panel.js` — replace `_buildLegRow()` with a stacked tray rendering `_spec.legs.map(_buildLegRow)`. Add reorder handles + per-leg remove. New "Add leg" button that appends a fresh `LegSpec` with the previous leg's destination as the next FROM (mirrors the Continue → flow but adds the new leg into the same tray instead of replacing).
- Modified: `modules/aircraft-flight-plan/flight-studio/leg-spec.js` — already supports `legs: LegSpec[]`; extend with `reorderLeg(spec, fromIdx, toIdx)` and `removeLeg(spec, idx)` pure helpers.
- Modified: `modules/aircraft-flight-plan/route-candidates.js` — make candidate rows draggable (`draggable=true`, `dragstart` payload `{destIata, distanceKm, paxScore, ...}`). No layout change to the table.
- Modified: `auto-scheduler/preview-panel.js` — already accepts `(externalLegs, externalOpts)` from the F0 work; the tray's batch Apply just hands the legs array to it. No API change.

**UX:**
- Drag candidate row → drops as a new leg in the tray with `to` pre-filled, `from` set to the prior leg's `to` (or hub for first leg), `depTimeLocal` set to prior leg's `depTimeLocal + flightTime + turnMin`.
- Per-leg ✕ remove. Drag handle on the left of each leg row.
- Single Preview / Apply / Automate row at the bottom of the tray applies to the whole sequence.
- Continue → coexists with the tray: it appends a new leg at the tail instead of replacing the spec, so the existing single-leg muscle memory still works.

**Verification (manual):** drag JAC, MLA, OLB candidates in turn → tray shows three legs JFK→JAC, JAC→MLA, MLA→OLB → Apply opens the existing confirm modal with all three.

**Risks:** tray-mode batch Apply skips per-leg dry-run-push (AS only has one form on screen) and hands the legs array straight to apply-batch.

### F3b — Station drawer (replaces "Open Stations…" behavior)

**User value:** Click a candidate row (or the new "ⓘ Detail" button on the row) → side drawer slides in with full station detail: schedule conflicts at this hub, hub fees, demand histogram, competitor list, distance, runway constraints.

**Files:**
- New: `modules/aircraft-flight-plan/flight-studio/station-drawer.js` — owns the drawer DOM, open/close API, content rendering.
- Modified: `modules/aircraft-flight-plan/route-candidates.js` — row click handler dispatches to `AesAfpStationDrawer.open(destIata)` instead of (or in addition to) the existing fill-form path.
- Modified: `modules/aircraft-flight-plan/host.js` — change "Open stations…" button to open the drawer rooted on the hub itself instead of the bulk-modal (or keep the bulk-modal as the caret action; primary becomes drawer).
- Modified: `manifest.json` — register `station-drawer.js` in the AFP content-script block.

**Data sources:**
- `RouteAssistantDemandStore.get(destIata)` — demand histogram
- `FlightsFromStore.loadAirport(destIata)` — incoming route data, weekly traffic, operator list
- `AesAfpScheduleStore.load(server, aircraftId)` — conflict detection (do my legs collide with this destination?)
- (later) hub-fee + runway data — surface as "TBD" placeholders in F3b, fill in F3c+ as the data lands.

**Verification:** open AFP page, click a candidate row → drawer slides in showing demand chart + operators + "no conflicts" or specific leg conflicts.

**Risks:** drawer takes screen real estate. Default to right-side overlay over the candidates table; closeable. Don't change the AFP page layout.

---

## Cross-cutting

- **HANDOVER.md update.** Add a "Flight Studio Expansion" section to the AFP roadmap once F1 lands; bullet-mark each F-slice's status.
- **Manifest.** F1 adds four AFP entries (settings-store, demand-store, profit-estimator, flightsfrom data-store). F2 adds one (templates-store). F3b adds one (station-drawer). F3a is panel.js + leg-spec.js + route-candidates.js only — no manifest change.
- **Read-only invariant.** F1 is pure read. F2 writes to `chrome.storage.local` under a new key (additive — preserves the panel-CTA write gateway). F3a writes nothing extra (apply-batch already gated). F3b is read-only.
- **Bus events.** F1 reuses `studio:draft-changed` only. F2 adds `studio:templates-changed` (informational). F3a re-uses `studio:draft-changed`. F3b adds `studio:station-drawer-opened` / `studio:station-drawer-closed`.

## Critical files (full path reference)

- `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/flight-studio/panel.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/flight-studio/leg-spec.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/route-candidates.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/host.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/auto-scheduler/preview-panel.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/route-assistant/demand-store.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/route-assistant/profit-estimator.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/route-assistant/contractual-partners-scraper.js`
- `/Users/jihwan/Downloads/AES.v0.6.9/modules/flightsfrom/data-store.js`
- (new) `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/flight-studio/templates-store.js` (F2)
- (new) `/Users/jihwan/Downloads/AES.v0.6.9/modules/aircraft-flight-plan/flight-studio/station-drawer.js` (F3b)
