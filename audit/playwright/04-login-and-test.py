#!/usr/bin/env python3
"""End-to-end Route Builder live test on the visible Chrome (port 9242).

Steps:
  1. Connect via CDP, find the /app/login tab.
  2. Fill email + password from audit/credentials.json, submit.
  3. Wait for landing.
  4. Navigate to /app/fleets to find an owned aircraft id.
  5. Open /app/fleets/aircraft/<id>/0 — observe AES Route Builder mount.
  6. Snapshot scaffold state, slot rendering, and console.
  7. Output a JSON report to stdout + screenshots to audit/playwright/out/.

Read-only with respect to AS — does not click final Submit.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, Page, TimeoutError

CDP_URL = "http://127.0.0.1:9242"
ROOT    = Path("/Users/jihwan/Downloads/AES.v0.6.9")
CREDS   = json.loads((ROOT / "audit" / "credentials.json").read_text())
OUT     = ROOT / "audit" / "playwright" / "out"
OUT.mkdir(parents=True, exist_ok=True)
HOST    = "https://" + CREDS["server"]


def find_first_page(browser):
    for ctx in browser.contexts:
        for pg in ctx.pages:
            if pg.url.startswith("http"):
                return pg
    return None


def maybe_login(page: Page, log: list[dict]) -> bool:
    if "/app/login" not in page.url:
        log.append({"phase": "login", "skipped": True, "url": page.url})
        return True
    log.append({"phase": "login", "url_before": page.url})
    try:
        page.wait_for_selector("input[type=email], input[name='email'], input[name*='username' i]", timeout=8000)
    except TimeoutError:
        log.append({"phase": "login", "error": "no email field"})
        return False
    # Find email + password inputs heuristically.
    email_input = page.locator("input[type=email], input[name='email'], input[name*='username' i]").first
    pw_input    = page.locator("input[type=password]").first
    email_input.fill(CREDS["email"])
    pw_input.fill(CREDS["password"])
    # Submit
    btn = page.locator("button[type=submit], input[type=submit]").first
    btn.click()
    try:
        page.wait_for_url(lambda u: "/app/login" not in u, timeout=20000)
    except TimeoutError:
        log.append({"phase": "login", "error": "still on login after submit", "url": page.url})
        return False
    log.append({"phase": "login", "url_after": page.url})
    return True


def find_owned_aircraft_id(page: Page, log: list[dict]) -> str | None:
    page.goto(HOST + "/app/fleets", wait_until="domcontentloaded", timeout=30000)
    time.sleep(2)
    aid = page.evaluate(r"""
      (() => {
        const links = [...document.querySelectorAll('a[href*="/app/fleets/aircraft/"]')];
        for (const a of links) {
          const m = (a.getAttribute('href') || '').match(/\/app\/fleets\/aircraft\/(\d+)\/0/);
          if (m) return m[1];
        }
        for (const a of links) {
          const m = (a.getAttribute('href') || '').match(/\/app\/fleets\/aircraft\/(\d+)/);
          if (m) return m[1];
        }
        return null;
      })()
    """)
    log.append({"phase": "find_aircraft", "aircraftId": aid})
    return aid


PROBE_AFP = r"""
(() => {
  const slot = (n) => document.querySelector('[data-aes-afp-slot="' + n + '"]');
  const slotsAll = [...document.querySelectorAll('[data-aes-afp-slot]')].map(s=>s.dataset.aesAfpSlot);
  const summary = (s) => s ? (s.innerText || '').slice(0,300).replace(/\s+/g,' ') : null;
  return {
    url: location.href,
    title: document.title,
    afpHost: !!document.querySelector('[data-aes-afp-host]'),
    wideHost: !!document.querySelector('[data-aes-afp-wide-host]'),
    h3: [...document.querySelectorAll('h3')].map(h=>h.textContent.trim()),
    slotsPresent: slotsAll,
    studio: summary(slot('studio')),
    candidates: summary(slot('candidates')),
    driver: summary(slot('driver')),
    tools: summary(slot('tools')),
    autoPreview: summary(slot('auto-preview')),
    wave: summary(slot('wave'))
  };
})()
"""


def main() -> int:
    report = {"steps": []}
    console: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        page = find_first_page(browser)
        if page is None:
            print(json.dumps({"error": "no page in visible Chrome"}))
            return 2

        page.on("console", lambda m: console.append({"t": time.time(), "type": m.type, "text": m.text[:300]}))
        page.on("pageerror", lambda e: console.append({"t": time.time(), "type": "pageerror", "text": str(e)[:300]}))

        report["steps"].append({"phase": "start", "url": page.url})
        ok = maybe_login(page, report["steps"])
        if not ok:
            page.screenshot(path=str(OUT / "login-failed.png"))
            print(json.dumps(report, indent=2, default=str))
            return 3

        aid = find_owned_aircraft_id(page, report["steps"])
        if not aid:
            page.screenshot(path=str(OUT / "no-aircraft.png"))
            print(json.dumps(report, indent=2, default=str))
            return 4

        afp_url = HOST + "/app/fleets/aircraft/" + aid + "/0"
        report["steps"].append({"phase": "navigate_afp", "url": afp_url})
        page.goto(afp_url, wait_until="load", timeout=30000)

        samples = []
        for delay in (0, 2, 4, 8):
            time.sleep(max(0.05, delay - (samples[-1]["deltaSec"] if samples else 0)))
            samples.append({"deltaSec": delay, "snap": page.evaluate(PROBE_AFP)})
        page.screenshot(path=str(OUT / "afp-fresh-load.png"), full_page=True)
        report["samples"] = samples

        # If scaffold mounted, also try clicking the Settings tab in AS to
        # trigger a Wicket re-render (this is what the user reports as the
        # "scaffold disappears" trigger).
        scaffold_mounted = bool(samples[-1]["snap"].get("wideHost"))
        report["scaffold_mounted_initial"] = scaffold_mounted

        if scaffold_mounted:
            # Try clicking a tab inside AS that triggers Wicket re-render.
            try:
                page.locator("a:has-text('Settings'), a:has-text('History')").first.click(timeout=3000)
                time.sleep(2.5)
                rerender = page.evaluate(PROBE_AFP)
                # Click back to Flight Plan
                try:
                    page.locator("a:has-text('Flight Plan')").first.click(timeout=3000)
                    time.sleep(2.5)
                except Exception:
                    pass
                after_back = page.evaluate(PROBE_AFP)
                report["after_tab_switch"] = {"rerender": rerender, "after_back": after_back}
                page.screenshot(path=str(OUT / "afp-after-tab-switch.png"), full_page=True)
            except Exception as e:
                report["after_tab_switch_error"] = str(e)[:200]

        report["console_count"] = len(console)
        report["console_recent"] = console[-30:]
        print(json.dumps(report, indent=2, default=str))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
