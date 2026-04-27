# Flight Studio — DOM selectors addendum

> Slice-local supplement to `modules/aircraft-flight-plan/SELECTORS.md`.
> Documents the additional DOM contracts the Studio relies on. Folded
> into the parent SELECTORS doc per slice; this file tracks origin per
> slice so a future regression has a paper trail.

## S1 — what the panel reads / writes

The S1 panel **does not** introduce any selectors against AS's own form
markup. It re-uses `AesAfpFormDriver.dryRun()` (which reads the existing
form's `<select>` options) and renders into its own slot
(`AesAfp.slot("studio")`).

### Slot anchor

| Purpose | Selector | Owner |
|---|---|---|
| Studio mount slot | `[data-aes-afp-slot='studio']` inside `[data-aes-afp-wide-host]` | `host.js` (slot definition); `flight-studio/panel.js` (consumer) |

The slot is created by `host.js:buildWideScaffold()` from the
`WIDE_SLOT_NAMES` list. It sits between `auto-preview` and `candidates`
in document order so the compose surface is visually adjacent to the
auto-build readout.

### AESMenu injection target

The S1 plan included an AESMenu submenu (`menu-extension.js`) but it was dropped before merge: the Studio panel auto-mounts on every AFP page via the `ctx:ready` bus event, so the menu entry was redundant on AFP pages and could not render anywhere else (the `studio` slot only exists on `/0`). If a future slice needs a global entry-point (e.g. cross-tab "open Studio for aircraft X"), it should land as a Central Hub tile or a keyboard shortcut, not a global menu item.

### Internal panel structure (Studio-owned)

These selectors are entirely internal to the Studio panel — no AS markup.
Listed here for diagnostics / tests.

| Purpose | Selector |
|---|---|
| Panel root | `[data-aes-studio-root]` |
| Body container (re-rendered on every state change) | `[data-aes-studio-body]` |
| Mode badge ("DRY-RUN" etc.) | `[data-aes-studio-mode]` |
| Dry-run details element | `[data-aes-studio-dry]` |
| Dry-run body `<pre>` | `[data-aes-studio-dry-body]` |
| Per-message hint | `[data-aes-studio-hint]` |

## Future slices (placeholder)

S2 introduces these new AS selectors (text-anchored, NOT Wicket ids):

- **Add via link** — `a` whose visible text matches `/\badd via\b/i` inside the New-Flight form; fallback `a[href*='add~via~container-link']`. Wicket-AJAX-driven; awaiting an indicator settle is required.
- **Flight number text input** — `input[type='text'][name$=':number_body:input']` or `input[type='text'][name*='number:number']` (maxlength 4) inside the New-Flight form.
- **Aircraft settings form** — `form[action*='aircraft.aircraft.settings']` (separate form on the page, NOT the New-Flight form).
- **Nickname input** — within the aircraft-settings form: `input[type='text'][name$=':name']` or `input[name*='name-group']` (maxlength 40).
- **Personal note input** — within the aircraft-settings form: `input[type='text'][name$=':remark']` or `input[name*='remark-group']` (maxlength 255).

S5 introduces:

- **Existing Flight Numbers tab listing** — for `registry-capturer.js` to scrape PAA-XX assignments after a successful submit. Specific selector TBD when S5 lands; must match the visible flight-number entries inside the "Existing Flight Number" tab panel.

S6 reuses parent SELECTORS.md's VFP overlay rows — no new selectors.
