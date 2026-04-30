"use strict"

/**
 * AES Command Palette — host (DOM, keybind, query/render).
 *
 * Cmd-K (Mac) / Ctrl-K (Win/Linux) opens a centered modal that lists every
 * command registered with `AESCommandRegistry` whose scope matches the
 * current page. Up/Down navigates, Enter dispatches, Esc closes. Empty query
 * shows the recent-command ring; typing filters by case-insensitive
 * substring across `label + hint + keywords`.
 *
 * The palette ships with NO commands of its own — the seed files
 * (seed-navigation.js, seed-actions.js) populate the registry. This file
 * is the consumer; future slices add palette presence by registering more
 * commands, never by editing here.
 *
 * Public surface (window.AESCommandPalette):
 *   open()    — show the dialog
 *   close()   — hide
 *   toggle()  — open if closed, close if open
 *   dispatch(id) — run a command by id (also closes the palette if open)
 *
 * Defensive guards:
 *   - typing in input/textarea/contentEditable → keybind is a no-op so the
 *     user's typed K reaches the field
 *   - body not mounted yet → open() bails (very early page-load)
 *   - registry missing → host installs a no-op global so callers don't
 *     have to feature-detect
 */
;(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return
    if (window.AESCommandPalette) return
    if (!window.AESCommandRegistry) {
        window.AESCommandPalette = {
            open: () => {}, close: () => {}, toggle: () => {}, dispatch: () => {}
        }
        return
    }

    const reg = window.AESCommandRegistry

    const STYLE_ID  = "aes-command-palette-style"
    const HOST_ID   = "aes-command-palette"

    const SCOPE = _resolveScope()
    _maybeRecordHub()

    let modal = null
    let backdrop = null
    let inputEl = null
    let listEl = null
    let footerEl = null
    let curResults = []
    let selectedIndex = 0
    let isOpen = false

    /* ------------------------------------------------------------------- */
    /*  Scope detection                                                     */
    /* ------------------------------------------------------------------- */

    function _resolveScope() {
        const p = location.pathname
        if (/^\/app\/com\/scheduling\b/.test(p)) return "scheduling"
        if (/^\/app\/fleets\/aircraft\/[^/]+\/0\b/.test(p)) return "afp"
        if (/^\/app\/fleets\b/.test(p)) return "fleets"
        if (/^\/app\/enterprise\/dashboard\b/.test(p)) return "dashboard"
        return "any"
    }

    function _maybeRecordHub() {
        const m = location.pathname.match(/^\/app\/com\/scheduling\/([^/?#]+)/)
        if (!m) return
        try { localStorage.setItem("aesCommandPalette:lastHub", m[1]) }
        catch (_) { /* noop — privacy/quota */ }
    }

    /* ------------------------------------------------------------------- */
    /*  Keybind                                                             */
    /* ------------------------------------------------------------------- */

    function _isTypingTarget(el) {
        if (!el) return false
        if (el.isContentEditable) return true
        const tag = el.tagName
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
    }

    function _isToggleChord(e) {
        if (e.key !== "k" && e.key !== "K") return false
        if (!(e.ctrlKey || e.metaKey)) return false
        if (e.altKey || e.shiftKey) return false
        return true
    }

    function _onDocumentKeydown(e) {
        if (_isToggleChord(e)) {
            if (_isTypingTarget(e.target) && !isOpen) return
            e.preventDefault()
            e.stopPropagation()
            toggle()
            return
        }
        if (!isOpen) return
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation()
            close()
            return
        }
        if (e.key === "ArrowDown") {
            e.preventDefault(); e.stopPropagation()
            _moveSelection(1)
            return
        }
        if (e.key === "ArrowUp") {
            e.preventDefault(); e.stopPropagation()
            _moveSelection(-1)
            return
        }
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation()
            _dispatchSelected()
            return
        }
        if (e.key === "Tab") {
            e.preventDefault(); e.stopPropagation()
            _moveSelection(e.shiftKey ? -1 : 1)
            return
        }
    }

    document.addEventListener("keydown", _onDocumentKeydown, true)

    /* ------------------------------------------------------------------- */
    /*  Styles                                                              */
    /* ------------------------------------------------------------------- */

    function _ensureStyle() {
        if (document.getElementById(STYLE_ID)) return
        const style = document.createElement("style")
        style.id = STYLE_ID
        style.textContent = `
            #${HOST_ID}-backdrop {
                position: fixed; inset: 0;
                background: rgba(26, 22, 18, 0.55);
                z-index: calc(var(--aes-z-modal) - 1);
                opacity: 0; transition: opacity var(--aes-tr-medium);
            }
            #${HOST_ID}-backdrop.open { opacity: 1; }
            #${HOST_ID} {
                position: fixed;
                top: 18vh; left: 50%; transform: translateX(-50%) translateY(-12px);
                width: min(640px, calc(100vw - 32px));
                max-height: 70vh; display: flex; flex-direction: column;
                background: var(--aes-bone); color: var(--aes-oxide);
                border: var(--aes-bw-2) solid var(--aes-oxide);
                border-radius: var(--aes-radius);
                box-shadow: 6px 6px 0 0 var(--aes-oxide);
                font-family: var(--aes-font-display);
                font-size: var(--aes-fs-body); line-height: var(--aes-lh-body);
                z-index: var(--aes-z-modal);
                opacity: 0; transition: opacity var(--aes-tr-medium), transform var(--aes-tr-medium);
                overflow: hidden;
            }
            #${HOST_ID}.open { opacity: 1; transform: translateX(-50%) translateY(0); }
            #${HOST_ID}-input {
                appearance: none; -webkit-appearance: none;
                width: 100%;
                padding: var(--aes-sp-3) var(--aes-sp-4);
                background: transparent; color: var(--aes-oxide);
                border: 0; border-bottom: var(--aes-bw-1) solid var(--aes-paper-rule);
                font-family: var(--aes-font-display);
                font-size: var(--aes-fs-lead);
                outline: none;
            }
            #${HOST_ID}-input::placeholder { color: var(--aes-slate); font-style: normal; }
            #${HOST_ID}-list {
                list-style: none; margin: 0; padding: var(--aes-sp-1) 0;
                overflow-y: auto; flex: 1 1 auto;
            }
            #${HOST_ID}-list .row {
                display: flex; align-items: center; gap: var(--aes-sp-3);
                padding: var(--aes-sp-2) var(--aes-sp-4);
                cursor: pointer;
                border-left: var(--aes-bw-3) solid transparent;
                transition: background var(--aes-tr-fast);
            }
            #${HOST_ID}-list .row.selected {
                background: var(--aes-rust-soft);
                border-left-color: var(--aes-rust);
            }
            #${HOST_ID}-list .row:hover { background: var(--aes-bone-2); }
            #${HOST_ID}-list .row.selected:hover { background: var(--aes-rust-soft); }
            #${HOST_ID}-list .label {
                color: var(--aes-oxide);
                font-family: var(--aes-font-display);
                font-weight: var(--aes-fw-medium);
                flex: 0 0 auto;
            }
            #${HOST_ID}-list .hint {
                color: var(--aes-slate);
                font-family: var(--aes-font-display);
                font-size: var(--aes-fs-small);
                flex: 1 1 auto; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            #${HOST_ID}-list .scope {
                color: var(--aes-rust);
                background: var(--aes-rust-soft);
                border: var(--aes-bw-1) solid var(--aes-rust);
                font-family: var(--aes-font-mono);
                font-size: var(--aes-fs-micro);
                padding: 1px var(--aes-sp-2);
                border-radius: var(--aes-radius);
                text-transform: uppercase;
                letter-spacing: var(--aes-tracking-mono);
                flex: 0 0 auto;
            }
            #${HOST_ID}-list .recent-tag {
                color: var(--aes-cobalt);
                background: var(--aes-cobalt-soft);
                border: var(--aes-bw-1) solid var(--aes-cobalt);
                font-family: var(--aes-font-mono);
                font-size: var(--aes-fs-micro);
                padding: 1px var(--aes-sp-2);
                border-radius: var(--aes-radius);
                text-transform: uppercase;
                letter-spacing: var(--aes-tracking-mono);
                flex: 0 0 auto;
            }
            #${HOST_ID}-list .empty {
                padding: var(--aes-sp-4);
                color: var(--aes-slate);
                text-align: center;
                font-family: var(--aes-font-mono);
                font-size: var(--aes-fs-small);
                text-transform: uppercase;
                letter-spacing: var(--aes-tracking-mono);
            }
            #${HOST_ID}-footer {
                padding: var(--aes-sp-2) var(--aes-sp-3);
                font-family: var(--aes-font-mono);
                font-size: var(--aes-fs-micro);
                color: var(--aes-slate);
                border-top: var(--aes-bw-1) solid var(--aes-paper-rule);
                display: flex; gap: var(--aes-sp-3); justify-content: flex-end;
                text-transform: uppercase;
                letter-spacing: var(--aes-tracking-mono);
            }
            #${HOST_ID}-footer kbd {
                background: var(--aes-bone-2);
                color: var(--aes-oxide);
                padding: 1px var(--aes-sp-2);
                border-radius: var(--aes-radius);
                border: var(--aes-bw-1) solid var(--aes-oxide);
                font-family: var(--aes-font-mono);
                font-size: var(--aes-fs-micro);
            }
        `
        document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------- */
    /*  DOM build                                                           */
    /* ------------------------------------------------------------------- */

    function _build() {
        if (modal) return
        _ensureStyle()

        backdrop = document.createElement("div")
        backdrop.id = HOST_ID + "-backdrop"
        backdrop.addEventListener("click", () => close())

        modal = document.createElement("div")
        modal.id = HOST_ID
        modal.setAttribute("role", "dialog")
        modal.setAttribute("aria-label", "AES command palette")

        inputEl = document.createElement("input")
        inputEl.id = HOST_ID + "-input"
        inputEl.type = "text"
        inputEl.autocomplete = "off"
        inputEl.spellcheck = false
        inputEl.placeholder = "Type to search commands…"
        inputEl.setAttribute("role", "combobox")
        inputEl.setAttribute("aria-expanded", "true")
        inputEl.setAttribute("aria-controls", HOST_ID + "-list")
        inputEl.setAttribute("aria-autocomplete", "list")
        inputEl.addEventListener("input", _refresh)

        listEl = document.createElement("ul")
        listEl.id = HOST_ID + "-list"
        listEl.setAttribute("role", "listbox")

        footerEl = document.createElement("div")
        footerEl.id = HOST_ID + "-footer"
        footerEl.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>"
            + "<span><kbd>↵</kbd> run</span>"
            + "<span><kbd>Esc</kbd> close</span>"

        modal.append(inputEl, listEl, footerEl)
    }

    /* ------------------------------------------------------------------- */
    /*  Render                                                              */
    /* ------------------------------------------------------------------- */

    function _refresh() {
        const query = (inputEl && inputEl.value) || ""
        curResults = reg.list({scope: SCOPE, query})
        if (!query.trim()) {
            const recentIds = reg.recent().map(r => r.id)
            const recentSet = new Set(recentIds)
            const recentCmds = []
            const others = []
            for (const c of curResults) {
                if (recentSet.has(c.id)) recentCmds.push(c)
                else others.push(c)
            }
            recentCmds.sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id))
            curResults = recentCmds.concat(others)
        }
        selectedIndex = 0
        _renderList()
    }

    function _renderList() {
        if (!listEl) return
        listEl.textContent = ""
        if (!curResults.length) {
            const empty = document.createElement("li")
            empty.className = "empty"
            empty.textContent = inputEl && inputEl.value
                ? `No commands match "${inputEl.value.trim()}"`
                : "No commands available on this page"
            listEl.append(empty)
            _syncActiveDescendant()
            return
        }
        const recentIds = new Set(reg.recent().map(r => r.id))
        const showingRecent = !((inputEl && inputEl.value) || "").trim()
        for (let i = 0; i < curResults.length; i++) {
            const cmd = curResults[i]
            const row = document.createElement("li")
            row.id = HOST_ID + "-row-" + i
            row.className = "row" + (i === selectedIndex ? " selected" : "")
            row.dataset.cmdId = cmd.id
            row.setAttribute("role", "option")
            row.setAttribute("aria-selected", i === selectedIndex ? "true" : "false")

            const label = document.createElement("span")
            label.className = "label"
            label.textContent = cmd.label

            const hint = document.createElement("span")
            hint.className = "hint"
            hint.textContent = cmd.hint || ""

            row.append(label, hint)

            if (showingRecent && recentIds.has(cmd.id)) {
                const tag = document.createElement("span")
                tag.className = "recent-tag"
                tag.textContent = "recent"
                row.append(tag)
            } else if (cmd.scope && cmd.scope !== "any") {
                const tag = document.createElement("span")
                tag.className = "scope"
                tag.textContent = cmd.scope
                row.append(tag)
            }

            row.addEventListener("mouseenter", () => {
                selectedIndex = i
                _updateSelectedClass()
            })
            row.addEventListener("click", (e) => {
                e.preventDefault()
                selectedIndex = i
                _dispatchSelected()
            })
            listEl.append(row)
        }
        _syncActiveDescendant()
    }

    function _syncActiveDescendant() {
        if (!inputEl) return
        const cur = listEl && listEl.children && listEl.children[selectedIndex]
        if (cur && cur.id) inputEl.setAttribute("aria-activedescendant", cur.id)
        else inputEl.removeAttribute("aria-activedescendant")
    }

    function _updateSelectedClass() {
        if (!listEl) return
        const rows = listEl.querySelectorAll(".row")
        for (let i = 0; i < rows.length; i++) {
            const sel = (i === selectedIndex)
            rows[i].classList.toggle("selected", sel)
            rows[i].setAttribute("aria-selected", sel ? "true" : "false")
        }
        const cur = rows[selectedIndex]
        if (cur && typeof cur.scrollIntoView === "function") {
            cur.scrollIntoView({block: "nearest"})
        }
        _syncActiveDescendant()
    }

    function _moveSelection(delta) {
        if (!curResults.length) return
        selectedIndex = (selectedIndex + delta + curResults.length) % curResults.length
        _updateSelectedClass()
    }

    /* ------------------------------------------------------------------- */
    /*  Open / close / dispatch                                             */
    /* ------------------------------------------------------------------- */

    function open() {
        if (isOpen) return
        if (!document.body) return
        _build()
        if (!modal.parentNode) document.body.append(backdrop, modal)
        isOpen = true
        if (inputEl) inputEl.value = ""
        _refresh()
        requestAnimationFrame(() => {
            if (backdrop) backdrop.classList.add("open")
            if (modal) modal.classList.add("open")
            if (inputEl) inputEl.focus()
        })
        _emitBus("opened")
    }

    function close() {
        if (!isOpen) return
        isOpen = false
        if (backdrop) backdrop.classList.remove("open")
        if (modal) modal.classList.remove("open")
        setTimeout(() => {
            if (!isOpen && backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop)
            if (!isOpen && modal && modal.parentNode) modal.parentNode.removeChild(modal)
        }, 140)
        _emitBus("closed")
    }

    function toggle() {
        if (isOpen) close()
        else open()
    }

    function _dispatchSelected() {
        const cmd = curResults[selectedIndex]
        if (!cmd) return
        dispatch(cmd.id)
    }

    function dispatch(id) {
        const wasOpen = isOpen
        if (wasOpen) close()
        _emitBus("invoked", {id})
        Promise.resolve(reg.dispatch(id)).catch((e) => {
            console.warn("[AES palette] dispatch threw", id, e)
        })
    }

    function _emitBus(kind, payload) {
        try {
            const evt = "command-palette:" + kind
            const data = Object.assign({scope: SCOPE, at: Date.now()}, payload || {})
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit(evt, data)
            }
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit("data:command-palette:" + kind, data)
            }
        } catch (_) { /* bus is best-effort */ }
    }

    window.AESCommandPalette = {open, close, toggle, dispatch}
})()
