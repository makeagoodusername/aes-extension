#!/usr/bin/env python3
"""CDP verification driver for the live extension on a Chrome instance.

Subcommands:
  tabs <port>                                  list pages + service workers
  pick <port> <substr>                         resolve substring to a tab id
  eval <port> <substr> <expr>                  Runtime.evaluate, returnByValue+awaitPromise
  reload <port> <substr> [bypassCache]         Page.reload + wait for load event
  nav   <port> <substr> <url>                  Page.navigate + wait for load event
  watch <port> <substr> <durationSec>          capture console/exceptions for N seconds
  shot  <port> <substr> <outpath> [fullpage]   PNG screenshot (default viewport)
  ext-reload <port>                            Runtime.evaluate('chrome.runtime.reload()') on the service worker

The picker matches first by URL substring on type==page; falls back to
service_worker; then to any non-devtools target. All output is JSON on stdout.
Errors: non-zero exit + JSON {"error": ...}.
"""
from __future__ import annotations
import json
import sys
import time
import urllib.request

try:
    from websocket import create_connection
except ImportError:
    print(json.dumps({"error": "pip install websocket-client"}), file=sys.stderr)
    sys.exit(2)


def list_targets(port: int) -> list[dict]:
    body = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read()
    return json.loads(body)


def pick(port: int, needle: str) -> dict:
    targets = list_targets(port)
    if needle:
        # Prefer pages with URL match
        for t in targets:
            if t.get("type") == "page" and needle in t.get("url", ""):
                return t
        for t in targets:
            if t.get("type") == "page" and needle in t.get("title", ""):
                return t
        # Fall back to any target whose url/title contains the needle
        for t in targets:
            if needle in t.get("url", "") or needle in t.get("title", ""):
                return t
    for t in targets:
        if t.get("type") == "page" and not t.get("url", "").startswith("devtools://"):
            return t
    raise SystemExit(json.dumps({"error": "no matching target", "targets": [(t.get("type"), t.get("url"), t.get("title")) for t in targets]}))


def open_ws(target: dict):
    return create_connection(target["webSocketDebuggerUrl"], timeout=10, max_size=64 * 1024 * 1024, suppress_origin=True)


def send_recv(ws, mid: int, method: str, params: dict | None = None, deadline_sec: float = 10.0):
    msg = {"id": mid, "method": method}
    if params is not None:
        msg["params"] = params
    ws.send(json.dumps(msg))
    deadline = time.time() + deadline_sec
    while time.time() < deadline:
        ws.settimeout(min(2.0, deadline - time.time() + 0.1))
        try:
            raw = ws.recv()
        except Exception:
            continue
        m = json.loads(raw)
        if m.get("id") == mid:
            return m
    raise TimeoutError(f"{method} timed out after {deadline_sec}s")


def cmd_tabs(port: int):
    print(json.dumps(list_targets(port), indent=2))


def cmd_pick(port: int, needle: str):
    print(json.dumps(pick(port, needle), indent=2))


def _discover_iso_context(ws, target_url: str | None = None) -> int | None:
    """Enumerate all execution contexts via Runtime.enable, then probe each
    chrome-extension isolated world for the richest AES surface. Returns the
    contextId where page-specific helpers are defined; falls back to the
    highest-id isolated context if none answer the probe.

    The page can host multiple isolated worlds when manifest declares several
    content_scripts blocks against the same URL.
    """
    ws.send(json.dumps({"id": 100, "method": "Runtime.enable"}))
    deadline = time.time() + 3.0
    iso_ctxs: list[int] = []
    while time.time() < deadline:
        ws.settimeout(min(0.5, max(0.05, deadline - time.time())))
        try:
            raw = ws.recv()
        except Exception:
            continue
        m = json.loads(raw)
        if m.get("method") == "Runtime.executionContextCreated":
            ctx = m.get("params", {}).get("context", {})
            aux = ctx.get("auxData") or {}
            origin = ctx.get("origin", "")
            if aux.get("type") == "isolated" and origin.startswith("chrome-extension://"):
                iso_ctxs.append(ctx.get("id"))
    if not iso_ctxs:
        return None
    # Probe each and prefer the richest AES content-script world. Some pages
    # receive several isolated worlds from different manifest blocks; the
    # shared settings world is not always the world that owns page-specific
    # helpers such as Inventory's analysis/apply functions.
    probes = [
        "typeof getPricingInventoryKey === 'function' && typeof getInventoryQuickPriceGate === 'function'",
        "typeof analysis !== 'undefined' && typeof getAnalysis === 'function'",
        "typeof window.CentralInventoryQuickPriceApplier === 'function'",
        "typeof window.AesSettings === 'function' || typeof AesSettings === 'function'",
    ]
    for cid in sorted(iso_ctxs, reverse=True):
        for idx, probe in enumerate(probes):
            probe_id = 2000 + (cid * 10) + idx
            ws.send(json.dumps({
                "id": probe_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": probe,
                    "returnByValue": True,
                    "contextId": cid,
                },
            }))
            deadline2 = time.time() + 2.0
            while time.time() < deadline2:
                ws.settimeout(0.5)
                try:
                    raw = ws.recv()
                except Exception:
                    continue
                m = json.loads(raw)
                if m.get("id") == probe_id:
                    v = m.get("result", {}).get("result", {}).get("value")
                    if v:
                        return cid
                    break
    # Fallback: highest id
    return max(iso_ctxs)


