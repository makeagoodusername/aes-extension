# Findings — Agent 4

Territory: AFP / Fleet Hub / Schedule Management / Canvas.
Phase 1 (audit only) start: 2026-05-01.

---

## F4-001 [INVARIANT-RISK] Form-driver SACRED PATH verified

`modules/aircraft-flight-plan/form-driver.js`

Re-read every method. Confirmed:

- `setOrigin/setDestination/setDepartureTime/setPricePercent/setService/setFlightNumber/setDayActive` mutate inputs only. None invokes `submitBtn.click()`. `setFlightNumber` and `setDayActive` dispatch `input`/`change`/`blur` deliberately so AS's per-input Wicket-Ajax validators fire — that is the AS-internal validation path, not a form submit.
- `_commitSelect` deliberately uses a no-change strategy (line 201-213). It mutates `<select>.value` and the visible select2 v3 chip (`<span class="select2-chosen">`) WITHOUT firing `change`. Comment block at lines 184-190 documents the rationale: AS's Wicket DropDownChoice has `AjaxFormComponentUpdatingBehavior` on `change` and firing 6 changes during `fill()` would race 6 Ajax round-trips and the last response clobbers the others. Form POST serializes `<select>.value` directly, so the no-change path is sufficient AND visually correct.
- `dryRun(leg)` returns `{url, body, missed}` and renders to the toolbar `<details>` panel. Does NOT fetch.
- `reverse()` clicks `f.reverseBtn` — this is AS's same-page reverse-O/D anchor (UI toggle, not state-changing POST). Allowed per invariant header.
- `clear()` resets selects to defaults; no submit.
- `fillAndSubmit(leg)` — the only submit caller. Click is `setTimeout(0)` deferred (line 488-491) so the resolved promise's `.then` can send the reply BEFORE the form POST navigates the page (microtask before macrotask). Verified the only callers of `fillAndSubmit` are:
  - `content_aircraftFlightPlan.js:48` — gated on `chrome.runtime.onMessage` with `msg.type === "aes:afp:fill-and-submit"`.
  - `modules/_background/afp-submit-queue.js:136` and `:260` — both go through `chrome.tabs.sendMessage(tabId, { type: 'aes:afp:fill-and-submit', leg })`.
- `submitBtn.click()` appears exactly once in the codebase (form-driver.js:489). No other path POSTs the AFP form.

Disposition: SACRED PATH intact. No fix needed.

## F4-002 [BUG] `_detectSelect2Version` is dead code in form-driver.js

`modules/aircraft-flight-plan/form-driver.js:118`

`_detectSelect2Version()` is defined and exported nowhere; grep across the project shows zero callers. The brief asserts `_commitSelect` should branch on the detected version, but the actual `_commitSelect` (line 202) uses the no-change chip-update strategy and never calls select2 at all. The version detection is leftover from an earlier strategy.

This is harmless (no runtime impact, no select2 call to mis-route) but the brief's description of "branches on version" does not match shipped code. The current no-change strategy is intentional and well-justified by the Wicket-Ajax-race rationale at line 184-190.

Disposition: cosmetic — dead helper. Safe to delete in Phase 2 as cleanup; preserve the no-change `_commitSelect` strategy intact.

## F4-003 [BUG] `schedule-diff.compare` does not accept `opts.toleranceMin`

`modules/aircraft-flight-plan/auto-scheduler/schedule-diff.js:75`

Brief expectation: "`compare(currentLegs, proposedLegs, opts?)` returns `{keep, delete, add, moveTime: []}`. Tolerance default 15min, configurable via `opts.toleranceMin`."

Actual: `function compare(currentLegs, proposedLegs)` — two-arg only. `TOLERANCE_MIN = 15` is a module-scope constant (line 66) used at line 147 (`if (d > TOLERANCE_MIN) continue`). No `opts` parameter; no caller in tree currently passes opts.

