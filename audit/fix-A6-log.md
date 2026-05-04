# Fix-Agent 6 Log — F-A3-007 (forward-simulator deterministic clone)

**Outcome:** REJECTED-stale — claim no longer applies. The fix is already in the source on disk.

## Territory
`modules/strategy/forward-simulator.js` (exclusive).

## Audit claim under review
streamline-A5.md / findings-AGENT-3 F-A3-007:
> `forward-simulator._decay` mutates `fork.snapshot` in place across re-runs,
> breaking the "deterministic projection" doc-string. Fix: clone the snapshot
> before applying decay.

## What I actually found in source (re-read line-by-line)

`/Users/jihwan/Downloads/AES.v0.6.9/modules/strategy/forward-simulator.js`:

- Lines **103-110** define `_cloneSnapshot(snapshot)`:
  - Tries `structuredClone(snapshot)` first (Chrome MV3 supports this — Chromium ≥ 98, AS targets recent Chromium).
  - Falls back to `JSON.parse(JSON.stringify(snapshot))` on failure.
  - Returns `null` if both clone paths throw.
- Line **143** in `simulateForward`:
  ```
  const workingSnapshot = _cloneSnapshot(fork.snapshot)
  ```
  Cloning happens at simulator entry, BEFORE any baseline scoring or decay.
- Line **144** guards against clone failure: `if (!workingSnapshot) return {ok: false, reason: "snapshot clone failed"}`.
- Line **163**: `_decay(workingSnapshot)` — decay walks the clone, never `fork.snapshot`.
- Lines **147, 149-153, 164, 167-172**: every `_scoreRoutes`, `_scoreObjective`, `_orsRankSum`, `_fleetMaintRatio`, `_dnaFit` call passes `workingSnapshot`, never `fork.snapshot`.

`grep -n "_decay" forward-simulator.js` returns exactly two lines (the definition at 112 and one call site at 163 with `workingSnapshot`). No code path mutates `fork.snapshot` directly.

The `_decay` function itself does mutate its input parameter in place (intentional — it's a private decay step on a working buffer), but `simulateForward` never hands it `fork.snapshot`. The contract is preserved at the caller level.

## Verification

- `node --check /Users/jihwan/Downloads/AES.v0.6.9/modules/strategy/forward-simulator.js` → OK.
- Existing smoke test:
  `/Users/jihwan/Downloads/AES.v0.6.9/audit/tests/strategy/forward-simulator-determinism.test.js`
  was written explicitly to lock down F-A3-001/F-A3-007 (its preamble notes "Today this test is EXPECTED TO FAIL — that's the point. Once Agent 3 lands the structuredClone-at-entry fix, this test should turn green automatically.").
  Run output (today):

  ```
    ok  simulateForward returns ok on first call
    ok  simulateForward returns ok on second call (forced)
    ok  baseline.weeklyResult is the same across re-runs (F-A3-001)
    ok  baseline.orsRankSum is the same across re-runs (F-A3-001)
    ok  fleet[0].age stays untouched after simulation (F-A3-001)
    ok  first-call deltas reflect non-zero forward projection
    ok  first-call weeks array length === requested weeks (or smaller on time-budget hit)

  forward-simulator-determinism (F-A3-001 lockdown): 7 passed, 0 failed
  ```

  All seven assertions green, including:
  - `baseline.weeklyResult` and `baseline.orsRankSum` stable across re-runs of the same fork.
  - `fork.snapshot.fleet[0].age` untouched after a full simulation pass.

  This is the canonical proof that the deep-clone is in place and `fork.snapshot` is no longer mutated.

## ?aes-debug console smoke for forward-simulator (manual repro)

There is no `?aes-debug=forwardSimulator` named smoke registered, but the live consumer is the **counterfactual-lab tile** (`modules/central-hub/tiles/counterfactual-lab-tile.js:249-253`). To exercise the simulator manually from a logged-in AS tab:

```js
// In DevTools console on any AS page where strategy modules are loaded:
const fork = await window.AesStrategy.forks.snapshotFork({label: "smoke"})
const r1 = await window.AesStrategyForwardSimulator.simulateForward(fork, {weeks: 4})
const r2 = await window.AesStrategyForwardSimulator.simulateForward(fork, {weeks: 4, force: true})
console.log("baseline drift:",
    r1.baseline.weeklyResult, "vs", r2.baseline.weeklyResult,
    "→ stable?", r1.baseline.weeklyResult === r2.baseline.weeklyResult)
```

Determinism holds when the third value is `true`.

## Files changed
**None.** Per the shared brief: "If the claim is stale, log REJECTED — claim no longer applies and stop without editing." Source already implements the recommended fix.

## Follow-ups (not in my territory)
- Streamline-A5 also raised the `Date.now()` time-budget watchdog (lines 139, 159, 188) as a residual non-determinism concern under load. This is item **#3** in streamline-A5's FIX list and orthogonal to the clone fix; surfacing only — not editing.
- Streamline-A5 item **#3** under STREAMLINE: `_dnaFit` reaches into `window.AesCanopyDnaFit` / `AesCanopyDnaStore` from a strategy-pure module (lines 88-90). Cross-territory (canopy = Agent 3); leaving for that owner.

## Disposition
No edits. No commits (per personal-computer rule in shared brief). Audit claim F-A3-007 should be re-tagged **[FIXED-CONFIRMED]** in findings-AGENT-3.md by whichever agent consolidates.
