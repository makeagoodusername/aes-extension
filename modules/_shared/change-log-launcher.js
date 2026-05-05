"use strict"

/**
 * Floating change-log launcher — mounts a small 📜 button in the bottom-
 * right corner of every AS page so the unified change log is one click
 * away regardless of which page the user is on.
 *
 * Self-installing: this script attaches itself when the document is ready
 * and registers a single chrome.storage.onChanged listener so the badge
 * count tracks new applies in real time.
 *
 * Coexists with the RA panel's 📜 header button (panel.js): both call
 * `window.AesChangeLogModal.open()`. On the scheduling page the user has
 * two equivalent entry points; everywhere else, only this floating button.
 *
 * Visual contract: anchored bottom-right, offset above the toast-host so
 * the two don't overlap. Idempotent — running the IIFE twice is a no-op.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof document === "undefined") return
    if (window.AesChangeLogLauncher) return

    const MOUNT_ID = "aes-change-log-launcher"
    // Position: anchored to the LEFT edge so we don't fight the RA panel,
    // toast host, or any other right-anchored AS UI. Offset 18px left, 80px
    // up — clears the AS page's bottom chrome on every route. z-index 10001
    // sits one above the RA panel (9999) so the launcher remains clickable
    // even when the panel is open and tall.
    const CSS_TEXT = `
        #${MOUNT_ID} {
            position: fixed;
            left: 18px;
            bottom: 80px;
            z-index: 10001;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: rgba(15, 22, 35, 0.92);
            color: #cbd5e1;
            border: 1px solid rgba(56, 189, 248, 0.40);
            border-radius: 999px;
            font: 11px/1 sans-serif;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.30);
            user-select: none;
            transition: background 0.15s, color 0.15s, transform 0.15s;
        }
        #${MOUNT_ID}:hover {
            background: rgba(15, 22, 35, 1);
            color: #7dd3fc;
            border-color: #38bdf8;
            transform: translateY(-1px);
        }
        #${MOUNT_ID}[hidden] { display: none !important; }
        #${MOUNT_ID} .glyph { font-size: 14px; line-height: 1; }
        #${MOUNT_ID} .label { font-weight: 500; letter-spacing: 0.02em; }
        #${MOUNT_ID} .count {
            background: #38bdf8;
            color: #0f1623;
            border-radius: 8px;
            padding: 0 5px;
            font-size: 9px;
            font-weight: 700;
            min-width: 14px;
            text-align: center;
        }
        #${MOUNT_ID} .count[data-empty="1"] { display: none; }

        .aes-cl-peek {
            position: fixed;
            z-index: 10002;
            background: rgba(15, 22, 35, 0.97);
            color: #cbd5e1;
            border: 1px solid rgba(56, 189, 248, 0.45);
            border-radius: 6px;
            font: 11px/1.4 sans-serif;
            padding: 0 0 4px 0;
            min-width: 300px;
            max-width: 380px;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        }
        .aes-cl-peek-header {
            color: #7dd3fc;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            padding: 6px 12px 5px;
            border-bottom: 1px solid rgba(31, 41, 55, 0.6);
        }
        .aes-cl-peek-body { padding: 4px 0; }
        .aes-cl-peek-row {
            display: flex;
            gap: 8px;
            align-items: center;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 11px;
        }
        .aes-cl-peek-row:hover { background: rgba(56, 189, 248, 0.10); }
        .aes-cl-peek-domain { flex-shrink: 0; width: 18px; text-align: center; font-size: 13px; }
        .aes-cl-peek-scope { font-family: monospace; color: #e2e8f0; flex-shrink: 0; min-width: 80px; font-size: 10px; }
        .aes-cl-peek-summary { color: #cbd5e1; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .aes-cl-peek-time { color: #6b7280; flex-shrink: 0; font-size: 10px; font-variant-numeric: tabular-nums; }
        .aes-cl-peek-empty { color: #94a3b8; padding: 10px 12px; text-align: center; font-size: 11px; }
        .aes-cl-peek-loading { color: #64748b; padding: 10px 12px; text-align: center; font-size: 11px; }
        .aes-cl-peek-footer {
            border-top: 1px solid rgba(31, 41, 55, 0.6);
            padding: 5px 12px;
            color: #64748b;
            font-size: 10px;
            text-align: center;
            margin-top: 2px;
        }

        @media (hover: none) { .aes-cl-peek { display: none !important; } }
    `

    let recentCount = 0
    let recentSince = 0
    let storageListener = null
    let countTimer = null

    let peekEl = null
    let peekShowTimer = null
    let peekHideTimer = null

    const DOMAIN_GLYPHS = {
        "pricing":         "💲",
        "service-profile": "🍽",
        "flight-numbers":  "🔢",
        "strategy":        "🎯",
        "auto-scheduler":  "🛫",
        "afp-audit":       "📋"
    }

    function formatPeekScope(e) {
        const s = (e && e.scope) || {}
        if (s.hub && s.dest) return s.hub + "→" + s.dest
        if (s.tail) return s.tail
        if (s.profileId != null) return "p" + s.profileId
        if (s.planId) return "plan " + String(s.planId).slice(0, 6)
        return "—"
    }

    function formatPeekAgo(ts) {
        if (!ts) return ""
        const sec = Math.floor((Date.now() - ts) / 1000)
        if (sec < 60)    return sec + "s"
        if (sec < 3600)  return Math.floor(sec / 60)   + "m"
        if (sec < 86400) return Math.floor(sec / 3600) + "h"
        return Math.floor(sec / 86400) + "d"
    }

    function onPeekRowClick(entry) {
        if (!window.AesChangeLogModal || typeof window.AesChangeLogModal.open !== "function") return
        const opts = {}
        if (entry && entry.domain) opts.initialDomains = [entry.domain]
        const s = (entry && entry.scope) || {}
        if (s.hub && s.dest) opts.initialSearch = s.hub + "-" + s.dest
        else if (s.tail)     opts.initialSearch = String(s.tail)
        window.AesChangeLogModal.open(opts)
        hidePeek(true)
        recentSince = Date.now()
        recentCount = 0
        refreshBadge()
    }

    async function loadPeekRows() {
        if (!window.AesChangeLogAggregator) return null
        try {
            return await window.AesChangeLogAggregator.loadAll({
                sinceMs: 0,
                domains: window.AesChangeLogAggregator.DOMAINS,
                limit:   5
            })
        } catch (_) { return null }
    }

    function renderPeekBody(wrap, list) {
        const body = wrap.querySelector(".aes-cl-peek-body")
        if (!body) return
        body.textContent = ""
        if (list === null) {
            const empty = document.createElement("div")
            empty.className = "aes-cl-peek-empty"
            empty.textContent = "Aggregator not loaded — reload the extension."
            body.append(empty)
            return
        }
        if (!list.length) {
            const empty = document.createElement("div")
            empty.className = "aes-cl-peek-empty"
            empty.textContent = "No applies yet — pipeline ready."
            body.append(empty)
            return
        }
        for (const e of list) {
            const row = document.createElement("div")
            row.className = "aes-cl-peek-row"
            const domain = document.createElement("span")
            domain.className = "aes-cl-peek-domain"
            domain.textContent = DOMAIN_GLYPHS[e.domain] || "•"
            const scope = document.createElement("span")
            scope.className = "aes-cl-peek-scope"
            scope.textContent = formatPeekScope(e)
            const summary = document.createElement("span")
            summary.className = "aes-cl-peek-summary"
            summary.textContent = e.summary || ""
            if (e.reason) summary.title = e.reason
            const time = document.createElement("span")
            time.className = "aes-cl-peek-time"
            time.textContent = formatPeekAgo(e.ts)
            time.title = new Date(e.ts || 0).toLocaleString()
            row.append(domain, scope, summary, time)
            row.addEventListener("click", (ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                onPeekRowClick(e)
            })
            body.append(row)
        }
    }

    function buildPeek() {
        const wrap = document.createElement("div")
        wrap.className = "aes-cl-peek"
        const head = document.createElement("div")
        head.className = "aes-cl-peek-header"
        head.textContent = "Recent activity"
        wrap.append(head)
        const body = document.createElement("div")
        body.className = "aes-cl-peek-body"
        const loading = document.createElement("div")
        loading.className = "aes-cl-peek-loading"
        loading.textContent = "Loading…"
        body.append(loading)
        wrap.append(body)
        const foot = document.createElement("div")
        foot.className = "aes-cl-peek-footer"
        foot.textContent = "Click any row · Click launcher for full log"
        wrap.append(foot)
        wrap.addEventListener("mouseenter", () => {
            clearTimeout(peekHideTimer)
            peekHideTimer = null
        })
        wrap.addEventListener("mouseleave", () => hidePeek(false))
        return wrap
    }

    function showPeek() {
        clearTimeout(peekHideTimer)
        peekHideTimer = null
        if (peekEl) return
        clearTimeout(peekShowTimer)
        peekShowTimer = setTimeout(async () => {
            peekShowTimer = null
            if (window.AesChangeLogModal && typeof window.AesChangeLogModal.isOpen === "function"
                && window.AesChangeLogModal.isOpen()) return
            peekEl = buildPeek()
            document.body.append(peekEl)
            const btn = document.getElementById(MOUNT_ID)
            if (btn) {
                const r = btn.getBoundingClientRect()
                peekEl.style.left = r.left + "px"
                peekEl.style.bottom = (window.innerHeight - r.top + 6) + "px"
            }
            const list = await loadPeekRows()
            if (peekEl) renderPeekBody(peekEl, list)
        }, 300)
    }

    function hidePeek(immediate) {
        clearTimeout(peekShowTimer)
        peekShowTimer = null
        if (!peekEl) return
        const dismiss = () => {
            peekHideTimer = null
            if (peekEl && peekEl.parentNode) peekEl.parentNode.removeChild(peekEl)
            peekEl = null
        }
        if (immediate) { dismiss(); return }
        clearTimeout(peekHideTimer)
        peekHideTimer = setTimeout(dismiss, 200)
    }

    function ensureStyle() {
        if (document.getElementById(MOUNT_ID + "-style")) return
        const s = document.createElement("style")
        s.id = MOUNT_ID + "-style"
        s.textContent = CSS_TEXT
        document.head.append(s)
    }

    function buildButton() {
        const btn = document.createElement("button")
        btn.id = MOUNT_ID
        btn.type = "button"
        btn.title = "Change log — every applied change across pricing, service, schedules, strategy. Click to open."
        const glyph = document.createElement("span")
        glyph.className = "glyph"
        glyph.textContent = "📜"
        const label = document.createElement("span")
        label.className = "label"
        label.textContent = "Change log"
        const count = document.createElement("span")
        count.className = "count"
        count.dataset.empty = "1"
        count.textContent = "0"
        btn.append(glyph, label, count)
        btn.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            hidePeek(true)
            if (window.AesChangeLogModal && typeof window.AesChangeLogModal.open === "function") {
                window.AesChangeLogModal.open()
                // Opening the modal is the user's "I've seen the activity"
                // signal — reset the badge counter.
                recentSince = Date.now()
                recentCount = 0
                refreshBadge()
            } else {
                console.warn("[AES change-log] modal module not loaded")
            }
        })
        btn.addEventListener("mouseenter", showPeek)
        btn.addEventListener("mouseleave", () => hidePeek(false))
        return btn
    }

    function refreshBadge() {
        const btn = document.getElementById(MOUNT_ID)
        if (!btn) return
        const c = btn.querySelector(".count")
        if (!c) return
        if (recentCount > 0) {
            c.dataset.empty = "0"
            c.textContent = recentCount > 99 ? "99+" : String(recentCount)
        } else {
            c.dataset.empty = "1"
            c.textContent = "0"
        }
    }

    /**
     * Recount how many entries have landed since `recentSince` by reading
     * the aggregator. Throttled so a burst of writes doesn't spam reads.
     * If the aggregator isn't loaded on this page (legacy bundle), the
     * badge silently stays at 0 — the launcher itself still works.
     */
    function scheduleRecount() {
        clearTimeout(countTimer)
        countTimer = setTimeout(async () => {
            if (!window.AesChangeLogAggregator) return
            try {
                const list = await window.AesChangeLogAggregator.loadAll({
                    sinceMs: recentSince || (Date.now() - 24 * 3600 * 1000),
                    limit:   200
                })
                recentCount = list.length
                refreshBadge()
            } catch (_) { /* non-fatal */ }
        }, 400)
    }

    function attachStorageListener() {
        if (storageListener) return
        if (!window.AesChangeLogAggregator) return
        const sourceKeys = window.AesChangeLogAggregator.SOURCE_KEYS || []
        const sourceKeySet = new Set(sourceKeys)
        storageListener = (changes, area) => {
            if (area !== "local") return
            for (const k in changes) {
                if (sourceKeySet.has(k)) { scheduleRecount(); return }
                for (const sk of sourceKeys) {
                    if (k.startsWith(sk + ":")) { scheduleRecount(); return }
                }
            }
        }
        if (chrome && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(storageListener)
        }
    }

    function mount() {
        if (document.getElementById(MOUNT_ID)) return
        ensureStyle()
        const btn = buildButton()
        document.body.append(btn)
        // Start the badge counter from the moment the launcher mounts —
        // anything older than this isn't "new since the user opened the
        // page" and shouldn't decorate the badge.
        recentSince = Date.now()
        attachStorageListener()
    }

    function start() {
        if (!document.body) {
            // document_end run_at default is fine but extension-injected
            // scripts can occasionally fire before body is parsed; defer.
            window.addEventListener("DOMContentLoaded", start, {once: true})
            return
        }
        mount()
    }

    window.AesChangeLogLauncher = {
        mount, start,
        get count() { return recentCount }
    }

    start()
})()