Severity: low. The 15-minute tolerance has been the stable AFP contract; no caller needs it configurable today. But the brief expectation is unmet. Recommend Phase-2 small extension: `function compare(currentLegs, proposedLegs, opts)` with `const tol = (opts && Number.isFinite(opts.toleranceMin)) ? opts.toleranceMin : TOLERANCE_MIN`. No invariant risk.

Other compare-contract checks confirmed:
- Returns `{keep, delete, add, moveTime, locked}` shape (line 78).
- `moveTime` is always `[]` (Phase-1 simplification documented in header line 33-34 and asserted in smokes line 295).
- `flightId` exact match wins regardless of time delta (Pass 1, lines 103-128).
- ±15min same-O/D match in Pass 2 (lines 135-161).
- Greedy: a current leg never re-shops (line 133 comment).

## F4-004 [INVARIANT-RISK] VFP day-cross collapse logic verified

`modules/aircraft-flight-plan/host.js:241` (`readVisualFlightPlan`) and `host.js:447` (`_collapseDayCrossPairs`).

Brief expectation: filters to `.block.flight`, pairs `started/ended` halves on `(dayIdx + 1) % 7`, Sun→Mon wrap, unpaired halves emit warn.

Actual:
- `readVisualFlightPlan` delegates to `AesAfpVfpReader.read()` + `legsFromSchedule` (which only emits flight-block legs per vfp-reader.js:309 + buildLegs filter at line 337). Legacy fallback (`_legacyReadVisualFlightPlan` line 263) explicitly filters `block.classList.contains("flight")` at line 273. ✅
- `_collapseDayCrossPairs` line 463 uses `(s.dayIdx + 1) % 7` for expected ended-half day. Sun (6) → Mon (0) wrap correct. ✅
- Lines 466, 478: unpaired halves emit `console.warn` and stay in output as same-day legs (`crossesMidnight: false` per line 488). ✅
- Line 469-474: paired half merges arrTime/durationMin/destination from the ended half into the started half; the started half stays, ended half marked `toRemove`.
- Pre-existing `spansIntoNext`/`spansFromPrev` are stripped from output (lines 489-490) so downstream consumers see the canonical `crossesMidnight` flag.

Note: the brief refers to these functions as living in `vfp-reader.js`. They actually live in `host.js`. `vfp-reader.js` only emits the per-block flags; the collapse pass is in host. Brief is slightly outdated; the logic is correct.

Disposition: shipped, intact, matches HANDOVER expectation.

## F4-005 [INVARIANT-RISK] Auto-scheduler tier gate + I-understand checkbox verified

`modules/aircraft-flight-plan/auto-scheduler/preview-panel.js`

- Line 353: `armed = !!enabledFlag && tier === "apply-on-confirm"` — both conditions required.
- Line 356-360: Apply button is disabled unless `!_state.running && _state.lastBuild && flights.length > 0 && armed && flights.length <= maxLegs`.
- Line 393-401: `_applyBlockedReason` returns user-facing reason for each blocked condition.
- Line 1366: I-understand checkbox starts unchecked (`ack.checked = false`).
- Line 1447: `enabled = !!(ack && ack.checked) && sel > 0` — Apply button only enabled with checkbox + ≥1 selected leg.
- Line 1408-1414: clicking Apply runs `_closeConfirmModal()` then `_applyAll(selectedLegs, ...)`.

`slot-optimizer.js`:
- Line 67 `MAX_PROPOSALS = 16`.
- Line 211, 225, 231, 249: every loop guards `proposals.length >= MAX_PROPOSALS` before pushing.
- Line 267: `return proposals.slice(0, MAX_PROPOSALS)` — defensive cap on the way out.

