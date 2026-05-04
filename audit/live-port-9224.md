# Port 9224 — Routes/Schedule/Canvas live audit

Agent B (LIVE), CDP port 9224, profile `/tmp/chrome-aes-2`.
Slice: `route-assistant`, `route-launcher`, `route-management`, `schedule-management` tiles +
`modules/canvas/`, `modules/fleet-schedule-grid/`, `modules/schedule-management/*`,
`modules/route-launcher/*`, `modules/route-assistant/*` (~70 sub-modules).

## Boot health

First successful page load (post extension reload):

- Console (only entry, no errors):
  ```
  [AES cleanup] tab-idle: 1/1 ok in 0ms   (cleanup-registry.js)
  ```
- Tile inventory query returned **28 hits** for tiles with `data-tile-id`,
  but the AS dashboard only ships ~14 distinct tile IDs. The DOM contains
  **3** `#aes-central-hub` root elements and **15** `div.aes-central-hub__section`
  containers (3× the expected 5 sections). See F-9224-LIVE-001.
- Slice tile bodies (filtered to my four IDs):
  ```
  route-assistant      section=routes  bodyLen=85   (expanded body has content)
  schedule-management  section=routes  bodyLen=56
  route-management     section=routes  bodyLen=81
  route-launcher       section=fleet   bodyLen=67  ← "Airline context unavailable on this page. NO AIRLINE"
  route-launcher       section=fleet   bodyLen=40  ← "No aircraft selected   IDLE"
  route-launcher       section=fleet   bodyLen=40  ← "No aircraft selected   IDLE"
  ```
  All four slice tiles render visible content; none are empty (bodyLen 0).
- Halfway through the audit the AS session timed out (browser bounced to
  `airlinesim.aero/auth/login`) and shortly after the Chrome instance on
  port 9224 stopped accepting CDP connections (curl: connection refused).
  Subsequent steps (wave-palette chord, Canvas modal probe on `/app/fleets`,
  recent-schedules emptiness check, screenshots) could not be exercised live.
  Findings below combine the data captured pre-logout with static review of
  the relevant call paths.

## Findings

### F-9224-LIVE-001 — Central Hub mounts 3 times
- **Slice owner:** out-of-slice (`modules/central-hub/host.js` + `shell.js`).
  Reported here because every slice tile is duplicated in the live DOM and
  one of the duplicates renders with stale ctx (`NO AIRLINE`).
- **Repro:** open `https://free1.airlinesim.aero/app/enterprise/dashboard`
  authenticated, run
  `document.querySelectorAll('#aes-central-hub').length` → **3** (expected 1).
  Same for `div.aes-central-hub__main` (3) and `div.aes-central-hub__section`
  (15 — i.e., 5 sections × 3 mounts). All three hubs are visible
  (`getComputedStyle(...).display === "block"`, width 888 px).
- **Severity:** HIGH. 3× tile work per refresh, 3× storage subscriptions,
  plus the first-mount instance carries an unresolved airline ctx so
  route-launcher #0 shows `Airline context unavailable on this page.`
  while #1/#2 show `No aircraft selected`. User sees three Route Launcher
  cards stacked.
- **Status:** OPEN. Requires fix in central-hub host/shell — explicitly
  out-of-slice for Agent B.
- **Suggested fix:** the host's `__aesCentralHubMounted` window flag and the
  `document.getElementById("aes-central-hub")` short-circuit should both be
  honoured by `shell.mount()` itself (defensive guard). Today `mount()` will
  happily attach a second `<div id="aes-central-hub">` if called twice;
  there is no `if (this.root)` guard at the top.

### F-9224-LIVE-002 — Schedule Canvas double-open via bus + direct fallback
- **Slice owner:** `modules/canvas/canvas-modal.js` (mine) +
  `modules/fleet-hub/command-center.js::_openHubCanvas` (out-of-slice caller).
- **Repro:** on `/app/fleets`, click "Build wave schedule ▸" on a hub card.
  `command-center.js` line 4729 emits `CentralHubBus.emit("open-tile",
  {tileId: "fleet-schedule-canvas", filter, source})` and `fleet-schedule-grid/host.js`
  is subscribed (line 51) — its handler calls `CanvasModal.open(...)` synchronously.
  The very next line (4738) of `_openHubCanvas` unconditionally calls
  `CanvasModal.open(...)` again. `CanvasModal.open` closes any active modal
  before opening, so the user sees: open → close → open (perceptible flicker;
  unmount/remount of `CanvasShell`, refetch of fleet+schedules).
- **Severity:** MED. Functional output is correct (single modal at the end),
  but the flicker + double load is wasteful and could lose any
  inflight rail state if the user starts interacting between the two opens.
- **Status:** FIXED in slice — `CanvasModal.open` now dedupes back-to-back
  opens with an identical `(server, airlineCode, selectedHub, selectedAircraftId,
  railMode)` signature within 250 ms; the second call returns the existing
  active instance.
