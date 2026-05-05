"use strict"

/**
 * AES Strategy — game-time watcher.
 *
 * Reads the AS bottom footer for the current game-world date+time and
 * persists it. Other modules subscribe to `onRollover(cb)` to fire when
 * the game-day flips. Loaded on every AS page so background tabs can
 * detect rollovers even when the user is on an unrelated screen.
 *
 * AS footer markup (verified on USA Stations.html sample):
 *   <nav class="as-navbar-bottom">
 *     <div class="as-footer-line">
 *       …
 *       <span class="as-footer-line-element">
 *         <span class="fa fa-clock-o"></span>
 *         2026-04-23
 *         20:45 HT
 *       </span>
 *       …
 *
 * The date is `YYYY-MM-DD` and the time `HH:MM HT` (Hub Time). We treat
 * the date as the game-day key — auto-tick fires at most once per game
 * day. The time is captured for diagnostics.
 *
 * Persistence:
 *   aesGameTime:lastSeen → {gameDate, gameTime, seenAt}
 *
 * Public API (window.AesGameTimeWatcher):
 *   .read()              → {gameDate, gameTime} | null  (synchronous DOM read)
 *   .start()             starts the 60s polling loop, returns void
 *   .stop()              stops polling
 *   .onRollover(cb)      cb({prevGameDate, gameDate, gameTime}); returns unsubscribe()
 *   .getLastSeen()       Promise<{gameDate, gameTime, seenAt} | null>
 *
 * Design notes:
 * - DOM-only read; no network. Cheap to poll every 60s.
 * - Multiple subscribers on the same page share one polling loop.
 * - Cross-page rollover detection works because every AS page persists
 *   its observation; the next page's start() compares persisted vs DOM.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesGameTimeWatcher) return

    const KEY        = "aesGameTime:lastSeen"
    const POLL_MS    = 60000
    const DATE_RE    = /(\d{4}-\d{2}-\d{2})/
    const TIME_RE    = /(\d{2}:\d{2})\s*HT/

    let _intervalHandle = null
    const _subscribers  = new Set()

    /**
     * Locate the bottom-bar element carrying a clock icon and parse out
     * the game date and time. Returns null when the footer isn't on the
     * page (some standalone error pages, login flow, etc.).
     */
    function read() {
        if (typeof document === "undefined") return null
        const candidates = document.querySelectorAll(".as-navbar-bottom .as-footer-line-element")
        for (const el of candidates) {
            if (!el.querySelector || !el.querySelector(".fa-clock-o")) continue
            const txt = (el.textContent || "").trim()
            const dateM = DATE_RE.exec(txt)
            if (!dateM) continue
            const timeM = TIME_RE.exec(txt)
            return {
                gameDate: dateM[1],
                gameTime: timeM ? timeM[1] : null
            }
        }
        return null
    }

    async function getLastSeen() {
        try {
            const out = await chrome.storage.local.get([KEY])
            return out[KEY] || null
        } catch (_) { return null }
    }

    async function _writeLastSeen(rec) {
        try { await chrome.storage.local.set({[KEY]: rec}) }
        catch (_) { /* best-effort */ }
    }

    function _emitRollover(payload) {
        for (const cb of _subscribers) {
            try { cb(payload) }
            catch (e) { console.warn("[AES game-time] subscriber threw", e) }
        }
    }

    /**
     * Compare a freshly-read snapshot to the persisted last-seen and
     * fire the rollover callback when the game-date has advanced.
     * Persisting the new value happens regardless — we want every page
     * that sees a newer date to commit it so other tabs catch up on
     * their next start().
     */
    async function _tickPoll() {
        const cur = read()
        if (!cur || !cur.gameDate) return
        const prev = await getLastSeen()
        const prevDate = prev && prev.gameDate || null
        const now = Date.now()
        await _writeLastSeen({
            gameDate: cur.gameDate,
            gameTime: cur.gameTime,
            seenAt:   now
        })
        if (prevDate && prevDate !== cur.gameDate && cur.gameDate > prevDate) {
            _emitRollover({
                prevGameDate: prevDate,
                gameDate:     cur.gameDate,
                gameTime:     cur.gameTime,
                seenAt:       now
            })
        }
    }

    function start() {
        if (_intervalHandle !== null) return
        // Run once immediately so the first observation lands fast — then
        // poll at the standard cadence. Both calls swallow failures so a
        // detached page can't break the loop.
        _tickPoll().catch(e => console.warn("[AES game-time] initial tick failed", e))
        _intervalHandle = setInterval(() => {
            _tickPoll().catch(e => console.warn("[AES game-time] tick failed", e))
        }, POLL_MS)
    }

    function stop() {
        if (_intervalHandle === null) return
        clearInterval(_intervalHandle)
        _intervalHandle = null
    }

    function onRollover(cb) {
        if (typeof cb !== "function") return () => {}
        _subscribers.add(cb)
        return () => _subscribers.delete(cb)
    }

    window.AesGameTimeWatcher = {
        read, start, stop, onRollover, getLastSeen,
        KEY:     KEY,
        POLL_MS: POLL_MS
    }

    // Auto-start on script load — every AS page should be observing.
    // start() is idempotent so duplicate calls are safe.
    try { start() }
    catch (e) { console.warn("[AES game-time] auto-start failed", e) }
})()
