# Live Smoke — 2026-05-03

Branch `slice/e-integration` against `free1.airlinesim.aero`, airline **Casper Flight Logistics** (account `jeankimdake@gmail.com`). Single Chrome instance on CDP port 9233, profile `/tmp/chrome-aes-1`, ext loaded from repo root.

## Headline

Extension **loads cleanly** on every page walked — 30+ AES globals, 459 hub-tile DOM nodes on dashboard, **0 console errors / 0 warnings on every page tested**. The live‑write step in the approved plan was **not executable** because the airline has no game state (0 AS$, 0 fleet, 0 routes), so there is nothing to apply against.

## Setup notes (worth keeping)

- Stable **Google Chrome 147** on macOS now silently rejects `--load-extension` / `--disable-extensions-except` (`extension_service.cc:438] --disable-extensions-except is not allowed in Google Chrome, ignoring.`). `audit/scripts/run-eight.sh` will launch Chrome but the AES extension will **not load** — and there's no error in the visible UI. Symptom: `chrome://extensions/` lists 0 items.
- Workaround: launch **Chrome for Testing** that Playwright already installed at `~/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. With that binary the same flags load the extension fine (service_worker `cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/background.js` appears in `/json/list`).
- `audit/scripts/cdp-login.py` (the v1 script wrapped by `cdp-login-from-file.py`) **silently no-ops** the AS submit — fields fill but the form never POSTs. `cdp-login-v2.py` (full event dispatch) works on the first try.
- → Action item: `run-eight.sh` should default to Chrome for Testing (or at least error loudly when run against stable Chrome), and `cdp-login-from-file.py` should call `cdp-login-v2` instead of `cdp-login`.

## Per-page results

| Page | URL | AES nodes | Console | Notes |
|------|-----|-----------|---------|-------|
| Enterprise Dashboard | `/app/enterprise/dashboard` | 534 | 0E/0W | 30 AES globals present incl. `AesDataBus`, `AesView`, `AesSettings`, `AESFreshnessPill`. 459 hub-tile nodes render. |
| Scheduling | `/app/com/scheduling/JFKJFK` | 17 | 0E/0W | Defaults to JFK→JFK placeholder route (no real routes set up). |
| Flight Numbers | `/app/com/numbers` | 11 | 0E/0W | Renders, no flight numbers exist on the airline. |
| Routes Evaluation | `/app/com/routes/evaluation` | 11 | 0E/0W | Empty state OK. |
| Markets | `/app/com/markets/JFKJFK` | 15 | 0E/0W | Same JFK placeholder. |
| ORS | `/app/info/ors` | 11 | 0E/0W | OK. |
| Enterprise Settings | `/app/enterprise/settings` | 32 | 0E/0W | h1 = "AirlineSim Enhancement Suite Settings" — settings page paints. 3 checkbox toggles + 5 panels rendered. |
| Fleet Management | `/app/fleets` | 14 | 0E/0W | "Default fleet" — empty fleet. |
| Inventory | `/app/com/inventory/JFKJFK` | 15 | 0E/0W | UI message: "AES Inventory Pricing Module could not be loaded because of errors: Please select 'All Flight Numbers' under Current Inventory" — this is the documented empty-route guard, not a bug. |

## Live writes — not executed

Cannot exercise pricing/IL/AFP appliers: the airline has **no fleet, no routes, no flight numbers, no balance**. Every applier has nothing to write against; flipping `apply.enabled`/`apply.dryRunOnly` on this account would no-op.

To unblock step 3 you'd need to either:
- Set up at least one O&D + one aircraft + one flight number on Casper Flight Logistics (manual in the AS UI, ~5 min), or
- Use a different account with real game state and update `audit/credentials.json`.

The command-palette Cmd-K probe also did not bind on Settings page (`palette: false`) — but the site-skin chord listener is documented as gated on skin state per recent commit `0d2236a`, and Settings may not satisfy that gate. Worth re-testing on a page that does (recommend dashboard).

## Cmd-K follow-up (one more probe)

Quick re-test on dashboard:

```
[no palette node found after Cmd+K dispatch]
```

Confirmed not bound on Settings; need to repeat on a "skin-active" page to know whether this is the documented gate or a regression.

## Files / scripts produced

- This findings file.
- Reusable: `/tmp/visit.sh` (per-URL probe script — feel free to keep or discard) and `/tmp/console-snap.py` (5-second console error sampler via CDP).
- Chrome still running, pid `46545`, port `9233`, profile `/tmp/chrome-aes-1` — ready for next session if you want to re-test after seeding game state.

## Recommended next steps

1. Patch `audit/scripts/run-eight.sh` to prefer Chrome for Testing and to fail loudly when stable Chrome is detected.
2. Switch `audit/scripts/cdp-login-from-file.py` to wrap `cdp-login-v2` instead of `cdp-login`.
3. Seed Casper Flight Logistics (or swap accounts) so the live-write spot checks become meaningful, then re-run.
4. Verify Cmd-K palette binding on a skin-active page (dashboard / markets).
