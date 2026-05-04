# A1 — Manifest + Load Order + Reachability — Streamline Report

## Summary

Scope: `manifest.json` (30 content_scripts blocks; 885 sum js entries; 596 unique paths), 586 `.js` in `modules/`, 24 `content_*.js` at root, 13 service-worker imports, 13 scripts in `bridge.html`. Headline: **0 true orphans**, **0 stale refs**, **0 in-block duplicate paths**, **3 idempotent cross-block on-page redundancies that should be removed for clarity**, **8 manifest entries (b6 + b9) that are strictly redundant with the universal block 1**, **AFP block 20 still missing `host.js`** (the §10 invariant violation; survives via the spec-resolver / form-driver / audit-log retry shims), **strategy `journal-store.js` loads after `learn.js`** in blocks 5 and 27 (§10 invariant order violation; benign today). Top recommendation: **delete the redundant cross-block manifest entries** (8 lines in b6+b9 + 3 in b19/b20) — they only exist because of historic copy/paste from a pre-`/app/*` universal era; removing them shrinks the manifest, eliminates the §10 "double-inject" latent regression vector, and removes the need for the dna/settings idempotent guards to actually carry the load.

## KEEP

**Manifest scaffolding (load-bearing, working):**
- `manifest.json` MV3, `version: 0.6.12 / version_name: 0.6.12-beta`, parses clean.
- All 30 `content_scripts` blocks accounted for; URL match patterns match what the site actually serves.
- Permissions list (`activeTab`, `declarativeContent`, `storage`, `unlimitedStorage`, `tabs`, `notifications`, `alarms`) all consumed by at least one module (266 storage callers; 11 tabs; 8 alarms; 1 notifications; 1 declarativeContent in `background.js`).
- `host_permissions` `https://*.airlinesim.aero/*` + `https://www.flightsfrom.com/*` both required.
- `web_accessible_resources` (`/images/*`, `/fonts/*`) consumed by site-skin CSS.
- `action.default_popup` → `popup.html` → `popup.js`; `options_ui.page` → `options.html` → `options.js`. Both intentionally not in `content_scripts` (orphans by manifest grep, but reached via HTML `<script>` tags and the action/options entry points).

**Universal block 0 (CSS only, run_at: document_start):** 1 js (`site-skin/bootstrap.js`) + 12 css. KEEP — early-flash prevention.

**Universal block 1 (`/app/*` + `/action/*`):** 100 js entries. KEEP — substrate (`_shared/*`, `central-hub/feed/*`, `customization/*`, `unified-settings/*`, `aes-menu`, `command-bridge/menu-installer`, site-skin polish). All 100 are correctly first-loadable (jQuery → helpers → `_shared/*`).

**Per-page blocks 2–18, 22–28:** all serve real pages; all entries reach a consumer.

**Block 19 `/app/fleets/aircraft/*/1*`** (aircraft-flights / per-aircraft history) — 13 entries, all needed.

**Block 20 `/app/fleets/aircraft/*/0*`** (AFP page) — 31 entries, all needed; load-order issue called out below.

