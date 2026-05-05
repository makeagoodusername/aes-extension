#!/usr/bin/env python3
"""Verify Fleet Hub -> dashboard linkage in a live Chrome CDP session.

Usage:
  python3 scripts/verify-fleet-dashboard-linkage-cdp.py [port]

Prereqs:
  - Chrome is running with AES loaded and a logged-in AirlineSim session.
  - audit/scripts/cdp-driver.py can reach that Chrome port.

Checks:
  1. /app/fleets renders Fleet Command Center data.
  2. Opening the first non-empty hub drilldown shows non-zero cap/used hours.
  3. /app/enterprise/dashboard reads the same fleet data in Fleet Hub and
     Schedule Canvas tiles.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "audit" / "scripts" / "cdp-driver.py"


def run_driver(*args: str, timeout: int = 45) -> dict:
    proc = subprocess.run(
        [sys.executable, str(DRIVER), *args],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        raise RuntimeError("cdp-driver failed: " + out + (" " + err if err else ""))
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError("cdp-driver returned non-JSON: " + out) from exc


def nav_page(port: str, needle: str, url: str) -> None:
    run_driver("nav", port, needle, url)
    time.sleep(3)


def eval_iso(port: str, needle: str, expr: str) -> dict:
    return run_driver("eval-iso", port, needle, expr, timeout=60).get("value")


FLEETS_EXPR = r"""
(async () => {
  await new Promise(r => setTimeout(r, 3000));
  const cards = [...document.querySelectorAll("[data-hub-card]")];
  const card = cards.find(e => !/no aircraft parked/i.test(e.innerText || "")) || cards[0];
  if (!card) return {ok:false, step:"fleets", error:"no hub cards"};
  const old = document.querySelector(".aes-fleet-hub-drilldown-overlay");
  if (old) old.remove();
  card.click();
  await new Promise(r => setTimeout(r, 4000));
  const overlay = document.querySelector(".aes-fleet-hub-drilldown-overlay");
  const text = overlay ? overlay.innerText : "";
  const cap = Number((text.match(/CAP\n([0-9]+)h/) || [])[1] || 0);
  const used = Number((text.match(/USED\n([0-9]+)h/) || [])[1] || 0);
  const cells = document.querySelectorAll("td.aes-fleet-hub-cell").length;
  const commandCenter = /BULK OPERATIONS|AUTO-GENERATE PLANS/.test(document.body.innerText);
  return {
    ok: commandCenter
      && cap > 0
      && used > 0
      && (cells > 0 || cards.length > 0),
    step: "fleets",
    url: location.href,
    hub: card.dataset.hubCard || "",
    cells,
    inlineCellsOptional: cells === 0,
    commandCenter,
    cap,
    used,
    excerpt: text.slice(0, 500)
  };
})()
"""


DASHBOARD_EXPR = r"""
(async () => {
  await new Promise(r => setTimeout(r, 3000));
  const all = [...document.querySelectorAll(".aes-central-hub-tile")];
  const pick = id => {
    const el = all.find(x => x.dataset.tileId === id);
    if (!el) return null;
    return {
      summary: (el.querySelector(".aes-central-hub-tile__summary") || {}).textContent || "",
      badge: (el.querySelector(".aes-central-hub-tile__badge") || {}).textContent || "",
      body: (el.querySelector(".aes-central-hub-tile__body") || {}).innerText || ""
    };
  };
  const tileObj = window.__aesCentralHub
    && window.__aesCentralHub.tilesById
    && window.__aesCentralHub.tilesById.get("fleet-schedule-canvas");
  if (tileObj && !tileObj.expanded) tileObj.toggle();
  await new Promise(r => setTimeout(r, 1500));
  const fleetHub = pick("fleet-hub");
  const scheduleCanvas = pick("fleet-schedule-canvas");
  return {
    ok: !!(fleetHub
      && fleetHub.summary
      && fleetHub.summary.indexOf("No fleet stored") === -1
      && scheduleCanvas
      && scheduleCanvas.summary
      && scheduleCanvas.summary.indexOf("Visit /app/fleets") === -1),
    step: "dashboard",
    url: location.href,
    ctx: window.__aesCentralHub
      ? {server: window.__aesCentralHub.server, airline: window.__aesCentralHub.airline}
      : null,
    identity: (typeof AES !== "undefined" && AES.getAirlineIdentity) ? AES.getAirlineIdentity() : "",
    fleetHub,
    scheduleCanvas: pick("fleet-schedule-canvas")
  };
})()
"""


def main() -> int:
    port = sys.argv[1] if len(sys.argv) > 1 else "9228"
    server = os.environ.get("AES_TEST_SERVER", "free1").strip() or "free1"
    base = "https://" + server + ".airlinesim.aero"

    nav_page(port, "enterprise/dashboard", base + "/app/fleets")
    fleets = eval_iso(port, "Default fleet", FLEETS_EXPR)
    if not fleets or not fleets.get("ok"):
        nav_page(port, "Default fleet", base + "/app/fleets")
        fleets = eval_iso(port, "Default fleet", FLEETS_EXPR)

    nav_page(port, "Default fleet", base + "/app/enterprise/dashboard")
    dashboard = eval_iso(port, "enterprise/dashboard", DASHBOARD_EXPR)
    if not dashboard or not dashboard.get("ok"):
        nav_page(port, "enterprise/dashboard", base + "/app/enterprise/dashboard")
        dashboard = eval_iso(port, "enterprise/dashboard", DASHBOARD_EXPR)

    result = {"ok": bool(fleets and fleets.get("ok") and dashboard and dashboard.get("ok")),
              "fleets": fleets,
              "dashboard": dashboard}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
