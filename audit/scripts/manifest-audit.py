#!/usr/bin/env python3
"""Manifest audit: orphans, duplicates, stale refs.

Outputs:
  TOTAL: count of every .js under modules/, content_*.js, helpers.js, background.js
  REGISTERED: of those, count present in manifest.json content_scripts/background/bridge.html
  ORPHANS: in modules/ but not registered anywhere
  STALE: registered but file missing
"""
import json, os, re, glob, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
os.chdir(REPO)

manifest = json.load(open('manifest.json'))

# --- Collect every registered path (manifest content_scripts + background) ---
manifest_refs = set()
manifest_dups_in_block = []  # (block_idx, path)
for idx, cs in enumerate(manifest.get('content_scripts', [])):
    seen_in_block = set()
    for js in cs.get('js', []):
        if js in seen_in_block:
            manifest_dups_in_block.append((idx, js))
        seen_in_block.add(js)
        manifest_refs.add(js)

bg = manifest.get('background', {})
if 'service_worker' in bg:
    manifest_refs.add(bg['service_worker'])
if 'scripts' in bg:
    for s in bg['scripts']:
        manifest_refs.add(s)

# Web-accessible resources (bridge.html etc.) - record but don't claim coverage
war_paths = set()
for war in manifest.get('web_accessible_resources', []):
    for r in war.get('resources', []):
        war_paths.add(r)

# --- Collect every .js loaded by HTML extension entry points ---
html_refs = set()
html_entrypoints = ['bridge.html']

action_popup = manifest.get('action', {}).get('default_popup')
if action_popup:
    html_entrypoints.append(action_popup)

options_ui = manifest.get('options_ui', {})
if options_ui.get('page'):
    html_entrypoints.append(options_ui['page'])

if manifest.get('options_page'):
    html_entrypoints.append(manifest['options_page'])

for html in sorted(set(html_entrypoints)):
    if os.path.exists(html):
        base = os.path.dirname(html)
        with open(html, encoding='utf-8') as fh:
            for m in re.finditer(r'<script[^>]+src="([^"]+\.js)"', fh.read()):
                src = m.group(1)
                html_refs.add(os.path.normpath(os.path.join(base, src)))

# --- Collect every .js loaded by background.js via importScripts() ---
bg_imports = set()
if os.path.exists('background.js'):
    with open('background.js', encoding='utf-8') as fh:
        text = fh.read()
        for m in re.finditer(r"importScripts\(([^)]+)\)", text):
            inner = m.group(1)
            for s in re.findall(r"['\"]([^'\"]+)['\"]", inner):
                bg_imports.add(s)

# --- Collect every .js file in tree we care about ---
ALL_JS = set()
for f in glob.glob('modules/**/*.js', recursive=True):
    ALL_JS.add(f)
for f in glob.glob('content_*.js'):
    ALL_JS.add(f)
for f in ['helpers.js', 'background.js', 'options.js', 'popup.js']:
    if os.path.exists(f):
        ALL_JS.add(f)

# Vendored jquery is referenced from many places
vendored = set(glob.glob('js/*.js'))
ALL_JS.update(vendored)

print(f"=== MANIFEST AUDIT ===")
print(f"manifest.json content_scripts blocks: {len(manifest.get('content_scripts', []))}")
print(f"manifest.json js entries (sum across blocks, with within-block dups): {sum(len(cs.get('js', [])) for cs in manifest.get('content_scripts', []))}")
print(f"manifest.json unique js paths: {len(manifest_refs)}")
print(f"HTML entrypoint script srcs: {len(html_refs)}")
print(f"background.js importScripts: {len(bg_imports)}")
print(f"")
print(f"=== TREE ===")
print(f"modules/**/*.js: {len(glob.glob('modules/**/*.js', recursive=True))}")
print(f"content_*.js (root): {len(glob.glob('content_*.js'))}")
print(f"total tracked: {len(ALL_JS)}")
print(f"")

# --- Orphans (in tree but not referenced anywhere) ---
referenced = manifest_refs | html_refs | bg_imports
orphans = sorted(ALL_JS - referenced)
print(f"=== ORPHANS (in tree but unreferenced): {len(orphans)} ===")
for o in orphans:
    print(f"  {o}")

# --- Stale (registered but missing on disk) ---
stale = sorted(p for p in referenced if not os.path.exists(p))
print(f"")
print(f"=== STALE (registered but missing on disk): {len(stale)} ===")
for s in stale:
    print(f"  {s}")

# --- In-block duplicates (same path twice in same content_scripts entry) ---
print(f"")
print(f"=== IN-BLOCK DUPLICATES: {len(manifest_dups_in_block)} ===")
for idx, p in manifest_dups_in_block:
    matches = manifest['content_scripts'][idx].get('matches', [])
    print(f"  block {idx} {matches}: {p}")

# --- Cross-block analysis: paths appearing in multiple blocks ---
from collections import defaultdict
path_blocks = defaultdict(list)
for idx, cs in enumerate(manifest.get('content_scripts', [])):
    for js in cs.get('js', []):
        path_blocks[js].append(idx)

# Multiple-block paths
multi_block = {p: idxs for p, idxs in path_blocks.items() if len(set(idxs)) > 1}
print(f"")
print(f"=== PATHS IN MULTIPLE BLOCKS: {len(multi_block)} ===")
# Top 20 by block count
top = sorted(multi_block.items(), key=lambda kv: -len(set(kv[1])))[:20]
for p, idxs in top:
    print(f"  {p}: blocks {sorted(set(idxs))}")
