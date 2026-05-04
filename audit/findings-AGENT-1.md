# Findings — Agent 1 (Manifest, Load Order, Module Reachability)

## Summary

**Phase 1 audit (no edits yet).** Findings: **9** ([BUG]: 4, [INVARIANT-RISK]: 2,
[WIRING-GAP]: 1, [QUESTION]: 1, [OBSERVATION]: 1).

Numbers up front:
- `content_scripts` blocks: **30** (HANDOVER §1 says ~869 — referring to total
  `js` references summed; actual sum across blocks = **843**, unique = **586**).
- `modules/**/*.js` count: **572** (HANDOVER §1 says 533 — file count grew by ~39
  since that snapshot; need fresh §11.10 reconciliation).
- Orphans (in tree, never referenced anywhere): **2** (popup.js, options.js —
  loaded by `popup.html` / `options.html`, NOT real orphans).
- Stale references (manifest entry pointing at deleted file): **0**.
- In-block duplicate paths (same .js listed twice in one block): **0**.
- Cross-block on-page duplications (file load twice on the same URL): **8**
  total — 6 idempotently guarded, **2 unguarded** (BUGs F-1 and F-2).

Static analysis is solid. Live verification was attempted on Chrome port 9227
(extension path `/Users/jihwan/Downloads/AES.v0.6.9` = my codebase via symlink).
Two findings (F-1, F-2) need a logged-in AS session to fully verify; the
unauthenticated `/app/aircraft/market` probe does NOT show the expected
redeclaration error, suggesting Chrome MV3 may dedupe within-page content
script paths — but the §10 invariant explicitly warns about this pattern, so
it remains a latent regression vector.

## Top 5 issues (in fix priority order)

1. **F-3 [BUG/WIRING-GAP] AFP slice host.js missing from block 20** —
   silent-fail pattern that §10 explicitly warns about. Bus subscribers in
   block 20 load before host.js (in block 27), so subscriptions are silently
   dropped. `audit-log.js`, `form-driver.js`, related slices in AFP-on-page-0
   may be inert. **Highest impact, clearest fix.**
2. **F-1 [BUG] settings-bridge.js double-listed in b1 and b6** — class
   redeclaration risk on `/app/aircraft/market*`. Per §10, AesSettings is
   substrate; should appear in universal block only.
3. **F-2 [BUG] schedule-store.js double-listed in b19 and b27** — class
   redeclaration risk on `/app/fleets/aircraft/*/1*`. Block 27 already
   covers `/1*` URLs.
