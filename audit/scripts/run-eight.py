#!/usr/bin/env python3
"""run-eight.py — log in and navigate each of the 8 audit Chromes.

Reads credentials from audit/credentials.json, then in parallel:
  1. Calls cdp-login.login(port, email, password) — opens /auth/login,
     fills the form, submits, waits for the post-login redirect.
  2. Opens a new tab on the agent's landing URL.
  3. Closes the now-stale /auth/login tab so each Chrome is left with
     exactly one tab on the right URL.

Reuses cdp-login.py's login() function as-is; no new dependencies.

Run directly via:    python3 audit/scripts/run-eight.py
Run via wrapper:     bash   audit/scripts/run-eight.sh
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AUDIT_DIR = os.path.dirname(SCRIPT_DIR)
CREDS_FILE = os.path.join(AUDIT_DIR, "credentials.json")
LOGIN_PY = os.path.join(SCRIPT_DIR, "cdp-login.py")

# Agent → (port, landing URL). server is templated in from credentials.
AGENTS = [
    (1, 9233, "chrome://extensions/"),
    (2, 9234, "https://{server}/app/com/scheduling"),
    (3, 9235, "https://{server}/app/enterprise/dashboard"),
    (4, 9236, "https://{server}/app/fleets"),
    (5, 9237, "https://{server}/app/aircraft/market"),
    (6, 9238, "https://{server}/app/enterprise/dashboard"),
    (7, 9239, "chrome://extensions/"),
    (8, 9240, "https://{server}/app/enterprise/dashboard"),
]

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def load_creds() -> dict:
    with open(CREDS_FILE) as f:
        creds = json.load(f)
    for k in ("email", "password"):
        if not creds.get(k):
            sys.exit(f"credentials.json: '{k}' is empty — fill in your AS login")
    creds.setdefault("server", "free1.airlinesim.aero")
    return creds


def import_login():
    spec = importlib.util.spec_from_file_location("cdp_login", LOGIN_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.login


def cdp_open_tab(port: int, url: str) -> dict:
    req = urllib.request.Request(
        f"http://localhost:{port}/json/new?{url}", method="PUT"
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read())


def cdp_close_tab(port: int, target_id: str) -> None:
    req = urllib.request.Request(
        f"http://localhost:{port}/json/close/{target_id}", method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


def cdp_list_tabs(port: int) -> list:
    with urllib.request.urlopen(
        f"http://localhost:{port}/json/list", timeout=5
    ) as r:
        return json.loads(r.read())


def boot_agent(agent_num: int, port: int, url_tpl: str, creds: dict, login_fn) -> dict:
    server = creds["server"]
    landing_url = url_tpl.format(server=server)
    tag = f"[agent-{agent_num} port={port}]"

    # Sanity: CDP socket must be up.
    try:
        with urllib.request.urlopen(
            f"http://localhost:{port}/json/version", timeout=4
        ) as r:
            json.loads(r.read())
    except Exception as e:
        log(f"{tag} CDP not reachable: {e}")
        return {"agent": agent_num, "ok": False, "stage": "cdp", "err": str(e)}

    is_chrome_url = landing_url.startswith("chrome://")

    login_target_id = None
    login_status = "skipped" if is_chrome_url else "pending"

    if not is_chrome_url:
        # cdp-login.login(port, email, password) opens /auth/login itself
        # and walks the form. It prints a few lines we don't capture here;
        # we rely on a post-check (final URL is not /auth/login) to decide
        # success. login() returns the target_id of the tab it opened.
        try:
            log(f"{tag} logging in as {creds['email']}...")
            login_target_id = login_fn(port, creds["email"], creds["password"])
            login_status = "ok"
        except SystemExit as e:
            log(f"{tag} login exited: {e}")
            login_status = f"exit:{e}"
        except Exception as e:
            log(f"{tag} login raised: {e}")
            login_status = f"err:{e}"

    # Open the landing URL on a fresh tab.
    try:
        new_tab = cdp_open_tab(port, landing_url)
        log(f"{tag} opened landing URL: {landing_url}")
    except Exception as e:
        log(f"{tag} could not open landing URL: {e}")
        return {
            "agent": agent_num,
            "ok": False,
            "stage": "open-landing",
            "err": str(e),
            "login": login_status,
        }

    # Give AS a beat to redirect / hydrate before we tear down login tab.
    time.sleep(2)

    # Close the original /auth/login tab so each Chrome is left with one
    # tab on the agent's URL (plus whatever blank tab the launcher seeded).
    if login_target_id:
        cdp_close_tab(port, login_target_id)

    # Close any leftover about:blank tabs the launcher seeded.
    try:
        for tab in cdp_list_tabs(port):
            if tab.get("type") != "page":
                continue
            if tab.get("id") == new_tab.get("id"):
                continue
            url = tab.get("url", "")
            if url == "about:blank" or url.startswith("chrome://newtab"):
                cdp_close_tab(port, tab["id"])
    except Exception:
        pass

    return {
        "agent": agent_num,
        "ok": True,
        "login": login_status,
        "url": landing_url,
    }


def main() -> int:
    creds = load_creds()
    login_fn = import_login()

    log(f"Server: {creds['server']}  /  account: {creds['email']}")
    log("Booting 8 agents in parallel...")
    log("")

    results = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {
            pool.submit(boot_agent, n, p, u, creds, login_fn): n
            for (n, p, u) in AGENTS
        }
        for fut in as_completed(futs):
            results.append(fut.result())

    results.sort(key=lambda r: r["agent"])
    log("")
    log("=== Boot summary ===")
    failed = 0
    for r in results:
        if r.get("ok"):
            log(f"  agent-{r['agent']}: OK  login={r['login']}  url={r['url']}")
        else:
            failed += 1
            log(
                f"  agent-{r['agent']}: FAIL stage={r.get('stage')} "
                f"login={r.get('login')} err={r.get('err')}"
            )
    if failed:
        log("")
        log(f"{failed} agent(s) failed to boot fully. Other agents are still up.")
        return 1
    log("")
    log("All 8 agents up. Use stop-eight.sh to shut them down.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
