# Streamline — Agent 3 (Substrate)

**Territory:** `modules/_shared/**`, `helpers.js`, `css/**`, `modules/site-skin/**`, `fonts/**`, `images/**`
**Method:** read-only static analysis. No production code edited.
**Anchors:** `audit/AGENT-6.md` (prior brief), `audit/findings-AGENT-6.md`, `manifest.json`, file scans across the repo.

## Tally

| Bucket | Count |
|---|---|
| KEEP | 19 |
| CUT | 6 |
| FIX | 4 |
| DEFER | 5 |
| STREAMLINE | 5 |

Files in scope: 28 `.js` in `modules/_shared/` (29 incl. `views/routes-fuel-context.js`) + 6 in `modules/site-skin/` + 12 CSS + 2 fonts + 5 images + `helpers.js`.

---

## KEEP (load-bearing, widely consumed)

| Module | Global | External consumers | Notes |
|---|---|---|---|
| `helpers.js` | `AES.*`, `escapeHtml` | 76 files (`AES.getServerName` 20+, `escapeHtml` 83 sites, `cleanInteger` 11, `getServerDate` 10) | Universal foundation; loaded into `/app/*` + `/action/*` block. Must stay. |
| `_shared/account-registry.js` | `AesAccountRegistry`, `__aesAccountId` | bootstrapped from `helpers.js`, consumed across canopy + scopers | L1 invariant. |
| `_shared/account-scoped-key.js` | `AesAccountKey`, `acctKey()`, `acctKeyForAccount()` | 10+ stores | L2 storage-key contract. |
| `_shared/data-bus.js` | `AesDataBus` | 9+ files | Integration spine. |
| `_shared/data-bus-topics.js` | `AES_DATA_BUS_TOPICS` | docs/audit only | Registry; **see FIX-3** below. |
| `_shared/cleanup-registry.js` | `window.AesCleanup` | 4 callers + background.js sweep | Slim; OK. |
| `_shared/ttl-cache.js` | `createTtlCache` | RA demand-store, fuel-price scraper, UAS price-history | Confirmed real consumers. |
| `_shared/store-cache.js` + `_shared/write-through.js` | `AesStoreCache`, `AesWriteThrough` | RA demand-store + internal | **STREAMLINE-1** below — narrow blast radius. |
| `_shared/prefix-store.js` | `createPrefixStore` | RA type-specs + ttl-cache | OK. |
| `_shared/settings-bridge.js` | `window.AesSettings` (loaded indirectly) | 4+ consumers | OK. |
| `_shared/migrate-legacy.js` | `AesMigrateLegacy` | called only from `helpers.js` bootstrap | Single legitimate consumer; OK. |
| `_shared/drag-arbiter.js` | `AesDragArbiter` | AFP + fleet-schedule-grid | OK. |
| `_shared/fleet-roster.js` | `AesFleetRoster` | route-launcher, canvas, canopy | OK. |
| `_shared/handoff-store.js` | `AesHandoffStore` | RA panel, AFP wave-applier, schedule-management, canvas, fleet-grid | OK. |
| `_shared/aircraft-spec.js` | `AesAircraftSpec` | fleet-schedule-grid, AFP fleet-picker-modal | OK. |
| `_shared/price-diagnostics-store.js` | `AesPriceDiagnostics` | 3 RA + strategy callers | OK. |
| `_shared/view-engine.js` + `_shared/hub-feed.js` | `AesView`, `HubFeed` | central-hub feed slices, dashboard tiles | OK; verified deps wiring. |
| `_shared/views/routes-fuel-context.js` | view declaration | view-engine subscribes via `deps:` | Currently the only declared view; **STREAMLINE-2**. |
| `_shared/surface-stamp.js` | `AesSurface` | customization/sections/spacing.js + self | OK (small). |
| `_shared/change-log-aggregator.js` + `_shared/change-log-modal.js` | `AesChangeLog*` | RA panel, briefing tile, weekly-review tile, competitor-intel | OK; load-bearing. |
| `site-skin/bootstrap.js` | `AESSiteSkin` | runs at `document_start`; powers entire skin | KEEP — but see CUT-2 for tightening. |
| `site-skin/keyboard-shortcuts.js` | (delegated) | wired through `AESShortcutRegistry` | KEEP. |
| `site-skin/click-to-copy.js`, `density-toggle.js`, `breadcrumb.js`, `table-polish.js` | DOM observers | low-risk QOL polish | KEEP (slim; total 755 LOC across 6 files). |
| `css/design-tokens.css` (95KB) | tokens + base64 fonts | loaded everywhere | KEEP, but see CUT-3 (the inlined fonts make `fonts/` redundant). |
| `css/components.css`, `css/content.css`, `css/cubist.css`, `css/cubist-a11y.css`, `css/skin/skin-art-deco.css`, `css/skin/skin-global.css` | base + skin styles | manifest content_scripts | KEEP. |
| `css/command-bridge.css` | `bridge.html` only | KEEP — used by the dedicated bridge page; not loaded as content_script. |
| `images/AES-logo-{16,32,48,128,256}.png` | manifest icons + `web_accessible_resources` | KEEP — all 5 used. |

