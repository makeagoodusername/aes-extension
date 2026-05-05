"use strict"

/**
 * Command Bridge click repair.
 *
 * The legacy navbar installer adds the Bridge link correctly, but its
 * safeRuntimeSendMessage branch can return before reaching the direct
 * chrome.runtime fallback. This late-loaded repair replaces the link node
 * once it appears, keeping the same visual markup while installing one
 * deterministic click path.
 */
;(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return
    if (window.__aesBridgeMenuSafeInstalled) return
    window.__aesBridgeMenuSafeInstalled = true

    const LINK_ID = "aes-bridge-nav-link"
    const MAX_WAIT_MS = 10000
    const POLL_MS = 200
    let waited = 0

    function tick() {
        const link = document.getElementById(LINK_ID)
        if (!link) {
            waited += POLL_MS
            if (waited < MAX_WAIT_MS) setTimeout(tick, POLL_MS)
            return
        }
        install(link)
    }

    function observeNavbar() {
        const root = document.querySelector("#as-navbar-main-collapse") || document.documentElement
        if (!root || root.__aesBridgeSafeObserver) return
        const observer = new MutationObserver(() => {
            const link = document.getElementById(LINK_ID)
            if (link && link.dataset.aesBridgeSafe !== "1") install(link)
        })
        observer.observe(root, {childList: true, subtree: true})
        root.__aesBridgeSafeObserver = observer
    }

    function install(link) {
        if (link.dataset.aesBridgeSafe === "1") return
        const fixed = link.cloneNode(true)
        fixed.dataset.aesBridgeSafe = "1"
        fixed.addEventListener("click", ev => {
            ev.preventDefault()
            openBridge()
        })
        fixed.addEventListener("keydown", ev => {
            if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault()
                openBridge()
            }
        })
        link.replaceWith(fixed)
    }

    function fallbackOpen() {
        try {
            if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
                window.open(chrome.runtime.getURL("bridge.html"), "aes-bridge")
            }
        } catch (_) { /* noop */ }
    }

    function handleResponse(resp, err) {
        if (err && window.AESSiteSkin?.handleInvalidatedContext
                && window.AESSiteSkin.handleInvalidatedContext(err)) return
        if (err || !resp || !resp.ok) fallbackOpen()
    }

    function openBridge() {
        if (window.AESSiteSkin?.safeRuntimeSendMessage) {
            try {
                const sent = window.AESSiteSkin.safeRuntimeSendMessage(
                    {type: "aes:bridge:open"},
                    handleResponse
                )
                if (sent !== false) return
            } catch (_) {
                /* fall through to direct runtime send */
            }
        }

        try {
            chrome.runtime.sendMessage({type: "aes:bridge:open"}, resp => {
                const lastErr = chrome.runtime.lastError
                handleResponse(resp, lastErr || null)
            })
        } catch (e) {
            handleResponse(null, e)
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            observeNavbar()
            tick()
        }, {once: true})
    } else {
        observeNavbar()
        tick()
    }
})()
