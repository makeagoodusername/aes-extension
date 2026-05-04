# Manifest request — Route Builder modal + tile

**Files added (this session):**
- `modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js` (new, ~530 LoC)
- `modules/central-hub/tiles/route-builder-tile.js` (new, ~95 LoC)

**Manifest entries needed.** I cannot write `manifest.json` directly (root-owned + Agent 1 territory per CLAUDE.md). Please add the following entries to the listed content_script blocks.

---

## Block 5 — `https://*.airlinesim.aero/app/enterprise/dashboard*`

Insert AFTER `modules/aircraft-flight-plan/active-draft-store.js` (currently index 87) and BEFORE the route-launcher modules:

```
"modules/aircraft-flight-plan/auto-scheduler/route-builder-planner.js",
"modules/aircraft-flight-plan/auto-scheduler/auto-apply-log.js",
"modules/aircraft-flight-plan/auto-scheduler/apply-batch.js",
"modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js",
```

Insert AFTER `modules/central-hub/tiles/route-launcher-tile.js` (currently index 99):

```
"modules/central-hub/tiles/route-builder-tile.js",
```

**Why these dependencies?** The modal uses:
- `AesAfpRouteBuilderPlanner.recommend` (planner)
- `AesAfpAutoApplyBatch.start` (apply pipeline)
- `AesAfpAutoApplyLog.add` (transitive — apply-batch logs per-leg outcomes)
- `AesAfpActiveDraftStore.setEdit` (already in block 5)
- `FlightsFromStore.loadAirport` (already in block 5)
- `AesFleetRoster.loadCurrent` (already in block 5)

The tile (`route-builder-tile.js`) only needs the modal — it's a thin shell.

---

## Block 20 — `https://*.airlinesim.aero/app/fleets/aircraft/*/0*`

Insert AFTER `modules/aircraft-flight-plan/auto-scheduler/preview-panel.js` (currently index 31):

```
"modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js",
```

Block 20 already has the planner + apply-batch + auto-apply-log; only the modal itself is new. This makes the modal also reachable from the AFP page (e.g. via `window.AesAfpRouteBuilderModal.open()` in DevTools, or a future tile button).

---

## Validation

After the manifest update, on `/app/enterprise/dashboard*`:

```js
> typeof window.AesAfpRouteBuilderModal
"object"
> await window.AesAfpRouteBuilderModal.open({server: AES.getServerName()})
// modal opens; pick airports, edit times, apply
```

The Central Hub renders a "Route Builder" tile in the `fleet` section (priority 17) with an "Open route builder…" button.

## Tests in this session

- `audit-jihwan/tests/route-builder-modal-controller.test.js` — pure-function smoke (parseIataList, materialiseLegs, buildApplyPayload). Run twice clean.
- `audit-jihwan/tests/route-builder-workbench-e2e.test.js` — the planner/draft/materialise contract the modal also relies on. 11/11 green twice.
- All 14 prior `audit/tests/afp/*.test.js` still pass.
