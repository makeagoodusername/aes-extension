# AES Streamline Synthesis — 12-Agent Sweep

**Scope:** All 12 territory reports (`streamline-A1.md` through `streamline-A12.md`) consolidated into one decision document.

**Headline:** AES is largely well-structured. Strategy core, AFP, Fleet-hub, Route Assistant, and Central-hub tiles are all clean (zero cuts in those territories). The bulk of the streamline opportunity sits in **four product decisions** the user controls, plus **mechanical hygiene** an agent can land in a single session.

---

## 1. Single-decision unlocks (user input gates everything)

These four product decisions, taken together, unlock ~2,400+ LOC of cuts and end ambiguity in three subsystems. Each is one binary call.

| # | Decision | What it unlocks | Where the LOC sits |
|---|---|---|---|
| **D1** | **LLM co-pilot — abandoned, deferred, or imminent?** | ~880 LOC + load cost on every page | `_shared/read.js` (540) + `tools.js` (240) + `vision.js` (98), plus `data-models/vision-capture.js` (47) |
| **D2** | **Cubist Mode (FACET) — ship or kill?** | ~1,187 LOC | `central-hub/hero-polyhedron.js` (709) + 3 `cubist*` settings flags + shell hook + confirm prompt + `canopy/cubist-map.js` (437) |
| **D3** | **Marketing module — commit to Slice 19 parser, or cut from manifest until ready?** | 266 LOC out of every-page load | `modules/marketing/**` (budget-applier returns `noop`, scraper returns `null`, not wired into apply-pipeline) |
| **D4** | **`fleet-schedule-grid` vs. `canvas` — two permanent surfaces or transition?** | Cleanup direction for one entire UI | Adjacent buttons launched from `fleet-schedule-grid/host.js`. If transition, which becomes default? |

Plus two smaller product calls:
- **D5** — `content_personelManagement.js` reachable today? Determines whether the dryRunOnly-bypass fix is a 1-line manifest edit or a multi-file dashboard-tab refactor.
- **D6** — `0.78CUSTOM/aes-cc{1..8}` + `aes-cx{1..8}` (16 sibling forks, each its own `.git`) — transient multi-Chrome harness clones, or unpushed experimental work? Without input these can't be classified past DEFER.

---

## 2. Mechanical hygiene (no decisions needed — green-light land)

These can be landed in a single session by a single agent without product input.

### 2.1 Manifest cleanup (A1's territory)
- **CUT 11 duplicate manifest js-entries** — 7 strict-subset dups (b6+b9 vs universal b1: `settings-bridge`, `dna-store`, `dna-fit-scorer`, `affiliations-store`, `combined-supply`) + 2 cross-block on-page dups (`schedule-store` in b19, `settings-extension` between b20/b27). Silent today via idempotent guards but they're the literal regression vector §10 calls out.
- **FIX-1** — add `host.js` + `route-candidates.js` + `wave-applier.js` to manifest block 20 in §10 order. Closes the named invariant and lets A8 retire ~80 LoC of `_attach`/`whenReady` retry shims in `spec-resolver.js` / `audit-log.js` / `route-candidates.js` / `wave-applier.js`.
- **FIX-2** — swap `journal-store.js` ahead of `learn.js` in blocks 5 and 27 (one-line each).

### 2.2 File-level cuts (no risk)
- `manifest.fingerprint` (66B, Jun 2024, zero references) — A2
- `_shared/change-log-launcher.js` (~360 LOC IIFE, global never read; consumers call `AesChangeLogModal.open()` directly) — A3
- `central-hub/legacy-bridge.js` (38 LOC, post-CH-4 dead, the legacy `<select>` no longer exists) — A4
- `world-view-tile.js:453-467` (`_renderRecommendationsPlaceholder` 15-line branch — never fires, manifest always loads `WorldViewRecommendationsPane`) — A10
- `data-models/flight-data.js:31-79` (49-line `FlightDataExample` literal, never instantiated) — A11
- `fonts/InterTight.woff2` + `fonts/JetBrainsMono-Regular.woff2` (66KB) — both already inlined as base64 in `design-tokens.css`; standalone files explicitly retained "for future need" — A3

