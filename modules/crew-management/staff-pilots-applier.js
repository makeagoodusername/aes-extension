"use strict"

/**
 * Posts hire-or-train requests to /action/enterprise/staffNewPilots.
 *
 * The endpoint is plain form-encoded (not Wicket): no PageExpired check
 * needed. Request body: `skillId=<n>&amount=<n>&educate=<true|false>`,
 * where educate=true means "train new pilots" and educate=false means
 * "hire from job market".
 *
 * Returns an envelope (never throws): {status, error?, httpStatus?}.
 *   status in {"posted", "failed"}
 *   error.code in {"badInput", "fetchFailed", "httpError", "notLoggedIn", "postThrew"}
 */
class CrewMgmtStaffPilotsApplier {
    static LOGIN_RE = /<form[^>]+action=["'][^"']*\/login/i

    async hireOrTrain(opts) {
        const skillId = opts && opts.skillId
        const amount = opts && opts.amount
        const mode = opts && opts.mode
        const server = opts && opts.server

        if (!server) return failed("badInput", "server required")
        if (!skillId) return failed("badInput", "skillId required")
        const amt = parseInt(String(amount), 10)
        if (!Number.isFinite(amt) || amt <= 0) return failed("badInput", "amount must be positive integer")
        if (mode !== "hire" && mode !== "train") return failed("badInput", "mode must be 'hire' or 'train'")

        const body = new URLSearchParams()
        body.set("skillId", String(skillId))
        body.set("amount", String(amt))
        body.set("educate", mode === "train" ? "true" : "false")

        const url = "https://" + server + ".airlinesim.aero/action/enterprise/staffNewPilots"
        let resp
        try {
            resp = await fetch(url, {
                method:      "POST",
                credentials: "include",
                headers:     {"Content-Type": "application/x-www-form-urlencoded"},
                body:        body.toString()
            })
        } catch (e) {
            return failed("postThrew", e && e.message || String(e))
        }
        if (!resp.ok) return failed("httpError", "HTTP " + resp.status, resp.status)
        let text = ""
        try { text = await resp.text() } catch (_) { /* ignore */ }
        if (CrewMgmtStaffPilotsApplier.LOGIN_RE.test(text)) {
            return failed("notLoggedIn", "login redirect", resp.status)
        }
        return {status: "posted", httpStatus: resp.status}
    }
}

function failed(code, message, httpStatus) {
    const out = {status: "failed", error: {code: code, message: message}}
    if (typeof httpStatus === "number") out.httpStatus = httpStatus
    return out
}

if (typeof window !== "undefined") {
    window.CrewMgmtStaffPilotsApplier = CrewMgmtStaffPilotsApplier
}
