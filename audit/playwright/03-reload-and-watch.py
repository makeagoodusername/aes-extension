#!/usr/bin/env python3
"""Reload AFP page fresh and watch the AES scaffold mount.

Connects to the existing Chrome via CDP, attaches console + pageerror
listeners, then navigates to a fresh /0 URL for aircraft 22092 (LHR).
Captures every console message during the first 10 seconds and reports
whether the AES Route Builder scaffold mounted.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP_URL = "http://127.0.0.1:9241"
ROOT    = Path("/Users/jihwan/Downloads/AES.v0.6.9")
OUT     = ROOT / "audit" / "playwright" / "out"
OUT.mkdir(parents=True, exist_ok=True)

AIRCRAFT = "22092"
HOST     = "https://free1.airlinesim.aero"
TARGET   = f"{HOST}/app/fleets/aircraft/{AIRCRAFT}/0"


def main() -> int:
    obs = {"target": TARGET}
    log: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        afp_page = None
        for ctx in browser.contexts:
            for pg in ctx.pages:
                if "/app/fleets/aircraft/" in pg.url and "/0" in pg.url:
                    afp_page = pg
                    break
            if afp_page:
                break
        if afp_page is None:
            print(json.dumps({"error": "no AFP tab open"}))
            return 2

        afp_page.on("console", lambda m: log.append({"t": time.time(), "type": m.type, "text": m.text[:300]}))
        afp_page.on("pageerror", lambda e: log.append({"t": time.time(), "type": "pageerror", "text": str(e)[:300]}))

        t0 = time.time()
        afp_page.goto(TARGET, wait_until="load", timeout=30000)

        # Sample DOM at +0s, +2s, +5s, +8s
        samples = []
        for delay in (0, 2, 5, 8):
            time.sleep(max(0, delay - (time.time() - t0)))
            snap = afp_page.evaluate(r"""
                (() => {
                    const slots = [...document.querySelectorAll('[data-aes-afp-slot]')].map(s=>s.dataset.aesAfpSlot);
                    return {
                        url: location.href,
                        readyState: document.readyState,
                        afpHost: !!document.querySelector('[data-aes-afp-host]'),
                        wideHost: !!document.querySelector('[data-aes-afp-wide-host]'),
                        slots,
                        h3List: [...document.querySelectorAll('h3')].map(h=>h.textContent.trim()),
                        bodyHasAesNs: typeof window.AesAfp,
                        candidatesText: ((document.querySelector('[data-aes-afp-slot=\"candidates\"]') || {}).innerText || '').slice(0,140),
                        studioText: ((document.querySelector('[data-aes-afp-slot=\"studio\"]') || {}).innerText || '').slice(0,140)
                    };
                })()
            """)
            samples.append({"deltaSec": round(time.time() - t0, 2), "dom": snap})

        afp_page.screenshot(path=str(OUT / "step-after-reload.png"), full_page=True)
        obs["samples"] = samples
        obs["console_count"] = len(log)
        obs["console"] = log
        print(json.dumps(obs, indent=2, default=str))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
