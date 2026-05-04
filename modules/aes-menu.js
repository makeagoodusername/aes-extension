class AESMenu {
    #container
    #button
    #menu
    #outsideClickHandler

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
        container.style.position = "relative"
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
        button.setAttribute("aria-haspopup", "true")
        button.setAttribute("aria-expanded", "false")
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
        button.addEventListener("click", () => {
            const wasOpen = this.#isMenuOpen()
            setTimeout(() => {
                this.#refreshStateBadges()
                const isOpen = this.#isMenuOpen()
                if (isOpen === wasOpen) this.#setMenuOpen(!wasOpen)
                else this.#setMenuOpen(isOpen)
            }, 0)
        })
        button.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault()
                button.click()
            }
        })

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
            "display:none",
            "left:0",
            "list-style:none",
            "margin:0",
            "padding:var(--aes-sp-1) 0",
            "position:absolute",
            "top:100%",
            "z-index:2147483646",
            "min-width:240px",
            "font-family:var(--aes-font-display)",
            "font-size:var(--aes-fs-body)"
        ].join(";")

        this.#ensureShortcutApi()

        const content = [{
            label: "Workspace",
            isHeader: true
        },{
            label: "Command Bridge",
            icon: { className: "fa-th-large" },
            onClick: () => this.#openCommandBridge()
        },{
            label: "Open AES Settings",
            icon: { className: "fa-cog" },
            onClick: () => {
                const us = window.AesUnifiedSettings
                if (us && typeof us.open === "function") {
                    try { us.open() } catch (_) { /* noop */ }
                }
            }
        },{
            label: "Startup Health",
            icon: { className: "fa-heartbeat" },
            stateLabel: () => this.#startupHealthState(),
            onClick: () => this.#showStartupDiagnostics()
        },{
            label: "Open command palette",
            icon: { className: "fa-search" },
            onClick: () => {
                const cp = window.AESCommandPalette
                if (cp && typeof cp.open === "function") {
                    try { cp.open() } catch (_) { /* noop */ }
                }
            }
        },{
            label: "Route Planner",
            icon: { className: "fa-paper-plane" },
            stateLabel: () => {
                const p = window.AesAfpRoutePlannerPanel
                return p && typeof p.open === "function" ? "" : "n/a"
            },
            onClick: () => {
                const p = window.AesAfpRoutePlannerPanel
                if (p && typeof p.open === "function") {
                    try { p.open() } catch (_) { /* noop */ }
                }
            }
        },{
            isDivider: true
        },{
            label: "Strategy",
            isHeader: true
        },{
            label: "Open Strategy",
            icon: { className: "fa-line-chart" },
            stateLabel: () => this.#surfaceState("AesStrategyPanel"),
            onClick: () => this.#openStrategyPanel({section: "overview", filter: this.#allStrategyDecisionFilter()})
        },{
            label: "Pricing Decisions",
            icon: { className: "fa-usd" },
            stateLabel: () => this.#surfaceState("AesStrategyPanel"),
            onClick: () => this.#openStrategyPanel({section: "decisions", domain: "price"})
        },{
            label: "Strategy Settings",
            icon: { className: "fa-sliders" },
            stateLabel: () => this.#strategySettingsState(),
            onClick: () => this.#openStrategySettings()
        },{
            label: "Hub Network Designer",
            icon: { className: "fa-sitemap" },
            stateLabel: () => this.#surfaceState("AesStrategyHubDesignerModal"),
            onClick: () => this.#openStrategyHubDesigner()
        },{
            label: "Layered Overrides",
            icon: { className: "fa-clone" },
            stateLabel: () => this.#surfaceState("AesStrategyLayeredPanel"),
            onClick: () => this.#openStrategyLayered()
        },{
            label: "Strategy Journal",
            icon: { className: "fa-book" },
            stateLabel: () => this.#surfaceState("AesStrategyPanel"),
            onClick: () => this.#openStrategyPanel({section: "journal", filter: this.#allStrategyDecisionFilter()})
        },{
            isDivider: true
        },{
            label: "Skin",
            isHeader: true
        },{
            label: "Brutalist Skin",
            stateLabel: () => {
                const skin = window.AESSiteSkin
                return skin && typeof skin.isEnabled === "function" && skin.isEnabled()
                    ? "ON" : "OFF"
            },
            onClick: () => {
                const skin = window.AESSiteSkin
                if (!skin || typeof skin.setEnabled !== "function"
                    || typeof skin.isEnabled !== "function") return
                skin.setEnabled(!skin.isEnabled())
            }
        },{
            label: "Density",
            stateLabel: () => {
                const skin = window.AESSiteSkin
                const density = skin && typeof skin.getDensity === "function"
                    ? skin.getDensity() : "comfortable"
                return density === "compact" ? "COMPACT" : "COMFORT"
            },
            onClick: () => {
                const skin = window.AESSiteSkin
                if (skin && typeof skin.cycleDensity === "function") skin.cycleDensity()
            }
        },{
            label: "Shortcuts",
            icon: { className: "fa-keyboard-o" },
            onClick: () => this.#showShortcuts()
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

        try {
            window.addEventListener("aes:init:health", () => this.#refreshStateBadges())
        } catch (_) { /* noop */ }

        return menu
    }

    #refreshStateBadges() {
        if (!this.#menu) return
        this.#menu.querySelectorAll("[data-aes-state]").forEach(badge => {
            const fn = badge.__aesStateFn
            if (typeof fn === "function") {
                try { badge.textContent = fn() }
                catch (_) { badge.textContent = "n/a" }
            }
        })
    }

    #isMenuOpen() {
        return !!(this.#container
            && (this.#container.classList.contains("open")
                || this.#container.classList.contains("show")
                || (this.#menu && this.#menu.style.display === "block")))
    }

    #setMenuOpen(open) {
        if (!this.#container || !this.#button || !this.#menu) return
        this.#container.classList.toggle("open", !!open)
        this.#container.classList.toggle("show", !!open)
        this.#button.setAttribute("aria-expanded", open ? "true" : "false")
        this.#menu.style.display = open ? "block" : "none"
        if (open) {
            this.#refreshStateBadges()
            if (!this.#outsideClickHandler) {
                this.#outsideClickHandler = (ev) => {
                    if (!this.#container || this.#container.contains(ev.target)) return
                    this.#setMenuOpen(false)
                }
            }
            setTimeout(() => document.addEventListener("click", this.#outsideClickHandler, true), 0)
        } else if (this.#outsideClickHandler) {
            document.removeEventListener("click", this.#outsideClickHandler, true)
        }
    }

    #surfaceState(globalName, methodName) {
        const obj = window[globalName]
        const method = methodName || "open"
        return obj && typeof obj[method] === "function" ? "ready" : "n/a"
    }

    #strategySettingsState() {
        const sp = window.AesStrategyPanel
        if (sp && typeof sp.open === "function") return "ready"
        const us = window.AesUnifiedSettings
        return us && typeof us.open === "function" ? "ready" : "n/a"
    }

    #allStrategyDecisionFilter() {
        return {
            domain: "all",
            search: "",
            applicableOnly: false,
            advisoryOnly: false,
            selectedOnly: false
        }
    }

    #showNotice(message, tone) {
        try {
            const t = document.createElement("div")
            const isWarn = tone === "warn"
            const border = isWarn ? "#f59e0b" : "var(--aes-rust, #9a3412)"
            t.className = "aes-menu__notice"
            t.textContent = message
            t.style.cssText = [
                "position:fixed",
                "right:20px",
                "bottom:20px",
                "z-index:2147483647",
                "max-width:360px",
                "padding:10px 12px",
                "background:var(--aes-bone, #fffaf0)",
                "color:var(--aes-oxide, #1f2937)",
                "border:1px solid " + border,
                "font-family:var(--aes-font-display, system-ui, sans-serif)",
                "font-size:12px",
                "box-shadow:0 10px 24px rgba(15,23,42,0.18)"
            ].join(";")
            document.body.appendChild(t)
            setTimeout(() => { try { t.remove() } catch (_) {} }, 4500)
        } catch (_) { /* noop */ }
    }

    #startupHealthState() {
        const init = window.AesInit
        const h = init && typeof init.health === "function" ? init.health() : null
        return h && h.failures && h.failures.length ? "Degraded" : "Normal"
    }

    #showStartupDiagnostics() {
        const init = window.AesInit
        const h = init && typeof init.health === "function"
            ? init.health()
            : {failures: [], url: window.location.href}

        const existing = document.getElementById("aes-startup-diagnostics")
        if (existing) {
            existing.remove()
            return
        }

        const overlay = document.createElement("div")
        overlay.id = "aes-startup-diagnostics"
        overlay.style.cssText = [
            "position:fixed",
            "right:18px",
            "top:58px",
            "z-index:2147483647",
            "width:min(520px, calc(100vw - 32px))",
            "max-height:calc(100vh - 92px)",
            "overflow:auto",
            "background:var(--aes-bone, #fffaf0)",
            "color:var(--aes-oxide, #1f2937)",
            "border:var(--aes-bw-2, 2px) solid var(--aes-oxide, #1f2937)",
            "box-shadow:0 18px 40px rgba(15,23,42,0.22)",
            "font-family:var(--aes-font-display, system-ui, sans-serif)",
            "font-size:12px"
        ].join(";")

        const header = document.createElement("div")
        header.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:12px",
            "padding:10px 12px",
            "border-bottom:1px solid var(--aes-paper-rule, #d6d3ca)"
        ].join(";")

        const title = document.createElement("strong")
        title.textContent = h.failures && h.failures.length
            ? "Startup Degraded"
            : "Startup Normal"
        title.style.cssText = "text-transform:uppercase;letter-spacing:var(--aes-tracking-caps, .06em);"

        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "×"
        close.setAttribute("aria-label", "Close diagnostics")
        close.style.cssText = [
            "border:1px solid var(--aes-oxide, #1f2937)",
            "background:transparent",
            "color:inherit",
            "min-width:28px",
            "height:28px",
            "cursor:pointer"
        ].join(";")
        close.addEventListener("click", () => overlay.remove())
        header.append(title, close)

        const body = document.createElement("div")
        body.style.cssText = "padding:10px 12px 12px;"

        const failures = (h.failures || []).slice().sort((a, b) => (a.label || "").localeCompare(b.label || ""))
        if (!failures.length) {
            const ok = document.createElement("div")
            ok.textContent = "No startup degradations recorded for this page."
            body.appendChild(ok)
        } else {
            for (const failure of failures) {
                const row = document.createElement("div")
                row.style.cssText = [
                    "padding:8px 0",
                    "border-bottom:1px solid var(--aes-paper-rule, #d6d3ca)"
                ].join(";")

                const label = document.createElement("div")
                label.textContent = failure.label || "startup"
                label.style.cssText = "font-weight:700;color:var(--aes-rust, #9a3412);"

                const message = document.createElement("div")
                message.textContent = failure.message || failure.name || "Unknown startup failure"
                message.style.cssText = "margin-top:3px;"

                const meta = document.createElement("div")
                meta.textContent = (failure.lastIso || failure.iso || "") + " · " + (failure.url || h.url || "")
                    + (failure.count > 1 ? " · x" + failure.count : "")
                meta.style.cssText = [
                    "margin-top:4px",
                    "font-family:var(--aes-font-mono, monospace)",
                    "font-size:10px",
                    "color:var(--aes-slate, #475569)",
                    "overflow-wrap:anywhere"
                ].join(";")

                row.append(label, message, meta)
                body.appendChild(row)
            }
        }

        overlay.append(header, body)
        document.body.appendChild(overlay)
    }

    #openStrategyPanel(opts) {
        const sp = window.AesStrategyPanel
        if (!sp || typeof sp.open !== "function") {
            this.#showNotice("Strategy is loaded on the dashboard and fleet pages. Open one of those pages, then try again.", "warn")
            return
        }
        try {
            const ret = sp.open(opts || {})
            if (ret && typeof ret.catch === "function") {
                ret.catch(e => {
                    console.warn("[AES menu] Strategy panel open failed", e)
                    this.#showNotice("Strategy panel failed to open. Check the console for details.", "warn")
                })
            }
        } catch (e) {
            console.warn("[AES menu] Strategy panel open threw", e)
            this.#showNotice("Strategy panel failed to open. Check the console for details.", "warn")
        }
    }

    #openStrategySettings() {
        const sp = window.AesStrategyPanel
        if (sp && typeof sp.open === "function") {
            this.#openStrategyPanel({section: "settings", filter: this.#allStrategyDecisionFilter()})
            return
        }
        const us = window.AesUnifiedSettings
        if (!us || typeof us.open !== "function") {
            this.#showNotice("Strategy settings are loaded on the dashboard and fleet pages. Open one of those pages, then try again.", "warn")
            return
        }
        try { us.open({tab: "modules", moduleId: "strategy"}) }
        catch (e) {
            console.warn("[AES menu] Strategy settings open threw", e)
            this.#showNotice("Strategy settings failed to open. Check the console for details.", "warn")
        }
    }

    #openStrategyHubDesigner() {
        const modal = window.AesStrategyHubDesignerModal
        if (!modal || typeof modal.open !== "function") {
            this.#showNotice("Hub Network Designer is loaded from the dashboard strategy bundle.", "warn")
            return
        }
        try {
            const ret = modal.open()
            if (ret && typeof ret.catch === "function") {
                ret.catch(e => {
                    console.warn("[AES menu] Hub Designer open failed", e)
                    this.#showNotice("Hub Network Designer failed to open. Check the console for details.", "warn")
                })
            }
        } catch (e) {
            console.warn("[AES menu] Hub Designer open threw", e)
            this.#showNotice("Hub Network Designer failed to open. Check the console for details.", "warn")
        }
    }

    #openStrategyLayered() {
        const panel = window.AesStrategyLayeredPanel
        if (!panel || typeof panel.open !== "function") {
            this.#showNotice("Layered strategy overrides are loaded from the dashboard strategy bundle.", "warn")
            return
        }
        try {
            const ret = panel.open({scope: "family"})
            if (ret && typeof ret.catch === "function") {
                ret.catch(e => {
                    console.warn("[AES menu] Layered strategy open failed", e)
                    this.#showNotice("Layered strategy overrides failed to open. Check the console for details.", "warn")
                })
            }
        }
        catch (e) {
            console.warn("[AES menu] Layered strategy open threw", e)
            this.#showNotice("Layered strategy overrides failed to open. Check the console for details.", "warn")
        }
    }

    #openCommandBridge() {
        const fallback = () => {
            try {
                if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
                    window.open(chrome.runtime.getURL("bridge.html"), "aes-bridge")
                }
            } catch (_) { /* noop */ }
        }

        const callback = (resp, err) => {
            if (err && window.AESSiteSkin?.handleInvalidatedContext
                    && window.AESSiteSkin.handleInvalidatedContext(err)) return
            if (err || !resp || !resp.ok) fallback()
        }

        if (window.AESSiteSkin?.safeRuntimeSendMessage) {
            try {
                const sent = window.AESSiteSkin.safeRuntimeSendMessage(
                    {type: "aes:bridge:open"},
                    callback
                )
                if (sent !== false) return
            } catch (_) { /* fall through */ }
        }

        try {
            chrome.runtime.sendMessage({type: "aes:bridge:open"}, (resp) => {
                const lastErr = chrome.runtime.lastError
                callback(resp, lastErr || null)
            })
        } catch (_) {
            fallback()
        }
    }

    #ensureShortcutApi() {
        if (typeof window === "undefined") return
        const skin = window.AESSiteSkin = window.AESSiteSkin || {}
        if (typeof skin.showShortcuts === "function"
                && typeof skin.hideShortcuts === "function") return

        let helpEl = null
        let overlayEl = null

        const hide = () => {
            if (helpEl) { helpEl.remove(); helpEl = null }
            if (overlayEl) { overlayEl.remove(); overlayEl = null }
            document.removeEventListener("keydown", onKeydown, true)
        }

        const onKeydown = (ev) => {
            if (ev.key === "Escape") {
                hide()
                ev.preventDefault()
            }
        }

        const show = () => {
            if (helpEl) { hide(); return }

            overlayEl = document.createElement("div")
            overlayEl.className = "aes-skin-help__overlay"
            overlayEl.style.cssText = [
                "position:fixed",
                "inset:0",
                "background:rgba(15,23,42,0.38)",
                "z-index:2147483646"
            ].join(";")
            overlayEl.addEventListener("click", hide)

            helpEl = document.createElement("div")
            helpEl.className = "aes-skin-help"
            helpEl.setAttribute("role", "dialog")
            helpEl.setAttribute("aria-modal", "true")
            helpEl.setAttribute("aria-label", "AES Shortcuts")
            helpEl.style.cssText = [
                "position:fixed",
                "top:12vh",
                "left:50%",
                "transform:translateX(-50%)",
                "width:min(560px, calc(100vw - 32px))",
                "max-height:76vh",
                "overflow:auto",
                "background:var(--aes-bone, #fffaf0)",
                "color:var(--aes-oxide, #1f2937)",
                "border:var(--aes-bw-2, 2px) solid var(--aes-oxide, #1f2937)",
                "box-shadow:0 18px 40px rgba(15,23,42,0.22)",
                "z-index:2147483647",
                "font-family:var(--aes-font-display, system-ui, sans-serif)"
            ].join(";")

            const header = document.createElement("div")
            header.className = "aes-skin-help__header"
            header.style.cssText = [
                "display:flex",
                "align-items:center",
                "justify-content:space-between",
                "gap:12px",
                "padding:12px 16px",
                "border-bottom:1px solid var(--aes-paper-rule, #d6d3ca)"
            ].join(";")

            const title = document.createElement("h3")
            title.className = "aes-skin-help__title"
            title.textContent = "AES Shortcuts"
            title.style.cssText = "margin:0;font-size:16px;text-transform:uppercase;letter-spacing:var(--aes-tracking-caps, .06em);"

            const close = document.createElement("button")
            close.type = "button"
            close.className = "aes-modal__close"
            close.textContent = "×"
            close.setAttribute("aria-label", "Close shortcuts")
            close.style.cssText = [
                "border:1px solid var(--aes-oxide, #1f2937)",
                "background:transparent",
                "color:inherit",
                "min-width:28px",
                "height:28px",
                "cursor:pointer"
            ].join(";")
            close.addEventListener("click", hide)
            header.append(title, close)

            const body = document.createElement("div")
            body.className = "aes-skin-help__body"
            body.style.cssText = "padding:8px 16px 16px;"
            for (const sc of this.#shortcutRows()) {
                const row = document.createElement("div")
                row.className = "aes-skin-help__row"
                row.style.cssText = [
                    "display:flex",
                    "align-items:center",
                    "gap:14px",
                    "padding:8px 0",
                    "border-bottom:1px solid var(--aes-paper-rule, #d6d3ca)"
                ].join(";")

                const keys = document.createElement("span")
                keys.className = "aes-skin-help__keys"
                keys.textContent = sc.keys
                keys.style.cssText = [
                    "flex:0 0 116px",
                    "font-family:var(--aes-font-mono, monospace)",
                    "font-size:12px",
                    "text-transform:uppercase",
                    "color:var(--aes-rust, #9a3412)"
                ].join(";")

                const desc = document.createElement("span")
                desc.className = "aes-skin-help__desc"
                desc.textContent = sc.desc
                desc.style.cssText = "flex:1 1 auto;min-width:0;"
                row.append(keys, desc)
                body.append(row)
            }

            helpEl.append(header, body)
            document.body.append(overlayEl, helpEl)
            document.addEventListener("keydown", onKeydown, true)
            close.focus()
        }

        if (typeof skin.showShortcuts !== "function") skin.showShortcuts = show
        if (typeof skin.hideShortcuts !== "function") skin.hideShortcuts = hide
    }

    #showShortcuts() {
        this.#ensureShortcutApi()
        try {
            if (window.AESSiteSkin?.showShortcuts) window.AESSiteSkin.showShortcuts()
        } catch (_) { /* noop */ }
    }

    #shortcutRows() {
        try {
            const reg = window.AESShortcutRegistry
            if (reg && typeof reg.resolved === "function") {
                return reg.resolved()
                    .filter(sc => sc && !sc.disabled && sc.keys && sc.desc)
                    .map(sc => ({keys: sc.keys, desc: sc.desc}))
            }
        } catch (_) { /* fall through */ }

        return [
            {keys: "Cmd-K", desc: "Open command palette"},
            {keys: "g d", desc: "Dashboard"},
            {keys: "g f", desc: "Fleets"},
            {keys: "g a", desc: "Accounting"},
            {keys: "g x", desc: "Settings"},
            {keys: "/", desc: "Focus search or filter"},
            {keys: "?", desc: "Show shortcuts"},
            {keys: "Esc", desc: "Close popover or help"}
        ]
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
                this.#setMenuOpen(false)
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
        labelEl.textContent = content.label + (typeof content.stateLabel === "function" ? " " : "")
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

