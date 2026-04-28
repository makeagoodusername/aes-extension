# FACET — Cubism Overhaul Working Spec

> The compact spec. The full plan with rationale lives at
> `~/.claude/plans/parsed-spinning-kahn.md`. Update *this* doc as
> slices ship; update the plan when the design itself changes.

## Mission

Add **simultaneity of perspective** to the AES shell. Every entity
(route, aircraft, hub, flight) currently shown from one angle gets a
faceted polygonal surface that shows 4–7 angles at once — demand,
profit, ORS, competitor, fleet, schedule, time — without navigating
between them. Extends the brutalist token system; opt-in via
`centralHub.cubistMode` (default OFF).

## Four innovations

1. **Simultaneity over navigation** — multiple analytical perspectives on one polyhedral artifact.
2. **Time-as-overlay** — past + present + forecast layered on the same surface.
3. **Fractal faceting** — facets decompose into sub-polyhedra; spatial drilling, not modal stacks.
4. **Composition-level layout** — asymmetric grid; the page itself reads as one Cubist still-life.

## Five primitives

Builders in `js/cubist-primitives.js`, styles in `css/cubist.css`.
All scoped under `body.aes-cubist`.

| Primitive | What | Use |
| --- | --- | --- |
| **Facet** | Polygonal region with `clip-path` | One analytical view of one entity |
| **Polyhedron** | Composition of 3–7 facets joined at angles | One entity, multiple perspectives |
| **GhostLayer** | Past / present / forecast layered with offsets | Time-as-overlay |
| **Stencil** | Display-serif + stripe-bg label | Synthetic-cubism collage typography |
| **Composition** | Asymmetric grid wrapper (totem/landscape/still-life) | Page-level layout |

## Visual language

- **Palette**: existing AESTokens (bone/oxide/slate/rust) + three Cubist accents — `vermilion` (alert), `viridian` (success), `gold` (opportunity).
- **Geometry**: 12 named polygon clip-paths, 12° default seam angle, 8° default pivot, 6px ghost offset.
- **Typography**: Inter Tight + JBM (unchanged) plus `.aes-stencil` collage utility.
- **Motion**: `pivot` (140ms rotateY on hover), `compose` (multi-stage clip morph). All gated by `prefers-reduced-motion`.

## Component catalog (CB1–CB6)

| Slice | Surface | Primitives used |
| --- | --- | --- |
| **CB1** Cubist Hero Polyhedron | Replaces `hero-strip.js` | Polyhedron + GhostLayer + Stencil + 7 Facets |
| **CB2** Studio Totem | Restyles flight-studio sidebar | Composition(totem) + 5 Facets + Stencil |
| **CB3** Polyhedral Route Card | Restyles RA tile body | Polyhedron(hex) per route + 6 Facets |
| **CB4** Voronoi Map | Net-new canopy surface (gated on Letter L7) | Composition(landscape) + N Facets |
| **CB5** Decomposition Mode | Click-to-shatter behavior | Animation over Polyhedron |
| **CB6** Polish | A11y, keyboard nav, wave-strip reskin | (cross-cutting) |

## Implementation slicing

### CB0 — Foundation (THIS SLICE)
- `js/cubist-tokens.js` — token map (`window.AESCubistTokens`)
- `js/cubist-primitives.js` — 5 builders (`window.AESCubistPrimitives`)
- `css/cubist.css` — 12 polygon clip-paths, ghost-layer, stencil, composition presets, reduced-motion gates
- `css/design-tokens.css` — adds 3 accent colors + 4 Cubist geometry tokens
- `js/design-tokens.js` — adds the 3 accent colors to `AESTokens.color`
- `modules/central-hub/settings-store.js` — adds `cubistMode: false` to defaults
- `modules/central-hub/shell.js` — toggles `body.aes-cubist` class on mount based on setting
- `modules/central-hub/tiles/settings-tile.js` — adds Cubist Mode toggle row + first-activation confirm
- `manifest.json` — wires the three new files into the appropriate `matches` blocks

CB0 ships **no Cubist visual surface**. Toggling `cubistMode` ON adds
the body class but no surface yet binds to it. CB1 onward consume the
primitives.

### CB1–CB6 — see plan file

Each gets a dedicated slice plan when its session arrives. Status
table below.

## Status

| Slice | Status |
| --- | --- |
| CB0 Foundation | shipped 2026-04-28 |
| CB1 Hero Polyhedron | shipped 2026-04-28 |
| CB2 Studio Totem | shipped 2026-04-28 |
| CB3 Polyhedral Route Card | shipped 2026-04-28 |
| CB4 Voronoi Map | shipped 2026-04-28 (per-hub stub; canopy aggregation when L7 lands) |
| CB5 Decomposition Mode | shipped 2026-04-28 |
| CB6 Polish | shipped 2026-04-28 |

## Constraints honored

NORTH-STAR §4 invariants 4.1, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12,
4.13, 4.18, 4.19. See plan §6 for the mapping.

## Verification (CB0)

1. `python3 -c "import json; json.load(open('manifest.json'))"` returns 0
2. devtools console: `typeof AESCubistTokens.poly` returns `"object"`
3. devtools console: `typeof AESCubistPrimitives.Facet` returns `"function"`
4. Settings tile → toggle Cubist Mode → reload → toggle remembers
5. With cubistMode ON, `<body>` has class `aes-cubist`; with OFF, no class
6. Existing UI unchanged when OFF (visual regression check by eye)
7. No console errors on `/app/enterprise/dashboard`, `/app/aircraft/*`, `/app/fleets/*`
8. `prefers-reduced-motion: reduce` → no `transform` declarations apply

## Open questions

| # | Question | Working default |
| --- | --- | --- |
| 1 | Per-entity Cubist override vs global toggle? | Global toggle in CB0 |
| 2 | Color-blind alternative palette? | Deferred to CB6 |
| 3 | Performance with 200+ polyhedra in RA tile? | Benchmark in CB3 |
| 4 | Mobile / narrow-viewport behavior? | Below 1200px reverts to orthogonal (cubist.css) |
| 5 | Voronoi map data source? | Defer to CB4 spec when L7 lands |
| 6 | Does CB2 sidebar restyle apply when cubistMode OFF? | No — single global mode |
| 7 | Pivot animation default? | Default ON; sub-setting `cubistMode.motion` in CB6 |