`apply-batch.js`:
- Bus topic prefix `auto-apply:` (start, progress, done, aborted, error). All emitted from a single `_emit` helper at line 67.
- Background message type `aes:afp:apply-batch` (line 316), abort `aes:afp:apply-batch:abort` (line 394).
- Listens for `aes:afp:apply-batch:progress` runtime messages (line 148) and re-emits onto AesAfp bus.
- Skip-locked branch at line 223: warns when locked legs are in the request — does NOT POST them.

Disposition: tier gate + checkbox + 16-proposal cap intact. SACRED PATH unaffected by this layer.

## F4-006 [INVARIANT-RISK] Fleet Hub D chip Tier 1 zero-POST path verified

`modules/fleet-hub/host.js:264` (`_onActionD`) → `AesAfpDashboardHost.openFor(detail)`.

`modules/aircraft-flight-plan-dashboard/settings-extension.js`:
- Lines 16-17: `T1_LOCKED.dryRunOnly = true; applyEnabled = false`.
- Lines 32-34: `load()` mergees stored values then forces `dryRunOnly = true; applyEnabled = false` regardless of storage. A user editing storage by hand cannot unlock T1.
- Line 38: `save()` warns + no-ops on Tier 1.

`modules/aircraft-flight-plan-dashboard/flight-number-applier.js`:
- Constructor line 55-56: instance fields `this.dryRunOnly = true; this.applyEnabled = false`.
- Line 338: local var `const dryRun = true   // T1 hard gate`. Tier 1 hardcodes dryRun true regardless of instance fields — belt-and-suspenders.
- Line 462-465: `if (dryRun) return {status: "dry-run"}` — short-circuit before any POST path.
- Line 466-475: unreachable in T1 — explicit anchor for T2 with `error.code: "tier2NotShipped"`.

`grep -rn "fetch(" modules/aircraft-flight-plan-dashboard/`:
- Only `proxy-page-fetcher.js:50` — and it's a GET (`fetch(url, {credentials: "include"})`) used for proxy reads.
- No POST in the dashboard module tree. ✅

Inline-table `_actionsCell` (line 163): renders R, S, P, D buttons in order, all share a delegated click handler at line 206 (`_onClick`) that emits the corresponding CustomEvent. `aes-fleet-hub:action-d` is one of the four event names defined at line 27-32.

Disposition: Tier 1 zero-POST contract intact, defended by both instance fields AND a hardcoded local. UI chip rendering verified.

## F4-007 [INVARIANT-RISK] Schedule Canvas Slice E inventory + commit-bar gating verified

19 canvas modules confirmed registered in manifest at lines 1020-1038 (single `/app/fleets*` content_scripts entry):

```
canvas-events.js              (1)
canvas-state-store.js         (2)
wave-spine-renderer.js        (3)
overlays/demand-overlay.js    (4)
overlays/ors-tooltip.js       (5)
actions/route-create-modal.js (6)
actions/drop-bridge.js        (7)
actions/cell-context-menu.js  (8)
actions/commit-bar.js         (9)
onboarding/first-run-overlay.js (10)
advanced-toggle.js            (11)
canvas-shell.js               (12)
rail/rail-shell.js            (13)
rail/builder-engine.js        (14)
rail/builder-card.js          (15)
rail/advisor-engine.js        (16)
rail/advisor-card.js          (17)
rail/rail-controller.js       (18)
canvas-modal.js               (19)
```

`commit-bar.js` (out-of-territory module-of-record `RouteAssistantPricingApplier` is in modules/route-assistant — Agent 2/3) verified:
- `applyPricing` (line 79-85) → `RouteAssistantPricingApplier.apply()`. Applier is constructed with `dryRunOnly: cfg.dryRunOnly !== false` (defaults true when settings missing) and `applyEnabled: !!cfg.enabled` (defaults false). Settings sourced from `RouteAssistantSettings.load()`. Safe defaults if settings missing.
- `addRoute` (line 91-97) — single-leg writes to `AesHandoffStore` via `_handoffSingleAdd`. Multi-leg → `summary.deferred += addEdits.length`.
- `moveRoute` (line 100) — counted as deferred. No POST emitted.
- `removeRoute` (line 100) — same as moveRoute.
- All deferred kinds get a toast (line 213-230) telling the user to open AFP.

