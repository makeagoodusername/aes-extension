# AGENT-1.md — Manifest, Load Order, Module Reachability

You own the **manifest layer**. You touch `manifest.json` and may produce small audit helpers under `modules/_shared/manifest-audit/`. You don't touch business logic.

## Why this is its own territory

The handover documents repeated incidents where modules were committed but not registered, registered in the wrong load order, or registered twice. The "Manifest wiring overhaul" closed 19 wiring gaps across 533 files. This is a chronic failure mode and benefits from one focused agent.

## Your Chrome instance

Use yours mostly for: opening DevTools on AS pages and confirming modules load (`window.AesXyz` returns truthy at the right pages). You don't need to log in for most of your work — manifest validation is mostly static. But when you suspect a load-order issue, having a live Chrome to check `console.log` order at IIFE init time is the fastest way to verify.

## Your scope

1. **Module reachability audit.** For each `.js` under `modules/`:
   - Referenced in `manifest.json` `content_scripts`?
   - Referenced by `bridge.html` or `background.js` `importScripts`?
   - Or orphan?
   Build a table in `audit/findings-AGENT-1.md`. Cross-reference against HANDOVER's claimed 0 orphans — verify.

2. **Load-order audit.** For every IIFE doing `if (typeof X !== "undefined")` against another module's namespace, verify that module loads first in the same content-script block. Out-of-order loads are findings.

3. **Per-block deduplication audit.** For each `content_scripts` entry, check for duplicate `.js` paths. HANDOVER documents 66 idempotent duplicates between AFP and `/app/fleets*` blocks; verify the count and that every duplicate has `if (window.X) return` at module top.

4. **Cross-block dedup.** Some modules MUST appear in multiple blocks (wave-overlay on scheduling+fleets). Others must NOT (`state-store.js` on AFP-zero-tab, since already on `/app/fleets*` per HANDOVER §10). Verify against the invariant list.

5. **Permissions audit.** Manifest declares: `storage`, `tabs`, `unlimitedStorage`, `notifications`, `alarms`, plus `host_permissions`. Verify each has at least one consumer; flag unused.

## Priority order for fixes

1. **Orphans that are referenced** — files other modules try to use but never load. Silent feature breakages. **Fix by adding to manifest.**
2. **Duplicates without idempotency guards** — throw on second load. **Fix by removing duplicate** (or request guard from owning agent via findings).
3. **Wrong load order** — module A loads before module B, but A subscribes to B's bus on init. **Fix by reordering within block.**
4. **Stale references** — manifest entries pointing at deleted files. **Remove.**
5. **Unused permissions** — flag, don't remove without confirmation.

## Tools

```bash
# Sanity
python3 -c "import json; m=json.load(open('manifest.json')); print(len(m['content_scripts']))"
find modules -name '*.js' | wc -l
grep -c '"js":' manifest.json
```

For orphan detection, build `audit/scripts/manifest-audit.py`:
```python
import json, glob, os
repo = "."
manifest = json.load(open(os.path.join(repo, 'manifest.json')))
registered = set()
for cs in manifest.get('content_scripts', []):
    for js in cs.get('js', []):
        registered.add(js)
all_js = set()
for f in glob.glob(os.path.join(repo, 'modules', '**', '*.js'), recursive=True):
    all_js.add(os.path.relpath(f, repo))
orphans = sorted(all_js - registered)
print(f"Total: {len(all_js)}, Registered: {len(registered & all_js)}, Orphans: {len(orphans)}")
for o in orphans: print(f"  {o}")
```

## Multi-instance notes

You don't need a SHARED-NOTES lock for anything you do — your work is read-only against AS. Other agents may be running live tests; their Chrome behavior is independent of your manifest changes until they reload the extension.

**However**, when you commit a manifest change, every other agent's Chrome will get it on their next extension reload. Coordinate timing: announce in SHARED-NOTES when you've pushed a manifest change so other agents know to reload before continuing live verification.

## Forbidden

- Editing any `.js` file inside `modules/`.
- Adding new content-script blocks for new URL match patterns without a SHARED-NOTES heads-up first.
- Renaming files (path-prefix rules in CLAUDE.md depend on current names).

## Inputs from other agents

Watch `audit/manifest-requests.md`. Format:

```
## REQ-N — added by Agent K

File: modules/xxx/yyy.js
Block: /app/com/scheduling*
Load after: zzz.js
Reason: yyy.js subscribes to zzz.js's bus topic at IIFE load
```

Batch once per hour.

## Smoke test before each commit

```bash
python3 -c "import json; json.load(open('manifest.json'))"
node -e "console.log('manifest size:', require('fs').statSync('manifest.json').size)"
```

## End-of-session deliverable

`audit/findings-AGENT-1.md`:

- Total `.js` in `modules/` vs total registered.
- Orphans with classification (referenced vs unreferenced).
- Duplicates with classification (intentional vs accidental).
- Load-order fixes applied.
- Final manifest entry count.
- Manifest-requests batched and applied.
