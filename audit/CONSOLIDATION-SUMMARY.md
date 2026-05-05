# Multi-agent audit + fix consolidation

Eight parallel agents (six slice-bound + two cross-cutting) ran a static audit, then six new agents drove the live extension via Chrome DevTools Protocol. This file consolidates findings and the fixes that landed in code; per-agent reports are in `audit/findings-agent-N.md`, `audit/live-port-NNNN.md`, `audit/pathway-bus.md`, and `audit/pathway-storage.md`.

## Agents and their slices
| # | Round | Slice | Port (live) | Outcome |
|---|---|---|---|---|
| 1 | static | Strategy/Conductor/Alliance | — | 1 fix (priority deconflict) |
| 2 | static | Routes/Schedule/Canvas | — | 3 fixes; flagged Schedule Canvas dashboard-unreachable as P1 |
| 3 | static | Fleet/Aircraft/Ops | — | 2 fixes inc. window.X probe regression |
| 4 | static | Canopy/Settings/Customization | — | 2 fixes (factory: tile registration regressions) |
| 5 | static | Intelligence/World | — | 4 fixes inc. competitor-monitoring filter, station-automation watchedStorageKeys |
| 6 | static | Substrate/Hub-Shell | — | 0 fixes; manifest dead-path inventory |
| A | live | Substrate | 9223 | environmental: hijacked by another orchestration session |
| B | live | Routes/Schedule/Canvas | 9224 | discovered triple-mount of Central Hub; canvas-modal dedupe fix |
| C | live | Fleet/Aircraft/Ops | 9225 | 2 more `class` declarations needing `window.X = X` shims |
| D | live | Canopy/Settings/Customization | 9226 | settings-tile title-bar gate finding; mirror-tested via 9227 |
| E | live | Strategy/Conductor/Alliance | 9227 | clean run; surfaced `_text` global collision (already partially fixed) |
| F | live | Intelligence/World | 9228 | discovered Chrome extension auto-disable on disk pressure |
| G | static | Bus pathways (cross-cutting) | — | discovered `AesStrategy.bus` is referenced 12× but never instantiated |
| H | static | Storage envelope (cross-cutting) | — | discovered 24+ writers bypass `AesSettings.saveArea` (F-9223-002 race incomplete) |

## Code fixes consolidated and applied to disk

| File | Change | Fixes |
|---|---|---|
| `modules/central-hub/host.js` | Added subframe skip (`if (window.top !== window) return`) | F-9224-LIVE-001 (triple-mount) |
| `modules/central-hub/shell.js` | Idempotency guards at `mount()` entry (`this.root` check, DOM check, post-await re-check) | F-9224-LIVE-001 (defense-in-depth) |
| `modules/central-hub/tiles/settings-tile.js` | Title-bar `Open →` prefers `AesUnifiedSettings.open()` over the legacy options page | F-9226-LIVE-002 |
| `modules/central-hub/tiles/strategy-slot-trading-tile.js` | IIFE-wrapped to scope its file-local `_text` helper | F-9227-LIVE-001 (was clashing with briefing-tile's same-name helper) |
| `modules/strategy/apply-pipeline.js` | Instantiates `window.AesStrategy.bus` once (mini event bus) | G-001 (12 silent emits) |
| `modules/central-hub/tiles/fleet-schedule-canvas-tile.js` | NEW. Dashboard surface for the wave canvas; opens `/app/fleets` | F-A2-001 / F-9224-LIVE-002 |
| `manifest.json` | Added `fleet-schedule-canvas-tile.js` to dashboard content-script block | F-A2-001 |

## Live verification (port 9228 after extension reload)

```
hubMounted: true
sectionTilesTotal: 41
uniqueTileIds: 41           ← was 35-with-3×-render before
hasCanvas: true             ← new tile lands
hasSlotTrade: true          ← IIFE wrap didn't break registration
manifestDashEntries: 281    ← was 263 pre-fix (canvas tile + others)
```

## P1 findings still open (deferred to user / next session)

These were discovered by agents G + H but couldn't be fixed in-session — they touch slices that running agents owned, or they require breaking changes spanning >20 files.

1. **H-001**: 24+ writers bypass `AesSettings.saveArea` and do raw `chrome.storage.local.set({settings:...})`. F-9223-002 closed the bridge race; these writers still race. Highest blast radius — touches RA settings-store, AFP settings-extension, strategy default-settings, UAS presets-store, canopy/dna-account-editor, schedule-management/open-stations-modal, _background/legacy-defaults, and every `content_*.js` file at root.
2. **H-004**: Conductor stores (`scenario-store`, `routine-store`, `signal-store`) have unmitigated read-modify-write races. K10 outcome attribution and K11 trust scoring drop dismissals/accepts/outcomes under any concurrency. Fix shape: tail-Promise queue (~10 lines per store).
3. **H-006**: `aesStrategy:autoTick:last` dual-writes legacy + scoped on every tick. Federation regression — every account's tick clobbers the legacy slot.
4. **H-008**: `routeAssistant:pricingApplyLog` has mixed-scope writers + multiple unscoped reads. Per-airline data leaks across federated accounts.
5. **G-002 / G-003**: `signal:strategy:wear-pressure` and `signal:strategy:crew-pressure` are emit-orphans — registry claims consumers but actual reads come from `snapshot.fleet[].wear.ratioStatus` / `snapshot.crew.pressure` directly. Either wire the bus consumer or de-claim in `data-bus-topics.js`.
6. **G-012**: 13 phantom topics emitted but absent from `data-bus-topics.js` (incl. `data:account:bootstrapped`, `data:accounting:weekly:saved`, `data:strategy:applied:saved`, `data:strategy:settings:saved`, `data:strategy:layered:*-changed`).
7. **F-A2-002**: `open-tile {tileId:"fleet-schedule-canvas"}` bus emit on `/app/fleets` doesn't reach the dashboard (different page bus). New canvas tile partially closes by giving a dashboard surface; cross-page bus bridging is still a deferred design.

## Environmental findings (not code bugs)

- **Multi-session port contention**: 3 separate orchestration systems concurrently spawn Chromes on overlapping ports (9222–9226 = `aes-claude-3`, 9227–9228 = AES.v0.6.9, 9229+ = `aes-refine-worktree`). Ports 9223–9226 lost to siblings during this session.
- **Disk full**: 460G volume at 100% capacity, 4.2G free. Correlates with Chrome auto-disabling unpacked extensions (`disabledReason: "unknown"`); recovery via `chrome.management.setEnabled(id, true)`.
- **Symlink reload pitfall**: `chrome.runtime.reload()` against an extension loaded via symlink consistently de-registers it (per F-9226-LIVE-003).