;(function () {
    if (typeof window === "undefined") return
    if (window.top !== window) return
    if (window.__aesMenuInstalled) return
    window.__aesMenuInstalled = true

    const MAX_WAIT_MS = 10000
    const POLL_MS = 200
    let waited = 0

    function findTarget() {
        const nav = document.querySelector("#as-navbar-main-collapse .navbar-nav")
        if (!nav) return null
        return nav.children[4] || nav.lastElementChild
    }

    function tick() {
        if (document.querySelector("#as-navbar-main-collapse .navbar-nav .aes-menu__trigger")) return
        const target = findTarget()
        if (!target) {
            waited += POLL_MS
            if (waited >= MAX_WAIT_MS) {
                console.warn("[AES Menu] navbar anchor not found; skipping mount")
                if (window.AesInit && typeof window.AesInit.record === "function") {
                    window.AesInit.record("aes-menu.anchor", "navbar anchor not found after " + MAX_WAIT_MS + "ms")
                }
                return
            }
            setTimeout(tick, POLL_MS)
            return
        }
        try {
            new AESMenu(target)
        } catch (err) {
            console.warn("[AES Menu] mount failed", err)
            if (window.AesInit && typeof window.AesInit.record === "function") {
                window.AesInit.record("aes-menu.mount", err)
            }
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", tick, {once: true})
    } else {
        tick()
    }
})()
