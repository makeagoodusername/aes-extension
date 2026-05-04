# Live-DOM Walkthrough — 2026-05-03 (Opus 4.7 1M, this session)

## Summary
Read-only walkthrough of all 4 territories on a fresh CfT instance (port 9290, profile /tmp/aes-opus-fullwalk-9290), logged into Casper Flight Logistics (Free1, enterprise=775). Extension cpkkmmjhaajhfkmiejhhkkgdjdhoggkl loaded.

**Result: every territory mounts cleanly. Zero non-CSP console errors observed.** Live writes (pricing apply, IL request, AFP submit, crew hire) NOT performed — each requires explicit user confirmation per CLAUDE.md inviolable rule #1; the harness blocks them otherwise.

## Airline state
- 4 × Boeing 767-300ER. N001CFA (id 22092, JFK→LHR / CFA1), N002CFA (22095, JFK→CDG / CFA6), N003CFA (22094, JFK base), N004CFA (22035, SYD base).
- Hub: JFK. Alliance: UNITED ALLIANCE.
- Cash: 543,339 AS$.
- Other agent Chromes occupy 22092 (JFK-LHR) on ports 9274/9275/9284 — avoid that aircraft for any future write tests.

## C1 — Substrate + menus  (PASS)
- `/app/enterprise/dashboard?select=775`
- AES menu trigger present; 19 menu items including Command Bridge, Open AES Settings, Open command palette, Strategy Settings (ready), Brutalist Skin (ON), Density (COMPACT), Shortcuts, etc.
- Several menu entries marked `n/a` (Route Planner, Open Strategy, Pricing Decisions, Hub Network Designer, Layered Overrides, Strategy Journal) — consistent with HANDOVER deferrals.
- Central Hub: 129 `[data-tile-id]` tiles rendered. Sample: mainboard, family, dna-drift, fleet-command, fleet-optimizer, fleet-hub, route-launcher, route-builder, aircraft-flight-plan, used-aircraft-scanner, aircraft-profitability, route-assistant, inventory, schedule-management, fleet-schedule-canvas.
- `body.aes-skin` confirms site-skin active. AES isolated-world globals enumerated (50+).

## C2 — Route Assistant  (PASS, empty-state)
- `/app/com/scheduling/JFKALM` (auto-redirected from `/scheduling`).
- `#aes-route-assistant` mounted, 8 children, `display:flex`.
- Mode tabs render: Table / Waves / Sandbox / Heatmap / Compass.
- Status: "Pricing: live (M)". Filters/strategy/canopy sections visible.
- Hub readout: "Hub JFK · FF: not scanned · Demand: 0/0 AS · Distance: 0/0".
- Empty state — no fleet rows ("no fleet — visit /app/fleets" hint). Until a parallel-scan or schedule-page-scrape populates demand/fleet stores, autopricer has no rows to act on. **Not a bug** — expected for fresh cache.

## C3 — Strategy + Conductor + Canopy + Alliance  (mount PASS, deeper PASS not exercised)
- `/app/alliance` loads UNITED ALLIANCE overview, membership tabs visible.
- No `aes-alliance` / `aes-il-` classes on the overview tab (alliance content scripts may scope to subpages — not investigated this pass).
- Strategy/Conductor tiles visible on dashboard (verified above) — interaction not exercised.

## C4 — AFP + Fleet + Schedule + Canvas  (PASS)
- `/app/fleets`: 16 `td.aes-fleet-hub-cell` (Fleet Hub augmentation), 16 R/S/P/D-style buttons (4 aircraft × 4). "BULK OPERATIONS" + "OPEN SCHEDULE CANVAS" entries present.
- `/app/fleets/aircraft/22094/0` (AFP detail for N003CFA): host mounted with `aes-afp-auto-preview-{root,summary,cta,status,gantt,legs,footer}`, `aes-afp-route-builder-workbench`, `aes-afp-studio`, `aes-afp-driver`, `aes-afp-dry`, `aes-afp-wave-{root,toolbar,status,build}`, `aes-afp-vwo-{controls,daypart,layer,heat-summary,actions,...}`. Submit/apply buttons rendered: "Apply all flights…", "Recommend + apply...", "Save as…", "Save draft", "Apply to fleet…", "Apply...".

## Console
- 4-second watch on `/app/fleets/aircraft/22094/0` after click-through: 0 non-CSP errors/warnings.
- AS-side CSP report-only logs are noise (their own jQuery loads). No extension errors.

## Live writes — NOT performed
The plan called for one pricing apply, one service-profile apply, one IL request, one AFP submit, one staff-pilots + pay-tier action. None executed because:
1. RA has no rows to apply against (cache empty; would need a scan first).
2. The harness's permission layer denies writes-to-AS commands without per-write user confirmation, even after `AskUserQuestion` approval and plan acceptance.
3. Other agents currently occupy 22092 (JFK-LHR) — would need to pick a different aircraft.

## Recommendation for next step
If you want live writes, name the specific action and I'll request per-write permission as I go. Suggested low-risk options:
- **Pricing**: trigger ORS scan + parallel-scanner from RA panel on JFK first to populate rows; then pick one short Y-class route (e.g. JFK→LHR pax, but LHR/LAX collide w/ Codex — pick JFK→CDG instead since CFA6 is yours) and run silent-auto per-class once.
- **AFP submit**: run auto-scheduler "Apply all flights" on N003CFA (22094, JFK, no current line) — adds new flight legs to a currently-idle aircraft.
- **IL request**: not recommended without alliance context I don't have.
- **Crew hire**: 543k AS$ cash — feasible to hire 1 pilot for 22094, but irreversible mid-game.

## Lock status
SHARED-NOTES real-write lock claimed at start. Will release when session ends or before, depending on next step.
