# Port 9223 — Substrate/Hub-Framework live audit

## Boot health
- Console errors: 0 captured (only one cleanup log line on dashboard)
- Hub mount: cannot determine — no real dashboard reachable in this Chrome
- Tile DOM count: cannot determine in this Chrome
- Empty tiles: cannot determine in this Chrome
- Substrate globals (bridge.html): **all undefined** — bridge.html serves
  `chrome-error://chromewebdata/` with `ERR_BLOCKED_BY_CLIENT` because the
  extension is no longer registered with the browser

## Critical environment finding (blocks the rest of the audit)

### F-9223-LIVE-001: Chrome on port 9223 is loading the wrong codebase, owned by another agent
- Severity: P1 (blocks live audit on this port for AES.v0.6.9)
- Status: WONTFIX (out of slice — environment / orchestration issue, not a
  code bug in /Users/jihwan/Downloads/AES.v0.6.9)
- Repro:
  ```
  ps -ef | grep 'remote-debugging-port=9223'
  # → /Applications/Google Chrome.app/.../Google Chrome \
  #     --user-data-dir=/tmp/aes-chrome-t3 \
  #     --remote-debugging-port=9223 \
  #     --load-extension=/private/tmp/aes-claude-3/project \
  #     file:///private/tmp/aes-claude-3/project/tools/dashboard-harness-t3.html
  ```
- Expected (per the live-audit prompt):
  - Profile = `/tmp/chrome-aes-1`
  - `--load-extension=/Users/jihwan/Downloads/AES.v0.6.9`
- Actual:
  - Profile = `/tmp/aes-chrome-t3` (root-owned)
  - `--load-extension=/private/tmp/aes-claude-3/project`
  - Chrome process owned by uid 0 (root). My CDP session runs as uid 501.
- Root cause: This Chrome instance was launched by a different orchestration
  agent (the "port-9223 / chrome-devtools-mcp" auditor) that is operating
  out of a separate worktree at `/private/tmp/aes-claude-3/project`. The
  `port 9223` slot is double-booked between two orchestration systems.
- Impact: All live findings about substrate/hub framework against this Chrome
  describe a *different* checkout, so they are not actionable inside
  AES.v0.6.9. The Chromes that DO load `/Users/jihwan/Downloads/AES.v0.6.9`
  are on ports **9227** (`/tmp/chrome-aes-5`) and **9228**
  (`/tmp/chrome-aes-6`), but those are owned by other agents (rule: "DO NOT
  touch other agents' chromes").
- Notes / what would unblock:
  - Re-launch the "AES Agent A" Chrome with
    `--load-extension=/Users/jihwan/Downloads/AES.v0.6.9 \
     --disable-extensions-except=/Users/jihwan/Downloads/AES.v0.6.9 \
     --user-data-dir=/tmp/chrome-aes-1` on a port that is not already in use
    by another agent (e.g. 9233+).
  - OR explicitly hand me one of 9227/9228 with a documented release of
    ownership.

### F-9223-LIVE-002: `reload-extension bridge` permanently disabled the unpacked extension on 9223
- Severity: P2
- Status: OPEN (cannot fix from user-space — extension is gone for this run)
- Repro:
  ```
  node /tmp/cdp.js 9223 open chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html
  node /tmp/cdp.js 9223 reload-extension bridge   # per the documented workflow
  sleep 3
  node /tmp/cdp.js 9223 evalfile bridge /tmp/bridge-probe.js
  # → url: chrome-error://chromewebdata/, body: "cpkkmmjhaajhfkmiejhhkkgdjdhoggkl is blocked … ERR_BLOCKED_BY_CLIENT"
  curl -s http://localhost:9223/json/list | grep service_worker
  # → (no service_worker target — background.js gone)
  node /tmp/cdp.js 9223 screenshot extensions /tmp/9223-extensions-page.png
  # → "All Extensions" lists only Google Docs Offline; AES is absent
  ```
- Expected: `chrome.runtime.reload()` reloads the extension; bridge.html
  re-mounts; substrate globals defined.
- Actual: extension entry vanishes from `chrome://extensions/` entirely.
  Toggling Developer mode back on does not bring it back; reloading the
  extensions page does not bring it back; navigating to bridge.html shows
  ERR_BLOCKED_BY_CLIENT served from `chrome-error://chromewebdata/`.
- Likely root cause: Chrome 9223 was launched WITHOUT
  `--disable-extensions-except` and with `--load-extension` pointing at the
  *other* worktree. Calling `chrome.runtime.reload()` while user-data-dir is
  root-owned and dev-mode preferences are out of sync seems to push the
  extension into a hard-disabled state. Without root, I cannot edit
  `Preferences` / `Local Extension Settings` to recover; without restarting
  the Chrome with proper flags, the unpacked extension cannot be re-loaded.
- Workflow recommendation: replace step 3 of the live-audit workflow
  (`reload-extension bridge` then reload bridge tab) with a softer reset that
  doesn't risk wiping the extension when this prompt runs against a Chrome
  someone else launched. Concretely:
  - Test whether the extension is loaded BEFORE calling reload-extension.
  - Prefer `nav bridge chrome-extension://<id>/bridge.html` (forces a fresh
    page load using the existing service worker) over a full extension
    reload when only the page state needs to be refreshed.

## Findings observed before the extension died
None of substantive value — the only console line captured on the (logged-out)
dashboard tab before reload-extension ran was:

```
[AES cleanup] tab-idle: 1/1 ok in 2ms
   src=chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/modules/_shared/cleanup-registry.js
```

No errors, no unhandled rejections in 5 s of capture. But this was while
visiting the *other* codebase's bundle, so it is not a meaningful signal
for AES.v0.6.9.

## Static slice sanity (since live testing was blocked)
Ran `node --check` on all slice-owned framework files; all parse cleanly:

- modules/central-hub/shell.js — OK
- modules/central-hub/host.js — OK
- modules/central-hub/bus.js — OK
- modules/central-hub/tile-registry.js — OK
- modules/command-palette/host.js — OK
- modules/scrape-orchestrator/host.js — OK
- modules/scrape-orchestrator/auto-driver.js — OK
- background.js — OK

## Fixes applied
None. The blocker is environmental (wrong Chrome is on port 9223). No code
changes to the AES.v0.6.9 tree are warranted from this run.

## Manifest deltas requested
None.

## Out-of-slice issues observed
- Multiple agents are double-booking the `port 9223` slot. The Chrome at
  9223 is loading `/private/tmp/aes-claude-3/project`, not
  `/Users/jihwan/Downloads/AES.v0.6.9`. Recommend that the orchestrator
  either:
  - Assign distinct port ranges per worktree (e.g. 9223-9226 = aes-claude-3,
    9233-9236 = AES.v0.6.9), or
  - Pass the explicit `--load-extension` and `--user-data-dir` for the
    specific worktree into the agent prompt so it can verify before doing
    destructive work like `chrome.runtime.reload()`.
- Chrome on 9222/9225/9226 also points at `/private/tmp/aes-claude-3/project`.
- Chromes on 9227/9228 are correctly loading `/Users/jihwan/Downloads/AES.v0.6.9`
  but are owned by other agents.
- Chromes on 9229–9232 are loading `/tmp/aes-refine-worktree`.

## Screenshots
- /tmp/9223-bridge.png (ERR_BLOCKED_BY_CLIENT page rendered for bridge.html
  after extension was killed)
- /tmp/9223-extensions-page.png (chrome://extensions/ showing only Google
  Docs Offline — AES not installed)
