# Findings — Auto-pricing live verification (FGM 105 reference)

**Date:** 2026-05-03
**Game world / account:** Free1 / `jeankimdake@gmail.com` → airlines `Casper Flight Logistics` (id 770) and `CFLAIR` (id 775)
**Method:** CDP read-only + dry-run only against existing Chrome on port 9316 (extension loaded). No live writes.
**Reference snapshot:** `FGM 105 _ Free1 _ AirlineSim.html` (FN id 18665, JFK→PUJ, Y=225 / C=525 / Cargo=152 / 100% LF on all). The snapshot's airline no longer exists in the live game world (likely a world reset between snapshot and now).

**Tested surfaces (5/5):** per-leg autopricer · Tier 3 markets applier · central price automator · pricing-compass · strategy pricing-engine.

**Summary:** **6 findings** — initially classified as 2 [BUG] / 3 [WIRING-GAP] / 1 [DEFERRED-CONFIRMED]; after re-reading the source two of the wiring gaps were reclassified as [BY-DESIGN]. Zero `posted` / `verified` rows in `routeAssistant:pricingApplyLog` (gate model intact). The "many features missing" symptom is real but the mechanism is **data starvation + default config + cryptic skip messaging**, not broken applier code.

### Disposition (this session)

| Finding | Disposition | Commit-time fix |
|---|---|---|
| F-FGM105-001 | [FIXED] | per-leg autopricer chip now shows `"no data"` with a clear "Sync route data" hint when all signals are absent. |
| F-FGM105-002 | [FIXED] | `AesRoutePriceAutomator.preview()` now returns a `notices[]` array with `watchlist-empty` and `no-cached-signals` codes when those conditions hold. |
| F-FGM105-003 | [FIXED] | `manifest.json` block #9 now includes `modules/strategy/pricing-engine.js` and `modules/strategy/price-moves.js` (consistent with blocks #5 / #28 / #12). |
| F-FGM105-004 | [BY-DESIGN] | `/app/com/numbers/*` content_scripts block intentionally minimal (7 files). Per-leg autopricer is self-contained by design; duplicating its parser inline avoids pulling the full RA scrape stack into the FN page. |
| F-FGM105-005 | [BY-DESIGN] | Same rationale as F-004 — central-price-automator stays out of the FN page intentionally. |
| F-FGM105-006 | [DEFERRED-CONFIRMED] | World reset; no action. |

---

## F-FGM105-001 · `[BUG]` · per-leg autopricer renders nothing because every signal is null

**Where:** `modules/route-assistant/per-leg-autopricer.js:1545-1589` (auto-fires on `DOMContentLoaded` on `/app/com/numbers/<id>`).

**Observed:** On a real flight-number page (`/app/com/numbers/9381` = CFA 1, JFK→LHR; current prices Y=431 / C=1091 / F=1946 / Cargo=247), `AesPerLegAutopricer.run({source:'verify-cli', dryRun:true})` returns:

```
movedClasses: []
skipped: ["Y","C","F","Cargo"]
suggestions: { Y:{skipReason:"|Δ| 0.0% < min 3%"}, C:..., F:..., Cargo:... }
adviceByClass: every class { competitorMedian:null, historicalAvgPrice:null, rmTightness:null, score:0, stance:"hold", reasons:[] }
routeSignals: { competitors:{counts:{Y:0,C:0,F:0,Cargo:0}, scrapedAt:null}, demand:{paxDemandPool:null,...}, ors:null, historyByClass:{}, yieldHistory:null }
diagnostics.lastSkipReason: "flight-number leg autopricer: no class moved"
```

Every input signal is null because the per-route scrapers (markets/ORS/demand) have never run for JFK-LHR on this airline. The autopricer correctly defaults to "hold" → 0% Δ → suggestion suppressed.

**Why this is a [BUG] and not [DEFERRED-CONFIRMED]:** the user-visible behavior is "auto-pricer does nothing on every flight-number page I visit." HANDOVER documents per-leg autopricer as shipped (Tier 3.x); it does not document the precondition that scrapers must be run first. No empty-state UI is rendered — there's no banner saying *"no data yet — run RA-panel sync once"*. The autopricer module's source even contains the string `"no cached demand — run RA panel sync once"` (line 1540) but it is not surfaced into the DOM when ALL signals are missing — only when *some* are.

**Disposition:** Render an empty-state chip on every row when `signalLabels.length === 0`, linking to the RA-panel "Sync route data" CTA. Don't suppress silently.

