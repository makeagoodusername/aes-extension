#!/usr/bin/env python3
"""List all Runtime.executionContexts on a chosen tab.

Usage:
  python3 cdp-contexts.py <port> <url-substring>
"""
import sys, json, time, urllib.request
from websocket import create_connection


def main():
    port = int(sys.argv[1])
    needle = sys.argv[2] if len(sys.argv) > 2 else ""
    tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read())
    tab = next((t for t in tabs if t.get("type") == "page" and (not needle or needle in t.get("url", ""))), None)
    if not tab:
        print(json.dumps({"error": "no tab", "tabs": [t.get("url") for t in tabs]}))
        return
    ws = create_connection(tab["webSocketDebuggerUrl"], timeout=10)
    msg_id = [0]
    def send(method, params=None):
        msg_id[0] += 1
        ws.send(json.dumps({"id": msg_id[0], "method": method, "params": params or {}}))
        return msg_id[0]
    send("Page.enable")
    send("Runtime.enable")
    contexts = []
    deadline = time.time() + 3.0
    ws.settimeout(0.5)
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except Exception:
            continue
        try:
            m = json.loads(raw)
        except Exception:
            continue
        if m.get("method") == "Runtime.executionContextCreated":
            ctx = m["params"]["context"]
            contexts.append({
                "id": ctx.get("id"),
                "uniqueId": ctx.get("uniqueId"),
                "name": ctx.get("name"),
                "origin": ctx.get("origin"),
                "auxData": ctx.get("auxData"),
            })
    ws.close()
    print(json.dumps({"tab": tab.get("url"), "contexts": contexts}, indent=2))


if __name__ == "__main__":
    main()
