class AESMenu {
    #container
    #button
    #menu

    constructor(target) {
        this.#container = this.#createContainer()
        this.#button = this.#createButton()
        this.#menu = this.#createMenu()

        this.#container.append(this.#button, this.#menu)
        if (!target) {
            throw new Error(`AESMenu: \`target\` is ${target}`)
        }
        target.after(this.#container)
    }

    /**
     * Creates the menu container — keeps Bootstrap `.dropdown` so AS's
     * own dropdown JS still toggles the menu open/closed; visuals are ours.
     */
    #createContainer() {
        const container = document.createElement("li")
        container.className = "dropdown"
        return container
    }

    /**
     * The trigger anchor in the AS navbar — UPPERCASE display caps, tracked.
     * This is the very first piece of AES typography a user sees on every page.
     */
    #createButton() {
        const caret = document.createElement("span")
        caret.className = "caret"
        caret.style.cssText = "margin-left:6px;border-top-color:currentColor;"

        const button = document.createElement("a")
        button.setAttribute("role", "button")
        button.setAttribute("tabindex", "0")
        button.dataset.toggle = "dropdown"
        button.className = "dropdown-toggle aes-menu__trigger"
        button.innerText = "AES"
        button.style.cssText = [
            "cursor:pointer",
            "font-family:var(--aes-font-display)",
            "font-weight:var(--aes-fw-display)",
            "text-transform:uppercase",
            "letter-spacing:var(--aes-tracking-caps)",
            "font-size:var(--aes-fs-small)"
        ].join(";")
        button.append(caret)

