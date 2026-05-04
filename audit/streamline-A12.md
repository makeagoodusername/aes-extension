# Streamline audit — Agent 12

Territory: `audit/**`, `tests/**`, `scripts/**`, `docs/**`, `tools/**`, root MD/HTML detritus, cross-version dirs (`0.7.8_0/`, `0.78CUSTOM/`, `aes-worktrees/`).

Method: read-only inventory + provenance check. No deletes. Bus query targets: is the file referenced, is it superseded, is it broken, does it carry uncommitted work?

Counts at a glance:
- Audit MD files: 30 (~7,266 LOC). Of these, 8 per-agent briefs + 8 per-agent findings + 5 live-port + 2 pathway + CONSOLIDATION-SUMMARY + critical-outcomes-matrix + findings.md (1,856 LOC queue) + findings-LIVE-VERIFY + live-verifications + claims.log + SHARED-NOTES.
- Root MD files: HANDOVER.md 2,972 lines / 697 KB; MANUAL.md 1,463 lines / 124 KB; CLAUDE.md 201 lines.
- Root HTML "fixtures": 5 files (~318 KB total) — explicitly listed in `.gitignore` lines 13–17.
- Worktrees: 17 directories under `aes-worktrees/`. Git registry says all 17 are `prunable: gitdir file points to non-existent location`. Their `.git` files all point to `/Users/jihwan/Downloads/AES.v0.6.9-beta/.git/worktrees/...` (an old path the parent repo had before being moved into `AIRLINESIMMOD/AES.v0.6.9`).
- `0.7.8_0/`: 8 module .js files, ~3 KB manifest. Stripped/proto layout.
- `0.78CUSTOM/`: 17 child dirs (`aes-cc1..8`, `aes-cx1..8`, `aes-fork`). `aes-fork` is the canonical NEWLY2014 upstream-style fork; the rest are clone variants (`cc` = consumer-context?, `cx` = experiment?). Each has its own `.git`.
- Test infra: `tests/` (4 Playwright specs + README, all blocked on credentials), `audit/tests/` (7 territory subdirs with Node-runnable smokes; populated, real assertions), `audit/scripts/` (CDP harness + run-eight orchestration), `scripts/` (3 audit Python helpers + 1 CDP verify).

---

## KEEP — load-bearing, current

| Path | Why |
|---|---|
| `CLAUDE.md` | Active agent brief; only 201 lines; referenced by every per-agent brief. |
| `HANDOVER.md` (whole file) | Per CLAUDE.md §1 this is the live state. End-of-file notes (lines 2956+) are dated "this session" with concrete formulas/invariants. Section §10 invariants are append-only contracts other modules consume. **Don't archive.** See STREAMLINE for what to trim. |
| `MANUAL.md` | Long-form reference (algorithms, formulas, storage envelope) — distinct purpose from HANDOVER. Cross-referenced by HANDOVER §1. |
| `audit/CONSOLIDATION-SUMMARY.md` | The rollup the per-agent findings flow into. Recently regenerated. |
| `audit/SHARED-NOTES.md` | Live cross-agent coordination log; still being appended (last entry 2026-05-01 16:36). |
| `audit/critical-outcomes-matrix.md` | Source-truth checkpoint table; PASS/DEFERRED status with proofs. |
| `audit/AGENT-{1..8}.md` | Per-agent briefs; the spec each agent reads. Don't consolidate; kept for reproducibility of the multi-agent run. |
| `audit/findings-AGENT-{1..8}.md` | Per-agent running logs; FIXED hashes referenced in commit messages. |
| `audit/pathway-bus.md` + `audit/pathway-storage.md` | Special-purpose deep dives (cross-cutting Agent G + H static audits) — fed into CONSOLIDATION-SUMMARY but contain detail not in summary. |
| `audit/credentials.json` | `.gitignore`'d (line 7); template per HANDOVER. Not committed. Keep as runtime artifact for the harness. |
| `audit/scripts/*.py` | Active CDP-driven harness (`cdp-driver.py`, `cdp-eval.py`, `cdp-probe-noorigin.py`, `cdp-login.py`, `run-eight.{py,sh}`, `stop-eight.sh`). Used by every live agent in this session. |
| `audit/tests/{afp,canvas,dashboard,route-assistant,scrape-orchestrator,strategy,substrate}/` | Pure-function Node smokes. Real assertions, run by per-territory agents. `forward-simulator-determinism.test.js` and `schedule-diff.test.js` documented as PASS in critical-outcomes-matrix. |
| `audit/settings-bridge.test.js` (loose at audit root) | Active test; placed at audit root because `audit/tests/substrate/` is root-owned in this checkout (note in critical-outcomes-matrix). Functional. |
| `scripts/audit-{orphans,bus,settings-writers}.py` | Static audits referenced by F-8-001/002/003. Re-runnable ground truth. |
| `scripts/verify-fleet-dashboard-linkage-cdp.py` | Live verification of F-A2-001 fix. |
| `tests/e2e/00-load-extension.spec.ts` | Playwright load smoke. Updated 2026-05-01 with verified live selectors. |
| `tests/integration/cmd-k-dispatch.spec.ts` | Updated to live-verified read-only flow on 2026-05-01. |
| `tests/README.md` | Documents test status; warns about `credentials.json` rejected by AS (auth blocker). |
| `docs/{NORTH-STAR,STRATEGY-ROADMAP,CONDUCTOR-ROADMAP,FLIGHT-STUDIO-ROADMAP,CUBIST-OVERHAUL,PLAN-drag-to-schedule}.md` | Cross-referenced by HANDOVER (e.g. §1 NORTH-STAR §4.12 "manifest discipline"; §4 STRATEGY-ROADMAP §Slice 12). Active design docs. |
| `aircraft.txt` | `.gitignore`d (line 17). Local user spec note. Keep on disk; never ships in `.crx`. |
| Root HTML "fixtures" (`USA Stations.html`, `created station after.html`, `html - for smaller countries without reigions.html`, `station alabama.html`, `market-sample.html`) | All five listed in `.gitignore` lines 3, 13–16. HANDOVER §line 1400 documents them as "scratch HTML/txt fixtures gitignored — saved AS pages used for parser development." Not test fixtures (verified: no .js/.spec/.py refs). Keep on disk for parser development; they don't ship. |

