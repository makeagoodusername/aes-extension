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
                background: rgba(0, 0, 0, 0.45);
                z-index: 2147483646;
                opacity: 0; transition: opacity 120ms ease;
            }
            #${HOST_ID}-backdrop.open { opacity: 1; }
            #${HOST_ID} {
                position: fixed;
                top: 18vh; left: 50%; transform: translateX(-50%) translateY(-12px);
                width: min(640px, calc(100vw - 32px));
                max-height: 70vh; display: flex; flex-direction: column;
                background: #181a1f; color: #d8dde6;
                border: 1px solid #2c313a; border-radius: 10px;
                box-shadow: 0 20px 50px -12px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.35);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px; line-height: 1.4;
                z-index: 2147483647;
                opacity: 0; transition: opacity 120ms ease, transform 120ms ease;
                overflow: hidden;
            }
            #${HOST_ID}.open { opacity: 1; transform: translateX(-50%) translateY(0); }
            #${HOST_ID}-input {
                appearance: none; -webkit-appearance: none;
                width: 100%; padding: 14px 16px;
                background: transparent; color: #f1f3f7;
                border: 0; border-bottom: 1px solid #2c313a;
                font-size: 15px; outline: none;
            }
            #${HOST_ID}-input::placeholder { color: #6a7280; }
            #${HOST_ID}-list {
                list-style: none; margin: 0; padding: 6px 0;
                overflow-y: auto; flex: 1 1 auto;
            }
            #${HOST_ID}-list .row {
                display: flex; align-items: center; gap: 12px;
                padding: 9px 16px; cursor: pointer;
                border-left: 3px solid transparent;
            }
            #${HOST_ID}-list .row.selected {
                background: #232730; border-left-color: #5fa8ff;
            }
            #${HOST_ID}-list .row:hover { background: #20242c; }
            #${HOST_ID}-list .label { color: #f1f3f7; font-weight: 500; flex: 0 0 auto; }
            #${HOST_ID}-list .hint  {
                color: #8a93a3; font-size: 12px;
                flex: 1 1 auto; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            #${HOST_ID}-list .scope {
                color: #5fa8ff; background: rgba(95,168,255,0.1);
                font-size: 10px; padding: 2px 7px; border-radius: 9px;
                text-transform: uppercase; letter-spacing: 0.4px;
                flex: 0 0 auto;
            }
            #${HOST_ID}-list .recent-tag {
                color: #d3a04c; background: rgba(211,160,76,0.12);
                font-size: 10px; padding: 2px 7px; border-radius: 9px;
                text-transform: uppercase; letter-spacing: 0.4px;
                flex: 0 0 auto;
            }
            #${HOST_ID}-list .empty {
                padding: 16px; color: #6a7280; text-align: center; font-style: italic;
            }
            #${HOST_ID}-footer {
                padding: 8px 14px; font-size: 11px; color: #6a7280;
                border-top: 1px solid #2c313a;
                display: flex; gap: 14px; justify-content: flex-end;
            }
            #${HOST_ID}-footer kbd {
                background: #232730; color: #d8dde6;
                padding: 1px 6px; border-radius: 4px; font-size: 10px;
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                border: 1px solid #2c313a;
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
            return
        }
        const recentIds = new Set(reg.recent().map(r => r.id))
        const showingRecent = !((inputEl && inputEl.value) || "").trim()
        for (let i = 0; i < curResults.length; i++) {
            const cmd = curResults[i]
            const row = document.createElement("li")
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
