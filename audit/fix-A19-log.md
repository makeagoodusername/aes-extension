# Fix A19 — Register orphan emit topics

**Status:** APPLIED

## Change
Added 2 registry entries to `modules/_shared/data-bus-topics.js`:

1. `data:strategy:company-reputation:saved` — emitted at `modules/strategy/company-reputation-store.js:95` (inside `save()`).
2. `fleet-optimizer:target-changed` — emitted at `modules/strategy/fleet-optimizer-settings.js:111,114` (inside `save()`, dual-emit to `CentralHubBus` + `AesStrategy.bus`). Flagged as non-canonical (does not follow `data:<module>:<slice>:<verb>` grammar).

No source files modified — emits already exist.

## Verify
- `node --check data-bus-topics.js` — pass.
- `auditTopics()` drift list should now be clear for these 2.

## Follow-ups (NOT in this pass)
- Wire actual subscribers for both topics (no consumers today).
- Consider renaming `fleet-optimizer:target-changed` to `data:strategy:fleet-optimizer:saved` for grammar conformance.