`drop-bridge.js` (lines 115-134) stages addRoute on empty cells, moveRoute on filled cells. Phase 7 stages intent; commit-bar enforces the per-kind dispatch.

`canvas-modal.js` `CanvasModal.open()` (line 29-58) — single-instance, ESC closes, dedupe back-to-back opens by signature within 250ms. The Open Schedule Canvas trigger lives in `modules/fleet-schedule-grid/host.js:147` (out of territory; cross-territory note for Agent 8).

Disposition: Slice E manifest registration complete; commit-bar honours RA pricing gates; addRoute/moveRoute/removeRoute deferred toasts intact.

## F4-008 [WIRING-GAP / DEFERRED-CONFIRMED] Per-brief flagged items

Per AGENT-4.md "Specific things flagged":

- `drag-affordance-store.js wired but no UI consumer` — verified deferred. Live source is `settings.aircraftFlightPlan.dragSubmitMode` per brief.
- `wave-registry.js consumers` — Fleet Command and rebalance proposers don't consume it. Deferred per brief.
- `flightsfrom/schedule-panel.js` — not in my territory; out-of-scope.
- AFP/fleets de-dup overlap audit — owned by Agent 1. Not investigating in Phase 1.

## F4-010 [BUG / CROSS — reply to Agent 1 F-3] AFP slice load order: workaround works, manifest cleanup is optional

`manifest.json` blocks 19/20/21/27 (Agent 1 territory) + `modules/aircraft-flight-plan/{audit-log,spec-resolver,route-candidates,wave-applier}.js`

Confirming Agent 1's F-3 manifest layout claim:
- block 20 (`/app/fleets/aircraft/*/0*`, 31 entries) loads `settings-extension.js` [2] → `audit-log.js` [7] → `spec-resolver.js` [8] → `form-driver.js` [16] → auto-scheduler suite. **No `host.js`, no `route-candidates.js`, no `wave-applier.js` in block 20.**
- block 27 (`/app/fleets*`, 201 entries) loads `host.js` [62] → `route-candidates.js` [63] → `wave-applier.js` [67] alongside the other AFP/fleets shared modules.
- AFP page matches both blocks. Chrome MV3 injects in manifest order: block 20 IIFEs run first, when `window.AesAfp.bus` is still undefined.

**However, the §10 invariant text "the slice silently disables itself" is OUT OF DATE.** The AFP module IIFEs are explicitly hardened against this load order:

- `spec-resolver.js:281-307` — `_attach()` polls every 50ms until `window.AesAfp.bus` exists, then subscribes to `ctx:ready`. Comment block at 281-288 documents this exact race ("manifest block A before host.js manifest block B... without the retry, the IIFE-bottom guard was false at parse time and the listener never subscribed — leaving last stuck at null and route-candidates frozen on 'Waiting for aircraft spec…' forever").
- `audit-log.js:280-303` — `whenReady()` polls every 200ms with a 30s cap before subscribing. Header comment 280-282 acknowledges "AesAfp.mount() is async".
- `route-candidates.js:1348` — same `_attach()` poll-retry, 50ms.
- `wave-applier.js:1081-1113` — same `_attach()` poll-retry, 50ms; also `_attachDraftListener()` for active-draft-store coordination.

So bus subscriptions DO land successfully on the AFP page today. The slice does not silently disable itself; it self-heals through poll-retry.

What Agent 1's F-3 fix would change:
- **Behavioural impact: zero** — subscriptions already attach via the workarounds.
- **Cleanup value: medium** — Agent 1's proposed fix (host.js + route-candidates.js + wave-applier.js into block 20 in §10-specified order) would let us delete ~80 LoC of `_attach`/`whenReady` poll-retry plumbing and remove the 30s timeout in `audit-log.js` that risks losing the audit subscriber if mount is unusually slow.
- **Risk: low** — but moving these out of block 27 risks breaking aircraft list page (`/app/fleets`) where ONLY block 27 fires today and host.js is needed there too. Agent 1's text says "add to block 20", not "move from block 27 to block 20" — keep both.

