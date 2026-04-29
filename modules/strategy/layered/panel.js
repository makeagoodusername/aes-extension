"use strict"

/**
 * AES Strategy — layered overrides panel (Slice 5).
 *
 * A self-contained modal that lets the user view + edit the layered
 * strategy at any scope (Family / Account / Division / Fleet / Route).
 * Tiny on purpose: per CLAUDE.md "keep customization the priority,
 * don't over-engineer." Five tabs, four knobs each, inheritance
 * badges, kill-switch toggles row, save/import/export buttons.
 *
 * Public API (window.AesStrategyLayeredPanel):
 *   open(opts?)   → void   opts: {scope?, hub?, dest?, divisionId?, fleetId?}
 *   close()       → void
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredPanel) return

    const KILL_SWITCHES = [
        {key: "aesStrategy:layered:enabled",          label: "Master"},
        {key: "aesStrategy:layered:family:enabled",   label: "Family"},
        {key: "aesStrategy:layered:division:enabled", label: "Division"},
        {key: "aesStrategy:layered:fleet:enabled",    label: "Fleet"},
        {key: "aesStrategy:layered:route:enabled",    label: "Route"}
    ]

    const KNOBS = [
        {path: "priceDeadband",          label: "Price deadband",         kind: "number", min: 0, max: 50, step: 1},
        {path: "maxPriceMovePerWindow",  label: "Max price move/window",  kind: "number", min: 0, max: 50, step: 1},
        {path: "weights.profitWeight",   label: "Profit weight",          kind: "number", min: 0, max: 1, step: 0.05},
        {path: "minOrsTarget",           label: "Min ORS target",         kind: "number", min: 0, max: 1, step: 0.05},
        {path: "routeCreationThreshold", label: "Route creation threshold", kind: "number", min: 0, max: 1, step: 0.05},
        {path: "riskProfile",            label: "Risk profile",           kind: "select", options: ["conservative", "balanced", "aggressive"]},
        {path: "objective.kind",         label: "Objective",              kind: "select", options: ["balanced", "maxShare", "maxProfit", "custom"]}
    ]

    let _root = null

    function _getNested(obj, path) {
        const parts = path.split(".")
        let cur = obj
        for (const p of parts) {
            if (!cur || typeof cur !== "object") return undefined
            cur = cur[p]
        }
        return cur
    }
    function _setNested(obj, path, val) {
        const parts = path.split(".")
        const last = parts.pop()
        let cur = obj
        for (const p of parts) {
            if (!cur[p] || typeof cur[p] !== "object") cur[p] = {}
            cur = cur[p]
        }
        if (val === null || val === undefined) delete cur[last]
        else cur[last] = val
    }

    function _el(tag, attrs, text) {
        const e = document.createElement(tag)
        if (attrs) {
            for (const k in attrs) {
                if (k === "style" && typeof attrs[k] === "object") {
                    Object.assign(e.style, attrs[k])
                } else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
                    e.addEventListener(k.slice(2), attrs[k])
                } else if (k === "value") {
                    e.value = attrs[k]
                } else {
                    e.setAttribute(k, attrs[k])
                }
            }
        }
        if (text != null) e.textContent = text
        return e
    }

    function _btn(label, onclick, primary) {
        return _el("button", {
            type: "button", onclick: onclick,
            style: {
                padding: "4px 10px", border: "1px solid #444",
                background: primary ? "#1a4f7a" : "#222", color: "#eee",
                cursor: "pointer", borderRadius: "2px", fontSize: "12px",
                marginRight: "6px"
            }
        }, label)
    }

    async function _readKillSwitches() {
        const keys = KILL_SWITCHES.map(k => k.key)
        try {
            const data = await chrome.storage.local.get(keys)
            const out = {}
            for (const k of keys) out[k] = !!data[k]
            return out
        } catch (_) { return {} }
    }

    async function _writeKillSwitch(key, on) {
        const obj = {}
        obj[key] = !!on
        try { await chrome.storage.local.set(obj) } catch (_) {}
        try {
            if (window.AesStrategyLayered && typeof window.AesStrategyLayered.invalidateCache === "function") {
                window.AesStrategyLayered.invalidateCache()
            }
        } catch (_) {}
    }

    function _accountId() {
        if (typeof currentAccountIdSync === "function") {
            try { return currentAccountIdSync() || null } catch (_) {}
        }
        return (window.__aesAccountId) || null
    }

    function _provenanceLabel(prov) {
        if (!prov) return "default"
        const layer = prov.layer || "default"
        return layer
    }

    function _provColor(layer) {
        switch (layer) {
            case "family":   return "#5a7fbe"
            case "account":  return "#7a7a7a"
            case "division": return "#7e8a4a"
            case "fleet":    return "#aa6b3e"
            case "route":    return "#3a8a5a"
            default:         return "#444"
        }
    }

    function _modalShell() {
        const overlay = _el("div", {
            "data-aes-layered-panel": "1",
            style: {
                position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)",
                zIndex: "999999", display: "flex", alignItems: "center",
                justifyContent: "center", fontFamily: "system-ui, sans-serif",
                color: "#eee", fontSize: "13px"
            }
        })
        const dialog = _el("div", {
            style: {
                width: "min(820px, 92vw)", maxHeight: "86vh",
                background: "#181818", border: "1px solid #333",
                display: "flex", flexDirection: "column"
            }
        })
        overlay.appendChild(dialog)
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) close()
        })
        return {overlay, dialog}
    }

    function close() {
        if (_root && _root.parentNode) _root.parentNode.removeChild(_root)
        _root = null
    }

    async function _renderKillSwitchRow(host) {
        const row = _el("div", {style: {
            padding: "8px 14px", background: "#222", borderBottom: "1px solid #333",
            display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center"
        }})
        const ks = await _readKillSwitches()
        for (const item of KILL_SWITCHES) {
            const wrap = _el("label", {style: {
                display: "flex", alignItems: "center", gap: "4px", cursor: "pointer"
            }})
            const cb = _el("input", {type: "checkbox"})
            cb.checked = !!ks[item.key]
            cb.addEventListener("change", async function () {
                await _writeKillSwitch(item.key, cb.checked)
            })
            const lbl = _el("span", {}, item.label)
            wrap.append(cb, lbl)
            row.appendChild(wrap)
        }
        host.appendChild(row)
    }

    function _renderTabs(host, state, onChange) {
        const tabs = ["family", "account", "division", "fleet", "route"]
        const row = _el("div", {style: {
            display: "flex", borderBottom: "1px solid #333", background: "#1f1f1f"
        }})
        for (const t of tabs) {
            const tab = _el("button", {
                type: "button",
                style: {
                    padding: "8px 14px", border: "none",
                    background: state.scope === t ? "#2a2a2a" : "transparent",
                    color: state.scope === t ? "#fff" : "#aaa",
                    cursor: "pointer", borderBottom: state.scope === t ? "2px solid " + _provColor(t) : "2px solid transparent",
                    textTransform: "capitalize", fontSize: "12px"
                },
                onclick: function () { onChange(t) }
            }, t)
            row.appendChild(tab)
        }
        host.appendChild(row)
    }

    async function _resolveCurrentEffective(state) {
        if (!window.AesStrategyLayered) return null
        try {
            const r = await window.AesStrategyLayered.resolveEffectiveStrategy({
                accountId: _accountId(),
                hub:       state.hub  || null,
                dest:      state.dest || null
            })
            return r
        } catch (_) { return null }
    }

    async function _loadActiveLayerRecord(state) {
        if (state.scope === "family") {
            const F = window.AesStrategyLayeredFamily
            if (!F) return {error: "Family store not loaded on this page."}
            const active = await F.resolveActiveKinId({accountId: _accountId()})
            if (!active) return {error: "No kin sister affiliation found for the active account."}
            const rec = (await F.load(active.kinId)) || {patch: {}, pinned: {}, label: ""}
            return {scope: {layer: "family", kinId: active.kinId}, record: rec, kinId: active.kinId}
        }
        if (state.scope === "account") {
            // Account layer is the existing AesStrategySettings save() target.
            // The panel surfaces it READ-ONLY (use the existing tuning panel
            // to edit the account block — keeps Slice 17 invariants intact).
            const settings = window.AesStrategySettings ? await window.AesStrategySettings.load() : null
            return {scope: {layer: "account", accountId: _accountId()}, record: {patch: settings || {}, pinned: {}, label: ""}, readonly: true}
        }
        if (state.scope === "division") {
            const D = window.AesStrategyLayeredDivision
            if (!D) return {error: "Division store not loaded on this page."}
            const list = await D.listForAccount(_accountId())
            if (!state.divisionId && list.length) state.divisionId = list[0].id
            if (!state.divisionId) return {scope: {layer: "division"}, record: {patch: {}, pinned: {}, label: ""}, list, empty: true}
            const rec = (await D.loadRecord(_accountId(), state.divisionId)) || {patch: {}, pinned: {}, label: ""}
            return {scope: {layer: "division", accountId: _accountId(), divisionId: state.divisionId},
                    record: rec, list, divisionId: state.divisionId}
        }
        if (state.scope === "fleet") {
            const F = window.AesStrategyLayeredFleet
            if (!F) return {error: "Fleet store not loaded on this page."}
            const list = await F.listForAccount(_accountId())
            if (!state.fleetId && list.length) state.fleetId = list[0].id
            if (!state.fleetId) return {scope: {layer: "fleet"}, record: {patch: {}, pinned: {}, label: ""}, list, empty: true}
            const rec = (await F.loadRecord(_accountId(), state.fleetId)) || {patch: {}, pinned: {}, label: ""}
            return {scope: {layer: "fleet", accountId: _accountId(), fleetId: state.fleetId},
                    record: rec, list, fleetId: state.fleetId}
        }
        if (state.scope === "route") {
            if (!state.hub || !state.dest) {
                return {error: "Route scope needs hub + dest. Pass hub/dest when opening the panel."}
            }
            const R = window.AesStrategyLayeredRouteExtras
            if (!R) return {error: "Route extras store not loaded on this page."}
            const rec = (await R.load(_accountId(), state.hub, state.dest)) || {patch: {}, pinned: {}, label: ""}
            return {scope: {layer: "route-extras", accountId: _accountId(), hub: state.hub, dest: state.dest},
                    record: rec}
        }
        return {error: "Unknown scope"}
    }

    async function _saveActiveLayerRecord(state, info) {
        if (info.readonly) return
        if (state.scope === "family") {
            await window.AesStrategyLayeredFamily.save({
                kinId:  info.kinId,
                patch:  info.record.patch,
                pinned: info.record.pinned,
                label:  info.record.label || ""
            })
        } else if (state.scope === "division") {
            await window.AesStrategyLayeredDivision.saveRecord(_accountId(), info.divisionId, {
                patch:  info.record.patch,
                pinned: info.record.pinned,
                label:  info.record.label || ""
            })
        } else if (state.scope === "fleet") {
            await window.AesStrategyLayeredFleet.saveRecord(_accountId(), info.fleetId, {
                patch:  info.record.patch,
                pinned: info.record.pinned,
                label:  info.record.label || ""
            })
        } else if (state.scope === "route") {
            await window.AesStrategyLayeredRouteExtras.save(_accountId(), state.hub, state.dest, {
                patch:  info.record.patch,
                pinned: info.record.pinned,
                label:  info.record.label || ""
            })
        }
    }

    async function _renderBody(host, state) {
        host.innerHTML = ""
        const eff = await _resolveCurrentEffective(state)
        const info = await _loadActiveLayerRecord(state)
        if (info.error) {
            host.appendChild(_el("div", {style: {padding: "20px", color: "#aaa"}}, info.error))
            return
        }

        // For division/fleet, show member-record picker.
        if (info.list) {
            const picker = _el("div", {style: {padding: "10px 14px", background: "#1d1d1d", borderBottom: "1px solid #333"}})
            picker.appendChild(_el("label", {style: {marginRight: "8px"}},
                state.scope === "division" ? "Division: " : "Fleet: "))
            const sel = _el("select", {style: {background: "#222", color: "#eee", border: "1px solid #444", padding: "3px 6px", marginRight: "8px"}})
            if (info.empty) sel.appendChild(_el("option", {value: ""}, "— none —"))
            for (const it of info.list) {
                const opt = _el("option", {value: it.id}, it.name + (it.kind ? "  (" + it.kind + ")" : ""))
                if (state.scope === "division" ? state.divisionId === it.id : state.fleetId === it.id) opt.setAttribute("selected", "")
                sel.appendChild(opt)
            }
            sel.addEventListener("change", function () {
                if (state.scope === "division") state.divisionId = sel.value
                else state.fleetId = sel.value
                _renderBody(host, state)
            })
            picker.appendChild(sel)
            picker.appendChild(_btn("+ New", async function () {
                const name = window.prompt("Name?")
                if (!name) return
                const kind = window.prompt("Kind? " + ["manual", "region", "aircraft-types", "aircraft-cats", "aircraft-ids", "org-ref"].join(" / "), "manual")
                if (!kind) return
                if (state.scope === "division") {
                    const def = await window.AesStrategyLayeredDivision.create(_accountId(),
                        {name: name, kind: kind, members: {}, priority: 100})
                    state.divisionId = def.id
                } else {
                    const def = await window.AesStrategyLayeredFleet.create(_accountId(),
                        {name: name, kind: kind, members: {}, priority: 100})
                    state.fleetId = def.id
                }
                _renderBody(host, state)
            }))
            picker.appendChild(_btn("Edit members", function () {
                const id = state.scope === "division" ? state.divisionId : state.fleetId
                if (!id) return
                const cur = info.list.find(d => d.id === id)
                if (!cur) return
                const text = window.prompt("Members JSON for kind=" + cur.kind, JSON.stringify(cur.members || {}))
                if (text == null) return
                let parsed
                try { parsed = JSON.parse(text) } catch (e) { window.alert("Invalid JSON"); return }
                const apiUpdate = (state.scope === "division")
                    ? window.AesStrategyLayeredDivision.updateDef
                    : window.AesStrategyLayeredFleet.updateDef
                apiUpdate(_accountId(), id, {members: parsed}).then(function () {
                    _renderBody(host, state)
                })
            }))
            picker.appendChild(_btn("Delete", async function () {
                const id = state.scope === "division" ? state.divisionId : state.fleetId
                if (!id) return
                if (!window.confirm("Delete this " + state.scope + "?")) return
                if (state.scope === "division") {
                    await window.AesStrategyLayeredDivision.removeDef(_accountId(), id)
                    state.divisionId = null
                } else {
                    await window.AesStrategyLayeredFleet.removeDef(_accountId(), id)
                    state.fleetId = null
                }
                _renderBody(host, state)
            }))
            host.appendChild(picker)
        }

        // Knob editor
        const form = _el("div", {style: {padding: "12px 14px", overflowY: "auto", flex: "1"}})
        if (info.empty) {
            form.appendChild(_el("div", {style: {color: "#aaa", fontStyle: "italic"}}, "Create a " + state.scope + " above to start editing its overrides."))
            host.appendChild(form)
            return
        }

        const provenance = (eff && eff.provenance) || {}
        const patch  = info.record.patch  || {}
        const pinned = info.record.pinned || {}

        for (const knob of KNOBS) {
            const row = _el("div", {style: {display: "grid", gridTemplateColumns: "180px 1fr 100px 80px 80px",
                gap: "10px", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #2a2a2a"}})
            row.appendChild(_el("label", {}, knob.label))
            const layerProv = provenance[knob.path]
            const provLayer = (layerProv && layerProv.layer) || "default"
            const effVal = eff && eff.effective ? _getNested(eff.effective, knob.path) : null
            const layerVal = _getNested(patch, knob.path)
            const isPinned = !!pinned[knob.path]

            let input
            if (knob.kind === "select") {
                input = _el("select", {style: {background: "#222", color: "#eee", border: "1px solid #444", padding: "3px"}})
                input.appendChild(_el("option", {value: ""}, "— inherit —"))
                for (const opt of knob.options) {
                    const o = _el("option", {value: opt}, opt)
                    if (String(layerVal) === opt) o.setAttribute("selected", "")
                    input.appendChild(o)
                }
            } else {
                input = _el("input", {
                    type: "number", min: knob.min, max: knob.max, step: knob.step,
                    style: {background: "#222", color: "#eee", border: "1px solid #444", padding: "3px", width: "120px"}
                })
                input.value = (layerVal != null) ? String(layerVal) : ""
                input.placeholder = "inherit"
            }
            row.appendChild(input)

            // Effective value badge
            const effBadge = _el("span", {style: {color: "#888", fontSize: "11px"}}, "→ " + (effVal != null ? String(effVal) : "—"))
            row.appendChild(effBadge)

            // Provenance pill
            const prov = _el("span", {style: {
                display: "inline-block", padding: "1px 6px", borderRadius: "8px",
                background: _provColor(provLayer), fontSize: "10px", textTransform: "uppercase"
            }}, provLayer)
            row.appendChild(prov)

            // Pin toggle
            const pinWrap = _el("label", {style: {display: "flex", gap: "4px", alignItems: "center", fontSize: "11px", color: "#999"}})
            const pinCb = _el("input", {type: "checkbox"})
            pinCb.checked = isPinned
            pinCb.addEventListener("change", function () {
                if (pinCb.checked) pinned[knob.path] = true
                else delete pinned[knob.path]
                info.record.pinned = pinned
            })
            pinWrap.append(pinCb, _el("span", {}, "pin"))
            row.appendChild(pinWrap)

            input.addEventListener("change", function () {
                let v = input.value
                if (v === "") {
                    _setNested(patch, knob.path, null)
                    delete pinned[knob.path]
                    pinCb.checked = false
                } else {
                    if (knob.kind === "number") v = Number(v)
                    _setNested(patch, knob.path, v)
                    pinned[knob.path] = true
                    pinCb.checked = true
                }
                info.record.patch  = patch
                info.record.pinned = pinned
            })
            form.appendChild(row)
        }

        // Save / export / import strip
        const actions = _el("div", {style: {display: "flex", padding: "10px 14px", borderTop: "1px solid #333", background: "#1f1f1f"}})
        if (info.readonly) {
            actions.appendChild(_el("span", {style: {color: "#aaa", fontStyle: "italic"}}, "Account layer is read-only here. Edit via the existing strategy panel."))
        } else {
            actions.appendChild(_btn("Save", async function () {
                try {
                    await _saveActiveLayerRecord(state, info)
                    actions.appendChild(_el("span", {style: {color: "#5a5", marginLeft: "8px"}}, "saved"))
                    setTimeout(() => _renderBody(host, state), 600)
                } catch (e) {
                    window.alert("Save failed: " + e.message)
                }
            }, true))
            actions.appendChild(_btn("Reset layer", async function () {
                if (!window.confirm("Clear this layer's overrides?")) return
                info.record.patch = {}
                info.record.pinned = {}
                await _saveActiveLayerRecord(state, info)
                _renderBody(host, state)
            }))
            actions.appendChild(_btn("Export JSON", async function () {
                if (!window.AesStrategyLayeredCodec) return window.alert("Codec not loaded.")
                try {
                    const bundle = await window.AesStrategyLayeredCodec.exportBundle(info.scope)
                    window.prompt("Bundle JSON (copy to clipboard):", window.AesStrategyLayeredCodec.stringify(bundle))
                } catch (e) { window.alert("Export failed: " + e.message) }
            }))
            actions.appendChild(_btn("Import JSON", async function () {
                if (!window.AesStrategyLayeredCodec) return window.alert("Codec not loaded.")
                const text = window.prompt("Paste bundle JSON:")
                if (!text) return
                const result = await window.AesStrategyLayeredCodec.apply(text)
                if (!result.ok) window.alert("Import failed: " + result.reason)
                else _renderBody(host, state)
            }))
        }
        host.appendChild(form)
        host.appendChild(actions)
    }

    async function open(opts) {
        opts = opts || {}
        if (_root) close()
        const {overlay, dialog} = _modalShell()
        _root = overlay

        const header = _el("div", {style: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "10px 14px", background: "#222", borderBottom: "1px solid #333"
        }})
        header.appendChild(_el("strong", {}, "Layered strategy overrides"))
        const closeBtn = _btn("×", close)
        closeBtn.style.fontSize = "16px"
        header.appendChild(closeBtn)
        dialog.appendChild(header)

        await _renderKillSwitchRow(dialog)

        const state = {
            scope: opts.scope || "family",
            hub: opts.hub || null, dest: opts.dest || null,
            divisionId: opts.divisionId || null, fleetId: opts.fleetId || null
        }

        const tabsRow = _el("div")
        dialog.appendChild(tabsRow)
        const body = _el("div", {style: {display: "flex", flexDirection: "column", overflow: "hidden", flex: "1", minHeight: "300px"}})
        dialog.appendChild(body)

        function _renderTabsAndBody() {
            tabsRow.innerHTML = ""
            _renderTabs(tabsRow, state, function (next) {
                state.scope = next
                _renderTabsAndBody()
            })
            _renderBody(body, state)
        }
        _renderTabsAndBody()

        document.body.appendChild(overlay)
    }

    window.AesStrategyLayeredPanel = {open: open, close: close}
})()
