"use strict"

/**
 * CentralHubStatusBadges — pure helpers for rendering tile badges + summary
 * lines in a consistent visual treatment. Tiles return {badge, badgeKind,
 * summary} from loadStatus(); the shell calls these to paint headers.
 *
 * badgeKind values map to AES design-token colour pairs:
 *   "default"  — bone bg, oxide fg
 *   "info"     — cobalt
 *   "ok"       — moss
 *   "warn"     — amber
 *   "alert"    — rust
 *   "muted"    — slate (no data / placeholder)
 */
class CentralHubStatusBadges {
    static KIND = {
        DEFAULT: "default",
        INFO:    "info",
        OK:      "ok",
        WARN:    "warn",
        ALERT:   "alert",
        MUTED:   "muted"
    }

    static _palette(kind) {
        const T = window.AESTokens
        const map = {
            default: {bg: T.color.bone2,      fg: T.color.oxide,   border: T.color.oxide},
            info:    {bg: T.color.cobaltSoft, fg: T.color.cobalt,  border: T.color.cobalt},
            ok:      {bg: T.color.mossSoft,   fg: T.color.moss,    border: T.color.moss},
            warn:    {bg: T.color.amberSoft,  fg: T.color.amber,   border: T.color.amber},
            alert:   {bg: T.color.rustSoft,   fg: T.color.rust,    border: T.color.rust},
            muted:   {bg: "transparent",      fg: T.color.slate,   border: T.color.paperRule}
        }
        return map[kind || "default"] || map.default
    }

    static makeBadgeEl(text, kind) {
        const T = window.AESTokens
        const colors = this._palette(kind)
        const el = document.createElement("span")
        el.className = "aes-central-hub-badge"
        el.dataset.kind = kind || "default"
        el.textContent = text
        el.style.cssText = [
            "display:inline-block",
            "padding:2px " + T.sp[2],
            "background:" + colors.bg,
            "color:" + colors.fg,
            "border:" + T.geom.bw1 + " solid " + colors.border,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "text-transform:uppercase",
            "white-space:nowrap"
        ].join(";")
        return el
    }
}

if (typeof window !== "undefined") {
    window.CentralHubStatusBadges = CentralHubStatusBadges
}
