import json, os

manifest_path = 'manifest.json'
with open(manifest_path, 'r') as f:
    manifest = json.load(f)

content_scripts = manifest.get('content_scripts', [])

print(f"Total content_scripts blocks: {len(content_scripts)}")

# F-1: settings-bridge.js in blocks 1 and 6
# Note: block indices are usually 0-based in scripts, but let's assume 1-based as per findings if they match.
b1 = content_scripts[0]
b6 = content_scripts[5]

print("\n--- F-1 Check ---")
print(f"Block 1 matches: {b1.get('matches')}")
print(f"settings-bridge.js in Block 1? {'modules/_shared/settings-bridge.js' in b1.get('js', [])}")
print(f"Block 6 matches: {b6.get('matches')}")
print(f"settings-bridge.js in Block 6? {'modules/_shared/settings-bridge.js' in b6.get('js', [])}")

# F-2: schedule-store.js in blocks 19 and 27
b19 = content_scripts[18]
b27 = content_scripts[26]

print("\n--- F-2 Check ---")
print(f"Block 19 matches: {b19.get('matches')}")
print(f"schedule-store.js in Block 19? {'modules/aircraft-flight-plan/schedule-store.js' in b19.get('js', [])}")
print(f"Block 27 matches: {b27.get('matches')}")
print(f"schedule-store.js in Block 27? {'modules/aircraft-flight-plan/schedule-store.js' in b27.get('js', [])}")

# F-3: host.js missing from block 20
b20 = content_scripts[19]
print("\n--- F-3 Check ---")
print(f"Block 20 matches: {b20.get('matches')}")
print(f"host.js in Block 20? {'modules/aircraft-flight-plan/host.js' in b20.get('js', [])}")

# F-4: journal-store.js loads after learn.js in blocks 5 and 27
b5 = content_scripts[4]
print("\n--- F-4 Check ---")
print(f"Block 5 matches: {b5.get('matches')}")
js5 = b5.get('js', [])
try:
    idx_learn5 = js5.index('modules/strategy/learn.js')
    idx_journal5 = js5.index('modules/strategy/journal-store.js')
    print(f"Block 5: learn.js at {idx_learn5}, journal-store.js at {idx_journal5}")
except ValueError as e:
    print(f"Block 5: One or both files missing: {e}")

js27 = b27.get('js', [])
print(f"Block 27 matches: {b27.get('matches')}")
try:
    idx_learn27 = js27.index('modules/strategy/learn.js')
    idx_journal27 = js27.index('modules/strategy/journal-store.js')
    print(f"Block 27: learn.js at {idx_learn27}, journal-store.js at {idx_journal27}")
except ValueError as e:
    print(f"Block 27: One or both files missing: {e}")