def cmd_eval(port: int, needle: str, expr: str, world: str = "main"):
    target = pick(port, needle)
    ws = open_ws(target)
    try:
        params = {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True,
            "timeout": 8000,
        }
        if world == "iso":
            ctx_id = _discover_iso_context(ws)
            if ctx_id is None:
                print(json.dumps({"tab": target.get("url"), "error": "no isolated chrome-extension context found"}))
                sys.exit(3)
            params["contextId"] = ctx_id
        m = send_recv(ws, 1, "Runtime.evaluate", params, deadline_sec=12.0)
        res = m.get("result", {})
        err = res.get("exceptionDetails")
        if err:
            print(json.dumps({"tab": target.get("url"), "error": err.get("text") or err.get("exception", {}).get("description")}))
            sys.exit(3)
        v = res.get("result", {}).get("value")
        print(json.dumps({"tab": target.get("url"), "world": world, "value": v}, default=str))
    finally:
        ws.close()


def cmd_reload(port: int, needle: str, bypass: bool = False):
    target = pick(port, needle)
    ws = open_ws(target)
    try:
        send_recv(ws, 1, "Page.enable", deadline_sec=4.0)
        send_recv(ws, 2, "Page.reload", {"ignoreCache": bypass}, deadline_sec=4.0)
        # Wait for Page.loadEventFired
        deadline = time.time() + 30
        while time.time() < deadline:
            ws.settimeout(2.0)
            try:
                raw = ws.recv()
            except Exception:
                continue
            m = json.loads(raw)
            if m.get("method") == "Page.loadEventFired":
                print(json.dumps({"tab": target.get("url"), "loaded": True, "tAt": m.get("params", {}).get("timestamp")}))
                return
        print(json.dumps({"tab": target.get("url"), "loaded": False, "error": "no loadEventFired in 30s"}))
        sys.exit(4)
    finally:
        ws.close()


def cmd_nav(port: int, needle: str, url: str):
    target = pick(port, needle)
    ws = open_ws(target)
    try:
        send_recv(ws, 1, "Page.enable", deadline_sec=4.0)
        send_recv(ws, 2, "Page.navigate", {"url": url}, deadline_sec=4.0)
        deadline = time.time() + 30
        while time.time() < deadline:
            ws.settimeout(2.0)
            try:
                raw = ws.recv()
            except Exception:
                continue
            m = json.loads(raw)
            if m.get("method") == "Page.loadEventFired":
                print(json.dumps({"tab": target.get("url"), "navigated_to": url, "loaded": True}))
                return
        print(json.dumps({"tab": target.get("url"), "navigated_to": url, "loaded": False}))
    finally:
        ws.close()


