# tests/

Test scaffolding for the AES extension. Two axes:

- `tests/e2e/`         — Playwright smoke against a logged-in AS profile.
- `tests/integration/` — cross-territory integration tests (Playwright) that
                         exercise paths spanning two or more agent slices.

Pure-function smokes that don't need Chrome live under `audit/tests/<territory>/`
to match the existing Phase-1 pattern (Agents 4 and 5 already populate that tree).

## Status (Phase 2, 2026-05-01)

- `audit/tests/strategy/forward-simulator-determinism.test.js` — Node-runnable.
  Locks down Agent 3's F-A3-001 (simulator mutates fork.snapshot). Currently
  passes 7/7 in the stabilized tree.
- `audit/tests/afp/schedule-diff.test.js` — Node-runnable. Currently
  passes 15/15 in the stabilized tree.
- `tests/e2e/00-load-extension.spec.ts` — updated to the live selectors
  verified on 2026-05-01 (`.aes-menu__trigger`, `#aes-central-hub`), but not
  yet run under Playwright in this checkout.
- `tests/integration/cmd-k-dispatch.spec.ts` — updated from a placeholder to
  the live-verified read-only flow:
  dashboard → `Cmd-K` → `Go to Accounting` → `/app/finance/accounting`.
- Other `tests/integration/*.spec.ts` — still scaffolded and not yet exercised.

The Playwright tests are blocked on a logged-in AS profile. Per
audit/SHARED-NOTES.md (2026-05-01 10:50, Agent 2), `audit/credentials.json`
no longer authenticates: AS rejected CDP login on port 9234 with
"Authentication failed". To unblock the integration suite the user needs to
either refresh credentials.json or hand-authenticate one of the
`/tmp/chrome-aes-N` profile directories and point `AES_TEST_PROFILE` at it.

## Running the pure-function smokes

From project root:

```bash
node audit/tests/strategy/forward-simulator-determinism.test.js
node audit/tests/afp/schedule-diff.test.js
```

No `npm install`; helpers under `audit/tests/<territory>/_helpers.js`
read sources via `fs` and eval them in a fresh `global.window` context.

## Running the Playwright suite (once unblocked)

```bash
cd tests
npm install --save-dev @playwright/test
npx playwright install chromium
AES_TEST_PROFILE=/tmp/chrome-aes-1 npx playwright test
```

The `AES_TEST_PROFILE` env var should point at any logged-in
chrome-aes-N directory; the eight agent profiles share the same AS
account so one logged-in session covers all suites.
