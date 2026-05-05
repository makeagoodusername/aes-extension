"use strict"

/**
 * Route Launcher — submit dispatcher.
 *
 * Wraps AesAfpSubmitBridge.submitLegInBackground() and turns one click
 * into a tracked log entry. Per-aircraft serialization is enforced by
 * background.js (`_afpEnqueueSubmit`); this module only tracks UI-side
 * status + writes one log record per submission.
 *
 * One bounded retry on transient errors (timeout, fetch fail, login).
 * Hard failures (form-not-found, missing destination) surface immediately.
 *
 * No singleton — one dispatcher per controller instance is fine.
 */
class AesRouteLauncherDispatcher {
    static TRANSIENT_RE = /(timed out|timeout|fetch|HTTP 5\d\d|notLoggedIn|page expired|PageExpired)/i
    static DEFAULT_TIMEOUT_MS = 90000

    constructor(opts) {
        const o = opts || {}
        this.server      = String(o.server || "")
        this.airlineCode = String(o.airlineCode || "")
        this.onStatus    = typeof o.onStatus === "function" ? o.onStatus : () => {}
    }

    /**
     * @param {object} args - {aircraftId, registration, hub, dest, depTime,
     *                          pricePct, service}
     * @returns {Promise<{ok, logId, error?}>}
     */
    async launch(args) {
        const a = args || {}
        if (!a.aircraftId || !a.dest || !a.hub) {
            return {ok: false, error: "dispatcher: missing aircraftId / hub / dest"}
        }
        if (typeof window === "undefined" || !window.AesAfpSubmitBridge) {
            return {ok: false, error: "dispatcher: AesAfpSubmitBridge not loaded — check manifest order on /app/enterprise/dashboard*"}
        }

        const queued = await this._writeQueued(a)
        this.onStatus({phase: "queued", record: queued})

        const start = Date.now()
        await this._update(queued.id, {status: "in-flight"})
        this.onStatus({phase: "in-flight", record: Object.assign({}, queued, {status: "in-flight"})})

        const leg = {
            origin:        a.hub,
            destination:   a.dest,
            depTimeLocal:  a.depTime,
            pricePct:      a.pricePct,
            service:       a.service
        }
        let resp = await this._submit(a.aircraftId, leg, a.hub)
        let retries = 0
        if (!resp.ok && AesRouteLauncherDispatcher._isTransient(resp.error) && retries === 0) {
            retries = 1
            resp = await this._submit(a.aircraftId, leg, a.hub)
        }

        const durationMs = Date.now() - start
        if (resp.ok) {
            const created = await this._update(queued.id, {
                status:     "created",
                durationMs,
                retries
            })
            this.onStatus({phase: "created", record: created})
            return {ok: true, logId: queued.id}
        }

        const failed = await this._update(queued.id, {
            status:     "failed",
            error:      resp.error || "unknown",
            durationMs,
            retries
        })
        this.onStatus({phase: "failed", record: failed})
        return {ok: false, logId: queued.id, error: resp.error}
    }

    async _submit(aircraftId, leg, hub) {
        try {
            return await window.AesAfpSubmitBridge.submitLegInBackground({
                server:     this.server,
                aircraftId,
                hub,
                leg,
                timeoutMs:  AesRouteLauncherDispatcher.DEFAULT_TIMEOUT_MS
            })
        } catch (e) {
            return {ok: false, error: "dispatcher: " + ((e && e.message) || String(e))}
        }
    }

    async _writeQueued(a) {
        return await window.AesRouteLauncherLog.append({
            server:       this.server,
            airline:      this.airlineCode,
            aircraftId:   String(a.aircraftId),
            registration: a.registration || null,
            hub:          a.hub,
            dest:         a.dest,
            depTime:      a.depTime,
            pricePct:     a.pricePct,
            service:      a.service,
            status:       "queued"
        })
    }

    async _update(id, patch) {
        return await window.AesRouteLauncherLog.update(this.server, id, patch)
    }

    static _isTransient(err) {
        if (!err) return false
        return AesRouteLauncherDispatcher.TRANSIENT_RE.test(String(err))
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherDispatcher = AesRouteLauncherDispatcher
}
