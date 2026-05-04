#!/usr/bin/env python3
"""Probe a URL on a specific Chrome port: nav -> close extras -> wait -> eval -> watch.

Usage: cdp-probe-clean.py <port> <url> [<eval_js>] [<watch_seconds>]
"""
from __future__ import annotations
import json, sys, time, urllib.request
from websocket import create_connection


def list_pages(port: int) -> list[dict]:
    return [t for t in json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read()) if t.get("type") == "page"]


def close_others(port: int, keep_id: str) -> int:
    n = 0
    for t in list_pages(port):
        if t.get("id") == keep_id: continue
        if "newtab" in t.get("url", ""): continue
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{t['id']}", timeout=3).read()
            n += 1
        except Exception:
            pass
    return n


def main():
    port = int(sys.argv[1]); url = sys.argv[2]
    eval_js = sys.argv[3] if len(sys.argv) > 3 else "location.href"
    watch_secs = float(sys.argv[4]) if len(sys.argv) > 4 else 0

    pages = list_pages(port)
    if not pages:
        body = urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?{url}", method="PUT"), timeout=8).read()
        target = json.loads(body)
    else:
        target = pages[0]

    ws = create_connection(target["webSocketDebuggerUrl"], timeout=20)
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

    send("Page.enable"); send("Runtime.enable"); send("Log.enable")
    nav = send("Page.navigate", {"url": url})
    wait_id(nav, 5)
    wait_method("Page.loadEventFired", timeout=15)
    time.sleep(3)

    # Close auto-spawned tabs (everything that doesn't match our nav URL)
    target_url_prefix = url.split("?")[0]
    pages_now = list_pages(port)
    survivor = next((p for p in pages_now if p.get("url", "").startswith(target_url_prefix)), None) or target
    closed = close_others(port, survivor["id"])

    # If our ws is dead because target id changed, reattach
    try:
        ws.send(json.dumps({"id": -1, "method": "Page.enable"}))
    except Exception:
        ws = create_connection(survivor["webSocketDebuggerUrl"], timeout=10)
        send("Page.enable"); send("Runtime.enable")

    time.sleep(2)

    # Eval
    eid = send("Runtime.evaluate", {"expression": f"({eval_js})", "returnByValue": True, "awaitPromise": True})
    res = wait_id(eid, timeout=15)
    val = res.get("result", {}).get("result", {}).get("value") if res else None
    print(json.dumps({"url_after_nav": url, "closed_extra_tabs": closed, "eval": val}, ensure_ascii=False, indent=2))

    # Watch
    if watch_secs > 0:
        end = time.time() + watch_secs
        ws.settimeout(0.4)
        events = []
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            method = m.get("method")
            if method == "Runtime.consoleAPICalled":
                p = m.get("params", {})
                lvl = p.get("type", "log")
                args = p.get("args", [])
                txt = " | ".join(a.get("value", a.get("description", "")) for a in args)[:400]
                events.append({"k": "console", "lvl": lvl, "txt": txt})
            elif method == "Runtime.exceptionThrown":
                e = m.get("params", {}).get("exceptionDetails", {})
                events.append({"k": "exception", "txt": (e.get("text", "") + ": " + str(e.get("exception", {}).get("description", "")))[:400]})
        print(json.dumps({"console_events": events}, ensure_ascii=False, indent=2))

    ws.close()


if __name__ == "__main__":
    main()
