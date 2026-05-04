#!/usr/bin/env python3
"""Read-only Playwright probe of the AES Route Builder on the live AFP page.

Connects to the running Chrome (port 9241) via CDP, finds the AFP tab,
and inspects every Route Builder slot + the underlying state without
clicking anything that would mutate AS state.

Output: JSON describing what's mounted, what's missing, what would block
a real route creation.
"""
from __future__ import annotations

import json
import sys
from playwright.sync_api import sync_playwright

CDP_URL = "http://127.0.0.1:9241"
AFP_URL_NEEDLE = "/app/fleets/aircraft/"


PROBE_JS = r"""
(async () => {
  const result = {url: location.href, title: document.title};

  // — Mount state —
  result.mount = {
    afpHost: !!document.querySelector('[data-aes-afp-host]'),
    wideHost: !!document.querySelector('[data-aes-afp-wide-host]'),
    routeBuilderHeader: [...document.querySelectorAll('h3')].some(h=>h.textContent==='AES Route Builder'),
    routeAssistantHeader: [...document.querySelectorAll('h3')].some(h=>h.textContent==='AES Route Assistant'),
    slots: [...document.querySelectorAll('[data-aes-afp-slot]')].map(s => ({
      name: s.dataset.aesAfpSlot,
      hasContent: s.children.length > 0 || (s.textContent||'').trim().length > 0,
      childTags: [...s.children].map(c => c.tagName.toLowerCase())
    }))
  };

  // — AS native form state —
  const allForms = [...document.querySelectorAll('form')];
  const newFlightForm = allForms.find(f => /newFlightNumber|toggle~new/.test(f.getAttribute('action') || ''));
  result.asForm = {
    formCount: allForms.length,
    newFlightFormFound: !!newFlightForm,
    actions: allForms.map(f => f.getAttribute('action') || '').slice(0, 10),
    hasOriginSel: !!document.querySelector('select[name*="origin" i], select[id*="origin" i]'),
    hasDestSel:   !!document.querySelector('select[name*="destination" i], select[id*="destination" i]'),
    hasDepTimeInput: !!document.querySelector('input[name*="time" i], input[id*="time" i]'),
    submitButtons: [...document.querySelectorAll('button, input[type=submit], a')].filter(b => /create new flight number|submit|create/i.test((b.value||b.textContent||'').trim())).map(b => ({
      tag: b.tagName.toLowerCase(),
      text: (b.value||b.textContent||'').trim().slice(0,80),
      disabled: !!b.disabled
    })).slice(0, 5)
  };

  // — Tabs active state (new vs existing) —
  const navTabs = document.querySelector('ul.nav-tabs, .nav-tabs');
  result.tabs = navTabs ? {
    activeText: (navTabs.querySelector('li.active') || {}).innerText || null,
    tabs: [...navTabs.querySelectorAll('a')].map(a => a.textContent.trim()).slice(0, 8)
  } : null;

  // — Candidates / Tools / Studio (Route Builder slots) —
  const slot = (name) => document.querySelector(`[data-aes-afp-slot="${name}"]`);
  const summarize = (el) => el ? {
    childTagSummary: [...el.children].map(c => c.tagName.toLowerCase() + (c.id ? '#'+c.id : '') + (c.className && typeof c.className === 'string' ? '.'+c.className.split(' ').filter(Boolean).slice(0,3).join('.') : '')),
    textPreview: (el.innerText || '').slice(0, 240).replace(/\s+/g, ' ')
  } : null;
  result.slotsDetail = {
    tools: summarize(slot('tools')),
    candidates: summarize(slot('candidates')),
    driver: summarize(slot('driver')),
    studio: summarize(slot('studio')),
    autoPreview: summarize(slot('auto-preview')),
    wave: summarize(slot('wave'))
  };

  // — Candidate rows actually rendered —
  const candHost = slot('candidates');
  const candRows = candHost ? [...candHost.querySelectorAll('[data-cand-iata], [data-iata], tr[data-iata], [class*="candidate"]')].slice(0, 10).map(r => ({
    iata: r.dataset.candIata || r.dataset.iata || (r.querySelector('[data-iata]') || {}).dataset?.iata || null,
    text: (r.innerText || '').slice(0, 120).replace(/\s+/g, ' ')
  })) : [];
  result.candidateRows = candRows;

  return result;
})()
"""


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        contexts = browser.contexts
        afp_page = None
        for ctx in contexts:
            for page in ctx.pages:
                if AFP_URL_NEEDLE in page.url and "/0" in page.url:
                    afp_page = page
                    break
            if afp_page:
                break
        if afp_page is None:
            print(json.dumps({"error": "no AFP tab open in Chrome", "tabs": [pg.url for ctx in contexts for pg in ctx.pages]}, indent=2))
            return 2

        # Run in main world first (sees AS form). Extension globals are in isolated world,
        # but since extension already wrote into the page DOM, the AES Route Builder header
        # is visible from main world too.
        result = afp_page.evaluate(PROBE_JS)
        print(json.dumps(result, indent=2, default=str))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
