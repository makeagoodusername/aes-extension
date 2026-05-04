# AGENT-8.md — Test Harness, Cross-Agent Verification, Consolidation

You own the cross-cutting glue: test infrastructure, integration smoke testing, and end-of-session consolidation. With the 8-Chrome model, your role shifts: you no longer monopolize the browser, but you still own the cross-checks that catch bugs no single-territory agent sees.

## Why this is its own territory

Every other agent works within a fixed territory and can verify their own fixes in their own Chrome. Someone still needs to:

- Cross-reference findings across agents (catch the "two agents found the same bug" case).
- Run integration smokes that span territories (e.g., a Strategy apply that hits the RA pricing applier — touches Agents 2 and 3's territories).
- Build the test harness others can use.
- Consolidate at the end.

## Your Chrome instance

Yours is the integration tester. Use it to verify cross-territory paths:

- Strategy apply → pricing applier → audit log (Agents 3 + 2).
- AFP batch submit → form-driver → background message → AS form (Agents 4 + 7).
- Wave overlay save → ScheduleStore → wave-applier (Agents 2 + 4).
- Cmd-K dispatch → opens panel → triggers handler (Agents 6 + others).

**Lock requirement:** acquire SHARED-NOTES real-write lock for any integration test that triggers a real apply. Coordinate timing — let other agents finish their dry-run verifications first.

**No lock needed for:**
- Reading every other agent's findings file.
- Running the orphan / bus / dedup audit scripts.
- Building Playwright tests that don't yet run.

## Your scope

You write to:

```
audit/                  # findings, manifests, requests, summaries
tests/                  # NEW — Playwright + Node smoke harnesses
scripts/                # NEW — small audit helpers (Python, Node, bash)
```

You read everything. You write to no production module under `modules/**`. You write to no entry script.

## Priority work areas

### 1 — Set up the verification harness (first ~30 min)

You don't need to solve auth from scratch — credentials.json already gets the user into AS. But your test harness should hook into the same login state without re-implementing it.

Create `tests/e2e/00-load-extension.spec.ts`:

```ts
import { chromium, test, expect } from '@playwright/test';
import path from 'path';

test('AES extension loads on AirlineSim', async () => {
  const extPath = path.resolve(__dirname, '../../');
  // Reuse a profile dir that's already logged in via credentials.json
  const profileDir = process.env.AES_TEST_PROFILE || path.resolve(__dirname, '.profile');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ],
  });
  const page = await ctx.newPage();
  await page.goto('https://www.airlinesim.aero/app/enterprise/dashboard');
  await expect(page.locator('#aes-top-menu, [data-aes-menu]').first()).toBeVisible({ timeout: 10000 });
  await ctx.close();
});
```

The user can point `AES_TEST_PROFILE` at one of the eight Chrome profile directories already in use (check with the user where those live). This reuses the existing logged-in session without invoking credentials.json directly.

### 2 — Build the audit cross-reference scripts (next ~30 min)

`scripts/audit-orphans.py`:

```python
import json, glob, os
repo = "."
manifest = json.load(open(os.path.join(repo, 'manifest.json')))
registered = set()
for cs in manifest.get('content_scripts', []):
    for js in cs.get('js', []):
        registered.add(js)
all_js = set()
for f in glob.glob(os.path.join(repo, 'modules', '**', '*.js'), recursive=True):
    all_js.add(os.path.relpath(f, repo))
orphans = sorted(all_js - registered)
print(f"Total: {len(all_js)}, Registered: {len(registered & all_js)}, Orphans: {len(orphans)}")
for o in orphans: print(f"  {o}")
```

`scripts/audit-bus.py`:

```python
import re, glob, os
repo = "."
emit_re = re.compile(r'(?:CentralHubBus|AesDataBus|AesAfp\.bus|AesStrategy\.bus)\.emit\(\s*[\'"]([^\'"]+)[\'"]')
on_re   = re.compile(r'(?:CentralHubBus|AesDataBus|AesAfp\.bus|AesStrategy\.bus)\.on\(\s*[\'"]([^\'"]+)[\'"]')
emits, ons = {}, {}
for f in glob.glob(os.path.join(repo, 'modules', '**', '*.js'), recursive=True):
    rel = os.path.relpath(f, repo)
    src = open(f).read()
    for t in emit_re.findall(src): emits.setdefault(t, []).append(rel)
    for t in on_re.findall(src): ons.setdefault(t, []).append(rel)
print("=== Emitted but never subscribed ===")
for t in sorted(set(emits) - set(ons)): print(f"  {t}  ({len(emits[t])} emitter(s))")
print("=== Subscribed but never emitted ===")
for t in sorted(set(ons) - set(emits)): print(f"  {t}  ({len(ons[t])} subscriber(s))")
```

Run both. Findings → `audit/findings-AGENT-8.md`, tagged for relevant territory agent.

### 3 — Cross-territory integration tests (~60 min)

These are the tests no single agent owns. Build them in `tests/integration/`:

- **Strategy apply → pricing applier**: open strategy modal, tier `apply-on-confirm`, tick a price decision, click Apply. Verify the pricing applier audit log gains an entry tagged with `source: "strategy"`.
- **Wave overlay save → ScheduleStore**: open RA panel, toggle Wave View, click 💾 Save schedule. Verify `<server><airline>schedule` storage gains a record.
- **AFP batch submit dry-run**: open AFP page, click Auto-build, click Apply-all in dry-run mode. Verify zero AS POSTs in DevTools Network.
- **Cmd-K integration**: dashboard → Cmd-K → "Open Strategy" → strategy modal opens.
- **Cross-tab settings sync**: change a setting in one Chrome instance; verify it propagates to other instances via `chrome.storage.onChanged` within ~250ms.

Each test acquires SHARED-NOTES lock if mutating, runs, releases lock, records pass/fail.

### 4 — Live verification of `[VERIFY-LIVE]` items from other agents (~45 min)

As Agents 1–7 produce findings, scan their files for `[VERIFY-LIVE]` blocks. With the 8-Chrome model, most agents verify their own — but flagged items are cross-territory or required a fresh Chrome session. Document each in `audit/live-verifications.md`.

### 5 — Final consolidation (last ~30 min)

Read all eight findings files. Produce `audit/SESSION-SUMMARY.md`:

- **Bug count** by severity: critical / high / medium / low.
- **Fix count** with commit hashes.
- **Deferred-confirmed count** (handover documented as deferred — no action).
- **Cross-agent issues**: flagged by one agent for another to pick up next session.
- **HANDOVER.md proposed updates**: one section per major change, ready for user review.
- **Open questions for the user.**
- **Top of the document:** "What should the user check first" — the 3-5 things most worth their personal review.

## Coordination protocol

Every 30 minutes, scan all eight findings files. If you see contradictions or two agents claiming the same bug, write a `## CROSS` entry in `audit/SHARED-NOTES.md` flagging both agents.

## Forbidden

- No edits to production code.
- No edits to `manifest.json` (Agent 1).
- No edits to `HANDOVER.md` directly — propose updates instead.
- No commits to other agents' findings files.
- No live-browser actions touching AS gates without acquiring SHARED-NOTES lock.

## End-of-session deliverable

In addition to your own findings:

- `audit/SESSION-SUMMARY.md` (master rollup).
- `tests/e2e/` populated with at least the load-extension smoke + 2-3 critical-path tests.
- `scripts/audit-orphans.py`, `scripts/audit-bus.py`, any other helpers.
- `audit/live-verifications.md` with results from your live-browser passes.
- "What the user should check first" at top of SESSION-SUMMARY.md.
