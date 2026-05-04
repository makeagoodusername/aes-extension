#!/usr/bin/env python3
"""Login to AS via CDP. Navigates to /auth/login, fills credentials, submits.

Usage:
  python3 cdp-login.py <port> <email> <password>
"""
import sys, json, time
from websocket import create_connection
import urllib.request

def http_put(url):
    return urllib.request.urlopen(urllib.request.Request(url, method='PUT'), timeout=8).read()
def http_post(url):
    return urllib.request.urlopen(urllib.request.Request(url, method='POST'), timeout=5).read()

def login(port, email, password):
    target = json.loads(http_put(f'http://localhost:{port}/json/new?https://www.airlinesim.aero/auth/login'))
    target_id = target['id']
    ws = create_connection(target['webSocketDebuggerUrl'], timeout=20, suppress_origin=True)
    msg_id = 0
    pending = {}
    def send(method, params=None):
        nonlocal msg_id
        msg_id += 1
        ws.send(json.dumps({'id': msg_id, 'method': method, 'params': params or {}}))
        return msg_id

    def wait(predicate, timeout=10):
        end = time.time() + timeout
        ws.settimeout(0.3)
        out = []
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            out.append(m)
            if predicate(m): return out
        return out

    send('Runtime.enable')
    send('Page.enable')
    # Wait for load
    print("Waiting for login page to load...")
    wait(lambda m: m.get('method') == 'Page.loadEventFired', timeout=15)
    time.sleep(2)

    # Find the login form
    eval_id = send('Runtime.evaluate', {
        'expression': '''(function(){
            const forms = Array.from(document.querySelectorAll('form'));
            const out = forms.map(f => ({
                action: f.action,
                method: f.method,
                inputs: Array.from(f.querySelectorAll('input')).map(i => ({name: i.name, type: i.type, id: i.id, placeholder: i.placeholder}))
            }));
            return JSON.stringify({title: document.title, url: location.href, forms: out});
        })()''',
        'returnByValue': True,
    })
    out = wait(lambda m: m.get('id') == eval_id, timeout=5)
    for m in out:
        if m.get('id') == eval_id:
            print('FORM scan:', m.get('result', {}).get('result', {}).get('value'))

    # Fill and submit
    fill_id = send('Runtime.evaluate', {
        'expression': f'''(function(){{
            // Try common AS field names: username/password, email/password, j_username/j_password
            const f = document.querySelector('form');
            if (!f) return 'no-form';
            const u = f.querySelector('input[name="j_username"], input[type="email"], input[name="username"], input[name="email"], input[name="login"]');
            const p = f.querySelector('input[type="password"], input[name="password"], input[name="j_password"]');
            if (!u || !p) return 'fields-missing u='+!!u+' p='+!!p;
            u.value = {json.dumps(email)};
            u.dispatchEvent(new Event('input', {{bubbles: true}}));
            p.value = {json.dumps(password)};
            p.dispatchEvent(new Event('input', {{bubbles: true}}));
            return 'ok';
        }})()''',
        'returnByValue': True,
    })
    out = wait(lambda m: m.get('id') == fill_id, timeout=5)
    for m in out:
        if m.get('id') == fill_id:
            print('FILL:', m.get('result', {}).get('result', {}).get('value'))

    # Submit
    submit_id = send('Runtime.evaluate', {
        'expression': '''(function(){
            const f = document.querySelector('form');
            if (!f) return 'no-form';
            const btn = f.querySelector('button[type="submit"], input[type="submit"]') || f;
            try {
                btn.click ? btn.click() : f.submit();
            } catch (e) { f.submit(); }
            return 'submitted';
        })()''',
        'returnByValue': True,
    })
    wait(lambda m: m.get('id') == submit_id, timeout=5)
    print('SUBMIT clicked')

    # Wait for navigation away
    print("Waiting for post-login navigation...")
    time.sleep(5)
    eval_url = send('Runtime.evaluate', {'expression': 'location.href', 'returnByValue': True})
    out = wait(lambda m: m.get('id') == eval_url, timeout=3)
    for m in out:
        if m.get('id') == eval_url:
            print('Post-login URL:', m.get('result', {}).get('result', {}).get('value'))

    ws.close()
    return target_id

if __name__ == '__main__':
    port = int(sys.argv[1])
    email = sys.argv[2]
    pw = sys.argv[3]
    login(port, email, pw)
