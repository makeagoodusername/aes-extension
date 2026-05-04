"use strict"

/**
 * Tools tile — quick links to AES support resources.
 *
 * Mirrors the Community + Support sections of `modules/aes-menu.js`
 * (lines ~100-140) so users who're already in the hub don't need to go
 * back up to the navbar dropdown to find docs / GitHub / Discord.
 */
class CentralHubToolsTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "tools"
        this.title = "Tools & Links"
        this.section = "tools"
        this.priority = 20
        this.requiresAirline = false
    }

    openHref() { return "https://github.com/ZoeBijl/airlinesim-enhancement-suite" }

    async loadStatus() {
        let v = ""
        try { v = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version || "" }
        catch (_) { /* noop */ }
        return {
            badge: v ? ("v" + v).toUpperCase() : "AES",
            badgeKind: window.CentralHubStatusBadges.KIND.DEFAULT,
            summary: "Manual, GitHub, Discord, bug reports."
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""

        // F-DASH-505 — utility actions row (in-extension tools, not links).
        const actions = document.createElement("div")
        actions.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "gap:" + T.sp[2],
            "margin-bottom:" + T.sp[3]
        ].join(";")
        const palAvail = !!(window.AESCommandPalette && typeof window.AESCommandPalette.open === "function")
        const palBtn = this._actionBtn(T, "Open command palette", () => {
            if (palAvail) window.AESCommandPalette.open()
        })
        palBtn.disabled = !palAvail
        if (!palAvail) palBtn.title = "Command palette not loaded."
        actions.append(palBtn)

        const cleanAvail = !!(window.AesCleanup && typeof window.AesCleanup.runAll === "function")
        const cleanBtn = this._actionBtn(T, "Run all cleanups", async () => {
            if (!cleanAvail) return
            cleanBtn.disabled = true
            const orig = cleanBtn.textContent
            cleanBtn.textContent = "Running…"
            try { await window.AesCleanup.runAll({reason: "manual-tools-tile"}) }
            catch (e) { console.warn("[AES tools] runAll failed", e) }
            cleanBtn.textContent = "Done"
            setTimeout(() => { cleanBtn.textContent = orig; cleanBtn.disabled = false }, 1500)
        })
        cleanBtn.disabled = !cleanAvail
        if (!cleanAvail) cleanBtn.title = "Cleanup registry not loaded."
        actions.append(cleanBtn)

        const clHistAvail = !!(window.AesDataBus && typeof window.AesDataBus.clearHistory === "function")
        const clHistBtn = this._actionBtn(T, "Clear bus history", () => {
            if (clHistAvail) window.AesDataBus.clearHistory()
        })
        clHistBtn.disabled = !clHistAvail
        if (!clHistAvail) clHistBtn.title = "Data bus not loaded."
        actions.append(clHistBtn)

        const optsBtn = this._actionBtn(T, "Open options page →", () => {
            try { chrome.runtime.openOptionsPage() }
            catch (_) { window.open(chrome.runtime.getURL("options.html"), "_blank") }
        })
        actions.append(optsBtn)
        host.appendChild(actions)

        const links = [
            {label: "Handbook (Google Docs)", href: "https://docs.google.com/document/d/1hzMHb3hTBXSZNtuDKoBuvx1HP9CgB7wVYR59yDYympg/", external: true},
            {label: "GitHub repo",             href: "https://github.com/ZoeBijl/airlinesim-enhancement-suite", external: true},
            {label: "Forum topic",             href: "https://forums.airlinesim.aero/t/introducing-airlinesim-enhancement-suite-beta/", external: true},
            {label: "Discord channel",         href: "https://discord.com/channels/113555701774749696/1249639537450160138", external: true},
            {label: "Report a bug",            href: this._bugReportUrl(), external: true},
            {label: "About AES",               href: "#aes-about-dialog", aboutModal: true}
        ]

        const list = document.createElement("ul")
        list.style.cssText = [
            "list-style:none",
            "padding:0",
            "margin:0",
            "display:grid",
            "grid-template-columns:repeat(auto-fit, minmax(220px, 1fr))",
            "gap:" + T.sp[2]
        ].join(";")

        for (const l of links) {
            const li = document.createElement("li")
            const a = document.createElement("a")
            a.textContent = l.label + (l.external ? " ↗" : "")
            a.href = l.href
            a.style.cssText = [
                "display:block",
                "padding:" + T.sp[2] + " " + T.sp[3],
                "background:" + T.color.bone2,
                "color:" + T.color.oxide,
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "text-decoration:none",
                "transition:" + T.tr.fast
            ].join(";")
            a.addEventListener("mouseenter", () => {
                a.style.background = T.color.oxide
                a.style.color = T.color.bone
            })
            a.addEventListener("mouseleave", () => {
                a.style.background = T.color.bone2
                a.style.color = T.color.oxide
            })
            if (l.external) {
                a.target = "_blank"
                a.rel = "noreferrer noopener"
            }
            if (l.aboutModal) {
                a.addEventListener("click", (e) => {
                    e.preventDefault()
                    const dlg = document.getElementById("aes-about-dialog")
                    if (!dlg) return
                    if (window.jQuery && typeof window.jQuery.fn.modal === "function") {
                        window.jQuery(dlg).modal("show")
                    } else {
                        dlg.style.display = "block"
                    }
                })
            }
            li.appendChild(a)
            list.appendChild(li)
        }
        host.appendChild(list)
    }

    _actionBtn(T, label, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "cursor:pointer"
        ].join(";")
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
        return b
    }

    _bugReportUrl() {
        let manifestVersion = ""
        try { manifestVersion = chrome.runtime.getManifest().version || "" }
        catch (_) { /* noop */ }
        let chromeVersion = ""
        try {
            const m = navigator.userAgent.match(/Chrom(?:e|ium)\/([0-9]+)/)
            chromeVersion = m ? m[1] : ""
        } catch (_) { /* noop */ }
        const body = "AES: v" + manifestVersion + "%0AChrome: v" + chromeVersion + "%0A%0A"
        return "https://github.com/ZoeBijl/airlinesim-enhancement-suite/issues/new?body=" + body
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "tools",
        section: "tools",
        priority: 20,
        factory: () => new CentralHubToolsTile()
    })
}
