#!/usr/bin/env python3
"""Playwright-driven end-to-end test of the AES Route Builder.

Connects to the already-running Chrome instance on the given CDP port
(default 9241), drives the AFP page through the Route Builder flow, and
verifies whether a new route lands in the actual AS schedule.

Captures screenshots and a structured report at audit/pw-rb-report.json
plus PNGs at audit/pw-rb-step-NN.png so the human reviewer can inspect.

Usage:
  python3 audit/scripts/pw_route_builder.py [--port 9241] [--aircraft 22092]
                                            [--dest JFK]
"""
from __future__ import annotations
import argparse, asyncio, json, os, subprocess, sys, time
from pathlib import Path

from playwright.async_api import async_playwright, Page, BrowserContext

REPO = Path(__file__).resolve().parents[2]
OUT  = REPO / "audit"
REPORT = OUT / "pw-rb-report.json"
SHOTS  = OUT / "pw-rb-shots"
SHOTS.mkdir(parents=True, exist_ok=True)

CDP_EVAL = REPO / "audit" / "scripts" / "cdp-eval.py"


def cdp_iso(port: int, url_substr: str, expr: str) -> dict:
    """Run an expression in the AES isolated world via the proven cdp-eval.py.
    Returns the parsed JSON {tab, ctx, world, value} or {error}.
    Playwright cannot reliably reach content-script isolated worlds because
    the existing CDP attach intercepts Runtime.executionContextCreated
    events, so we shell out to the audit helper that walks contexts directly.
    """
    res = subprocess.run(
        ["python3", str(CDP_EVAL), str(port), url_substr, expr, "--world=aes"],
        capture_output=True, text=True, timeout=60
    )
    if res.returncode != 0:
        return {"_error": res.stderr.strip() or res.stdout.strip(), "_rc": res.returncode}
    try:
        return json.loads(res.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {"_error": f"parse: {e}", "_raw": res.stdout[:500]}

# Public CDP probe — the AES extension lives in an "isolated world" execution
# context, so to reach window.AesAfp etc. we have to ask Chrome which world
# is the extension's. Playwright's page.evaluate runs in the page's main
# world by default. The trick: emit things from page.eval into chrome.runtime
# message channel, OR find the isolated world contextId via CDP and use it.
#
# Easier path: in MV3 with "world": "ISOLATED" (default), the content scripts
# expose globals through a content_script bridge. The repo uses
# `window.AesAfp` which is set on the isolated world only — but most pages
# also forward selected globals through a bridge content script. Let's first
# probe what's reachable in the main world and pivot from there.


async def screenshot(page: Page, name: str) -> str:
    p = SHOTS / f"{name}.png"
    try:
        await page.screenshot(path=str(p), full_page=False)
        return str(p.relative_to(REPO))
    except Exception as e:
        return f"<screenshot failed: {e}>"


async def cdp_eval_iso(page: Page, port: int, expr: str):
    """Evaluate `expr` in the AES isolated world by shelling to cdp-eval.py.
    Why shell out: Playwright owns Runtime events on the page target, so the
    in-process CDP handshake misses Runtime.executionContextCreated. The
    audit helper opens its own websocket and walks contexts directly."""
    url_substr = page.url.split("?")[0].split("/")[-2]  # e.g. "22092"
    return await asyncio.get_event_loop().run_in_executor(
        None, cdp_iso, port, url_substr, expr
    )


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9241)
    ap.add_argument("--aircraft", default="22092")
    ap.add_argument("--dest", default="JFK", help="3-letter IATA destination to test (default JFK)")
    ap.add_argument("--server", default="free1.airlinesim.aero")
    ap.add_argument("--commit", action="store_true",
                    help="Actually commit the route (default: stop at dry-run)")
    args = ap.parse_args()

    report = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "args": vars(args),
        "steps": [],
        "ok": False,
    }

    def step(name, **kw):
        kw["name"] = name
        kw["t"] = time.strftime("%H:%M:%S")
        report["steps"].append(kw)
        # Stream key fields so user sees progress
        compact = {k: v for k, v in kw.items() if k not in {"html"}}
        print(json.dumps(compact, indent=None)[:400], flush=True)

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
        # Use the existing default context — Playwright surfaces it as contexts[0]
        ctx: BrowserContext = browser.contexts[0]

        # Find or open AFP page
        afp_url = f"https://{args.server}/app/fleets/aircraft/{args.aircraft}/0"
        target = None
        for p in ctx.pages:
            if f"/aircraft/{args.aircraft}/" in p.url:
                target = p; break
        if not target:
            target = await ctx.new_page()
            await target.goto(afp_url, wait_until="domcontentloaded")
        else:
            if afp_url not in target.url:
                await target.goto(afp_url, wait_until="domcontentloaded")
        page = target
        # Bring to front so selectors that depend on visibility behave
        try: await page.bring_to_front()
        except Exception: pass

        # Capture console + page errors
        console_log = []
        page.on("console", lambda m: console_log.append({"type": m.type, "text": m.text[:300]}))
        page.on("pageerror", lambda e: console_log.append({"type": "pageerror", "text": str(e)[:300]}))

        # Wait for AFP scaffold
        await page.wait_for_timeout(1500)
        step("loaded-afp", url=page.url, shot=await screenshot(page, "01-loaded"))

        # Probe AES context
        ctx_probe = await cdp_eval_iso(page, args.port, """
        (() => {
          const af = window.AesAfp;
          const slot = (n) => af && af.slot ? !!af.slot(n) : false;
          return {
            url: location.href,
            ctx: af && af.ctx ? {
              registration: af.ctx.registration,
              equipment: af.ctx.equipment,
              currentLocationIata: af.ctx.currentLocationIata,
              aircraftId: af.ctx.aircraftId,
              server: af.ctx.server,
            } : null,
            slots: {
              tools: slot('tools'), candidates: slot('candidates'),
              studio: slot('studio'), driver: slot('driver'),
              autoPreview: slot('auto-preview'), wave: slot('wave'),
            },
            modules: {
              candidates: typeof window.AesAfpRouteCandidates,
              formDriver: typeof window.AesAfpFormDriver,
              flightStudio: typeof window.AesAfpFlightStudio,
              applyBatch: typeof window.AesAfpAutoApplyBatch,
              previewPanel: typeof window.AesAfpAutoSchedulerPreview,
              submitBridge: typeof window.AesAfpSubmitBridge,
              flightsFromStore: typeof window.FlightsFromStore,
              scheduleStore: typeof window.AesAfpScheduleStore,
            }
          };
        })()
        """)
        step("ctx-probe", **ctx_probe)

        v = ctx_probe.get("value") or {}
        hub = ((v.get("ctx") or {}).get("currentLocationIata") or "").upper()
        if not hub:
            step("FAIL", reason="no hub on aircraft ctx", probe=v)
            REPORT.write_text(json.dumps(report, indent=2))
            return

        # ── Step A: ensure FlightsFrom data exists for hub ─────────────────
        ff = await cdp_eval_iso(page, args.port, f"""
        (async () => {{
          const data = await window.FlightsFromStore.loadAirport('{hub}');
          return {{
            iata: '{hub}',
            count: data && data.routes ? data.routes.length : 0,
            stale: data ? !!data.stale : null,
            scrapedAt: data && data.scrapedAt || null,
          }};
        }})()
        """)
        step("flightsfrom-state", **ff)

        if (ff.get("value") or {}).get("count", 0) == 0:
            # Trigger the in-page Scan button
            step("scan-needed", note="no FF data, clicking scan button")
            clicked = await page.evaluate("""
              () => {
                const b = document.querySelector('[data-aes-ff-scan-btn]');
                if (b) { b.click(); return true; }
                return false;
              }
            """)
            step("scan-clicked", clicked=clicked)
            # Wait up to 60s for data
            for i in range(30):
                await page.wait_for_timeout(2000)
                ff2 = await cdp_eval_iso(page, args.port, f"""
                (async () => {{
                  const d = await window.FlightsFromStore.loadAirport('{hub}');
                  return {{ count: d && d.routes ? d.routes.length : 0 }};
                }})()
                """)
                if (ff2.get("value") or {}).get("count", 0) > 0:
                    step("scan-complete", iter=i, **ff2)
                    break
            else:
                step("scan-timeout", note="FlightsFrom scan did not return data in 60s")

        # ── Step B: compute candidates and look for desired dest ───────────
        await page.wait_for_timeout(2000)  # let candidate pipeline run
        cands = await cdp_eval_iso(page, args.port, f"""
        (async () => {{
          const c = window.AesAfpRouteCandidates;
          const last = c && c.last || [];
          const want = '{args.dest}'.toUpperCase();
          const match = last.find(x => x.destIata === want) || null;
          return {{
            total: last.length,
            wantedDest: want,
            haveWanted: !!match,
            sample: last.slice(0, 5).map(x => ({{ destIata: x.destIata, fits: x.fits, scoreBlend: x.scoreBlend, distanceKm: x.distanceKm }})),
          }};
        }})()
        """)
        step("candidates-compute", **cands)

        # ── Step C: trigger candidate selection (click row) ────────────────
        # If the wanted dest isn't in the visible top-N, expand topN first by
        # cycling the chip ("All"). The candidates list uses the data-attribute
        # `data-aes-afp-cand-iata` (route-candidates.js renders one per row).
        chosen = await page.evaluate(f"""
          () => {{
            const dest = '{args.dest}'.toUpperCase();
            const slot = document.querySelector('[data-aes-afp-slot=candidates]');
            if (!slot) return {{ ok: false, reason: 'no candidates slot' }};
            // Try to bump topN to 'all' if the row isn't visible yet.
            for (let i = 0; i < 5; i++) {{
              const row0 = slot.querySelector(`tr[data-aes-afp-cand-iata="${{dest}}"]`);
              if (row0) break;
              // Click the topN chip to cycle (route-candidates.js line ~TOP_N_CYCLE)
              const chips = Array.from(slot.querySelectorAll('button, [role=button]'))
                .filter(b => /^(top |all|\\d+$)/i.test((b.textContent || '').trim()));
              if (!chips.length) break;
              chips[chips.length - 1].click();
            }}
            const row = slot.querySelector(`tr[data-aes-afp-cand-iata="${{dest}}"]`);
            if (!row) {{
              const rows = Array.from(slot.querySelectorAll('tr[data-aes-afp-cand-iata]'));
              return {{ ok: false, reason: 'row not found',
                       availableIatas: rows.slice(0, 30).map(r => r.getAttribute('data-aes-afp-cand-iata')),
                       totalRows: rows.length }};
            }}
            row.scrollIntoView({{block: 'center'}});
            row.click();
            return {{ ok: true, text: (row.textContent || '').trim().slice(0, 200) }};
          }}
        """)
        step("candidate-clicked", **(chosen or {}))
        await page.wait_for_timeout(800)
        await screenshot(page, "02-candidate-clicked")

        # ── Step C2: fill the AS form via form-driver (the user-facing path)
        fill_resp = await cdp_eval_iso(page, args.port, f"""
        (async () => {{
          const drv = window.AesAfpFormDriver;
          if (!drv || typeof drv.fill !== 'function') return {{ ok: false, reason: 'no fill' }};
          // fill({{destination}}) lets form-driver pull origin/time/price from defaults +
          // the candidate it remembered from candidate:selected. This is the same
          // path the in-page "Fill latest pick" button takes.
          const r = await drv.fill({{ destination: '{args.dest}' }});
          return {{ ok: r && r.ok, set: r && r.set, missed: r && r.missed }};
        }})()
        """)
        step("fill-form", **fill_resp)
        await page.wait_for_timeout(500)

        # ── Step D: dry-run via form-driver ────────────────────────────────
        dry = await cdp_eval_iso(page, args.port, """
        (() => {
          const drv = window.AesAfpFormDriver;
          if (!drv || typeof drv.dryRun !== 'function') return { ok: false, reason: 'driver missing' };
          const out = drv.dryRun();
          return { ok: true, missed: out.missed, body: out.body, url: out.url };
        })()
        """)
        step("dry-run", **dry)

        # ── Step E: check the AS native form has the values pre-filled ─────
        formstate = await page.evaluate("""
        () => {
          const sels = document.querySelectorAll('form select');
          const out = {};
          sels.forEach(s => {
            const k = s.name || s.id || '?';
            const opt = s.options[s.selectedIndex];
            out[k] = { value: s.value, label: opt ? (opt.text || '').trim() : null };
          });
          return out;
        }
        """)
        step("as-form-state", state=formstate)
        await screenshot(page, "03-as-form-state")

        # ── Step F: invoke gated apply via background — submitLegInBackground
        # This is the SACRED path.
        if args.commit:
            step("commit-mode-on", note="will trigger gated submit-bridge")
            # Pre-assign next-available flight number so AS doesn't reject the
            # POST when the number input is left blank. Use form-driver's own
            # roster lookup to avoid colliding with existing assignments.
            preassign = await cdp_eval_iso(page, args.port, """
            (async () => {
              const drv = window.AesAfpFormDriver;
              if (!drv || typeof drv.findNextAvailableFlightNumber !== 'function') {
                return { ok: false, error: 'driver lacks findNextAvailableFlightNumber' };
              }
              const num = await drv.findNextAvailableFlightNumber({});
              return { ok: !!num, flightNumberText: num };
            })()
            """)
            step("preassign-flight-number", **(preassign or {}))
            chosen_fn = (preassign or {}).get("value", {}).get("flightNumberText") if isinstance(preassign, dict) else None
            apply_resp = await cdp_eval_iso(page, args.port, f"""
            (async () => {{
              if (!window.AesAfpSubmitBridge) return {{ ok: false, error: 'no submit bridge' }};
              const af = window.AesAfp && window.AesAfp.ctx;
              if (!af) return {{ ok: false, error: 'no AfpCtx' }};
              // Build the leg payload — `depTime` (HH:MM) is form-driver's
              // canonical field name; an empty `flightNumberText` makes AS
              // auto-assign on submit, but we pre-pick one above so the
              // assignExistingFlight step can match by number not by route+time.
              return await window.AesAfpSubmitBridge.submitLegInBackground({{
                server: af.server,
                aircraftId: af.aircraftId,
                hub: af.currentLocationIata,
                leg: {{
                  origin: af.currentLocationIata,
                  destination: '{args.dest}',
                  depTime: '12:00',
                  pricePct: 100,
                  service: '',
                  flightNumberText: {repr(chosen_fn or '')}
                }},
                timeoutMs: 90000
              }});
            }})()
            """)
            step("submit-bridge-resp", **(apply_resp or {}))
            await page.wait_for_timeout(4000)
            await screenshot(page, "04-after-submit")
        else:
            step("commit-mode-off", note="dry-run only — pass --commit to actually create")

        # ── Step G: verify AS schedule contains the leg ─────────────────────
        sched = await cdp_eval_iso(page, args.port, f"""
        (async () => {{
          const af = window.AesAfp && window.AesAfp.ctx;
          if (!af) return {{ ok: false }};
          const store = window.AesAfpScheduleStore;
          if (!store) return {{ ok: false, error: 'no schedule store' }};
          const s = await store.load(af.server, af.aircraftId);
          const want = '{args.dest}';
          const legs = (s && s.legs) || [];
          return {{
            hub: s ? s.hubIata : null,
            legCount: legs.length,
            destIatas: legs.map(l => l && l.destination),
            haveWanted: legs.some(l => l && (l.destination === want || l.dest === want))
          }};
        }})()
        """)
        step("schedule-check", **(sched or {}))

        report["console_log_tail"] = console_log[-30:]
        report["ok"] = True

    REPORT.write_text(json.dumps(report, indent=2))
    print(f"\nReport: {REPORT.relative_to(REPO)}")
    print(f"Shots:  {SHOTS.relative_to(REPO)}/")


if __name__ == "__main__":
    asyncio.run(main())
