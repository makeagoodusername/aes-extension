#!/usr/bin/env python3
"""End-to-end Route Builder live test via Playwright.

Loads the AES extension into Chrome for Testing, logs into AirlineSim with
credentials from audit/credentials.json, drives the AFP Route Builder UI on a
real aircraft, and verifies that pre-fill flows through to AS's New Flight
Number form. Submission stays on the user's deliberate gesture (we click AS's
own green button, NOT a bypass) per CLAUDE.md §3 rule 1.

Usage:
    python3 audit/scripts/playwright/route_builder_e2e.py [--mode probe|fill|submit]

Modes
    probe   diagnose UI state — no clicks beyond navigation (default)
    fill    click candidate row, observe form pre-fill, no submit
    submit  pre-fill + click AS's submit button (real game-state mutation)
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parents[3]
EXT_DIR = str(ROOT)
CREDS = json.loads((ROOT / "audit" / "credentials.json").read_text())

CFT_BIN = (
    "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/"
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/"
    "Google Chrome for Testing"
)
PROFILE_DIR = os.environ.get("AES_RB_PROFILE_DIR", "/tmp/chrome-rb-pw")
SERVER = CREDS.get("server", "free1.airlinesim.aero")


def log(msg: str) -> None:
    print(f"[rb-e2e] {msg}", flush=True)


def login(page) -> None:
    log("navigating to login")
    page.goto("https://www.airlinesim.aero/auth/login", wait_until="domcontentloaded")
    page.wait_for_selector("form input[type='password']", timeout=15000)
    inputs = page.query_selector_all("form input")
    user_inp = None
    for inp in inputs:
        n = (inp.get_attribute("name") or "").lower()
        t = (inp.get_attribute("type") or "").lower()
        if t == "password":
            continue
        if n in ("j_username", "username", "email", "login"):
            user_inp = inp
            break
        if t == "email":
            user_inp = inp
            break
    if not user_inp:
        user_inp = inputs[0]
    user_inp.fill(CREDS["email"])
    page.locator("form input[type='password']").first.fill(CREDS["password"])
    btn = page.locator("form button[type='submit'], form input[type='submit']").first
    if btn.count():
        btn.click()
    else:
        page.evaluate("() => document.querySelector('form').submit()")
    page.wait_for_load_state("networkidle", timeout=20000)
    log(f"after login url={page.url}")


def find_aircraft_id(page) -> str | None:
    # Survey the global /account page first — it's the canonical place to
    # see all enterprises this account owns across servers. If the user
    # has an enterprise on a different server (free2, etc.), prefer that.
    log("surveying https://www.airlinesim.aero/account for enterprises")
    try:
        page.goto("https://www.airlinesim.aero/account",
                  wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(2000)
        ent_survey = page.evaluate(
            r"""