### 2.3 Two-line wiring fixes
- Add to `aes-menu.js`: "Open AES Settings" → `AesUnifiedSettings.open()`, "Open command palette" → `AESCommandPalette.open()`. Closes the discoverability seam between three menu surfaces. — A4
- Fix `Repo root:` line in `HANDOVER.md:7` and `MANUAL.md:5` (both hardcode the moved `/Users/jihwan/Downloads/AES.v0.6.9-beta/` path that broke the 17 worktrees). — A12

### 2.4 Worktree cleanup
- `git worktree prune` + `rm -rf aes-worktrees/` — all 17 dirs are already prunable (broken `.git` pointers). ~62 MB. Branches preserved in main repo refs and `origin/slice/...`. **Run only after user confirm.** — A12

### 2.5 Bug fixes (in-territory, low risk)
- **F4-011** — wrap `aircraft-flight-plan/schedule-store.js` in idempotent IIFE guard (~6 LoC). Manifest blocks 19+27 load it twice on `/app/fleets/aircraft/*/1*` — second load throws SyntaxError, kills the rest of block 27. *(Ideally land alongside the §2.1 manifest dup-cut so the underlying cause is also gone.)* — A8
- **forward-simulator._decay** mutates `fork.snapshot` in place across re-runs, breaking the "deterministic projection" doc-string (F-A3-007). — A5
- **Conductor stores race** — `scenario-store`, `routine-store`, `signal-store` read-modify-write on `chrome.storage` drops K10/K11 outcome attribution under concurrency. ~10 LOC tail-Promise queue per file. — A6
- **`AesConductorRoutines` registry** triplicated across `route-profit`, `cash-runway`, `maintenance-rebalance` → extract to `routines/_registry.js`. ~30 LOC saving. — A6
- **2 orphan bus emits** — `data:strategy:company-reputation:saved` (`company-reputation-store.js:95`) and `fleet-optimizer:target-changed` (`fleet-optimizer-settings.js:111+114`). Either register or delete (gates on a policy decision — see §3). — A5

### 2.6 Documentation hygiene
- Split `audit/findings.md` (1856 LOC) — move FIXED items >2 sessions old into `audit/findings-archive.md`. — A12

---

## 3. Cross-cutting questions (one answer, multiple territories cleaned)

### 3.1 Orphan-bus-emit policy
A5 found 2; A3 found 12 registered topics with no listeners. **One answer needed:** wire later, register now, or delete? Until decided, every audit will keep flagging the same set.

### 3.2 `modules/_background/**` ownership
A2 flagged this: CLAUDE.md §4 matrix forbids A2 from touching it; AGENT-7.md brief assigns fix items that live there. F-7-009 notification-routing fix sits uncommitted in working tree because of the ambiguity. **One source-of-truth answer needed.**

### 3.3 Three-path competitor data
A10 flagged: `competitor-monitoring-tile`, `competitor-intel-hub-tile`, and `displayCompetitorMonitoring()` (`content_dashboard.js:1145`) all read the same storage shape. **Schema-drift risk.** Pick one and route the others through it.

### 3.4 FlightsFrom selector freshness
A7 flagged: `content_flightsFrom.js` ships 11 container + 7 row named selectors plus a heuristic catch-all. **Are the named selectors still matching, or has everything silently fallen through to the catch-all?** Needs a live scrape against JFK/LHR with selector-match logging.

---

## 4. Refactor candidates (defer — bigger than a streamline pass)

These are big code-health wins but each is a dedicated session, not part of this streamline sweep:

| File | LOC | Owner agent | Note |
|---|---|---|---|
| `content_dashboard.js` | 4,061 | A2 + A10 | Extract to `modules/dashboard/**` — 8 mostly-independent panes, each reachable via own central-hub tile via `CentralHubLegacy.switchDropdownTo`. Cross-territory (A1+A2+A10 coord). |
| `fleet-hub/command-center.js` | 5,390 | A9 | Split into shell + 4 tab files (~1,500 LoC each). |
| `strategy/panel.js` | 2,303 | A5 | Pure cleanup, no behaviour change. |
| `strategy/auto-driver.js` | 1,049 | A5 | Pure cleanup. |
| `_shared/_num` proliferation | — | A3 | ~40 strategy modules redefine `function _num` locally despite `AesUtils._num` existing (only 4 adopters). One-pass migration. |
| Shared MutationObserver scaffold | ~120 | A11 | Extract from 5× `content_finance_*.js` to `modules/_shared/mountWhenAnchor()`. |

