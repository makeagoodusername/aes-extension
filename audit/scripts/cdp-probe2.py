#!/usr/bin/env python3
"""CDP probe — enumerate isolated worlds, evaluate in extension's content-script world.

Usage:
  python3 cdp-probe2.py <port> <url> [duration_seconds]
"""
import sys, json, time
from websocket import create_connection
import urllib.request

def http_put(url):
    return urllib.request.urlopen(urllib.request.Request(url, method='PUT'), timeout=5).read()
def http_post(url):
    return urllib.request.urlopen(urllib.request.Request(url, method='POST'), timeout=5).read()

def main():
    port = int(sys.argv[1])
    url = sys.argv[2]
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0

    target = json.loads(http_put(f'http://localhost:{port}/json/new?{url}'))
    target_id = target['id']
    ws = create_connection(target['webSocketDebuggerUrl'], timeout=duration + 2)
    msg_id = 0
    pending = {}
    def send(method, params=None):
        nonlocal msg_id
        msg_id += 1
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        return msg_id

    def recv_until(timeout=1.5):
        end = time.time() + timeout
        out = []
        ws.settimeout(0.3)
        while time.time() < end:
            try:
                raw = ws.recv()
            except Exception:
                continue
            try:
                m = json.loads(raw)
            except Exception:
                continue
            out.append(m)
        return out

    send("Runtime.enable")
    send("Console.enable")
    send("Log.enable")
    send("Page.enable")

    contexts = {}  # id → {name, origin}
    consoleMsgs = []
    exceptions = []

    end = time.time() + duration
    ws.settimeout(0.3)
    while time.time() < end:
        try:
            raw = ws.recv()
        except Exception:
            continue
        try:
            m = json.loads(raw)
        except Exception:
            continue
        method = m.get('method', '')
        if method == 'Runtime.executionContextCreated':
            ctx = m['params']['context']
            contexts[ctx['id']] = {'name': ctx.get('name',''), 'origin': ctx.get('origin', ''), 'auxData': ctx.get('auxData', {})}
        elif method == 'Runtime.consoleAPICalled':
            consoleMsgs.append(m['params'])
        elif method == 'Runtime.exceptionThrown':
            exceptions.append(m['params']['exceptionDetails'])

    print(f"=== {url} (port {port}) — captured {duration}s ===")
    print(f"Execution contexts seen: {len(contexts)}")
    for cid, info in contexts.items():
        print(f"  ctx#{cid}: name={info['name'][:60]} origin={info['origin'][:60]} auxData={info['auxData']}")

    # Find the content-script context — auxData typically has type:'isolated' or name="AES"
    iso_ctx = None
    for cid, info in contexts.items():
        if info['auxData'].get('type') == 'isolated':
            iso_ctx = cid
            break
    if iso_ctx is None:
        # Take any non-default
        for cid, info in contexts.items():
            if not info['auxData'].get('isDefault', False):
                iso_ctx = cid
                break

    print(f"Using isolated ctx: {iso_ctx}")
    if iso_ctx is not None:
        eval_id = send("Runtime.evaluate", {
            "expression": "JSON.stringify({location: location.href, AesSettings: typeof window.AesSettings, AesAfp: typeof window.AesAfp, AesAfp_bus: !!(window.AesAfp && window.AesAfp.bus), AesAfp_handlers: window.AesAfp && window.AesAfp.bus ? Object.keys(window.AesAfp.bus._handlers||{}) : null, AesAfpScheduleStore: typeof window.AesAfpScheduleStore, AesAfpAuditLog: typeof window.AesAfpAuditLog, RouteAssistantPanel: typeof window.RouteAssistantPanel})",
            "contextId": iso_ctx,
            "returnByValue": True,
        })
        responses = recv_until(2.0)
        for r in responses:
            if r.get('id') == eval_id:
                v = r.get('result', {}).get('result', {}).get('value')
                print(f"isolated-world globals: {v}")

    print(f"\nExceptions ({len(exceptions)}):")
    for e in exceptions:
        desc = (e.get('exception', {}).get('description', '') or e.get('text', '')).strip()
        url_e = e.get('url', '')
        ln = e.get('lineNumber', 0)
        print(f"  {desc[:300]}")
        if url_e:
            print(f"     @ {url_e}:{ln}")

    print(f"\nConsole messages ({len(consoleMsgs)}):")
    for c in consoleMsgs:
        kind = c.get('type', 'log')
        args = c.get('args', [])
        vals = [a.get('value', a.get('description', '')) for a in args]
        print(f"  [{kind}] {' '.join(str(v) for v in vals)[:300]}")

    ws.close()
    try: http_post(f'http://localhost:{port}/json/close/{target_id}')
    except: pass

if __name__ == '__main__':
    main()
