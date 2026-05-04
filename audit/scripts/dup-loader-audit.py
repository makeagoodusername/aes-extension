#!/usr/bin/env python3
"""For each block pair where one URL pattern is a strict subset of another,
identify overlapping JS files and check whether each has an idempotent guard
(`if (window.X) return` or `if (window.X !== undefined) return`).
"""
import json, os, re, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
os.chdir(REPO)
manifest = json.load(open('manifest.json'))
blocks = manifest['content_scripts']

def pat_to_re(p):
    """Translate a Chrome match pattern to a regex (string)."""
    # https://*.airlinesim.aero/app/com/scheduling*
    p = p.replace('https://', '').replace('http://', '')
    # Now: *.airlinesim.aero/app/com/scheduling*
    # Replace * (host) and * (path) with .*
    return re.sub(r'\*', r'.*', re.escape(p).replace(r'\*', '*'))

def matches_urls(pat):
    """Return a regex that matches URLs against this Chrome pattern."""
    # Strip protocol
    if pat.startswith('https://'):
        rest = pat[8:]
    elif pat.startswith('http://'):
        rest = pat[7:]
    else:
        rest = pat
    # Convert to regex
    parts = rest.split('/', 1)
    host = parts[0]
    path = '/' + parts[1] if len(parts) > 1 else '/'
    # Host: '*.airlinesim.aero' → '[^/]*\.airlinesim\.aero'
    host_re = re.escape(host).replace(r'\*', r'[^/]*')
    # Path: '/app/*' → '/app/.*'
    path_re = re.escape(path).replace(r'\*', r'.*')
    return re.compile('^https?://' + host_re + path_re + '$')

# For each pair of blocks, check if A's pattern set is "covered by" B
# (i.e. every URL matching A also matches B). If yes, A and B fire on the
# same pages. We want to find files in both that lack guards.
def _strip_comments(text):
    no_block = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return re.sub(r'//[^\n]*', '', no_block)

def _executable_lines(no_line):
    out = []
    for line in no_line.splitlines():
        s = line.strip()
        if not s:
            continue
        if s in ('"use strict"', "'use strict'", '"use strict";', "'use strict';"):
            continue
        out.append(line)
    return out

def is_iife_wrapped(no_line):
    lines = _executable_lines(no_line)
    if not lines:
        return False
    first = lines[0].lstrip()
    return bool(re.match(r'^[;!~]?\s*(?:\(\s*)?(?:function\b|\(\s*(?:async\s*)?\(?[\w,\s]*\)?\s*=>)', first))

def has_guard(filepath):
    """Heuristic: file has a top-level if (window.X) return as first executable line, OR
    is wrapped in an IIFE. Return True if guarded, False if a bare top-level class
    or similar.
    """
    if not os.path.exists(filepath):
        return None  # unknown
    try:
        with open(filepath, encoding='utf-8') as fh:
            text = fh.read()
    except Exception:
        return None
    no_line = _strip_comments(text)
    # Look for "if (window.<name>) return" anywhere in first 80 lines
    # OR root/globalThis aliases such as settings-bridge's
    # `if (!root || root.AesSettings) return`.
    head = '\n'.join(no_line.splitlines()[:120])
    if re.search(r'if\s*\(\s*window\.\w+\s*[!=)]', head) and 'return' in head:
        return True
    if re.search(r'if\s*\(\s*!\s*root\s*\|\|\s*root\.\w+\s*\)\s*return\b', head):
        return True
    if re.search(r'if\s*\(\s*root\.\w+\s*[!=)]', head) and 'return' in head:
        return True
    if re.search(r'if\s*\(\s*globalThis\.\w+\s*[!=)]', head) and 'return' in head:
        return True
    if is_iife_wrapped(no_line) and re.search(r'if\s*\([^)]*(?:window|root|globalThis)\.\w+[^)]*\)\s*return\b', head):
        return True
    # Top-level class with no guard immediately
    # Or top-level top window.X = ...; const X = class …; export var X — last is harmless
    # Common pattern: bare `class XxxYyy { ... }` at module top level
    # We use a quick heuristic: presence of `^class \w+` at column 0 within first 30 non-blank-non-comment lines
    cleaned_lines = [l for l in no_line.splitlines() if l.strip()]
    early = '\n'.join(cleaned_lines[:50])
    if re.search(r'^class\s+\w+', early, flags=re.MULTILINE):
        # No guard found, top-level class declaration found
        return False
    # Default: assume guarded (probably safe constant defs, var, etc.)
    return None

GENERIC_HELPER_RE = re.compile(r'^(?:function\s+_(?:text|fmt|num)\b|(?:const|let|var)\s+_(?:text|fmt|num)\s*=)', re.MULTILINE)
TOP_LEVEL_CLASS_RE = re.compile(r'^class\s+\w+', re.MULTILINE)

def static_top_level_violations(filepath):
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, encoding='utf-8') as fh:
            text = fh.read()
    except Exception:
        return []
    no_line = _strip_comments(text)
    if is_iife_wrapped(no_line):
        return []
    violations = []
    if GENERIC_HELPER_RE.search(no_line):
        violations.append("generic top-level helper (_text/_fmt/_num)")
    if TOP_LEVEL_CLASS_RE.search('\n'.join(_executable_lines(no_line)[:80])) and has_guard(filepath) is not True:
        violations.append("unguarded top-level class")
    return violations