## CUT — safe to remove (no work would be lost)

| Path | Why | Risk |
|---|---|---|
| `aes-worktrees/` (all 17 dirs) | Every worktree's `.git` file points to the non-existent path `/Users/jihwan/Downloads/AES.v0.6.9-beta/.git/worktrees/...`. They are NOT live worktrees from git's view (`git worktree list` reports all 17 `prunable`). The directories are physical orphans of an old repo path. Each branch (`slice/L-foundation`, `slice/n-strategy`, etc.) is preserved in `.git/refs/heads/` of the main repo, AND an `origin/slice/...` remote tracking branch exists for each — so the commits are not at risk. The directories themselves carry no committed-but-unpushed work (since they have no functional `.git`). They can be re-checked out at any time via `git worktree add` from the main repo. ~62 MB total. | **Verify** by running `git fsck` after delete. The branches in `.git/refs/heads/` and `remotes/origin/...` are the source of truth; the disk dirs are just stale physical copies. |
| `audit/.pids/agent-{1..8}.pid` | Old PID files from a prior run of `audit/scripts/run-eight.sh`. Not referenced. | None. |
| `audit/scripts/__pycache__/` | Python bytecode cache. `.gitignore`d already (line 9). | None. |
| `0.7.8_0/` | 8 .js files; stripped layout; manifest shows it's an unrelated proto/snapshot, not a successor. No symbolic links from the main tree. The newer canonical work lives in `0.78CUSTOM/aes-fork`. | **Confirm with user** before delete — possibly a hand-rolled milestone snapshot the user wants. |

## FIX — broken state with a clear repair

