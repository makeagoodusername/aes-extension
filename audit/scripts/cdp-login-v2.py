#!/usr/bin/env python3
"""Login v2: full event dispatch + fresh nav. Reads creds from audit/credentials.json."""
from __future__ import annotations
import json, sys, time, urllib.request
from pathlib import Path
from websocket import create_connection

ROOT = Path(__file__).resolve().parents[1]


def main(port: int) -> int:
    creds = json.loads((ROOT / "credentials.json").read_text())
    email = creds["email"]; password = creds["password"]

    # Pick the existing login tab or open a fresh one
    targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read())
    tab = next((t for t in targets if t.get("type") == "page" and "airlinesim" in t.get("url", "")), None)
    if not tab:
        body = urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?https://www.airlinesim.aero/auth/login",
            method="PUT"), timeout=8).read()
        tab = json.loads(body)
    ws = create_connection(tab["webSocketDebuggerUrl"], timeout=20)
    mid = 0
    def send(method, params=None):
        nonlocal mid
        mid += 1
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid
    def wait_id(target_id, timeout=10):
        end = time.time() + timeout
        ws.settimeout(0.4)
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("id") == target_id:
                return m
        return None
    def wait_method(method, timeout=10):
        end = time.time() + timeout
        ws.settimeout(0.4)
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("method") == method:
                return m
        return None

    send("Page.enable"); send("Runtime.enable")
    nav = send("Page.navigate", {"url": "https://www.airlinesim.aero/auth/login"})
    wait_id(nav, timeout=5)
    wait_method("Page.loadEventFired", timeout=15)
    time.sleep(2)

    js = f"""(async () => {{
      const f = document.querySelector('form');
      if (!f) return 'no-form';
      const u = f.querySelector('input[name="login"]');
      const p = f.querySelector('input[name="password"]');
      if (!u || !p) return 'fields-missing';
      const setNative = (el, val) => {{
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', {{bubbles:true}}));
        el.dispatchEvent(new Event('change', {{bubbles:true}}));
      }};
      u.focus(); setNative(u, {json.dumps(email)}); u.blur();
      p.focus(); setNative(p, {json.dumps(password)}); p.blur();
      await new Promise(r => setTimeout(r, 500));
      const btn = f.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) btn.click(); else f.submit();
      return 'submitted';
    }})()"""
    sid = send("Runtime.evaluate", {"expression": js, "awaitPromise": True, "returnByValue": True})
    res = wait_id(sid, timeout=10)
    print("submit result:", res.get("result", {}).get("result", {}).get("value") if res else "TIMEOUT")
    wait_method("Page.loadEventFired", timeout=15)
    time.sleep(3)
    uid = send("Runtime.evaluate", {"expression": "location.href", "returnByValue": True})
    res = wait_id(uid, timeout=5)
    final = res.get("result", {}).get("result", {}).get("value") if res else "?"
    print("post-login URL:", final)
    ws.close()
    return 0 if "auth/login" not in final else 1


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1])))