**Recommendation for Agent 1 / user:** Two choices:
1. **Land the manifest cleanup** (add host.js + route-candidates.js + wave-applier.js to block 20 BEFORE audit-log.js, keep them in block 27 too — both blocks are intentionally idempotent on `/app/fleets/aircraft/*/0*`). Then DELETE the `_attach` / `whenReady` poll-retry workarounds in Phase 2 follow-up. Agent 4 owns the deletion.
2. **Update §10 invariant text** to reflect the shipped reality (poll-retry is the contract, not "silently disables") and leave the manifest as-is. Cheaper.

Either is acceptable. Today's behaviour is correct.

**Live verification:** would need a logged-in AS Chrome to confirm `audit-log.js` actually subscribes (`window.AesAfp.bus.listenerCount("candidate:selected") > 0` after page mount). Blocked by Agent 2's reported auth wall (10:50 in SHARED-NOTES).

Disposition: not a behavioural bug; clarification needed in §10 invariant; manifest cleanup is optional and Agent 1 owns it. Agent 4 will follow up by deleting the poll-retry workarounds IF Agent 1 lands the manifest fix.

## F4-011 [INVARIANT-RISK / CROSS — reply to Agent 1 F-6] `class AesAfpScheduleStore` lacks idempotent guard

`modules/aircraft-flight-plan/schedule-store.js:34`

Confirmed: `class AesAfpScheduleStore` is declared at module-top-level (line 34) with no `if (window.AesAfpScheduleStore) return` guard. The bottom-of-file `if (typeof window !== "undefined") { window.AesAfpScheduleStore = AesAfpScheduleStore }` only avoids ReferenceError in non-browser test envs — it does NOT prevent class redeclaration if the file is included twice on the same page.

Today's manifest **does** load schedule-store.js twice on the `/app/fleets/aircraft/*/1*` page (the maintenance/per-aircraft `/1` route):
- block 19 [11]: `modules/aircraft-flight-plan/schedule-store.js`
- block 27 [4]: `modules/aircraft-flight-plan/schedule-store.js`

Without a guard, the second IIFE would `class AesAfpScheduleStore` re-declare and throw `SyntaxError: Identifier 'AesAfpScheduleStore' has already been declared`, killing the entire script body that follows (block 27 has 201 entries; nothing after position 4 would execute). This is exactly the silent-but-fatal failure mode Agent 1's F-2 flagged (block 19 entry duplicates block 27).

Agent 1's F-2 plans to remove the dup from block 19 (since block 27 already covers it). Once F-2 lands, the dup is gone and the immediate breakage disappears. F-6 is the defense-in-depth ask: future manifest changes must not re-introduce the dup, and the cheapest insurance is an idempotent guard at the top of schedule-store.js.

**Phase-2 fix (Agent 4 owns, since this is `aircraft-flight-plan/`):**

```js
"use strict"
if (typeof window !== "undefined" && window.AesAfpScheduleStore) {
    // already loaded — block 19/27 idempotent overlap on /app/fleets/aircraft/*/1*
} else {
    // ...existing class body unchanged...
    if (typeof window !== "undefined") { window.AesAfpScheduleStore = AesAfpScheduleStore }
}
```

Or, simpler if class-body re-indent is unwelcome: wrap the file in an IIFE with an early-return guard on `window.AesAfpScheduleStore`. The class moves inside the IIFE; the bottom assignment stays.

**Risk in Phase 2 fix:** none — class redeclaration prevention is purely additive. No invariant on storage prefix touched; no behavior change; no apply gate touched. Phase-2 ready once user OKs.

