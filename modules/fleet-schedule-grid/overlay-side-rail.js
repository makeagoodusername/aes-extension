"use strict"

/**
 * Fleet Schedule Grid — side-rail tab container.
 *
 * Hosts the wave picker (Slice 1) and the drag-source panel (Slice 3) as
 * switchable panes inside a single right-side rail on the modal. The rail
 * has a fixed width so toggling tabs doesn't reflow the grid.
 *
 * Each tab provides `{id, label, paneEl, onActivate?}` — `paneEl` is the
 * DOM the tab owns (the rail just shows/hides them); `onActivate` fires
 * when the tab becomes active.
 */
class FleetScheduleGridSideRail {

    static ROOT_CLASS = "aes-fsg-side-rail"
    static TAB_BAR_CLASS = "aes-fsg-side-rail-tabs"
    static BODY_CLASS = "aes-fsg-side-rail-body"

    constructor(opts) {
        const o = opts || {}
        this.tabs = Array.isArray(o.tabs) ? o.tabs.slice() : []
        this.activeTabId = o.activeTabId || (this.tabs[0] && this.tabs[0].id) || null
        this.rootEl = null
        this._tabButtons = new Map()
    }

    mount(parentEl) {
        if (!parentEl) return null
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const root = document.createElement("div")
        root.className = FleetScheduleGridSideRail.ROOT_CLASS
        root.style.cssText = "flex:0 0 320px;display:flex;flex-direction:column;"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-left:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "min-height:0;overflow:hidden;"

        const tabBar = document.createElement("div")
        tabBar.className = FleetScheduleGridSideRail.TAB_BAR_CLASS
        tabBar.style.cssText = "display:flex;flex:0 0 auto;"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const body = document.createElement("div")
        body.className = FleetScheduleGridSideRail.BODY_CLASS
        body.style.cssText = "flex:1 1 auto;overflow:auto;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        for (const tab of this.tabs) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.dataset.tabId = tab.id
            btn.style.cssText = "flex:1 1 0;padding:8px 12px;cursor:pointer;"
                + "border:0;border-bottom:2px solid transparent;"
                + "background:transparent;font-size:11px;"
                + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
                + "font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
                + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
                + "transition:background 80ms linear, border-color 80ms linear, color 80ms linear;"
            btn.textContent = tab.label
            btn.addEventListener("click", () => this.setActiveTab(tab.id))
            tabBar.appendChild(btn)
            this._tabButtons.set(tab.id, btn)
            if (tab.paneEl) {
                tab.paneEl.dataset.tabPane = tab.id
                tab.paneEl.style.display = "none"
                body.appendChild(tab.paneEl)
            }
        }

        root.append(tabBar, body)
        parentEl.appendChild(root)
        this.rootEl = root
        if (this.activeTabId) this.setActiveTab(this.activeTabId)
        return root
    }

    setActiveTab(id) {
        if (!this.rootEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this.activeTabId = id
        for (const tab of this.tabs) {
            const btn = this._tabButtons.get(tab.id)
            const isActive = (tab.id === id)
            if (btn) {
                btn.style.background = isActive ? (T ? T.color.bone : "#F4F1EA") : "transparent"
                btn.style.borderBottomColor = isActive ? (T ? T.color.rust : "#B8472A") : "transparent"
                btn.style.color = isActive ? (T ? T.color.oxide : "#2B2520") : (T ? T.color.oxide2 : "#4A413B")
            }
            if (tab.paneEl) {
                tab.paneEl.style.display = isActive ? "" : "none"
            }
            if (isActive && typeof tab.onActivate === "function") {
                try { tab.onActivate() } catch (e) { console.warn("[AES FSG] tab onActivate threw", e) }
            }
        }
    }

    refresh() {
        for (const tab of this.tabs) {
            if (tab.id === this.activeTabId && typeof tab.onActivate === "function") {
                try { tab.onActivate() } catch (_) {}
            }
        }
    }

    dispose() {
        if (this.rootEl && this.rootEl.parentElement) {
            this.rootEl.parentElement.removeChild(this.rootEl)
        }
        this.rootEl = null
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridSideRail = FleetScheduleGridSideRail
}
