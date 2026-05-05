#!/usr/bin/env python3
"""CDP probe variant that opens a websocket without an Origin header.

Required because the audit Chromes are launched without
`--remote-allow-origins=*`, so the default `Origin: http://localhost:<port>`
header that `websocket-client` sends is rejected with 403. Sending no
Origin header at all is accepted by Chrome and lets us drive CDP normally.

Usage:
  python3 cdp-probe-noorigin.py <port> <url> [duration_seconds]
"""
import sys, json, time, socket, base64, os, struct, urllib.request


def http_put(url):
    return urllib.request.urlopen(urllib.request.Request(url, method='PUT'), timeout=8).read()
def http_post(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, method='POST'), timeout=5).read()
    except Exception:
        pass


class RawWS:
    def __init__(self, ws_url, timeout=5):
        assert ws_url.startswith("ws://")
        host_port, _, path = ws_url[5:].partition('/')
        host, _, port_s = host_port.partition(':')
        path = '/' + path
        self.sock = socket.create_connection((host, int(port_s)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port_s}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        # Drain handshake response
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WS handshake closed early")
            resp += chunk
        if b" 101 " not in resp.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"WS handshake failed: {resp[:120]!r}")
        self._buf = resp.split(b"\r\n\r\n", 1)[1]

    def send_text(self, data: str):
        payload = data.encode("utf-8")
        # Final, text frame
        first = 0x81
        ln = len(payload)
        mask = os.urandom(4)
        if ln < 126:
            header = struct.pack("!BB", first, 0x80 | ln)
        elif ln < 65536:
            header = struct.pack("!BBH", first, 0x80 | 126, ln)
        else:
            header = struct.pack("!BBQ", first, 0x80 | 127, ln)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _recv(self, n):
        out = self._buf[:n]
        self._buf = self._buf[n:]
        while len(out) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WS closed")
            out += chunk
        if len(out) > n:
            self._buf = out[n:] + self._buf
            out = out[:n]
        return out

    def recv_frame(self, timeout=None):
        if timeout is not None:
            self.sock.settimeout(timeout)
        h = self._recv(2)
        b1, b2 = h[0], h[1]
        opcode = b1 & 0x0F
        masked = (b2 & 0x80) != 0
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self._recv(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._recv(8))[0]
        mask = self._recv(4) if masked else b""
        data = self._recv(ln) if ln else b""
        if masked:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return opcode, data

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def main():
    port = int(sys.argv[1])
    url = sys.argv[2]
    duration = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0

    target = json.loads(http_put(f"http://127.0.0.1:{port}/json/new?{url}"))
    target_id = target["id"]
    ws = RawWS(target["webSocketDebuggerUrl"], timeout=duration + 4)
    msg_id = 0

    def send(method, params=None):
        nonlocal msg_id
        msg_id += 1
        ws.send_text(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        return msg_id

    send("Runtime.enable")
    send("Console.enable")
    send("Log.enable")
    send("Page.enable")

    contexts = {}
    consoleMsgs = []
    exceptions = []
    eval_results = {}

    end = time.time() + duration
    while time.time() < end:
        try:
            ws.sock.settimeout(0.4)
            opcode, data = ws.recv_frame(timeout=0.4)
        except socket.timeout:
            continue
        except Exception:
            continue
        if opcode != 0x1:  # not text
            continue
        try:
            m = json.loads(data.decode("utf-8"))
        except Exception:
            continue
        method = m.get("method", "")
        if method == "Runtime.executionContextsCleared":
            contexts.clear()
        elif method == "Runtime.executionContextCreated":
            ctx = m["params"]["context"]
            contexts[ctx["id"]] = {
                "name": ctx.get("name", ""),
                "origin": ctx.get("origin", ""),
                "auxData": ctx.get("auxData", {}),
            }
        elif method == "Runtime.consoleAPICalled":
            consoleMsgs.append(m["params"])
        elif method == "Runtime.exceptionThrown":
            exceptions.append(m["params"]["exceptionDetails"])
        if "id" in m and m["id"] not in (1, 2, 3, 4):
            eval_results[m["id"]] = m

    print(f"=== {url} (port {port}) — captured {duration}s ===")
    print(f"Execution contexts seen: {len(contexts)}")
    for cid, info in contexts.items():
        nm = info["name"][:60]
        og = info["origin"][:60]
        ax = info["auxData"]
        print(f"  ctx#{cid}: name={nm} origin={og} auxData={ax}")

    default_ctx = None
    iso_ctx = None
    for cid, info in contexts.items():
        if info["auxData"].get("isDefault", False):
            default_ctx = cid
        if info["auxData"].get("type") == "isolated":
            iso_ctx = cid
            break
    if iso_ctx is None:
        for cid, info in contexts.items():
            if not info["auxData"].get("isDefault", False):
                iso_ctx = cid
                break
    eval_ctx = iso_ctx if iso_ctx is not None else default_ctx
    print(f"Using isolated ctx: {iso_ctx}")
    print(f"Using eval ctx: {eval_ctx}")

    if eval_ctx is not None:
        eid = send("Runtime.evaluate", {
            "expression": (
                "JSON.stringify({"
                "loc:location.href,"
                "title:document.title,"
                "readyState:document.readyState,"
                "aesMenu:!!document.querySelector('.aes-menu__trigger'),"
                "aesMenuCount:document.querySelectorAll('.aes-menu__trigger').length,"
                "centralHub:!!document.querySelector('#aes-central-hub'),"
                "centralHubRoots:document.querySelectorAll('#aes-central-hub').length,"
                "centralHubTiles:document.querySelectorAll('#aes-central-hub .aes-central-hub-tile').length,"
                "centralHubUniqueTileIds:Array.from(new Set(Array.from(document.querySelectorAll('#aes-central-hub .aes-central-hub-tile')).map(function(el){return el.dataset.tileId||el.id||''}).filter(Boolean))).length,"
                "centralHubDuplicateTileIds:(function(){var c={};Array.from(document.querySelectorAll('#aes-central-hub .aes-central-hub-tile')).forEach(function(el){var id=el.dataset.tileId||el.id||''; if(id)c[id]=(c[id]||0)+1});return Object.keys(c).filter(function(id){return c[id]>1})})(),"
                "bridgeRoot:!!document.querySelector('#aes-command-bridge, .aes-bridge'),"
                "optionsRoot:!!document.querySelector('#options, .aes-options'),"
                "AesSettings:typeof window.AesSettings,"
                "AESTokens:typeof window.AESTokens,"
                "CentralHubBus:typeof window.CentralHubBus,"
                "CentralHubShell:typeof window.CentralHubShell,"
                "AesAfp:typeof window.AesAfp,"
                "AesAfp_bus:!!(window.AesAfp&&window.AesAfp.bus),"
                "AesAfp_handlers:window.AesAfp&&window.AesAfp.bus?Object.keys(window.AesAfp.bus._handlers||{}):null,"
                "AesAfpScheduleStore:typeof window.AesAfpScheduleStore,"
                "AesAfpAuditLog:typeof window.AesAfpAuditLog,"
                "AesAfpSpecResolver:typeof window.AesAfpSpecResolver,"
                "AesAfpFormDriver:typeof window.AesAfpFormDriver,"
                "AesAfpRouteCands:typeof window.AesAfpRouteCandidates,"
                "AesAfpWaveApplier:typeof window.AesAfpWaveApplier,"
                "AesStrategyJournal:typeof window.AesStrategyJournal,"
                "AesStrategyLearn:typeof window.AesStrategyLearn,"
                "AesStrategyApply:!!(window.AesStrategy&&typeof window.AesStrategy.apply==='function'),"
                "AesStrategyApplyPipeline:typeof window.AesStrategyApplyPipeline"
                "})"
            ),
            "contextId": eval_ctx,
            "returnByValue": True,
        })
        # Wait briefly for response
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if eid in eval_results:
                break
            try:
                ws.sock.settimeout(0.3)
                opcode, data = ws.recv_frame(timeout=0.3)
                if opcode != 0x1:
                    continue
                m = json.loads(data.decode("utf-8"))
                if "id" in m:
                    eval_results[m["id"]] = m
                if m.get("method") == "Runtime.exceptionThrown":
                    exceptions.append(m["params"]["exceptionDetails"])
            except Exception:
                continue
        if eid in eval_results:
            v = eval_results[eid].get("result", {}).get("result", {}).get("value")
            print(f"eval globals: {v}")
        else:
            print("eval timed out")

    print(f"\nExceptions ({len(exceptions)}):")
    for e in exceptions[:30]:
        desc = (e.get("exception", {}).get("description") or e.get("text", "")).strip()
        url_e = e.get("url", "")
        ln = e.get("lineNumber", 0)
        first = desc.splitlines()[0] if desc else ""
        print(f"  {first[:240]}")
        if url_e:
            print(f"     @ {url_e}:{ln}")

    print(f"\nConsole messages ({len(consoleMsgs)}):")
    for c in consoleMsgs[:30]:
        kind = c.get("type", "log")
        args = c.get("args", [])
        vals = [a.get("value", a.get("description", "")) for a in args]
        print(f"  [{kind}] {' '.join(str(v) for v in vals)[:240]}")

    ws.close()
    http_post(f"http://127.0.0.1:{port}/json/close/{target_id}")


if __name__ == "__main__":
    main()
