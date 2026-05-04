# AGENT-6.md — Substrate (`_shared`, central-hub shell, site-skin, command-palette, settings)

You own the foundation that everyone else depends on. Small file count, high blast radius.

## Why this is its own territory

`_shared` modules and central-hub shell are the integration substrate — bus, view-engine, hub-feed, cleanup-registry, ttl-cache, drag-arbiter, price-diagnostics-store, surface-stamp. Everyone reads from them. A small mistake here breaks several tiles or panels at once.

## Your Chrome instance

You'll touch every page during verification:

- `/app/enterprise/dashboard*` — central-hub shell, hero strip, activity strip, tiles.
- `/app/com/scheduling*` — site-skin, command-palette, RA panel uses your bus.
- `/app/fleets*` — site-skin, AFP host uses your bus.
- Any AS page — site-skin, AES menu, command-palette.

**Lock requirement:** none. Your work is read-only against AS and the substrate stores you write to are local-only (settings, account registry, cleanup registry).

**Cross-agent coordination:** when you change anything in `data-bus-topics.js`, the bus registry, or the central-hub shell, **post in SHARED-NOTES** that you've pushed. Other agents need to reload extension to pick up your changes.

## Your scope

```
modules/_shared/
├── account-key.js
├── account-registry.js
├── data-bus.js
├── data-bus-topics.js
├── view-engine.js
├── views-registry.js
├── views/routes-fuel-context.js
├── hub-feed.js
├── drag-arbiter.js
├── price-diagnostics-store.js
├── ttl-cache.js
├── cleanup-registry.js
├── change-log-aggregator.js
├── change-log-launcher.js
├── change-log-modal.js
├── surface-stamp.js
├── migrate-legacy.js
├── settings-bridge.js
└── utils.js

modules/central-hub/
├── shell.js
├── host.js
├── tile.js
├── tile-registry.js
├── activity-strip.js
├── salience.js
├── hero-strip.js
└── feed/
    ├── index.js
    ├── cash-feed.js
    └── strategy-feed.js

modules/site-skin/
├── bootstrap.js
├── table-polish.js
├── keyboard-shortcuts.js
├── density-toggle.js
├── click-to-copy.js
└── breadcrumb.js

modules/command-palette/
├── registry.js
├── seed-navigation.js
├── seed-actions.js
├── derivers/fork-deriver.js
└── host.js

modules/unified-settings/
├── tab-account.js
└── (other tab-* files)

modules/aes-menu.js
modules/about-dialog.js
helpers.js
css/skin/*.css
css/content.css
```

## Priority audit areas

1. **Bus topic registry integrity** — `data-bus-topics.js` is the central registry. Verify:
   - Every emitted topic has a registry entry.
   - Every registered topic has at least one subscriber.
   - Recent additions per HANDOVER: `data:conductor:trust:updated`, `signal:conductor:tier:promoted`, `signal:conductor:drift`, `data:conductor:drift:proposal:created`, `data:conductor:threshold:applied`, `data:strategy:fork:created`, `data:strategy:fork:simulated`, `data:strategy:fork:promoted`. Verify all 8 present.

2. **AesCleanup boot sweep** — handover says `cleanup-registry.js` was unwired in universal block until recently. Verify:
   - `AesCleanup` global on every page.
   - Tab-side `requestIdleCallback` boot sweep on every page mount.
   - `background.js` 6h alarm sweep also runs.
   - `await window.AesCleanup.runAll({reason: "manual"})` returns array.

3. **TtlCache factory** — three consumers (RA demand-store, RA fuel-price-scraper, UAS price-history-store) fall back to null cache when factory undefined. Verify:
   - `createTtlCache` exposed on window.
   - All three actually use it.

4. **HubFeed bridge** — `feed/index.js` must wire `accounting:` → `data:accounting:weekly:saved`, `aesStrategy:plan:applied` → `data:strategy:applied:saved`, `settings` → `data:strategy:settings:saved`. Without it, hero-strip cash card and strategy-tile feed view read empty.

