"use strict"

/**
 * Settings tile — site skin / density / extension options shortcut.
 *
 * Mirrors the toggles already exposed in `modules/aes-menu.js` so the
 * user has a second discoverable entry point that's also visible at a
 * glance from the hub. Status reflects the current skin + density.
 */
class CentralHubSettingsTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "settings"
        this.title = "Settings"
        this.section = "tools"
        this.priority = 10
        this.requiresAirline = false
    }

    openHandler() {
        return () => {
            try { chrome.runtime.openOptionsPage() }
            catch (_) { window.open(chrome.runtime.getURL("options.html"), "_blank") }
        }
    }

    async loadStatus() {
        const skin = window.AESSiteSkin
        const enabled = skin && typeof skin.isEnabled === "function" && skin.isEnabled()
        const density = (skin && typeof skin.getDensity === "function" && skin.getDensity()) || "comfortable"
        return {
            badge: (enabled ? "SKIN ON" : "SKIN OFF") + " · " + density.toUpperCase(),
            badgeKind: enabled
                ? window.CentralHubStatusBadges.KIND.INFO
                : window.CentralHubStatusBadges.KIND.MUTED,
            summary: "Site skin and density toggles for the AES UI."
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const skin = window.AESSiteSkin

        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:160px 1fr auto",
            "gap:" + T.sp[2] + " " + T.sp[3],
            "align-items:center"
        ].join(";")

        // Skin toggle
        grid.appendChild(this._label(T, "Brutalist Skin"))
        const skinValue = document.createElement("span")
        skinValue.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.mono + ";"
        skinValue.textContent = (skin && skin.isEnabled && skin.isEnabled()) ? "ON" : "OFF"
        grid.appendChild(skinValue)
        const skinBtn = this._actionBtn(T, "Toggle", () => {
            if (!skin) return
            skin.setEnabled(!skin.isEnabled())
            skinValue.textContent = skin.isEnabled() ? "ON" : "OFF"
            this.refresh()
        })
        skinBtn.disabled = !skin
        grid.appendChild(skinBtn)

        // Density toggle
        grid.appendChild(this._label(T, "Density"))
        const densityValue = document.createElement("span")
        densityValue.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.mono + ";"
        densityValue.textContent = (skin && skin.getDensity && skin.getDensity()) || "comfortable"
        grid.appendChild(densityValue)
        const densityBtn = this._actionBtn(T, "Cycle", () => {
            if (!skin || !skin.cycleDensity) return
            skin.cycleDensity()
            densityValue.textContent = skin.getDensity ? skin.getDensity() : "?"
            this.refresh()
        })
        densityBtn.disabled = !skin
        grid.appendChild(densityBtn)

        // Shortcuts dialog
        grid.appendChild(this._label(T, "Keyboard shortcuts"))
        const sc = document.createElement("span")
        sc.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
        sc.textContent = "Press ? on any AS page"
        grid.appendChild(sc)
        const scBtn = this._actionBtn(T, "Show", () => {
            if (skin && skin.showShortcuts) skin.showShortcuts()
        })
        scBtn.disabled = !(skin && skin.showShortcuts)
        grid.appendChild(scBtn)

        // Options page
        grid.appendChild(this._label(T, "Data inspector"))
        const insp = document.createElement("span")
        insp.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
        insp.textContent = "Stored snapshots + caches"
        grid.appendChild(insp)
        grid.appendChild(this._actionBtn(T, "Open options →", () => {
            try { chrome.runtime.openOptionsPage() }
            catch (_) { window.open(chrome.runtime.getURL("options.html"), "_blank") }
        }))

        host.appendChild(grid)
    }

    _label(T, text) {
        const el = document.createElement("div")
        el.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.bold,
            "color:" + T.color.oxide
        ].join(";")
        el.textContent = text
        return el
    }

    _actionBtn(T, label, onClick) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        btn.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "cursor:pointer"
        ].join(";")
        btn.addEventListener("click", (e) => { e.preventDefault(); onClick() })
        return btn
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "settings",
        section: "tools",
        priority: 10,
        factory: () => new CentralHubSettingsTile()
    })
}
