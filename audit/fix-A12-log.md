# Fix-A12 — interline-store account scoping

**File:** `modules/route-assistant/interline-store.js`
**Pattern:** Sibling read-time fallback (matches route-overrides-store, route-note-store).

## Changes
- Added `SCOPE_PREFIX` + `LEGACY_PREFIX`; kept `KEY_PREFIX` for back-compat.
- `_key()` now routes through `acctKey()`; added `_legacyKey()` + `_pairKey()`.
- `load()`, `bulkLoad()`: read namespaced first, fall back to legacy.
- `save()` empty-list path, `clear()`: remove BOTH ns and legacy keys.
- `loadAll()`: dedupes by pair, namespaced wins.
- Skipped one-shot migration shim (not house style).

## Verify
`node --check` — OK.

## Follow-ups
- Add `saveAt(accountId, …)` for Undo parity (siblings expose this).
- Tests: scoped-only / legacy-only / both keys for load + bulkLoad.
