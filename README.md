# AirlineSim Enhancement Suite Fork

This checkout is the live-maintained AES Chrome MV3 extension fork. It has no build step; load the repository root as an unpacked Chrome extension.

## Current Operating Posture

- Proven write paths default to live AirlineSim changes, not dry-run previews.
- Route Assistant pricing ships `permanentLiveMode=true`: manual apply, bulk apply, `flightsPrices?adjust=true` recommended bulk, foreground silent-auto, and dashboard silent-auto all default to live scopes.
- Strategy defaults to `apply-auto` with schedule, route creation, price, service, crew, alliance, and slot-bid domains enabled; unimplemented form-shape stubs still fail closed with `form-shape-not-yet-mapped`.
- Aircraft Flight Plan defaults to apply-ready: auto-scheduler enabled, `tier="apply-on-confirm"`, drag-submit dry-run off, drag/drop Apply goes through the live orchestrator, route-planner UI is shimmed live-only, fleet-wave Apply submits the fleet batch, and AFP dashboard flight-number Apply performs the real POST/verify path.
- Per-leg pricing suggestions, Fleet Command bulk apply, Fleet Optimizer rebalance, and Conductor drift proposals expose live Apply behavior by default instead of dry-run apply buttons.
- Unmapped marketing-budget and slot-bid writers do not return successful dry-run stubs; they log/return blocked form-mapping results until their AirlineSim POST bodies are implemented.
- Route Assistant Market Analysis is integrated into the screenshot/table categories: the `Cmp$` tooltip, `Mkt%`/Cmp enterprise popover, and `Flt` drawer show real logged-in AirlineSim per-airline flight rows with individual fares, flight numbers, departure/arrival times, aircraft/equipment, seat/cargo capacity, booked/load, availability, and status.
- Competitor Intel graph drilldowns use the same Market Analysis cache: each airport-carrier Schedule pane and carrier Network pane displays individual enterprise flight rows with fare/class detail, departure, aircraft, seat/cargo capacity, booked/load/availability, and status.
- Latest active free1 session: `audit/live-active-session-10121-20260505.json` is attached to CDP port `10121`, authenticated on enterprise `775` as Lamda, and confirms `dryRun=false`, `liveWrites=true`, all pricing live scopes on, Strategy `apply-auto`, and AFP apply-ready settings. The latest bounded smoke with a live tick found no eligible proposals, so it made no AS price POST.
- Latest read-only Market Analysis verification: `audit/live-ra-enterprise-flight-drilldown-10085-20260505.json` logged into free1 enterprise `775`, parsed real JFK-LAX AS Market Analysis rows, grouped 165 competitor flight/class rows into 8 airline groups, and resolved aircraft seat/cargo capacity for all rows without AS POSTs.
- Credentials are not part of the extension. Use a logged-in Chrome profile or transient harness credentials for live verification; do not commit real credentials.

See `HANDOVER.md` for the detailed current-state handover and verification notes.
