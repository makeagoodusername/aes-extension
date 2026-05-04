#!/usr/bin/env python3
"""Audit `chrome.storage.local.set({settings: ...})` direct writers.

Per HANDOVER §10 + pathway-storage.md H-001, every settings writer MUST
go through `AesSettings.saveArea(<area>, block)` so the tail-Promise
queue can serialize same-tab concurrent writes (F-9223-002).

This script lists every file that still does `chrome.storage.local.set({settings: ...})`
or otherwise spreads `settings` directly. Output buckets by territory agent.
"""
import re, glob, os, sys

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Match `chrome.storage.local.set({settings: ...})` and `chrome.storage.local.set({...settings: ...})`
# We're conservative — we want the actual `settings` key, not nested keys.
patterns = [
    re.compile(r"chrome\.storage\.local\.set\(\s*\{[^}]*\bsettings\s*:", re.S),
    re.compile(r"chrome\.storage\.local\.set\(\s*\{[^}]*\.\.\.settings\b", re.S),
    # Object-shorthand: chrome.storage.local.set({settings})  →  {settings: settings}
    re.compile(r"chrome\.storage\.local\.set\(\s*\{\s*settings\s*\}", re.S),
]

# Exempt list — files that are the legitimate single-writer (saveArea queue) or fixtures
EXEMPT = {
    "modules/_shared/settings-bridge.js",  # this IS saveArea
}

files = (
    glob.glob(os.path.join(repo, "modules", "**", "*.js"), recursive=True)
    + glob.glob(os.path.join(repo, "*.js"))
)

# Territory by file-path prefix (per CLAUDE.md §4 territory matrix)
def territory(rel):
    if rel.startswith("modules/route-assistant/"):                return "Agent 2 (RA)"
    if rel.startswith("modules/strategy/"):                       return "Agent 3 (Strategy)"
    if rel.startswith("modules/conductor/"):                      return "Agent 3 (Conductor)"
    if rel.startswith("modules/canopy/"):                         return "Agent 3 (Canopy)"
    if rel.startswith("modules/alliance/"):                       return "Agent 3 (Alliance)"
    if rel.startswith("modules/aircraft-flight-plan/"):           return "Agent 4 (AFP)"
    if rel.startswith("modules/aircraft-flight-plan-dashboard/"): return "Agent 4 (AFP-D)"
    if rel.startswith("modules/fleet-hub/"):                      return "Agent 4 (FleetHub)"
    if rel.startswith("modules/schedule-management/"):            return "Agent 4 (Sched)"
    if rel.startswith("modules/canvas/"):                         return "Agent 4 (Canvas)"
    if rel.startswith("modules/used-aircraft-scanner/"):          return "Agent 5 (UAS)"
    if rel.startswith("modules/world-view/"):                     return "Agent 5 (WV)"
    if rel.startswith("modules/_shared/"):                        return "Agent 6 (Substrate)"
    if rel.startswith("modules/central-hub/"):                    return "Agent 6 (Hub)"
    if rel.startswith("modules/site-skin/"):                      return "Agent 6 (Skin)"
    if rel.startswith("modules/command-palette/"):                return "Agent 6 (Palette)"
    if rel.startswith("modules/unified-settings/"):               return "Agent 6 (Settings)"
    if rel == "modules/aes-menu.js":                              return "Agent 6 (Menu)"
    if rel.startswith("modules/_background/"):                    return "Agent 7 (BG)"
    if rel.startswith("content_") or rel in {
        "background.js","helpers.js","options.js","popup.js","bridge.html"
    }:                                                            return "Agent 7 (Entry)"
    if rel == "helpers.js":                                       return "Agent 6 (Helpers)"
    return f"?  ({rel})"

violations = {}
for f in files:
    rel = os.path.relpath(f, repo)
    if rel in EXEMPT:
        continue
    try:
        src = open(f, encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    hits = []
    for pat in patterns:
        for m in pat.finditer(src):
            line = src[:m.start()].count("\n") + 1
            snippet = m.group(0).replace("\n", " ")[:120]
            hits.append((line, snippet))
    if hits:
        violations[rel] = hits

print(f"\nFound {sum(len(v) for v in violations.values())} direct `set({{settings: ...}})` calls")
print(f"across {len(violations)} files.\n")

# Group by territory
by_territory = {}
for rel, hits in violations.items():
    by_territory.setdefault(territory(rel), []).append((rel, hits))

for terr in sorted(by_territory):
    print(f"## {terr}")
    for rel, hits in sorted(by_territory[terr]):
        print(f"  {rel}")
        for line, snip in hits:
            print(f"    L{line}: {snip}")
    print()