5. **AesAccountKey + AesAccountRegistry** — L1 canopy foundation. Verify:
   - Singleton at `window.AesAccountRegistry`.
   - `aesAccounts` storage key with single-writer rule (only `background.js` writes).
   - `currentAccountIdSync()` reads `window.__aesAccountId`.
   - `acctKey(prefix, accountId, suffix)` produces `<prefix>:acct:<id>:<suffix>` form.

6. **Command palette** — Cmd-K cross-page launcher. Verify:
   - `AESCommandRegistry` API: `register / list / dispatch / recent / subscribe`.
   - 12 seed commands (7 navigation + 5 actions).
   - Per-page scope filtering (`any` / `dashboard` / `scheduling` / `fleets` / `afp`).
   - `_isTypingTarget` matches `keyboard-shortcuts.js` exactly.
   - Recent ring cap 8, persisted at `commandPalette:recent:acct:<id>`.

7. **Site-skin + AES menu** — Verify:
   - `aes_skin_enabled` and `aes_skin_density` round-trip through `chrome.storage.sync` (only sync keys in codebase).
   - `<html data-aes-skin>` stamp lands at `document_start`.
   - AES menu's three new top items render with `stateLabel` updating live.

8. **Activity strip + briefing watermark** — both surfaces read from `aesStrategy:lastSeenAt[:acct:<id>]`. Click-to-mark-as-read advances both.

## Specific things flagged

- "Drag-affordance-store consumer wired but no UI" — Agent 4 owns AFP side. You verify store global is correct.
- "Wave-registry.js consumers — Fleet Command and rebalance proposers still don't consume it" — **deferred**.
- "HANDOVER §4 storage-key audit not refreshed after recent slices" — flag for Agent 8.

## Bus topic request batching

Watch `audit/bus-topic-requests.md`. Format:

```
## TOPIC-N — added by Agent K

Name: data:foo:bar:baz
Emitted by: modules/foo/bar.js
Subscribed by: modules/qux/quux.js
Carries: {fooId, barTimestamp}
```

Batch additions to `data-bus-topics.js` once per hour.

## Pure-function smokes

Write under `audit/tests/substrate/`:

- `data-bus.js` — emit/on/off semantics, multiple subscribers, late subscribers don't get past events.
- `view-engine.js` — declare/refresh contract.
- `ttl-cache.js` — TTL respected, eviction order correct.
- `cleanup-registry.js` — `register / list / runAll / unregister`.
- `account-key.js` — `acctKey` produces correct shape.

## Live verifications

- Open any AS page; AES menu mounts in top bar.
- Toggle Brutalist Skin off via menu; AS chrome reverts to default within ~50ms.
- Press Shift+D; density cycles comfortable ↔ compact.
- Press `?`; help popover opens.
- Press Cmd-K on dashboard; palette opens; type "stra" → "Open Strategy" highlights.
- Cmd-K on scheduling page; "Run silent-auto tick now" appears (scope-filtered).
- Cmd-K on fleets page; "Open Audit Log" filtered out (scheduling-only scope).
- Activity strip on dashboard shows "Since last visit: …" or "Quiet since last visit".
- Strategy briefing tile auto-opens once per game-week.
- Open Data-Flow Inspector tile; bus topics + cleanups panes populated.

## Forbidden

- No edits to tile files (other than central-hub shell-internal listed).
- No edits inside `modules/route-assistant/**`, `modules/strategy/**`, `modules/aircraft-flight-plan/**`.
- No edits to `manifest.json` (Agent 1).
- No edits to `background.js` or `content_*.js` (Agent 7).
- No reshape of `aesAccounts` storage key (L1 canopy invariant).
- No silent removal of any registered bus topic.

## End-of-session deliverable

`audit/findings-AGENT-6.md`:

- Bus topic registry verified — all emits matched, all subscriptions sourced.
- AesCleanup, TtlCache, HubFeed, AesAccountKey, surface-stamp, view-engine — each verified.
- Command palette: 12 commands registered, scope filtering correct.
- Site-skin sync keys round-trip.
- Activity strip + briefing watermark single-source-of-truth.
- Bus-topic-request batches applied.
- Smoke tests under `audit/tests/substrate/`.
- Live verification results.
