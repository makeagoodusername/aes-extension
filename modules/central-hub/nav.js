"use strict"

/**
 * CentralHubNav — left-rail section list. Renders five section headers
 * (Fleet & Aircraft, Routes & Schedule, Operations, Finance, Tools &
 * Settings); each holds a list of tile titles populated by the shell
 * after tiles mount.
 *
 * Operations groups AS-mutating workflows scoped to the enterprise
 * (service profiles, crew, station automation, alliance) — distinct
 * from Routes which is route-scoped data + planning.
 *
 * Click a section header → onSectionChange(section).
 * Click a tile link    → onTileSelect(tileId).
 */
class CentralHubNav {
    static SECTIONS = [
        {id: "fleet",      label: "Fleet & Aircraft"},
        {id: "routes",     label: "Routes & Schedule"},
        {id: "operations", label: "Operations"},
        {id: "finance",    label: "Finance"},
        {id: "tools",      label: "Tools & Settings"}
    ]

    constructor(opts) {
        this.activeSection   = (opts && opts.activeSection) || "fleet"
        this.onSectionChange = (opts && opts.onSectionChange) || null
        this.onTileSelect    = (opts && opts.onTileSelect)    || null
        this.root            = null
        this._sectionEls     = new Map()
    }

    build() {
        const T = window.AESTokens
        const root = document.createElement("nav")
        root.className = "aes-central-hub-nav"
        root.style.cssText = [
            "flex:0 0 220px",
            "min-width:0",
            "padding:" + T.sp[3],
            "background:" + T.color.bone2,
            "border-right:" + T.geom.bw2 + " solid " + T.color.oxide,
            "box-sizing:border-box",
            "overflow-y:auto"
        ].join(";")

        for (const s of CentralHubNav.SECTIONS) {
            const sectionEl = this._buildSection(s)
            this._sectionEls.set(s.id, sectionEl)
            root.appendChild(sectionEl)
        }

        this.root = root
        this._applyActive()
        return root
    }

    _buildSection(section) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.dataset.section = section.id
        wrap.style.cssText = "margin-bottom:" + T.sp[4] + ";"

        const header = document.createElement("div")
        header.className = "aes-central-hub-nav__section-header"
        header.dataset.section = section.id
        header.textContent = section.label
        header.style.cssText = [
            "padding:" + T.sp[1] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate,
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "margin-bottom:" + T.sp[2],
            "cursor:pointer",
            "transition:" + T.tr.fast
        ].join(";")
        header.addEventListener("click", () => {
            this.setActive(section.id)
            if (typeof this.onSectionChange === "function") this.onSectionChange(section.id)
        })

        const list = document.createElement("ul")
        list.className = "aes-central-hub-nav__list"
        list.dataset.section = section.id
        list.style.cssText = [
            "list-style:none",
            "padding:0",
            "margin:0",
            "display:flex",
            "flex-direction:column",
            "gap:2px"
        ].join(";")

        wrap.append(header, list)
        return wrap
    }

    setTilesForSection(section, tiles) {
        const T = window.AESTokens
        const sectionEl = this._sectionEls.get(section)
        if (!sectionEl) return
        const list = sectionEl.querySelector(".aes-central-hub-nav__list")
        if (!list) return
        list.textContent = ""

        for (const t of tiles) {
            const li = document.createElement("li")
            li.style.cssText = "list-style:none;"
            const link = document.createElement("a")
            link.href = "#aes-central-hub-tile-" + t.id
            link.textContent = t.title || t.id
            link.dataset.tileId = t.id
            link.style.cssText = [
                "display:block",
                "padding:2px " + T.sp[2],
                "color:" + T.color.oxide2,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "text-decoration:none",
                "border-left:" + T.geom.bw2 + " solid transparent",
                "cursor:pointer",
                "transition:" + T.tr.fast
            ].join(";")
            link.addEventListener("mouseenter", () => { link.style.background = T.color.bone3 })
            link.addEventListener("mouseleave", () => { link.style.background = "transparent" })
            link.addEventListener("click", (e) => {
                e.preventDefault()
                if (typeof this.onTileSelect === "function") this.onTileSelect(t.id)
            })
            li.appendChild(link)
            list.appendChild(li)
        }
    }

    setActive(section) {
        if (this.activeSection === section) return
        this.activeSection = section
        this._applyActive()
    }

    _applyActive() {
        const T = window.AESTokens
        for (const [id, el] of this._sectionEls) {
            const header = el.querySelector(".aes-central-hub-nav__section-header")
            if (!header) continue
            const isActive = id === this.activeSection
            header.style.color = isActive ? T.color.rust : T.color.slate
            header.style.borderBottomColor = isActive ? T.color.rust : T.color.paperRule
        }
    }
}

if (typeof window !== "undefined") {
    window.CentralHubNav = CentralHubNav
}