4. **F-4 [INVARIANT-RISK] strategy/journal-store.js loads after learn.js in
   blocks 5 and 27** — violates §10 explicit ordering invariant ("journal-store
   ahead of apply-pipeline AND learn"). Today learn.js's IIFE doesn't write at
   load-time, so the violation is benign at runtime, but it matches a §10
   anti-pattern that future load-order changes could weaponise.
5. **F-7 [QUESTION] HANDOVER §1 says "0 orphans, 533 files"; current tree has
   572 files** — Agent 8 should reconcile §3 (project map) and §11.3
   (post-overhaul claim) at end of session.

## Detailed findings

### F-1 [BUG] `modules/_shared/settings-bridge.js` double-listed in blocks 1+6

**Where:** `manifest.json` content_scripts block 1
(`/app/*` + `/action/*`, position 8) AND block 6 (`/app/aircraft/market*`,
position 7).

**Why it's a bug:** The file declares `class AesSettings { ... }` at module top
level with no `if (window.AesSettings) return` guard. On
`/app/aircraft/market*` URLs, both blocks fire. Per §10 invariant for AFP:
*"Listing the same file in both entries causes Chrome to inject it twice into
the same isolated world; the second top-level `class X` execution throws
`Identifier X has already been declared` and the page breaks."*

**Live verification:** I navigated port 9227 to
`https://www.airlinesim.aero/app/aircraft/market` (404 unauthenticated, but
content scripts still inject). Captured CDP execution-context isolated-world
globals: `AesSettings: "function"` (defined), no
`Identifier 'AesSettings' has already been declared` exception. Only one
exception fired (`AESMenu: target is null`, expected on a non-app page).
**Implication:** Chrome MV3 may de-duplicate identical script paths across
content_scripts entries on a single page, OR the redeclaration silently no-ops
in this specific context. Either way, the §10 invariant against this pattern
remains the contract — the current arrangement is a latent regression
vector.

**Suggested fix (Phase 2):** Remove `modules/_shared/settings-bridge.js` from
block 6. Block 1 already covers all `/app/*` URLs (block 6's match
`/app/aircraft/market*` is a subset).

**Status:** awaiting user OK before Phase 2.

---

### F-2 [BUG] `modules/aircraft-flight-plan/schedule-store.js` double-listed in blocks 19+27

**Where:** block 19 (`/app/fleets/aircraft/*/1*`, position 11) AND block 27
(`/app/fleets*`, position 4).

**Why it's a bug:** The file declares `class AesAfpScheduleStore { ... }` at
top level with no idempotent guard. On `/app/fleets/aircraft/<id>/1` URLs,
block 27 (`/app/fleets*`) ALSO matches because `*` matches any path suffix
including `/aircraft/<id>/1`. Both blocks fire; the file injects twice. Same
§10 invariant violation as F-1.

**Suggested fix:** Remove from block 19 — block 27 already covers it.

**Status:** awaiting user OK. **Live verification pending logged-in session
(I cannot autonomously authenticate per harness denial).**

---

### F-3 [BUG/WIRING-GAP] AFP slice `host.js` missing from block 20; bus subscribers load before bus is published

**Where:** block 20 (`/app/fleets/aircraft/*/0*`).

**Why it's a bug:** Block 20 includes the AFP foundation
(`settings-extension.js`, position 2) AND the AFP bus subscribers
(`audit-log.js` p7, `spec-resolver.js` p8, `form-driver.js` p16, etc.) — but
NOT `host.js`, which is what publishes `window.AesAfp.bus`. `host.js` is in
block 27 (`/app/fleets*`, position 62). On `/app/fleets/aircraft/<id>/0`, both
blocks fire. Chrome content_scripts inject in **manifest order**: block 20
runs first (positions 0–30), then block 27 (positions 0–200). So
`audit-log.js` runs at block-20 position 7, attempts
`window.AesAfp.bus.on(...)`, finds `window.AesAfp` undefined, the defensive
guard at line 287 silences the failure, and the slice "silently disables
itself" (per the explicit §10 wording). Block 27 then loads `host.js` and
publishes the bus, but no subscribers are attached to it.

**§10 invariant cited:** *"AFP slice load order: foundation → host → bus
subscribers → entry. settings-extension.js (no bus dep) before host.js
(publishes window.AesAfp.bus) before audit-log.js / spec-resolver.js /
route-candidates.js / form-driver.js / wave-applier.js (all bus.on(...) at
module-level IIFE load) before content_aircraftFlightPlan.js (calls
AesAfp.mount() on window.load). Reordering would leave the bus subscribers
calling against an undefined window.AesAfp.bus. The defensive guard at
audit-log.js:233 softens the failure to a warn but the slice silently
disables itself..."*

**Suggested fix (Phase 2):** Add `modules/aircraft-flight-plan/host.js` to
block 20, immediately after `settings-extension.js` (position 2 → 3). Verify
`route-candidates.js` and `wave-applier.js` are also added (they're in block
27 today; `audit-log.js` loads BEFORE them in block 20, which would be wrong
if they sit in block 27 only). Per the §10 invariant text, block 20 should
contain settings-extension → host → audit-log → spec-resolver →
route-candidates → form-driver → wave-applier → content_aircraftFlightPlan.

**Note:** This may overlap with Agent 4's territory (AFP module wiring). My
fix is purely the manifest entry; the underlying module code stays
unchanged.

**Status:** awaiting user OK + cross-check with Agent 4. **Live verification
pending logged-in session.**

---

### F-4 [INVARIANT-RISK] `modules/strategy/journal-store.js` loads after `learn.js` in blocks 5 and 27

**Where:** block 5 (dashboard) — learn.js at position 230, journal-store.js
at position 231. Block 27 (fleets) — learn.js at 133, journal-store.js at
134.

**Why it matters:** §10 invariant: *"Manifest order MUST keep journal-store.js
ahead of apply-pipeline.js and learn.js (so its passive subscriber catches
their first write) and ahead of panel.js (so the modal section can reach
window.AesStrategyJournal)."*

**Why benign in practice:** I read `learn.js` end-to-end. Its IIFE only
defines `window.AesStrategyLearn` and runs an opt-in smoke test under
`?aes-debug`. No storage write at module load. The journal's passive
`chrome.storage.onChanged` subscriber is set up in journal-store.js's IIFE,
which DOES run before any user-triggered write to `learn.js`'s
`aesStrategy:learn:weights:current` key. So at runtime today, no event is
missed.

**Why still flag:** The §10 wording is unambiguous ("MUST keep ... ahead of
... learn.js"). Future code changes that move a write into learn.js's IIFE
would silently miss the journal subscription. Trivial to swap the two lines
in manifest.

**Suggested fix:** Move journal-store.js to position 230 (before learn.js)
in both block 5 and block 27. Apply-pipeline (pos 236) is already after
journal-store.

**Status:** awaiting user OK.

---

### F-5 [INVARIANT-RISK] `class AesSettings` lacks idempotent guard (§10 contract violation)

**Where:** `modules/_shared/settings-bridge.js`, lines 46–106.

**Why it matters:** Even if F-1 (manifest dedup) is fixed, the §10
"Listing-the-same-file-in-two-entries-crashes" warning relies on every
substrate module having an idempotent guard. Five other `_shared/` modules
have either guards (`if (window.X) return`) or non-class top-level (no
class redeclaration risk). settings-bridge.js is the lone substrate file
with both: top-level `class AesSettings` AND no guard. Future manifest
restructure that re-introduces a duplicate would crash silently.

**Out-of-territory:** Adding a guard touches the file inside `modules/` —
that's Agent 6's territory (`_shared/**`). I'll request via cross-agent
finding rather than edit. Filing here as INVARIANT-RISK; Agent 6 to
add the guard.

**Suggested fix:** Wrap lines 46–110 in
`(function(){ if (window.AesSettings) return; ... })()` or prepend
`if (typeof window !== "undefined" && window.AesSettings) { /* already loaded */ }`
gate. **Note for Agent 6.**

**Status:** flagged for Agent 6.

---

### F-6 [INVARIANT-RISK] `class AesAfpScheduleStore` lacks idempotent guard

**Where:** `modules/aircraft-flight-plan/schedule-store.js`, line 38 onwards.

Same as F-5 but for AFP. Out of my territory (Agent 4 owns AFP modules).

**Status:** flagged for Agent 4.

---

### F-7 [QUESTION] Tree size grew from claimed 533 to 572 modules — has §11.3 reconciliation drifted?

**Observation:** HANDOVER §1 (Manifest wiring overhaul section) and §3
(Project map) both reference 533 `.js` files in `modules/`. Today the tree
has 572. Between snapshots, the tree grew by ~39 files. This suggests
either: (a) post-overhaul commits added modules without re-running the
§11.3 reconciliation, or (b) the count was approximate.

**Why this matters for me:** The orphan check still passes (only popup.js +
options.js are unreferenced, both intentionally so). So the manifest layer
is currently consistent. But if future agents add modules, the §11.3
checklist is the catch-net — and it apparently hasn't run in some time.

**Question for user:** Is reconciling §3 + §11.3 a job for Agent 8 at end of
session, or do you want me to draft a short "post-audit" appendix?

---

### F-8 [OBSERVATION] §10 claim of "AFP/fleets de-dup overlap: 66" doesn't match current state

**Observation:** HANDOVER §1.3 (Manifest wiring overhaul) says: *"AFP/fleets
de-dup overlap: 66 (pre-slice 58)"* — meaning 66 files appearing in both
the AFP block 20 AND the fleets block 27 (intentional idempotent
double-loads). Current state: **block 20 ∩ block 27 = 0 files**. Block 19 ∩
block 27 = 1 file (the F-2 schedule-store.js bug). Block 21 ∩ 27 = 0.

**Implication:** Either the 66 figure was never accurate, OR a later cleanup
slice removed all 66. Given the file structure is clearly organised
("things that need both blocks would be 66" feels arbitrary), I lean
toward "the 66 figure was the count of intentional dups in a prior layout
that was later refactored". Worth a HANDOVER note but not actionable as a
manifest change.

**Status:** observation only.

---

### F-9 [OBSERVATION] Permissions audit clean

`storage` (266 consumers) ✓, `tabs` (11), `notifications` (1),
`alarms` (8), `declarativeContent` (1, in background.js).
`unlimitedStorage` and `activeTab` are manifest-only flags (no API surface);
both are reasonable to declare. No unused-permission flags raised.

**Status:** observation only.

---

## Cross-territory items (for Agent 8 / per-agent reading)

- **F-3** is partly Agent 4's territory (AFP module structure), partly mine
  (manifest). Manifest fix is in my territory; module-side `host.js`
  internals untouched. Agent 4 should verify the wiring expectation matches
  their understanding.
- **F-5** is Agent 6's territory (`_shared/**` guard).
- **F-6** is Agent 4's territory (`aircraft-flight-plan/schedule-store.js`
  guard).
- **F-7** asks for Agent 8 reconciliation.

## Open questions for the user

1. **Live verification of F-1/F-2/F-3:** The harness denied my CDP login
   attempt. To verify the redeclaration error and AFP wiring at runtime, I
   need an authenticated AS session. Options:
   (a) You manually log in once on port 9227 (or any AES-loaded Chrome) and
       I take it from there with read-only navigation.
   (b) Authorise me to run the login script (it only calls
       `window.location='/auth/login'` then form-fills + submits — same as a
       human would).
   (c) Skip live verification and proceed on static evidence — F-1 is
       already partly verified (CDP confirms AesSettings IS defined and no
       redeclaration error fires; current behaviour is benign-but-fragile).

2. **F-4 ordering:** Worth fixing despite being benign? My read: yes, since
   it's a 1-line manifest swap and the §10 invariant is unambiguous. But
   you may prefer "if it ain't broke" — your call.

3. **F-3 cross-territory:** Should I propose the manifest entry additions
   for AFP block 20 myself (within my territory), or wait for Agent 4 to
   confirm which module list block 20 should contain? My read: I propose
   based on the §10 invariant text, Agent 4 reviews. The §10 invariant
   names the exact file order, so I have a clear specification.

## Tools / artefacts

- `audit/scripts/manifest-audit.py` — orphan + stale + duplicate audit.
- `audit/scripts/dup-loader-audit.py` — cross-block on-page collision finder
  with idempotent-guard heuristic.
- `audit/scripts/cdp-probe2.py` — CDP isolated-world global enumerator. Used
  for F-1 live verification.
- `audit/scripts/cdp-login.py` — login automation (denied by harness; not
  used).

## Phase 2 plan (pending user OK)

1. Fix F-1 (remove settings-bridge.js from block 6).
2. Fix F-2 (remove schedule-store.js from block 19).
3. Fix F-3 (add host.js + route-candidates.js + wave-applier.js to block 20
   in §10-specified order; coordinate with Agent 4).
4. Fix F-4 (move journal-store.js ahead of learn.js in blocks 5 and 27).
5. Verify each via `python3 audit/scripts/manifest-audit.py` clean run.
6. Live verify against Chrome (with logged-in session, if granted).
7. Append `[FIXED]` markers below each finding with commit refs.

End of Phase 1 audit.
