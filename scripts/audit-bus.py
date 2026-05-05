#!/usr/bin/env python3
"""Bus pathway audit.

For each bus (CentralHubBus, AesDataBus, AesAfp.bus, AesStrategy.bus):
  - emits but no `.on(...)` subscriber  → producer-only (dead emit)
  - .on(...) but no emit                → subscriber-only (dead listener)

Topic-suffix wildcards (`"data:command-palette:" + kind`) are best-effort matched.
"""
import re, glob, os, sys
from collections import defaultdict

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Buses we care about (regex-escaped class accessor)
BUSES = {
    "CentralHubBus":    r"(?:window\.)?CentralHubBus",
    "AesDataBus":       r"(?:window\.)?AesDataBus",
    "AesAfp.bus":       r"(?:(?:window\.)?AesAfp\.bus|ns\.bus)",
    "AesStrategy.bus":  r"(?:window\.)?AesStrategy\.bus",
}

emit_method = r"\.(?:emit|publish)"
on_method = r"\.on"

emits = defaultdict(lambda: defaultdict(list))
ons   = defaultdict(lambda: defaultdict(list))

# Search modules and root .js
files = (
    glob.glob(os.path.join(repo, "modules", "**", "*.js"), recursive=True)
    + glob.glob(os.path.join(repo, "*.js"))
)

# Detect local aliases like `const bus = window.CentralHubBus` → record bus name per file
ALIAS_PATTERNS = [
    (re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:window\.)?(CentralHubBus|AesDataBus|AesAfp\.bus|AesStrategy\.bus)\b"), None),
    # function param patterns rarely catch us; live with that
]

for f in files:
    rel = os.path.relpath(f, repo)
    try:
        src = open(f, encoding="utf-8", errors="replace").read()
    except Exception as e:
        print(f"!! couldn't read {rel}: {e}")
        continue

    # Build alias map for this file
    aliases = {}
    for pat, _ in ALIAS_PATTERNS:
        for m in pat.finditer(src):
            alias_name = m.group(1)
            target = m.group(2)
            target_key = "AesAfp.bus" if "AesAfp" in target else target
            aliases[alias_name] = target_key

    for bus_name, bus_re in BUSES.items():
        # emit / publish — capture quoted topic only (group 1)
        emit_pat = re.compile(rf"{bus_re}{emit_method}\(\s*[\'\"]([^\'\"]+)[\'\"]")
        for m in emit_pat.finditer(src):
            topic = m.group(1)
            emits[bus_name][topic].append(rel)

        # .on — capture quoted topic
        on_pat = re.compile(rf"{bus_re}{on_method}\(\s*[\'\"]([^\'\"]+)[\'\"]")
        for m in on_pat.finditer(src):
            topic = m.group(1)
            ons[bus_name][topic].append(rel)

    # Aliased emit/on
    for alias_name, target_key in aliases.items():
        a = re.escape(alias_name)
        emit_pat = re.compile(rf"\b{a}{emit_method}\(\s*[\'\"]([^\'\"]+)[\'\"]")
        for m in emit_pat.finditer(src):
            emits[target_key][m.group(1)].append(rel + f" (alias {alias_name})")
        on_pat = re.compile(rf"\b{a}{on_method}\(\s*[\'\"]([^\'\"]+)[\'\"]")
        for m in on_pat.finditer(src):
            ons[target_key][m.group(1)].append(rel + f" (alias {alias_name})")

# Subscribe via subscribeBus helper (CentralHubBus tile)
sub_helper = re.compile(r"\bsubscribeBus\(\s*[\'\"]([^\'\"]+)[\'\"]")
for f in files:
    rel = os.path.relpath(f, repo)
    src = open(f, encoding="utf-8", errors="replace").read()
    for m in sub_helper.finditer(src):
        ons["CentralHubBus"][m.group(1)].append(rel + " (subscribeBus)")

# Print findings per bus
for bus_name in BUSES:
    e = emits[bus_name]
    o = ons[bus_name]
    print(f"\n========== {bus_name} ==========")
    print(f"  emitted topics: {len(e)}, on-listened topics: {len(o)}")
    print(f"\n  -- Emitted, no subscriber (DEAD EMIT):")
    for topic in sorted(set(e) - set(o)):
        emitters = sorted(set(e[topic]))
        print(f"    {topic}  ({len(emitters)} emitter(s))")
        for ef in emitters[:3]:
            print(f"      <- {ef}")
        if len(emitters) > 3:
            print(f"      <- ... +{len(emitters)-3} more")
    print(f"\n  -- Subscribed, no emit (DEAD LISTENER):")
    for topic in sorted(set(o) - set(e)):
        subs = sorted(set(o[topic]))
        print(f"    {topic}  ({len(subs)} subscriber(s))")
        for sf in subs[:3]:
            print(f"      <- {sf}")
        if len(subs) > 3:
            print(f"      <- ... +{len(subs)-3} more")

# Cross-bus same-topic check
print("\n\n========== CROSS-BUS DUPLICATES (same topic emitted on >1 bus) ==========")
all_topics = defaultdict(set)
for bus_name in BUSES:
    for topic in emits[bus_name]:
        all_topics[topic].add(bus_name)
for topic in sorted(all_topics):
    if len(all_topics[topic]) > 1:
        print(f"  {topic}  -> {sorted(all_topics[topic])}")

# Suffixed/dynamic emits hint
print("\n\n========== DYNAMIC TOPIC NAMES (emit with non-string-literal) ==========")
dyn_pat = re.compile(r'((?:CentralHubBus|AesDataBus|AesAfp\.bus|AesStrategy\.bus))\.(?:emit|publish)\(\s*([A-Za-z_][\w\.]*\s*\+|`)')
for f in files:
    rel = os.path.relpath(f, repo)
    src = open(f, encoding="utf-8", errors="replace").read()
    for m in dyn_pat.finditer(src):
        line_no = src[:m.start()].count("\n") + 1
        print(f"  {rel}:{line_no}  {m.group(0)[:80]}…")