        return button
    }

    /**
     * Creates the dropdown menu — bone bg, 2px oxide border, no radius.
     * Style overrides applied inline so we beat AS's Bootstrap CSS specificity.
     */
    #createMenu() {
        const menu = document.createElement("ul")
        menu.className = "dropdown-menu aes-menu__panel"
        menu.style.cssText = [
            "background:var(--aes-bone)",
            "color:var(--aes-oxide)",
            "border:var(--aes-bw-2) solid var(--aes-oxide)",
            "border-radius:var(--aes-radius)",
            "box-shadow:none",
            "padding:var(--aes-sp-1) 0",
            "min-width:240px",
            "font-family:var(--aes-font-display)",
            "font-size:var(--aes-fs-body)"
        ].join(";")

        const content = [{
            label: "Workspace",
            isHeader: true
        },{
            label: "Command Bridge",
            icon: { className: "fa-th-large" },
            onClick: () => {
                try {
                    chrome.runtime.sendMessage(
                        {type: "aes:bridge:open"},
                        () => { void chrome.runtime.lastError }
                    )
                } catch (_) { /* noop */ }
            }
        },{
            isDivider: true
        },{
            label: "Skin",
            isHeader: true
        },{
            label: "Brutalist Skin",
            stateLabel: () => window.AESSiteSkin?.isEnabled() ? "ON" : "OFF",
            onClick: () => {
                if (!window.AESSiteSkin) return
                window.AESSiteSkin.setEnabled(!window.AESSiteSkin.isEnabled())
            }
        },{
            label: "Density",
            stateLabel: () => (window.AESSiteSkin?.getDensity() || "comfortable") === "compact" ? "COMPACT" : "COMFORT",
            onClick: () => {
                if (!window.AESSiteSkin) return
                window.AESSiteSkin.cycleDensity()
            }
        },{
            label: "Shortcuts",
            icon: { className: "fa-keyboard-o" },
            onClick: () => {
                if (window.AESSiteSkin?.showShortcuts) window.AESSiteSkin.showShortcuts()
            }
        },{
            isDivider: true
        },{
            label: "Community",
            isHeader: true
        },{
            label: "Forum Topic",
            href: "https://forums.airlinesim.aero/t/introducing-airlinesim-enhancement-suite-beta/",
            newWindow: true
        },{
            label: "Discord",
            href: "https://discord.com/channels/113555701774749696/1249639537450160138",
            newWindow: true
        },{
            isDivider: true
        },{
            label: "Support",
            isHeader: true
        },{
            label: "Report a Bug",
            href: `https://github.com/ZoeBijl/airlinesim-enhancement-suite/issues/new?body=AES:%20v${chrome.runtime.getManifest().version}%0AChrome:%20v${window.navigator.userAgent.match(/Chrom(?:e|ium)\/([0-9]+)/)[1]}%0A%0A`,
            newWindow: true,
            icon: { className: "fa-bug" }
        },{
            label: "Handbook",
            href: "https://docs.google.com/document/d/1hzMHb3hTBXSZNtuDKoBuvx1HP9CgB7wVYR59yDYympg/",
            newWindow: true,
            icon: { className: "fa-book" }
        },{
            label: "GitHub",
            href: "https://github.com/ZoeBijl/airlinesim-enhancement-suite",
            newWindow: true,
            icon: { className: "fa-github" }
        },{
            isDivider: true
        },{
            label: "About AES",
            icon: { className: "fa-info" },
            data: {
                toggle: "modal",
                target: "#aes-about-dialog"
            }
        }]

        for (const item of content) {
            menu.append(this.#createMenuItem(item))
        }

        // Re-stamp the state badges on items that have a stateLabel() function
        // whenever the storage values change. The bootstrap script in
        // modules/site-skin/bootstrap.js drives the storage updates; we just
        // listen and refresh the labels in place so the menu stays accurate
        // without a full re-render.
        if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
            const skin = (typeof window !== "undefined" && window.AESSiteSkin) || {}
            const skinKey    = skin.SKIN_KEY    || "aes_skin_enabled"
            const densityKey = skin.DENSITY_KEY || "aes_skin_density"
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== "sync") return
                if (!changes[skinKey] && !changes[densityKey]) return
                menu.querySelectorAll("[data-aes-state]").forEach(badge => {
                    const fn = badge.__aesStateFn
                    if (typeof fn === "function") badge.textContent = fn()
                })
            })
        }

        return menu
    }

    /**
     * Builds a single menu item with brutalist treatment.
     * Headers: UPPERCASE display tracked, slate colour, hairline below.
     * Dividers: hairline rule across full width.
     * Links: bone bg, oxide fg → invert on hover (oxide bg, bone fg).
     */
    #createMenuItem(content) {
        const menuItem = document.createElement("li")

        if (content.isDivider) {
            menuItem.className = "divider"
            menuItem.style.cssText = [
                "height:0",
                "margin:var(--aes-sp-1) 0",
                "border-top:var(--aes-bw-1) solid var(--aes-paper-rule)",
                "background:transparent",
                "list-style:none"
            ].join(";")
            return menuItem
        }

        if (content.isHeader) {
            menuItem.className = "dropdown-header"
            menuItem.style.cssText = [
                "padding:var(--aes-sp-1) var(--aes-sp-3) 2px",
                "font-family:var(--aes-font-display)",
                "font-size:var(--aes-fs-micro)",
                "font-weight:var(--aes-fw-display)",
                "text-transform:uppercase",
                "letter-spacing:var(--aes-tracking-caps)",
                "color:var(--aes-slate)",
                "list-style:none"
            ].join(";")
            menuItem.textContent = content.label
            return menuItem
        }

        const linkStyle = [
            "display:flex",
            "align-items:center",
            "gap:var(--aes-sp-2)",
            "padding:var(--aes-sp-1) var(--aes-sp-3)",
            "color:var(--aes-oxide)",
            "background:transparent",
            "font-family:var(--aes-font-display)",
            "font-size:var(--aes-fs-body)",
            "text-decoration:none",
            "cursor:pointer",
            "transition:var(--aes-tr-fast)",
            "white-space:nowrap"
        ].join(";")

        let icon
        if (content.icon || content.newWindow) {
            icon = document.createElement("span")
            icon.setAttribute("aria-hidden", "true")
            icon.style.cssText = "color:var(--aes-oxide-2);width:1em;flex-shrink:0;"
        }
        if (content.icon) {
            icon.className = `fa ${content.icon.className}`
        }

        let inner
        if (content.data?.toggle) {
            inner = document.createElement("a")
            inner.setAttribute("role", "button")
            inner.setAttribute("tabindex", "0")
            for (const attribute in content.data) {
                inner.dataset[attribute] = content.data[attribute]
            }
        } else if (content.href) {
            inner = document.createElement("a")
            inner.setAttribute("href", content.href)
            if (content.newWindow && !content.icon) {
                icon.className = "fa fa-external-link"
            }
            if (content.newWindow) {
                inner.setAttribute("target", "_blank")
                inner.setAttribute("rel", "noreferrer noopener")
            }
        } else if (content.onClick) {
            inner = document.createElement("a")
            inner.setAttribute("role", "button")
            inner.setAttribute("tabindex", "0")
            inner.addEventListener("click", (e) => {
                e.preventDefault()
                content.onClick(e)
            })
        } else {
            inner = document.createElement("a")
        }

        inner.style.cssText = linkStyle
        inner.addEventListener("mouseenter", () => {
            inner.style.background = "var(--aes-oxide)"
            inner.style.color = "var(--aes-bone)"
            if (icon) icon.style.color = "var(--aes-bone)"
        })
        inner.addEventListener("mouseleave", () => {
            inner.style.background = "transparent"
            inner.style.color = "var(--aes-oxide)"
            if (icon) icon.style.color = "var(--aes-oxide-2)"
        })

        if (icon) inner.append(icon)
        const labelEl = document.createElement("span")
        labelEl.textContent = content.label
        labelEl.style.flex = "1 1 auto"
        inner.append(labelEl)

        // Live state badge — e.g. "ON" / "OFF" / "COMPACT". The factory
        // attaches the function to the badge so the menu's storage-change
        // listener can re-invoke it without remembering the binding.
        if (typeof content.stateLabel === "function") {
            const badge = document.createElement("span")
            badge.dataset.aesState = "1"
            badge.style.cssText = [
                "font-family:var(--aes-font-mono)",
                "font-size:var(--aes-fs-micro)",
                "letter-spacing:var(--aes-tracking-mono)",
                "color:var(--aes-rust)",
                "text-transform:uppercase"
            ].join(";")
            badge.textContent = content.stateLabel()
            badge.__aesStateFn = content.stateLabel
            inner.append(badge)
        }

        menuItem.style.listStyle = "none"
        menuItem.append(inner)
        return menuItem
    }
}

new AESMenu(document.querySelector("#as-navbar-main-collapse .navbar-nav > li:nth-child(5)"))
