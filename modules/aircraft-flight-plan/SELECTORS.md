# Aircraft Flight Plan — DOM selectors

Reference for every selector this module relies on. The runtime mirror lives in `diagnostics.js` (`SELECTORS` table) — keep the two in sync; `AesAfpDiagnostics.runSelfTest()` walks them and reports pass/fail on the live page.

**Source snapshot:** `CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:6968:0?925.html` (the AFP page captured for slice planning). Re-verify against a fresh capture if AS ships a Wicket markup change.

**Wicket id caveat:** every `id<NNNN>` attribute on this page is regenerated on each render. Never select by id. Match by name / action / text / class instead.

**select2 version:** AS uses **select2 v3** on the origin and destination selects (the `select2-offscreen` class is a v3-only marker; v4 uses `select2-hidden-accessible`). The two builds disagree on the `val` setter signature — see `form-driver.js:_commitSelect` for the version-dispatch.

---

## Form root

| Purpose | Selector | Notes |
|---|---|---|
| New-flight form | `form[action*='aircraft.newflight.number']` | Anchored on `action` because the form id reshuffles every render |
| Submit button | `input[type='submit'][value*='Create new flight']` | Only-one match on the page; disambiguates from the Transfer-flight-plan form's `Transfer Flight Plan` submit |

`host.js:findNewFlightForm()` chains the two: it finds the submit button first, then walks `closest('form')` to scope every other lookup to that form's subtree.

## Selects (six fields)

All scoped to the form root. Origin / destination use select2 v3; the rest are native.

| Field | Selector | Option value semantics |
|---|---|---|
| Origin | `select[name='origin']` | airport id (numeric) — option label is `"City, Region (IATA)"` |
| Destination | `select[name='destination']` | same as Origin |
| Hours | `select[name='departure:hours']` | unpadded `"0".."23"` |
| Minutes | `select[name='departure:minutes']` | unpadded `"0","5","10",...,"55"` |
| Price | `select[name='price']` | price-percent string (`"50"`, `"100"`, `"150"`, …) |
| Service | `select[name='service']` | service-class string |

`form-driver.js:_findOptByIata` matches an IATA against the visible label via `\b<IATA>\b` (city names are mixed-case, so the case-sensitive uppercase token only matches the parenthetical IATA). The function then returns the option element; `_commitSelect` reads `opt.value` (the airport id) and passes that to select2 — that's the value AS expects on POST.

## Buttons & links

| Purpose | Selector | Fallback | Notes |
|---|---|---|---|
| Reverse O/D | `a.btn.btn-default[href*='toggle~stations']` | text-match `/reverse/i` within form | `host.js:findNewFlightForm` already chains both |
| Flight-number input | `input[name='number:number_body:input']` | `input[name$=':number_body:input']` then `input[type='text'][maxlength='4'][name*='number']` | 1–4 numeric chars; AS auto-assigns when blank on submit |
| Find first available | `a[href*='number~find~first']` | `a[title='find first available']` | Wicket Ajax — populates the input subtree on click |
| Find available | `a[href*='number~find']:not([href*='number~find~first'])` | `a[title='find available']` | Same Wicket Ajax shape; cycles through available numbers |

## Tabs (form visibility gate)

The "New Flight Number" form's submit button only exists in its own tab panel. When the user is on the "Existing Flight Number" tab, `findNewFlightForm()` returns null. `host.js:findFormTabs()` locates both tabs and reports which is active so `form-driver.js:_ensureNewTabActive()` can flip to "New" and poll until the panel swap completes.

Find the right `.nav-tabs` first by looking for one whose text contains both labels; fall back to `.as-page-aircraft .col-md-10 .nav-tabs`. Then within that nav:

| Tab | Primary | Fallback | Notes |
|---|---|---|---|
| New Flight Number | `a` with text `"New Flight Number"` | `a[href*='newFlightNumber'], a[href*='toggle~new']` | Active state: `li.active` parent contains the matching anchor |
| Existing Flight Number | `a` with text `"Existing Flight Number"` | `a[href*='existingFlightNumber'], a[href*='toggle~existing']` | Same active-state convention |

Active tab readout: `findFormTabs()` returns `activeTab` as `"new"`, `"existing"`, or `"unknown"` based on the `li.active`'s text.

