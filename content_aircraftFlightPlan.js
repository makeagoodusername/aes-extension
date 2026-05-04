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
async function bootAfpAssistant() {
    if (typeof window.AesAfp === "undefined" || typeof window.AesAfp.mount !== "function") {
        console.warn("[AES AFP] host.js did not publish window.AesAfp; skipping mount")
        if (window.AesInit && typeof window.AesInit.record === "function") {
            window.AesInit.record("aircraft-flight-plan.mount", "host.js did not publish window.AesAfp")
        }
        return
    }
    await window.AesAfp.mount()
    // Slice S1 (Track 9) — Flight Studio attaches its bus listeners and
    // performs an initial render once host.js has emitted ctx:ready.
    // Idempotent: the module's own attach() guards re-entry.
    if (window.AesAfpFlightStudio && typeof window.AesAfpFlightStudio.attach === "function") {
        try { window.AesAfpFlightStudio.attach() }
        catch (e) { console.warn("[AES studio] attach threw", e) }
    }
}

AesBoot.register({
    id: "content-aircraft-flight-plan",
    matches: "aircraftFlightPlan",
    deps: [
        function afpHostReady() {
            return !!(window.AesAfp && typeof window.AesAfp.mount === "function")
        }
    ],
    anchors: [
        ".as-page-aircraft .col-md-2"
    ],
    init: bootAfpAssistant
})

window.AesBoot.once("content-aircraft-flight-plan:messages", function registerAfpMessages() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return false
        if (msg.type === "aes:afp:page-context") {
            const ctx = (window.AesAfp && window.AesAfp.ctx) || null
            sendResponse({ok: !!ctx, ctx: ctx})
            return false
        }
        if (msg.type === "aes:afp:verify-created-leg") {
            verifyCreatedLeg(msg.leg || {}).then(resp => {
                try { sendResponse(resp) } catch (_) { /* tab may be closing */ }
            }).catch(err => {
                try { sendResponse({ok: false, error: (err && err.message) || String(err)}) }
                catch (_) { /* noop */ }
            })
            return true
        }
        if (msg.type === "aes:afp:assign-existing-flight") {
            if (!window.AesAfpFormDriver
                    || typeof window.AesAfpFormDriver.assignExistingFlight !== "function") {
                sendResponse({ok: false, error: "AesAfpFormDriver assignment API not loaded"})
                return false
            }
            window.AesAfpFormDriver.assignExistingFlight(msg.leg || {}).then(resp => {
                try { sendResponse(resp) } catch (_) { /* page may be unloading post-submit */ }
            }).catch(err => {
                try { sendResponse({ok: false, error: (err && err.message) || String(err)}) }
                catch (_) { /* noop */ }
            })
            return true
        }
        if (msg.type === "aes:afp:verify-scheduled-flight") {
            if (!window.AesAfpFormDriver
                    || typeof window.AesAfpFormDriver.verifyScheduledFlight !== "function") {
                sendResponse({ok: false, error: "AesAfpFormDriver verification API not loaded"})
                return false
            }
            try {
                sendResponse(window.AesAfpFormDriver.verifyScheduledFlight(msg.leg || {}))
            } catch (err) {
                sendResponse({ok: false, error: (err && err.message) || String(err)})
            }
            return false
        }
        if (msg.type !== "aes:afp:fill-and-submit") return false
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
})

async function verifyCreatedLeg(leg) {
    const wanted = normaliseVerifyLeg(leg)
    if (!wanted.origin || !wanted.destination || !wanted.depTimeLocal) {
        return {ok: false, error: "verify-created-leg: missing origin, destination, or departure", wanted}
    }
    const deadline = Date.now() + 15000
    let lastSchedule = []
    while (Date.now() < deadline) {
        const schedule = readCurrentScheduleForVerify()
        if (Array.isArray(schedule)) {
            lastSchedule = schedule
            const match = schedule.find(row => legMatchesVerify(row, wanted))
            if (match) {
                return {
                    ok: true,
                    wanted,
                    match: summariseVerifyLeg(match),
                    scheduleCount: schedule.length
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    return {
        ok: false,
        error: "created leg not found in visual flight plan after submit",
        wanted,
        scheduleCount: lastSchedule.length,
        sample: lastSchedule.slice(0, 12).map(summariseVerifyLeg)
    }
}

function readCurrentScheduleForVerify() {
    try {
        if (window.AesAfp && typeof window.AesAfp.mount === "function") {
            window.AesAfp.mount().catch(() => {})
        }
    } catch (_) { /* best effort */ }
    try {
        if (window.AesAfp && typeof window.AesAfp.getCurrentSchedule === "function") {
            return window.AesAfp.getCurrentSchedule() || []
        }
    } catch (_) { /* retry until timeout */ }
    return null
}

function normaliseVerifyLeg(leg) {
    const l = leg || {}
    return {
        origin: normaliseVerifyIata(l.origin || l.originIata || l.from || l.fromIata),
        destination: normaliseVerifyIata(l.destination || l.destIata || l.dest || l.to || l.toIata),
        depTimeLocal: normaliseVerifyTime(l.depTimeLocal || l.depTime || l.departureTime)
    }
}

function normaliseVerifyIata(value) {
    const s = String(value || "").trim().toUpperCase()
    return /^[A-Z]{3}$/.test(s) ? s : null
}

function normaliseVerifyTime(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!match) return null
    const h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    if (!(h >= 0 && h <= 23) || !(m >= 0 && m <= 59)) return null
    return (h < 10 ? "0" + h : String(h)) + ":" + (m < 10 ? "0" + m : String(m))
}

function legMatchesVerify(row, wanted) {
    const r = summariseVerifyLeg(row)
    return r.origin === wanted.origin
        && r.destination === wanted.destination
        && r.depTimeLocal === wanted.depTimeLocal
}

function summariseVerifyLeg(row) {
    const r = row || {}
    return {
        origin: normaliseVerifyIata(r.origin || r.originIata || r.from || r.fromIata),
        destination: normaliseVerifyIata(r.destination || r.destIata || r.dest || r.to || r.toIata),
        depTimeLocal: normaliseVerifyTime(r.depTimeLocal || r.depTime || r.departureTime),
        flightNumber: r.flightNumber || r.flightCode || null,
        flightId: r.flightId || null,
        dayName: r.dayName || null
    }
}
