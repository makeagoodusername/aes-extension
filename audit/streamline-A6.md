# Streamline — Agent 6 (Conductor + Canopy + Alliance + Marketing + Customization)

Territory: 64 production JS files, 14,611 LOC across `modules/conductor` (15), `modules/canopy` (20), `modules/alliance` (3), `modules/marketing` (3), `modules/customization` (23). Manifest references: 79 entries.

Read-only audit. No production edits. Cross-checked with `audit/AGENT-3.md`, `findings-AGENT-3.md`, `CONSOLIDATION-SUMMARY.md`.

---

## KEEP

These are load-bearing, wired into apply-pipeline / tiles / bus, and have real consumers outside their own module.

| Module | Role | External consumers (count) |
|---|---|---|
| `modules/conductor/signal-layer.js` | Single chrome.storage.onChanged extractor → `conductor:signal` bus. Eight typed signals. | scrape-orchestrator/auto-driver, conductor-tile, drift-tile, conductor-trust-tile, central-hub/salience |
| `modules/conductor/signal-store.js` | 500-row ring per server:airline | shell.js (salience input) |
| `modules/conductor/scenarios.js` | 10-scenario library — conductor brain | scenario-engine, outcome-driver |
| `modules/conductor/scenario-engine.js`, `scenario-store.js` | Subscribes signals → fires | conductor-tile |
| `modules/conductor/routine-engine.js` + `routines/*` (3 routines) | Multi-step state machines spawned from fires | conductor-tile |
| `modules/conductor/trust-store.js`, `trust-driver.js`, `tier-gate.js` | K11 Beta-Bayesian trust quotient → tier ceiling | conductor-trust-tile, scenario-engine |
| `modules/conductor/drift-detector.js`, `drift-driver.js`, `threshold-store.js` | K14 CUSUM drift → demote ceiling | drift-tile, scenario-engine |
| `modules/conductor/outcome-driver.js` | K10 verdict scheduler | conductor-tile, trust-driver (`conductor:outcome:applied`) |
| `modules/canopy/affiliations-store.js` | Single source of "kin/partner/competitor" | RA panel, family-tile, command-bridge, strategy/sister-coordination, strategy/kin-handoff, UAS family-grid |
| `modules/canopy/dna-store.js` + `dna-fit-scorer.js` | L5 strategy DNA — used by 8+ external surfaces | strategy/forward-simulator, family-tile, dna-drift-tile, RA panel, UAS, settings-tile, unified-settings |
| `modules/canopy/dna-drift-detector.js`, `dna-wizard.js`, `dna-account-editor.js` | DNA UI wired into unified-settings tab-account + dna-drift-tile | unified-settings/tab-account, dna-drift-tile |
| `modules/canopy/regions-store.js`, `region-resolver.js`, `geography-base.js`, `geography-seeder.js`, `regions-settings-page.js` | Canonical region grouping — used by RA wave-registry/wave-palette + strategy fleet-store/fleet-command + sister-coordination + unified-settings | wave-registry, fleet-store, fleet-command, sister-coordination, unified-settings |
| `modules/canopy/orgs-store.js`, `roles-store.js`, `role-detector.js`, settings pages | Coalitions / role registry | command-bridge (coalitions-panel, priority-board, subsidiary-cards), settings-tile, unified-settings |
| `modules/canopy/combined-supply.js` | Pure aggregator for kin vs neutral comp | RA panel decoration |
| `modules/canopy/wave-preset-meta-store.js` | Wave-preset metadata (consumed under `AesWavePresetMetaStore`) | RA wave-registry, wave-palette |
| `modules/canopy/interline-gap-detector.js` | Pure gap detector for kin handoffs | family-tile, strategy/kin-handoff-moves |
| `modules/alliance/alliance-overview-scraper.js` | Scrapes `/app/alliance` member roster + pendingApplications | alliance-tile, hero-polyhedron, world-view-tile, world-view/recommend-alliance, scrape-orchestrator/phases, run-archive-store, strategy/context, strategy/diff-plan, strategy/remote-refresh, strategy/apply-pipeline, world-view/network-builder |
| `modules/alliance/il-request-applier.js` | Sole IL request POSTer; two-gate (applyEnabled+dryRunOnly:true default per invariant) | strategy/apply-pipeline `_applyAllianceMoves` |
| `modules/alliance/content-alliance.js` | Conditional content-script — fires only on `/app/alliance*` (manifest matches scoped) — not always-on | wired in manifest 538-543 |
| `modules/customization/store.js`, `applier.js`, `host.js`, `presets.js`, `preset-codec.js`, `token-registry.js`, `panel-shell.js`, `shortcut-registry.js` | Live-CSS-overrides cascade + Studio Panel | unified-settings/tab-customisation (renderInto), site-skin/keyboard-shortcuts (consumes shortcut-registry), settings-tile, command-palette/seed-navigation, _background/customization-store |