**Block 21 `/app/fleets/aircraft/*/0*` (`world: MAIN`, `run_at: document_start`)** — 1 entry (`page-bridge.js`). KEEP — the MAIN-world bridge is intentionally separate (must run before AS's own scripts).

**Block 27 `/app/fleets*`** — 217 entries. The big one. KEEP; it's the integration hub for fleet-hub + AFP host + strategy + canopy + RA + schedule-management on the fleets list page. Internal load-order is correct except for the `journal-store / learn` swap noted in FIX.

**Service-worker reachability (`background.js` + `_background/*`):** 14 modules across 13 `importScripts` calls (`account-registry`, `afp-submit-queue`, `alarms`, `bridge-tab`, `customization-store`, `flight-number-groups`, `legacy-defaults`, `notifications`, `scrape-routing`, `silent-auto-alarm`, `site-skin-sync`, `tab-lifecycle`, `vision-capture` + `scrape-orchestrator/background-tab-pool`). KEEP — all consumed.

**`bridge.html` reachability:** 13 scripts (`_shared/account-registry`, `_shared/fleet-roster`, `canopy/affiliations-store`, `canopy/orgs-store`, `aircraft-flight-plan/schedule-store`, `strategy/portfolio`, plus 7 `command-bridge/*`). KEEP.

## CUT (with file paths and reason)

These manifest entries are redundant — every file is **also** loaded via the universal block 1 (`/app/*` matches every URL these per-page blocks fire on). All three files are idempotently guarded so the dup is silent today, but it (a) clutters the manifest, (b) re-runs the IIFE entry guard 1× per dup, (c) is the literal regression vector §10 calls out.

**Block 6 (`/app/aircraft/market*`) — strict subset of block 1:**
- `manifest.json` block 6 `js[7]` → `modules/_shared/settings-bridge.js` — duplicate of block 1 `js[11]`.
- `manifest.json` block 6 `js[?]` → `modules/canopy/dna-fit-scorer.js` — duplicate of block 1 `js[44]`.
- `manifest.json` block 6 `js[?]` → `modules/canopy/dna-store.js` — duplicate of block 1 `js[43]`.

**Block 9 (`/app/com/scheduling*`) — strict subset of block 1:**
- `modules/canopy/affiliations-store.js` — duplicate of block 1 `js[34]`.
- `modules/canopy/combined-supply.js` — duplicate of block 1 `js[48]`.
- `modules/canopy/dna-fit-scorer.js` — duplicate of block 1 `js[44]`.
- `modules/canopy/dna-store.js` — duplicate of block 1 `js[43]`.

**Cross-block on-page redundancies (sub-page block also loaded by `/app/fleets*` block 27):**
- `modules/aircraft-flight-plan/schedule-store.js` listed in BOTH block 19 (`/app/fleets/aircraft/*/1*`) AND block 27 — F-2 from prior findings, still present. CUT from block 19 (block 27 already covers it; module has `if (window.AesAfpScheduleStore) return` guard).
- `modules/aircraft-flight-plan/settings-extension.js` listed in BOTH block 20 AND block 27. CUT from one of them (likely keep in block 20 so AFP page loads it before any AFP slice consumer runs; remove from block 27).

(Both files now carry idempotent guards — verified: `schedule-store.js:8` has `if (window.AesAfpScheduleStore) return`, `settings-bridge.js:28` has `if (!root || root.AesSettings) return`. So the dup is silent. But removal is cheaper than the extra IIFE re-execution.)

**Result of all CUTs above:** 11 manifest js-entry deletions; manifest sum drops 885 → 874; unique count unchanged at 596.

**No file-system deletions recommended.** All 586 `.js` in `modules/` are referenced. (Three files at root — `popup.js`, `options.js`, `background.js` — are reached via HTML/service-worker entry points, NOT manifest content_scripts. Not orphans.)

## FIX (broken wiring)

**FIX-1 (BUG/WIRING-GAP) `manifest.json` block 20 missing AFP `host.js`** — F-3 from prior findings, still present. The page `/app/fleets/aircraft/<id>/0` co-fires block 20 (31 scripts, AFP slice) and block 27 (217 scripts including `host.js` at pos 70 and `route-candidates.js` / `wave-applier.js` at pos 72/76). Chrome content-script injection is **manifest-block-order**, so block 20's bus subscribers (`audit-log` p7, `spec-resolver` p8, `form-driver` p16, `auto-scheduler/*` p17–24, `flight-studio/*` p25–29) attempt `window.AesAfp.bus.on(...)` BEFORE block 27 publishes it via `host.js`. Currently survives because every block 20 consumer carries a defensive workaround:
- `spec-resolver.js:289–306` — `_attach()` with `setTimeout(50)` retry until `window.AesAfp.bus` exists.
- `form-driver.js:892–908` — `setInterval(...)` with `POLL_MAX_TRIES` retry.
- `audit-log.js:284–303` — `whenReady(cb)` with 200ms tick, 30s cap.
- `route-candidates.js` — same retry pattern (per `spec-resolver.js:288` reference).

The §10 invariant is unambiguous (line 2943 of `HANDOVER.md`): *"AFP slice load order: foundation → host → bus subscribers → entry. settings-extension.js (no bus dep) before host.js (publishes window.AesAfp.bus) before audit-log.js / spec-resolver.js / route-candidates.js / form-driver.js / wave-applier.js (all bus.on(...) at module-level IIFE load) before content_aircraftFlightPlan.js."* The retry workarounds are technical debt that mask the missing manifest entries.

**Fix:** Add `modules/aircraft-flight-plan/host.js` to block 20 immediately after `settings-extension.js` (current position 2 → insert host as new position 3). Also add `modules/aircraft-flight-plan/route-candidates.js` and `modules/aircraft-flight-plan/wave-applier.js` (currently in block 27 only, but the §10 invariant text names them as block 20 contents). Once the manifest matches the invariant, the retry shims become dead-but-harmless code that Agent 4 can clean later. Coordinate with Agent 4 (AFP territory). Live verification needs an authenticated AS session (CDP login was previously denied).

**FIX-2 (INVARIANT-RISK) `journal-store.js` loads AFTER `learn.js`** — F-4 from prior findings, still present:
- `manifest.json` block 5 (`/app/enterprise/dashboard*`): `learn.js` at pos 251, `journal-store.js` at pos 252.
- `manifest.json` block 27 (`/app/fleets*`): `learn.js` at pos 146, `journal-store.js` at pos 147.

§10 invariant (`HANDOVER.md:2881`): *"Manifest order MUST keep `journal-store.js` ahead of `apply-pipeline.js` and `learn.js` (so its passive subscriber catches their first write) and ahead of `panel.js` (so the modal section can reach `window.AesStrategyJournal`)."*

Benign today: `learn.js`'s IIFE only defines `window.AesStrategyLearn` and runs an opt-in smoke test under `?aes-debug` — no storage write at module load, so the journal's `chrome.storage.onChanged` subscriber doesn't miss anything. But the §10 wording is a hard MUST, and any future change that pushes a write into `learn.js`'s IIFE would silently bypass the journal.

**Fix:** swap the two entries in both block 5 and block 27. One-line change in each block. Apply-pipeline (block 5 pos 257 / block 27 pos 152) is already after journal-store.

**FIX-3 (manifest-request inbox)** Agent 7's `audit/manifest-requests.md` request from 2026-05-01 is unprocessed: prepend `modules/_shared/settings-bridge.js` to the manifest entries that load `content_dashboard.js`, `content_settings.js`, `content_inventory.js`, `content_personelManagement.js`, `content_fligthSchedule.js`. Today only universal block 1 + block 6 inject the bridge; on the dashboard / settings / inventory / staff / schedule URLs, `window.AesSettings` is undefined to those legacy `content_*.js` files, so Agent 7's storage-writer migration is blocked. Note: dashboard is block 5 (already in scope of universal block 1, so the bridge IS available there because block 1 also matches `/app/*`); the actual gap is in the `content_settings.js` / `content_inventory.js` / `content_personelManagement.js` / `content_fligthSchedule.js` entries (blocks 4, 2, 13, 3 respectively). All five URLs are subsets of `/app/*` and already get the bridge via block 1, so this request appears moot under current manifest layout — **agent-1 to confirm with agent-7 whether the request is still live or has been overtaken by the universal-block delivery.**

## DEFER (per CLAUDE.md §5)

- **`drag-affordance-store` without a live consumer** — HANDOVER §1.3 calls this out as a v1 deferred: the module is wired (manifest blocks 5/9/20/27) but its tutorial-UI consumer is not yet built. The `dragSubmitMode` field is duplicated by `settings.aircraftFlightPlan.dragSubmitMode` which is the live source of truth. Manifest does the right thing (load it for shape coherence); leave alone.
- **AFP slice retry shims (`spec-resolver._attach`, `form-driver` setInterval, `audit-log.whenReady`)** — defensive code that masks the FIX-1 manifest gap. CLAUDE.md §5 distinguishes "deferred" from "broken"; the manifest gap is broken (FIX-1). The shims themselves stay until Agent 4 cleans up after FIX-1 lands; they don't actively hurt anything but their existence is the symptom, not the disease.
- **Block 0 vs Block 1 split (same URL, different `run_at`)** — intentional. Block 0 is `run_at: document_start` for early-CSS; block 1 is default `document_idle`. Don't merge.
- **Block 21 vs Block 20 split (same URL, different `world: MAIN` / `run_at: document_start`)** — intentional. Block 21 injects `page-bridge.js` into the page's main world before AS's own scripts run; cannot be merged with block 20.
- **Blocks 13 + 14 (both match `/action/enterprise/staffOverview*`) and Blocks 17 + 29 (both match `/app/info/enterprises/*`)** — could be merged for tidiness but the file lists are disjoint and the split appears organisational (one block per "owner"). Not worth the diff during streamline; leave alone.
- **Modules NOT in manifest content_scripts (21 files)** — all reached via service-worker `importScripts` (13 in `_background/*` + 1 `scrape-orchestrator/background-tab-pool.js`) or via `bridge.html` (7 `command-bridge/*`). Not orphans; per §11.3 reconciliation logic.

## STREAMLINE — Top 5

1. **Land FIX-1 (AFP block 20 host.js + route-candidates + wave-applier).** Highest impact: closes the §10 invariant explicitly named, lets Agent 4 retire 4 retry shims (`spec-resolver._attach`, `form-driver` setInterval, `audit-log.whenReady`, plus the `route-candidates` mirror), and removes the latent regression vector. Manifest size delta: +3 entries in block 20 (one of which is also in block 27 today — see point 3 — so net is +2). Coordinate with Agent 4 before commit; require live verification on `/app/fleets/aircraft/<id>/0` against an authenticated AS session.

2. **Delete the 7 strict-subset cross-block redundancies (b6 dna+settings, b9 affiliations+combined-supply+dna×2).** All 7 files are also loaded by universal block 1 which matches every URL block 6 and block 9 fire on. Manifest shrinks 7 entries; sum 885 → 878. No runtime change (idempotent guards already in place). Removes the §10 "double-inject" concern these duplicates embody.

3. **Delete the 2 sub-page-vs-fleets cross-block dups (`schedule-store.js` from b19, `settings-extension.js` from one of b20/b27).** Both have idempotent guards now. Removes the F-1/F-2 historic regression vector. Manifest shrinks 2 entries.

4. **Land FIX-2 (swap `journal-store.js` ahead of `learn.js` in blocks 5 and 27).** One-line edit in each block. Closes the §10 invariant cleanly. Future-proofs against a `learn.js` IIFE that ever does a storage write.

5. **Reconcile HANDOVER.md §1 / §3 / §11.3 file count drift.** Tree has 586 module files; HANDOVER §1 still says 533. Either bump the count post-streamline OR have Agent 8 do the §11.3 reconciliation pass at end of session. Either way, the audit's catch-net for orphan-on-add isn't running, so a future commit that adds an unreferenced module will only be caught by `audit/scripts/manifest-audit.py` — make sure that script is in the agents' pre-commit checklist (it currently lives at `audit/scripts/manifest-audit.py`; could be shipped as `tools/manifest-audit.py` per a separate slice).

## Open questions for the user

1. **FIX-1 cross-territory:** The §10 invariant is unambiguous about which AFP files belong in block 20 (host → audit-log → spec-resolver → route-candidates → form-driver → wave-applier). Should I propose the manifest entry additions myself (territory-internal), or wait for Agent 4 to confirm? Suggested: proceed on §10's specification, Agent 4 reviews. Live verification needs an authenticated AS session — same blocker as the Phase-1 audit.

2. **Manifest-request from Agent 7 (2026-05-01):** the request asks for `settings-bridge.js` to be added to 5 manifest entries, but every URL named is already covered by universal block 1 which already loads the bridge. Should I (a) reply in `audit/manifest-requests.md` that the request appears moot, or (b) add the bridge anyway as belt-and-braces given that idempotent guards make it free? My read: (a) — adding the same-file dup creates more §10 "double-inject" surface and Agent 7's blocked migration should already work today.

3. **Block consolidation (13+14, 17+29):** small tidiness win, no functional change. Worth doing in this streamline pass or leave for a future "manifest hygiene" slice?