## Wicket internals — leave alone

| Purpose | Selector | Notes |
|---|---|---|
| Hidden form-state container | `form > div.hidden-fields[hidden]` | Carries CSRF / form state. `dryRun()` reads it for honesty; nothing in this module writes to it |

---

## Visual Flight Plan blocks (Track 7)

The bottom half of the AFP page is `.as-panel.visual-flight-plan` — a per-day Gantt that AS calls the "visual flight plan" or VFP. Slice 7a's `vfp-reader.js` walks every `.day .blocks` and emits typed `ScheduleBlock`s for all six block kinds. Slice 7b adds the popover + planning-matrix readers.

| Kind | Primary | Inner data | Modifiers seen | Capture line |
|---|---|---|---|---|
| location | `.block.location` | `span.outbound[title=IATA]` / `span.inbound[title=IATA]` | `started`, `ended`, `short`, `dimmed` | 4411–4417 |
| maintenance | `.block.maintenance` | none — width = downtime | `started`, `ended` | 4418, 5319 |
| turnaround | `.block.turnaround` | `.modal#ta-NN table.table` (see Turnaround popover below) | `started`, `ended`, `dimmed` | 4421, 4425 |
| flight | `.block.flight` | `.code`, `a[href*='/numbers/']`, `.times>span.start/.end`, `.overlay a[title]` | `started`, `ended`, `locked`, `dimmed` | 4699–4717 |
| ready | `.block.ready` | none — width = ready window | `started`, `ended`, `dimmed` | 5002, 5314 |
| overlap | `.block.overlap` | none — boundary marker | `started`, `ended` | 5007, 5923 |

Time encoding uses CSS `margin-left` / `width` percentages of 24h. `1% = 14.4 min`. The `<span class="start|end">` text is unreliable on short bars — use the percent values.

`spansIntoNext` / `spansFromPrev` are derived from the `started` / `ended` modifiers (started without ended ⇒ runs into next day; ended without started ⇒ continued from previous).

### Flight overlay (per-bar action icons)

Inside each `.block.flight`:

| Action | Selector | href shape | Notes |
|---|---|---|---|
| Info | `.overlay a[title*='View flight']` | `https://…/app/com/numbers/<id>?segment=N` | Carries `<span class="fa fa-info">` |
| Edit | `.overlay a[title*='Set planner']` | `…?<query>-1.-tabs-panel-visualFlightPlan-days-D-blocks-B-content-overlay-edit` | Wicket Ajax — `<span class="fa fa-edit">` |
| Delete | `.overlay a[title*='Delete']` | `…-content-overlay-delete` | Wicket Ajax — `<span class="fa fa-remove">` |

The Wicket-Ajax URLs are captured for completeness; future writer slices can post them via the `Wicket.Ajax.ajax({u, c, e})` plumbing AS injects in the page header (capture lines 55-82).

## Turnaround popover (Track 7 Slice 7b)

Each `.block.turnaround` contains a Bootstrap modal with the per-side activity decomposition.

| Purpose | Selector | Notes |
|---|---|---|
| Modal root | `.block.turnaround .modal[id^='ta-']` | One modal per turnaround block; id is `ta-NN` |
| Activity table | `.modal table.table` | Three `<tbody>` blocks: Inbound / Outbound / Split Turnaround |
| Section heading row | `tbody > tr:first-child > th[colspan='5']` | Text is `Inbound`, `Outbound`, or `Split Turnaround` |
| Activity row | `tbody > tr:has(td.name)` | Cells: name, start-pair, duration-bar, completion-pair, float |
| Activity name | `td.name` | "Taxi In", "De-Boarding", "Boarding", "Pushback/Taxi Out", … |
| Duration HH:MM | `td.duration-bar .progress-bar > span` | Per-activity duration |
| Earliest/latest start | `tr > td:nth-of-type(2) > span` | Two spans separated by " / " |
| Earliest/latest end | `tr > td:nth-of-type(4) > span` | Same shape as start |
| Float HH:MM | `tr > td:nth-of-type(5)` | Slack between earliest/latest |
| Inbound total | `tbody:has(th:contains('Split')) tr:nth-of-type(2) td:nth-of-type(2) span:first-of-type` | "Duration of inbound activities" row |
| Outbound total | `tbody:has(th:contains('Split')) tr:nth-of-type(3) td:nth-of-type(2) span:first-of-type` | "Duration of outbound activities" row |
| Maintenance window | `tbody:has(th:contains('Split')) tr:nth-of-type(4) td:nth-of-type(2) span` | Single value |

