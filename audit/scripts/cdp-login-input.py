#!/usr/bin/env python3
"""Login to AirlineSim through CDP using real input events.

The older cdp-login.py assigns input.value directly. AS currently rejects that
path as missing/invalid fields. This helper focuses each field and types via
CDP Input.insertText so the page receives normal input/change events.

Usage:
  python3 audit/scripts/cdp-login-input.py <port>
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from websocket import create_connection

ROOT = Path(__file__).resolve().parents[1]


def http_json(url: str, method: str = "GET") -> dict:
    req = urllib.request.Request(url, method=method)
    return json.loads(urllib.request.urlopen(req, timeout=8).read())


def open_login_tab(port: int) -> dict:
    url = "https://www.airlinesim.aero/auth/login"
    encoded = urllib.parse.quote(url, safe="")
    return http_json(f"http://127.0.0.1:{port}/json/new?{encoded}", "PUT")


class Cdp:
    def __init__(self, target: dict):
        self.ws = create_connection(
            target["webSocketDebuggerUrl"],
            timeout=20,
            suppress_origin=True,
        )
        self._mid = 0

    def close(self) -> None:
        self.ws.close()

    def send(self, method: str, params: dict | None = None) -> int:
        self._mid += 1
        self.ws.send(json.dumps({"id": self._mid, "method": method, "params": params or {}}))
        return self._mid

    def wait_id(self, mid: int, timeout: float = 10.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(min(0.5, max(0.05, deadline - time.time())))
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            if msg.get("id") == mid:
                return msg
        raise TimeoutError(f"CDP response {mid} timed out")

    def call(self, method: str, params: dict | None = None, timeout: float = 10.0) -> dict:
        return self.wait_id(self.send(method, params), timeout)

    def eval(self, expr: str, timeout: float = 8.0):
        msg = self.call(
            "Runtime.evaluate",
            {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": True,
                "timeout": int(timeout * 1000),
            },
            timeout + 2.0,
        )
        res = msg.get("result", {})
        if res.get("exceptionDetails"):
            raise RuntimeError(json.dumps(res["exceptionDetails"]))
        return (res.get("result") or {}).get("value")

    def wait_load(self, timeout: float = 20.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(min(0.5, max(0.05, deadline - time.time())))
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            if msg.get("method") == "Page.loadEventFired":
                return

    def focus_and_type(self, selector: str, text: str) -> None:
        ok = self.eval(
            f"""(() => {{
              const el = document.querySelector({json.dumps(selector)});
              if (!el) return false;
              el.focus();
              el.value = "";
              el.dispatchEvent(new Event("input", {{bubbles:true}}));
              return document.activeElement === el;
            }})()"""
        )
        if not ok:
            raise RuntimeError(f"could not focus {selector}")
        self.call("Input.insertText", {"text": text}, 5.0)
        self.eval(
            f"""(() => {{
              const el = document.querySelector({json.dumps(selector)});
              if (!el) return false;
              el.dispatchEvent(new Event("change", {{bubbles:true}}));
              return true;
            }})()"""
        )


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    port = int(sys.argv[1])
    creds = json.loads((ROOT / "credentials.json").read_text())
    target = open_login_tab(port)
    cdp = Cdp(target)
    try:
        cdp.call("Runtime.enable")
        cdp.call("Page.enable")
        cdp.wait_load(20.0)
        time.sleep(1.0)
        print(json.dumps(cdp.eval("({url:location.href,title:document.title})")))
        cdp.focus_and_type("form input[name='login'], form input[type='email']", creds["email"])
        cdp.focus_and_type("form input[type='password'], form input[name='password']", creds["password"])
        state = cdp.eval(
            """(() => ({
              loginLen: (document.querySelector("form input[name='login'], form input[type='email']") || {}).value?.length || 0,
              passwordLen: (document.querySelector("form input[type='password'], form input[name='password']") || {}).value?.length || 0
            }))()"""
        )
        print(json.dumps({"filled": state}))
        cdp.eval(
            """(() => {
              const form = document.querySelector("form");
              const btn = form && form.querySelector("button[type='submit'], input[type='submit']");
              if (btn) btn.click();
              else if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
              return true;
            })()"""
        )
        time.sleep(6.0)
        result = cdp.eval(
            """(() => ({
              url: location.href,
              title: document.title,
              text: document.body.innerText.slice(0, 900)
            }))()"""
        )
        print(json.dumps(result))
        return 0 if "/auth/login" not in result.get("url", "") else 1
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
