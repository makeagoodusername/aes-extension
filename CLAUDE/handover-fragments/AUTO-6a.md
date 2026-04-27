# AUTO-6a — VFP parser hardening

Track 6 slice 6a — sets up Track 6 by validating and rewriting the
Visual Flight Plan reader so a "diff against current schedule" feature
has a reliable input. The original parser at `host.js:175-207` (Slice A)
shipped against an empty-VFP capture and emitted one entry per *every*
block (location/turnaround/ready/flight) with hand-wavy regex extraction.
This rewrites it against the populated 13536 capture.

## What shipped

- REWROTE `modules/aircraft-flight-plan/host.js:readVisualFlightPlan` —
  filters to `.block.flight` only, derives time from CSS percentages (the
  source of truth — see AFP-VFP-parser.md for the full encoding audit),
  resolves origin/destination from the sandwiching `.block.location`
  bars' `.outbound[title]` / `.inbound[title]` IATAs, and emits a
  structured leg with synthesised `seq` (1-based, ordered by
  `(dayIdx, depTime)`).
- ADDED 4 internal helpers (`_readVfpFlightBlock`, `_percentToMinutes`,
  `_minToHHMM`, `_hhmmToMin`, `_findAdjacentIata`) — all kept inside the
  host IIFE; nothing new on the AesAfp public surface.
- ADDED `CLAUDE/handover-fragments/AFP-VFP-parser.md` — selector reference
  plus a confidence column (HIGH / MEDIUM / UNCERTAIN) that the rest of
  Track 6 can use to decide where additional verification is needed.
- Touched ONLY `readVisualFlightPlan` in host.js; `WIDE_SLOT_NAMES`,
  `findNewFlightForm`, and the rest of the file are untouched per the
  coordination rules.

## Public API surface (6a)

```js
AesAfp.getCurrentSchedule()  // already pointed at readVisualFlightPlan
  → Leg[]                    // see shape below

// Per-leg shape:
{
  seq:           number,     // 1-based, ordered by (dayIdx, depTime)
  dayIdx:        0..6,       // Mon..Sun
  dayName:       string|null,
  depTimeLocal:  "HH:MM"|null,
  arrTimeLocal:  "HH:MM"|null,
  durationMin:   number|null,
  origin:        "IATA"|null,
  destination:   "IATA"|null,
  flightCode:    string|null,           // suffix only, e.g. "79" or "FGM 1"
  flightNumber:  string|null,           // alias of flightCode
  flightId:      string|null,           // numeric AS id, e.g. "9018"
  flightLink:    "/app/com/numbers/<id>"|null,
  spansIntoNext: boolean,
  spansFromPrev: boolean,
  raw:           HTMLElement
}
```

`AesAfp.getCurrentSchedule` is already wired (Slice A); slice 6a only
upgrades what comes back from it.

## Validated against

`CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:13536:0?6 flight plan.html`
— 14+ flight bars across all seven days. The capture exposes:

- Short flights (`.block.flight.short`) — JFK→RDU, RDU→JFK
- Long flights (`.block.flight` no `short`) — JFK→LAX, LAX→JFK
- Repeated weekly pattern — same flight ids appear on multiple days

All four shapes parse correctly through the rewritten reader (manual
inspection of the markup against the parser logic).

The 6968 captures still produce `[]` (empty `.blocks`); behaviour
preserved.

## Selector confidence summary

See `AFP-VFP-parser.md` for the full table. Highlights:

- **HIGH**: flightId, flightLink, flightCode (the `<span class="code">`
  text), depTimeLocal (from `margin-left`).
- **MEDIUM**: origin/destination — the sandwich pattern is consistent
  across the 14 flights in 13536 but a wrap-of-the-day flight could in
  principle have only one location bar adjacent. Parser falls back to
  `null` rather than guessing.
- **UNCERTAIN**: full flight number (`<span class="code">` carries only
  the suffix, e.g. `"79"`; the airline-code prefix lives on
  `/app/com/numbers/<id>`). Slice 6b's diff matches on
  origin+dest+depTime so the prefix isn't needed; a future surface that
  wants `"AA79"` should hydrate from the flight-detail page.

## Day-spanning flights (followup — shipped)

The 13536 capture had no multi-day flights; this slice's original
output tagged `spansIntoNext` / `spansFromPrev` flags but never
exercised them. The user later supplied a populated 21944 capture
with 6 day-cross pairs, which now sits at
`CLAUDE/...:21944:0?13 MULTIDAYROUTES.html`.

**Followup change:** added a `_collapseDayCrossPairs(legs)` post-pass
to `readVisualFlightPlan`. It walks the output legs, buckets by
`flightId`, and pairs each `spansIntoNext: true` leg with the
matching `spansFromPrev: true` leg on `(dayIdx + 1) % 7` (so Sun→Mon
wraps cleanly). The `started` half is kept as the canonical merged
leg with:

- `depTimeLocal` from the started half (e.g. `"19:40"`)
- `arrTimeLocal` from the ended half (e.g. `"02:51"`)
- `durationMin` = sum of both halves' widths
- `destination` from the ended half (its same-day `.inbound` IATA;
  the started half's same-day search returns `null` because it sits
  at the end of its day's blocks)
- `crossesMidnight: true`
- `dayIdx` from the started half (the day the flight DEPARTS)

The retired `spansIntoNext` / `spansFromPrev` flags are stripped
from every output leg — only `crossesMidnight` survives.

For the MULTIDAYROUTES capture: 20 raw flight bars → 6 paired into 6
collapsed legs + 8 same-day legs = **14 logical legs**. Verified
through a Node stub (24-assertion smoke run) covering empty/null
input, same-day-only legs, simple paired collapse, multiple pairs,
Sun→Mon wrap, unpaired halves (warn + keep as same-day), and the
full 14-leg count.

Pathological shapes (`started` with no matching `ended` or vice
versa) emit `console.warn("[AES afp-6a] unpaired day-cross …")` and
stay in the output as same-day legs — the safe failure mode.

## Verified

- Manual walk-through of the parser against the 13536 markup (e.g. flight
  `9018` JFK→LAX: `margin-left: 25.0%` → `06:00` ✓; `width: 21.458%` →
  `309 min` → arrival `11:09` ✓).
- The internal helpers are pure (no DOM / chrome.storage side effects)
  and could be lifted to a `vfp-parser-test.js` smoke harness; no test
  runner is configured for this project so smokes go inline only.
- Inline `console.assert` smoke tests deferred to slice 6b — the host
  module's existing convention is to keep the IIFE side-effect-free at
  module load. The 6a rewrite preserves that posture.

## Known limitations

- `flightCode` is a suffix, not the full AS flight number. Track 5's
  preview panel doesn't need it (the legs are referenced by `seq`); a
  future "show flight number on the diff modal" surface should hydrate
  from `/app/com/numbers/<id>`.
- After the followup, `spansIntoNext` / `spansFromPrev` are no longer
  surfaced — only `crossesMidnight` is. Existing 6b smoke tests don't
  reference the retired flags so no regression.
- The parser doesn't expose `pricePct` or `service` — they're not in the
  VFP markup (those fields live on `/app/com/numbers/<id>`). Slice 6b's
  diff doesn't need them either; the keep/delete/add decision is made on
  origin+dest+depTime alone.

## Open questions for the human

- **Multi-cross long-haul** (a flight that crosses two midnights) is
  unlikely in AS but the pairing logic would currently merge the FIRST
  started with the next-day ended and warn-then-skip the second
  started. Acceptable for Phase 1.