---

## CUT (orphans — no real consumer)

### CUT-1 — `_shared/aircraft-context.js` (148 LOC — `AesAircraftContext`)
File-only consumer (the global is referenced exclusively inside its own definition). Authored as a "Track 8 slice 8b" facade for a future panel. **Loaded on every AFP page; never instantiated.** Drop the manifest entry and the file unless the AFP host adopts it (Agent 4 territory).

### CUT-2 — `_shared/views-registry.js` (51 LOC — `AES_VIEWS`)
Documentation array; literally no `.js` outside the file references `AES_VIEWS`. The accompanying view (`routes-fuel-context.js`) self-declares against `AesView.declare(...)`. The "registry" is decorative.

### CUT-3 — `_shared/change-log-launcher.js` (~360 LOC; `AesChangeLogLauncher`)
The floating bottom-left 📜 button. The global is set but the only places that read it back are `change-log-launcher.js` itself. The RA panel and competitor-intel views call `AesChangeLogModal.open()` directly. Removing the file (and its manifest entry) drops a 360-LOC IIFE that paints a button on every AS page.

If the user wants the floating launcher to remain, it works as-is. If the goal is to streamline, this is the largest single CUT in `_shared/`.

### CUT-4 — Speculative LLM-tool layer: `_shared/read.js` (540 LOC), `_shared/tools.js` (240 LOC), `_shared/vision.js` (98 LOC) — **~880 LOC**
- `AesRead` — only consumer is `tools.js` itself.
- `AesTools` — only consumer is `tools.js` itself.
- `AesVision` — only consumer is `tools.js`.
The trio is the documented foundation for the deferred "Slice 28 LLM co-pilot" + "Slice 30 public read-only API." None of those features ship in v0.6.x. The modules load on every page but no surface invokes them.

**Recommend:** move all three out of the universal block to a separate manifest entry gated on a feature flag, OR delete and re-add with the LLM slice. Today they pay full load cost for zero usage.

### CUT-5 — `fonts/InterTight.woff2` + `fonts/JetBrainsMono-Regular.woff2` (66 KB)
The fonts are **inlined as base64** inside `design-tokens.css` (confirmed in source comments: *"Inlined as base64 data URIs because Chrome MV3 resolves url()"*). The standalone `.woff2` files in `fonts/` are kept *"for any future need"* per the design-tokens header. Net: 66 KB of unreferenced repo weight; the `web_accessible_resources` `/fonts/*` entry can be removed too.

