#!/usr/bin/env python3
"""Connect to Chrome via CDP, navigate to a URL, capture console + exceptions
for ~5 seconds, then close tab. Print every console + exception.

Usage:
  python3 cdp-probe.py <port> <url>
  python3 cdp-probe.py 9227 'https://www.airlinesim.aero/app/aircraft/market'
"""
import sys, json, threading, time
try:
    from websocket import create_connection
except ImportError:
    print("ERROR: pip install websocket-client", file=sys.stderr)
    sys.exit(2)
import urllib.request

def http_get(url):
    return urllib.request.urlopen(url, timeout=5).read()

def http_put(url):
    req = urllib.request.Request(url, method='PUT')
    return urllib.request.urlopen(req, timeout=5).read()

def http_post(url):
    req = urllib.request.Request(url, method='POST')
    return urllib.request.urlopen(req, timeout=5).read()

def open_tab(port, target_url):
    body = http_put(f'http://localhost:{port}/json/new?{target_url}')
    return json.loads(body)

def close_tab(port, target_id):
    try:
        http_post(f'http://localhost:{port}/json/close/{target_id}')
    except Exception:
        pass

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    port = int(sys.argv[1])
    url = sys.argv[2]
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0

    target = open_tab(port, url)
    ws_url = target['webSocketDebuggerUrl']
    target_id = target['id']

    try:
        ws = create_connection(ws_url, timeout=duration + 2)
        # Subscribe to console + exception events
        msg_id = 0
        def send(method, params=None):
            nonlocal msg_id
            msg_id += 1
            ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
            return msg_id

        send("Runtime.enable")
        send("Console.enable")
        send("Log.enable")
        send("Page.enable")

        results = []
        start = time.time()
        ws.settimeout(0.5)
        while time.time() - start < duration:
            try:
                raw = ws.recv()
            except Exception:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            method = msg.get('method', '')
            if method == 'Runtime.consoleAPICalled':
                args = msg['params'].get('args', [])
                vals = [a.get('value', a.get('description', a.get('preview', ''))) for a in args]
                results.append(('console.' + msg['params'].get('type', 'log'), ' '.join(str(v) for v in vals)))
            elif method == 'Runtime.exceptionThrown':
                ex = msg['params'].get('exceptionDetails', {})
                desc = ex.get('exception', {}).get('description', '') or ex.get('text', '')
                lineCol = f" at {ex.get('url','')}:{ex.get('lineNumber',0)}:{ex.get('columnNumber',0)}"
                results.append(('exception', (desc + lineCol).strip()))
            elif method == 'Log.entryAdded':
                e = msg['params'].get('entry', {})
                results.append(('log.' + e.get('level', 'info'), e.get('text', '') + ' @ ' + e.get('url', '')))

        # Also get final URL + dump window globals of interest
        send("Runtime.evaluate", {
            "expression": "JSON.stringify({url: location.href, ttl: typeof window.AesSettings, afpBus: !!(window.AesAfp && window.AesAfp.bus), afpHandlers: window.AesAfp && window.AesAfp.bus && Object.keys(window.AesAfp.bus._handlers||{}), schedStore: typeof window.AesAfpScheduleStore})",
            "returnByValue": True,
        })
        # Wait briefly for response
        deadline = time.time() + 1.5
        while time.time() < deadline:
            try:
                raw = ws.recv()
                msg = json.loads(raw)
                if 'result' in msg and msg.get('result', {}).get('result', {}).get('value') is not None:
                    val = msg['result']['result']['value']
                    results.append(('eval', val))
            except Exception:
                break

        ws.close()
    finally:
        close_tab(port, target_id)

    print(f"=== {url} (port {port}) — {duration}s ===")
    for kind, msg in results:
        print(f"  [{kind}] {str(msg)[:300]}")

if __name__ == '__main__':
    main()