def cmd_watch(port: int, needle: str, duration_sec: float):
    """Capture Runtime.consoleAPICalled + Runtime.exceptionThrown for duration."""
    target = pick(port, needle)
    ws = open_ws(target)
    events = []
    try:
        send_recv(ws, 1, "Runtime.enable", deadline_sec=4.0)
        send_recv(ws, 2, "Log.enable", deadline_sec=4.0)
        deadline = time.time() + duration_sec
        while time.time() < deadline:
            ws.settimeout(min(1.0, max(0.05, deadline - time.time())))
            try:
                raw = ws.recv()
            except Exception:
                continue
            m = json.loads(raw)
            method = m.get("method")
            params = m.get("params", {})
            if method == "Runtime.consoleAPICalled":
                args = []
                for a in params.get("args", []) or []:
                    if "value" in a:
                        args.append(a["value"])
                    elif "description" in a:
                        args.append(a["description"])
                    else:
                        args.append(a.get("type"))
                events.append({"kind": "console", "level": params.get("type"), "args": args, "url": (params.get("stackTrace", {}).get("callFrames") or [{}])[0].get("url")})
            elif method == "Runtime.exceptionThrown":
                ex = params.get("exceptionDetails", {})
                events.append({"kind": "exception", "text": ex.get("text"), "exception": (ex.get("exception") or {}).get("description") or (ex.get("exception") or {}).get("value"), "url": ex.get("url"), "lineNumber": ex.get("lineNumber"), "columnNumber": ex.get("columnNumber")})
            elif method == "Log.entryAdded":
                e = params.get("entry", {})
                events.append({"kind": "log", "level": e.get("level"), "source": e.get("source"), "text": e.get("text"), "url": e.get("url")})
        print(json.dumps({"tab": target.get("url"), "duration": duration_sec, "events": events}, default=str))
    finally:
        ws.close()


def cmd_shot(port: int, needle: str, outpath: str, fullpage: bool = False):
    import base64
    target = pick(port, needle)
    ws = open_ws(target)
    try:
        send_recv(ws, 1, "Page.enable", deadline_sec=4.0)
        params = {"format": "png"}
        if fullpage:
            params["captureBeyondViewport"] = True
        m = send_recv(ws, 2, "Page.captureScreenshot", params, deadline_sec=20.0)
        data = m.get("result", {}).get("data")
        if not data:
            print(json.dumps({"error": "no data", "raw": m}))
            sys.exit(5)
        with open(outpath, "wb") as f:
            f.write(base64.b64decode(data))
        print(json.dumps({"tab": target.get("url"), "out": outpath, "bytes": len(data)}))
    finally:
        ws.close()


def cmd_ext_reload(port: int):
    """Find the extension service worker and call chrome.runtime.reload()."""
    targets = list_targets(port)
    sw = next((t for t in targets if t.get("type") == "service_worker" and "chrome-extension://" in t.get("url", "")), None)
    if not sw:
        print(json.dumps({"error": "no service worker", "targets": [(t.get("type"), t.get("url")) for t in targets]}))
        sys.exit(6)
    ws = open_ws(sw)
    try:
        # chrome.runtime.reload() never resolves (worker dies first). Use a one-shot eval without awaitPromise.
        send_recv(ws, 1, "Runtime.enable", deadline_sec=4.0)
        try:
            send_recv(ws, 2, "Runtime.evaluate", {
                "expression": "chrome.runtime.reload(); 'reloading'",
                "returnByValue": True,
                "awaitPromise": False,
                "timeout": 1500,
            }, deadline_sec=4.0)
        except TimeoutError:
            pass  # SW dies, expected
        print(json.dumps({"sw": sw.get("url"), "status": "reload-fired"}))
    except Exception as e:
        print(json.dumps({"sw": sw.get("url"), "status": "fired-with-error", "error": str(e)}))
    finally:
        try:
            ws.close()
        except Exception:
            pass


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "tabs":
        cmd_tabs(int(args[0]))
    elif cmd == "pick":
        cmd_pick(int(args[0]), args[1] if len(args) > 1 else "")
    elif cmd == "eval":
        cmd_eval(int(args[0]), args[1], args[2])
    elif cmd == "eval-iso":
        cmd_eval(int(args[0]), args[1], args[2], world="iso")
    elif cmd == "reload":
        cmd_reload(int(args[0]), args[1], bypass=(len(args) > 2 and args[2] in ("1", "true", "bypassCache")))
    elif cmd == "nav":
        cmd_nav(int(args[0]), args[1], args[2])
    elif cmd == "watch":
        cmd_watch(int(args[0]), args[1], float(args[2]))
    elif cmd == "shot":
        cmd_shot(int(args[0]), args[1], args[2], fullpage=(len(args) > 3 and args[3] in ("1", "true", "fullpage")))
    elif cmd == "ext-reload":
        cmd_ext_reload(int(args[0]))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