### CUT-6 — `_shared/data-bus-topics.js` topics with no subscriber (registry-only)
Verified zero consumer outside the registry file:
- `data:settings:area:saved`
- `data:route-assistant:demand:saved`
- `data:scanner:price-history:appended`
- `data:crewMgmt:staffOverview:saved`
- `data:route-assistant:serviceProfile:updated` / `:ors:updated` / `:schedule:updated` / `:airportOverview:updated` / `:pricing:applied` / `:serviceProfile:applied`
- `data:afp:maintenance:updated`, `data:afp:flightLog:appended`
- `data:accounting:snapshot:updated`
- `data:strategy:dispatch:pending`
- `data:strategy:layered:{division,family,fleet,route-extras}-changed`
- `signal:strategy:wear-pressure`

These are *emitted* by stores but no code subscribes (no `AesDataBus.on`, no `deps:` array). Either prune the producer-side emit or remove the registry stub. **Note:** Agent 6 already partially addressed this in `c7b08b5` — the inverse problem (emit without registry entry); the listener-side gaps remain.

---

## FIX (small, in-territory bugs)

### FIX-1 — Duplicated `_num` / `_clamp` / `_formatMoney` helpers (~40 local copies in `modules/strategy/**`)
`AesUtils` (in `_shared/utils.js`) provides `_num/_clamp/_pct/_debounce/_throttle/_formatMoney/_formatDateRel`. Despite this, ~40 files redefine `function _num(v, f)` locally — see `modules/strategy/{alliance, allocate-fleet, backtest, briefing, …}.js`. `AesUtils` itself is consumed by only 4 external files (`activity-strip`, `congestion`, `diff-plan`, `objective`).

The intended migration (per `_shared/utils.js` docstring: *"future migrations can replace those copies one file at a time"*) has stalled. Either:
- Cut `_shared/utils.js` (no real adoption), OR
- Land the migration sweep across strategy/ to reduce duplication.

This is cross-territory work (Agent 4/Strategy owns `modules/strategy/**`); flag for them.

### FIX-2 — `helpers.js` global `class AES` namespace collision risk
`helpers.js` declares `class AES` at the global scope (line 2) — survives because it's the first content_script in the universal block. Any later module that does `class AES { … }` would silently re-declare. Mild invariant risk, no current bug; document in §10 invariants if not already.

### FIX-3 — `data-bus-topics.js` docstring still says *"Canonical topic registry for AesDataBus"* but ~30 of the 45 entries are emitted on `CentralHubBus`
Agent 6's F-AGENT6-003 (open question) — same finding. Repeat here because it falls in this territory and is unresolved. Either rename to "shared bus topic registry" with a per-entry `bus:` field, or split into `databus-topics.js` + `centralhub-topics.js`. Pure documentation drift; no behaviour change.

### FIX-4 — Stale comment in `helpers.js`
Line 224–230 has a commented-out validation block (`// const isExpectedFormat = …`) with a `// TODO: create separate function for cleaning currency values`. This TODO is six months old and `AES.cleanInteger` has 11 callers all passing arbitrary strings; the dead code is just visual noise.

---

## DEFER (intentional half-features per HANDOVER §1 deferral list)

1. **`AES_VIEWS` registry expansion** — only `routes:fuel-context` declared; the file lists 5 reserved future views. Per deferral list, expansion ships with later strategy slices.
2. **`AesAircraftContext` adoption** — the AFP host doesn't use it yet. Track 8 slice 8d will allegedly replace the spec lookup. (Hence CUT-1 is conditional on confirming it's not "deferred-by-design.")
3. **`AesRead` / `AesTools` / `AesVision`** — Slice 28/30 deferrals. CUT-4 is a streamline recommendation if those slices stay deferred. If the user wants them live within the next session, leave alone.
4. **`drag-affordance-store` consumer + `wave-registry` consumers** — already noted by Agent 6 as deferred.
5. **`signal:strategy:wear-pressure` emit** — wired but consumer is gated behind a deferred Strategy v2 slice; HANDOVER notes it.