**File:line of root cause:** `modules/route-assistant/per-leg-autopricer.js` — the suppress-when-no-signals branch around the rendering pipeline (search for `signalLabels`, `pricingSignals.labels`).

---

## F-FGM105-002 · `[BUG]` · default `silentAutoFollowMode: "watchlist"` + empty watchlist = zero proposals forever

**Where:** `modules/route-assistant/central-price-automator.js` → `window.AesRoutePriceAutomator.preview({hub:'JFK', dest:'LHR'})`.

**Observed:** preview returns 94 cached routes for the airline. Counts:

```
routes: 94, watchlisted: 0, pinned: 0, proposed: 0
withOwnPricing: 94, withCompetitors: 60, withYieldHistory: 0, withOrs: 0
```

**Every row** has `stage: "skipped"`, `reason: "not watchlisted"`. So even though competitor data is cached for **60 of 94 routes**, the automator emits zero proposals because `silentAutoFollowMode` defaults to `"watchlist"` and the user has starred zero routes.

**Why this is a [BUG]:** The default config combination is unreachable: a brand-new install can never produce a proposal until the user *both* (a) discovers the watchlist concept and (b) stars routes. There is no first-run UI nudge. Result: users perceive auto-pricing as "completely broken" when it is in fact gate-locked by an empty allow-list.

**Disposition:** One of:
- Default `silentAutoFollowMode` to `"all"` (with a config doc note).
- On first preview that returns `proposed:0 && watchlisted:0`, surface a one-time toast explaining the gate.
- Pre-populate the watchlist with the airline's top-5 highest-revenue routes on first mount.

**Verification of harmlessness:** `state.silentAutoEnabled: false` and `applyGate.reason: "scope-disabled:silentAuto"` — even with proposals, no live write would happen until the user explicitly enables silent-auto + flips `liveScopes.silentAuto`. Default-flipping the follow mode does not weaken the write-gate model.

---

## F-FGM105-003 · `[WIRING-GAP]` · strategy pricing-engine + price-moves + `AesStrategy` namespace don't mount on the scheduling page

**Where:** `manifest.json` registers `modules/strategy/pricing-engine.js`, `modules/strategy/price-moves.js`, etc. in three content_scripts blocks (lines 458/767/1126).

**Observed (on `/app/com/scheduling/JFKALM`, isolated world):**

```
typeof window.AesStrategyPricingEngine === "undefined"
typeof window.AesStrategy             === "undefined"
typeof window.AesPriceMoves           === "undefined"
typeof window.AesPricingCompass       === "object"     ← this one DID mount
```

`AesPricingCompass` (which is in the same neighborhood) loaded fine. The strategy globals didn't.

**Smoking gun:** `pricing-engine.js:50` is `if (window.AesStrategyPricingEngine) return` — single-mount guard. `price-moves.js:43` is `const ns = window.AesStrategy || (window.AesStrategy = {})` — namespace pattern. Either:
- The content_scripts block matching `/app/com/scheduling/*` is missing one of these files.
- A prior file in the same block is throwing and aborting the rest of the IIFE.
- The IIFE itself early-returns on a precondition that fails on `/app/com/scheduling/*` (URL match? page state?).

**Disposition:** Audit the 3 manifest blocks at lines 458, 767, 1126 — confirm `pricing-engine.js` and `price-moves.js` are in the block matching `/app/com/scheduling/*` and that no earlier file in the same `js` array throws.

---

## F-FGM105-004 · `[WIRING-GAP]` · `RouteAssistantInventoryPageScraper` not loaded on `/app/com/numbers/*`

**Where:** Expected to be the canonical price-row DOM parser shared between the inventory page, schedule-page-scraper, and the per-leg autopricer.

**Observed (on `/app/com/numbers/9381`, isolated world):**

```
typeof window.RouteAssistantInventoryPageScraper === "undefined"
typeof window.RouteAssistantFlightNumberResolver  === "undefined"
```

The per-leg autopricer therefore must duplicate price-parsing logic inline (it does — see `_readCurrentPrices` and `_routeFromForm` in `per-leg-autopricer.js`).

**Why this matters:** Two parsers means two places to break when AS rewires its DOM. The per-leg autopricer also bypasses the scraper's snapshot-write side-effects (storing into `routeAssistant:markets:ownPricing:<HUB>-<DEST>`) — except it re-implements that too via `_persistVisiblePricingSnapshot`. Net: there's drift risk.