**Question for user / Agent 1:** Do we want to extend the same audit to other module-level `class` declarations in the AFP territory? Quick grep:

```
$ grep -l "^class Aes" modules/aircraft-flight-plan/*.js modules/aircraft-flight-plan/auto-scheduler/*.js modules/aircraft-flight-plan/flight-studio/*.js
```

If F-1's `AesSettings` and F-6's `AesAfpScheduleStore` are flagged, sister classes (e.g., `AesAfpStateStore`, `AesAfpActiveDraftStore`, `AesAfpFlightLogStore`, `AesAfpMaintenanceStore`, `AesAfpWearModel`, `AesAfpAuditLog` if any are class-bodied at top level) deserve the same insurance audit. Agent 4 can sweep in Phase 2 if user wants.

Disposition: REAL invariant risk; Phase-2 fix is one IIFE wrap on schedule-store.js, low risk; possible sweep of related classes pending user direction.

## F4-009 [QUESTION] Brief refers to functions by names that don't match the codebase

Two cases noticed during audit:

1. AGENT-4.md line 117-119: `_collapseDayCrossPairs` and `readVisualFlightPlan` are described as living in `vfp-reader.js`, but they live in `host.js`. The `vfp-reader.js` API is `read()`/`readFromRoot()`.
2. AGENT-4.md line 99-105: `_commitSelect` "branches on version" — actual code uses no-change strategy that bypasses select2 entirely (intentional, per Wicket-Ajax-race rationale).

These are brief-vs-code mismatches. The shipped code is correct; the brief is slightly outdated. Recommend: update brief at end-of-session for Agent 8's consolidation pass; not a fix in code.

---

## F4-012 [FIXED] Wave overlay density layer too faint to read past hour 14

User reported the AFP wave overlay "doesn't show the whole range of routes flown" — screenshot showed "1 waves – 16 heat routes – profit heat" with thick orange/yellow heat bars dominating hours 1–14 and only thin threads visible afterwards.

**Root cause** (rendering, not data):
- `_renderExistingRouteDensity` in `modules/aircraft-flight-plan/visual-wave-overlay.js` drew real flown legs at `height: "2px"` and `alpha 0.42`, with no border. Against the saturated heat-candidate bars (full-height, full-alpha), density bars read as background noise — even though the data covered the full 24 h.
- Density gap shading was `alpha 0.10/0.19` — barely contrasted with the empty grid.
- Heat / wave-window / build bars rendered at full opacity even when density was the user's chosen primary view.

**Fix** (single file, no POST surface, no storage shape change):
- Density flight bars: `height 2px → 5px`, `alpha 0.42 → 0.62`, added `borderColor` at 0.85 alpha for adjacency separation.
- `_densityTrack` re-pitched: `4 + (hash % 11)*3` → `3 + (hash % 6)*6` — fewer parallel tracks but each one legible at the new bar height; fits within the same ~38px row footprint.
- Density gaps: hub `0.19/0.28` → `0.22/0.32`, spoke `0.10/0.18` → `0.13/0.22`.
- Heat / build / wave-window bars now pass `opacity: 0.7` to `_appendSpan` when `_state.densityEnabled` is true. `_appendSpan` already had the `opts.opacity` hook (line 1244); just plumbed it through the three caller sites.

**Verification:** `node --check modules/aircraft-flight-plan/visual-wave-overlay.js` passes. Live verification pending — reload extension, open `/app/fleets/aircraft/<id>/0` for a JFK aircraft with multi-leg days, confirm density bars visibly extend across hours 0–23 with heat candidates muted to 70% opacity behind them.

**Out of scope (latent bug noted for future session):**
`modules/route-assistant/wave-editor.js:56` — `addWave` uses `const baseHr = Math.min(22, 6 + 4 * n)` which clamps wave 5+ all to hour 22 (waves 5/6/7/… stack invisibly on top of wave 4). Not triggered in this session's reported case (the user has 1 configured wave) but should be fixed when wave-editor is next touched. Outside Agent 4 territory (`route-assistant/**` is Agent 2).

