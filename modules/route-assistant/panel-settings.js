/**
 * Settings Drawer UI features for RouteAssistantPanel.
 * Mixed into RouteAssistantPanel.prototype.
 */

if (typeof window.RouteAssistantPanel !== "undefined") {
    /**
     * Export the entire `settings.routeAssistant` + `settings.usedAircraftScanner`
     * blobs as a downloadable JSON file. Wrap-format envelope is documented
     * next to AES_CONFIG_FORMAT below.
     */
    window.RouteAssistantPanel.prototype._exportConfig = async function() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const manifest = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
            ? chrome.runtime.getManifest()
            : {}
        const envelope = {
            format:              AES_CONFIG_FORMAT,
            version:             manifest.version_name || manifest.version || "unknown",
            exportedAt:          new Date().toISOString(),
            server:              this.server || "",
            routeAssistant:      settings.routeAssistant || {},
            usedAircraftScanner: settings.usedAircraftScanner || {}
        }
        const json = JSON.stringify(envelope, null, 2)
        const blob = new Blob([json], {type: "application/json"})
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = "aes-config-" + (this.server || "world") + "-"
            + new Date().toISOString().slice(0, 10) + ".json"
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        if (typeof RouteAssistantToast !== "undefined") {
            RouteAssistantToast.success("Exported " + a.download)
        }
    }

    /**
     * Open the system file picker for an AES config JSON, validate it,
     * compute the diff against current settings, and show a modal listing
     * every change with Apply / Cancel. On Apply both blobs are written
     * back through their respective stores (which deep-merge against
     * defaults for any missing keys).
     */
    window.RouteAssistantPanel.prototype._openImportConfig = function() {
        const input = document.createElement("input")
        input.type = "file"
        input.accept = "application/json,.json"
        input.style.display = "none"
        input.addEventListener("change", async () => {
            const file = input.files && input.files[0]
            document.body.removeChild(input)
            if (!file) return
            let parsed
            try {
                const text = await file.text()
                parsed = JSON.parse(text)
            } catch (e) {
                this._noteToast("Couldn't parse JSON: " + e.message, true)
                return
            }
            if (!parsed || parsed.format !== AES_CONFIG_FORMAT) {
                this._noteToast("Not a valid AES config file (expected format: \""
                    + AES_CONFIG_FORMAT + "\").", true)
                return
            }
            // Defend against hand-edited JSON where a namespace was replaced
            // with a non-object — _diffConfig would otherwise walk Object.keys
            // on a string/array and produce nonsense rows.
            if (parsed.routeAssistant !== undefined && !_isPlainObject(parsed.routeAssistant)) {
                this._noteToast("Config file shape is invalid (routeAssistant must be an object).", true)
                return
            }
            if (parsed.usedAircraftScanner !== undefined && !_isPlainObject(parsed.usedAircraftScanner)) {
                this._noteToast("Config file shape is invalid (usedAircraftScanner must be an object).", true)
                return
            }
            const data = await chrome.storage.local.get(["settings"])
            const cur = data.settings || {}
            const changes = _diffConfig(
                {routeAssistant: cur.routeAssistant || {}, usedAircraftScanner: cur.usedAircraftScanner || {}},
                {routeAssistant: parsed.routeAssistant || {}, usedAircraftScanner: parsed.usedAircraftScanner || {}}
            )
            this._showImportDiffModal(parsed, changes)
        })
        document.body.appendChild(input)
        input.click()
    }

    /**
     * Floating modal listing every changed leaf path in the import diff.
     * Apply writes both blobs back via their stores; Cancel discards.
     * No-changes case still shows the modal so the user knows the file
     * matched their current state (and didn't silently no-op).
     */
    window.RouteAssistantPanel.prototype._showImportDiffModal = function(parsed, changes) {
        const overlay = document.createElement("div")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);"
            + "z-index:10001;display:flex;align-items:center;justify-content:center;"
        const modal = document.createElement("div")
        modal.style.cssText = "background:#1f2937;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:6px;padding:12px 16px;min-width:480px;max-width:80vw;"
            + "max-height:80vh;display:flex;flex-direction:column;font:13px/1.4 sans-serif;"

        // Partition changes by namespace so the per-section toggles can hide
        // their rows without rebuilding the list, and Apply can gate each
        // store's save() independently.
        const raChanges  = changes.filter(c => c.path.startsWith("routeAssistant."))
        const uasChanges = changes.filter(c => c.path.startsWith("usedAircraftScanner."))

        const h = document.createElement("strong")
        h.textContent = "Import AES config — " + changes.length + " change"
            + (changes.length === 1 ? "" : "s")
        h.style.cssText = "font-size:14px;margin-bottom:6px;"

        const meta = document.createElement("div")
        meta.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:8px;"
        meta.textContent = "From: v" + (parsed.version || "?") + "  ·  exported "
            + (parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString() : "?")
            + (parsed.server ? "  ·  server " + parsed.server : "")

        // Version-skew warning — informational only, never blocks Apply. The
        // deep-merge in each store's save() handles missing/extra keys, but
        // a renamed key would silently land in the wrong place, so the user
        // should eyeball the diff before committing across versions.
        const currentVersion = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
            ? (chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version || "")
            : ""
        let skewBanner = null
        if (parsed.version && currentVersion && parsed.version !== currentVersion) {
            skewBanner = document.createElement("div")
            skewBanner.style.cssText = "margin:0 0 8px 0;padding:6px 10px;"
                + "background:rgba(245, 158, 11, 0.12);border:1px solid rgba(245, 158, 11, 0.40);"
                + "border-radius:4px;color:#fcd34d;font-size:11px;"
            skewBanner.textContent = "⚠ Imported from v" + parsed.version
                + ". You're on v" + currentVersion
                + ". Schema may have changed shape; review the diff carefully."
        }

        // Per-namespace toggles — disabled when the namespace isn't present
        // in the envelope. State drives both the row visibility and which
        // save() runs at Apply time.
        const raPresent  = parsed.routeAssistant !== undefined
        const uasPresent = parsed.usedAircraftScanner !== undefined
        let importRA  = raPresent
        let importUAS = uasPresent

        const toggles = document.createElement("div")
        toggles.style.cssText = "display:flex;gap:14px;margin-bottom:8px;font-size:12px;color:#cbd5e1;"

        const mkToggle = (label, count, present, getter, setter) => {
            const wrap = document.createElement("label")
            wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;cursor:"
                + (present ? "pointer" : "default") + ";"
                + (present ? "" : "opacity:0.45;")
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = getter() && present
            cb.disabled = !present
            cb.style.cursor = present ? "pointer" : "default"
            cb.addEventListener("change", () => {
                setter(cb.checked)
                applyVisibilityAndLabel()
            })
            const txt = document.createElement("span")
            txt.textContent = label + " (" + count + " change"
                + (count === 1 ? "" : "s") + ")"
            wrap.append(cb, txt)
            return wrap
        }
        toggles.append(
            mkToggle("Route Assistant", raChanges.length, raPresent,
                () => importRA, (v) => { importRA = v }),
            mkToggle("Used Aircraft Scanner", uasChanges.length, uasPresent,
                () => importUAS, (v) => { importUAS = v })
        )

        const list = document.createElement("div")
        list.style.cssText = "overflow-y:auto;flex:1;border:1px solid #374151;"
            + "border-radius:4px;padding:6px 8px;margin-bottom:10px;background:#0f1623;"
            + "font-family:ui-monospace,monospace;font-size:11px;"

        // Tag each row with its namespace so toggle handlers can flip
        // display:none without rebuilding the list.
        const rowEntries = []

        if (!changes.length) {
            const p = document.createElement("p")
            p.textContent = "Imported config is identical to current settings — nothing to apply."
            p.style.cssText = "color:#9ca3af;margin:6px 0;"
            list.append(p)
        } else {
            for (const c of changes) {
                const namespace = c.path.startsWith("routeAssistant.")        ? "ra"
                                : c.path.startsWith("usedAircraftScanner.")   ? "uas"
                                                                              : "other"
                const row = document.createElement("div")
                row.style.cssText = "padding:2px 0;border-bottom:1px solid #1f2937;"
                const tagColor = c.kind === "added"   ? "#86efac"
                              : c.kind === "removed" ? "#fca5a5"
                              : "#fde68a"
                const tag = document.createElement("span")
                tag.textContent = c.kind.toUpperCase().padEnd(8, " ")
                tag.style.cssText = "color:" + tagColor + ";font-weight:bold;margin-right:6px;"
                const path = document.createElement("span")
                path.textContent = c.path
                path.style.cssText = "color:#cbd5e1;"
                row.append(tag, path)
                if (c.kind === "changed") {
                    const arrow = document.createElement("div")
                    arrow.style.cssText = "color:#9ca3af;margin-left:64px;"
                    arrow.textContent = _formatDiffValue(c.from) + "  →  " + _formatDiffValue(c.to)
                    row.append(arrow)
                } else if (c.kind === "added") {
                    const arrow = document.createElement("div")
                    arrow.style.cssText = "color:#9ca3af;margin-left:64px;"
                    arrow.textContent = "(new)  →  " + _formatDiffValue(c.to)
                    row.append(arrow)
                } else {
                    const arrow = document.createElement("div")
                    arrow.style.cssText = "color:#9ca3af;margin-left:64px;"
                    arrow.textContent = _formatDiffValue(c.from) + "  →  (removed)"
                    row.append(arrow)
                }
                list.append(row)
                rowEntries.push({row, namespace})
            }
        }

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"
        const cancel = document.createElement("button")
        cancel.textContent = "Cancel"
        Object.assign(cancel.style, smallBtnStyle())
        cancel.style.background = "#374151"
        const apply = document.createElement("button")
        Object.assign(apply.style, smallBtnStyle())

        // Recompute visible-changes count + Apply label whenever a namespace
        // toggle flips. Also flips row visibility in place — checking a box
        // restores rows without rebuilding the list.
        const applyVisibilityAndLabel = () => {
            const visibleCount = (importRA ? raChanges.length : 0)
                + (importUAS ? uasChanges.length : 0)
            for (const e of rowEntries) {
                const show = (e.namespace === "ra"  && importRA)
                          || (e.namespace === "uas" && importUAS)
                          || (e.namespace === "other")
                e.row.style.display = show ? "" : "none"
            }
            if (visibleCount === 0) {
                apply.textContent = "Close"
                apply.style.background = "#374151"
            } else {
                apply.textContent = "Apply " + visibleCount + " change"
                    + (visibleCount === 1 ? "" : "s")
                apply.style.background = ""
            }
        }
        applyVisibilityAndLabel()

        // Lifecycle — single close() removes the overlay AND unbinds both
        // listeners. Previous version only unbound the keydown listener on
        // Escape press, so Cancel/Apply leaked it forever.
        const onKey = (e) => { if (e.key === "Escape") close() }
        const onOverlayClick = (e) => { if (e.target === overlay) close() }
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            document.removeEventListener("keydown", onKey)
            overlay.removeEventListener("click", onOverlayClick)
        }
        cancel.addEventListener("click", close)
        apply.addEventListener("click", async () => {
            const visibleCount = (importRA ? raChanges.length : 0)
                + (importUAS ? uasChanges.length : 0)
            close()
            if (visibleCount === 0) return

            // Per-namespace try/catch so a UAS save failure doesn't bury the
            // fact that the RA save already landed. The user always learns
            // exactly which blob made it into storage.
            const applied = []
            const failed  = []
            if (importRA && parsed.routeAssistant) {
                try {
                    await RouteAssistantSettings.save(parsed.routeAssistant)
                    applied.push("routeAssistant")
                } catch (e) {
                    failed.push({ns: "routeAssistant", err: e && e.message ? e.message : String(e)})
                }
            }
            if (importUAS && parsed.usedAircraftScanner) {
                try {
                    await UsedAircraftPresets.save(parsed.usedAircraftScanner)
                    applied.push("usedAircraftScanner")
                } catch (e) {
                    failed.push({ns: "usedAircraftScanner", err: e && e.message ? e.message : String(e)})
                }
            }
            if (applied.length) {
                try {
                    this.settings = await RouteAssistantSettings.load()
                    this._render()
                } catch (e) {
                    console.warn("[AES routeAssistant] post-import reload failed:", e)
                }
            }
            if (failed.length === 0) {
                this._noteToast("Imported " + applied.length + " section"
                    + (applied.length === 1 ? "" : "s")
                    + ", " + visibleCount + " change"
                    + (visibleCount === 1 ? "" : "s"), false)
            } else if (applied.length > 0) {
                this._noteToast("Partial import — applied " + applied.join(", ")
                    + "; failed " + failed.map(f => f.ns).join(", ")
                    + ": " + failed[0].err, true)
            } else {
                this._noteToast("Import failed: " + failed[0].err, true)
            }
        })
        overlay.addEventListener("click", onOverlayClick)
        document.addEventListener("keydown", onKey)

        btnRow.append(cancel, apply)
        const children = [h, meta]
        if (skewBanner) children.push(skewBanner)
        if (changes.length > 0) children.push(toggles)
        children.push(list, btnRow)
        modal.append(...children)
        overlay.append(modal)
        document.body.appendChild(overlay)
    }

    /**
     * Open a small popup menu anchored to the Config button. Two items:
     * Export → triggers _exportConfig; Import → triggers _openImportConfig.
     * Click outside / Escape closes. Modeled after the panel's other
     * lightweight menus rather than a styled <select>.
     */
    window.RouteAssistantPanel.prototype._openConfigMenu = function(anchor) {
        const existing = document.getElementById("aes-config-menu")
        if (existing) { existing.parentNode.removeChild(existing); return }
        const menu = document.createElement("div")
        menu.id = "aes-config-menu"
        menu.style.cssText = "position:absolute;background:#0f1623;border:1px solid #374151;"
            + "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);z-index:10000;"
            + "padding:4px 0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:200px;"
        const rect = anchor.getBoundingClientRect()
        menu.style.top  = (rect.bottom + 4) + "px"
        menu.style.left = (rect.right  - 200) + "px"
        const mkItem = (label, fn) => {
            const item = document.createElement("div")
            item.textContent = label
            item.style.cssText = "padding:6px 12px;cursor:pointer;"
            item.addEventListener("mouseenter", () => item.style.background = "#1f2937")
            item.addEventListener("mouseleave", () => item.style.background = "")
            item.addEventListener("click", () => { close(); fn() })
            return item
        }
        const close = () => {
            if (menu.parentNode) menu.parentNode.removeChild(menu)
            document.removeEventListener("click", onDocClick, true)
            document.removeEventListener("keydown", onKey)
        }
        const onDocClick = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close() }
        const onKey = (e) => { if (e.key === "Escape") close() }
        menu.append(
            mkItem("Export config → file", () => this._exportConfig()),
            mkItem("Import config ← file", () => this._openImportConfig())
        )
        document.body.appendChild(menu)
        setTimeout(() => {
            document.addEventListener("click",   onDocClick, true)
            document.addEventListener("keydown", onKey)
        }, 0)
    }

    /**
     * Restructure slice C — settings drawer slide-in/out.
     *
     * Was: opened the drawer inline and capped `body.maxHeight = 25vh`,
     * crushing the table to almost nothing while open. The mode pill
     * bar landed on top of that bug because the "table disappeared"
     * complaint was really "table is 25% of normal height + I'm in
     * Wave View at the same time, so I see no rows".
     *
     * Now: slides over the body from the right. Body retains its
     * natural height; the user can keep an eye on the table behind the
     * drawer. Backdrop catches outside clicks; ESC closes it too.
     */
    window.RouteAssistantPanel.prototype._toggleSettings = function() {
        const open = this._drawerHost.dataset.open !== "1"
        this._drawerHost.dataset.open = open ? "1" : "0"
        if (open) {
            // Compute the drawer's top offset so it clears the panel
            // header + status bar + controls bar (all variable-height).
            // The body region is what we want to overlay; the header
            // region must stay visible so the gear button still works.
            const headerOffset = this._computeBodyTopOffset()
            this._drawerHost.style.top = headerOffset + "px"
            this._settingsBackdrop.style.top = headerOffset + "px"
            this._drawerHost.style.transform = "translateX(0)"
            this._settingsBackdrop.style.display = "block"
            // Drawer wins focus: route subsequent renders to the drawer DOM.
            this.settingsHost = this._drawerHost
            this._modalHost = null
            this._renderSettings()
            // ESC handler — installed only while the drawer is open so
            // we don't intercept the user's keystrokes the rest of the
            // time (AS scheduling page has its own keyboard handlers).
            if (!this._settingsEscHandler) {
                this._settingsEscHandler = (e) => {
                    if (e.key === "Escape" && this._drawerHost.dataset.open === "1") {
                        this._toggleSettings()
                    }
                }
                document.addEventListener("keydown", this._settingsEscHandler)
            }
        } else {
            this._drawerHost.style.transform = "translateX(100%)"
            this._settingsBackdrop.style.display = "none"
            if (this._settingsEscHandler) {
                document.removeEventListener("keydown", this._settingsEscHandler)
                this._settingsEscHandler = null
            }
        }
    }

    /**
     * Public — render the settings UI into an arbitrary host element so
     * the unified-settings modal can embed it. Routes subsequent
     * re-renders (triggered by inputs inside the rendered tree) to the
     * same host until either `unmountModalSettings()` is called or the
     * drawer is opened (which reclaims render focus).
     */
    window.RouteAssistantPanel.prototype.renderSettingsInto = function(host) {
        if (!host) return
        this._modalHost   = host
        this.settingsHost = host
        this._renderSettings()
    }

    /**
     * Public — companion to `renderSettingsInto`. Restores render target
     * to the drawer DOM. Safe to call when no modal embed is active.
     */
    window.RouteAssistantPanel.prototype.unmountModalSettings = function() {
        if (!this._modalHost) return
        this._modalHost   = null
        this.settingsHost = this._drawerHost
    }

    window.RouteAssistantPanel.prototype._renderSettings = function() {
        if (!this.settingsHost) return
        this.settingsHost.innerHTML = ""

        // Slice C — sticky drawer header (title + ✕ close). Pins to the
        // top of the side-drawer's scroll area so the user always has one
        // click to close even when scrolled deep into the section list.
        // Negative margin escapes the host's padding so the bar runs
        // edge-to-edge while content below respects the padded inset.
        const drawerHead = document.createElement("div")
        drawerHead.style.cssText = "position:sticky;top:0;z-index:2;"
            + "display:flex;align-items:center;gap:var(--aes-sp-2);"
            + "padding:var(--aes-sp-2) var(--aes-sp-3);"
            + "margin:calc(var(--aes-sp-2) * -1) calc(var(--aes-sp-3) * -1) var(--aes-sp-2);"
            + "background:var(--aes-bone-2);"
            + "border-bottom:var(--aes-bw-1) solid var(--aes-paper-rule);"
        const drawerTitle = document.createElement("strong")
        drawerTitle.textContent = "SETTINGS"
        drawerTitle.style.cssText = "flex:1;font-family:var(--aes-font-display);"
            + "font-weight:var(--aes-fw-display);text-transform:uppercase;"
            + "letter-spacing:var(--aes-tracking-caps);font-size:var(--aes-fs-lead);"
            + "color:var(--aes-oxide);"
        const drawerClose = document.createElement("button")
        drawerClose.type = "button"
        drawerClose.textContent = "✕"
        drawerClose.title = "Close settings (Esc)"
        drawerClose.style.cssText = "background:transparent;color:var(--aes-oxide);"
            + "border:var(--aes-bw-1) solid var(--aes-paper-rule);"
            + "padding:2px 10px;cursor:pointer;font-size:14px;line-height:1;"
        drawerClose.addEventListener("click", () => this._toggleSettings())
        drawerHead.append(drawerTitle, drawerClose)
        this.settingsHost.append(drawerHead)

        // ----- Header
        const scoringHeader = document.createElement("div")
        scoringHeader.innerHTML = "<strong>Score weights & filters</strong>"
        scoringHeader.style.cssText = "margin-bottom:6px;"
        this.settingsHost.append(scoringHeader)

        // ----- Quick presets row
        const presetRow = document.createElement("div")
        presetRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;"
        const presetLabel = document.createElement("span")
        presetLabel.textContent = "Quick presets:"
        presetLabel.style.cssText = "color:#9ca3af;font-size:11px;"
        presetRow.append(presetLabel)
        for (const preset of RouteAssistantPanel.WEIGHT_PRESETS) {
            const btn = document.createElement("button")
            btn.textContent = preset.name
            btn.title = preset.description
            Object.assign(btn.style, smallBtnStyle())
            btn.style.background = "#475569"
            btn.style.fontSize = "10px"
            btn.style.padding = "2px 7px"
            btn.addEventListener("click", () => this._applyWeightPreset(preset))
            presetRow.append(btn)
        }
        this.settingsHost.append(presetRow)

        // U7 + U3 — Columns & groups chooser entry point. One button
        // opens a modal listing every column grouped by COLUMN_GROUPS;
        // each group has a "Collapse group" toggle and per-column
        // checkboxes. State persists to settings.columnPrefs.
        const colsRow = document.createElement("div")
        colsRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:8px;"
        const colsLabel = document.createElement("span")
        colsLabel.textContent = "Columns & groups:"
        colsLabel.style.cssText = "color:#9ca3af;font-size:11px;"
        colsRow.append(colsLabel)
        const colsBtn = document.createElement("button")
        colsBtn.type = "button"
        colsBtn.textContent = "Configure columns…"
        Object.assign(colsBtn.style, smallBtnStyle())
        colsBtn.style.fontSize = "10px"
        colsBtn.style.padding = "2px 7px"
        colsBtn.addEventListener("click", () => this._openColumnPrefsModal())
        colsRow.append(colsBtn)
        const colsSummary = document.createElement("span")
        colsSummary.style.cssText = "color:#9ca3af;font-size:10px;"
        const cp = (this.settings && this.settings.columnPrefs) || {hiddenFields: [], collapsedGroups: []}
        const nHidden    = (cp.hiddenFields || []).length
        const nCollapsed = (cp.collapsedGroups || []).length
        if (nHidden || nCollapsed) {
            const parts = []
            if (nHidden)    parts.push(nHidden    + " hidden")
            if (nCollapsed) parts.push(nCollapsed + " collapsed")
            colsSummary.textContent = "(" + parts.join(", ") + ")"
        }
        colsRow.append(colsSummary)
        this.settingsHost.append(colsRow)

        // ----- Scoring table
        const scoringTable = document.createElement("table")
        scoringTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:8px;"
        scoringTable.innerHTML = `<thead><tr>
            <th style="text-align:center;padding:2px 4px;width:36px;">On</th>
            <th style="text-align:left;padding:2px 4px;">Variable</th>
            <th style="text-align:left;padding:2px 4px;">Direction</th>
            <th style="text-align:right;padding:2px 4px;width:60px;">Weight</th>
            <th style="text-align:right;padding:2px 4px;width:90px;">Min</th>
            <th style="text-align:right;padding:2px 4px;width:90px;">Max</th>
        </tr></thead>`
        const tbody = document.createElement("tbody")
        scoringTable.append(tbody)

        const settingsMode = this._currentViewMode()
        for (const f of RouteAssistantPanel.SCORING_FIELDS) {
            // Hide scoring rows that don't apply to the active tab so
            // the user doesn't toggle a field that's silently ignored
            // by the current view's score blend.
            if (Array.isArray(f.modes) && f.modes.indexOf(settingsMode) < 0) continue
            const cfg = this.settings.scoring[f.field] = Object.assign(
                {enabled: false, weight: 1, direction: f.direction, min: null, max: null},
                this.settings.scoring[f.field] || {}
            )
            const tr = document.createElement("tr")
            const groupTint = (RouteAssistantPanel.COLUMN_GROUPS[f.group] || {}).tint
            if (groupTint) tr.style.background = groupTint

            const cb = mkInput("checkbox", null)
            cb.checked = !!cfg.enabled

            const dirSel = mkSelect([
                {value: "higher", label: "higher = better"},
                {value: "lower",  label: "lower = better"}
            ], cfg.direction || f.direction)

            const w = mkInput("number", cfg.weight)
            w.min = "0"; w.step = "0.5"; w.style.width = "55px"

            const mn = mkSuggestSelect(cfg.min, f.suggestedValues)
            const mx = mkSuggestSelect(cfg.max, f.suggestedValues)

            const td1 = document.createElement("td")
            td1.style.cssText = "padding:2px 4px;text-align:center;"
            td1.append(cb); tr.append(td1)

            const td2 = document.createElement("td")
            td2.style.cssText = "padding:2px 4px;"
            td2.textContent = f.label
            tr.append(td2)

            const td3 = document.createElement("td")
            td3.style.cssText = "padding:2px 4px;"
            td3.append(dirSel); tr.append(td3)

            const td4 = document.createElement("td")
            td4.style.cssText = "padding:2px 4px;text-align:right;"
            td4.append(w); tr.append(td4)

            const td5 = document.createElement("td")
            td5.style.cssText = "padding:2px 4px;text-align:right;"
            td5.append(mn); tr.append(td5)

            const td6 = document.createElement("td")
            td6.style.cssText = "padding:2px 4px;text-align:right;"
            td6.append(mx); tr.append(td6)

            tbody.append(tr)

            const sync = async () => {
                const wNum = w.value === "" ? 1 : Number(w.value)
                this.settings.scoring[f.field] = {
                    enabled:   cb.checked,
                    weight:    isFinite(wNum) && wNum >= 0 ? wNum : 1,
                    direction: dirSel.value,
                    min:       numOrNull(mn.value),
                    max:       numOrNull(mx.value)
                }
                await RouteAssistantSettings.save({scoring: this.settings.scoring})
                this._render()
            }
            cb.addEventListener("change", sync)
            dirSel.addEventListener("change", sync)
            w.addEventListener("input", sync)
            mn.addEventListener("change", sync)
            mx.addEventListener("change", sync)
        }
        this.settingsHost.append(scoringTable)

        // ----- Filters: min score, max distance, status checkboxes
        const filtRow = document.createElement("div")
        filtRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const minScoreSel = mkSuggestSelect(
            (this.settings.filters || {}).minScore,
            [50, 60, 70, 80, 90]
        )
        const minScoreLbl = document.createElement("label")
        minScoreLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        minScoreLbl.append(document.createTextNode("Min score"), minScoreSel)
        filtRow.append(minScoreLbl)

        const maxDistSel = mkSuggestSelect(
            (this.settings.filters || {}).maxDistanceKm,
            [500, 1500, 3000, 5000, 8000, 12000, 15000]
        )
        const maxDistLbl = document.createElement("label")
        maxDistLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        maxDistLbl.append(document.createTextNode("Max km"), maxDistSel)
        filtRow.append(maxDistLbl)

        // Status checkboxes — split into Operating (NEW) and Health
        // (OK/UNDER/OVER/OOR) groups so the settings drawer mirrors the
        // chip-bar grouping.
        const statusBox = document.createElement("span")
        statusBox.style.cssText = "display:flex;gap:8px;align-items:center;"
        const buildStatusCheckbox = (s) => {
            const sCb = mkInput("checkbox", null)
            sCb.checked = (this.settings.filters.statuses[s] !== false)
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:3px;align-items:center;color:" +
                ((RouteAssistantPanel.STATUS_DEF[s] || {}).color || "#9ca3af") + ";"
            lbl.append(sCb, document.createTextNode(s))
            sCb.addEventListener("change", async () => {
                this.settings.filters.statuses[s] = sCb.checked
                await RouteAssistantSettings.save({filters: this.settings.filters})
                this._render()
            })
            return lbl
        }
        statusBox.append(buildStatusCheckbox("NEW"))
        const opSep = document.createElement("span")
        opSep.style.cssText = "color:#374151;"
        opSep.textContent = "·"
        statusBox.append(opSep)
        for (const s of ["OK", "UNDER", "OVER", "OOR"]) statusBox.append(buildStatusCheckbox(s))
        filtRow.append(statusBox)

        this.settingsHost.append(filtRow)

        const filterSync = async () => {
            this.settings.filters.minScore      = numOrNull(minScoreSel.value)
            this.settings.filters.maxDistanceKm = numOrNull(maxDistSel.value)
            await RouteAssistantSettings.save({filters: this.settings.filters})
            this._render()
        }
        minScoreSel.addEventListener("change", filterSync)
        maxDistSel.addEventListener("change", filterSync)

        // ----- Auto-Pricing (Tier 1 — visibility layer)
        // Surfaces the user's current ticket price / yield / ORS rank per
        // route, scraped from /app/com/scheduling/<HUB><DEST>. Tier 2
        // (recommendations) and Tier 3 (write-back) hang off the same
        // settings.pricing block.
        this._renderAutoPricingSection()

        // ----- Yield feedback (Roadmap G — actual-yields feedback loop)
        // Joins the live-route-data cache (which tells us which tails fly
        // each route) with `<server>aircraftFlights<id>` profit records
        // (written by content_aircraftFlights.js) and projects realised
        // $/flt onto the table. Closes the loop on the rough estimator.
        this._renderYieldFeedbackSection()

        // ----- Service profiles (per-class seats + service-level posture)
        // Default Y/C/F mix, class yield multipliers, per-class costs, and
        // service-level definitions. Per-route overrides land via the
        // Seats/wk ▾ popover.
        this._renderServiceProfilesSection()

        // ----- Carriers (Letter F — full carrier list per route)
        // Bulk-sync flightsfrom.com/<HUB>-<DEST> to enrich the Cmp
        // column with a colored intensity badge + per-carrier tooltip.
        this._renderCarriersSection()

        // ----- Interlining records (H slice 3b.1.1 — bulk view)
        // Audit-all-routes-at-once entry point for per-route interline /
        // codeshare partners. Layered above the global Carriers cache.
        this._renderInterlineRecordsSection()

        // ----- Canopy view (Letter L slice L6 — combined-supply view)
        // Federation-aware classification of every leaderboard entry +
        // five new columns gated on settings.routeAssistant.canopyView.active.
        // Builds on L4-lite affiliations + L5 DNA scoring infrastructure.
        this._renderCanopyViewSection()

        // ----- Market Analysis (Tier 2a — per-route markets-page scraper)
        // Bulk-sync /app/com/markets/<HUB><DEST> for competitor flights,
        // own pricing, market shares, and historic capacity/price charts.
        // Stored split across 4 chrome.storage.local key families.
        this._renderMarketAnalysisSection()

        // ----- Demand depth (Letter K — per-class historic + RM buckets)
        // Heavy fan-out scrape that derives real per-route demand pool +
        // price elasticity + RM tightness, replacing the 0–10 station
        // badge as the score-blend's demand signal.
        this._renderDemandDepthSection()

        // ----- ORS Rank (Tier 2b — Online Reservation System scraper)
        // Submits /app/info/ors per route and walks all result pages,
        // computing every flavor of "our rank". Stores the full connection
        // list so any rank metric can be re-derived at render time.
        this._renderOrsRankSection()

        // ----- ORS Sandbox (Letter I slice 1 — pricing simulator config)
        // Tunable model parameters (α_price, α_comfort, default T) +
        // per-route T overrides. The sandbox UI lives in the panel mode
        // toggled via the 🧪 header button; this expander is for the
        // model knobs only.
        this._renderOrsSandboxSection()

        // ----- Active prompts (alert rules)
        // Per-row triggers — declarative "if this field crosses N, toast
        // me on next mount". Rules persist in `routeAssistant:alertRules`
        // and evaluate against the diff-decorated scoredRows on every
        // _renderRows call.
        this._renderAlertRulesSection()

        // ----- Q16 — desktop notifications for long bulk-syncs.
        this._renderNotificationsSection()

        // ----- Economics — feeds the rough profit estimator
        const econHeader = document.createElement("div")
        econHeader.style.cssText = "margin-top:10px;margin-bottom:4px;color:#9ca3af;font-size:11px;"
        econHeader.innerHTML = "<strong>Economics (rough profit estimator)</strong> — live-syncs as you type. Hover any $/flt cell for the full per-row breakdown."
        this.settingsHost.append(econHeader)

        const formula = document.createElement("div")
        formula.style.cssText = "margin:2px 0 6px 0;color:#6b7280;font-size:10px;line-height:1.5;"
        formula.innerHTML =
            "<strong>Pax LF</strong> = lerp(LF min, max) by pax demand 0–10. " +
            "<strong>Cargo LF</strong> = same with cargo demand. " +
            "<strong>Effective yield</strong> = base yield × (1 + <em>sensitivity</em> × (demand − 5)/5), " +
            "clamped [0.5×, 1.5×]. <strong>0 sensitivity = flat yield</strong>.<br>" +
            "Revenue = seats × paxLF × paxYield × dist × 2 × falloffMult <em>+</em> " +
            "cargoKg × cargoLF × cargoYield × dist × 2 × falloffMult.<br>" +
            "Cost = (fuel + crew + maint) × block hours + other-per-flight. " +
            "<em>$/flt = revenue − cost.</em>"
        this.settingsHost.append(formula)

        const econ = this.settings.economics || {}

        // Pax row
        const lfMinInput  = mkNumberInput(econ.loadFactorMin,          {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const lfMaxInput  = mkNumberInput(econ.loadFactorMax,          {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const lfInput     = mkNumberInput(econ.loadFactor,             {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const yieldInput  = mkNumberInput(econ.yieldPerKm,             {min: 0,    max: 10,   step: 0.01, width: "55px"})
        const yieldSensInput = mkNumberInput(econ.yieldDemandSensitivity, {min: 0, max: 1,    step: 0.1,  width: "55px"})
        // Cargo row
        const cyInput     = mkNumberInput(econ.cargoYieldPerKgKm,      {min: 0,    max: 1,    step: 0.0001, width: "75px"})
        const cLfMinInput = mkNumberInput(econ.cargoLoadFactorMin,     {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const cLfMaxInput = mkNumberInput(econ.cargoLoadFactorMax,     {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const cySensInput = mkNumberInput(econ.cargoYieldDemandSensitivity, {min: 0, max: 1, step: 0.1, width: "55px"})
        // Cost row
        const fuelInput   = mkNumberInput(econ.fuelCostPerHour,        {min: 0,    max: 99999, step: 100, width: "70px"})
        const fuelAgeInput = mkNumberInput(econ.fuelAgePenaltyPerYear, {min: 0,    max: 0.05, step: 0.001, width: "65px"})
        const crewInput   = mkNumberInput(econ.crewCostPerHour,        {min: 0,    max: 99999, step: 50,  width: "65px"})
        const maintInput  = mkNumberInput(econ.maintenanceCostPerHour, {min: 0,    max: 99999, step: 50,  width: "65px"})
        const otherInput  = mkNumberInput(econ.otherFixedPerFlight,    {min: 0,    max: 9999999, step: 100, width: "75px"})
        const falloffMult = mkNumberInput(econ.falloffYieldMultiplier, {min: 0,    max: 1.5,  step: 0.05, width: "55px"})

        const wrap = (label, inp, hint) => {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            w.title = hint || ""
            w.append(document.createTextNode(label), inp)
            return w
        }

        const paxRow = document.createElement("div")
        paxRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:4px;"
        const paxTag = document.createElement("strong")
        paxTag.textContent = "Pax"
        paxTag.style.cssText = "color:#60a5fa;font-size:10px;width:36px;"
        paxRow.append(
            paxTag,
            wrap("Yield AS$/km",       yieldInput,     "AS$ revenue per pax per km. Default 0.10 — tune to your game world."),
            wrap("Yield sens.",        yieldSensInput, "How much pax demand modulates yield. 0 = flat (default), 1 = ±20% by demand (clamped). Pairs with LF curve."),
            wrap("LF min (demand 0)",  lfMinInput,     "Pax load factor when AS pax demand is 0/10. Default 0.50."),
            wrap("LF max (demand 10)", lfMaxInput,     "Pax load factor when AS pax demand is 10/10. Default 0.95."),
            wrap("LF base",            lfInput,        "Pax fallback LF when demand isn't resolved. Default 0.75.")
        )
        this.settingsHost.append(paxRow)

        const cargoRow = document.createElement("div")
        cargoRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:4px;"
        const cargoTag = document.createElement("strong")
        cargoTag.textContent = "Cargo"
        cargoTag.style.cssText = "color:#a78bfa;font-size:10px;width:36px;"
        cargoRow.append(
            cargoTag,
            wrap("Yield AS$/kg-km",    cyInput,     "AS$ revenue per kg of cargo per km. Default 0 — cargo revenue is OFF until you enter a value. Try 0.0008 as a starting point."),
            wrap("Yield sens.",        cySensInput, "How much cargo demand modulates cargo yield. 0 = flat (default), 1 = ±20% by demand (clamped)."),
            wrap("LF min (demand 0)",  cLfMinInput, "Cargo load factor when AS cargo demand is 0/10. Default 0.40."),
            wrap("LF max (demand 10)", cLfMaxInput, "Cargo load factor when AS cargo demand is 10/10. Default 0.85.")
        )
        this.settingsHost.append(cargoRow)

        const commonRow = document.createElement("div")
        commonRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const commonTag = document.createElement("strong")
        commonTag.textContent = "Cost"
        commonTag.style.cssText = "color:#9ca3af;font-size:10px;width:36px;"
        commonRow.append(
            commonTag,
            wrap("Fuel AS$/h",         fuelInput,    "AS$ per block hour, fleet-average fuel cost (base, before age penalty). Default 2500. When 'Auto-scale' is on in the Cache section below, this is the BASELINE — effective cost auto-scales by AS fuel price ratio."),
            wrap("Age penalty/yr",     fuelAgeInput, "Fraction of extra fuel per year of aircraft age. Default 0 = OFF. Try 0.005 (0.5%/yr) or 0.01 (1%/yr) — exact AS mechanic unconfirmed, calibrate from observation. Capped at 2× total. Per-tail mode uses exact tail age; per-type / Fleet mode uses avg age of owned aircraft of that type."),
            wrap("Crew AS$/h",         crewInput,    "AS$ per block hour for crew. Default 0 — disabled until you set it."),
            wrap("Maint AS$/h",        maintInput,   "AS$ per block hour for maintenance reserves. Default 0 — disabled until you set it."),
            wrap("Other AS$/flt",      otherInput,   "AS$ per round-trip: leasing, insurance, gate fees, anything fixed-per-flight. Default 0."),
            wrap("Falloff yield",      falloffMult,  "Revenue multiplier when distance is in the fall-off zone (90–95% of range). Default 0.85.")
        )
        this.settingsHost.append(commonRow)

        // ----- Cache section
        const cacheHeader = document.createElement("div")
        cacheHeader.style.cssText = "margin-top:10px;margin-bottom:4px;color:#9ca3af;font-size:11px;"
        cacheHeader.innerHTML = "<strong>Cache</strong> — distances are cached forever by default. Set a max age to re-resolve stale entries (e.g. after AS adjusts route restrictions)."
        this.settingsHost.append(cacheHeader)

        const cacheRow = document.createElement("div")
        cacheRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const cacheTag = document.createElement("strong")
        cacheTag.textContent = "Distance"
        cacheTag.style.cssText = "color:#9ca3af;font-size:10px;width:50px;"
        const distAgeSel = mkSuggestSelect(
            this.settings.distanceMaxAgeDays,
            [7, 14, 30, 60, 90, 180]
        )
        const distAgeWrap = document.createElement("label")
        distAgeWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        distAgeWrap.title = "Days before a cached distance is considered stale and re-resolved on next mount. Default: no expiry."
        distAgeWrap.append(document.createTextNode("Max age (days)"), distAgeSel)
        cacheRow.append(cacheTag, distAgeWrap)
        this.settingsHost.append(cacheRow)

        distAgeSel.addEventListener("change", async () => {
            this.settings.distanceMaxAgeDays = numOrNull(distAgeSel.value)
            await RouteAssistantSettings.save({distanceMaxAgeDays: this.settings.distanceMaxAgeDays})
            // Drop the resolver so it picks up the new max age, then refresh:
            // refresh rebuilds rows from ffData (distanceKm null), bulkLoad
            // applies only fresh entries, enrichment re-resolves the rest.
            this.distanceResolver = null
            await this.refresh()
        })

        // ----- AS fuel auto (letter A)
        // Per-type model: when Auto is on AND the scraped price is in ASc$/l,
        // fuel cost per flight = (cycle_L + per_km_L × dist × 2) × price/100,
        // with cycle_L and per_km_L derived per type (heuristic from spec, or
        // a stored override). When Auto is off, the legacy "Fuel AS$/h ×
        // block hours" model is used.
        const fuelRow = document.createElement("div")
        fuelRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-top:4px;"
        const fuelTag = document.createElement("strong")
        fuelTag.textContent = "AS fuel"
        fuelTag.style.cssText = "color:#9ca3af;font-size:10px;width:50px;"

        const fp = this.fuelPrice
        const havePrice = fp && fp.unit === "ASc$/l" && typeof fp.value === "number" && fp.value > 0
        const fuelStatus = document.createElement("span")
        fuelStatus.style.color = "#9ca3af"
        if (this._fuelScrapeInFlight) {
            fuelStatus.textContent = "Scraping…"
            fuelStatus.style.color = "#60a5fa"
        } else if (fp && typeof fp.value === "number") {
            const ageH = Math.max(0, Math.round((Date.now() - fp.scrapedAt) / 3600e3))
            const ageStr = ageH < 1 ? "just now" : ageH + "h ago"
            const dateStr = fp.date ? " · " + (typeof fp.date === "number" ? fp.date.toFixed(2) : fp.date) : ""
            const unit = fp.unit === "ASc$/l" ? " ASc$/l" : " (chart-scale)"
            fuelStatus.textContent = `${fp.value.toFixed(2)}${unit} (${ageStr})${dateStr}`
            if (RouteAssistantFuelPriceScraper.isStale(fp)) fuelStatus.style.color = "#fbbf24"
        } else {
            fuelStatus.textContent = "Not scraped — click Refresh."
            fuelStatus.style.color = "#fbbf24"
        }

        const fuelRefreshBtn = document.createElement("button")
        fuelRefreshBtn.textContent = "Refresh"
        Object.assign(fuelRefreshBtn.style, smallBtnStyle())
        fuelRefreshBtn.style.fontSize = "10px"
        fuelRefreshBtn.style.padding = "1px 6px"
        fuelRefreshBtn.disabled = this._fuelScrapeInFlight
        if (this._fuelScrapeInFlight) fuelRefreshBtn.style.opacity = "0.5"
        fuelRefreshBtn.addEventListener("click", () => this._scrapeFuelPriceAsync())

        // Auto toggle — only meaningful with a usable ASc$/l price scrape.
        const autoCb = mkInput("checkbox", null)
        autoCb.checked = !!econ.fuelPriceAutoEnabled
        autoCb.disabled = !havePrice
        const autoLbl = document.createElement("label")
        autoLbl.style.cssText = "display:flex;gap:3px;align-items:center;color:#9ca3af;"
        autoLbl.title = "Compute fuel cost as (cycle_L + per_km_L × distance × 2) × current AS price. Per-type cycle/per_km derived from spec heuristic; override per type below."
        autoLbl.append(autoCb, document.createTextNode("Auto (per-type fuel)"))
        autoCb.addEventListener("change", async () => {
            this.settings.economics.fuelPriceAutoEnabled = autoCb.checked
            await RouteAssistantSettings.save({economics: this.settings.economics})
            this._recomputeProfit()
            this._renderSettings()
        })

        fuelRow.append(fuelTag, fuelStatus, fuelRefreshBtn, autoLbl)

        // When per-type fuel is on, override the Fuel AS$/h input with the
        // cruise-equivalent rate for the currently selected aircraft (or the
        // fleet average in Fleet mode). The user sees what fuel actually
        // costs them per hour at cruise. Field becomes read-only — the
        // underlying setting is preserved unchanged.
        const cruiseRate = (econ.fuelPriceAutoEnabled && havePrice)
            ? this._computeCruiseFuelRate(fp.value) : null
        if (cruiseRate !== null) {
            fuelInput.value = String(Math.round(cruiseRate.rate))
            fuelInput.disabled = true
            fuelInput.style.opacity = "0.7"
            fuelInput.title = `Auto-derived: ${cruiseRate.perKmL.toFixed(2)} L/km × ${cruiseRate.speed} km/h × ${fp.value} ASc/l ÷ 100 = AS$${Math.round(cruiseRate.rate)}/h cruise${cruiseRate.label ? " (" + cruiseRate.label + ")" : ""}. Disable Auto (per-type fuel) to edit.`
        }

        // Method indicator
        const methodNote = document.createElement("span")
        methodNote.style.cssText = "color:#6b7280;font-size:10px;"
        if (econ.fuelPriceAutoEnabled && havePrice) {
            methodNote.style.color = "#a3e635"
            const rateStr = cruiseRate
                ? ` · cruise rate AS$${Math.round(cruiseRate.rate)}/h${cruiseRate.label ? " (" + cruiseRate.label + ")" : ""}`
                : ""
            methodNote.textContent = "→ fuel = (cycle_L + per_km_L × dist × 2) × AS price" + rateStr
        } else if (econ.fuelPriceAutoEnabled && !havePrice) {
            methodNote.style.color = "#fbbf24"
            methodNote.textContent = "→ Auto on but no ASc$/l price — falling back to flat AS$/h"
        } else {
            methodNote.textContent = "→ legacy: Fuel AS$/h × block hours"
        }
        fuelRow.append(methodNote)

        this.settingsHost.append(fuelRow)

        // Per-type fuel-burn list (read-only summary; opens edit modal on click).
        if (econ.fuelPriceAutoEnabled && havePrice && this.fleet
                && Array.isArray(RouteAssistantFleetStore.activeTypeSlots(this.fleet))) {
            this._renderFuelBurnTable()
        }

        const allInputs = [lfMinInput, lfMaxInput, lfInput, yieldInput, yieldSensInput,
                           cyInput, cLfMinInput, cLfMaxInput, cySensInput,
                           fuelInput, fuelAgeInput, crewInput, maintInput, otherInput, falloffMult]

        // Apply changes immediately to in-memory settings (so the breakdown
        // tooltip on hover reads current values), but debounce the storage
        // write + recompute so a multi-keystroke entry like "0.123" doesn't
        // trigger 4 saves and 4 re-aggregations.
        const stageEconomics = () => {
            this.settings.economics = Object.assign({}, this.settings.economics, {
                loadFactor:                  parseFloatOr(lfInput.value, 0.75),
                loadFactorMin:               parseFloatOr(lfMinInput.value, 0.50),
                loadFactorMax:               parseFloatOr(lfMaxInput.value, 0.95),
                yieldPerKm:                  parseFloatOr(yieldInput.value, 0.10),
                yieldDemandSensitivity:      parseFloatOr(yieldSensInput.value, 0),
                cargoYieldPerKgKm:           parseFloatOr(cyInput.value, 0),
                cargoLoadFactorMin:          parseFloatOr(cLfMinInput.value, 0.40),
                cargoLoadFactorMax:          parseFloatOr(cLfMaxInput.value, 0.85),
                cargoYieldDemandSensitivity: parseFloatOr(cySensInput.value, 0),
                fuelCostPerHour:             fuelInput.disabled
                                                 ? this.settings.economics.fuelCostPerHour
                                                 : parseFloatOr(fuelInput.value, 2500),
                fuelAgePenaltyPerYear:       parseFloatOr(fuelAgeInput.value, 0),
                crewCostPerHour:             parseFloatOr(crewInput.value, 0),
                maintenanceCostPerHour:      parseFloatOr(maintInput.value, 0),
                otherFixedPerFlight:         parseFloatOr(otherInput.value, 0),
                falloffYieldMultiplier:      parseFloatOr(falloffMult.value, 0.85)
            })
        }

        const econDebounced = () => {
            stageEconomics()
            clearTimeout(this._economicsDebounceTimer)
            this._economicsDebounceTimer = setTimeout(async () => {
                await RouteAssistantSettings.save({economics: this.settings.economics})
                this._recomputeProfit()
            }, 250)
        }

        for (const inp of allInputs) {
            inp.addEventListener("input", econDebounced)
        }
    }

    /**
     * Settings-drawer block for the actual-yields feedback loop:
     *   - status line (last snapshot, K/N routes have history)
     *   - Snapshot CTA + progress
     *   - "Show actuals columns" toggle, attribution-mode select,
     *     variance threshold, history limit
     */
    window.RouteAssistantPanel.prototype._renderYieldFeedbackSection = function() {
        const cfg = this.settings.yieldFeedback = Object.assign(
            {showColumns: true, varianceWarnPct: 25, attributionMode: "frequency",
             historyLimit: 12, lastSnapshotAt: null, autoSnapshotOnMount: false,
             deltaMode: false},
            this.settings.yieldFeedback || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(168, 85, 247, 0.08);border:1px solid rgba(168, 85, 247, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#d8b4fe;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Yield feedback (actuals)</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Joins cached "
            + "live-route data with each tail's <code>aircraftFlights</code> profit record "
            + "to attribute realised $/flt per route. Closes the loop with the rough estimator.</span>"
        wrap.append(header)

        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.actualProfitPerFlight != null).length
        const lastSnap  = cfg.lastSnapshotAt
            ? new Date(cfg.lastSnapshotAt).toLocaleString()
            : "never"

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        status.textContent = "Snapshots: " + dataRows + "/" + totalRows
            + " routes · last snapshot: " + lastSnap
        wrap.append(status)
        this._snapshotStatusEl = status

        // Diagnostic block — only shown after the user actually clicked
        // "Snapshot yields now". Surfaces *why* the run produced what it did
        // so a 0-routes outcome doesn't read as silent failure.
        const diag = this._lastSnapshotResult
        if (diag) {
            const liveCaptured = (this.rows || []).filter(r => r.liveAircraftType || r.liveDeparture).length
            const lines = []
            let modeLine
            if (diag.attributionMode === "per-flight") {
                modeLine = "per-flight (exact) · " + (diag.routesWithPerFlight || 0)
                    + " route" + ((diag.routesWithPerFlight === 1) ? "" : "s")
                    + " attributed exactly"
                    + ((diag.routesFellBack > 0)
                        ? " · " + diag.routesFellBack + " fell back to frequency"
                        : "")
            } else if (diag.mode === "delta") {
                modeLine = "delta-mode · " + (diag.tailsUsingDelta || 0) + "/" + diag.tailsUsed
                    + " tails had a prior baseline"
            } else {
                modeLine = "cumulative-mode (lifetime average $/flt per tail)"
            }
            lines.push(diag.routesUpdated + " route" + (diag.routesUpdated === 1 ? "" : "s")
                + " updated · " + diag.routesScanned + " scanned · "
                + diag.tailsUsed + "/" + diag.tailsSeen + " tails contributed · " + modeLine)
            if (diag.attributionMode === "per-flight" && diag.routesFellBack > 0) {
                lines.push("⚠ " + diag.routesFellBack + " route" + (diag.routesFellBack === 1 ? "" : "s")
                    + " had no measured flights. Visit each tail's flight-history page AND each "
                    + "individual flight detail page to populate <server>flightInfo<id>; the "
                    + "Aircraft history page's \"Extract finished flight profit\" button bulk-opens them.")
            }
            if (diag.tailsMissingProfit > 0) {
                const sample = (diag.tailsMissingList || []).slice(0, 6).join(", ")
                lines.push("⚠ " + diag.tailsMissingProfit + " tail"
                    + (diag.tailsMissingProfit === 1 ? "" : "s")
                    + " missing profit data — visit /app/fleets/aircraft/<id>/1 to capture each."
                    + (sample ? "\n   First few: " + sample
                        + (diag.tailsMissingList.length > 6 ? ", …" : "") : ""))
            }
            if (diag.routesScanned === 0 && liveCaptured === 0) {
                lines.push("⚠ No live route data found. Click \"Sync live route data for visible routes\" first.")
            } else if (diag.routesScanned === 0 && liveCaptured > 0) {
                lines.push("⚠ Live route data exists but no flights were attributed. "
                    + "Re-sync the routes in case the previous fetch missed the Flight Numbers table.")
            }
            const diagBox = document.createElement("div")
            const errorish = diag.routesUpdated === 0 || diag.tailsMissingProfit > 0
            diagBox.style.cssText = "color:" + (errorish ? "#fde68a" : "#a7f3d0")
                + ";font-size:10px;margin-bottom:6px;white-space:pre-wrap;line-height:1.45;"
                + "background:" + (errorish ? "rgba(245,158,11,0.07)" : "rgba(34,197,94,0.07)")
                + ";border:1px solid " + (errorish ? "rgba(245,158,11,0.30)" : "rgba(34,197,94,0.30)")
                + ";border-radius:3px;padding:4px 6px;"
            diagBox.textContent = "Last snapshot: " + lines.join("\n")
            wrap.append(diagBox)
        }

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#d8b4fe;"
        showLbl.append(showCb, document.createTextNode("Show actuals columns"))
        showCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.showColumns = showCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
            this._render()
        })
        ctrlRow.append(showLbl)

        const modeSel = mkSelect([
            {value: "per-flight", label: "per-flight (exact)"},
            {value: "frequency",  label: "by frequency"},
            {value: "distance",   label: "by distance × frequency"},
            {value: "equal",      label: "split equally per route"}
        ])
        modeSel.value = cfg.attributionMode || "frequency"
        modeSel.style.fontSize = "11px"
        modeSel.title = "per-flight = sums each finished flight's profit per route exactly "
            + "(no frequency averaging). Requires the user to have visited each flight's "
            + "detail page so the financials cache is populated. Routes with no per-flight "
            + "data fall back to frequency-weighted attribution."
        modeSel.addEventListener("change", async () => {
            this.settings.yieldFeedback.attributionMode = modeSel.value
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        const modeLbl = document.createElement("label")
        modeLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        modeLbl.append(document.createTextNode("Attribution:"), modeSel)
        ctrlRow.append(modeLbl)

        const warnInput = mkNumberInput(cfg.varianceWarnPct, {min: 1, max: 200, step: 1, width: "55px"})
        warnInput.addEventListener("change", async () => {
            const v = parseFloatOr(warnInput.value, 25)
            this.settings.yieldFeedback.varianceWarnPct = Math.max(1, Math.round(v))
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
            this._render()
        })
        const warnLbl = document.createElement("label")
        warnLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        warnLbl.append(document.createTextNode("Δ% warn at ±"), warnInput, document.createTextNode("%"))
        ctrlRow.append(warnLbl)

        const limitInput = mkNumberInput(cfg.historyLimit, {min: 2, max: 60, step: 1, width: "50px"})
        limitInput.addEventListener("change", async () => {
            const v = parseFloatOr(limitInput.value, 12)
            this.settings.yieldFeedback.historyLimit = Math.max(2, Math.round(v))
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        const limitLbl = document.createElement("label")
        limitLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        limitLbl.append(document.createTextNode("History"), limitInput, document.createTextNode("snapshots"))
        ctrlRow.append(limitLbl)

        const deltaCb = mkInput("checkbox", null)
        deltaCb.checked = !!cfg.deltaMode
        const deltaLbl = document.createElement("label")
        deltaLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        deltaLbl.title = "Delta mode subtracts the previous snapshot's lifetime profit from each "
            + "tail's current cumulative profit, so $/flt reflects only flights flown SINCE the "
            + "last snapshot (true periodic yield). First snapshot still uses cumulative; "
            + "subsequent runs switch automatically per-tail when a baseline exists."
        deltaLbl.append(deltaCb, document.createTextNode("Delta mode"))
        deltaCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.deltaMode = deltaCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        ctrlRow.append(deltaLbl)

        const autoCb = mkInput("checkbox", null)
        autoCb.checked = !!cfg.autoSnapshotOnMount
        const autoLbl = document.createElement("label")
        autoLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        autoLbl.title = "When enabled, the panel runs a snapshot once after each mount/refresh. "
            + "Skipped silently when no live route data is cached yet."
        autoLbl.append(autoCb, document.createTextNode("Auto on mount"))
        autoCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.autoSnapshotOnMount = autoCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        ctrlRow.append(autoLbl)

        const snapBtn = document.createElement("button")
        snapBtn.textContent = this._snapshotRunning ? "Snapshotting…" : "Snapshot yields now"
        Object.assign(snapBtn.style, smallBtnStyle())
        snapBtn.style.background = "#7c3aed"
        snapBtn.disabled = !!this._snapshotRunning || !this.hubIata
        snapBtn.addEventListener("click", () => this._runYieldSnapshot())
        ctrlRow.append(snapBtn)

        // Calibrate-flagged button — runs the per-route override editor's
        // "Calibrate from actuals" math against every row whose |Δ%| trips
        // the variance threshold, batched behind a confirmation modal so a
        // single click never silently overrides 50 routes.
        const flagged = this._flaggedRoutesForCalibration()
        const calibBtn = document.createElement("button")
        calibBtn.textContent = "Calibrate flagged (" + flagged.length + ")"
        Object.assign(calibBtn.style, smallBtnStyle())
        calibBtn.style.background = flagged.length ? "#7c3aed" : "#475569"
        calibBtn.disabled = !flagged.length
        if (!flagged.length) calibBtn.style.opacity = "0.5"
        calibBtn.title = flagged.length
            ? "Open a confirmation modal listing every route whose Δ% currently exceeds the warn threshold "
              + "and the per-route yield override that would make the estimator match the latest snapshot. "
              + "Save runs as a batch."
            : "No routes currently flagged. Lower the warn threshold or take a fresh snapshot to populate."
        calibBtn.addEventListener("click", () => this._openCalibrateFlaggedModal(flagged))
        ctrlRow.append(calibBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Requires recent <em>Sync live route data</em> (so we know which tails fly each route) "
            + "and one visit to each tail's flight-history page (<code>/app/fleets/aircraft/&lt;id&gt;/1</code>) "
            + "so its profit is captured. Snapshot reports tails missing profit data so you can fill in the gaps."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Settings-drawer expander for the per-route service profiles defaults.
     * Per-route overrides land via the Seats/wk ▾ popover; this expander
     * lets the user tune the global defaults that fall through.
     */
    window.RouteAssistantPanel.prototype._renderServiceProfilesSection = function() {
        const cfg = this.settings.serviceProfiles = Object.assign(
            {showServiceColumns: true},
            this.settings.serviceProfiles || {}
        )
        // Ensure nested defaults exist (deep-merge already filled them at load,
        // but a fresh upgrade through save() may strip them).
        cfg.defaultClassMix  = Object.assign({Y: 1.0, C: 0,    F: 0  }, cfg.defaultClassMix  || {})
        cfg.classYieldMult   = Object.assign({Y: 1.0, C: 2.5,  F: 4.5}, cfg.classYieldMult   || {})
        cfg.classCostPerPax  = Object.assign({Y: 5,   C: 18,   F: 45 }, cfg.classCostPerPax  || {})
        cfg.serviceLevels    = Object.assign({
            budget:   {yieldMult: 0.85, costPerPax: 3,  label: "Budget"},
            standard: {yieldMult: 1.00, costPerPax: 8,  label: "Standard"},
            premium:  {yieldMult: 1.20, costPerPax: 22, label: "Premium"}
        }, cfg.serviceLevels || {})

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(56, 189, 248, 0.08);border:1px solid rgba(56, 189, 248, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#7dd3fc;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Service profiles</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Default Y/C/F class mix, class yield multipliers, per-pax cost, and service-level posture. Per-route overrides via the Seats/wk ▾.</span>"
        wrap.append(header)

        // ---- Show columns toggle
        const showRow = document.createElement("div")
        showRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;"
        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showServiceColumns !== false
        showCb.addEventListener("change", async () => {
            cfg.showServiceColumns = showCb.checked
            await RouteAssistantSettings.save({serviceProfiles: cfg})
            this._render()
        })
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#7dd3fc;"
        showLbl.append(showCb, document.createTextNode("Show Service columns (Seats/wk · Mix · Svc)"))
        showRow.append(showLbl)
        wrap.append(showRow)

        // ---- Default class mix
        const mixWrap = document.createElement("div")
        mixWrap.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px;flex-wrap:wrap;"
        const mY = mkNumberInput(Math.round((cfg.defaultClassMix.Y || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mC = mkNumberInput(Math.round((cfg.defaultClassMix.C || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mF = mkNumberInput(Math.round((cfg.defaultClassMix.F || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        mixWrap.append((() => { const s = document.createElement("span"); s.textContent = "Default mix %"; s.style.color = "#9ca3af"; return s })())
        for (const [lbl, inp, color] of [["Y", mY, "#7dd3fc"], ["C", mC, "#fcd34d"], ["F", mF, "#fda4af"]]) {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:3px;align-items:center;color:" + color + ";"
            w.append(document.createTextNode(lbl), inp)
            mixWrap.append(w)
        }
        wrap.append(mixWrap)

        // ---- Per-class yield mult + cost
        const fareTable = document.createElement("table")
        fareTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        fareTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Class</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield × base</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        </tr></thead>`
        const fareBody = document.createElement("tbody")
        const yldInputs = {}
        const costInputs = {}
        const classColors = {Y: "#7dd3fc", C: "#fcd34d", F: "#fda4af"}
        for (const cls of ["Y", "C", "F"]) {
            const yldIn  = mkNumberInput(cfg.classYieldMult[cls],  {min: 0, max: 20,    step: 0.1,  width: "70px"})
            const costIn = mkNumberInput(cfg.classCostPerPax[cls], {min: 0, max: 99999, step: 1,    width: "70px"})
            yldInputs[cls]  = yldIn
            costInputs[cls] = costIn
            const tr = document.createElement("tr")
            const cell = (text, color) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;color:" + (color || "#d1d5db") + ";"
                c.textContent = text
                return c
            }
            tr.append(cell(cls, classColors[cls]))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(yldCell, costCell)
            fareBody.append(tr)
        }
        fareTable.append(fareBody)
        wrap.append(fareTable)

        // ---- Service levels
        const lvlTable = document.createElement("table")
        lvlTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        lvlTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Service level</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield ×</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        </tr></thead>`
        const lvlBody = document.createElement("tbody")
        const lvlInputs = {}
        for (const lvl of ["budget", "standard", "premium"]) {
            const def = cfg.serviceLevels[lvl] || {}
            const yldIn  = mkNumberInput(def.yieldMult,  {min: 0,    max: 5,    step: 0.05, width: "65px"})
            const costIn = mkNumberInput(def.costPerPax, {min: 0,    max: 9999, step: 1,    width: "65px"})
            lvlInputs[lvl] = {yld: yldIn, cost: costIn}
            const tr = document.createElement("tr")
            const labelCell = document.createElement("td")
            labelCell.style.cssText = "padding:2px 4px;color:#d1d5db;"
            labelCell.textContent = (def.label || (lvl.charAt(0).toUpperCase() + lvl.slice(1)))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(labelCell, yldCell, costCell)
            lvlBody.append(tr)
        }
        lvlTable.append(lvlBody)
        wrap.append(lvlTable)

        // ---- Save row
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save service-profile defaults"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.background = "#0284c7"
        saveBtn.addEventListener("click", async () => {
            const sumPct = (parseFloatOr(mY.value, 0) || 0)
                         + (parseFloatOr(mC.value, 0) || 0)
                         + (parseFloatOr(mF.value, 0) || 0)
            const factor = sumPct > 0 ? 100 / sumPct : 1
            const norm = {
                Y: Math.max(0, (parseFloatOr(mY.value, 0) || 0) * factor) / 100,
                C: Math.max(0, (parseFloatOr(mC.value, 0) || 0) * factor) / 100,
                F: Math.max(0, (parseFloatOr(mF.value, 0) || 0) * factor) / 100
            }
            cfg.defaultClassMix  = norm
            for (const cls of ["Y", "C", "F"]) {
                cfg.classYieldMult[cls]  = parseFloatOr(yldInputs[cls].value,  cfg.classYieldMult[cls])
                cfg.classCostPerPax[cls] = parseFloatOr(costInputs[cls].value, cfg.classCostPerPax[cls])
            }
            for (const lvl of ["budget", "standard", "premium"]) {
                cfg.serviceLevels[lvl] = Object.assign({}, cfg.serviceLevels[lvl] || {}, {
                    yieldMult:  parseFloatOr(lvlInputs[lvl].yld.value,  cfg.serviceLevels[lvl].yieldMult),
                    costPerPax: parseFloatOr(lvlInputs[lvl].cost.value, cfg.serviceLevels[lvl].costPerPax)
                })
            }
            await RouteAssistantSettings.save({serviceProfiles: cfg})
            this._reapplyServiceProjection()
            this._render()
        })
        wrap.append(saveBtn)

        // ---- AS service profiles auto-detect block
        const asWrap = document.createElement("div")
        asWrap.style.cssText = "margin-top:8px;padding:6px 8px;background:rgba(15, 23, 42, 0.5);border:1px dashed rgba(56, 189, 248, 0.30);border-radius:3px;"
        const asHead = document.createElement("div")
        asHead.style.cssText = "color:#7dd3fc;font-size:10px;margin-bottom:4px;"
        const profileCount = (this.serviceProfilesCache && this.serviceProfilesCache.size) || 0
        const listCache    = this._serviceProfilesList || null
        const lastSyncTxt  = listCache && listCache.scrapedAt
            ? new Date(listCache.scrapedAt).toLocaleString()
            : "never"
        asHead.innerHTML = "<strong>AS service profiles auto-detect</strong> — "
            + profileCount + " profile" + (profileCount === 1 ? "" : "s") + " cached · last sync: " + lastSyncTxt
        asWrap.append(asHead)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = this._serviceProfileSyncRunning ? "Syncing…" : "Refresh AS service profiles"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.background = "#0ea5e9"
        refreshBtn.disabled = !!this._serviceProfileSyncRunning
        refreshBtn.addEventListener("click", () => this._refreshServiceProfilesFromAS())
        asWrap.append(refreshBtn)

        const asNote = document.createElement("div")
        asNote.style.cssText = "color:#6b7280;font-size:10px;margin-top:4px;line-height:1.4;"
        asNote.innerHTML = "Fetches /action/enterprise/serviceProfiles + per-profile detail pages. "
            + "Each route's <em>assigned</em> service profile (from the markets-page sync) "
            + "then surfaces in the Svc tooltip + Seats/wk popover with its real name + per-class quality score."
        asWrap.append(asNote)
        wrap.append(asWrap)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Mix percentages renormalise to 100% on save. Per-route overrides (Seats/wk ▾) take precedence over these defaults."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Settings-drawer expander for the carrier-list scraper.
     * Mirrors `_renderAutoPricingSection`:
     *   - status line: "Synced X/Y routes · last bulk sync: …"
     *   - showCarrierIntensity toggle
     *   - "Sync carriers for all visible routes" CTA
     *
     * Fetches go through `RouteAssistantCarriersScraper.bulkScrape`
     * with concurrency + stagger from `settings.carriers`.
     */
    window.RouteAssistantPanel.prototype._renderCarriersSection = function() {
        const cfg = this.settings.carriers = Object.assign(
            {showCarrierIntensity: true, concurrency: 3, staggerMs: 1200, lastBulkScrapeAt: null},
            this.settings.carriers || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(34, 197, 94, 0.06);border:1px solid rgba(34, 197, 94, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#86efac;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Carriers</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-route carrier list from "
            + "flightsfrom.com/&lt;HUB&gt;-&lt;DEST&gt;. Replaces the integer Cmp count with a "
            + "colored intensity badge (green/amber/red) and a hover tooltip listing each carrier.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r =>
            Array.isArray(r.carriers) || r.carriersScrapedAt
        ).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Synced: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._carrierStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showCarrierIntensity !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#86efac;"
        showLbl.append(showCb, document.createTextNode("Show colored intensity badge"))
        showCb.addEventListener("change", async () => {
            this.settings.carriers.showCarrierIntensity = showCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._carrierScrapeRunning
            ? "Syncing carriers…"
            : "Sync carriers for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#15803d"
        scanBtn.disabled = !!this._carrierScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkCarrierScrape())
        ctrlRow.append(scanBtn)

        // F slice 2 — bulk-sync AS enterprise metadata for the
        // competitor list. Different button so the user can keep
        // flightsfrom carriers fresh independently of AS enterprise
        // banner/avatar caches (different TTLs).
        const enterpriseBtn = document.createElement("button")
        enterpriseBtn.textContent = this._enterpriseMetaScrapeRunning
            ? "Syncing enterprise data…"
            : "Sync enterprise data (banners + avatars)"
        Object.assign(enterpriseBtn.style, smallBtnStyle())
        enterpriseBtn.style.background = "#1d4ed8"
        // Count distinct enterpriseIds across visible rows so we can
        // gate the button: nothing to do if no AS competitors yet.
        const visibleIds = (() => {
            const s = new Set()
            for (const r of (this.rows || [])) {
                for (const list of [r.marketSharePax, r.marketShareCargo]) {
                    if (!Array.isArray(list)) continue
                    for (const e of list) {
                        if (e && e.enterpriseId != null) s.add(String(e.enterpriseId))
                    }
                }
            }
            return s.size
        })()
        enterpriseBtn.disabled = !!this._enterpriseMetaScrapeRunning
            || !this.hubIata
            || visibleIds === 0
        enterpriseBtn.title = visibleIds > 0
            ? visibleIds + " distinct enterprises visible"
            : "Sync the Markets page first to populate AS competitors."
        enterpriseBtn.addEventListener("click", () => this._runBulkEnterpriseMetaSync())
        ctrlRow.append(enterpriseBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        const lastMeta = (cfg.lastEnterpriseMetaSyncAt)
            ? new Date(cfg.lastEnterpriseMetaSyncAt).toLocaleString()
            : "never"
        note.innerHTML = "flightsfrom.com is rate-limited — defaults are "
            + cfg.concurrency + " concurrent / " + cfg.staggerMs + "ms stagger. "
            + "Hover any Cmp pill to see the carrier list. "
            + "<br>AS enterprise data: " + visibleIds + " visible · last sync " + lastMeta + "."
        wrap.append(note)

        this.settingsHost.append(wrap)

        // F slice 3 — Contractual partners sub-panel. Visually distinct
        // (purple) from the green carriers panel above so the user
        // doesn't conflate "what flightsfrom says about competition"
        // with "what AS says about my own agreements".
        const partnersWrap = document.createElement("div")
        partnersWrap.style.cssText = "margin-top:6px;padding:6px 8px;"
            + "background:rgba(124, 58, 237, 0.06);border:1px solid rgba(124, 58, 237, 0.25);"
            + "border-radius:4px;"

        const partnersHeader = document.createElement("div")
        partnersHeader.style.cssText = "color:#c4b5fd;font-size:11px;margin-bottom:4px;"
        partnersHeader.innerHTML = "<strong>Contractual partners</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Reads your own enterprise's "
            + "<em>Contractual partners</em> tab to mark interlining (⇄) and alliance (✦) partners "
            + "in the Cmp popover.</span>"
        partnersWrap.append(partnersHeader)

        const lastPartnersTs = cfg.lastPartnersSyncAt
            ? new Date(cfg.lastPartnersSyncAt).toLocaleString()
            : "never"
        const partnersStatus = document.createElement("div")
        partnersStatus.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        partnersStatus.textContent = "Configured: " + ((cfg.myEnterpriseIds || []).length)
            + " enterprise id(s) · last sync: " + lastPartnersTs
        partnersWrap.append(partnersStatus)
        // Hold a reference so _runRefreshContractualPartners can update
        // progress in this panel rather than in the green Carriers panel
        // above (which the user might not be looking at).
        this._partnersStatusEl = partnersStatus

        const inputRow = document.createElement("div")
        inputRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:11px;margin-bottom:6px;flex-wrap:wrap;"
        const idsLabel = document.createElement("span")
        idsLabel.textContent = "Own enterprise IDs:"
        idsLabel.style.cssText = "color:#c4b5fd;flex-shrink:0;"
        inputRow.append(idsLabel)

        const idsInput = document.createElement("input")
        idsInput.type = "text"
        idsInput.placeholder = "e.g. 785 or 785, 872"
        idsInput.value = (cfg.myEnterpriseIds || []).join(", ")
        idsInput.style.cssText = "flex:1;min-width:140px;background:#0f1623;border:1px solid #374151;color:#e5e7eb;padding:3px 6px;border-radius:3px;font-size:11px;font-family:monospace;"
        const persistIds = async () => {
            const parsed = idsInput.value.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
            const before = (this.settings.carriers.myEnterpriseIds || []).join(",")
            const after  = parsed.join(",")
            if (before === after) return
            this.settings.carriers.myEnterpriseIds = parsed
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            await this._applyCachedContractualPartners()
            // Rebuild the drawer so the Configured: count + Refresh
            // button's disabled state pick up the new id list. _render()
            // alone only redraws the table, so the drawer would otherwise
            // keep showing stale "Configured: 0".
            this._renderSettings()
            this._render()
        }
        idsInput.addEventListener("change", persistIds)
        idsInput.addEventListener("blur",   persistIds)
        inputRow.append(idsInput)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = this._partnersScrapeRunning
            ? "Refreshing…"
            : "Refresh contractual partners"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.background = "#7c3aed"
        // Only disable while a scrape is in flight. An empty-IDs click
        // is allowed through so the handler can surface the inline
        // "enter an ID first" hint — avoids the silently-dead button
        // problem when the user types but hasn't blurred the input yet.
        refreshBtn.disabled = !!this._partnersScrapeRunning
        refreshBtn.addEventListener("click", () => this._runRefreshContractualPartners())
        inputRow.append(refreshBtn)
        partnersWrap.append(inputRow)

        const togglesRow = document.createElement("div")
        togglesRow.style.cssText = "display:flex;gap:14px;align-items:center;font-size:11px;flex-wrap:wrap;"

        const ilCb = mkInput("checkbox", null)
        ilCb.checked = cfg.showInterliningGlyph !== false
        const ilLbl = document.createElement("label")
        ilLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#c4b5fd;cursor:pointer;"
        ilLbl.append(ilCb, document.createTextNode("Show ⇄ for interlining partners"))
        ilCb.addEventListener("change", async () => {
            this.settings.carriers.showInterliningGlyph = ilCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        togglesRow.append(ilLbl)

        const alCb = mkInput("checkbox", null)
        alCb.checked = !!cfg.showAllianceGlyph
        const alLbl = document.createElement("label")
        alLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#c4b5fd;cursor:pointer;"
        alLbl.append(alCb, document.createTextNode("Show ✦ for alliance partners"))
        alCb.addEventListener("change", async () => {
            this.settings.carriers.showAllianceGlyph = alCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        togglesRow.append(alLbl)

        const logoCb = mkInput("checkbox", null)
        logoCb.checked = cfg.showAllianceLogos !== false
        const logoLbl = document.createElement("label")
        logoLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#c4b5fd;cursor:pointer;"
        logoLbl.append(logoCb, document.createTextNode("Show alliance logos in popover"))
        logoCb.addEventListener("change", async () => {
            this.settings.carriers.showAllianceLogos = logoCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        togglesRow.append(logoLbl)
        partnersWrap.append(togglesRow)

        const partnersHint = document.createElement("div")
        partnersHint.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        partnersHint.innerHTML = "Find your enterprise ID in the AS URL when you open your own profile — e.g. "
            + "<code style='color:#a78bfa;'>/app/info/enterprises/<strong>785</strong>?tab=1</code>. "
            + "Multiple IDs (canopy users): comma-separate them. "
            + "Default cache TTL: " + (cfg.partnersMaxAgeDays || 30) + "d."
        partnersWrap.append(partnersHint)

        this.settingsHost.append(partnersWrap)
    }

    /**
     * H slice 3b.1.1 — settings-drawer expander listing every per-route
     * interline / codeshare record across every hub, grouped by hub.
     * Click a current-hub row → opens the per-route popover (which is
     * hub-pinned by design); cross-hub rows render as informational
     * with a "switch to /app/com/scheduling/<HUB> to edit" tooltip.
     * "Clear all" is gated by window.confirm.
     *
     * Lazy: full list only renders when the user expands; status line
     * (count + last update) populates eagerly so a glance reveals the
     * size of the dataset.
     */
    window.RouteAssistantPanel.prototype._renderInterlineRecordsSection = async function() {
        if (typeof RouteAssistantInterlineStore === "undefined") return

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(168, 85, 247, 0.06);border:1px solid rgba(168, 85, 247, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#d8b4fe;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Interlining records</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-route interline / codeshare partners "
            + "you've recorded across every hub. Layered above the global Carriers contractual cache.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        status.textContent = "Loading…"
        wrap.append(status)

        const listHost = document.createElement("div")
        listHost.style.cssText = "max-height:240px;overflow-y:auto;"
            + "border:1px solid rgba(168, 85, 247, 0.18);"
            + "background:rgba(0,0,0,0.18);border-radius:3px;padding:4px 6px;"
            + "display:none;margin-bottom:6px;"
        wrap.append(listHost)

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        let _records = null
        let _expanded = false

        const refresh = async () => {
            _records = await RouteAssistantInterlineStore.loadAll()
            const totalPartners = _records.reduce(
                (sum, r) => sum + (Array.isArray(r.partners) ? r.partners.length : 0), 0)
            const newest = _records.reduce(
                (mx, r) => Math.max(mx, Number(r.updatedAt) || 0), 0)
            const newestStr = newest ? new Date(newest).toLocaleString() : "never"
            status.textContent = _records.length + " route"
                + (_records.length === 1 ? "" : "s")
                + " · " + totalPartners + " partner"
                + (totalPartners === 1 ? "" : "s")
                + " · last update: " + newestStr
            clearBtn.disabled = !_records.length
            if (_expanded) this._renderInterlineBulkList(_records, listHost)
        }

        const viewBtn = document.createElement("button")
        Object.assign(viewBtn.style, smallBtnStyle())
        viewBtn.style.background = "#7c3aed"
        viewBtn.textContent = "View all records ▾"
        viewBtn.addEventListener("click", async () => {
            _expanded = !_expanded
            listHost.style.display = _expanded ? "block" : "none"
            viewBtn.textContent = _expanded ? "Hide records ▴" : "View all records ▾"
            if (_expanded) {
                if (_records === null) await refresh()
                else this._renderInterlineBulkList(_records, listHost)
            }
        })
        ctrlRow.append(viewBtn)

        const clearBtn = document.createElement("button")
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.textContent = "Clear all"
        clearBtn.disabled = true
        clearBtn.addEventListener("click", async () => {
            const recs = _records || await RouteAssistantInterlineStore.loadAll()
            if (!recs.length) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.info("No interline records to clear.")
                }
                return
            }
            const ok = window.confirm(
                "Delete every per-route interline record? "
                + recs.length + " route"
                + (recs.length === 1 ? "" : "s")
                + " across every hub.\n\nThis cannot be undone."
            )
            if (!ok) return
            let cleared = 0
            for (const rec of recs) {
                const pair = String(rec.pair || "")
                const dash = pair.indexOf("-")
                if (dash <= 0) continue
                const hub  = pair.substring(0, dash)
                const dest = pair.substring(dash + 1)
                if (!hub || !dest) continue
                try {
                    await RouteAssistantInterlineStore.clear(hub, dest)
                    cleared++
                } catch (e) {
                    console.warn("[AES interline bulk-clear] clear failed for " + pair + ":", e)
                }
            }
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.success(
                    "Cleared " + cleared + " interline record"
                    + (cleared === 1 ? "" : "s") + ".")
            }
            // Invalidate the panel's per-route caches in one pass so the
            // wave overlay drops every pill + the estimator stops trimming
            // LF without waiting for the next refresh().
            if (cleared > 0) {
                this.interlineByPair.clear()
                if (Array.isArray(this.rows)) {
                    for (const r of this.rows) { if (r) r.interlineShares = null }
                    RouteAssistantAggregator.applyFleetContext(
                        this.rows, this._fleetContext(), this._serviceContext())
                }
                this._waveBuild = null
                if (typeof this._render === "function") this._render()
            }
            await refresh()
        })
        ctrlRow.append(clearBtn)
        wrap.append(ctrlRow)

        try {
            await refresh()
        } catch (e) {
            status.textContent = "Failed to load interline records: "
                + (e && e.message ? e.message : String(e))
        }

        this.settingsHost.append(wrap)
    }

    /**
     * Letter L slice L6 — Canopy view settings expander.
     *
     *   - Status line: "X kin · Y partners · Z neutral · N unclassified"
     *     summarising the affiliation graph as it sees the leaderboards
     *     across visible rows.
     *   - "Active" toggle (also surfaced as the controls-bar pill).
     *   - Cannib threshold sliders (sharePct + minKin).
     *   - "Open Affiliations editor" CTA → existing options-page.
     *
     * Builds on L4-lite affiliations + L5 DNA. Read-only by default —
     * the only writes are local settings persistence.
     */
    window.RouteAssistantPanel.prototype._renderCanopyViewSection = function() {
        const cv = this.settings.canopyView = Object.assign({
            active: false,
            cannibShareThresholdPct: 80,
            cannibMinKin: 2,
            gapMinPaxScore: 8,
            showDnaFitOpportunities: true
        }, this.settings.canopyView || {})

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(6, 182, 212, 0.06);border:1px solid rgba(6, 182, 212, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#67e8f9;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Canopy view</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Federation-aware columns. "
            + "Classifies every leaderboard entry as kin (self) / partner (allied + interline + "
            + "codeshare) / neutral via the L4 affiliation graph and surfaces MyWk · Cmp* · "
            + "FShare · Cannib · Gap? columns. v1 sources kin hubs from this account's recent "
            + "hubs — sister-kin hubs land in L7.</span>"
        wrap.append(header)

        // Status: count classifications across visible rows.
        const counts = {kin: 0, partner: 0, neutral: 0, unclassified: 0, rowsWithSupply: 0}
        for (const r of (this.rows || [])) {
            const sup = r && r.canopySupply
            if (!sup) continue
            counts.rowsWithSupply++
            counts.kin += sup.kinCount || 0
            counts.partner += sup.partnerFlights || 0
            counts.neutral += sup.effectiveCompetitorCount || 0
            counts.unclassified += sup.unclassifiedCount || 0
        }
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        if (counts.rowsWithSupply === 0) {
            status.textContent = "No leaderboard data on visible rows yet — sync Markets to populate kin/partner/competitor counts."
        } else {
            status.textContent = "Across " + counts.rowsWithSupply + " row(s): "
                + counts.kin + " kin · " + counts.partner + " partner · "
                + counts.neutral + " neutral"
                + (counts.unclassified > 0 ? " · " + counts.unclassified + " unclassified (no enterpriseId)" : "")
        }
        wrap.append(status)

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;"

        // Active toggle.
        const activeCb = mkInput("checkbox", null)
        activeCb.checked = cv.active === true
        const activeLbl = document.createElement("label")
        activeLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#67e8f9;"
        activeLbl.append(activeCb, document.createTextNode("Active (show columns)"))
        activeCb.addEventListener("change", async () => {
            this.settings.canopyView.active = activeCb.checked
            try { await RouteAssistantSettings.save({canopyView: this.settings.canopyView}) }
            catch (e) { /* non-fatal */ }
            await this._applyCanopySupply()
            this._render()
        })
        ctrlRow.append(activeLbl)

        // L6 — DNA-fit pill toggle. Storage key stays as showDnaFitOpportunities
        // for back-compat with prior L5 saves, but the pill now renders on
        // every route row (not just NEW/UNDER) and click opens the explainer.
        const dnaCb = mkInput("checkbox", null)
        dnaCb.checked = cv.showDnaFitOpportunities !== false
        const dnaLbl = document.createElement("label")
        dnaLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#a7f3d0;"
        dnaLbl.title = "Show ◉/◐/◯ DNA-fit pill on every route row. Click the pill to open the DNA explainer. Scores against effective DNA via dnaFitScoreRoute."
        dnaLbl.append(dnaCb, document.createTextNode("DNA-fit pill on routes"))
        dnaCb.addEventListener("change", async () => {
            this.settings.canopyView.showDnaFitOpportunities = dnaCb.checked
            try { await RouteAssistantSettings.save({canopyView: this.settings.canopyView}) }
            catch (e) { /* non-fatal */ }
            this._renderRows()
        })
        ctrlRow.append(dnaLbl)

        wrap.append(ctrlRow)

        // Threshold row.
        const thrRow = document.createElement("div")
        thrRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;margin-top:6px;color:#9ca3af;"

        const cannibPctInp = mkInput("number", String(cv.cannibShareThresholdPct))
        cannibPctInp.style.width = "55px"
        cannibPctInp.min = "10"
        cannibPctInp.max = "100"
        cannibPctInp.step = "5"
        cannibPctInp.title = "Cannibalization fires when combined kin share crosses this percent."
        cannibPctInp.addEventListener("change", async () => {
            const v = Math.max(10, Math.min(100, Number(cannibPctInp.value) || 80))
            this.settings.canopyView.cannibShareThresholdPct = v
            cannibPctInp.value = String(v)
            try { await RouteAssistantSettings.save({canopyView: this.settings.canopyView}) }
            catch (e) { /* non-fatal */ }
            await this._applyCanopySupply()
            this._renderRows()
        })
        const cannibPctLbl = document.createElement("label")
        cannibPctLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        cannibPctLbl.append(document.createTextNode("Cannib threshold %:"), cannibPctInp)
        thrRow.append(cannibPctLbl)

        const cannibMinInp = mkInput("number", String(cv.cannibMinKin))
        cannibMinInp.style.width = "44px"
        cannibMinInp.min = "1"
        cannibMinInp.max = "10"
        cannibMinInp.step = "1"
        cannibMinInp.title = "Minimum kin count required before cannibalization fires (single-kin users never see it at minKin=2)."
        cannibMinInp.addEventListener("change", async () => {
            const v = Math.max(1, Math.min(10, Number(cannibMinInp.value) || 2))
            this.settings.canopyView.cannibMinKin = v
            cannibMinInp.value = String(v)
            try { await RouteAssistantSettings.save({canopyView: this.settings.canopyView}) }
            catch (e) { /* non-fatal */ }
            await this._applyCanopySupply()
            this._renderRows()
        })
        const cannibMinLbl = document.createElement("label")
        cannibMinLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        cannibMinLbl.append(document.createTextNode("min kin:"), cannibMinInp)
        thrRow.append(cannibMinLbl)

        const gapInp = mkInput("number", String(cv.gapMinPaxScore))
        gapInp.style.width = "44px"
        gapInp.min = "0"
        gapInp.max = "10"
        gapInp.step = "1"
        gapInp.title = "Minimum paxScore required for the Gap? glyph to fire on a kin-absent destination."
        gapInp.addEventListener("change", async () => {
            const v = Math.max(0, Math.min(10, Number(gapInp.value) || 8))
            this.settings.canopyView.gapMinPaxScore = v
            gapInp.value = String(v)
            try { await RouteAssistantSettings.save({canopyView: this.settings.canopyView}) }
            catch (e) { /* non-fatal */ }
            await this._applyCanopySupply()
            this._renderRows()
        })
        const gapLbl = document.createElement("label")
        gapLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        gapLbl.append(document.createTextNode("Gap? min paxScore:"), gapInp)
        thrRow.append(gapLbl)

        wrap.append(thrRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Affiliations are auto-classified from your contractual partners cache (L4-lite). "
            + "Adjust per-enterprise classification via "
            + "<strong>Settings → Account → Affiliations</strong> "
            + "(the Cmp popover's enterprise rows also surface affiliation badges). "
            + "Sister-kin federation hubs require the L1–L3 registry refactor — until then, kin "
            + "hub enumeration uses this account's recent hubs only."
        wrap.append(note)

        // Geography sub-card (L7) — country/region lens. Empty-state safe:
        // hides the column group toggle when the geography substrate isn't
        // loaded; otherwise lets the user enable the Country / Kin in / Reg
        // columns and deep-link to the regions editor.
        const gv = this.settings.geographyView = Object.assign({
            active: false
        }, this.settings.geographyView || {})
        const geoSubcard = document.createElement("div")
        geoSubcard.style.cssText = "margin-top:8px;padding:6px;background:rgba(34, 211, 238, 0.06);"
            + "border:1px solid rgba(34, 211, 238, 0.25);border-radius:3px;"
        const geoHdr = document.createElement("div")
        geoHdr.style.cssText = "color:#67e8f9;font-size:11px;margin-bottom:4px;"
        geoHdr.innerHTML = "<strong>Geography (L7)</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Country, kin density per country, "
            + "regulatory tags. Resolves destIata via demand cache → countryId → ISO2 → continent → user region.</span>"
        geoSubcard.append(geoHdr)

        const geoCtrl = document.createElement("div")
        geoCtrl.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const geoActiveCb = mkInput("checkbox", null)
        geoActiveCb.checked = gv.active === true
        const geoActiveLbl = document.createElement("label")
        geoActiveLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#67e8f9;"
        geoActiveLbl.append(geoActiveCb, document.createTextNode("Active (show columns)"))
        geoActiveCb.addEventListener("change", async () => {
            this.settings.geographyView.active = geoActiveCb.checked
            try { await RouteAssistantSettings.save({geographyView: this.settings.geographyView}) }
            catch (e) { /* non-fatal */ }
            await this._applyGeography()
            this._render()
        })
        geoCtrl.append(geoActiveLbl)

        const regBtn = document.createElement("button")
        regBtn.type = "button"
        regBtn.textContent = "Manage regions →"
        regBtn.style.cssText = "background:transparent;border:1px solid #67e8f9;color:#67e8f9;"
            + "padding:2px 8px;border-radius:3px;font-size:10.5px;cursor:pointer;"
        regBtn.title = "Open the regions editor (countries, ISO2, continents, regulatory tags)."
        regBtn.addEventListener("click", () => {
            try {
                const url = chrome.runtime.getURL("options.html#regions")
                window.open(url, "_blank")
            } catch (_) { /* noop */ }
        })
        geoCtrl.append(regBtn)
        geoSubcard.append(geoCtrl)

        // Status line: how many rows resolved, how many countries.
        const geoStatus = document.createElement("div")
        geoStatus.style.cssText = "color:#9ca3af;font-size:10px;margin-top:4px;"
        const seenCountries = new Set()
        let resolved = 0
        for (const r of (this.rows || [])) {
            const g = r && r.geography
            if (!g) continue
            resolved++
            if (g.iso2)         seenCountries.add(g.iso2)
            else if (g.countryId != null) seenCountries.add("c" + g.countryId)
        }
        geoStatus.textContent = resolved
            ? resolved + " row(s) resolved · " + seenCountries.size + " distinct country/-ies in view"
            : "No geography resolved yet — sync demand to populate destination country IDs."
        geoSubcard.append(geoStatus)
        wrap.append(geoSubcard)

        this.settingsHost.append(wrap)
    }

    /**
     * Render the bulk list into `host`. Groups records by hub and sorts
     * the current-hub group first; current-hub rows are clickable and
     * open the per-route popover, cross-hub rows are read-only.
     */
    window.RouteAssistantPanel.prototype._renderInterlineBulkList = function(records, host) {
        host.textContent = ""
        if (!records || !records.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#9ca3af;font-size:10px;padding:6px;"
            empty.textContent = "No interline records yet. Right-click any route in the table → Interlining…"
            host.append(empty)
            return
        }

        const byHub = new Map()
        for (const rec of records) {
            const pair = String(rec.pair || "")
            const dash = pair.indexOf("-")
            if (dash <= 0) continue
            const hub = pair.substring(0, dash)
            if (!byHub.has(hub)) byHub.set(hub, [])
            byHub.get(hub).push(rec)
        }

        const currentHub = String(this.hubIata || "").toUpperCase()
        const sortedHubs = Array.from(byHub.keys()).sort((a, b) => {
            if (a === currentHub) return -1
            if (b === currentHub) return 1
            return a.localeCompare(b)
        })

        for (const hub of sortedHubs) {
            const isCurrent = hub === currentHub
            const group = document.createElement("div")
            group.style.cssText = "margin-bottom:6px;"

            const hubHeader = document.createElement("div")
            hubHeader.style.cssText = "color:" + (isCurrent ? "#d8b4fe" : "#9ca3af")
                + ";font-size:10px;font-weight:bold;letter-spacing:0.5px;"
                + "margin:4px 0 2px 0;text-transform:uppercase;"
            hubHeader.textContent = hub + (isCurrent ? "  ·  current panel hub" : "")
            group.append(hubHeader)

            const list = byHub.get(hub).slice()
                .sort((a, b) => String(a.pair).localeCompare(String(b.pair)))
            for (const rec of list) {
                const pair = String(rec.pair)
                const dash = pair.indexOf("-")
                const dest = pair.substring(dash + 1)
                const rowEl = document.createElement("div")
                rowEl.style.cssText = "display:flex;gap:8px;align-items:center;"
                    + "padding:3px 4px;color:#e2e8f0;font-size:11px;"
                    + "cursor:" + (isCurrent ? "pointer" : "default") + ";"
                    + "border-radius:2px;"
                if (isCurrent) {
                    rowEl.addEventListener("mouseenter", () => {
                        rowEl.style.background = "rgba(168, 85, 247, 0.12)"
                    })
                    rowEl.addEventListener("mouseleave", () => {
                        rowEl.style.background = "transparent"
                    })
                    rowEl.addEventListener("click", () => {
                        this._openInterlinePopover({destIata: dest}, rowEl)
                    })
                    rowEl.title = "Click to open the interlining editor for this route"
                } else {
                    rowEl.title = "Switch to /app/com/scheduling/" + hub + " to edit this record"
                }

                const pairLabel = document.createElement("span")
                pairLabel.style.cssText = "font-family:monospace;color:#cbd5e1;min-width:84px;"
                pairLabel.textContent = pair
                rowEl.append(pairLabel)

                const partnerCount = (rec.partners || []).length
                const countLabel = document.createElement("span")
                countLabel.style.cssText = "color:#a1a1aa;min-width:70px;"
                countLabel.textContent = partnerCount + " partner"
                    + (partnerCount === 1 ? "" : "s")
                rowEl.append(countLabel)

                const sharesByClass = new Map()
                for (const p of (rec.partners || [])) {
                    const cls = p.productClass || "PAX"
                    sharesByClass.set(cls,
                        (sharesByClass.get(cls) || 0) + (Number(p.sharePercent) || 0))
                }
                const sharesLabel = document.createElement("span")
                sharesLabel.style.cssText = "color:#a1a1aa;flex:1;font-size:10px;"
                const sharesText = []
                for (const cls of ["Y", "C", "F", "PAX", "CARGO"]) {
                    if (sharesByClass.has(cls)) {
                        sharesText.push(cls + ":" + Math.round(sharesByClass.get(cls)) + "%")
                    }
                }
                sharesLabel.textContent = sharesText.length ? sharesText.join(" · ") : "—"
                rowEl.append(sharesLabel)

                const updatedLabel = document.createElement("span")
                updatedLabel.style.cssText = "color:#71717a;font-size:10px;min-width:64px;text-align:right;"
                updatedLabel.textContent = rec.updatedAt
                    ? new Date(rec.updatedAt).toLocaleDateString()
                    : "—"
                rowEl.append(updatedLabel)

                group.append(rowEl)
            }

            host.append(group)
        }
    }

    /**
     * Settings-drawer expander for demand-depth. Slate-tinted; sits
     * below Market Analysis. The `useRealDemandForLF` toggle prompts
     * a confirm the first time it's flipped on because it shifts
     * every existing profit number.
     */
    window.RouteAssistantPanel.prototype._renderDemandDepthSection = function() {
        const cfg = this.settings.demandDepth = Object.assign(
            {showDemandColumns: true, classCoverage: "summary", useRealDemandForLF: false,
             concurrency: 3, staggerMs: 1200, historicWindowPeriods: 12,
             lastBulkScrapeAt: null, historicMaxAgeDays: null, inventoryMaxAgeDays: 3},
            this.settings.demandDepth || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(100, 116, 139, 0.08);border:1px solid rgba(100, 116, 139, 0.35);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#cbd5e1;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Demand depth</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-class historic + inventory RM buckets. "
            + "Derives per-route demand pool, price elasticity, and RM tightness so the score blend can use real "
            + "AS demand instead of the 0–10 station badge.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.paxDemandPool != null || r.cargoDemandPool != null).length
        const lastSync  = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Synced: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastSync
            + " · class coverage: " + cfg.classCoverage
        wrap.append(status)
        this._demandStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showDemandColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;"
        showLbl.append(showCb, document.createTextNode("Show demand columns"))
        showCb.addEventListener("change", async () => {
            this.settings.demandDepth.showDemandColumns = showCb.checked
            await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})
            this._render()
        })
        ctrlRow.append(showLbl)

        const coverageSel = mkSelect([
            {value: "summary", label: "Coverage: Summary (PAX + CARGO)"},
            {value: "full",    label: "Coverage: Full (Y / C / F / PAX / CARGO)"}
        ], cfg.classCoverage || "summary")
        coverageSel.addEventListener("change", async () => {
            this.settings.demandDepth.classCoverage = coverageSel.value
            await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})
            this._renderSettings()
        })
        ctrlRow.append(coverageSel)

        const realCb = mkInput("checkbox", null)
        realCb.checked = !!cfg.useRealDemandForLF
        const realLbl = document.createElement("label")
        realLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fde68a;"
        realLbl.title = "Advanced — when on, the profit estimator uses pool / weeklySeats for LF instead of the 0–10 paxScore interpolation. Routes with no pool yet keep the paxScore path."
        realLbl.append(realCb, document.createTextNode("Use real demand for LF (advanced)"))
        realCb.addEventListener("change", async () => {
            if (realCb.checked && !cfg.useRealDemandForLF) {
                if (!confirm("Switch profit-estimator load factor to real demand pool?\n\nThis will shift every $/flt and $/wk number on routes that have demand-depth data. Routes without pool data keep the existing paxScore path.")) {
                    realCb.checked = false
                    return
                }
            }
            this.settings.demandDepth.useRealDemandForLF = realCb.checked
            await RouteAssistantSettings.save({demandDepth: this.settings.demandDepth})
            RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
            this._render()
        })
        ctrlRow.append(realLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._demandScrapeRunning
            ? "Syncing demand…"
            : "Sync demand depth"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#475569"
        scanBtn.disabled = !!this._demandScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkDemandSync())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Heavy scrape — " + (cfg.classCoverage === "full" ? "5" : "2")
            + " markets fetches × every visible route + 1 inventory fetch each. "
            + cfg.concurrency + " concurrent / " + cfg.staggerMs + "ms stagger. "
            + "Friendly to a parallel ORS sync (different endpoint)."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Settings drawer expander for alert rules. Lists existing rules
     * with enable toggle + delete; an "Add rule" row with field /
     * operator / threshold / scope / severity inputs. Saves through
     * RouteAssistantAlertRulesStore.
     */
    window.RouteAssistantPanel.prototype._renderAlertRulesSection = function() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fde68a;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Active prompts</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Rules that fire a notification "
            + "when a field crosses your threshold. Evaluated on every panel mount against the "
            + "diff-decorated rows. Watchlist scope (default) only fires for ★-starred routes; "
            + "All scope fires for every visible row. Cooldown (default 24h) suppresses repeats "
            + "of the same rule+route within the window.</span>"
        wrap.append(header)

        const rules = this._alertRules || []
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const enabledCount = rules.filter(r => r.enabled).length
        status.textContent = "Rules: " + rules.length + " (" + enabledCount + " enabled)"
        wrap.append(status)

        // Existing rules list ----------------------------------------------
        if (rules.length) {
            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:6px;"
            for (const rule of rules) {
                list.append(this._buildAlertRuleRow(rule))
            }
            wrap.append(list)
        }

        // Add-rule row ------------------------------------------------------
        const addWrap = document.createElement("div")
        addWrap.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;"
            + "padding-top:4px;border-top:1px solid rgba(251,191,36,0.20);"
        const addLabel = document.createElement("span")
        addLabel.textContent = "Add rule:"
        addLabel.style.color = "#fde68a"
        addWrap.append(addLabel)

        const fieldOpts = (typeof RouteAssistantAlertEvaluator !== "undefined")
            ? RouteAssistantAlertEvaluator.availableFields()
            : []
        const fieldSel = document.createElement("select")
        fieldSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;padding:1px 4px;font-size:11px;max-width:200px;"
        for (const f of fieldOpts) {
            const o = document.createElement("option")
            o.value = f.field
            o.textContent = f.label
            fieldSel.append(o)
        }
        addWrap.append(fieldSel)

        const opSel = document.createElement("select")
        opSel.style.cssText = fieldSel.style.cssText
        for (const op of [
            {value: "increased_by", label: "increased by"},
            {value: "decreased_by", label: "decreased by"},
            {value: "above",        label: "above"},
            {value: "below",        label: "below"}
        ]) {
            const o = document.createElement("option")
            o.value = op.value
            o.textContent = op.label
            opSel.append(o)
        }
        addWrap.append(opSel)

        const thrInput = document.createElement("input")
        thrInput.type = "number"
        thrInput.step = "any"
        thrInput.placeholder = "threshold"
        thrInput.style.cssText = "width:90px;background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;padding:1px 4px;font-size:11px;"
        addWrap.append(thrInput)

        const scopeSel = document.createElement("select")
        scopeSel.style.cssText = fieldSel.style.cssText
        for (const sc of [
            {value: "watchlist", label: "watchlist only"},
            {value: "all",       label: "all routes"}
        ]) {
            const o = document.createElement("option")
            o.value = sc.value
            o.textContent = sc.label
            scopeSel.append(o)
        }
        addWrap.append(scopeSel)

        const sevSel = document.createElement("select")
        sevSel.style.cssText = fieldSel.style.cssText
        for (const sv of [
            {value: "warn",  label: "warn"},
            {value: "info",  label: "info"},
            {value: "error", label: "error"}
        ]) {
            const o = document.createElement("option")
            o.value = sv.value
            o.textContent = sv.label
            sevSel.append(o)
        }
        addWrap.append(sevSel)

        const addBtn = document.createElement("button")
        addBtn.textContent = "+ Add"
        Object.assign(addBtn.style, smallBtnStyle())
        addBtn.style.background = "#92400e"
        addBtn.style.color = "#fde68a"
        addBtn.addEventListener("click", async () => {
            const t = Number(thrInput.value)
            if (!isFinite(t)) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.warn("Enter a numeric threshold first.")
                }
                return
            }
            try {
                await RouteAssistantAlertRulesStore.add({
                    field:    fieldSel.value,
                    operator: opSel.value,
                    threshold: t,
                    scope:    scopeSel.value,
                    severity: sevSel.value
                })
                await this._loadAlertRules()
                this._alertFiredThisMount = new Set()  // re-evaluate against new rule next render
                this._renderSettings()
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.success("Alert rule added.")
                }
            } catch (e) {
                if (typeof RouteAssistantToast !== "undefined") {
                    RouteAssistantToast.error("Couldn't add rule: " + (e && e.message ? e.message : e))
                }
            }
        })
        addWrap.append(addBtn)
        wrap.append(addWrap)

        this.settingsHost.append(wrap)
    }

}
