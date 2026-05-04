# streamline-A4.md — Hub Shell + Tiles + Command Palette + Unified Settings

Agent 4 streamline pass.
Territory:
- `modules/central-hub/**` (shell, host, tile, tile-registry, activity-strip, salience, feed, hero-strip, hero-polyhedron, cascade-pane, recents-rail, pin-affordance, status-badges, tile-section-overrider, settings-store, nav, legacy-bridge, bus, all 40 tiles)
- `modules/command-palette/**`
- `modules/unified-settings/**`
- `modules/aes-menu.js`

Read-only. No production edits.

---

## Numbers at a glance

| Metric | Value |
|---|---|
| Tile files | 40 (all in `modules/central-hub/tiles/`) |
| Tiles registered with `CentralHubTileRegistry` | 40 / 40 (every file calls `register({id,section,priority,factory})`) |
| Tile entries in `manifest.json` (dashboard block) | 40 unique paths |
| Orphaned tiles (file present, never registered or never manifest-loaded) | 0 |
| `CentralHubBus` `emit()` call sites | 99 across 31 files |
| `CentralHubBus` `on()` call sites | 36 across 16 files |
| Cross-territory bus consumers (canvas, RA, fleet-hub, conductor, canopy, AFP) | 25+ files outside this territory |
| Command-palette commands seeded | 12 (5 actions + 7 navigation) + 4 derivers (tiles, sections, hotkeys legend, fork) |
| Unified-settings module adapters wired | 6 (RA, Strategy, AFP, Fleet Command, Schedule Mgmt, Competitor Intel) |
| Distinct "settings" UI surfaces | 4 — `aes-menu.js`, `unified-settings` modal, `customization` studio, legacy `options.html` |
| Distinct "menu" UI surfaces | 3 — `aes-menu.js` (navbar dropdown), `command-palette` (Cmd-K), `tools-tile`/`settings-tile` (in-hub launchers) |
| Hero variants | 2 — `hero-strip` (default) + `hero-polyhedron` (cubist-mode opt-in, defaults OFF) |
| Layout modes | 2 — classic (default) + cascade (opt-in, prompted) |
| Settings tabs in unified-settings | 5 (Customisation, Modules, Account, Data, About) |
| Lines in territory | ~7,744 (substrate ex-tiles) + 14,732 (tiles) = ~22,500 LOC |

---

## KEEP

These are load-bearing. Do not cut.

- `modules/central-hub/shell.js` (1159 LOC) — orchestrates topbar, layout selector, mounts hero/activity/section/cascade. Heavy but every block is wired.
- `modules/central-hub/host.js` (78 LOC) — bootstrap with subframe guard (F-9224-LIVE-001 fix); concise.
- `modules/central-hub/bus.js` (69 LOC) — `CentralHubBus` is **load-bearing**: 99 emits across 31 files including canvas, route-assistant, fleet-hub, conductor, canopy, AFP. Single-record `replay()` lets late-mounting tiles recover open-tile intent. NOT a passthrough.
- `modules/central-hub/tile-registry.js` (46 LOC) — minimal static registry; every one of 40 tiles uses it. Cannot cut.
- `modules/central-hub/tile.js` (578 LOC) — base class; every tile extends it. Keep.
- `modules/central-hub/nav.js`, `salience.js`, `recents-rail.js`, `pin-affordance.js`, `cascade-pane.js`, `tile-section-overrider.js` — all consumed by `shell.js` and have user-visible effects.
- `modules/central-hub/activity-strip.js` (257 LOC) — wired in `shell.js:223`, reads `aesStrategy:lastSeenAt` watermark; user-visible "since last visit" sentence above hero strip. Shared single-source-of-truth with strategy-briefing-tile (verified per AGENT-6 finding F-AGENT6-009). Keep.
- `modules/central-hub/hero-strip.js` (606 LOC) — default hero. Wired in `shell.js:238`. Keep.
- `modules/central-hub/feed/{index,cash-feed,strategy-feed}.js` — HubFeed bridge; cash-feed is consumed by hero-strip's "Cash" card via `feedSlice: "hub:cash:weekly"`. Keep.
- `modules/central-hub/settings-store.js` — `CentralHubSettings` central settings (layoutMode, pins, recents, salience weights, cubist toggles). 14+ consumers. Keep.
- `modules/command-palette/{registry,host,seed-navigation,seed-actions,api,legend}.js` — all wired. Cmd-K UX is intentional and small.
- `modules/command-palette/derivers/{tiles,sections,hotkeys,fork-deriver}.js` — auto-derive palette commands from tile registry, nav sections, shortcuts, fork store. Tiny, pure, additive. Keep.
- `modules/aes-menu.js` (380 LOC) — top-of-AS-navbar dropdown ("AES"). Single discoverable entry on every AS page; user-visible since extension first ships. Mounts `Workspace`/`Skin`/`Community`/`Support` items. Triggers Command Bridge (`aes:bridge:open`), site-skin toggle, density cycle, shortcuts, About. Distinct purpose from Cmd-K. Keep.
- `modules/unified-settings/{host,registry,shell,tab-customisation,tab-modules,tab-account,tab-data,tab-about}.js` — only modal that **consolidates** Customisation Studio + per-module adapters + Account (canopy) + Data (export/import) + About into one surface. Six adapters land. Keep — this IS the consolidation, see CUT/STREAMLINE notes below for what it replaced.
- `modules/unified-settings/adapters/*.js` (6 files: AFP, Strategy, RA, Fleet Command, Schedule Mgmt, Competitor Intel) — each module's settings page is now mounted *inside* the unified modal. This is the consolidation pattern working as designed. Keep.

