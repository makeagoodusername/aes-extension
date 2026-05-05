#!/usr/bin/env python3
"""Read-only-ish CDP click audit for AES UI surfaces.

The script clicks visible safe buttons/links inside a selector scope and
reports URL changes, DOM changes, dialogs, and console/exception events.
It intentionally skips obvious live-write/destructive controls.

Usage:
  python3 audit/scripts/cdp-click-audit.py <port> <url-substring> [scopeSelector] [maxClicks] [startIndex]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request

from websocket import create_connection


SKIP_RE = (
    "apply", "submit", "delete", "remove", "clear", "reset", "accept",
    "dismiss", "create", "post", "live", "enable", "run silent-auto",
    "run a tick", "scan", "scrape", "sync", "snapshot", "open stations", "confirm",
    "promote", "buy", "bid", "lease", "cancel", "set price",
    "seed all countries", "bulk scrape", "run all cleanups", "automate",
    "save schedule", "open in flight plan", "apply to fleet"
)


def list_targets(port: int) -> list[dict]:
    body = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3).read()
    return json.loads(body)


def pick(port: int, needle: str) -> dict:
    targets = list_targets(port)
    for t in targets:
        if t.get("type") == "page" and needle in t.get("url", ""):
            return t
    for t in targets:
        if t.get("type") == "page" and needle in t.get("title", ""):
            return t
    raise SystemExit(json.dumps({"error": "no matching page", "needle": needle}))


class Cdp:
    def __init__(self, target: dict):
        self.target = target
        self.ws = create_connection(target["webSocketDebuggerUrl"], timeout=10, max_size=64 * 1024 * 1024, suppress_origin=True)
        self.mid = 0
        self.events: list[dict] = []

    def send(self, method: str, params: dict | None = None) -> int:
        self.mid += 1
        msg = {"id": self.mid, "method": method}
        if params is not None:
            msg["params"] = params
        self.ws.send(json.dumps(msg))
        return self.mid

    def wait_id(self, msg_id: int, timeout: float = 8.0) -> dict | None:
        end = time.time() + timeout
        while time.time() < end:
            self.ws.settimeout(min(0.5, max(0.05, end - time.time())))
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            if msg.get("id") == msg_id:
                return msg
            self._event(msg)
        return None

    def drain(self, duration: float = 0.5) -> None:
        end = time.time() + duration
        while time.time() < end:
            self.ws.settimeout(min(0.2, max(0.05, end - time.time())))
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            self._event(msg)

    def _event(self, msg: dict) -> None:
        method = msg.get("method")
        params = msg.get("params", {})
        if method == "Runtime.consoleAPICalled":
            args = []
            for a in params.get("args", []) or []:
                args.append(a.get("value", a.get("description", "")))
            if params.get("type") in ("error", "warning"):
                self.events.append({"kind": "console", "level": params.get("type"), "args": args})
        elif method == "Runtime.exceptionThrown":
            ex = params.get("exceptionDetails", {})
            self.events.append({"kind": "exception", "text": ex.get("text"), "details": ex.get("exception", {}).get("description")})
        elif method == "Log.entryAdded":
            entry = params.get("entry", {})
            if entry.get("level") in ("error", "warning"):
                self.events.append({"kind": "log", "level": entry.get("level"), "text": entry.get("text"), "url": entry.get("url")})

    def eval(self, expr: str, timeout: float = 8.0):
        msg_id = self.send("Runtime.evaluate", {
            "expression": expr,
            "awaitPromise": True,
            "returnByValue": True,
            "timeout": int(timeout * 1000),
        })
        msg = self.wait_id(msg_id, timeout + 2)
        if not msg:
            return {"error": "timeout"}
        res = msg.get("result", {})
        if res.get("exceptionDetails"):
            return {"error": res["exceptionDetails"].get("text")}
        return res.get("result", {}).get("value")

    def click_xy(self, x: float, y: float) -> None:
        for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
            params = {"type": typ, "x": x, "y": y, "button": "left", "clickCount": 1}
            if typ == "mouseMoved":
                params.pop("button")
                params.pop("clickCount")
            self.send("Input.dispatchMouseEvent", params)
        self.drain(0.15)

    def close(self) -> None:
        self.ws.close()


def js_string(value: str) -> str:
    return json.dumps(value)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    port = int(sys.argv[1])
    needle = sys.argv[2]
    scope = sys.argv[3] if len(sys.argv) > 3 else "body"
    max_clicks = int(sys.argv[4]) if len(sys.argv) > 4 else 20
    start_index = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    target = pick(port, needle)
    cdp = Cdp(target)
    try:
        cdp.send("Runtime.enable")
        cdp.send("Log.enable")
        cdp.send("Page.enable")
        cdp.drain(1.0)
        scope_js = js_string(scope)
        before = cdp.eval("({url: location.href, title: document.title, bodyLen: document.body ? document.body.innerText.length : 0})")
        collect_expr = f"""(() => {{
          const scope = document.querySelector({scope_js}) || document.body;
          const nodes = Array.from(scope.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]'));
          const skip = {json.dumps(SKIP_RE)};
          const out = [];
          let idx = 0;
          for (const el of nodes) {{
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width < 3 || r.height < 3 || cs.visibility === 'hidden' || cs.display === 'none') continue;
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.href || '').replace(/\\s+/g, ' ').trim();
            const title = (el.title || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
            const lower = (text + ' ' + title + ' ' + (el.href || '')).toLowerCase();
            const href = el.href || '';
            const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
            const dangerous = disabled || skip.some(s => lower.includes(s));
            el.setAttribute('data-aes-click-audit-idx', String(idx));
            out.push({{
              idx, tag: el.tagName, text: text.slice(0, 90), title: title.slice(0, 120), href: href.slice(0, 160),
              disabled, dangerous,
              x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
            }});
            idx++;
          }}
          return out.slice(0, 80);
        }})()"""
        items = cdp.eval(collect_expr)
        results = []
        if not isinstance(items, list):
            print(json.dumps({"tab": target.get("url"), "scope": scope, "before": before, "error": "collect failed", "raw": items}, indent=2))
            return 1
        clicks_used = 0
        for item in items:
            if item.get("idx", 0) < start_index:
                results.append({**item, "status": "deferred-before-start"})
                continue
            if item.get("dangerous"):
                results.append({**item, "status": "skipped"})
                continue
            if clicks_used >= max_clicks:
                results.append({**item, "status": "deferred-after-budget"})
                continue
            idx = item["idx"]
            locate_expr = f"""(() => {{
              const scope = document.querySelector({scope_js}) || document.body;
              const expected = {json.dumps({"idx": item.get("idx"), "tag": item.get("tag"), "text": item.get("text"), "title": item.get("title"), "href": item.get("href")})};
              const textOf = el => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.href || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
              const titleOf = el => (el.title || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
              const nodes = Array.from(scope.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]'));
              let el = scope.querySelector(`[data-aes-click-audit-idx="${{expected.idx}}"]`);
              if (!el) {{
                el = nodes.find(node => node.tagName === expected.tag && textOf(node) === expected.text && titleOf(node) === expected.title && String(node.href || '').slice(0, 160) === expected.href);
              }}
              if (!el) {{
                el = nodes.find(node => node.tagName === expected.tag && textOf(node) === expected.text);
              }}
              if (!el) return {{error: 'not-found'}};
              el.scrollIntoView({{block: 'center', inline: 'center'}});
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const x = Math.round(r.left + r.width / 2);
              const y = Math.round(r.top + r.height / 2);
              const top = document.elementFromPoint(x, y);
              const covered = top && top !== el && !el.contains(top);
              return {{
                x,
                y,
                width: Math.round(r.width),
                height: Math.round(r.height),
                visible: r.width >= 3 && r.height >= 3 && cs.visibility !== 'hidden' && cs.display !== 'none',
                covered: !!covered,
                coverText: covered ? ((top.innerText || top.getAttribute('aria-label') || top.title || top.tagName || '').replace(/\\s+/g, ' ').trim().slice(0, 80)) : '',
                text: textOf(el),
                title: titleOf(el),
                href: String(el.href || '').slice(0, 160)
              }};
            }})()"""
            located = cdp.eval(locate_expr, timeout=3)
            if not isinstance(located, dict) or located.get("error") or not located.get("visible") or located.get("covered"):
                results.append({**item, "status": "not-found", "located": located})
                continue
            state_before = cdp.eval("""(() => {
              const visible = el => {
                const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
                return r.width >= 3 && r.height >= 3 && cs.visibility !== 'hidden' && cs.display !== 'none';
              };
              return {url: location.href, activeDialogs: Array.from(document.querySelectorAll('[role="dialog"], .modal, [data-aes-modal], #aes-command-palette')).filter(visible).length, bodyLen: document.body.innerText.length};
            })()""")
            event_start = len(cdp.events)
            cdp.click_xy(located["x"], located["y"])
            clicks_used += 1
            cdp.drain(0.8)
            state_after = cdp.eval("""(() => {
              const visible = el => {
                const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
                return r.width >= 3 && r.height >= 3 && cs.visibility !== 'hidden' && cs.display !== 'none';
              };
              return {url: location.href, activeDialogs: Array.from(document.querySelectorAll('[role="dialog"], .modal, [data-aes-modal], #aes-command-palette')).filter(visible).length, bodyLen: document.body.innerText.length};
            })()""")
            new_events = cdp.events[event_start:]
            changed = False
            if isinstance(state_before, dict) and isinstance(state_after, dict):
                changed = state_before.get("url") != state_after.get("url") \
                    or state_before.get("activeDialogs") != state_after.get("activeDialogs") \
                    or abs((state_before.get("bodyLen") or 0) - (state_after.get("bodyLen") or 0)) > 15
            results.append({**item, "status": "clicked", "changed": changed, "located": located, "after": state_after, "events": new_events})
            # Close common overlays so the next button is reachable.
            cdp.eval("""(() => {
              const escDown = new KeyboardEvent('keydown', {key:'Escape', bubbles:true});
              const escUp = new KeyboardEvent('keyup', {key:'Escape', bubbles:true});
              document.dispatchEvent(escDown);
              document.dispatchEvent(escUp);
              const visible = el => {
                const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
                return r.width >= 3 && r.height >= 3 && cs.visibility !== 'hidden' && cs.display !== 'none';
              };
              const overlays = Array.from(document.querySelectorAll('[role="dialog"], .modal, [data-aes-modal], #aes-command-palette')).filter(visible);
              if (!overlays.length) return true;
              const root = overlays[overlays.length - 1];
              const controls = Array.from(root.querySelectorAll('button, [role="button"], a[href], input[type="button"]')).reverse();
              const close = controls.find(el => {
                if (!visible(el)) return false;
                const t = (el.innerText || el.value || el.title || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
                return /^(close|cancel|ok|done|×|✕|x)$/i.test(t) || /close|cancel|esc/i.test(t);
              });
              if (close) close.click();
              return true;
            })()""", timeout=2)
            cdp.drain(0.3)
            # If the click navigated away from the original app page, go back once.
            if isinstance(before, dict) and isinstance(state_after, dict) and state_after.get("url") != before.get("url"):
                cdp.send("Page.navigate", {"url": before["url"]})
                cdp.drain(2.5)
        print(json.dumps({
            "tab": target.get("url"),
            "scope": scope,
            "maxClicks": max_clicks,
            "startIndex": start_index,
            "before": before,
            "items": len(items),
            "clicked": sum(1 for r in results if r.get("status") == "clicked"),
            "skipped": sum(1 for r in results if r.get("status") == "skipped"),
            "deferred": sum(1 for r in results if str(r.get("status", "")).startswith("deferred")),
            "noops": [r for r in results if r.get("status") == "clicked" and not r.get("changed") and not r.get("events")],
            "problems": [r for r in results if r.get("events")],
            "results": results,
        }, indent=2))
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    sys.exit(main())
