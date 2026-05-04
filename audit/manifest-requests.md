# Manifest requests
# Agent 1 reads. Other agents append.

---

## 2026-05-01 — Agent 7 — add settings-bridge.js to legacy content_*.js entries

**Why:** F-8-005 (cross from Agent 8) requires migrating 24 direct
`chrome.storage.local.set({settings})` writers in legacy content_*.js to
`window.AesSettings.saveArea()`. Today only 2 manifest entries inject
`modules/_shared/settings-bridge.js`; the entries that load
`content_dashboard.js`, `content_settings.js`, `content_inventory.js`,
`content_personelManagement.js`, and `content_fligthSchedule.js` do not.
Without bridge in scope, `window.AesSettings` is undefined and migration
is a no-op (or breaks).

**Ask:** prepend `modules/_shared/settings-bridge.js` to the `js` array of
the manifest entries that load each of these five content scripts (entries
2, 3, 4, 5, 13 in `manifest.json` per current ordering). The bridge is
idempotent — adding it to additional entries is safe.

**Blocked work:** F-8-005 settings-writer migration (24 sites in territory)
sits behind this. I'll land the migrations as soon as the bridge ships.

Note: `modules/_background/legacy-defaults.js:88` is intentionally a
whole-blob bootstrap write (first-install only); excluded from migration.

---

## 2026-05-04 — Integration session (upstream AES v0.7.8 greenfield import)

Three manifest entries added; all greenfield (no target counterpart).
Source: `/Users/jihwan/Downloads/AES.v0.6.9/AirlineSim-Enhancement-Suite-main/extension/`
adapted to target's IIFE / `_shared/` / kebab-case conventions.

**Always-on shared bundle (the second `content_scripts` entry,
`/app/*` + `/action/*`):**

- Added `modules/_shared/notifications.js` immediately after
  `modules/_shared/cleanup-registry.js`. Generic AS-style
  `feedbackPanel` toast utility; exposes `window.AesNotifications`
  ({Notification, Notifications, toast}). Coexists with
  `modules/route-assistant/toast-host.js` (RA-specific, different
  CSS classes). No bus topic — pure side-effectful renderer.
- Added `modules/release-notes.js` immediately after
  `modules/about-dialog.js`. Per-version changelog dialog; exposes
  `window.AesReleaseNotes`. Auto-opens once after an update keyed
  by new chrome.storage.local key `aesReleaseNotesSeenVersion`
  (needs HANDOVER §4 entry — follow-up). Seeded with a single
  placeholder entry for `0.6.12-beta`; user should populate real
  notes before shipping.

**New content_scripts block:**

- Added entry matching `https://*.airlinesim.aero/app/info/ors*`
  loading `modules/online-reservation-system/host.js`. Read-only
  DOM enhancement: numeric labels next to ORS rating images and a
  "Difference" column. Exposes `window.AesOnlineReservationSystem`.
  Coexists with `modules/route-assistant/ors-scraper.js` (different
  surface — that one analyzes scraped server data, this one
  decorates the in-page table). Defensive URL-pathname guard inside
  the IIFE in case the manifest pattern is widened in the future.

**Files NOT touched** (deliberate, per "greenfield only" scope):
`background.js`, `helpers.js`, `options.{html,js}`, `popup.{html,js}`,
all `content_*.js`, `modules/aes-menu.js`, `modules/about-dialog.js`,
`modules/inventory/validation.js`, `modules/flightInfo/` (target's
`content_flightInfo.js` already covers the same `/action/info/flight*`
URL — upstream's class-based module is a follow-up refactor candidate,
not a swap-in this session).

CLAUDE.md §3 invariants preserved:
- Rule 1 (no new POSTs to AS): all three modules are read-only.
- Rule 2 (storage-key contract): one new top-level key
  `aesReleaseNotesSeenVersion`; all other state is per-tab
  localStorage (`tmp_ors_maxRating`).
- Rule 5 (bus is integration contract): no new bus topics needed —
  these modules are leaf renderers.
- Rule 7 (no silent default flips): nothing defaults-on; the
  release-notes auto-open is gated by an explicit unset
  storage key, not a setting flip.
