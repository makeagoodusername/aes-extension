"use strict"

/**
 * Entry script for the Aircraft Flight Plan Assistant.
 *
 * Mirrors content_aircraftFlights.js:10-16 — wait for the page to load
 * (Wicket renders the sidebar synchronously, but Select2 + a few sidebar
 * widgets attach during onload), then call the foundation slice's
 * mount() once. Re-mount on Wicket sidebar re-renders is handled by the
 * MutationObserver inside host.js; this entry is responsible only for
 * the very first mount per page navigation.
 *
 * Slices B-F register their bus subscribers from THEIR own content
 * scripts; Slice A doesn't import or know about them — the bus is the
 * only contract.
 *
 * Also handles the background-tab submit pipeline: when background.js
 * opens this page in a hidden tab and asks us to submit a leg, we call
 * AesAfpFormDriver.fillAndSubmit() — the only entry point that breaks
 * the no-programmatic-submit invariant. The user-facing fill / Apply
 * paths (toolbar, candidate-selected bus subscriber, wave-applier
 * Apply) still pre-fill only; this listener is unreachable from them.
 */
window.addEventListener("load", () => {
    if (typeof window.AesAfp === "undefined" || typeof window.AesAfp.mount !== "function") {
        console.warn("[AES AFP] host.js did not publish window.AesAfp; skipping mount")
        return
    }
    window.AesAfp.mount().catch((err) => {
        console.error("[AES AFP] mount failed", err)
    })
    // Slice S1 (Track 9) — Flight Studio attaches its bus listeners and
    // performs an initial render once host.js has emitted ctx:ready.
    // Idempotent: the module's own attach() guards re-entry.
    if (window.AesAfpFlightStudio && typeof window.AesAfpFlightStudio.attach === "function") {
        try { window.AesAfpFlightStudio.attach() }
        catch (e) { console.warn("[AES studio] attach threw", e) }
    }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "aes:afp:fill-and-submit") return false
    if (!window.AesAfpFormDriver
            || typeof window.AesAfpFormDriver.fillAndSubmit !== "function") {
        sendResponse({ok: false, error: "AesAfpFormDriver not loaded"})
        return false
    }
    window.AesAfpFormDriver.fillAndSubmit(msg.leg || {}).then(resp => {
        try { sendResponse(resp) } catch (_) { /* page may be unloading post-submit */ }
    }).catch(err => {
        try { sendResponse({ok: false, error: (err && err.message) || String(err)}) }
        catch (_) { /* noop */ }
    })
    return true   // keep the message channel open for the async response
})