**Disposition:** Either (a) add inventory-page-scraper to the content_scripts block for `/app/com/numbers/*`, or (b) document explicitly that per-leg-autopricer is intentionally self-contained and the duplication is by design (matches CLAUDE.md §11 "be skeptical of comments saying this works").

---

## F-FGM105-005 · `[WIRING-GAP]` · `AesRoutePriceAutomator` mounts on `/app/enterprise/dashboard` but **not** on `/app/com/numbers/*`

**Where:**

| URL | `AesRoutePriceAutomator` |
|---|---|
| `/app/enterprise/dashboard` | `object` (loaded) |
| `/app/com/scheduling/<HUB>` | `object` (loaded) |
| `/app/com/numbers/<id>`     | **undefined** |

**Why this matters:** the per-leg autopricer's `run()` does a full pricing computation locally on the FN page. The central automator's logic (with cooldown / cap-block / proposal stages) is not consulted. So a user could in principle (a) get a per-leg suggestion that was already tried 5 minutes ago and silently ignored by the central automator's cooldown, with no UI hint of the conflict. The two surfaces don't share state on FN pages.

**Disposition:** [QUESTION for user] — is this by design (per-leg autopricer is intentionally a thin client that doesn't talk to the central automator), or should the FN page also load the automator and consult it before rendering chips? If the former, document in HANDOVER §10 invariants. If the latter, add the script to the FN content_scripts block.

---

## F-FGM105-006 · `[DEFERRED-CONFIRMED]` · the snapshot's flight (FGM 105 / id 18665) no longer exists live

**Observed:** `https://free1.airlinesim.aero/app/com/numbers/18665` returns "PAGE NOT FOUND" for both airlines on the account. The current airline (`CFLAIR`) has 41 flight numbers spanning IDs 9381–9450ish, all named purely numerically (`1`, `2`, `3`, …) — no "FGM" prefix anywhere. The "Casper Flight Logistics" airline has zero flight numbers and 0 AS$ balance.

**Conclusion:** The Free1 game world reset (or the snapshot-airline was deleted) since the user saved the FGM 105 page. This is not a bug — just a fact that bounded the verification: we tested on `CFA 1` (a live equivalent) instead.

**Implication:** The user's expectation that "the auto-pricer should suggest a different price than 225 / 525 / 152" against the FGM 105 snapshot can't be exercised end-to-end against the live game. The mechanism (F-FGM105-001 + 002) explains why it would also have produced no suggestion against FGM 105 — that flight was on JFK-PUJ which is also unlikely to have had competitor data scraped.

---

## What does work

- ✅ `AesPerLegAutopricer` mounts and auto-fires on `/app/com/numbers/<id>` (verified by `lastContextAt` timestamp predating our manual run).
- ✅ Form parsing reads Y/C/F/Cargo prices correctly from the AS DOM.
- ✅ `AesRoutePriceAutomator.preview()` enumerates all 94 routes with cached state.
- ✅ Two-gate write model intact: `applyGate.reason: "scope-disabled:silentAuto"` blocks live writes for silent-auto by default; `liveScopes.bulk: false` blocks bulk; only `liveScopes.manual: true` is open (i.e., a deliberate user click in the panel can write).
- ✅ Apply log is empty of `posted`/`verified` rows on this account (no rogue writes happened during the verification).
- ✅ `AesPricingCompass.computeForRoute` runs without error (returns `{}` when signals are absent — same starvation pattern as F-FGM105-001).

## Open questions for the user

1. Is the watchlist-only default for silent-auto follow mode intentional? If yes, F-FGM105-002 becomes a UX/onboarding gap (need first-run nudge) instead of a config bug.
2. Should the per-leg autopricer page also load `AesRoutePriceAutomator` and consult its cooldown/cap state? (F-FGM105-005)
3. Was the snapshot's airline (FGM-prefixed, JFK-PUJ) intentionally retired, or is there a third airline on the account that I should re-target the verification against?

## Handoff notes

- The current Chrome instance on port 9316 has a tab open at `/app/com/scheduling/JFKALM` for airline CFLAIR. No state changes.
- 60 of 94 cached routes have competitor data — sufficient to test the proposal pipeline once F-FGM105-002 is addressed (flip follow mode to "all" temporarily, or add a route to watchlist).
- A faster repro for F-FGM105-001 is to call `AesPerLegAutopricer.run({source:'repro', dryRun:true})` from any FN page's iso-world console and inspect the `routeSignals.competitors.counts` field.
