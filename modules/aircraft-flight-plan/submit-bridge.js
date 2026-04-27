"use strict"

/**
 * Background-tab submit bridge for the Schedule Management overlay.
 *
 * The Fleet Hub overlay can't fill or POST AS's New Flight Number form
 * directly — that form only exists on /app/fleets/aircraft/<id>/0. This
 * helper wraps the chrome.runtime message that asks background.js to:
 *   1. Open the AFP page in a hidden background tab.
 *   2. Wait for the AFP content script to signal ready.
 *   3. Send the leg payload to that tab; the content script calls
 *      AesAfpFormDriver.fillAndSubmit(leg).
 *   4. Close the background tab and reply with success/error.
 *
 * Per-aircraft serialisation is enforced by background.js — concurrent
 * Apply clicks queue up rather than racing the same Wicket session.
 *
 * On the AFP page itself the wave-applier's Apply button does NOT call
 * this bridge — it stays on the existing in-page bus path (pre-fill only,
 * user clicks AS Submit). This bridge is only the overlay's escape hatch
 * for triggering the same effect from a different tab.
 */
class AesAfpSubmitBridge {
    static MESSAGE = "aes:afp:submit-leg"
    static DEFAULT_TIMEOUT_MS = 90000

    /**
     * @param {object} args - {server, aircraftId, leg, hub?, timeoutMs?}
     *   leg = {origin, destination, depTimeLocal, pricePct, service}
     * @returns {Promise<{ok:boolean, error?:string, flightNumber?:string}>}
     */
    static submitLegInBackground(args) {
        const a = args || {}
        if (!a.server || !a.aircraftId || !a.leg) {
            return Promise.resolve({ok: false, error: "submit-bridge: missing server / aircraftId / leg"})
        }
        const timeoutMs = a.timeoutMs || AesAfpSubmitBridge.DEFAULT_TIMEOUT_MS

        return new Promise(resolve => {
            let settled = false
            const settle = (v) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(v)
            }
            const timer = setTimeout(() => {
                settle({ok: false, error: "submit-bridge: timed out after " + timeoutMs + "ms"})
            }, timeoutMs)

            try {
                chrome.runtime.sendMessage({
                    type:       AesAfpSubmitBridge.MESSAGE,
                    server:     String(a.server),
                    aircraftId: String(a.aircraftId),
                    hub:        a.hub || null,
                    leg:        a.leg
                }, (resp) => {
                    const lastErr = chrome.runtime.lastError
                    if (lastErr) {
                        settle({ok: false, error: "submit-bridge: " + lastErr.message})
                        return
                    }
                    if (!resp || typeof resp !== "object") {
                        settle({ok: false, error: "submit-bridge: empty response from background"})
                        return
                    }
                    settle(resp)
                })
            } catch (e) {
                settle({ok: false, error: "submit-bridge: " + ((e && e.message) || e)})
            }
        })
    }
}

if (typeof window !== "undefined") {
    window.AesAfpSubmitBridge = AesAfpSubmitBridge
}
