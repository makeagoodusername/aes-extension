# AFP — Visual Flight Plan parser audit

Selector audit for `host.js:readVisualFlightPlan`, written for slice 6a
and extended for the 6a-followup multi-day collapse. The parser walks
`.day .blocks > .block.flight` across Mon–Sun and emits one *logical*
`Leg` per flight (day-cross pairs are collapsed into a single leg
with `crossesMidnight: true`). Validated against the 13536 (same-day)
and 21944 MULTIDAYROUTES (6 day-crosses) captures; the 6968 captures
still return `[]` because their `.blocks` are empty.

## Snapshots used

- `CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:13536:0?6 flight plan.html`
  — 14+ flight bars across all seven days, all same-day. (`grep -c
  'class="block flight' …` = 14.)
- `CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:21944:0?13 MULTIDAYROUTES.html`
  — 20 flight bars: 8 same-day + 6 day-cross pairs (12 visual halves).
  Collapse outputs 14 logical legs.

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
| arrTimeLocal | HIGH | Computed `(start + width) % 1440`; for collapsed day-cross pairs, taken from the ended half's `(start + width)` in its own day frame |
| origin, destination | HIGH | Validated across both 13536 (same-day) and 21944 (multi-day) captures. For day-cross pairs the merged leg's `destination` comes from the ended half's same-day next-sibling `.inbound[title]`, which is the correct arrival airport |
| flightCode → full flight number | UNCERTAIN | Span carries only the suffix (`"79"`); the airline code prefix (`AA`) lives on a different page (`/app/com/numbers/<id>`). Track 6 diff matches on origin+dest+depTime so the prefix is not needed for slice 6b, but a future "show full flight number" surface needs an enrichment pass via the flight-number detail page |

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
  crossesMidnight: false,        // true when this leg was merged from a started+ended pair
  raw:           HTMLElement   // back-pointer to the <div.block.flight> (started half if merged)
}
```

`origin` / `destination` may be `null` if AS rendered an unusual
sequence (no preceding/following location bar). Slice 6b's diff engine
treats null sides as a non-match, so a leg with a missing IATA cannot
be a "keep" — it always becomes a delete (or add) candidate, which is
the safe failure mode.

## Multi-day flights (slice 6a-followup)

Validated against
`CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:21944:0?13 MULTIDAYROUTES.html`
— 20 flight bars, 6 day-cross pairs (Mon-Tue, Tue-Wed, Wed-Thu, etc.)
across all 7 days, plus 8 same-day flights. Class shapes:

| Class | Count | Meaning |
|---|---|---|
| `block flight started ended` | 8 | Same-day flight |
| `block flight started`        | 6 | Crosses into next day (first half) |
| `block flight ended`          | 6 | Continuation from prev day (second half) |

Both halves share `flightId` (the `numbers/<id>` parsed out of the
overlay anchor) AND `flightCode` (the `<span class="code">` text). The
`started` half's `<span class="start">` text is the dep time in HHMM
(`"1940"`); the `<span class="end">` is `"0000"` (midnight marker). The
matching `ended` half's spans are `"0000"` / `"0251"` — the second half
of the same flight.

The parser pairs them in `_collapseDayCrossPairs(legs)` by `flightId` +
`dayIdx + 1` (mod 7 for Sun→Mon wrap). The `started` half is kept as
the canonical merged leg with:

- `depTimeLocal` from the started half (e.g. `"19:40"`)
- `arrTimeLocal` from the ended half (e.g. `"02:51"`)
- `durationMin` = sum of both halves' widths (e.g. 260 + 171 = 431 min)
- `destination` from the ended half (its same-day `.inbound` IATA)
- `crossesMidnight: true`
- `dayIdx` from the started half (the day the flight LEAVES)
- `seq` re-stamped after collapse so it stays gap-free

The `ended` half is dropped from the output.

Pathological shapes (a `started` with no matching `ended`, or vice
versa) emit `console.warn("[AES afp-6a] unpaired day-cross …", …)`
and stay in the output as same-day legs (`crossesMidnight: false`).

The retired `spansIntoNext` / `spansFromPrev` flags were internal
scaffolding; they're stripped from every output leg before return so
consumers see only `crossesMidnight`.

## Open questions

- **Multi-cross long-haul** (a flight that crosses TWO midnights, e.g.
  a 30+ hour flight) would produce a `started` + same-flightId
  `started` + `ended` pattern. AS is unlikely to render this (the
  longest scheduled flight in any AS server is ~18h), but the
  pairing logic would currently merge the FIRST started with the
  next-day ended and warn-then-skip the second started. Acceptable
  for Phase 1.
- **Airline-prefix enrichment** — slice 6c (flight-deleter) will hit
  `/app/com/numbers/<id>` directly, which is also where the full flight
  number (e.g. `AA79`) is exposed. If a future surface needs the prefix
  in the leg shape, hydrate it there rather than re-parsing the AFP page.