---

## CUT

Nothing in this territory is recommended for outright deletion. Every file in the five modules has at least one external consumer or a clear runtime role. Closest candidates that *could* be cut, with caveats:

- `modules/canopy/cubist-map.js` (437 LOC). Self-registers a Central-Hub tile; **zero outside-canopy consumers** (only manifest + harness + canopy itself). It's a visual-only "FACET overhaul" that the in-file docstring labels as a CB4 stub gated on L7. CUT-CANDIDATE if the user does not use the Cubist Map tile — but it's an isolated tile, not dead weight (it loads only on dashboard via tile registration). Decision deferred to user.

---

## FIX

Already documented carry-overs from Agent 3. None new from this audit.

| ID | File | Status |
|---|---|---|
| F-A3-002 | `modules/strategy/apply-pipeline.js:483` (out of my territory; affects alliance pattern parity) | RA pricing applier hardcoded `applyEnabled:true, dryRunOnly:false` — pricing is the only domain bypassing the user kill-switch. Out of A6 territory; flagged for visibility. |
| F-9227-002 | `modules/marketing/budget-store.js:54-80` | Cross-account legacy KEY_BASE leak. Needs the patch documented in `audit/findings.md`. **FIX needed**. |
| H-004 | `modules/conductor/{scenario,routine,signal}-store.js` | Read-modify-write race on chrome.storage. Tail-Promise queue ~10 LOC each. Listed as P1 in `CONSOLIDATION-SUMMARY.md`. **FIX needed (race regression).** |

---

## DEFER

Confirmed deferred-by-design from `AGENT-3.md` + module docstrings:

- **Conductor K14.1**: `scenarios.js` still uses hardcoded `RATIO_FLOOR`/`PROFIT_DECAY_PCT` constants instead of reading via `AesConductorThresholdStore.resolve()`. Drift-driver writes overlays; tile renders proposals; apply-gate honours them; only the scenario `match()` consumer hop is missing. Confirmed deferred per AGENT-3 brief.
- **Conductor K11.2**: `fork-store.promote()` returns `{ok:false}` because composer not shipped. Defense-in-depth `promotionEnabled:false`. Deferred-confirmed per AGENT-3.
- **Marketing Slice 19 v1**: `budget-applier.parseHtml` returns `null`; applier returns `{status:"noop", reason:"form-shape-not-yet-mapped"}`. Tuner produces advisory-only decisions (`applicable:false`). Marketing is **NOT wired into apply-pipeline** — only into `strategy/marketing-tuner.js`, which feeds `diff-plan` as advisory. The full chain ships as a stub awaiting an AS marketing-page HTML sample.
- **Canopy L6 (combined-supply)**: per-competitor weekly flight counts not exposed at per-flight level today; v1 derives counts from leaderboards. Documented v1 limitation.
- **Customization Phase 2**: per-section / per-tile / per-component cascade layers. Phase 1 is preset + global only. Sections marked `active:false`: `components`, `scopes`, `backup`. Documented in `panel-shell.js`.

---

## STREAMLINE

These are not bugs; they are reductions in surface area worth flagging.

1. **Conductor's three-routine roster carries register-once boilerplate triplicated across each routine file** (`route-profit-recovery.js:130-136`, `cash-runway-defence.js:144-150`, `maintenance-rebalance.js:118-124`). The first to load creates `window.AesConductorRoutines = {_defs, register, all}`. This is "first-loader-wins" pattern that works but is duplicated in three files. **STREAMLINE**: extract into a 10-LOC `routines/_registry.js` loaded first via manifest. Saves ~30 LOC, removes risk of drift between three implementations.

2. **Customization-Studio mount paths are fragmented**. `host.js` exposes a hotkey `g c` opener, `tab-customisation.js` calls `AESCustomizationStudio.renderInto(host)`, and `settings-tile.js` references the legacy options page. Three entry surfaces for one panel. **STREAMLINE**: pick `unified-settings` as the single home (already the case for everything else), and either deprecate the slide-out drawer or keep it as a power-user shortcut. The `g c` chord and `nav.settings`'s `g x` already overlap conceptually.

3. **Canopy's three "settings-page" subfiles** (`orgs-settings-page.js` 229 LOC, `regions-settings-page.js` 244 LOC, `roles-settings-page.js` 327 LOC) each implement a dedicated DOM page. They are wired through `unified-settings/tab-account.js` via `check`/`open` callable shape. **STREAMLINE**: these three files render very similar shapes (header, list, add/edit form). Consolidating them into one templated page-renderer would save ~400 LOC. Out of scope for streamline-pass; flagged for future consolidation.

