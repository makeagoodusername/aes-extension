"use strict"

/**
 * Tab-local pub/sub for cross-module data updates. Loaded into every AS page
 * via the wildcard shared content_scripts block (manifest.json:51-102), so
 * surfaces without their own bus (notably the in-page used-aircraft-scanner
 * panel at /app/aircraft/market) can subscribe to producer-module events
 * without reaching into peer storage.
 *
 * Mirrors the shape of `CentralHubBus` so existing muscle memory carries over.
 *
 *   AesDataBus.on(topic, cb) → off
 *   AesDataBus.off(topic, cb)
 *   AesDataBus.emit(topic, payload)
 *   AesDataBus.publish(topic, value, hint?) → emits AND caches value for last()
 *   AesDataBus.last(topic) → last published value, or undefined
 *   AesDataBus.lastWithMeta(topic) → {value, at, source} | null
 *   AesDataBus.peek(topic, fetcher, opts?) → cached value, or fetcher() result on cold start
 *   AesDataBus.replay(topic?) → last-emitted record (or all-by-topic when omitted)
 *   AesDataBus.bridgeStorage({prefix, topic, single?, makePayload?, extractValue?}) → unbridge
 *   AesDataBus.history({topic?, limit?}) → recent emit records (newest first)
 *   AesDataBus.stats() → [{topic, count, lastAt, hasSubscribers}]
 *   AesDataBus.clearHistory()
 *
 * **Topic grammar.** `data:<module>:<slice>:<verb>` — three colon-segments.
 * Verbs: `saved`, `updated`, `appended`, `cleared`, `migrated`. The
 * canonical list lives in modules/_shared/data-bus-topics.js (read by humans
 * and by the slice-2 dashboard tile; this file does not enforce the names).
 *
 * **Payload contract.** Minimal: `{at, topic, source, ...hint}` — subscribers
 * re-fetch via the producer's existing `get()` rather than consume the
 * payload directly. `at` is the local emit timestamp, `source` is `"local"`
 * (this tab fired) or `"storage"` (chrome.storage.onChanged echo from
 * another tab). `hint` carries small primitives the consumer needs to
 * decide whether to act (a suffix, a count, a scalar).
 *
 * **Cross-tab.** Producer awaits `chrome.storage.local.set(...)` then calls
 * `AesDataBus.emit(topic, hint)`. The originating tab's local subscribers
 * fire immediately (source:"local"). Other tabs' data-buses listen to
 * `chrome.storage.onChanged` and walk a registry of `bridgeStorage` entries
 * — for any change to a key matching a registered prefix/topic, they emit
 * the same topic with source:"storage". The originating tab also sees its
 * own onChanged event, but a 200ms suppress window prevents the duplicate
 * (we already fired source:"local"; remote tabs see source:"storage").
 *
 * **Late mount.** A subscriber that registers AFTER an emit can call
 * `replay(topic)` to read the last-emitted record per topic and warm up.
 *
 * **Value cache (publish/last/peek).** Producers that want consumers to skip a
 * storage round-trip call `publish(topic, value, hint?)` instead of `emit`.
 * The value is stored in a per-topic Map; consumers read it via `last(topic)`
 * (sync, undefined when never published) or `peek(topic, fetcher)` (returns
 * cached value or invokes fetcher on cold start and caches the result).
 * Cross-tab: if a `bridgeStorage` registration carries `extractValue(suffix,
 * newValue, oldValue)`, the storage echo populates `last()` on the receiving
 * tab too — so producers don't have to round-trip through both publish and
 * a bridge. The minimal `{at, topic, source, ...hint}` event payload is
 * unchanged; `last()` is a parallel surface, not a new event shape.
 *
 * **Coalescing.** Writers responsible — do not call `emit` inside tight
 * loops. Storage-echo bridges fire at most once per onChanged batch.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesDataBus) return

    const STORAGE_ECHO_SUPPRESS_MS = 200
    const HISTORY_GLOBAL_MAX       = 500   // total events kept across all topics
    const HISTORY_PER_TOPIC_MAX    = 50    // per-topic ringbuffer for inspector drill-in

    const subs            = new Map()  // topic → Set<cb>
    const lastEmit        = new Map()  // topic → last record
    const lastValue       = new Map()  // topic → {value, at, source}  (publish/extractValue)
    const recentLocalEmit = new Map()  // topic → epoch-ms of last local emit
    const bridges         = []         // [{prefix, topic, makePayload, single, extractValue}]
    const counts          = new Map()  // topic → emit count (lifetime of this tab)
    const historyGlobal   = []         // [record, …]  newest at end
    const historyByTopic  = new Map()  // topic → [record, …]  newest at end

    function on(topic, cb) {
        if (typeof topic !== "string" || !topic) return () => {}
        if (typeof cb    !== "function") return () => {}
        let set = subs.get(topic)
        if (!set) { set = new Set(); subs.set(topic, set) }
        set.add(cb)
        return () => off(topic, cb)
    }

    function off(topic, cb) {
        const set = subs.get(topic)
        if (set) set.delete(cb)
    }

    function dispatch(topic, record) {
        lastEmit.set(topic, record)
        counts.set(topic, (counts.get(topic) || 0) + 1)
        // Append to history ringbuffers — feeds the data-flow inspector tile.
        // Trimmed by length, not by age, so a quiet topic's last events stay
        // visible even if the global ring rolls over.
        historyGlobal.push(record)
        if (historyGlobal.length > HISTORY_GLOBAL_MAX) {
            historyGlobal.splice(0, historyGlobal.length - HISTORY_GLOBAL_MAX)
        }
        let perTopic = historyByTopic.get(topic)
        if (!perTopic) { perTopic = []; historyByTopic.set(topic, perTopic) }
        perTopic.push(record)
        if (perTopic.length > HISTORY_PER_TOPIC_MAX) {
            perTopic.splice(0, perTopic.length - HISTORY_PER_TOPIC_MAX)
        }
        const set = subs.get(topic)
        if (!set || !set.size) return
        // Snapshot the subscriber set — handlers may unsubscribe synchronously.
        const snap = Array.from(set)
        for (const cb of snap) {
            try { cb(record) }
            catch (e) { console.warn("[AES data-bus] handler threw", topic, e) }
        }
    }

    function emit(topic, payload) {
        if (typeof topic !== "string" || !topic) return null
        const record = Object.assign(
            {at: Date.now(), topic: topic, source: "local"},
            payload || {}
        )
        recentLocalEmit.set(topic, record.at)
        dispatch(topic, record)
        return record
    }

    /**
     * Cache `value` under `topic` AND emit a minimal record (for subscribers
     * that don't read last() directly). The value cache is updated BEFORE
     * `recentLocalEmit` so the cross-tab storage-echo suppress window can't
     * race against a co-fired echo.
     */
    function publish(topic, value, hint) {
        if (typeof topic !== "string" || !topic) return null
        const at = Date.now()
        lastValue.set(topic, {value: value, at: at, source: "local"})
        const record = Object.assign(
            {at: at, topic: topic, source: "local"},
            hint || {}
        )
        recentLocalEmit.set(topic, at)
        dispatch(topic, record)
        return record
    }

    function last(topic) {
        const entry = lastValue.get(topic)
        return entry ? entry.value : undefined
    }

    function lastWithMeta(topic) {
        return lastValue.get(topic) || null
    }

    /**
     * Sync read with cold-start fallback. Returns the cached value when present;
     * otherwise calls fetcher() once, caches its (awaited) result, and returns
     * the resolved value (or a Promise if fetcher is async). Mirrors the
     * read-through cache pattern.
     */
    function peek(topic, fetcher, opts) {
        const entry = lastValue.get(topic)
        if (entry) return entry.value
        if (typeof fetcher !== "function") return undefined
        const out = fetcher()
        if (out && typeof out.then === "function") {
            return out.then((v) => {
                if (v !== undefined) {
                    lastValue.set(topic, {value: v, at: Date.now(), source: "peek"})
                }
                return v
            })
        }
        if (out !== undefined) {
            lastValue.set(topic, {value: out, at: Date.now(), source: "peek"})
        }
        return out
    }

    function replay(topic) {
        if (typeof topic === "string") return lastEmit.get(topic) || null
        const out = {}
        for (const [k, v] of lastEmit) out[k] = v
        return out
    }

    function bridgeStorage(opts) {
        if (!opts || !opts.prefix || !opts.topic) {
            throw new Error("AesDataBus.bridgeStorage: {prefix, topic} required")
        }
        const bridge = {
            prefix:       opts.prefix,
            topic:        opts.topic,
            single:       !!opts.single,           // prefix is the FULL key, not a prefix
            makePayload:  opts.makePayload  || null,
            extractValue: opts.extractValue || null  // (suffix, newValue, oldValue) → cached value
        }
        bridges.push(bridge)
        return () => {
            const i = bridges.indexOf(bridge)
            if (i >= 0) bridges.splice(i, 1)
        }
    }

    function onStorageChanged(changes, area) {
        if (area !== "local") return
        if (!bridges.length) return
        const now = Date.now()
        // De-dupe so a bridge whose multiple matching keys appear in one
        // onChanged batch only emits once. Producers that want one event per
        // suffix should use explicit emit; the storage echo is a coarse fallback.
        const fired = new Set()
        for (const key in changes) {
            for (const b of bridges) {
                if (fired.has(b.topic)) continue
                const matches = b.single
                    ? (key === b.prefix)
                    : (key.indexOf(b.prefix) === 0)
                if (!matches) continue
                const lastLocal = recentLocalEmit.get(b.topic) || 0
                if (now - lastLocal < STORAGE_ECHO_SUPPRESS_MS) {
                    fired.add(b.topic)  // suppress the echo for this batch too
                    continue
                }
                const suffix = b.single ? null : key.substring(b.prefix.length)
                let hint = {}
                if (b.makePayload) {
                    try { hint = b.makePayload(suffix, changes[key].newValue, changes[key].oldValue) || {} }
                    catch (e) { console.warn("[AES data-bus] bridge payload threw", b.topic, e) }
                }
                if (b.extractValue) {
                    try {
                        const v = b.extractValue(suffix, changes[key].newValue, changes[key].oldValue)
                        if (v !== undefined) lastValue.set(b.topic, {value: v, at: now, source: "storage"})
                    } catch (e) { console.warn("[AES data-bus] bridge extractValue threw", b.topic, e) }
                }
                const record = Object.assign(
                    {at: now, topic: b.topic, source: "storage", key: key, suffix: suffix},
                    hint
                )
                dispatch(b.topic, record)
                fired.add(b.topic)
            }
        }
    }

    try { chrome.storage.onChanged.addListener(onStorageChanged) }
    catch (_) { /* chrome.storage unavailable in this context — bus stays in-tab only */ }

    function history(opts) {
        const limit = (opts && opts.limit) || 0
        if (opts && typeof opts.topic === "string") {
            const arr = historyByTopic.get(opts.topic) || []
            const slice = limit > 0 ? arr.slice(-limit) : arr.slice()
            return slice.reverse()  // newest first
        }
        const slice = limit > 0 ? historyGlobal.slice(-limit) : historyGlobal.slice()
        return slice.reverse()
    }

    function stats() {
        const out = []
        for (const [topic, count] of counts) {
            const last = lastEmit.get(topic)
            out.push({
                topic:          topic,
                count:          count,
                lastAt:         last ? last.at : null,
                lastSource:     last ? last.source : null,
                hasSubscribers: !!(subs.get(topic) && subs.get(topic).size)
            })
        }
        out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
        return out
    }

    function clearHistory() {
        historyGlobal.length = 0
        historyByTopic.clear()
        // Don't clear counts or lastEmit — those are useful even after a reset.
    }

    window.AesDataBus = {
        on:            on,
        off:           off,
        emit:          emit,
        publish:       publish,
        last:          last,
        lastWithMeta:  lastWithMeta,
        peek:          peek,
        replay:        replay,
        bridgeStorage: bridgeStorage,
        history:       history,
        stats:         stats,
        clearHistory:  clearHistory
    }
})()
