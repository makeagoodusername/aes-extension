#!/usr/bin/env python3
"""Evaluate a JS expression in an existing Chrome tab via CDP.

Usage:
  python3 cdp-eval.py <port> <url-substring> '<expression>' [--world=aes|main|N]

  --world=aes  : auto-pick the AES extension isolated world (where AesSettings exists)
  --world=main : main page world (default)
  --world=NNN  : use specific contextId
"""
import sys, json, time, urllib.request
try:
    from websocket import create_connection
except ImportError:
    print("ERROR: pip install websocket-client", file=sys.stderr)
    sys.exit(2)


def list_tabs(port):
    body = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read()
    return json.loads(body)


def pick_tab(tabs, url_substring):
    if url_substring:
        for t in tabs:
            if t.get("type") == "page" and url_substring in t.get("url", ""):
                return t
    for t in tabs:
        if t.get("type") == "page" and not t.get("url", "").startswith("devtools://"):
            return t
    return None


def main():
    args = sys.argv[1:]
    world = "main"
    for a in list(args):
        if a.startswith("--world="):
            world = a.split("=", 1)[1]
            args.remove(a)
    if len(args) < 3:
        print(__doc__)
        sys.exit(2)
    port = int(args[0])
    needle = args[1]
    expr = args[2]

    tabs = list_tabs(port)
    tab = pick_tab(tabs, needle)
    if not tab:
        print(json.dumps({"error": "no tab", "tabs": [t.get("url") for t in tabs]}))
        sys.exit(1)

    ws = create_connection(tab["webSocketDebuggerUrl"], timeout=10)
    mid = [0]
    def send(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        return mid[0]

    try:
        send("Runtime.enable")
        contexts = []
        deadline = time.time() + 1.5
        ws.settimeout(0.3)
        while time.time() < deadline:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("method") == "Runtime.executionContextCreated":
                contexts.append(m["params"]["context"])

        ctx_id = None
        if world == "main":
            for c in contexts:
                if (c.get("auxData", {}) or {}).get("isDefault"):
                    ctx_id = c.get("id")
                    break
        elif world == "aes":
            iso = [c for c in contexts if (c.get("auxData", {}) or {}).get("type") == "isolated"]
            fallback_ctx = None
            for c in iso:
                origin = c.get("origin") or ""
                name = c.get("name") or ""
                if fallback_ctx is None and (
                    origin.startswith("chrome-extension://")
                    or "AirlineSim Enhancement Suite" in name
                ):
                    fallback_ctx = c.get("id")
                eid = send("Runtime.evaluate", {
                    "expression": "!!(window.AesSettings || window.AesDataBus || window.AesAfp || window.AesAfpFormDriver || window.RouteAssistantSettings || window.RouteAssistantSilentAutoProposers || window.AESSiteSkin || window.CanvasRailController)",
                    "returnByValue": True,
                    "contextId": c["id"],
                    "timeout": 2000,
                })
                ddl = time.time() + 2.5
                while time.time() < ddl:
                    try:
                        m = json.loads(ws.recv())
                    except Exception:
                        continue
                    if m.get("id") == eid:
                        v = (m.get("result", {}).get("result", {}) or {}).get("value")
                        if v is True:
                            ctx_id = c["id"]
                        break
                if ctx_id is not None:
                    break
            if ctx_id is None:
                ctx_id = fallback_ctx
        elif world.isdigit():
            ctx_id = int(world)

        params = {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True,
            "timeout": 8000,
        }
        if ctx_id is not None:
            params["contextId"] = ctx_id
        eid = send("Runtime.evaluate", params)
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("id") == eid:
                res = m.get("result", {})
                err = res.get("exceptionDetails")
                if err:
                    print(json.dumps({
                        "tab": tab.get("url"),
                        "ctx": ctx_id,
                        "world": world,
                        "error": err.get("text") or (err.get("exception", {}) or {}).get("description"),
                    }))
                    sys.exit(3)
                v = res.get("result", {}).get("value")
                print(json.dumps({"tab": tab.get("url"), "ctx": ctx_id, "world": world, "value": v}))
                return
        print(json.dumps({"error": "timeout", "tab": tab.get("url")}))
        sys.exit(4)
    finally:
        ws.close()


if __name__ == "__main__":
    main()
