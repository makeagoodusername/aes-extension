# fix-A14-log.md — Outcome: APPLIED

Agent: Fix-Agent 14 of 20.
Territory: `modules/aes-menu.js` (exclusive).
Brief: streamline-A4.md FIX-A4-3 / Top-rec #2 — close discoverability seam between
the AES navbar dropdown, Cmd-K command palette, and Unified Settings modal.

## Pre-flight

- Read `/tmp/aes-fix-shared.md` and `audit/streamline-A4.md` rec #2.
- Re-read `modules/aes-menu.js` (380 LOC) end-to-end before editing — confirmed
  the two recommended entries ("Open AES Settings", "Open command palette")
  are NOT already present. Claim is fresh; no REJECTED-stale.
- Verified target globals exist in the codebase:
  - `window.AesUnifiedSettings.open(opts)` defined in
    `modules/unified-settings/host.js:66-73` (proxies to `AesUnifiedSettingsShell.open`).
  - `window.AESCommandPalette.open()` defined in
    `modules/command-palette/host.js:480` and the no-op stub at
    `modules/command-palette/host.js:34` (so calls are safe even if the host
    failed to mount). Correct casing is `AESCommandPalette` (caps AES).

## Change

`modules/aes-menu.js`, content array inside `#createMenu()`. Two new entries
inserted directly after the existing "Command Bridge" launcher (still inside
the `Workspace` section, before the divider that introduces `Skin`):

```
{
    label: "Open AES Settings",
    icon: { className: "fa-cog" },
    onClick: () => {
        const us = window.AesUnifiedSettings
        if (us && typeof us.open === "function") {
            try { us.open() } catch (_) { /* noop */ }
        }
    }
},{
    label: "Open command palette",
    icon: { className: "fa-search" },
    onClick: () => {
        const cp = window.AESCommandPalette
        if (cp && typeof cp.open === "function") {
            try { cp.open() } catch (_) { /* noop */ }
        }
    }
}
```

House-style match:
- Same object literal shape as Command Bridge, Brutalist Skin, Density,
  Shortcuts entries (`label`, optional `icon`, `onClick` arrow).
- Same defensive global-feature-detect + try/catch noop pattern used by the
  existing Skin and Shortcuts handlers (e.g. `if (window.AESSiteSkin?.showShortcuts) ...`).
- Font-Awesome 4 icons consistent with rest of file (`fa-cog`, `fa-search`).
- Placed in the `Workspace` section because the audit's STREAMLINE-A4-1
  describes the three menu UIs (navbar / Cmd-K / in-hub launcher) as parallel
  workspaces; grouping them next to "Command Bridge" gives one obvious entry
  per always-on launcher.

Lines added: 16 (two object literals).
Nothing removed. Pure additive change, in line with the "ADD over REMOVE"
directive in `/tmp/aes-fix-shared.md`.

## Verification

- `node --check /Users/jihwan/Downloads/AES.v0.6.9/modules/aes-menu.js` → OK.
- No manifest touched, so no JSON validation needed.
- Re-read the patched region (lines 102–120 post-edit) and the rest of
  `#createMenu()` was untouched: the `for (const item of content)` registration
  loop and the `chrome.storage.onChanged` re-stamp of `data-aes-state` badges
  still run as before. New entries do not declare `stateLabel`, so the badge
  re-stamp pass is a no-op for them.
- Did not launch Playwright. The change is a pure additive content-array
  patch; the existing menu mount path (`tick()` → `new AESMenu(target)` at
  `aes-menu.js:367-369`) renders the new items via the unchanged
  `#createMenuItem()` factory. Risk surface is zero JS-syntax (covered by
  `node --check`) and zero runtime regression for existing items (data-only
  insertion). If the user wants a live screenshot pass, easy to do later by
  loading the extension into a Chrome instance and opening any AS page.

## Follow-ups

None inside A14 territory. Out-of-territory observations from the brief
that I did not act on (correctly — territory rules forbid it):

- FIX-A4-1: `tools-tile.js:77` and `settings-tile.js:289` still call
  `chrome.runtime.openOptionsPage()` directly instead of preferring
  `AesUnifiedSettings.open()`. Forward to whichever agent owns
  `modules/central-hub/tiles/`.
- FIX-A4-2: `unified-settings/tab-data.js:75-80` opens the legacy options
  page from inside the unified modal (circular UX). Forward to whichever
  agent owns `modules/unified-settings/`.
- STREAMLINE-A4-5: hard-coded community URLs in `aes-menu.js:163-189` could
  be moved to a constants block. Out of scope for the FIX-A4-3 directive
  (this fix is supposed to be additive-only, two entries) — leaving it.

## Outcome

APPLIED. Two entries added, static check passes, house-style preserved,
defensive feature-detect prevents errors when either global is absent.