4. **Customization sections (`color`, `theme`, `typography`, `spacing`, `motion`, `ornament`, `numerals`, `dashboard`, `keybindings`)** ship 2,028 LOC across 9 section files. Each renders Studio inputs. The dashboard section writes to `centralHub:settings` (NOT customization store), making it a special case that should arguably live with the dashboard config code, not customization. **STREAMLINE**: move `sections/dashboard.js` (257 LOC) into `modules/central-hub/` or unified-settings tabs; nothing it does is theme-related.

5. **Marketing's three-file stub trio** (budget-store + budget-scraper + budget-applier, 266 LOC total) is the entire marketing module. Until Slice 19 ships parser/form-shape, only `budget-store.js` is functional. **STREAMLINE**: Could collapse the three into one file or DEFER all three (delete from manifest content_scripts) until parsing lands. Marketing is wired into strategy/marketing-tuner.js only — nothing else reads or writes. **No urgency**: load cost is negligible (266 LOC); leaving stubs in keeps the integration contract intact.

6. **Alliance's `content-alliance.js` is 23 LOC of boilerplate** that triggers `AllianceOverviewScraper.scrape()` 1.5s after AS alliance page mount. The scraper is also called by scrape-orchestrator/phases.js. **STREAMLINE**: Since alliance content-script only matches `/app/alliance*`, this is correct — auto-refresh on visit. Keep as is. Already conditional, not always-on dead weight.

7. **"Customization" name vs role**: Module customizes design tokens (CSS vars), keybindings, presets — i.e. user preferences. It is not "customizing AS." It already integrates with unified-settings. The user prompt asks if it "could merge with unified-settings". **Recommendation**: NO merge — it's a 2,500 LOC visual cascade subsystem that unified-settings rightfully embeds; merging would just inline a tab. The `g c` slide-out drawer overlap with the unified-settings tab is the only redundancy worth pruning (see point 2).

---

## Cross-module duplication

- **DOMParser usage**: `alliance-overview-scraper.js` (3x), `il-request-applier.js` (1x). Two distinct scrapers, no duplication, no helper extraction warranted.
- **chrome.storage.onChanged listeners**: signal-layer.js (1, broadcasts), customization/store.js (1, hydrates), every canopy store (subscribed via cross-tab). Pattern is consistent — no double-listener risk found.
- **`AesConductorRoutines` registry creation**: triplicated in three routines (see STREAMLINE #1).

---

## Open questions

1. **Marketing stub urgency**: Has the user actually attempted to use marketing-budget tuning? If no, the entire `modules/marketing/**` (266 LOC) could be cut from manifest content_scripts and re-added when Slice 19 form-parser lands. Current shipped state: tuner produces advisory-only decisions that nothing applies. **Top open question.**
2. **Cubist Map tile** — does the user actually use it? If not, it's the only file in this territory that has zero non-canopy consumers (CUT candidate at 437 LOC).
3. **Conductor scenarios K14.1 wiring** — deferred per brief but the work is "replace 5 constant references with `AesConductorThresholdStore.resolve()` calls". One bounded session of work. Worth scheduling for next pass.
4. **Customization Studio's slide-out drawer (`g c`)** — keep, or deprecate now that `unified-settings/tab-customisation.js` mounts the same Studio?
5. **Canopy's three settings-page files** (orgs/regions/roles, 800 LOC) — schedule for templating consolidation, or leave?

---

## Counts

- Files audited: **64** (Conductor 15, Canopy 20, Alliance 3, Marketing 3, Customization 23)
- LOC audited: **14,611**
- KEEP: **62**
- CUT: **0** (1 candidate pending user input — `cubist-map.js`)
- FIX: **3** (1 cross-territory carry-over + 2 carry-over from prior agents — race regressions, marketing leak)
- DEFER: **5** (K11.2, K14.1, Marketing Slice 19, Canopy L6 v1, Customization Phase 2)
- STREAMLINE: **7** distinct simplifications listed
- Open questions: **5**

---

## Notes for next session

- The race fixes in conductor stores (H-004) are the highest-priority fix in this territory — they actively drop user data under concurrency.
- Conductor's structural integrity is good (Strategy does NOT depend on conductor; conductor depends on strategy bus events). They are co-equal subsystems sharing the apply-pipeline outcome bus, not Strategy-absorbing-Conductor.
- Alliance is correctly conditional (content-alliance.js scoped to `/app/alliance*`; il-request-applier ships dryRun-true; allianceMoves only fire if user has alliance via decisions). Not "always-on dead weight."
- Marketing is the most stub-heavy module: 100% of its applier path is noop. Either commit to Slice 19 parsing or cut from manifest until ready.
- Customization is a complete subsystem already integrated into unified-settings; no merge needed.