`turnaround-popover-reader.js` walks the three tbodies, distinguishing them by the text of the leading `<th colspan='5'>`. Section headings without a `td.name` row are skipped, so detection is robust to AS adding new caption rows.

## Planning matrix (Track 7 Slice 7b)

The `<form action*='flight.planning.form'>` matrix at the top of the AFP page (capture line 2381). 7-column grid Mon..Sun × per-segment rows.

| Purpose | Selector | Notes |
|---|---|---|
| Form root | `form[action*='flight.planning.form']` | Always inside `<div class='as-panel'>` after the new-flight panel |
| Day-selection checkbox | `input[type='checkbox'][name*='daySelection:'][name*=':ticked']` | Name pattern `days:daySelection:N:ticked` |
| Base departure hh | `select[name='segmentSettings:N:newDeparture:hours']` | One per segment N |
| Base departure mm | `select[name='segmentSettings:N:newDeparture:minutes']` | One per segment N |
| Origin terminal | `select[name*='segmentSettings:N:'][name*='originTerminal']` | Optional — present only when terminals are configurable |
| Destination terminal | `select[name*='segmentSettings:N:'][name*='destinationTerminal']` | |
| Per-day departure offset | `select[name*='segmentsContainer:segments:N:departure-offsets:D:departureOffset']` | Values `-60..+60` (signed minutes) |
| Per-day fixed-arrival | `input[type='checkbox'][name*='segmentsContainer:segments:N:fixedArrivalSelection:D:fixedArrival']` | |
| Per-day arrival hh | `select[name*='segmentsContainer:segments:N:newArrivals:D:newArrival:hours']` | |
| Per-day arrival mm | `select[name*='segmentsContainer:segments:N:newArrivals:D:newArrival:minutes']` | |
| Departure-time-validity row | `tr` whose `td.caption` contains `Departure Time Validity` | Per-day check icons in trailing cells |
| Aircraft-performance row | `tr` whose `td.caption` contains `Aircraft performance` | |
| Route-restrictions row | `tr` whose `td.caption` contains `Route Restrictions` | |
| Departure slots (origin) | `tr` whose `td.caption` text matches `^Departure slots$` | First match in document order |
| Nighttime departure | `tr` whose `td.caption` text matches `^Nighttime departure$` | |
| Noise restrictions (origin) | First `tr` whose `td.caption` text matches `^Noise restrictions$` | Two rows share this caption — first = origin, second = destination |
| Arrival slots (destination) | `tr` whose `td.caption` text matches `^Arrival slots$` | |
| Nighttime arrival | `tr` whose `td.caption` text matches `^Nighttime arrival$` | |
| Noise restrictions (destination) | Second `tr` whose `td.caption` text matches `^Noise restrictions$` | |

Check icons: `<span class="fa fa-check">` = pass; `<span class="fa fa-times">` / `fa-remove` / `fa-ban` = fail; empty cell = unknown (returns `null`, NOT `false`).

`expandCellsToDays(tr)` handles per-day cells with `colspan` > 1 by replicating the cell into multiple day slots — necessary because the base-departure cell spans 3 day columns visually. The function caps the result at 7 entries.

## Verifying on a live page

1. Open any aircraft Flight Plan page with `?aes-debug` (e.g. `/app/fleets/aircraft/6968/0?aes-debug`).
2. The diagnostics overlay appears top-right.
3. Click **Run self-test**. Every row in the table above should be green.
4. Switch to the "Existing Flight Number" tab and re-run — the `form`-scoped rows turn red (form not in DOM) but the `tabs`-scoped rows stay green.
5. Click any candidate row from the AFP candidates panel; the form-driver auto-flips to the New tab and the live form-state table in the overlay should show every chip update with the new value.

If a selector starts failing because AS changed markup, update `SELECTORS` in `diagnostics.js` and this doc together.
