"use strict"

/**
 * Central Hub bootstrap. Mounts on /app/enterprise/dashboard*.
 *
 * Slice CH-1 is additive: the hub renders directly above the AS dashboard's
 * #enterprise-dashboard anchor, while the legacy content_dashboard.js still
 * runs and renders its dropdown below. The legacy script is removed during
 * the CH-4 cutover.
 *
 * Idempotent: if a hub element is already in the DOM, this no-ops.
 */
;(function () {
    if (typeof window === "undefined") return
    // Subframes never host the hub. AS dashboard pages contain iframes that
    // match the same content-script pattern; without this skip, the IIFE
    // (and its mount path) re-fires per frame and the user sees N stacked
    // hub roots in the top frame's DOM after subframe scripts inherit it.
    if (window.top !== window) return
    if (window.__aesCentralHubMounted) return
    window.__aesCentralHubMounted = true

    const MAX_WAIT_MS = 15000
    const POLL_MS = 200
    let waited = 0

    function record(label, err) {
        if (window.AesInit && typeof window.AesInit.record === "function") {
            window.AesInit.record(label, err)
        }
    }

    function findAnchor() {
        return document.getElementById("enterprise-dashboard")
            || document.querySelector(".as-page-dashboard")
            || document.querySelector("#main-content > .row")
            || document.querySelector("#main-content")
    }

    function resolveContext() {
        let server = ""
        let airline = ""
        try { server = AES.getServerName() } catch (_) { /* noop */ }
        try {
            const code = AES.getAirlineCode()
            airline = (code && code.code) || ""
        } catch (_) { /* fall through */ }
        if (!airline) {
            try { airline = AES.getAirlineIdentity() || "" } catch (_) { /* noop */ }
        }
        return {server, airline}
    }

    function mountIfReady() {
        if (document.getElementById("aes-central-hub")) return true
        const anchor = findAnchor()
        if (!anchor) return false
        if (typeof window.CentralHubShell !== "function") {
            console.warn("[AES Hub] CentralHubShell not loaded — check manifest order")
            record("dashboard.hub.shell", "CentralHubShell not loaded")
            return true
        }
        const {server, airline} = resolveContext()
        const shell = new window.CentralHubShell({server, airline})
        shell.mount(anchor).catch(err => {
            console.warn("[AES Hub] shell mount failed", err)
            record("dashboard.hub.mount", err)
        })
        window.__aesCentralHub = shell
        return true
    }

    function tick() {
        const run = function () {
            if (mountIfReady()) return
            waited += POLL_MS
            if (waited >= MAX_WAIT_MS) {
                console.warn("[AES Hub] anchor not found after", MAX_WAIT_MS, "ms; giving up")
                record("dashboard.hub.anchor", "anchor not found after " + MAX_WAIT_MS + "ms")
                return
            }
            setTimeout(tick, POLL_MS)
        }
        if (window.AesInit && typeof window.AesInit.safe === "function") {
            window.AesInit.safe("dashboard.hub.tick", run)
        } else {
            try { run() }
            catch (err) {
                console.warn("[AES Hub] boot tick failed", err)
            }
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", tick, {once: true})
    } else {
        tick()
    }
})()
