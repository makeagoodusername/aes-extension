#!/usr/bin/env python3
"""Orphan-audit — find modules/*.js files NOT registered in manifest content_scripts.

Usage: python3 scripts/audit-orphans.py
"""
import json, glob, os, sys

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
manifest_path = os.path.join(repo, "manifest.json")

manifest = json.load(open(manifest_path))
registered = set()
for cs in manifest.get("content_scripts", []):
    for js in cs.get("js", []):
        registered.add(js)

# bridge.html script tags are loaded by the page itself, not content_scripts
bridge_html_path = os.path.join(repo, "bridge.html")
bridge_loaded = set()
if os.path.exists(bridge_html_path):
    import re
    src = open(bridge_html_path).read()
    for m in re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', src):
        bridge_loaded.add(m.lstrip("./"))

# background.js importScripts() — service worker bootstrap
bg_path = os.path.join(repo, "background.js")
bg_loaded = set()
if os.path.exists(bg_path):
    import re
    src = open(bg_path).read()
    for m in re.findall(r"importScripts\(([^)]*)\)", src):
        for s in re.findall(r'["\']([^"\']+)["\']', m):
            bg_loaded.add(s.lstrip("./"))

all_js = set()
for f in glob.glob(os.path.join(repo, "modules", "**", "*.js"), recursive=True):
    rel = os.path.relpath(f, repo)
    all_js.add(rel)

reachable = registered | bridge_loaded | bg_loaded
orphans = sorted(all_js - reachable)
_root_js = [os.path.relpath(p, repo) for p in glob.glob(os.path.join(repo, "*.js"))]
_known_entry = {"helpers.js", "background.js", "popup.js", "options.js"}
unreachable_root_js = sorted(
    p for p in _root_js if p not in reachable and p not in _known_entry
)

print(f"Total modules/**/*.js:     {len(all_js)}")
print(f"  in manifest content_scripts: {len(registered & all_js)}")
print(f"  in bridge.html script tags: {len(bridge_loaded & all_js)}")
print(f"  in background importScripts: {len(bg_loaded & all_js)}")
print(f"  ORPHANS (in modules/, nowhere reached): {len(orphans)}")
for o in orphans:
    print(f"    {o}")

if unreachable_root_js:
    print()
    print(f"Top-level *.js outside the known entrypoints (helpers/background/popup/options):")
    for o in unreachable_root_js:
        print(f"    {o}")

print()
print(f"Manifest entries that don't exist on disk:")
missing = []
for entry in sorted(registered):
    if not os.path.exists(os.path.join(repo, entry)):
        missing.append(entry)
        print(f"    {entry}")
if not missing:
    print("    (none)")

sys.exit(0 if not orphans and not missing else 1)
