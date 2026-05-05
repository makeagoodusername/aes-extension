"use strict"

/**
 * Route Launcher — status feed.
 *
 * Renders the last N submissions from AesRouteLauncherLog into a host
 * element. Each row shows: state icon, time, registration, hub→dest,
 * outcome (created/failed + reason). Failed rows get a "↻ Retry" button.
 *
 * Pure render module. Re-rendered by the controller on log updates and
 * dispatcher status callbacks.
 */
class AesRouteLauncherStatusFeed {
    static LIMIT = 12

    constructor(opts) {
        const o = opts || {}
        this.server  = String(o.server || "")
        this.onRetry = typeof o.onRetry === "function" ? o.onRetry : () => {}
    }

    async render(host) {
        const T = window.AESTokens
        host.textContent = ""
        host.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[1],
            "max-height:240px",
            "overflow-y:auto",
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "background:" + T.color.bone2
        ].join(";")

        if (!window.AesRouteLauncherLog) {
            host.appendChild(this._muted(T, "Log store not loaded."))
            return
        }
        const records = await window.AesRouteLauncherLog.list(this.server, AesRouteLauncherStatusFeed.LIMIT)
        if (!records.length) {
            host.appendChild(this._muted(T, "No submissions yet. Pick an aircraft and click a destination."))
            return
        }
        for (const r of records) host.appendChild(this._renderRow(T, r))
    }

    _renderRow(T, r) {
        const row = document.createElement("div")
        const isFail = r.status === "failed"
        const isOk   = r.status === "created"
        const accent = isFail ? T.color.rust
                     : isOk   ? T.color.cobalt
                     :          T.color.slate
        row.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "background:" + T.color.bone,
            "border-left:3px solid " + accent,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "color:" + T.color.oxide
        ].join(";")

        const icon = document.createElement("span")
        icon.textContent = AesRouteLauncherStatusFeed._iconOf(r.status)
        icon.style.cssText = "flex:0 0 auto;width:18px;color:" + accent + ";"

        const ts = document.createElement("span")
        ts.textContent = AesRouteLauncherStatusFeed._fmtTime(r.ts)
        ts.style.cssText = "flex:0 0 56px;color:" + T.color.slate + ";font-size:" + T.fs.micro + ";"

        const route = document.createElement("span")
        route.textContent = (r.hub || "?") + " → " + (r.dest || "?") + " · " + (r.depTime || "?")
        route.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"

        const reg = document.createElement("span")
        reg.textContent = r.registration || ("#" + (r.aircraftId || ""))
        reg.style.cssText = "flex:0 0 auto;color:" + T.color.oxide2 + ";font-size:" + T.fs.micro + ";"

        row.append(icon, ts, route, reg)

        if (isFail && r.error) {
            const err = document.createElement("span")
            err.textContent = AesRouteLauncherStatusFeed._truncate(r.error, 40)
            err.title = r.error
            err.style.cssText = "flex:0 0 auto;color:" + T.color.rust + ";font-size:" + T.fs.micro + ";max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
            row.appendChild(err)
            row.appendChild(this._retryBtn(T, r))
        }
        return row
    }

    _retryBtn(T, r) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = "↻ Retry"
        b.style.cssText = [
            "flex:0 0 auto",
            "background:transparent",
            "color:" + T.color.cobalt,
            "border:" + T.geom.bw1 + " solid " + T.color.cobalt,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[0] + " " + T.sp[1],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "cursor:pointer"
        ].join(";")
        b.addEventListener("click", (e) => {
            e.stopPropagation()
            this.onRetry(r)
        })
        return b
    }

    _muted(T, text) {
        const p = document.createElement("p")
        p.style.cssText = "color:" + T.color.slate + ";margin:" + T.sp[2] + " 0;font-style:italic;"
        p.textContent = text
        return p
    }

    static _iconOf(status) {
        switch (status) {
            case "queued":    return "⏳"
            case "in-flight": return "✈"
            case "created":   return "✓"
            case "failed":    return "✗"
            default:          return "·"
        }
    }

    static _fmtTime(ts) {
        if (!ts) return "—"
        const d = new Date(ts)
        return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
    }

    static _truncate(s, n) {
        s = String(s || "")
        return s.length > n ? s.slice(0, n - 1) + "…" : s
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherStatusFeed = AesRouteLauncherStatusFeed
}