---

## CUT

These are good candidates for removal/de-prioritisation.

### CUT-A4-1 — `modules/central-hub/legacy-bridge.js` (38 LOC)
File documents itself: *"After CH-4 cutover the dropdown won't exist; this helper becomes inert."* The legacy `<select id="aes-select-dashboard-main">` is no longer present in the live dashboard (CH-4 cutover happened). `CentralHubLegacy.switchDropdownTo()` is **never called** anywhere in `modules/**`. `hasLegacy()` is **never called** either. The file is a no-op but still ships in manifest line 237.

Recommendation: **CUT** the file + manifest entry. Saves one network round-trip on dashboard load.

### CUT-A4-2 — `popup.html` + `popup.js` (70 + 10 LOC)
Out-of-territory but adjacent: `popup.js` only has one button — "Open options" — that calls `chrome.runtime.openOptionsPage()`. That's it. The toolbar popup duplicates one entry from `aes-menu.js` and one entry from `unified-settings/tab-data.js` (both already say "Open options page →"). Forward to Agent 7.

Recommendation: leave for Agent 7 (out of A4 territory) but flag.

### CUT-A4-3 — Reduce duplicate "open settings" CTAs
The settings-tile body now renders FIVE separate CTAs to enter settings UI: Customization Studio button, Unified Settings button, then 5 quick-jump tab buttons (customisation/modules/account/data/about), then 3 canopy sub-page buttons (Orgs/Regions/Roles). The fall-through grid (lines 164–328) is *only reached when `window.AesUnifiedSettings` is undefined* — which on shipped manifest never happens because unified-settings is always loaded.

Recommendation: **CUT the legacy fall-through grid** (lines 164–328 of `settings-tile.js`); it's dead code in shipped builds. Out-of-tile-territory edit but obvious dead code worth flagging.

---

## FIX

Real bugs / drift in territory.

### FIX-A4-1 — `tools-tile.js` and `settings-tile.js` both call `chrome.runtime.openOptionsPage()` directly
Both bypass the unified-settings preference. `tools-tile.js:77` and `settings-tile.js:289` open the legacy options page, while `settings-tile.js:25` correctly prefers `AesUnifiedSettings.open()`. Inconsistent within the same file.

### FIX-A4-2 — `unified-settings/tab-data.js:75-80` also opens legacy options page
Within the *unified* settings modal, the Data tab has an "Open options page →" button that calls `chrome.runtime.openOptionsPage()`. So unified-settings → opens legacy options. This is a circular UX seam: unified is supposed to be the consolidator. Either:
- (a) inline a Storage Inspector tab inside unified-settings, replacing the link; or
- (b) accept that unified-settings is an outer shell and rename the legacy options.html to "Data Inspector" cleanly.

### FIX-A4-3 — `aes-menu.js` does not link to Unified Settings or Cmd-K
The AES navbar menu surfaces Workspace/Skin/Community/Support but **does not** offer "Open AES Settings" or "Open command palette". The user has to know about the keyboard shortcuts (`g x`, Cmd-K) to find them. Adding two menu entries (`Open AES Settings` → `AesUnifiedSettings.open()`, `Open command palette` → `AESCommandPalette.open()`) closes the discoverability gap without adding complexity.

### FIX-A4-4 — `tile-section-overrider.js` is loaded but on a kill-switch defaulted OFF
`shell.js:759-762` uses it iff `settings.tileSectionOverridesEnabled === true`. The default is `false`. There's no UI to flip it (no settings adapter exposes the toggle). Either ship UI in `unified-settings/tab-customisation` to expose it, or the file is dead until the user manually edits storage.