**Invariant impact:** none. Visual rendering only. No bus topics, no storage keys, no POST paths.

---

## Phase 1 summary (so far)

- Findings: 11.
- Categories: 2 BUG (1 cosmetic dead code, 1 low-priority API extension), 4 INVARIANT-RISK (verified intact: form-driver SACRED PATH, VFP collapse, tier gate, Slice E commit-bar), 2 INVARIANT-RISK / CROSS (F4-010 manifest poll-retry workaround, F4-011 schedule-store idempotent guard), 1 WIRING-GAP / DEFERRED-CONFIRMED, 1 QUESTION, plus this summary.
- SACRED PATH (form-driver no-auto-submit) verified intact — only one `submitBtn.click()` in tree (form-driver.js:489), only one `fillAndSubmit` invocation site (`aes:afp:fill-and-submit` runtime message), only one content-script gate (content_aircraftFlightPlan.js:42).
- Tier 1 zero-POST guarantee for Fleet Hub D chip verified intact (settings-extension forces dryRunOnly+applyEnabled regardless of storage; flight-number-applier hardcodes `dryRun = true` at line 338 plus `status: "dry-run"` short-circuit at 463).
- Schedule Canvas Slice E manifest + dispatch gating verified intact (commit-bar honours RA pricing gates; addRoute single-leg → AesHandoffStore; multi-leg / moveRoute / removeRoute deferred with toast).
- Tier gate + I-understand checkbox + 16-proposal cap on auto-scheduler verified intact.
- Cross-territory replies to Agent 1: F-3 (F4-010) — workaround works today, manifest cleanup is optional; F-6 (F4-011) — real invariant risk, simple Phase-2 fix.

### Top 5 issues I'd fix first (Phase 2 plan)

Ranked by ratio of (risk reduction + brief-match value) / (LoC + invariant blast radius):

1. **F4-011 / Agent 1's F-6** — wrap `schedule-store.js` in idempotent IIFE guard so a future manifest dup won't kill block 27's 200-entry script body. ~6 LoC of plumbing. Pairs with Agent 1's F-2 manifest dedup. Real invariant risk reduction.
2. **F4-003** — extend `schedule-diff.compare(currentLegs, proposedLegs, opts?)` to honour `opts.toleranceMin` (default 15min). ~5-line change inside a pure-function core. No POST path touched. Matches brief expectation; useful for future fleet-level diff at coarser tolerances.
3. **F4-010 / Agent 1's F-3 follow-up** — IF Agent 1 lands the manifest reorder (host.js + route-candidates.js + wave-applier.js into block 20 before audit-log.js), DELETE the `_attach` / `whenReady` poll-retry workarounds from spec-resolver.js, audit-log.js, route-candidates.js, wave-applier.js. ~80 LoC removal, zero behaviour change. **Sequenced after Agent 1.**
4. **F4-002** — delete dead `_detectSelect2Version` helper from form-driver.js (no callers; current `_commitSelect` uses no-change strategy). ~7-line cleanup; preserves the no-change Wicket-Ajax-race fix. Zero behavioural change.
5. **Phase-2 smokes** — write `audit/tests/afp/{range-buckets, schedule-builder, schedule-diff, slot-optimizer, auto-apply-log}.js` per brief §"Pure-function smokes". Pure Node, no Chrome dependency, locks down the contracts the brief specified.

Out-of-Phase-2 candidates: F4-009 (brief-vs-code naming drift) → recommend Agent 8 picks up at consolidation; F4-008 deferred items confirmed no-fix.

### Blockers / questions