- **Cleaner long-term fix (out-of-slice):** make `_openHubCanvas` only fall
  back to a direct call when `CentralHubBus` has no listeners for `open-tile`.
  That would require a `hasListeners` / `listenerCount` API on
  `central-hub/bus.js`. Proposed but not implemented (out of scope).

### F-9224-LIVE-003 — `RouteManagementTile._loadSchedule` reads all of chrome.storage.local
- **Slice owner:** `modules/central-hub/tiles/route-management-tile.js` (mine; tile lives in central-hub but is owned by the routes slice).
- **Repro:** every refresh of the Route Mgmt tile calls
  `await chrome.storage.local.get(null)` (line 56) and iterates the entire
  storage map looking for objects with `type === "schedule"`. On profiles
  with many cached scrapes / snapshots, this is a measurable hit on every
  re-render, including the periodic refreshes triggered by storage-watch
  (and especially under F-9224-LIVE-001 where the same tile renders 3×).
- **Severity:** LOW (perf, not correctness). The tile already filters by
  exact key `<server><airline>schedule` for storage-watch; the refresh path
  could narrow `get()` to that same key when both server+airline are present
  (with `chrome.storage.local.get(null)` only as a fallback when airline ctx
  is missing).
- **Status:** OPEN — non-blocking; deliberately not changed in this pass to
  keep the patch surface small while the multi-mount bug (F-9224-LIVE-001)
  is also at play.

### Static-finding regressions: NOT REPRODUCED
- **F-A2-003 (route-assistant scheduling link double-encoded):** the live
  query `[data-tile-id='route-assistant'] a[href*='scheduling']` couldn't
  be exercised after the session ended. Static recheck of
  `modules/central-hub/tiles/route-assistant-tile.js:200` shows
  `link.href = "/app/com/scheduling/" + encodeURIComponent(hubInfo.hub)`
  with `hubInfo.hub` sourced from `e.suffix` of a single-key feed entry —
  no repeat-IATA construction visible. Looks fixed; live verification
  blocked.
- **F-A2-004 (recent-schedules list empty when index has entries):**
  `tiles/schedule-management-tile.js::_loadRecentSchedules` (lines 49–66)
  now handles both `{scheduleId, ...}` summary objects (current
  `ScheduleStore.save` shape) and bare-id legacy strings, and
  `ScheduleStore.save` (`schedule-store.js:64`) writes summary objects.
  The two are aligned; static fix appears correct. Live verification blocked
  (would have needed a saved schedule + the dashboard tile expanded).

### Other items not exercised (Chrome/session died)
- Wave palette chord (`Cmd/Ctrl+Shift+K` vs `Cmd/Ctrl+K`): not tested live.
  Static palette wiring lives in `modules/route-assistant/wave-palette.js`
  and the keybind store in `modules/route-assistant/wave-keybinds-store.js` —
  neither was reachable for runtime keydown injection.
- `CanvasModal` presence on `/app/fleets`: not directly verified live.
  Static: `window.CanvasModal = CanvasModal` at `canvas-modal.js:501`,
  manifest registers `modules/canvas/canvas-modal.js` (line 1001 of manifest),
  `fleet-schedule-grid/host.js` references it directly — wiring is intact.
- Fleet Hub Command Center "Open Schedule Canvas" CTA: not clicked. Static
  trace already produced F-9224-LIVE-002 above.

## Fixes applied (file:line)

- `modules/canvas/canvas-modal.js:24-58` — added `_lastOpenSig` /
  `_lastOpenAt` static fields and a 250 ms identical-payload dedupe in
  `CanvasModal.open()`. Resolves F-9224-LIVE-002. `node --check` clean.

## Manifest deltas requested

None. The manifest registers all four slice tiles, both canvas surfaces, and
the wave palette / keybinds module in the expected order. No additions or
removals proposed.

## Out-of-slice issues

1. **F-9224-LIVE-001** — Central Hub mounts 3×. Owner: `modules/central-hub/host.js`
   + `shell.js`. Recommended: add `if (this.root) return` guard at the top of
   `CentralHubShell.mount()`, and have `host.js::mountIfReady` recheck
   `__aesCentralHub` (the live shell instance) in addition to the DOM id, so
   late callers from AS's SPA navigation hit the no-op path.
2. **F-9224-LIVE-002 root cause (caller)** — `modules/fleet-hub/command-center.js::_openHubCanvas`
   should only invoke `CanvasModal.open` directly when `CentralHubBus` has
   no `open-tile` listener. Needs a `listenerCount(event)` helper on
   `modules/central-hub/bus.js`.

## Screenshots

Not captured. The Chrome instance on port 9224 stopped responding to CDP
mid-audit (after roughly the second `eval` round) and the dashboard tab had
already been replaced with `file:///private/tmp/aes-claude-3/project/tools/dashboard-harness-t4.html`
from a peer agent before the crash. Subsequent attempts to re-open
`https://free1.airlinesim.aero/app/enterprise/dashboard` redirected to the
login page and then `curl http://localhost:9224/json` started returning
`Connection refused`. No re-launch was attempted from this agent (out of
scope per "DO NOT touch other agents' chromes/ports").
