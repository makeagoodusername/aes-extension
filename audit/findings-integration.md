# Findings — Upstream AES v0.7.8 integration session (2026-05-04)

**Summary:** 3 imports, 3 fixed (created), 0 blocked, 0 deferred-confirmed.
8 upstream files deliberately not imported (target ahead or no counterpart
needed); see `## Out-of-scope (deliberate non-imports)` below.

**Source:** `/Users/jihwan/Downloads/AES.v0.6.9/AirlineSim-Enhancement-Suite-main/extension/`
**Strategy:** Greenfield-only — only files with no target counterpart, adapted
to target's IIFE + `_shared/` + kebab-case + `host.js` conventions.

---

## [FIXED] modules/_shared/notifications.js (new)

Combined upstream `modules/notification.js` (74 lines) + `modules/notifications.js`
(50 lines). Renders into AS's native `.feedbackPanel` slot — the same banner UI
AirlineSim uses for its own success/warning/error feedback. Exposes
`window.AesNotifications = { Notification, Notifications, toast(msg, opts) }`.
The `toast()` helper is a singleton convenience; producers can also instantiate
`new AesNotifications.Notifications()` directly. Loaded as part of the
always-on shared bundle, after `_shared/cleanup-registry.js`.

Coexistence: `modules/route-assistant/toast-host.js` is RA-feature-specific
and uses different CSS classes; this one is the generic AS-style banner.
No collision.

## [FIXED] modules/release-notes.js (new)

Adapted upstream `modules/release-notes.js` (293 lines). IIFE-wrapped, exposes
`window.AesReleaseNotes = { STORAGE_KEY, RELEASE_NOTES, ReleaseNotesDialog,
show, maybeShow, addFooterLink }`. Footer-link installer + open-once gate run
on load.

The hardcoded `AES_RELEASE_NOTES` dict for upstream's `0.7.7`/`0.7.8` was
replaced with a single placeholder entry for target's `version_name`
(`0.6.12-beta`) so the dialog doesn't lie to users about features they don't
have. User should populate the placeholder's `sections` array before shipping.

New chrome.storage.local key: `aesReleaseNotesSeenVersion` (single string,
last-seen version). Needs an entry in HANDOVER.md §4 storage-key registry
in a follow-up commit.

## [FIXED] modules/online-reservation-system/host.js (new)

Adapted upstream `modules/onlineReservationSystem/onlineReservationSystem.js`
(180 lines) into a kebab-case module folder with the standard `host.js`
mount-point name. IIFE-wrapped, exposes
`window.AesOnlineReservationSystem`.

Adds two enhancements to AS's ORS results page:
- Numeric labels next to rating images (parsed from `img.title`).
- A "Difference" column on the totals row, comparing each row's rating to
  the running max. Max persists across navigation in `localStorage` key
  `tmp_ors_maxRating` (per-tab session state — settings-bridge isn't used
  here because the data is ephemeral, not a setting).

Defensive URL-pathname guard inside the IIFE in case the manifest pattern
is widened. Manifest entry matches `https://*.airlinesim.aero/app/info/ors*`.

Coexistence: `modules/route-assistant/ors-scraper.js` analyzes scraped ORS
data for RA's pricing engine. Different surface, no shared state.

---

## [OUT-OF-SCOPE] (deliberate non-imports)

| Upstream | Why skipped |
|---|---|
| `extension/manifest.json` | Target's manifest is a 12× superset (~20 content_scripts blocks for features upstream doesn't have). Replacing would erase most of the project. |
| `extension/background.js` | Target SW is a thin shim by design; upstream re-introduces default-settings logic now in helpers/settings-bridge. |
| `extension/options.{html,js}` | Target's options.js is a complete data-manager rewrite. Upstream would regress. |
| `extension/popup.{html,js}` | Both minimal; not worth churn. |
| `extension/helpers.js` | Diverged; target has unique helpers (`AES.getAirlineIdentity` etc.). Cherry-pick deferred. |
| `extension/content_*.js` (all overlaps) | Target ahead on every overlap. Excluded by greenfield-only scope. |
| `extension/modules/aes-menu.js`, `extension/modules/about-dialog.js` | Target ahead (816 vs 171, 180 vs 107). |
| `extension/modules/inventory/validation.js` | Target ahead (178 vs 166). |
| `extension/modules/flightInfo/flightInfo.js` | Not greenfield — `content_flightInfo.js` already covers the same `/action/info/flight*` URL. The upstream's class-based refactor is a possible follow-up. |

---

## Manifest changes

Logged in `audit/manifest-requests.md` (this session's entry):

1. `modules/_shared/notifications.js` — appended to always-on shared bundle
   (after `_shared/cleanup-registry.js`).
2. `modules/release-notes.js` — appended to always-on shared bundle (after
   `modules/about-dialog.js`).
3. New `content_scripts` block matching `/app/info/ors*` loading
   `modules/online-reservation-system/host.js`.

---

## Verification

- `node --check` clean on all three new files.
- `python3 -c "import json; json.load(open('manifest.json'))"` clean.
- Live Chrome verification deferred to user; checklist in plan file
  `/Users/jihwan/.claude/plans/effervescent-floating-wand.md` § Verification.

---

## Handoff notes for next session

1. Populate `RELEASE_NOTES["0.6.12-beta"].sections` in `modules/release-notes.js`
   with real entries before any user-facing release.
2. Add `aesReleaseNotesSeenVersion` to HANDOVER.md §4 storage-key registry.
3. Decide whether to swap target's `content_flightInfo.js` for a class-based
   `modules/flight-info/host.js` (upstream's flightInfo refactor). Current
   session left target's implementation untouched.

## Open questions for the user

- Real release-notes copy for `0.6.12-beta`?
- Should the manifest ever widen the ORS URL match (e.g., to `/action/info/ors*`)?
  Current pattern is the same as upstream.