1. **Live validation still blocked** — Agent 2's auth wall report (SHARED-NOTES 2026-05-01 10:50) means CDP-driven login on chrome-aes-4 (port 9236) is also blocked. Earlier attempt at port 9227 hit the same not-logged-in state. **Question for user**: refresh `credentials.json` to a working set, or hand-authenticate one Chrome instance and tell us which port? Until live verification lands, I cannot confirm the AFP page diagnostics overlay (`?aes-debug`) or the runSelfTest table for the brief.

2. **F4-010 sequencing** — should Agent 4 wait on Agent 1's manifest fix before deleting the poll-retry workarounds, or should I leave them in place as belt-and-suspenders even if the manifest is fixed? My recommendation: delete after Agent 1 lands F-3, since the workarounds are non-trivial code. User call.

3. **F4-011 sweep** — should the idempotent-guard sweep extend to other class-bodied modules in the AFP territory (state-store, active-draft-store, flight-log-store, maintenance-store, wear-model)? My recommendation: yes if any of them appear in two manifest blocks on the same URL match. Will quick-audit before Phase 2 commit if user OKs.

4. **Pure-function smokes** — no Chrome dependency for these. Safe to run in parallel with Phase 2 even before live verification unblocks. Recommend proceeding.


---

## 2026-05-03 · Compact "Flight Board" view for Fleet Command Center

**Disposition:** [FIXED] (additive feature)

**What:** Added a per-airline "Compact" view-mode toggle to
`modules/fleet-hub/command-center.js`. Standard mode (existing card grid)
is the default; Compact renders each tab as a salience-sorted, mono,
status-coded "departure board" — Overview rows = hubs, Schedules rows =
saved schedules, Waves rows = presets, Aircraft Plans inherits mono
styling. Click semantics preserved: hub rows open the existing
drilldown overlay; preset/schedule rows expand inline (transient state,
not persisted). Status pills use existing semantic tokens
(`--aes-crimson` BLOCKED · `--aes-amber` DRAFT · `--aes-moss` LIVE ·
`--aes-slate` IDLE). Subtle split-flap flip animation fires for ~420 ms
when a hub's status changes between repaints (respects
`prefers-reduced-motion`).

**Storage:** additive field `viewMode: "standard"|"compact"` in
`settings.fleetCommandCenter`. Persisted via the same read–merge–write
pattern as the existing `expandedPresets`/`expandedAircraft` savers — no
new queue, no new key prefix, no migration. Default `"standard"` matches
current UX.

**Files touched:**
- `modules/fleet-hub/command-center.js` — constructor state, hydrate in
  `_loadActiveTab`, new `_saveViewMode`, `_renderViewModeToggle`,
  `_hubSalience`, `_hubStatusCode`, `_hubStatusLabel`,
  `_renderOverviewBoard`, `_renderHubBoardRow`, `_renderSchedulesBoard`,
  `_renderWavesBoard`. Branches added at top of `_renderOverview`,
  `_renderSchedules`, `_renderWaves`. Aircraft Plans rendering
  unchanged — picks up mono styling via the CSS.
- `css/fleet-compact.css` — NEW. Scoped under
  `[data-aes-fleet-cc][data-view-mode="compact"]`. Board grid, status
  pills, hover/expand state, generate-strip, flip keyframe, reduced-motion
  guard.
- `audit/manifest-requests.md` — request to Agent 1 to register the new
  stylesheet in `content_scripts[0].css`.

**Invariant impact:** none. Additive settings field (HANDOVER §10
stable-key prefixes — no rename, no namespace move). Default `"standard"`
respects §10 "no silent default flips". `_hubSalience` is a pure function
(§4.7). No new POST path, no AS form touch — view-only.

**Cross-territory:** one ask to Agent 1 (manifest CSS line). Until that
lands, JS still sets `data-view-mode` and the grid DOM renders — just
without the mono+pill skin.

**Verification:** `node --check modules/fleet-hub/command-center.js`
passes. Live UI verification pending Agent 1's manifest update + a Chrome
instance with auth.