# Pairwise: for each block A and each other block B, check if A's URL set ⊆ B's URL set
def block_url_set(block):
    return [matches_urls(m) for m in block.get('matches', [])]

# Sample test URLs for each block
sample_urls = {
    0: ['https://x.airlinesim.aero/app/com/scheduling/JFKLAX', 'https://x.airlinesim.aero/action/foo'],
    1: ['https://x.airlinesim.aero/app/foo', 'https://x.airlinesim.aero/action/foo'],
    2: ['https://x.airlinesim.aero/app/com/inventory/JFKLAX'],
    3: ['https://x.airlinesim.aero/app/info/enterprises/123?tab=3'],
    4: ['https://x.airlinesim.aero/app/enterprise/settings'],
    5: ['https://x.airlinesim.aero/app/enterprise/dashboard'],
    6: ['https://x.airlinesim.aero/app/aircraft/market'],
    7: ['https://x.airlinesim.aero/app/alliance'],
    8: ['https://www.flightsfrom.com/JFK'],
    9: ['https://x.airlinesim.aero/app/com/scheduling'],
    10: ['https://x.airlinesim.aero/app/com/markets/JFKLAX'],
    11: ['https://x.airlinesim.aero/app/com/numbers/123'],
    12: ['https://x.airlinesim.aero/app/info/airports/JFK', 'https://x.airlinesim.aero/app/ops/stations'],
    13: ['https://x.airlinesim.aero/action/enterprise/staffOverview'],
    14: ['https://x.airlinesim.aero/action/enterprise/staffOverview'],
    15: ['https://x.airlinesim.aero/app/enterprise/marketing'],
    16: ['https://x.airlinesim.aero/action/enterprise/staffPilots'],
    17: ['https://x.airlinesim.aero/app/info/enterprises/123'],
    18: ['https://x.airlinesim.aero/action/info/flight'],
    19: ['https://x.airlinesim.aero/app/fleets/aircraft/123/1'],
    20: ['https://x.airlinesim.aero/app/fleets/aircraft/123/0'],
    21: ['https://x.airlinesim.aero/app/fleets/aircraft/123/0'],
    22: ['https://x.airlinesim.aero/app/finance/accounting'],
    23: ['https://x.airlinesim.aero/app/finance/leasing'],
    24: ['https://x.airlinesim.aero/app/finance/capital'],
    25: ['https://x.airlinesim.aero/app/finance/assets'],
    26: ['https://x.airlinesim.aero/action/enterprise/schedule'],
    27: ['https://x.airlinesim.aero/app/fleets'],
    28: ['https://x.airlinesim.aero/app/info/airports/JFK'],
    29: ['https://x.airlinesim.aero/app/info/enterprises/123'],
}

def block_matches_url(block_idx, url):
    res = block_url_set(blocks[block_idx])
    return any(r.match(url) for r in res)

# For each block i, find which other blocks ALSO match its sample URL, then file overlap
print("=== ON-PAGE CO-FIRING BLOCKS (overlap files) ===")
issues = []
for i, urls in sample_urls.items():
    co_fire = set()
    for u in urls:
        for j in range(len(blocks)):
            if i == j: continue
            if block_matches_url(j, u):
                co_fire.add(j)
    # For each co-firing j, compute file overlap
    js_i = set(blocks[i]['js'])
    for j in co_fire:
        js_j = set(blocks[j]['js'])
        common = js_i & js_j
        if common:
            for f in sorted(common):
                guard = has_guard(f)
                tag = 'GUARDED' if guard is True else ('UNGUARDED' if guard is False else 'unknown')
                issues.append((i, j, f, tag))

# Dedup (i,j,f) regardless of order
seen = set()
unique_issues = []
for i, j, f, tag in issues:
    key = (min(i, j), max(i, j), f)
    if key in seen: continue
    seen.add(key)
    unique_issues.append((min(i, j), max(i, j), f, tag))

# Group by tag
unguarded = [x for x in unique_issues if x[3] == 'UNGUARDED']
unknown = [x for x in unique_issues if x[3] == 'unknown']
guarded = [x for x in unique_issues if x[3] == 'GUARDED']
static_violations = []
for _, _, f, _ in unique_issues:
    for reason in static_top_level_violations(f):
        static_violations.append((f, reason))

print(f"\nUNGUARDED multi-block files (potential page break): {len(unguarded)}")
for i, j, f, _ in sorted(unguarded):
    print(f"  blocks {i:>2}+{j:<2} : {f}")

print(f"\nGUARDED multi-block files: {len(guarded)}")
print(f"\nUNKNOWN multi-block files requiring review: {len(unknown)}")
for i, j, f, _ in sorted(unknown)[:30]:
    print(f"  blocks {i:>2}+{j:<2} : {f}")
print(f"  ... and {max(0, len(unknown)-30)} more")

print(f"\nSTATIC top-level exposure violations: {len(static_violations)}")
for f, reason in sorted(static_violations):
    print(f"  {f}: {reason}")

if unguarded or unknown or static_violations:
    sys.exit(1)
