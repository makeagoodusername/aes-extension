# LIVE Audit — Port 9227 — Slice E (Strategy / Conductor / Alliance)

**Agent**: Live Agent E of 6
**Chrome**: port 9227, profile `/tmp/chrome-aes-5`
**Extension**: `cpkkmmjhaajhfkmiejhhkkgdjdhoggkl` v0.6.12
**Server**: `free1.airlinesim.aero`
**Slice tiles**: `strategy`, `strategy-backtest`, `strategy-briefing`, `conductor`, `alliance`, `weekly-review`
**Slice modules**: `modules/strategy/`, `modules/conductor/`, `modules/alliance/`

## Boot health

After `reload-extension` + dashboard reload (`/app/enterprise/dashboard?3`):

- Console at boot: only `[AES cleanup] tab-idle: 1/1 ok` log lines. No errors from strategy/conductor/alliance modules.
- One pre-existing console error from `modules/fleet-hub/optimizer-drilldown.js` (`SyntaxError: Unexpected token '}'`) — **OUT OF SLICE**, noted in section "Out-of-slice".
- All 6 slice tiles render in the DOM as `[data-tile-id]` nodes. Bodies populate after the toggle (▸→▾) click. Per-tile button counts:
  - `strategy`: `Open →`, `☆`, toggle (3 btns); body adds `Compose`, `Layered…`, `Run a tick now`, `Open Settings →`, `Enable…` etc.
  - `strategy-backtest`: header `☆`, toggle (2); body adds `Run backtest`. **No `Open →` button** — by design (no `openHandler`/`openHref`).
  - `strategy-briefing`: `Open →`, `☆`, toggle (3); body adds `Open Settings →`, `Open full briefing →`.
  - `conductor`: header `☆`, toggle (2); body adds 7 filter chips + `Tick outcomes`, `Clear fires`, `Clear routines`, `Clear signals`. **No `Open →` button** — no canonical destination, intentional.
  - `alliance`: `Open →`, `☆`, toggle (3); body adds `Open Alliance Page →` link.
  - `weekly-review`: header `☆`, toggle (2); body shows "Pending / Active / Applied" cards, `0 pending · 0 active · 0 applied (7d)`.

## Tile-level checks

| Tile | Status | Notes |
| --- | --- | --- |
| `strategy` | OK | `AesStrategyPanel.open()` mounts overlay (z=10001) inside ~2s. Inline cards rendered: Settings strip, Auto-apply (game-day) diagnostic, Learning, Quick plan preview. `Last apply` card hidden because no plan applied yet (expected). |
| `strategy-briefing` | OK after fresh extension reload | `loadStatus` → `buildBriefing` returned `{windowDays:1, applied:0, opportunities:0, drift:none}`; `_briefing` populated; header `Open →` and body `Open full briefing →` both mount the modal at z=2147483640. |
| `strategy-backtest` | OK | `Run backtest` click runs `AesStrategyBacktest.run({weeks:12})`; first run produced `Δ cumulative: $0 over 12 weeks` with full per-week table + `Last backtest 2026-04-30 · 12wk · engine would have outperformed actual` cached badge. Run-and-cache flow OK. |
| `conductor` | OK | Status header: `30 signals · 1 types · 0 scenarios fired`. Routines section empty (expected — no scenarios fired). `Tick outcomes` button click flips `disabled` true→false within 1ms, no console errors — `AesConductorOutcomeDriver.tickOnce({force:true})` returns clean (no open fires to score). Static F-A1-002 priority bump 7→8 confirmed: `priority: 8` in source + on-screen ordering. |
| `alliance` | OK | `AllianceOverviewScraper.loadRecord()` returns null until user visits `/app/alliance` once; tile correctly renders `No alliance data — visit /app/alliance once to seed the cache.` Header `Open Alliance Page →` link points at `/app/alliance`. **Cache not yet seeded** in the live profile, so partner roster table is empty by design (not a bug). |
| `weekly-review` | OK | All 3 sub-cards (pending/active/applied) render; aggregate footer accurate. |

`/app/fleets` opened cleanly (`https://free1.airlinesim.aero/app/fleets`); console log shows the same single `tab-idle: 1/1 ok` line. Strategy modules are listed in the manifest content_scripts entry for `/app/fleets*` (lines 902–971 of `manifest.json`) so `AesStrategyPanel` is reachable from the AES menu on that page.

## Findings

### F-9227-LIVE-001 — `_text` global-scope collision broke `strategy-briefing` body render (FIXED upstream)