### FIX-A4-5 — Cascade prompt logic is permanently active even after dismissal
`shell.js:90-161` — `_maybePromptCascade` re-prompts after 60 days even after the user explicitly chose "Not now". The dismiss writes only `cascadePromptedAt`, never a "rejected" flag. This will spam users every 60 days. Should add a `cascadeRejectedPermanently` flag or a "Don't ask again" button.

### FIX-A4-6 — Hero polyhedron is shipped but gated entirely behind `cubistMode`
`hero-polyhedron.js` (709 LOC) only renders when `settings.cubistMode === true`. Default is `false` and there's a confirm prompt to even enable it. Either:
- (a) commit to cubist as a real polish path and remove the gate prompt; or
- (b) recognize that 709 LOC of opt-in experimental UI behind a confirm dialog is **DEFER candidate** (see DEFER-A4-2 below).

---

## DEFER

These are intentional half-features worth leaving alone for now.

### DEFER-A4-1 — Cascade layout (slice CH-W1 → CH-W5)
`layoutMode: "cascade"` has 5 slices' worth of code (`cascade-pane.js`, salience scorer in `salience.js`, topic-chip strip, projection migration). It's opt-in via topbar toggle and a one-time prompt. HANDOVER documents this as the future direction. Currently shipped as preview behind the toggle. Keep deferred — don't delete, don't promote to default.

### DEFER-A4-2 — Cubist Mode + Hero Polyhedron + Color-blind patterns
Three-feature bundle (`cubistMode`, `cubistMotion`, `cubistColorBlind`) gated by an explicit confirm dialog (`settings-tile.js:212-220`). Per HANDOVER §4.18 ("no silent default flips"), defaults must be `false`. This whole CB0–CB6 polish set is a long-running design exploration. ~750 LOC across `hero-polyhedron.js` + cubist toggles. Defer — but when the cubist exploration concludes (ship or kill), revisit.

### DEFER-A4-3 — `tile-section-overrider` UI exposure
The kill-switch + map are wired in shell, but no settings UI exposes the controls. Either ship a section-override editor in `tab-customisation` or remove the engine. Defer until Q3 cascade-vs-classic decision.

### DEFER-A4-4 — `pin-affordance.js` cycle: pinned → pinned-full-width
CH-W4 long-press / shift-click cycle to "full-width pin" works, but there's no test of whether users discover this. Tooltip-only discoverability. Defer.

### DEFER-A4-5 — `unified-settings/tab-modules.js` empty-state when zero adapters
Shows "No module adapters registered yet." Six adapters land via manifest, so the empty state is never seen in shipped builds — but the path exists for legacy installs. Defer-confirmed.

---

## STREAMLINE

Code that works but could be smaller / clearer.

### STREAMLINE-A4-1 — Three menu UIs, partial overlap, no single map
- `aes-menu.js` (navbar dropdown, every AS page)
- `AESCommandPalette` (Cmd-K, every AS page after substrate loads)
- `tools-tile` + `settings-tile` (dashboard-only in-hub launcher)

Each has a different mental model. The command palette is the only one with auto-discovery (tile deriver). AES menu is the only one always visible without keyboard. Tiles are the only one giving inline status badges.

Recommendation: **document the three-menu model explicitly** in HANDOVER; do not collapse, but cross-link. Adding one line to `aes-menu.js` content array — `{label: "Command palette (⌘K)", onClick: () => AESCommandPalette.open()}` — closes the keyboard-shy discoverability gap (see FIX-A4-3).

### STREAMLINE-A4-2 — Tile section taxonomy creep
`CentralHubSettings.SECTIONS` declares: `["fleet", "routes", "operations", "finance", "tools"]`. But:
- `service-profile-tile`, `station-automation-tile`, `crew-management-tile`, `alliance-tile` were moved from `tools` → `operations` per CH-5b note in `settings-store.js:73-75`.
- 40 tiles spread across these 5 sections produces an average 8 tiles/section. The Tools section is now a catch-all dumping ground (`general-tile`, `tools-tile`, `diagnostics-tile`, `data-flow-inspector-tile`, `settings-tile`).

Recommendation: audit the per-tile `section` field in each file (40 tiles, 1 line each) and rebalance / collapse `Tools` into `Settings + Diagnostics`. Out-of-A4-tile-territory but visible from registry.

