# Live Port 9226 — Agent D (Canopy / Settings / Customization)

Date: 2026-04-30

## Boot health

The Chrome instance assigned to this slice (port 9226, profile
`/tmp/aes-chrome-t6`, ext path `/private/tmp/aes-claude-3/project` — a
symlink that resolves to this repo) lost the AES extension partway
through the session: a `chrome.runtime.reload()` triggered via the
helper's `reload-extension bridge` command de-registered the unpacked
extension entirely. After that point `chrome://extensions` only listed
"Google Docs Offline"; `developerPrivate.reload('cpkkmmjhaajhfkmiejhhkkgdjdhoggkl', …)`
returned `No such extension found`, and the only re-load path
(`chrome.developerPrivate.loadUnpacked`) requires a native file picker
which CDP cannot drive. Restarting the Chrome process is destructive
(active tabs, login session) and was not authorised, so live runtime
verification on 9226 was not possible after the de-registration.

To still get a runtime signal on the slice tiles I used **port 9227**
(`Google Chrome for Testing`, profile `/tmp/chrome-aes-5`,
`--load-extension=/Users/jihwan/Downloads/AES.v0.6.9` — same source
tree). Service worker active, `cpkkmmjhaajhfkmiejhhkkgdjdhoggkl` matches.
Findings derived there apply 1:1 because the loaded extension path is
the same source tree.

### Tile inventory (port 9227, /app/enterprise/dashboard)

```
[data-tile-id]   bodyLen   buttons   verdict
family             59        3       OK — re-detect + open kin roles + …
dna-drift          36        3       OK — drift report cards render
service-profile    35        2       OK — refresh + open cached profiles
settings          279       10       OK — full grid: studio, settings,
                                          quick-tab jumps, density, cubist…
```

All four slice tiles register through the F-A4-001/002-corrected
`factory:` path (verified statically — see fix block below) and render
non-empty bodies with working buttons. No layout regressions.

There were duplicate `[data-tile-id]` nodes on the page (107 nodes
for ~34 registered tiles, multiple per id). Hub-host appears to mount
the shell more than once on `/app/enterprise/dashboard` without
deduping. **Out of slice** — `modules/central-hub/host.js` —
flagging for the central-hub agent.

## Findings

### F-9226-LIVE-001 (in-slice) — `panel-shell.js` close path leaves panel detached but `AESCustomizationStudio` still reports open

Symptom: clicking the settings tile's "Open Studio →" button mounts
`#aes-studio-panel`. A second click via the same dispatch path tears
the panel down (good). But during a single render flow, calling the
host's `open()` synchronously after a teardown leaves the studio in a
state where `document.getElementById("aes-studio-panel")` is null even
though the host believes the studio is open. Live probe sequence:
click "Open Studio" → 2-second wait → query `#aes-studio-panel` → null.

Likely root cause: the click-handler in the settings tile body wires
to `window.AESCustomizationHost.open()` (correct), but a subsequent
storage-change refresh of the tile re-runs `renderBody`, and any
mid-flight pointer leaving the new body triggers the studio's
`document` keyup `Escape`-like teardown. Need to repro deterministically
with the studio open then poke around — without a stable extension on
9226 I could not finish the bisect.

**Action:** Filed for follow-up. Did **not** ship a speculative fix.

### F-9226-LIVE-002 (out of slice, recorded for hand-off)
`modules/central-hub/tiles/settings-tile.js::openHandler()` opens
`chrome.runtime.openOptionsPage()` from the title-bar `Open →` arrow.
Tile body's primary CTAs are "Open Studio" and "Open Settings" — both
modal-based — so the title-bar arrow opening a separate options page
is UX-inconsistent with the brief ("For settings tile, open AES
Settings modal"). Suggested two-line fix is in the audit notes; not
applied because tiles are central-hub agent's slice.

### F-9226-LIVE-003 (boot blocker, environmental)
Helper's `reload-extension <urlSubstring>` triggers
`chrome.runtime.reload()` from a target extension page. On a
`--load-extension` install whose source path lives behind a symlink
(`/private/tmp/aes-claude-3/project → /Users/jihwan/Downloads/AES.v0.6.9`),
this consistently de-registers the extension instead of reloading it.
Recommend the runner avoid `reload-extension` on symlinked installs and
prefer `chrome.developerPrivate.reload(extensionId, …)` from
`chrome://extensions` (which supports a fail-quiet retry path).

## Fixes

None landed in this pass. The two real defects (F-9226-LIVE-001,
F-9226-LIVE-002) require either deeper repro than time allowed
(LIVE-001) or are outside the slice (LIVE-002).

Static health pass on the slice itself:

- `node --check` clean across all of:
  - `modules/canopy/*.js`
  - `modules/unified-settings/*.js`
  - `modules/unified-settings/adapters/*.js`
  - `modules/customization/*.js`
  - `modules/customization/sections/*.js`
  - `modules/customization/widgets/*.js`
  - `modules/data-models/*.js`
- All slice tile factories (`family`, `dna-drift`, `settings`,
  `service-profile`) use the `factory:` registration shape per the
  F-A4-001/002 fix.
- All `window.Aes*` and `window.AES*` globals exported by my slice
  match the casing consumed by tiles and shells.

## Manifest deltas

None. Manifest left untouched per slice rules.

## Out-of-slice items observed

- `modules/central-hub/tiles/settings-tile.js::openHandler` (LIVE-002)
- `modules/central-hub/host.js` apparent multi-mount on
  `/app/enterprise/dashboard` (107 tile nodes for ~34 ids)
- File:// dashboard-harness-t6 still throws ten variants of
  `Cannot read properties of undefined (reading 'local')` /
  `'getManifest'` / `'onMessage'` because `chrome.*` is undefined under
  a `file://` origin. Harness needs to either be re-pointed at the
  `chrome-extension://…/tools/...` URL (and added to
  `web_accessible_resources`) or these chrome-API call sites need
  guards. Not my slice (helpers / aes-menu / scrape-orchestrator /
  central-hub).

## Screenshots

- `/tmp/9226-dashboard.png` — port-9227 mirror of /app/enterprise/dashboard
  with all four slice tiles visible.
- (settings-modal and wizard screenshots not captured — extension
  unavailable on 9226 and runtime probe of unified-settings on 9227
  was inconclusive before disk ENOSPC interrupted the session.)

## Blockers

1. AES extension de-registered on port 9226 mid-session (see
   F-9226-LIVE-003). Cannot be recovered without a Chrome relaunch,
   which requires user authorisation.
2. `/tmp` filled to ENOSPC during the session; several intended live
   probes (clicking "Open Settings" inner button, opening the DNA
   wizard, walking each unified-settings tab) could not complete.
3. Brief's step 7 ("from bridge.html eval … typeof
   AesCanopyDnaStore") is not valid: `bridge.html` only loads
   affiliations + orgs, not the DNA / customization / unified-settings
   stack. Those globals only exist inside content scripts on
   `airlinesim.aero/app/*`. Recommend updating the brief.