() => {
  const out = {};
  const links = Array.from(document.querySelectorAll('a'));
  out.entLinks = Array.from(new Set(links.map(a => a.href)
    .filter(h => /\/app\/enterprise\/dashboard/.test(h))));
  // "Manage" / "Play" / "Open" buttons usually point to airline app URLs
  out.appLinks = Array.from(new Set(links.map(a => a.href)
    .filter(h => /airlinesim\.aero\/app\//.test(h)
              && !/^https:\/\/www\.airlinesim\.aero/.test(h))));
  // Section text scrape — the /account page lists enterprises with
  // "Active" / "Inactive" status labels, IATA codes, server names.
  const text = (document.body.innerText || '').slice(0, 4000);
  out.bodyTextHead = text;
  // Buttons / list items mentioning enterprises
  out.h1 = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent.trim()).slice(0, 12);
  return out;
}
            """
        )
        log(f"account-page enterprise dashboard links: {ent_survey.get('entLinks')}")
        log(f"account-page app links: {ent_survey.get('appLinks')}")
        log(f"account-page headings: {ent_survey.get('h1')}")
        log(f"account-page text head:\n{ent_survey.get('bodyTextHead', '')[:1500]}")
        # If we found a per-server enterprise dashboard link, follow it.
        for h in ent_survey.get("appLinks", []):
            if "/app/enterprise/dashboard" in h or "/app/fleets" in h:
                log(f"following enterprise app link: {h}")
                page.goto(h, wait_until="domcontentloaded", timeout=15000)
                page.wait_for_timeout(2500)
                ids = page.evaluate(
                    "() => Array.from(document.querySelectorAll('a[href*=\"/app/fleets/aircraft/\"]'))"
                    ".map(a => (a.href.match(/aircraft\\/(\\d+)/) || [])[1])"
                    ".filter(Boolean)"
                )
                log(f"  ids on this page: {ids[:5]}")
                if ids:
                    return ids[0]
                # If we landed on a real airline dashboard, also look for
                # /app/com/scheduling/<HUBDEST> links — those reveal owned
                # routes, hence owned aircraft.
    except Exception as e:
        log(f"/account survey failed: {e}")
    for guess in ("22035", "22094"):
        log(f"probing /app/fleets/aircraft/{guess}/0")
        try:
            page.goto(f"https://{SERVER}/app/fleets/aircraft/{guess}/0",
                      wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(2500)
            url_now = page.url
            log(f"  landed url={url_now}")
            if f"aircraft/{guess}" in url_now:
                # Verify the AFP page actually rendered (title must contain
                # 'Aircraft' or registration). Skip if it's a 404/redirect.
                title = page.title()
                log(f"  title={title!r}")
                if "Unexpected" not in title and "Error" not in title:
                    log(f"aircraft {guess} loads — using it")
                    return guess
        except Exception as e:
            log(f"probe {guess} failed: {e}")
    log(f"navigating to https://{SERVER}/app/enterprise/dashboard for enterprise selection")
    try:
        page.goto(f"https://{SERVER}/app/enterprise/dashboard",
                  wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(2500)
    except PWTimeout:
        pass
    log(f"navigating to https://{SERVER}/app/fleets to discover an aircraft")
    page.goto(f"https://{SERVER}/app/fleets", wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except PWTimeout:
        log("networkidle timeout (continuing)")
    log(f"after fleets nav url={page.url}")
    if "auth" in page.url or "account" in page.url:
        # Need to click an enterprise to enter the server. The account page
        # lists enterprises with links like /app/enterprise/<id> on the
        # specific server.
        ent = page.locator(f"a[href*='{SERVER}/app/']").first
        if ent.count():
            href = ent.get_attribute("href")
            log(f"clicking enterprise entry: {href}")
            ent.click()
            page.wait_for_load_state("domcontentloaded", timeout=15000)
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except PWTimeout:
                pass
            page.goto(f"https://{SERVER}/app/fleets", wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except PWTimeout:
                pass
        log(f"after server entry url={page.url}")
    page.wait_for_timeout(2500)
    survey = page.evaluate(
        r"""
