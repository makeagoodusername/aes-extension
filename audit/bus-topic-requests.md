# Bus topic requests
# Agent 6 reads. Other agents append.

---

## 2026-05-04 — Agent 3 — K13 + K15 conductor learning substrate

**Ask:** register the following topics in
`modules/_shared/data-bus-topics.js` so they pass the registry guard:

| Topic                                  | Emitter file                              | Subscribers (today)                                                  |
|----------------------------------------|-------------------------------------------|----------------------------------------------------------------------|
| `data:conductor:baseline:updated`      | modules/conductor/baseline-store.js       | modules/conductor/forecast-store.js (debounced refresh)             |
| `signal:conductor:baseline:tick`       | modules/conductor/baseline-driver.js      | modules/conductor/forecast-store.js                                  |
| `data:conductor:forecast:updated`      | modules/conductor/forecast-store.js       | (none yet — placeholder for K6 tile re-render hook)                  |

Notes:

- `data:conductor:baseline:updated` envelope: `{metric, scope, scopeId, n, mean}`. Debounced 5s after writes inside the store.
- `signal:conductor:baseline:tick` envelope: `{at: epochMs}`. Fired by chrome.alarms once per 24h.
- `data:conductor:forecast:updated` envelope: `{host, count}`. Fired after each `refresh(host)` call.

All three are pure observation broadcasts — no payload is sensitive, no
recipient mutates AS-side state, two-gate model unaffected.

**Blocked work:** if the registry guard rejects these emits (i.e. drops
them silently with a "topic not registered" log), the forecast-store will
still function via the bus listener fall-through, but Agent 6's central
audit will flag them as unregistered emits.

---

## 2026-05-04 — Cross-Territory Integration session — register notifications-api topic

**Ask:** add the following entry to `window.AES_DATA_BUS_TOPICS` in
`modules/_shared/data-bus-topics.js` (sorted into the `-- ui --` group, or
add a new group if none exists):

| Topic                          | Emitter file                                     | Subscribers (today)                          |
|--------------------------------|--------------------------------------------------|----------------------------------------------|
| `data:notifications:posted`    | `modules/_shared/notifications-api.js`           | (none yet — placeholder for audit timeline) |

Suggested entry block:

```javascript
{
    topic:    "data:notifications:posted",
    emittedBy: "modules/_shared/notifications-api.js",
    hint:     "{message: string, type: 'success'|'warning'|'error', ts: number}",
    notes:    "fired on every in-page toast posted via AesNotifications.add(); best-effort emit (try/catch) so a missing bus never breaks the UI feedback path"
}
```

Notes:
- Pure observation broadcast — no payload is sensitive, no recipient is
  expected today. Registered for `auditTopics()` visibility so the data-flow
  inspector sees the topic exists.
- Two-gate model unaffected.

**Blocked work:** none — the emit already runs unguarded; this just keeps
`AesDataBus.auditTopics()` from listing the topic as `discovered` (drift)
once a real subscriber lands.


