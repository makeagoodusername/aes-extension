"use strict"

/**
 * Track 6 slice 6c — content script for /app/com/numbers/* pages.
 *
 * Receives `aes:afp:delete-flight-form` from background.js (the AFP
 * delete-batch pipeline driving a hidden tab) and submits AS's
 * Wicket-mangled delete form for the flight whose detail page we're on.
 *
 * The form's action ends with `-delete~form` (the Wicket session id and
 * component path drift across page loads — verified against captures of
 * flights 9441 and 9437). We anchor the selector on the suffix.
 *
 * Critical safety guard: before submitting we assert that
 * location.pathname === '/app/com/numbers/<flightId>' so a redirected
 * tab (login bounce, 404 → list, session expiry) never silently deletes
 * a different flight than the caller expected.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "aes:afp:delete-flight-form") return false

    const expectedId = msg.flightId != null ? String(msg.flightId) : ""
    if (!expectedId) {
        sendResponse({ok: false, error: "missing flightId"})
        return false
    }

    const expectedPath = "/app/com/numbers/" + expectedId
    if (location.pathname !== expectedPath) {
        sendResponse({
            ok: false,
            error: "wrong page (expected " + expectedPath + ", got " + location.pathname + ")"
        })
        return false
    }

    const form = document.querySelector('form[action$="-delete~form"]')
    if (!form) {
        sendResponse({ok: false, error: "delete form not found"})
        return false
    }

    // Reply BEFORE submitting — the form POST navigates the tab away,
    // and sendResponse on a destroyed page throws. The wrapper try/catch
    // covers that case but firing the reply first is cheaper.
    try { sendResponse({ok: true, posting: true}) }
    catch (_) { /* page may be unloading post-submit */ }

    // Native form submission — no JS-bound handlers on the button per
    // the captures, and form.submit() avoids any onclick that might
    // cancel.
    try { form.submit() }
    catch (e) {
        // We've already replied {ok:true,posting:true}. The background
        // pipeline will time out on _waitForTabComplete and surface that
        // as a flight-level failure.
        console.warn("[AES afp-6c] form.submit() threw", e)
    }

    return false   // response already sent synchronously
})