() => {
  const out = {url: location.href, title: document.title};
  const allLinks = Array.from(document.querySelectorAll('a'));
  out.totalLinks = allLinks.length;
  const idsFromHref = allLinks
    .map(a => (a.href||'').match(/aircraft\/(\d+)/))
    .filter(Boolean).map(m => m[1]);
  out.idsFromHref = idsFromHref.slice(0, 5);
  // Probe for any link that mentions /fleets/ followed by digits — fleet
  // list view, hangar view, all use slightly different URL shapes.
  const allFleetLinks = allLinks.map(a => a.href).filter(h => /\/app\/fleets\/[^?#]/.test(h));
  out.fleetLinks = allFleetLinks.slice(0, 10);
  // Tables on this page
  out.tableCount = document.querySelectorAll('table').length;
  out.firstTableRows = document.querySelector('table') ? document.querySelector('table').rows.length : 0;
  // Try data-ng-href, data-href, or text pattern
  const idsFromText = Array.from(document.body.innerText.matchAll(/\b(\d{4,7})\b/g))
    .map(m => m[1]).slice(0, 10);
  out.idsFromText = idsFromText;
  // Sample a few links to see their hrefs
  out.sampleHrefs = allLinks.slice(0, 30).map(a => a.href).filter(h => h && !h.startsWith('javascript'));
  // Tab navigation hints — aircraft list might be a different tab
  const tabs = Array.from(document.querySelectorAll('.nav-tabs a, .nav a, ul.nav li a'))
    .map(a => ({text: a.textContent.trim().slice(0,30), href: a.href}));
  out.tabs = tabs.slice(0, 12);
  // If there's a button to expand a list
  out.iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src);
  return out;
}
        """
    )
    log("== fleets-page survey ==")
    log(json.dumps(survey, indent=2)[:2500])
    ids = survey.get("idsFromHref", [])
    if not ids:
        # Try clicking a tab labelled "Aircraft" or following a link to aircraft list
        for tab in survey.get("tabs", []):
            t = (tab.get("text") or "").lower()
            if "aircraft" in t and "fleets" not in t:
                log(f"clicking tab: {tab}")
                page.goto(tab["href"], wait_until="domcontentloaded")
                page.wait_for_timeout(2500)
                ids = page.evaluate(
                    "() => Array.from(document.querySelectorAll('a[href*=\"/app/fleets/aircraft/\"]'))"
                    ".map(a => (a.href.match(/aircraft\\/(\\d+)/) || [])[1])"
                    ".filter(Boolean)"
                )
                if ids:
                    break
    log(f"found aircraft ids: {ids[:5]} ... ({len(ids)} total)")
    return ids[0] if ids else None


def diagnose_route_builder(page) -> dict:
    """Read AesAfp.* globals + slot DOM snapshot from the extension's isolated world."""
    return page.evaluate(
        r"""
() => {
  const out = {};
  out.url = location.href;
  out.hasAesAfp = typeof window.AesAfp;
  out.hasFormDriver = typeof window.AesAfpFormDriver;
  out.hasOrchestrator = typeof window.AesAfpScheduleApplyOrchestrator;
  out.hasRouteCandidates = typeof window.AesAfpRouteCandidates;
  out.hasDragToSchedule = typeof window.AesAfpDragToSchedule;
  out.hasWaveStrip = typeof window.AesAfpWaveStrip;
  out.hasScheduleStore = typeof window.AesAfpScheduleStore;
  out.hasFlightStudio = typeof window.AesAfpFlightStudio;
  const headers = Array.from(document.querySelectorAll('h3'))
    .map(h => h.textContent.trim());
  out.h3s = headers;
  out.hasRouteBuilderHeader = headers.includes('AES Route Builder');
  out.hasRouteAssistantHeader = headers.includes('AES Route Assistant');
  const slots = Array.from(document.querySelectorAll('[data-aes-afp-slot]'))
    .map(s => ({name: s.getAttribute('data-aes-afp-slot'),
                hasChildren: !!s.firstElementChild,
                outerLen: (s.outerHTML||'').length}));
  out.slots = slots;
  out.candidateRows = document.querySelectorAll('[data-aes-afp-cand-iata]').length;
  // AS form locators (mirror host.js's getNewFlightForm)
  const formGuess = document.querySelector('form');
  out.formAction = formGuess ? formGuess.action : null;
  const ctx = (window.AesAfp && window.AesAfp.ctx) || null;
  out.ctx = ctx ? {
    server: ctx.server,
    aircraftId: ctx.aircraftId,
    registration: ctx.registration,
    equipment: ctx.equipment,
    currentLocationIata: ctx.currentLocationIata
  } : null;
  // Form handles
  if (window.AesAfp && typeof window.AesAfp.getNewFlightForm === 'function') {
    try {
      const f = window.AesAfp.getNewFlightForm();
      out.formHandles = f ? {
        hasForm: !!f.form,
        hasOrigin: !!f.originSelect,
        hasDest: !!f.destSelect,
        hasHours: !!f.hoursSelect,
        hasMins: !!f.minsSelect,
        hasPrice: !!f.priceSelect,
        hasService: !!f.serviceSelect,
        hasFlightNumber: !!f.flightNumberInput,
        hasSubmit: !!f.submitBtn
      } : null;
    } catch(e) { out.formHandlesErr = String(e); }
  }
  if (window.AesAfp && typeof window.AesAfp.getFormTabs === 'function') {
    try {
      const t = window.AesAfp.getFormTabs();
      out.tabs = t ? {
        hasNewTab: !!t.newTab,
        hasExistingTab: !!t.existingTab,
        activeTab: t.activeTab
      } : null;
    } catch(e) { out.tabsErr = String(e); }
  }
  // Scrape errors from console (we can't read console, but document any
  // visible error overlays the extension may have rendered)
  const errs = document.querySelectorAll('.aes-afp-driver-hint');
  out.driverHintTexts = Array.from(errs).map(e => e.textContent.trim()).filter(Boolean);
  return out;
}
        """
    )


def trigger_ff_scan_if_needed(page) -> dict:
    """Click the in-panel FlightsFrom scan button when the candidates pane shows
    "No FlightsFrom data". Waits up to ~120s for the scrape tab to populate
    the data store, then refreshes the candidate list. Returns a dict with
    {triggered, finalCount, status}."""
    state = page.evaluate(
        r"""
() => {
  const slot = document.querySelector('[data-aes-afp-slot=candidates]');
  const btn  = slot && slot.querySelector('[data-aes-ff-scan-btn]');
  const candCount = document.querySelectorAll('[data-aes-afp-cand-iata]').length;
  return {
    candCount,
    hasScanBtn: !!btn,
    btnDisabled: btn ? !!btn.disabled : null,
    statusText: slot && slot.querySelector('[data-aes-ff-status]')
      ? slot.querySelector('[data-aes-ff-status]').textContent.trim()
      : null
  };
}
        """
    )
    log(f"ff-state pre: {state}")
    if state.get("candCount", 0) > 0:
        return {"triggered": False, "reason": "candidates already present",
                "finalCount": state["candCount"]}
    if not state.get("hasScanBtn"):
        return {"triggered": False, "reason": "no scan button rendered",
                "state": state}
    clicked = page.evaluate(
        r"""
() => {
  const btn = document.querySelector('[data-aes-afp-slot=candidates] [data-aes-ff-scan-btn]');
  if (!btn) return {ok: false, err: 'btn-missing-on-second-look'};
  if (btn.disabled) return {ok: false, err: 'btn-disabled'};
  btn.click();
  return {ok: true};
}
        """
    )
    if not clicked.get("ok"):
        return {"triggered": False, "reason": clicked}
    log("FF scan triggered; waiting for child tab to scrape (up to 120s)")
    last = None
    for i in range(60):  # 60 × 2s = 120s
        page.wait_for_timeout(2000)
        last = page.evaluate(
            r"""
() => {
  const slot = document.querySelector('[data-aes-afp-slot=candidates]');
  return {
    candCount: document.querySelectorAll('[data-aes-afp-cand-iata]').length,
    statusText: slot && slot.querySelector('[data-aes-ff-status]')
      ? slot.querySelector('[data-aes-ff-status]').textContent.trim()
      : null
  };
}
            """
        )
        if last.get("candCount", 0) > 0:
            log(f"FF scan complete after {(i+1)*2}s — {last['candCount']} candidates")
            return {"triggered": True, "finalCount": last["candCount"],
                    "elapsedSec": (i + 1) * 2}
    return {"triggered": True, "reason": "timeout", "lastState": last}


def click_first_candidate(page) -> dict:
    """Click a candidate row that AS will actually accept, then read back the AS
    form state via DOM.

    Uses pure DOM selectors mirroring host.js#findNewFlightForm so the
    snapshot works in Playwright's main world (window.AesAfp is in the
    extension's isolated world and not directly reachable from here).

    Prefers a candidate whose IATA appears as an actual <option> in AS's
    destination select — flightsfrom-derived candidates may include
    destinations AS doesn't permit from this hub (regulation, missing
    bilateral, etc.), and form-driver's destination-fill silently misses
    those. Also prefers rows with a slot-available dep time; falls back to
    injecting "12:00" so the per-row depSlotUnavailable guard doesn't
    swallow the click.
    """
    res = page.evaluate(
        r"""
() => {
  const rows = document.querySelectorAll('[data-aes-afp-cand-iata]');
  if (!rows.length) return {ok:false, err:'no-candidate-rows'};
  // Build a set of IATAs the AS form will actually accept as destinations.
  const submit = document.querySelector("input[type='submit'][value*='Create new flight']");
  const form = submit && submit.closest('form');
  const destSel = form && (form.querySelector("select[name='destination']")
                       || form.querySelector("select[name*='destination']"));
  const allowed = new Set();
  if (destSel) {
    for (const opt of destSel.options) {
      const m = (opt.text || '').match(/\(([A-Z]{3})\)/);
      if (m) allowed.add(m[1]);
    }
  }
  // Prefer a row whose IATA is in `allowed` AND has slotAvailable.
  // Fall back through (allowed, anything) → (anything, slotAvailable) →
  // (anything, anything).
  let chosenRow = null;
  let chosenDiag = null;
  let bestRank = -1;  // higher is better
  for (const r of rows) {
    const dep = r.querySelector('.aes-afp-row-dep');
    const iata = r.dataset.aesAfpCandIata;
    const slotAvail = dep ? dep.placeholder !== 'pick' : false;
    const inAllowed = allowed.size === 0 || allowed.has(iata);
    const diag = {
      iata,
      depVal: dep ? dep.value : null,
      depPlaceholder: dep ? dep.placeholder : null,
      depTitle: dep ? dep.title : null,
      depDisabled: dep ? !!dep.disabled : null,
      slotAvailable: slotAvail,
      inAsAllowedDestinations: inAllowed,
    };
    // Rank: 3 = allowed + slot-avail; 2 = allowed only; 1 = slot only; 0 = neither
    const rank = (inAllowed ? 2 : 0) + (slotAvail ? 1 : 0);
    if (rank > bestRank) {
      bestRank = rank;
      chosenRow = r;
      chosenDiag = diag;
      if (rank === 3) break;
    }
  }
  const r = chosenRow;
  const dep = r.querySelector('.aes-afp-row-dep');
  // If the row has no dep value yet (depSlotUnavailable=true OR fresh row),
  // inject a sane default so emit() doesn't silently swallow the click.
  let injected = null;
  if (dep && (!dep.value || !/^\d{1,2}:\d{2}$/.test(dep.value))) {
    injected = '12:00';
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(dep), 'value').set;
    setter.call(dep, injected);
    dep.dispatchEvent(new Event('input', {bubbles: true}));
    dep.dispatchEvent(new Event('change', {bubbles: true}));
  }
  const iata = r.dataset.aesAfpCandIata;
  r.scrollIntoView({block:'center'});
  const ev = new MouseEvent('click', {bubbles: true, cancelable: true, view: window});
  r.dispatchEvent(ev);
  return {ok:true, clickedIata: iata, injectedDepTime: injected, diag: chosenDiag};
}
        """
    )
    # form-driver runs fill() async; _ensureNewTabActive may switch tabs
    # via Wicket AJAX which can take 3-6s. Poll instead of single-shot,
    # bail out early once the destination chip changes from the default.
    snap = None
    for poll in range(12):  # 12 × 1s = 12s
        page.wait_for_timeout(1000)
        snap = page.evaluate(
        r"""
() => {
  // Mirror host.js#findNewFlightForm — pure DOM, isolated-world-free.
  const submitBtn = document.querySelector(
    "input[type='submit'][value*='Create new flight']"
  );
  if (!submitBtn) return {ok:false, err:'no-submit-button-on-page'};
  const form = submitBtn.closest('form');
  if (!form) return {ok:false, err:'submit-has-no-form-ancestor'};

  const $ = (sel) => form.querySelector(sel);
  const originSelect  = $("select[name='origin']")       || $("select[name*='origin']");
  const destSelect    = $("select[name='destination']")  || $("select[name*='destination']");
  const hoursSelect   = $("select[name='departure:hours']");
  const minsSelect    = $("select[name='departure:minutes']");
  const priceSelect   = $("select[name='price']");
  const serviceSelect = $("select[name='service']");
  const flightNumberInput =
       $("input[name='number:number_body:input']")
    || $("input[name$=':number_body:input']")
    || $("input[type='text'][maxlength='4'][name*='number']");

  const optText = (sel) => {
    if (!sel) return null;
    const o = sel.options[sel.selectedIndex];
    return o ? {value: o.value, text: (o.text || '').trim()} : null;
  };
  const chip = (id) => {
    if (!id) return null;
    const c = document.getElementById('s2id_' + id);
    if (!c) return null;
    const cn = c.querySelector('.select2-chosen');
    return cn ? cn.textContent.trim() : null;
  };

  return {
    ok: true,
    origin: optText(originSelect),
    dest:   optText(destSelect),
    hours:  optText(hoursSelect),
    mins:   optText(minsSelect),
    price:  optText(priceSelect),
    service:optText(serviceSelect),
    flightNumberValue: flightNumberInput ? flightNumberInput.value : null,
    chipOrigin: originSelect ? chip(originSelect.id) : null,
    chipDest:   destSelect ? chip(destSelect.id) : null,
    submitBtnVisible: !!submitBtn.offsetParent,
    submitBtnLabel:   (submitBtn.value || submitBtn.textContent || '').trim(),
    driverHint: (document.querySelector('.aes-afp-driver-hint') || {}).textContent || null
  };
}
        """
        )
        if not snap or snap.get("ok") is False:
            continue
        chip_dest = snap.get("chipDest") or ""
        dest_val = (snap.get("dest") or {}).get("value") or ""
        if dest_val and chip_dest and chip_dest != "Choose One":
            log(f"form filled after poll {poll + 1} ({(poll + 1)}s)")
            break
    return {"click": res, "form": snap}


def click_as_submit(page) -> dict:
    """Click AS's native 'Create new flight number' button (not a bypass)."""
    res = page.evaluate(
        r"""
() => {
  const f = window.AesAfp && window.AesAfp.getNewFlightForm
    ? window.AesAfp.getNewFlightForm() : null;
  if (!f || !f.submitBtn) return {ok:false, err:'no-submit-button'};
  const before = f.submitBtn.outerHTML.slice(0, 120);
  f.submitBtn.click();
  return {ok:true, clicked: before};
}
        """
    )
    page.wait_for_load_state("networkidle", timeout=20000)
    return res


def main(mode: str, aircraft: str | None, enterprise: str | None) -> int:
    args = [
        f"--load-extension={EXT_DIR}",
        f"--disable-extensions-except={EXT_DIR}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--window-size=1500,1000",
    ]
    log(f"mode={mode} ext={EXT_DIR}")
    log(f"profile={PROFILE_DIR}")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            executable_path=CFT_BIN,
            headless=False,
            args=args,
            viewport={"width": 1500, "height": 1000},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        # Forward extension + page console output so form-driver fill()
        # diagnostics + AesAfp warnings reach the test log.
        def _on_console(msg):
            try:
                txt = msg.text
            except Exception:
                txt = "<unreadable console msg>"
            if "AES" in txt or msg.type in ("error", "warning"):
                log(f"page.{msg.type}: {txt[:240]}")
        page.on("console", _on_console)
        page.on("pageerror", lambda e: log(f"pageerror: {str(e)[:240]}"))
        try:
            login(page)
            # When --enterprise is supplied, prime the AS session by selecting
            # that enterprise via the dashboard URL. Skips the discovery dance
            # entirely when --aircraft is also supplied.
            if enterprise:
                log(f"selecting enterprise {enterprise}")
                page.goto(
                    f"https://{SERVER}/app/enterprise/dashboard?select={enterprise}",
                    wait_until="domcontentloaded", timeout=30000,
                )
                try:
                    page.wait_for_load_state("networkidle", timeout=15000)
                except PWTimeout:
                    pass
            ac_id = aircraft or find_aircraft_id(page)
            if not ac_id:
                log("no aircraft id discovered; aborting "
                    "(pass --aircraft <id> + --enterprise <id> to skip discovery)")
                return 2
            log(f"using aircraft id={ac_id}")
            if not page.url.endswith(f"/aircraft/{ac_id}/0"):
                page.goto(f"https://{SERVER}/app/fleets/aircraft/{ac_id}/0",
                          wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except PWTimeout:
                pass
            # Allow content scripts time to mount + ctx:ready emit
            page.wait_for_timeout(3500)
            d = diagnose_route_builder(page)
            log("== diagnose snapshot ==")
            log(json.dumps(d, indent=2)[:3500])
            if mode in ("fill", "submit"):
                if d.get("candidateRows", 0) == 0:
                    log("no candidate rows present; trying FlightsFrom scan bootstrap")
                    ff = trigger_ff_scan_if_needed(page)
                    log(f"ff-bootstrap: {ff}")
                    if not ff.get("finalCount"):
                        log("waiting up to 10s for any late candidates...")
                        for _ in range(10):
                            page.wait_for_timeout(1000)
                            n = page.evaluate(
                                "() => document.querySelectorAll('[data-aes-afp-cand-iata]').length"
                            )
                            if n:
                                log(f"candidates appeared: {n}")
                                break
                f = click_first_candidate(page)
                log("== click + post-fill snapshot ==")
                log(json.dumps(f, indent=2)[:3500])
            if mode == "submit":
                if not f.get("form", {}).get("ok"):
                    log("form not ready; aborting submit")
                    return 3
                log(">>> submitting via AS native button <<<")
                r = click_as_submit(page)
                log(json.dumps(r, indent=2))
                page.wait_for_timeout(3000)
                log(f"post-submit url={page.url}")
            log("done; leaving browser open 10s for visual inspection")
            page.wait_for_timeout(10000)
        finally:
            ctx.close()
    return 0


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--mode", default="probe", choices=["probe", "fill", "submit"])
    p.add_argument("--aircraft", default=os.environ.get("AES_TEST_AIRCRAFT_ID"),
                   help="Skip aircraft discovery and go straight to /app/fleets/aircraft/<id>/0")
    p.add_argument("--enterprise",
                   default=os.environ.get("AES_TEST_ENTERPRISE_ID"),
                   help="Select this enterprise via dashboard?select=<id> before navigating")
    a = p.parse_args()
    sys.exit(main(a.mode, a.aircraft, a.enterprise))
