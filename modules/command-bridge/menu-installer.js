"use strict"

/**
 * Command Bridge slice CB-1 — navbar entry installer.
 *
 * Adds a top-level "BRIDGE" item to the AS navbar, sitting next to the
 * existing AES dropdown. Click sends `aes:bridge:open` to the background
 * service worker, which focuses an existing Bridge tab via
 * chrome.tabs.query (cross-tab dedup) or creates one. The fallback path
 * uses window.open if the message round-trip fails — keeps the click
 * useful even when the SW is restarting.
 *
 * Mirrors aes-menu.js's anchor strategy: insert after the 5th li in
 * the navbar (the AES menu installs at nth-child(5) and inserts after,
 * making itself the 6th; we insert after the AES menu, becoming the
 * 7th li). On a slow page where navbar isn't ready yet, retry briefly.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.__aesBridgeMenuInstalled) return
    window.__aesBridgeMenuInstalled = true

    const MAX_WAIT_MS = 10000
    const POLL_MS = 200
    let waited = 0

    function findAesMenuLi() {
        // The AES dropdown installs itself as a sibling after
        // `.navbar-nav > li:nth-child(5)`. If aes-menu.js has run, the
        // AES dropdown is itself an li with class "dropdown" containing
        // a `.aes-menu__trigger`. Anchor relative to that.
        const trigger = document.querySelector("#as-navbar-main-collapse .navbar-nav .aes-menu__trigger")
        if (trigger) return trigger.closest("li")
        return null
    }

    function tick() {
        if (document.getElementById("aes-bridge-nav-link")) return
        const aesLi = findAesMenuLi()
        if (!aesLi) {
            waited += POLL_MS
            if (waited >= MAX_WAIT_MS) return
            setTimeout(tick, POLL_MS)
            return
        }
        install(aesLi)
    }

    function install(aesLi) {
        const li = document.createElement("li")
        const a = document.createElement("a")
        a.id = "aes-bridge-nav-link"
        a.setAttribute("role", "button")
        a.setAttribute("tabindex", "0")
        a.textContent = "Bridge"
        a.style.cssText = [
            "cursor:pointer",
            "font-family:var(--aes-font-display)",
            "font-weight:var(--aes-fw-display)",
            "text-transform:uppercase",
            "letter-spacing:var(--aes-tracking-caps)",
            "font-size:var(--aes-fs-small)",
            "color:var(--aes-rust)"
        ].join(";")
        a.addEventListener("click", openBridge)
        a.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openBridge() }
        })
        li.appendChild(a)
        aesLi.after(li)
    }

    function openBridge() {
        // CB-3: route through background so all tabs share dedup. The
        // background handler focuses an existing Bridge tab+window or
        // creates a new one. Falls back to window.open() only if the
        // message round-trip fails (extension reload race, MV3 SW asleep
        // and rejecting, etc).
        try {
            chrome.runtime.sendMessage({type: "aes:bridge:open"}, (resp) => {
                const err = chrome.runtime.lastError
                if (err || !resp || !resp.ok) {
                    try { window.open(chrome.runtime.getURL("bridge.html"), "aes-bridge") }
                    catch (_) { /* noop */ }
                }
            })
        } catch (_) {
            try { window.open(chrome.runtime.getURL("bridge.html"), "aes-bridge") }
            catch (__) { /* noop */ }
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", tick, {once: true})
    } else { tick() }
})()