- **Severity**: would-be P1 if reproducible; current source already has the IIFE wrap.
- **Symptom (observed in stale extension state before reload)**: `[AES Hub] tile body render failed strategy-briefing TypeError: Cannot read properties of undefined (reading 'oxide2') at _text (.../strategy-slot-trading-tile.js:205:43) at CentralHubStrategyBriefingTile._renderAppliedCard (.../strategy-briefing-tile.js:197:30)`.
- **Root cause**: `modules/central-hub/tiles/strategy-slot-trading-tile.js` declares `function _text(T, s)` at file top-level (line 203, no IIFE wrap), shadowing the 1-arg `function _text(s)` previously defined at top-level in `strategy-briefing-tile.js`. With both files injected as content scripts they share the same script-global scope, and load order makes slot-trading the winner.
- **State on disk**: `strategy-briefing-tile.js` is already wrapped in an IIFE (`;(function () { … })();` at lines 19/1029) with a header comment that documents this exact issue. So the briefing helpers are now scoped local. After `reload-extension` + dashboard reload, the body renders cleanly.
- **Residual risk**: `strategy-slot-trading-tile.js` still has the leak at top-level (out of slice). Any other tile that ever declares a top-level `function _text(s)` will collide. Recommend wrapping slot-trading in IIFE — see Out-of-slice.

### F-9227-LIVE-002 — Briefing tile `openHandler` depends on `loadStatus` having run successfully

- **Severity**: P3 (defensive nit; never observed mis-firing once loadStatus runs).
- **Where**: `modules/central-hub/tiles/strategy-briefing-tile.js` line 343 `_openFullBriefing` early-returns silently when `this._briefing` is null.
- **Issue**: `loadStatus(ctx)` populates `this._briefing` from `buildBriefing(...)`; `renderBody` re-fetches and assigns `this._briefing = report` at line 122. But the header `Open →` button is wired in `_buildOpenButton` from `super.mount` via `openHandler()`, which captures `() => this._openFullBriefing()`. If `loadStatus` failed (e.g., transient `buildBriefing` throw caught at line 76–80) **and** the user never expanded the body, the header click silently does nothing.
- **Recommendation (not applied — requires lazy fetch on click)**: in `_openFullBriefing`, if `this._briefing` is null, fetch a fresh briefing on the spot before returning. Out of scope for this audit pass since `buildBriefing` succeeded in the live session.

## Fixes applied

None — the slice runs clean post-reload. The briefing IIFE wrap that prevents F-9227-LIVE-001 is already on disk (must have landed in a recent commit and the extension just needed a fresh reload to pick it up).

## Manifest deltas

**None.** Per fix rules, `manifest.json` was not edited. The current diff (`git status`) shows uncommitted manifest changes from prior agents (added trust-store / drift-driver / slot-* etc.) — left untouched.

## Out-of-slice (reported, not fixed)

1. **`modules/central-hub/tiles/strategy-slot-trading-tile.js`** — top-level `function _text(T, s)` (line 203) leaks into the shared content-script global scope. Briefing tile is now shielded by its own IIFE, but any future tile that re-declares `_text` will hit the same trap. **Suggested fix (out of slice)**: wrap the file body in `;(function () { … })();` like `strategy-briefing-tile.js` does. One-liner change, zero behaviour delta.
2. **`modules/fleet-hub/optimizer-drilldown.js`** — `SyntaxError: Unexpected token '}'` on every dashboard load. Whole file fails to evaluate, so any tile that references `OptimizerDrilldown` (`fleet-optimizer-tile.js`) loses functionality. Not in my slice — flagging for the fleet-hub agent.

## Boot tile inventory (live DOM probe)

```
[
  {id:"strategy-briefing",   bodyLen:107, btnCount:3},
  {id:"alliance",            bodyLen:79,  btnCount:3},
  {id:"strategy",            bodyLen:136, btnCount:3},
  {id:"weekly-review",       bodyLen:16,  btnCount:2},
  {id:"strategy-backtest",   bodyLen:67,  btnCount:2},
  {id:"conductor",           bodyLen:51,  btnCount:2}
]
```

All 6 tiles present; no empty bodies, no missing tiles, no duplicate registrations.

## Module presence (probed via DOM stamp from main world)

`AesStrategy*`, `AesConductor*`, `AllianceOverviewScraper`, `AesGameTimeWatcher` are all `undefined` in the **main world**, as expected — they're content-script isolated-world globals. They're reachable from the tiles (which run in the same isolated world) and their behaviour was validated indirectly via tile interactions (modal open, backtest run, tickOnce, briefing build).

`bridge.html` does not load slice modules (only `command-bridge/*` + `strategy/portfolio.js` per `bridge.html:37–49`), so the step-11 typeof probe of `AesStrategyPanel` etc. on `bridge` returns all-undefined — that's a workflow misnote, not a runtime bug. Validation was done via tile-driven smoke tests instead.

## Screenshots

- `/tmp/9227-dashboard.png` — full dashboard with 6 slice tiles visible
- `/tmp/9227-fleets.png` — `/app/fleets` after the strategy-loaded content script chain
