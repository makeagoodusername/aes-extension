# AGENT-7.md — Background, Content-Script Entrypoints, Options, Popup, Login

You own everything outside `modules/**` — the Chrome-extension-shell layer. You also own the credentials.json login automation that gets each Chrome instance into AS.

## Why this is its own territory

`background.js` is the MV3 service worker. It coordinates message routing for AFP submit, the silent-auto alarm, the long-op notification handler, the customization patch handler, and the AFP batch pipeline. The `content_*.js` files are the page-specific entry points. You also own the login automation since that's the layer that bridges credentials.json into a logged-in browser session.

## Your Chrome instance

Yours is the meta-instance: you're verifying the login flow itself, plus message-passing between content scripts and background. Open multiple tabs in your Chrome to confirm cross-tab message flow.

**Lock requirement:** acquire SHARED-NOTES real-write lock before:
- Triggering test logins from credentials.json (other agents' Chromes are already logged in; an additional login flow could invalidate their session in some AS configurations).
- Mass-clearing storage during testing (would force every other agent to re-mount).

**No lock needed for:**
- Reading message handler code.
- Tracing `chrome.runtime.sendMessage` calls.
- Verifying alarm registration via DevTools service worker console.

## Your scope

```
background.js
content_dashboard.js
content_scheduling.js
content_marketScan.js
content_flightsFrom.js
content_stationOpen.js
content_aircraftFlights.js
content_aircraftFlightPlan.js
content_fleetHub.js
content_fligthSchedule.js          (typo retained)
content_inventory.js
content_personelManagement.js
content_enterpriceOverview.js
content_flightInfo.js
content_settings.js
content_fleetManagement.js
content_markets.js

options.html
options.js
popup.html
popup.js

credentials.json                   (DO NOT commit changes; read-only audit)
login automation (wherever it lives — likely in background.js or a content script)
```

## Priority audit areas

1. **Login automation review** — there's a `credentials.json` and a flow that uses it to log each Chrome instance into AS. Verify:
   - Where the credentials are read (file path, security model).
   - When login fires (on Chrome launch? On session expiry? On manual trigger?).
   - What happens if AS rejects the login (retries? backoff? user-visible error?).
   - Whether the login flow is idempotent — running it twice in a row should not break a working session.
   - Whether multiple Chrome instances can race on login simultaneously and produce inconsistent session state.

   The user has been running 8 instances against the same account. Verify the login flow handles concurrent first-run logins without one stepping on another.

2. **`background.js` message handlers** — verify each `chrome.runtime.onMessage` listener:
   - `aes:afp:fill-and-submit` — single-aircraft submit, queue-coordinated via `_afpSubmitQueues`. Must NOT race a batch submit on the same aircraft.
   - `aes:afp:apply-batch` — full multi-leg pipeline, opens hidden tab, iterates serially with 500ms inter-leg delay.
   - `aes:afp:apply-batch:abort` — sets abort flag + closes hidden tab.
   - `aes:notify:long-op` — fires `chrome.notifications.create`, click refocuses originating tab.
   - `aes:silent-auto:tick` (alarm-driven, broadcasts to most-recently-active scheduling tab only).
   - Customization patch handler.

3. **`chrome.alarms` + silent-auto cadence** — verify:
   - Alarm name `aes:silent-auto:tick` registered when `silentAutoEnabled` flips true.
   - `periodInMinutes` mirrors `silentAutoTickMin` (clamped 5–240).
   - Reconcile on `chrome.runtime.onInstalled`, `onStartup`, and `chrome.storage.onChanged` filtered to two specific fields.
   - Single-tab broadcast (most-recently-active by `tabs.lastAccessed` desc).
   - **8-instance interaction:** since each Chrome has its own service worker, each has its own alarm. Verify the most-recently-active-tab logic picks the right tab WITHIN each Chrome, not across Chromes (it can't see other Chromes' tabs).

4. **`content_aircraftFlights.js` per-flight envelope** — Roadmap G slice 4. Verify:
   - `getFlights()` extracts `flightNumberId` from `/app/com/numbers/<id>` href.
   - Origin/destination IATAs from `<title>` rows 3/5.
   - `depUtc` from row 4 title.
   - Saved cache gains `flights[]` envelope.
   - **Pre-existing bug fix**: flight ID regex is `url.match(/[?&]id=(\d+)/)[1]`, NOT `url.match(/\d+/)[0]` (which picked up "1" in `free1` hostname).

5. **`content_marketScan.js` child-tab worker** — UAS dispatches per-type child tabs. Verify session-storage handshake intact.

6. **Manifest match patterns vs content scripts** — verify each `content_*.js` is referenced by a manifest content-script entry with right `matches` pattern. Cross-reference with Agent 1.

7. **Options page** — verify brutalist skin section + density radio round-trip through `chrome.storage.sync`. Verify `aes_skin_enabled` + `aes_skin_density` are only sync keys touched.

8. **Popup** — usually minimal in MV3. Verify it doesn't make AS POSTs or carry state conflicting with content-script panels.

## Specific things flagged

- "background.js batch pipeline timeouts: AFP_BATCH_FILL_TIMEOUT_MS = 30s, AFP_BATCH_RELOAD_TIMEOUT_MS = 30s, AFP_BATCH_INTER_LEG_DELAY_MS = 500ms, AFP_BATCH_TOTAL_TIMEOUT_MS = 20min" — verify constants exist and are honoured.
- "Reload-timeout recovery: closes possibly-wedged tab, recreates fresh one, continues" — verify recovery doesn't loop infinitely.
- "Notifications listener wired ONCE via `_aesLongOpClickWired` flag" — verify flag prevents duplicate registration.
- "Customization patch handler" — handover mentions without detail. Audit what it does.

## Smoke approach

Most of your work is static + in your own service worker DevTools:

- Open `chrome://extensions/`, click your extension's "service worker" link to get DevTools on the SW.
- Read every `chrome.runtime.onMessage.addListener` and trace what it expects.
- Grep across the repo for every `chrome.runtime.sendMessage` call. Verify message types match what background handles.
- Read every `chrome.alarms.*` call; verify lifecycle (create / clear / onAlarm).
- Verify async handlers `return true` (otherwise response promise dropped).

## Forbidden

- No edits inside `modules/**`.
- No new `chrome.runtime.onMessage` types without confirming with originating module's owner.
- No new permissions in manifest (Agent 1).
- No silent removal of existing message handler.
- No flipping silent-auto enabled-by-default.
- **No committing changes to credentials.json.** Audit only. If you find issues with the credential format or login flow, write findings; don't auto-fix.

## End-of-session deliverable

`audit/findings-AGENT-7.md`:

- All `background.js` message handlers traced and verified.
- AFP batch pipeline timeouts + abort path verified.
- Silent-auto alarm + storage-onChange reconcile verified.
- `content_aircraftFlights.js` flightId regex fix in current code.
- All `content_*.js` traced to manifest entries.
- Customization patch handler documented.
- Options page sync round-trip verified.
- Login flow concurrent-instance behavior documented.
- List of message-passing inconsistencies (sender uses type X, handler expects Y).
