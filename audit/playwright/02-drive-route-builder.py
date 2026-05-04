#!/usr/bin/env python3
"""Live-drive the Route Builder via Playwright on the running Chrome (port 9241).

Connects to existing Chrome via CDP, finds the AFP tab for aircraft 22092
(N001CFA, B767-300ER, hub LHR), and walks the Flight Studio compose flow:

  1. Probe panel state (legs, mode badge, Apply button presence)
  2. Click "+ Add leg" in Flight Studio
  3. Type a destination IATA into the leg row's TO field
  4. Watch console for studio:dry-run-rendered + form:filled events
  5. Capture a screenshot at each step
  6. Print the resulting state — DO NOT click final Apply yet (read-only).

Outputs JSON of observations + screenshot paths.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, Page

CDP_URL = "http://127.0.0.1:9241"
ROOT    = Path("/Users/jihwan/Downloads/AES.v0.6.9")
OUT     = ROOT / "audit" / "playwright" / "out"
OUT.mkdir(parents=True, exist_ok=True)


def find_afp_page(browser) -> Page | None:
    for ctx in browser.contexts:
        for pg in ctx.pages:
            if "/app/fleets/aircraft/" in pg.url and "/0" in pg.url:
                return pg
    return None


def collect_console(page: Page, log: list[dict]) -> None:
    def on_console(msg):
        try:
            log.append({"type": msg.type, "text": msg.text[:400]})
        except Exception:
            pass
    page.on("console", on_console)
    page.on("pageerror", lambda e: log.append({"type": "pageerror", "text": str(e)[:400]}))


def main() -> int:
    obs: dict = {"steps": []}
    console_log: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        page = find_afp_page(browser)
        if page is None:
            print(json.dumps({"error": "no AFP tab open"}))
            return 2

        obs["url"] = page.url
        collect_console(page, console_log)
        page.bring_to_front()
        time.sleep(0.5)

        # 1) Snapshot the Studio panel structure
        studio_state = page.evaluate(r"""
            (() => {
                const slot = document.querySelector('[data-aes-afp-slot="studio"]');
                if (!slot) return {error: 'studio slot missing'};
                const root = slot.querySelector('.aes-afp-studio') || slot;
                const buttons = [...root.querySelectorAll('button')].map(b => ({
                    text: (b.textContent || '').trim().slice(0, 60),
                    title: (b.title || '').slice(0, 80),
                    disabled: !!b.disabled,
                    ds: Object.fromEntries(Object.entries(b.dataset || {}))
                }));
                const inputs = [...root.querySelectorAll('input, select')].map(i => ({
                    tag: i.tagName.toLowerCase(),
                    name: i.name || '',
                    type: i.type || '',
                    placeholder: i.placeholder || '',
                    value: i.value || '',
                    ds: Object.fromEntries(Object.entries(i.dataset || {}))
                }));
                const legRows = [...root.querySelectorAll('[data-leg-row], [data-aes-studio-leg]')].map(r => ({
                    ds: Object.fromEntries(Object.entries(r.dataset || {})),
                    text: (r.innerText || '').slice(0, 200).replace(/\s+/g, ' ')
                }));
                const modeBadge = root.querySelector('[data-aes-studio-mode]');
                return {
                    badge: modeBadge ? modeBadge.textContent.trim() : null,
                    buttons: buttons.slice(0, 30),
                    inputs: inputs.slice(0, 30),
                    legRows,
                    rootText: (root.innerText || '').slice(0, 800).replace(/\s+/g, ' ')
                };
            })()
        """)
        obs["steps"].append({"name": "studio_initial_state", "data": studio_state})
        page.screenshot(path=str(OUT / "step1-initial.png"), full_page=False)

        # 2) Try clicking "+ Add leg" — text-based locator
        try:
            add_btn = page.locator('[data-aes-afp-slot="studio"] button:has-text("Add leg")').first
            if add_btn.count() == 0:
                add_btn = page.locator('[data-aes-afp-slot="studio"] button:has-text("+ Add")').first
            add_btn.click(timeout=3000)
            time.sleep(0.5)
            obs["steps"].append({"name": "click_add_leg", "ok": True})
        except Exception as e:
            obs["steps"].append({"name": "click_add_leg", "ok": False, "error": str(e)[:200]})

        # 3) Re-snapshot after add-leg
        after_add = page.evaluate(r"""
            (() => {
                const slot = document.querySelector('[data-aes-afp-slot="studio"]');
                const root = slot && (slot.querySelector('.aes-afp-studio') || slot);
                if (!root) return null;
                const legRows = [...root.querySelectorAll('[data-leg-row], [data-aes-studio-leg], tr[data-leg], tr[data-seq]')].map(r => ({
                    ds: Object.fromEntries(Object.entries(r.dataset || {})),
                    text: (r.innerText || '').slice(0, 240).replace(/\s+/g, ' ')
                }));
                const inputs = [...root.querySelectorAll('input, select')].map(i => ({
                    tag: i.tagName.toLowerCase(),
                    name: i.name || '',
                    placeholder: i.placeholder || '',
                    value: i.value || ''
                }));
                return {legRows, inputs};
            })()
        """)
        obs["steps"].append({"name": "studio_after_add", "data": after_add})
        page.screenshot(path=str(OUT / "step2-after-add.png"), full_page=False)

        # 4) Capture a long visible region — full body
        page.screenshot(path=str(OUT / "step3-fullpage.png"), full_page=True)

        obs["console_log_count"] = len(console_log)
        obs["console_recent"] = console_log[-30:]
        print(json.dumps(obs, indent=2, default=str))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