---

## STREAMLINE (consolidation opportunities, no urgency)

### STREAMLINE-1 — Consolidate `store-cache.js` + `write-through.js` into one module
Both are tiny (~6.5 KB + ~8.5 KB). Single external consumer (`route-assistant/demand-store.js` for `AesWriteThrough`; `AesStoreCache` only used by `write-through` itself). Could merge into `_shared/storage.js` with a single `AesStorage.{getMem, setMem, write, remove}` surface.

### STREAMLINE-2 — Page-scope the per-section skin CSS
`css/skin/skin-finance.css`, `skin-fleet.css`, `skin-schedule.css`, `skin-info.css`, `skin-ops.css` are loaded on **every** content_script entry (~869). They could be scoped via separate `content_scripts` blocks matching the relevant URL patterns (Agent 1 territory). Net win: ~13 KB saved on every non-matching page.

### STREAMLINE-3 — `tools.js` registers 7 tools that are themselves orphans
Vision.captureTab, vision.frameOf, bus.auditTopics, bus.history, bus.stats, gameTime.read, gameTime.getLastSeen, meta.listTools. Useful for DevTools poking but no production surface invokes them. If CUT-4 (drop the LLM trio) lands, drop the tool registrations too.

### STREAMLINE-4 — `helpers.js` `class AES` could move into `_shared/`
`helpers.js` lives at repo root for legacy reasons. Migrating it to `modules/_shared/legacy-helpers.js` (renaming the class to `AesLegacy` with a `window.AES = AesLegacy` alias) tightens the substrate boundary. Cross-cutting; would require touching all 76 consumer files (DEFER scale).

### STREAMLINE-5 — `data-bus-topics.js` is 370 LOC of pure documentation
At its current size + density (45 topics, 9 KB minified), the registry is fine. If CUT-6 lands (drop ~12 listener-less entries), it shrinks to ~33 entries / ~250 LOC. Already-good; minor.

---

## Open questions (top first)

1. **Is the "Slice 28/30 LLM co-pilot" being abandoned, deferred, or imminent?**
   `_shared/read.js` + `tools.js` + `vision.js` total ~880 LOC loaded on every page with zero current consumers. If deferred indefinitely, CUT-4 saves the most weight (~25 KB JS) of any single recommendation. If the next session ships Slice 28, leave alone.

2. **Should `AesAircraftContext` (CUT-1) be cut or kept as a forward-compatible facade?**
   Brief AGENT-6.md doesn't mention it. The "Track 8 slice 8b" reference is internal-only.

3. **Resolution on F-AGENT6-003** (cross-bus registry docstring drift) — repeat from prior brief; unblocks `data-bus-topics.js` cleanup.

4. **`AESSiteSkin.handleInvalidatedContext`** — fires `location.reload()` on extension context invalidation. Aggressive; can clobber unsaved AS form state. Confirm intentional; otherwise STREAMLINE-target this with a softer reload prompt.

5. **`change-log-launcher.js` retention.** Floating button on every page; redundant with RA panel button on scheduling pages and competitor-intel modal entry. CUT or KEEP at user preference.

---

## Recommended action order (smallest-blast-radius first)

1. CUT-5 (delete `fonts/*.woff2`, drop `/fonts/*` from `web_accessible_resources`) — pure repo-weight reduction, zero risk.
2. FIX-4 (remove stale `helpers.js` TODO/comment block) — cosmetic.
3. CUT-2 (`views-registry.js`) — single 51-LOC documentation file.
4. CUT-6 (prune listener-less `data-bus-topics.js` entries) — registry hygiene; coordinate with Agent 6.
5. CUT-1 / CUT-3 — pending answers to open questions 1 + 2.
6. CUT-4 — pending answer to open question 1.
7. STREAMLINE-2 — coordinate manifest change with Agent 1.
8. FIX-1 — coordinate strategy-helper sweep with Agent 4.
