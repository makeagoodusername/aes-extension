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
            // Prefer the in-page Unified Settings modal — the body CTAs use it,
            // and bouncing to the legacy options page on the title-bar arrow
            // makes the two paths inconsistent.
            if (window.AesUnifiedSettings && typeof window.AesUnifiedSettings.open === "function") {
                window.AesUnifiedSettings.open()
                return
            }
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

        // Studio CTA — primary entry to the granular customization flow.
        const studio = document.createElement("div")
        studio.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:" + T.sp[3],
            "padding:" + T.sp[3],
            "margin-bottom:" + T.sp[4],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "box-shadow:4px 4px 0 " + T.color.oxide
        ].join(";")
        const studioLabel = document.createElement("div")
        const studioTitle = document.createElement("div")
        studioTitle.textContent = "CUSTOMIZATION STUDIO"
        studioTitle.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";")
        const studioSub = document.createElement("div")
        studioSub.textContent = "Theme, colours, keybindings · hotkey g c"
        studioSub.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.oxide2,
            "margin-top:2px"
        ].join(";")
        studioLabel.append(studioTitle, studioSub)
        const studioBtn = this._actionBtn(T, "Open Studio →", () => {
            const sh = window.AESCustomizationHost
            if (sh && typeof sh.open === "function") sh.open()
        })
        studioBtn.style.cssText += ";background:" + T.color.oxide + ";color:" + T.color.bone + ";border-color:" + T.color.oxide
        studioBtn.disabled = !window.AESCustomizationHost
        studio.append(studioLabel, studioBtn)
        host.appendChild(studio)

        // Unified Settings CTA — preferred entry once the shell is loaded.
        // Legacy inline grid stays behind the fallback below for installs
        // that haven't booted unified-settings yet (§4.19 bridge).
        if (window.AesUnifiedSettings) {
            const usWrap = document.createElement("div")
            usWrap.style.cssText = [
                "display:flex",
                "align-items:center",
                "justify-content:space-between",
                "gap:" + T.sp[3],
                "padding:" + T.sp[3],
                "background:" + T.color.bone2,
                "border:" + T.geom.bw2 + " solid " + T.color.oxide,
                "box-shadow:4px 4px 0 " + T.color.oxide
            ].join(";")
            const lbl = document.createElement("div")
            const t = document.createElement("div")
            t.textContent = "AES SETTINGS"
            t.style.cssText = [
                "font-family:" + T.font.display,
                "font-size:" + T.fs.lead,
                "font-weight:" + T.fw.display,
                "letter-spacing:" + T.track.caps,
                "color:" + T.color.oxide
            ].join(";")
            const sub = document.createElement("div")
            sub.textContent = "Customisation · modules · account · data · about · hotkey g x"
            sub.style.cssText = [
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.small,
                "color:" + T.color.oxide2,
                "margin-top:2px"
            ].join(";")
            lbl.append(t, sub)
            const openBtn = this._actionBtn(T, "Open Settings →", () => {
                window.AesUnifiedSettings.open()
            })
            openBtn.style.cssText += ";background:" + T.color.oxide + ";color:" + T.color.bone + ";border-color:" + T.color.oxide
            usWrap.append(lbl, openBtn)
            host.appendChild(usWrap)

            // F-DASH-504 — quick-jump to common tabs without leaving the hub.
            const tabs = [
                ["customisation", "Customisation"],
                ["modules",       "Modules"],
                ["account",       "Account"],
                ["data",          "Data"],
                ["about",         "About"]
            ]
            const tabRow = document.createElement("div")
            tabRow.style.cssText = [
                "display:flex",
                "flex-wrap:wrap",
                "gap:" + T.sp[2],
                "margin-top:" + T.sp[3]
            ].join(";")
            for (const [tabId, label] of tabs) {
                const btn = this._actionBtn(T, label, () => {
                    if (typeof window.AesUnifiedSettings.setActiveTab === "function") {
                        window.AesUnifiedSettings.open()
                        window.AesUnifiedSettings.setActiveTab(tabId)
                    } else {
                        window.AesUnifiedSettings.open()
                    }
                })
                tabRow.appendChild(btn)
            }
            host.appendChild(tabRow)
            return
        }

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

        // CB0 — Cubist Mode toggle (FACET overhaul, opt-in)
        const cubistSettings = await window.CentralHubSettings.load()
        grid.appendChild(this._label(T, "Cubist Mode"))
        const cubistValue = document.createElement("span")
        cubistValue.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.mono + ";"
        cubistValue.textContent = (cubistSettings.cubistMode ? "ON" : "OFF") + " · experimental"
        grid.appendChild(cubistValue)
        const cubistBtn = this._actionBtn(T, "Toggle", async () => {
            const cur = await window.CentralHubSettings.load()
            const wantOn = !cur.cubistMode
            if (wantOn && !cur.cubistModeAcked) {
                const ok = window.confirm(
                    "Enable FACET (Cubist) visual mode?\n\n" +
                    "Experimental UI direction. CB0 ships the foundation only — " +
                    "no visible change yet. Subsequent slices (CB1+) will bind hub " +
                    "surfaces to this mode.\n\n" +
                    "You can toggle off at any time."
                )
                if (!ok) return
                cur.cubistModeAcked = true
            }
            cur.cubistMode = wantOn
            await window.CentralHubSettings.save(cur)
            if (document.body && document.body.classList) {
                document.body.classList.toggle("aes-cubist", wantOn)
            }
            cubistValue.textContent = (wantOn ? "ON" : "OFF") + " · experimental"
            this.refresh()
        })
        grid.appendChild(cubistBtn)

        // CB6 — Motion sub-toggle (cubistMotion: "on" | "off")
        grid.appendChild(this._label(T, "↳ Motion"))
        const motionValue = document.createElement("span")
        motionValue.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.mono + ";"
        motionValue.textContent = cubistSettings.cubistMotion === "off" ? "OFF" : "ON"
        grid.appendChild(motionValue)
        const motionBtn = this._actionBtn(T, "Toggle", async () => {
            const cur = await window.CentralHubSettings.load()
            const next = cur.cubistMotion === "off" ? "on" : "off"
            cur.cubistMotion = next
            await window.CentralHubSettings.save(cur)
            if (document.body) {
                document.body.setAttribute("data-aes-motion", next)
            }
            motionValue.textContent = next === "off" ? "OFF" : "ON"
        })
        grid.appendChild(motionBtn)

        // CB6 — Color-blind pattern fills toggle
        grid.appendChild(this._label(T, "↳ Color-blind"))
        const cbValue = document.createElement("span")
        cbValue.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.mono + ";"
        cbValue.textContent = cubistSettings.cubistColorBlind ? "ON · patterns" : "OFF"
        grid.appendChild(cbValue)
        const cbBtn = this._actionBtn(T, "Toggle", async () => {
            const cur = await window.CentralHubSettings.load()
            const next = !cur.cubistColorBlind
            cur.cubistColorBlind = next
            await window.CentralHubSettings.save(cur)
            if (document.body) {
                if (next) document.body.setAttribute("data-aes-cb-patterns", "on")
                else      document.body.removeAttribute("data-aes-cb-patterns")
            }
            cbValue.textContent = next ? "ON · patterns" : "OFF"
        })
        grid.appendChild(cbBtn)

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

        // Lane B Phase 1 — Organisations sub-page
        grid.appendChild(this._label(T, "Organisations"))
        const orgsVal = document.createElement("span")
        orgsVal.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
        orgsVal.textContent = "Manage canopy groups"
        grid.appendChild(orgsVal)
        const orgsBtn = this._actionBtn(T, "Open →", () => {
            if (window.AesCanopyOrgsSettingsPage) window.AesCanopyOrgsSettingsPage.open()
        })
        orgsBtn.disabled = !window.AesCanopyOrgsSettingsPage
        grid.appendChild(orgsBtn)

        // Lane B Phase 1 — Geographic regions sub-page
        grid.appendChild(this._label(T, "Geographic regions"))
        const regsVal = document.createElement("span")
        regsVal.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
        regsVal.textContent = "Country / region groupings"
        grid.appendChild(regsVal)
        const regsBtn = this._actionBtn(T, "Open →", () => {
            if (window.AesCanopyRegionsSettingsPage) window.AesCanopyRegionsSettingsPage.open()
        })
        regsBtn.disabled = !window.AesCanopyRegionsSettingsPage
        grid.appendChild(regsBtn)

        // Letter M slice M0 — Kin roles sub-page
        grid.appendChild(this._label(T, "Kin roles"))
        const rolesVal = document.createElement("span")
        rolesVal.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono + ";"
        rolesVal.textContent = "Conglomerate role per airline"
        grid.appendChild(rolesVal)
        const rolesBtn = this._actionBtn(T, "Open →", () => {
            if (window.AesCanopyRolesSettingsPage) window.AesCanopyRolesSettingsPage.open()
        })
        rolesBtn.disabled = !window.AesCanopyRolesSettingsPage
        grid.appendChild(rolesBtn)

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
