# Route Assistant — Store Index

24 `*-store.js` files live in this module. Most are small, similar in shape, and easy to confuse. This index says what each one owns and whether the new `createPrefixStore` primitive (`modules/_shared/prefix-store.js`) is a viable CRUD substrate for it.

Migration policy: the factory is **opt-in** for stores that already match its shape. Don't force a migration if the domain semantics don't fit — adopt opportunistically, when the store is being changed for another reason.

## Settings

| Store | Owns | Storage | Factory candidate? |
| ----- | ---- | ------- | ------------------ |
| `settings-store.js` | All RA user prefs (filters, scoring, view modes, presets, etc.) | `settings.routeAssistant` (shared blob) + `settings.acct.<id>.routeAssistant` (L2) | No — single blob; pending L2-aware `AesSettings.getAreaScoped` variant. |
| `alert-rules-store.js` | Per-route alert rules + last-fired tracking | L2 namespaced `routeAssistant:alertRules` (legacy + acct) | No — L2-scoped, single blob. |
| `service-config-store.js` | Service-profile config knobs | TBD (read source) | Probably not — config blob. |

## Per-route metadata (one chrome.storage key per route)

| Store | Suffix shape | Storage | Factory candidate? |
| ----- | ------------ | ------- | ------------------ |
| `route-note-store.js` | `<HUB>-<DEST>` | L2 `routeAssistant:routeNote` (legacy + acct) | Partially — domain shape fits, but L2 logic stays hand-rolled. |
| `route-overrides-store.js` | `<HUB>-<DEST>` | L2 namespaced | Same as route-note. |
| `interline-store.js` | `<HUB>-<DEST>` | `routeAssistant:interline:<HUB>-<DEST>` | **Yes** — non-L2; CRUD substrate would replace `_key`/load/save/loadAll. |
| `wave-overrides-store.js` | per-route wave state | L2 namespaced | Partially — same as route-note. |

## Per-airline / per-fleet caches

| Store | Suffix shape | Storage | Factory candidate? |
| ----- | ------------ | ------- | ------------------ |
| `fleet-store.js` | (single blob per server/airline) | `routeAssistant:fleet:<server><airline>` | Probably not — single composite key. |
| `demand-store.js` | per-route demand snapshot | TBD | Likely yes — check shape. |
| `watchlist-store.js` | watchlist routes | L2 namespaced | Same as route-note. |

## Aircraft type / global caches

| Store | Suffix shape | Storage | Factory candidate? | Status |
| ----- | ------------ | ------- | ------------------ | ------ |
| `type-specs-store.js` | `<typeId>` | `routeAssistant:typeSpec:<typeId>` (no L2 — game-physics, server-agnostic) | **Yes** | **Migrated** (proof). |

## Time-series / history

| Store | Suffix shape | Storage | Factory candidate? |
| ----- | ------------ | ------- | ------------------ |
| `status-history-store.js` | per-route status events | L2 namespaced | Probably no — append-only timeline; consider a `createTimelineStore` if a 2nd lands. |
| `yield-history-store.js` | per-route yield observations | L2 namespaced | Same — timeline shape. |
| `rating-observation-store.js` | per-route rating samples | L2 namespaced | Same. |
| `rating-alpha-store.js` | per-route fitted alpha | L2 namespaced | Probably yes for the CRUD substrate. |

## ORS / pricing

| Store | Suffix shape | Storage | Factory candidate? |
| ----- | ------------ | ------- | ------------------ |
| `ors-snapshot-store.js` | per-route ORS snapshot | L2 namespaced | Same as route-note. |
| `sandbox-scenarios-store.js` | named scenarios | L2 namespaced | Same. |
| `sandbox-backtest-store.js` | named backtests | L2 namespaced | Same. |

## Wave subsystem (see also WAVES.md)

| Store | Suffix shape | Storage | Factory candidate? |
| ----- | ------------ | ------- | ------------------ |
| `wave-draft-store.js` | per-route draft | L2 namespaced | Partially. |
| `wave-overrides-store.js` | per-route override | L2 namespaced | Partially. |

---

## Why most stores aren't migrating today

Two recurring obstacles:

1. **L2 account-scoping** (`acctKey` + legacy fallback). Affects 13 of 24 stores. The factory could grow a `scoped: true` mode, but a clean version requires `_shared/account-scoped-key.js` to expose a richer API (legacy + scoped key pair, fallback resolution). Until that exists, account-scoped stores keep their hand-rolled key arithmetic.
2. **Domain validation / normalization**. Most stores apply field-level guards (`_normalisePartner`, `_clean`, range clamps) that are useful enough to keep; the factory only replaces the I/O substrate underneath, not the validation.

The factory is a **CRUD primitive** that domain stores compose with — not a replacement for the domain stores themselves.

## Migration checklist

When a store qualifies (non-L2, simple per-key shape):

1. `const _store = window.createPrefixStore({prefix: <PREFIX>})` — keep PREFIX identical to the legacy constant for byte-compatibility.
2. Replace `_key(...)` + `chrome.storage.local.get([key])` with `_store.get(suffix)`.
3. Replace `chrome.storage.local.set({[_key(id)]: rec})` with `_store.set(suffix, rec)`.
4. Replace `loadAll()` walks with `_store.getAll()`.
5. Replace bulk reads with `_store.bulkGet([...])`.
6. Domain validation, timestamps, `_clean()` helpers stay where they are.
7. Verify `chrome.storage.local` shape is byte-identical pre/post via DevTools.

Migrated stores (so far):
- `type-specs-store.js`