| Item | Fix |
|---|---|
| HANDOVER.md §line 7 + MANUAL.md §line 5 hardcode `Repo root: /Users/jihwan/Downloads/AES.v0.6.9-beta/` | Wrong path. Real path is `/Users/jihwan/Downloads/AIRLINESIMMOD/AES.v0.6.9/`. Same drift caused all 17 worktree `.git` files to dangle. One-line s/// in both files. |
| `git worktree list` reports 17 prunable entries | Run `git worktree prune` (one-time housekeeping; only removes dead bookkeeping, doesn't touch any branch or commit). |
| `tests/integration/cmd-k-dispatch.spec.ts` and 3 sibling specs blocked | Per `tests/README.md` and `audit/SHARED-NOTES.md` 10:50 entry: `audit/credentials.json` no longer authenticates (AS rejected on port 9234). User must refresh credentials or hand-auth one chrome-aes-N profile and point `AES_TEST_PROFILE` at it. Doc-only fix the user can resolve out-of-session. |

## DEFER — has value, not urgent

| Item | Why defer |
|---|---|
| `0.78CUSTOM/aes-cc{1..8}` and `aes-cx{1..8}` (16 sibling forks) | Each carries its own `.git`. Provenance unclear without user input — they look like per-Claude-instance worktree clones. Cutting them blind risks losing experimentation. Ask user to identify. |
| Eight `audit/findings-AGENT-{1..8}.md` files | After full consolidation into `CONSOLIDATION-SUMMARY.md` + `SHARED-NOTES.md` resolves the remaining `[QUESTION]`s, these per-agent files become historical. NOT YET — F-8-005, F-8-006, F-8-007 etc. are still cited live by other agents. Archive only at end of session run. |
| `audit/findings.md` (1,856-line free-form queue) | Still has open items per its first comment ("OPEN → CLAIMED → FIXED"). Defer until next consolidation. |
| `audit/findings-LIVE-VERIFY.md` and `audit/live-verifications.md` | Two parallel logs of live CDP verifications. Some overlap; both still being read. Consolidate at session end, not now. |
| `audit/live-port-{9223..9227}.md` (5 files, ~770 lines) | Per-port live-debug transcripts from earlier rounds. Once their findings landed in CONSOLIDATION-SUMMARY (they did), these are session archive. Defer to when HANDOVER absorbs the corresponding §"Manifest wiring overhaul" + "Trust→Drift→Foresight" entries (already absorbed) — at that point safe to move under `audit/archive/`. |
| `audit/claims.log` (273 lines) | Lock-claim log for the 8-agent run. Useful for forensics. Archive once session retrospective is signed off. |
| `audit/phase3.md` | Domain-split coordination doc for the dashboard hub walkthrough. Active reference for `tile-by-tile` work. Archive after walkthrough completes. |
| `tools/dashboard-harness-t{2..6}.html` and `dashboard-harness.html` (5 files, 0.5 MB) | Free-standing HTML harnesses referenced from `audit/live-port-922{3..6}.md`. Used to repro dashboard tile bugs without needing a running AS session. Keep until those live-port logs are archived. |
| `tools/logicalflow/` | Side tool (`app.js`, `index.html`, `primitives.js`, `shell.js`, `styles.css`). Not referenced from main extension or audit. Not actively cited; ask user if still wanted. |

## STREAMLINE — keep the file but trim sections

| File | What to trim |
|---|---|
| `HANDOVER.md` (2,972 lines) | The "What's been said" rolling log at §11 (lines 2956+) is recent-context flavor — could be capped at last ~30 entries. Pre-Slice-12 session entries in §1 (the "Trust→Drift→Foresight wave" + "Manifest wiring overhaul" + "Strategy Slice 12" blocks) are LOAD-BEARING — they document live invariants other agents read. **Don't archive these.** Candidate for archival into `HANDOVER-archive.md`: any §1 session entry whose feature has subsequently been superseded (verify with user before moving any). The §10 invariant wall (lines 2900+) is contract — keep verbatim. |
| `MANUAL.md` (1,463 lines) | Reference-quality, internally consistent. Already organised by §1..§28+. Trim only typos / dead code references on review; **do not re-section.** Its `Repo root` header at line 5 needs the same path fix as HANDOVER. |
| `audit/findings.md` | Cap or split — 1,856 lines is past readable. Move FIXED items older than two sessions to `audit/findings-archive.md`. |
| `audit/SHARED-NOTES.md` | Append-only by design. Add a `## Archive cut` divider at session end so future sessions don't re-read the previous run's locks. |
| `tests/integration/{afp-batch-dryrun,strategy-apply-to-pricing-applier,wave-overlay-save}.spec.ts` | Per `tests/README.md`: "still scaffolded and not yet exercised". Skeleton specs. Either harden once credentials unblock, or move to `tests/integration/_pending/` to make the runnable suite legible. |

## Cross-version redundancy

- `0.78CUSTOM/aes-fork/` is the canonical NEWLY2014 upstream-style fork (has README, LICENSE, CHANGELOG, CONTRIBUTING-style structure, separate `extension/` + `feat/` + `src/` + `contracts/` + `meta/`). Its layout is fundamentally different from `AES.v0.6.9/` (which is the in-place vanilla MV3 unpacked layout). **They serve different purposes:** `aes-fork` looks like a packaged/distributable rebuild; `AES.v0.6.9` is the live development working tree. Don't cross-merge without an explicit reconciliation pass.
- `0.7.8_0/` — minimal (8 modules); unclear provenance; recommend asking user.
- `0.78CUSTOM/aes-cc{1..8}` and `aes-cx{1..8}` — almost certainly per-agent disposable forks created for the multi-Chrome run; treat as DEFER until user names them.

---

## Open questions for the user

1. **Worktree cleanup safety:** all 17 `aes-worktrees/*` are git-prunable (their `.git` pointer files reference an old path `/Users/jihwan/Downloads/AES.v0.6.9-beta/`). Branch refs are preserved in the main repo's `.git/refs/heads/` and as `origin/slice/...` tracking refs. Is it safe to `rm -rf aes-worktrees/` and `git worktree prune`? — All commits would survive; only the disk dirs disappear. **My read: yes, but confirm.**
2. **`0.7.8_0/` and `0.78CUSTOM/aes-cc{1..8}` + `aes-cx{1..8}`:** what are these? Are any of them carrying experimental work that hasn't been pushed to a remote? If they're transient harness clones, they can go.
3. **`HANDOVER.md` repo-root drift** (line 7) and **`MANUAL.md`** (line 5): both hardcode the old path. Want a one-line fix?
4. **Per-agent findings + live-port logs:** ready to move to `audit/archive/` once this session's CONSOLIDATION-SUMMARY is signed off, or hold for the next consolidation pass?
5. **`tools/logicalflow/`:** in-use, or orphan? It isn't referenced from anywhere in `modules/`, `audit/`, `scripts/`, or `tests/`.

## Top-3 priority recommendations

1. **`git worktree prune` + `rm -rf aes-worktrees/`** (after user confirm) — single highest-leverage cleanup; ~62 MB; eliminates a confusing parallel directory tree. Branches are safe in the main repo.
2. **Fix the `Repo root:` line in HANDOVER.md and MANUAL.md** — one-line each. Eliminates the documented-vs-real path drift that caused the worktree corruption.
3. **`git worktree prune`** standalone (independent of the above) — removes 17 stale registry entries; non-destructive.