---

## 5. Confirmed clean (no action needed)

So the user knows which territories are *not* the problem:

- **Strategy core** — 73 files / 27.5K LOC, zero version debris, all 8 apply-gates default safe (invariant §4.18 holds), no duplicate scorers (the four-piece pricing stack layers, doesn't duplicate).
- **AFP SACRED PATH** — `submitBtn.click()` exists exactly once at `form-driver.js:489`, reachable only via gated `aes:afp:fill-and-submit` runtime message routed through background `afp-submit-queue.js`. Drag-drop wired correctly.
- **Central-hub tiles** — 40/40 register with `CentralHubTileRegistry`, 40/40 in manifest, zero orphans. Bus is genuinely load-bearing (99 emit sites across 31 files).
- **Background.js** — 108-line shim, all 17 message handlers have matching senders, no dead handlers.
- **Auth surface** — `audit/credentials.json` is harness-only (`cdp-login.py`, `run-eight.py`), never read by extension code, properly gitignored. Zero hardcoded secrets in `background.js` / content scripts / options.js / popup.js.
- **`bridge.html`** — actively used (Command Bridge: `bridge-tab.js`, `menu-installer.js`, `opportunities-panel.js`).
- **5× `content_finance_*.js`** — NOT overkill; 40–60 LOC anchor-finders for distinct AS URLs. Keep.
- **`content_fligthSchedule.js` typo** — no collision, only one file exists, harmless.
- **`enterprice` typo** — real but cosmetic.
- **Conductor vs. Strategy** — independent co-equal subsystems, not absorbed.
- **Alliance** — correctly conditional (content-script scoped to `/app/alliance*`), not always-on dead weight.
- **Customization** — already merged into unified-settings via `tab-customisation.js → renderInto(host)`.
- **Slots** — stub-not-cruft. Plumbed end-to-end (store→scorer→tuner→`strategy-slot-trading-tile`), consumes user-seeded data. DEFER.
- **Command-bridge** — NOT a bus duplicate. Extension page, correct `chrome.storage.onChanged` use.
- **HANDOVER.md** — actively load-bearing, §10 invariants live-referenced, §11 intentional rolling context.
- **All 586 modules** — referenced by manifest. Zero orphan files.

---

## 6. Critical safety finding (gate-bypass — fix priority)

**`content_personelManagement.js:138`** calls `salaryBtn.click()` WITHOUT either of the two gates that the modern `crew-management/pay-tier-applier.js` enforces. Both files inject on the same `staffOverview` URL via two separate manifest content_scripts blocks (lines 691–711). The legacy file silently bypasses the user's `dryRunOnly:true` safety. **This is an invariant §3.7 violation** ("No silent default flips").

Resolution path:
1. Confirm reachability (D5 above) — is the legacy dashboard `<option value="personelManagement">` still mounted by `content_dashboard.js`?
2. If unreachable: 1-line manifest cut.
3. If reachable: migrate dashboard tab UI to modern slice first, then cut.

---

## 7. Recommended action sequence

If the user wants to move now, this is the lowest-risk order:

1. **Answer D1–D6.** Each is a binary, and they unlock the bulk of LOC reductions.
2. **Land §2.1 manifest cleanup + F4-011 + journal/learn order fix** as one PR. Closes A1's full territory and unblocks A8's retry-shim retirement.
3. **Land §2.2–2.4 file cuts and HANDOVER/MANUAL path fix** as one PR. Pure deletions, no behaviour change.
4. **Decide D5, then resolve §6 gate-bypass.** Safety priority.
5. **Resolve §3.1 orphan-bus-emit policy** with one-line addition to CLAUDE.md or HANDOVER §10. Lets every future audit stop re-flagging the same orphans.
6. **Worktree cleanup (§2.4)** once user confirms.
7. **Defer §4 refactors** to dedicated sessions.

Total estimated streamline if D1+D2+D3 all "cut" and §2 lands cleanly: **~2,400+ LOC reduction**, ~62 MB worktree disk reclaim, three subsystems with no remaining ambiguity, one safety violation closed.
