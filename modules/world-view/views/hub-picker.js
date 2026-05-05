"use strict"

/**
 * WorldViewHubPicker — chip row for selecting the focused hub.
 *
 * render(host, {hubs, focused, onPick}) writes a flexbox of toggleable
 * chips into `host`. Active chip is filled; click on an inactive chip
 * fires onPick(iata).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewHubPicker) return

    function render(host, opts) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        const hubs = (opts && Array.isArray(opts.hubs)) ? opts.hubs : []
        const focused = (opts && opts.focused) ? String(opts.focused).toUpperCase() : ""
        const onPick = (opts && typeof opts.onPick === "function") ? opts.onPick : null

        host.textContent = ""

        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "align-items:center",
            "flex-wrap:wrap",
            "gap:" + T.sp[1],
            "margin-bottom:" + T.sp[2]
        ].join(";")

        const label = document.createElement("span")
        label.textContent = "HUB"
        label.style.cssText = ws.metricLabel() + ";margin-right:" + T.sp[2] + ";"
        wrap.appendChild(label)

        if (!hubs.length) {
            const empty = document.createElement("span")
            empty.textContent = "(no hubs in snapshot — visit /app/com/scheduling/<HUB> to seed)"
            empty.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.display + ";font-size:" + T.fs.small + ";"
            wrap.appendChild(empty)
            host.appendChild(wrap)
            return
        }

        for (const iata of hubs) {
            const code = String(iata || "").toUpperCase()
            if (!code) continue
            const active = code === focused
            const btn = document.createElement("button")
            btn.type = "button"
            btn.dataset.hub = code
            btn.textContent = code
            btn.style.cssText = ws.chip(active)
            btn.addEventListener("mouseenter", () => {
                if (!active) btn.style.background = T.color.bone2
            })
            btn.addEventListener("mouseleave", () => {
                if (!active) btn.style.background = "transparent"
            })
            btn.addEventListener("click", () => {
                if (active) return
                if (onPick) onPick(code)
            })
            wrap.appendChild(btn)
        }

        host.appendChild(wrap)
    }

    window.WorldViewHubPicker = {render: render}
})()
