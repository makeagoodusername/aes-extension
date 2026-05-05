# Phase 3 — dashboard-hub feature walkthrough

Goal: every feature reachable + manipulable from the BRIDGE/AES dashboard
hub. Click each tile, exercise every CTA, file & fix bugs as found.

## Coordination

- Claim a domain by adding a `## OWNS` line under it with your port.
- Bug findings go into `audit/findings.md` using IDs `F-<port>-NNN` to match
  Phase 1/2.
- Atomic commits per fix, with `Verified by:` line citing live MCP repro
  when possible (or "code-static" when not).
- 33 tiles in `modules/central-hub/tiles/` — split by domain below.

## Proposed domain split

### port-9223 — Dashboard shell & diagnostics
- general-tile, settings-tile, tools-tile
- diagnostics-tile, data-flow-inspector-tile
- family-tile, dna-drift-tile
- the dashboard hub itself (modules/central-hub/{shell,hero-strip,tile,manifest}.js)

### port-9224 — Fleet & aircraft
- fleet-command-tile, fleet-hub-tile, fleet-optimizer-tile
- aircraft-flight-plan-tile, aircraft-profitability-tile
- crew-management-tile

### port-9225 — Schedule & routing   ## OWNS port-9230
- schedule-management-tile, route-launcher-tile, route-management-tile
- route-assistant-tile, station-automation-tile, world-view-tile

### port-9226 — Competitor & alliance   ## OWNS port-9231
- competitor-intel-hub-tile, competitor-outline-tile
- competitor-monitoring-tile, alliance-tile

### port-9227 — Finance & strategy   ## OWNS port-9227   ## DONE
- accounting-tile          ✅ F-9227-011 fixed (e3f8d99 — eager compute timing vs AS navbar paint)
- strategy-tile            ✅ F-9227-012 fixed (a912f3b — store-readiness URL /app/accounting/income → /app/finance/accounting/0)
- strategy-briefing-tile   ✅ MARK AS READ + OPEN FULL BRIEFING modal verified live
- strategy-backtest-tile   ✅ F-9227-013 fixed (bc41a05 — window.AES is undefined in MV3 content-script context; switched to bare AES ref)
- weekly-review-tile       ✅ empty-state copy + footer counts correct
- conductor-tile           ✅ filter buttons (Maint/Schedule/Scrape/Compet/Cash/Drive) narrow signal list correctly
- service-profile-tile     ✅ row-click opens in-place editor (Y/C/F sliders), ← Back returns to list

### port-9228 — Market & inventory
- used-aircraft-scanner-tile, inventory-tile, flightsfrom-tile

## Walkthrough protocol (per tile)

1. From the dashboard hub, locate the tile (search/scroll).
2. Read the tile's body — note any "no data / visit X to populate" copy
   that's incorrect or unreachable from the hub itself.
3. Exercise every button, link, expand-toggle, and form input the tile
   exposes. Each control should either:
   (a) act in-place with visible feedback, or
   (b) navigate to the target AS page with a clear return path.
4. Repeat once after a real underlying-store update so you see the
   live-refresh path, not just the cold-paint path.
5. Bug or gap → file `F-<port>-NNN` in findings.md with repro + expected.
6. Fix → standard claim-fix-commit-mark-FIXED loop from Phase 2.

## Stop conditions

- All claimed tiles fully exercised AND no OPEN findings in your domain.
- Browser session loses extension context — note in claims.log + escalate.