### STREAMLINE-A4-3 — `settings-tile.js` body is doing too much
730 LOC body for one tile. Every CTA is a stub for an external screen (Studio, Unified Settings, Orgs, Regions, Roles, Data Inspector). The tile is essentially a launcher menu rendered as a grid. Could be ~150 LOC if simplified to two CTAs ("Open AES Settings", "Open Studio") + a single status-badge row.

### STREAMLINE-A4-4 — Two cubist hero variants behind one bool
`hero-strip.js` is the default; `hero-polyhedron.js` is the cubist variant. Selection happens at `shell.js:231-244`. Both expose roughly the same 6 KPI cards. The polyhedron is purely cosmetic. If FACET / cubist exploration is committed-to, share the resolver layer between the two heroes and split only the rendering.

### STREAMLINE-A4-5 — `aes-menu.js` Forum/Discord/GitHub/Handbook URLs hard-coded inline
Lines 145–171. Move to one constant block at top of file or to `data-bus-topics`-style constants module so updates don't require touching layout code.

### STREAMLINE-A4-6 — Command palette has 4 derivers + 2 seeds + 1 host + 1 registry + 1 api + 1 legend = 9 files for ~12 commands
The seeds + derivers are clean. The split between `host.js` (UI), `registry.js` (state), and `api.js` (facade that re-exports `registry.register` onto `AESCommandPalette`) is more layers than the surface needs. Could fold `api.js` into `host.js` (~88 LOC saved) without losing structure.

### STREAMLINE-A4-7 — `unified-settings` "Modules" tab vs adapters split
The Modules tab dynamically lists adapters from registry and mounts them. Each adapter file (~50–365 LOC) re-implements its module's settings panel inside the modal, often by *creating a second mount path* over an already-mounted in-page settings panel. Where the per-module already has a settings page (e.g. RA), the adapter is essentially a redirect + duplicate mount path. Where it doesn't (e.g. AFP), the adapter IS the settings page. Inconsistent.

Recommendation: agree on one rule — every module's "settings UI" lives ONLY inside its unified-settings adapter, accessed via `AesUnifiedSettings.open({moduleId: "..."})`. Per-module in-page panels become render targets only.

### STREAMLINE-A4-8 — Empty-state fall-throughs in shell.js
`shell.js:822-835` renders "No tiles registered for this section yet." Cannot be hit in shipped builds (40 tiles span all 5 sections). Dead path; could be removed.

---

## Open questions (for the user)

1. **Q-A4-1 — Cubist Mode strategic decision.** ~750 LOC of opt-in experimental UI gated behind an explicit user-confirm prompt. Is this an active design path the user plans to ship, or scaffolding from a paused exploration? If paused: candidate for full removal in v0.7.0.

2. **Q-A4-2 — `unified-settings` adapters vs. per-module settings panels.** Six modules ship adapters that effectively re-mount their existing settings panels inside the modal. Should the unified modal be the **only** entry to settings (per-module panels become inert) or the **secondary** entry (per-module remains primary)? Both routes need the same code; only the docs and discovery story change.

3. **Q-A4-3 — Cascade layout commitment.** Topbar selector exists; default is classic. Cascade is feature-flagged via `layoutMode`. If cascade is the long-term direction, when does the prompt promote to "the new default"? If it isn't, why is it shipped at all?

4. **Q-A4-4 — `aes-menu.js` discoverability addition.** Adding two entries (`Open AES Settings`, `Open command palette`) is a two-line change but lands in territory shared by Agent 6 and is user-facing. OK to land?

5. **Q-A4-5 — `legacy-bridge.js` removal.** Confirmed dead. May I cut?

---

## Top 3 recommendations

1. **Cut `modules/central-hub/legacy-bridge.js`** + manifest entry. Confirmed-dead post-CH-4 cutover. Trivial win.
2. **Add two entries to `aes-menu.js`** (`Open AES Settings` → `AesUnifiedSettings.open()`, `Open command palette` → `AESCommandPalette.open()`). Closes the discoverability seam between the navbar menu, Cmd-K, and the modal — biggest UX win in the territory.
3. **Decide cubist vs no-cubist** (Q-A4-1). 750 LOC + a confirm prompt + 4 settings flags in chrome.storage hangs on this single product call.

---

## Top open question

**Q-A4-1: Is Cubist Mode (FACET) an active design path or paused scaffolding?** This decision unlocks ~750 LOC of cleanup AND determines whether `hero-polyhedron`, three settings flags (`cubistMode`/`cubistMotion`/`cubistColorBlind`), and the `_applyCubistMode` shell hook stay or go. No technical work blocks on it; only a product call.
