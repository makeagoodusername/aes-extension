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
    # Strip comments (rough; just // and /* */)
    no_block = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    no_line = re.sub(r'//[^\n]*', '', no_block)
    # Look for "if (window.<name>) return" anywhere in first 80 lines
    # OR an IIFE wrap "(function(){...})()" / "(()=>{ ... })()"
    head = '\n'.join(no_line.splitlines()[:120])
    if re.search(r'if\s*\(\s*window\.\w+\s*[!=)]', head) and 'return' in head:
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

# Pairwise: for each block A and each other block B, check if A's URL set ⊆ B's URL set
def block_url_set(block):
    return [matches_urls(m) for m in block.get('matches', [])]

def sample_from_match(pattern):
    """Build a representative URL from a Chrome match pattern.

    This audit used to keep a hand-written block-index → URL table. That
    table drifted every time a content_scripts block was inserted, producing
    false positives for unrelated pages. Generating samples from manifest
    patterns keeps the overlap check tied to the actual manifest shape.
    """
    if pattern == "<all_urls>":
        return "https://x.airlinesim.aero/app/foo"
    scheme = "https://"
    rest = pattern
    if "://" in pattern:
        scheme, rest = pattern.split("://", 1)
        scheme += "://"
    if "/" in rest:
        host, path = rest.split("/", 1)
        path = "/" + path
    else:
        host, path = rest, "/"
    host = host.replace("*.", "x.").replace("*", "x")
    replacements = [
        ("*tab=3", "123?tab=3"),
        ("*", "123"),
    ]
    for old, new in replacements:
        path = path.replace(old, new)
    return scheme + host + path

sample_urls = {
    idx: [sample_from_match(p) for p in block.get("matches", [])]
    for idx, block in enumerate(blocks)
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

print(f"\nUNGUARDED multi-block files (potential page break): {len(unguarded)}")
for i, j, f, _ in sorted(unguarded):
    print(f"  blocks {i:>2}+{j:<2} : {f}")

print(f"\nGUARDED multi-block files: {len(guarded)}")
print(f"\nUnknown (may be safe — no top-level class): {len(unknown)}")
# Optionally print unknown to verify; comment out for brevity
for i, j, f, _ in sorted(unknown)[:30]:
    print(f"  blocks {i:>2}+{j:<2} : {f}")
print(f"  ... and {max(0, len(unknown)-30)} more")
