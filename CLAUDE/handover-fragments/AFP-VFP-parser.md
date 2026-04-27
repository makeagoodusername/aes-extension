# AFP — Visual Flight Plan parser audit

Selector audit for `host.js:readVisualFlightPlan`, written for slice 6a.
The parser walks `.day .blocks > .block.flight` across Mon–Sun and emits a
`Leg` per flight bar. Validated against the populated 13536 capture; the
6968 captures still return `[]` because their `.blocks` are empty.

## Snapshot used

`CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:13536:0?6 flight plan.html`
— 14+ flight bars across all seven days (verified via
`grep -c 'class="block flight' …` = a populated VFP).

## Confirmed selectors

| Field | Selector | Notes |
|---|---|---|
| Day root | `.as-panel.visual-flight-plan .vfp.vfp-main .day` | One per Mon..Sun |
| Day name | `.day > .dayName` | `Monday`..`Sunday` |
| All blocks | `.day > .blocks > *` | Mixed: `flight`, `location`, `turnaround`, `ready` |
| Flight bar | `.block.flight` | Filter on classList |
| Flight code | `.block.flight .code` | Text like `"79"` or `"FGM 1"` — no airline prefix |
| Flight detail link | `.block.flight a[href*='/numbers/']` | Href is AS-relative `../../../com/numbers/<id>?segment=0` |
| Flight id | regex `/numbers\/(\d+)/` on the href | We canonicalise to `/app/com/numbers/<id>` |
| Departure (origin) IATA | previous sibling `.block.location > .outbound[title]` | `<span class="outbound" title="JFK">JFK</span>` |
| Arrival (destination) IATA | next sibling `.block.location > .inbound[title]` | `<span class="inbound" title="LAX">LAX</span>` |
| Day-spanning markers | `block.classList` `started` / `ended` | `started` only → spans into next day; `ended` only → spans from prev |

## Time encoding (confirmed)

CSS percentages on each block carry timing info. `margin-left` is the
position relative to the day's left edge (00:00) as a fraction of 1440 min.
`width` is the duration the bar occupies.

```
margin-left: 25.0%   →  25/100 × 1440 = 360 min  → 06:00
width:       21.46%  →  21.46/100 × 1440 = 309 min → 5h09m
```

The `<span class="start">` / `<span class="end">` text inside the bar is
**unreliable** as a parsing source:
- Long bars: `<span class="start">0600</span>` (HHMM, four digits)
- Short bars (with class `short`): `<span class="start">10</span>` (just minutes)

Parser deliberately ignores those spans and derives time from
`margin-left` + `width`, rounding to the nearest minute. This trades a
tiny amount of float-precision noise (e.g. `0.6944% × 1440 = 9.999 min`
rounded to 10) for a single well-defined code path.

## Best-effort vs uncertain

| Field | Confidence | Reason |
|---|---|---|
| flightId, flightLink | HIGH | Anchor href shape stable across all 14 flight bars in 13536 |
| flightCode (suffix) | HIGH | `<span class="code">` always present inside the flight bar |
| depTimeLocal | HIGH | `margin-left` parses cleanly to a minute; rounding error ≤ 1 min |
| arrTimeLocal | MEDIUM | Computed `(start + width) % 1440`; spans-into-next flights wrap to early-morning value of the *next* day, which is correct but caller should respect `spansIntoNext` |
| origin, destination | MEDIUM | The location-bar sandwich pattern is consistent in 13536 but a wrap-of-the-day flight could in principle have only one location bar adjacent; parser falls back to `null` rather than guessing |
| flightCode → full flight number | UNCERTAIN | Span carries only the suffix (`"79"`); the airline code prefix (`AA`) lives on a different page (`/app/com/numbers/<id>`). Track 6 diff matches on origin+dest+depTime so the prefix is not needed for slice 6b, but a future "show full flight number" surface needs an enrichment pass via the flight-number detail page |

## Day-spanning shape

A block with `class="block flight started"` (no `ended`) represents a
flight that begins in this day and continues past 24:00. The mirror
block with `class="block flight ended"` (no `started`) appears in the
next day starting at `margin-left: 0%`. The parser emits both halves as
separate legs — slice 6b's `ScheduleDiff` matches by origin+dest+depTime
so only the `started` half (the one with the real depTime) participates
in the keep/delete/add decision; the `ended` half always appears with
`depTimeLocal` of `00:00` and is best treated as a continuation marker.

The 13536 capture happens to have **no** day-spanning flights so this
behaviour wasn't exercised end-to-end. Flagged here so a future test on
a long-haul aircraft (e.g. JFK–HKG) can verify the parser.

## Returned leg shape

```js
{
  seq:           1,            // 1-based, ordered by (dayIdx, depTime) across all days
  dayIdx:        0,            // 0..6, Mon..Sun
  dayName:       "Monday",
  depTimeLocal:  "06:00",
  arrTimeLocal:  "11:09",      // null if width is missing
  durationMin:   309,
  origin:        "JFK",        // null if no .block.location precedes the flight bar
  destination:   "LAX",        // null if no .block.location follows
  flightCode:    "FGM 1",      // text of <span class="code">
  flightNumber:  "FGM 1",      // alias for callers expecting `flightNumber`
  flightId:      "9018",       // numeric AS id, parsed from the href
  flightLink:    "/app/com/numbers/9018",
  spansIntoNext: false,
  spansFromPrev: false,
  raw:           HTMLElement   // back-pointer to the <div.block.flight>
}
```

`origin` / `destination` may be `null` if AS rendered an unusual
sequence (no preceding/following location bar). Slice 6b's diff engine
treats null sides as a non-match, so a leg with a missing IATA cannot
be a "keep" — it always becomes a delete (or add) candidate, which is
the safe failure mode.

## Open questions

- **Long-haul day-spanning flights** — not present in the 13536 capture.
  When one ships, verify the parser emits two legs (one with
  `spansIntoNext: true`, one with `spansFromPrev: true`) and that diff
  treats them sensibly. The conservative call right now is to skip
  `spansFromPrev: true` legs when comparing against a proposed Build,
  since their `depTimeLocal` is structurally `00:00` and would only ever
  match a midnight-departure proposal by accident.
- **Multi-segment flight numbers** — `?segment=0` in the href hints AS
  has multi-segment FNs. The 13536 capture only has `segment=0` for
  every link; a multi-segment aircraft would let us audit whether
  `segment=1` flights need to be emitted as separate legs or rolled up.
- **Airline-prefix enrichment** — slice 6c (flight-deleter) will hit
  `/app/com/numbers/<id>` directly, which is also where the full flight
  number (e.g. `AA79`) is exposed. If a future surface needs the prefix
  in the leg shape, hydrate it there rather than re-parsing the AFP page.
