"use strict"

/**
 * Letter L slice L5 — per-account DNA editor.
 *
 * Master-detail modal: 280px left rail (account list) + right detail pane.
 * Each dimension renders with an inherit/override toggle at the dim level;
 * for object dims, per-leaf overrides too. Effective DNA per account =
 * `deepMerge(template, override)` at leaf level.
 *
 * Mirrors `roles-settings-page.js` shape so the canopy management pages
 * feel consistent.
 *
 * Public API:
 *   AesCanopyDnaAccountEditor.open()
 *   AesCanopyDnaAccountEditor.close()
 */
;(function () {
    if (window.AesCanopyDnaAccountEditor) return

    let _modal = null
    let _state = {accounts: [], template: null, overrides: {}, selectedId: null}

    function _esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }

    async function _refresh() {
        if (window.AesAccountRegistry) {
            try {
                _state.accounts = await window.AesAccountRegistry.list()
            } catch (_) { _state.accounts = [] }
        }
        if (window.AesCanopyDnaStore) {
            try {
                _state.template = await window.AesCanopyDnaStore.loadTemplate()
                _state.overrides = await window.AesCanopyDnaStore.loadAllOverrides()
            } catch (_) {}
        }
        if (!_state.selectedId && _state.accounts.length) {
            _state.selectedId = _state.accounts[0].id
        }
        _render()
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-dna-account-editor"
        root.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999988;display:none;align-items:flex-start;justify-content:center;padding-top:8vh"
        root.addEventListener("click", (e) => { if (e.target === root) close() })
        const box = document.createElement("div")
        box.style.cssText = "width:min(960px,94vw);max-height:82vh;background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif"
        root.appendChild(box)

        const header = document.createElement("div")
        header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(148,163,184,0.18)"
        header.innerHTML =
            '<div style="display:flex;flex-direction:column">' +
            '<div style="font-weight:600;font-size:14px">Per-account DNA</div>' +
            '<div style="font-size:11px;color:#94a3b8">Override the global template for individual airlines. Effective DNA = template + override (leaf-level merge).</div>' +
            '</div>'
        const headerActions = document.createElement("div")
        headerActions.style.cssText = "display:flex;gap:6px;align-items:center"
        const editTpl = document.createElement("button")
        editTpl.textContent = "Edit template →"
        editTpl.title = "Open the wizard to edit the global DNA template that all accounts inherit from."
        editTpl.style.cssText = "background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px"
        editTpl.addEventListener("click", () => {
            close()
            if (window.AesCanopyDnaWizard) window.AesCanopyDnaWizard.open({reason: "edit"})
        })
        headerActions.appendChild(editTpl)
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px"
        closeBtn.addEventListener("click", () => close())
        headerActions.appendChild(closeBtn)
        header.appendChild(headerActions)
        box.appendChild(header)

        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:280px 1fr;flex:1;overflow:hidden"
        body.innerHTML =
            '<div id="aes-dna-acct-list" style="border-right:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:8px"></div>' +
            '<div id="aes-dna-acct-detail" style="overflow-y:auto;padding:14px"></div>'
        box.appendChild(body)

        document.body.appendChild(root)
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && root.style.display !== "none") close()
        })
        _modal = root
        return root
    }

    function _render() {
        _renderList()
        _renderDetail()
    }

    function _renderList() {
        const host = document.getElementById("aes-dna-acct-list")
        if (!host) return
        const html = []
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Accounts (' + _state.accounts.length + ')</div>')
        if (!_state.accounts.length) {
            html.push('<div style="font-size:11px;color:#64748b;padding:12px;text-align:center;font-style:italic">No accounts registered yet — visit AS pages to populate the registry.</div>')
        }
        for (const acc of _state.accounts) {
            const id = acc.id || ""
            const sel = (id === _state.selectedId)
            const ov = _state.overrides[id] || {}
            const overrideCount = Object.keys(ov).length
            html.push(
                '<div data-id="' + _esc(id) + '" style="cursor:pointer;padding:8px;border-radius:3px;font-size:12px;margin-bottom:3px;' +
                (sel ? "background:rgba(59,130,246,0.18);" : "") + '">' +
                '<div style="display:flex;align-items:center;gap:6px;justify-content:space-between">' +
                '<span style="font-weight:500">' + _esc(acc.displayName || acc.airlineIdentity || id) + '</span>' +
                '<span data-fit-host="' + _esc(id) + '"></span>' +
                '</div>' +
                '<div style="color:#94a3b8;font-size:10px;margin-top:3px">' +
                _esc(acc.server || "?") + ' · ' +
                (overrideCount > 0 ? '<span style="color:#f59e0b">' + overrideCount + ' override' + (overrideCount === 1 ? '' : 's') + '</span>' : '<span>inheriting template</span>') +
                '</div>' +
                '</div>'
            )
        }
        host.innerHTML = html.join("")
        host.querySelectorAll("[data-id]").forEach(el => {
            el.addEventListener("click", () => { _state.selectedId = el.dataset.id; _render() })
        })
        // Render fit pills async (each needs an effectiveDna lookup)
        for (const acc of _state.accounts) {
            const fitHost = host.querySelector('[data-fit-host="' + acc.id + '"]')
            if (!fitHost || !window.AesCanopyDnaFit) continue
            _renderAccountFitPill(fitHost, acc.id)
        }
    }

    async function _renderAccountFitPill(host, accountId) {
        try {
            const eff = await window.AesCanopyDnaStore.effectiveDna(accountId)
            const observed = window.AesCanopyDnaDrift ? await window.AesCanopyDnaDrift.observedStateFor(accountId) : null
            if (!observed || !Object.keys(observed).length) return
            const r = window.AesCanopyDnaFit.dnaFitScoreAccountState(eff, observed)
            host.textContent = ""
            window.AesCanopyDnaFit.renderInto(host, r, {label: "Account vs effective DNA"})
        } catch (_) {}
    }

    function _renderDetail() {
        const host = document.getElementById("aes-dna-acct-detail")
        if (!host) return
        const acc = _state.accounts.find(a => a.id === _state.selectedId)
        if (!acc) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px">Select an account on the left.</div>'
            return
        }
        host.innerHTML = ""

        const head = document.createElement("div")
        head.style.cssText = "margin-bottom:14px"
        head.innerHTML =
            '<div style="font-size:13px;font-weight:600">' + _esc(acc.displayName || acc.airlineIdentity || acc.id) + '</div>' +
            '<div style="font-size:11px;color:#94a3b8">' + _esc(acc.server || "?") + ' · ' + _esc(acc.airlineIdentity || acc.id) + '</div>'
        host.appendChild(head)

        // Per-dim editor rows
        const ov = _state.overrides[acc.id] || {}
        for (const dim of (window.AesCanopyDnaStore.DIMENSIONS || [])) {
            host.appendChild(_renderDimRow(acc.id, dim, ov))
        }

        // Footer: clear-all + sync-strategy
        const footer = document.createElement("div")
        footer.style.cssText = "display:flex;justify-content:space-between;gap:8px;margin-top:14px;padding-top:10px;border-top:1px dashed rgba(148,163,184,0.18)"
        const clear = document.createElement("button")
        clear.textContent = "Clear all overrides"
        clear.style.cssText = "background:transparent;border:1px solid rgba(239,68,68,0.45);color:#fca5a5;padding:5px 12px;border-radius:3px;cursor:pointer;font-size:11px"
        clear.addEventListener("click", async () => {
            if (!window.confirm("Clear ALL overrides for this account? It will inherit the template fully.")) return
            await window.AesCanopyDnaStore.clearAllOverrides(acc.id)
            await _refresh()
        })
        footer.appendChild(clear)
        const sync = document.createElement("button")
        sync.textContent = "Sync DNA → Strategy"
        sync.title = "Write the effective DNA's riskProfile into settings.strategy.riskProfile for this account. Advisory-only by default — explicit action required so DNA never silently flips Strategy."
        sync.style.cssText = "background:#3b82f6;border:1px solid #3b82f6;color:#fff;padding:5px 12px;border-radius:3px;cursor:pointer;font-size:11px"
        sync.addEventListener("click", async () => {
            const eff = await window.AesCanopyDnaStore.effectiveDna(acc.id)
            const rp = eff.riskProfile
            if (!rp) return
            try {
                const current = await window.AesStrategySettings.load()
                if (current.riskProfile === rp) {
                    window.alert("Strategy riskProfile already matches DNA: " + rp)
                    return
                }
                if (!window.confirm("Set strategy.riskProfile to '" + rp + "' for the active account? (Was: " + (current.riskProfile || "unset") + ")")) return
                await window.AesStrategySettings.save({riskProfile: rp})
                window.alert("Strategy riskProfile updated.")
            } catch (e) {
                window.alert("Sync failed: " + (e && e.message))
            }
        })
        footer.appendChild(sync)
        host.appendChild(footer)
    }

    function _renderDimRow(accountId, dim, ov) {
        const overridden = (dim.key in ov)
        const tplVal = _state.template ? _state.template[dim.key] : null

        const row = document.createElement("div")
        row.style.cssText = "padding:10px 12px;background:rgba(148,163,184,0.06);border-radius:4px;margin-bottom:8px;border-left:3px solid " + (overridden ? "#f59e0b" : "transparent")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px"

        const left = document.createElement("div")
        left.style.cssText = "display:flex;align-items:center;gap:6px"
        const label = document.createElement("div")
        label.style.cssText = "font-size:12px;font-weight:600"
        label.textContent = dim.label
        left.appendChild(label)
        if (overridden) {
            const badge = document.createElement("span")
            badge.textContent = "Δ"
            badge.title = "This dimension overrides the template."
            badge.style.cssText = "color:#f59e0b;font-weight:700;font-size:11px"
            left.appendChild(badge)
        }
        head.appendChild(left)

        const right = document.createElement("div")
        right.style.cssText = "display:flex;align-items:center;gap:6px"
        const toggleLabel = document.createElement("label")
        toggleLabel.style.cssText = "font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:4px;cursor:pointer"
        const toggle = document.createElement("input")
        toggle.type = "checkbox"
        toggle.checked = overridden
        toggle.addEventListener("change", async () => {
            if (toggle.checked) {
                // Initialize the override with the current template value
                const seed = _seedForDim(dim, tplVal)
                await window.AesCanopyDnaStore.saveOverride(accountId, {[dim.key]: seed})
            } else {
                await window.AesCanopyDnaStore.clearOverrideDimension(accountId, dim.key)
            }
            await _refresh()
        })
        toggleLabel.appendChild(toggle)
        toggleLabel.appendChild(document.createTextNode("Override"))
        right.appendChild(toggleLabel)
        if (overridden) {
            const reset = document.createElement("button")
            reset.textContent = "Reset to template"
            reset.style.cssText = "background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:10px"
            reset.addEventListener("click", async () => {
                await window.AesCanopyDnaStore.clearOverrideDimension(accountId, dim.key)
                await _refresh()
            })
            right.appendChild(reset)
        }
        head.appendChild(right)
        row.appendChild(head)

        // Body — only show editable controls when overridden, else show inherited preview
        if (!overridden) {
            const preview = document.createElement("div")
            preview.style.cssText = "font-size:11px;color:#94a3b8;font-family:ui-monospace,monospace"
            preview.textContent = "Inherits: " + _formatDimValue(dim, tplVal)
            row.appendChild(preview)
        } else {
            const ovVal = ov[dim.key]
            row.appendChild(_buildDimControl(accountId, dim, ovVal, tplVal))
        }
        return row
    }

    function _seedForDim(dim, tplVal) {
        if (dim.kind === "enum")    return tplVal
        if (dim.kind === "number")  return tplVal
        if (dim.kind === "object")  return Object.assign({}, tplVal)
        return tplVal
    }

    function _formatDimValue(dim, val) {
        if (val == null) return "(no value)"
        if (dim.kind === "enum")   return String(val)
        if (dim.kind === "number") return Number(val).toFixed(2)
        if (dim.kind === "object") {
            return dim.leaves.map(l => l + ": " + (Number(val[l]) || 0).toFixed(2)).join(" · ")
        }
        return String(val)
    }

    function _buildDimControl(accountId, dim, ovVal, tplVal) {
        const wrap = document.createElement("div")
        if (dim.kind === "enum") {
            const grp = document.createElement("div")
            grp.style.cssText = "display:flex;gap:6px;flex-wrap:wrap"
            for (const opt of dim.options) {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.textContent = opt
                const selected = ovVal === opt
                btn.style.cssText = [
                    "padding:4px 10px",
                    "font-size:11px",
                    "border-radius:3px",
                    "cursor:pointer",
                    "border:1px solid " + (selected ? "#3b82f6" : "rgba(148,163,184,0.35)"),
                    "background:" + (selected ? "rgba(59,130,246,0.18)" : "transparent"),
                    "color:" + (selected ? "#dbeafe" : "#cbd5e1")
                ].join(";")
                btn.addEventListener("click", async () => {
                    await window.AesCanopyDnaStore.saveOverride(accountId, {[dim.key]: opt})
                    await _refresh()
                })
                grp.appendChild(btn)
            }
            wrap.appendChild(grp)
        } else if (dim.kind === "number") {
            const r = dim.range || {min: 0, max: 1, step: 0.05}
            const cur = Number(ovVal)
            const slider = document.createElement("input")
            slider.type = "range"
            slider.min = r.min; slider.max = r.max; slider.step = r.step
            slider.value = isFinite(cur) ? cur : tplVal
            slider.style.cssText = "width:100%"
            const valEl = document.createElement("div")
            valEl.style.cssText = "font-family:ui-monospace,monospace;font-size:11px;color:#cbd5e1;margin-top:4px"
            valEl.textContent = Number(slider.value).toFixed(2) + " (template " + Number(tplVal).toFixed(2) + ")"
            slider.addEventListener("input", () => { valEl.textContent = Number(slider.value).toFixed(2) + " (template " + Number(tplVal).toFixed(2) + ")" })
            slider.addEventListener("change", async () => {
                await window.AesCanopyDnaStore.saveOverride(accountId, {[dim.key]: Number(slider.value)})
                await _refresh()
            })
            wrap.appendChild(slider); wrap.appendChild(valEl)
        } else if (dim.kind === "object") {
            const grid = document.createElement("div")
            grid.style.cssText = "display:grid;grid-template-columns:auto 1fr auto auto;gap:4px 10px;align-items:center"
            const r = dim.range || {min: 0, max: 1, step: 0.05}
            for (const leaf of dim.leaves) {
                const lab = document.createElement("label")
                lab.style.cssText = "font-size:11px;color:#94a3b8;text-align:right;min-width:80px"
                lab.textContent = leaf
                grid.appendChild(lab)
                const leafOverridden = ovVal && (leaf in ovVal)
                const cur = leafOverridden ? Number(ovVal[leaf]) : Number(tplVal && tplVal[leaf])
                const slider = document.createElement("input")
                slider.type = "range"
                slider.min = r.min; slider.max = r.max; slider.step = r.step
                slider.value = isFinite(cur) ? cur : 0
                slider.disabled = !leafOverridden
                slider.style.cssText = "width:100%"
                const valEl = document.createElement("div")
                valEl.style.cssText = "font-family:ui-monospace,monospace;font-size:11px;color:" + (leafOverridden ? "#cbd5e1" : "#64748b") + ";min-width:50px;text-align:right"
                valEl.textContent = Number(slider.value).toFixed(2) + (leafOverridden ? "" : " (inh.)")
                slider.addEventListener("input", () => { valEl.textContent = Number(slider.value).toFixed(2) })
                slider.addEventListener("change", async () => {
                    await window.AesCanopyDnaStore.saveOverride(accountId, {[dim.key]: {[leaf]: Number(slider.value)}})
                    await _refresh()
                })
                grid.appendChild(slider); grid.appendChild(valEl)
                const leafToggle = document.createElement("button")
                leafToggle.type = "button"
                leafToggle.textContent = leafOverridden ? "Inherit leaf" : "Override leaf"
                leafToggle.style.cssText = "background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:3px 6px;border-radius:3px;cursor:pointer;font-size:10px"
                leafToggle.addEventListener("click", async () => {
                    if (leafOverridden) {
                        await window.AesCanopyDnaStore.clearOverrideLeaf(accountId, [dim.key, leaf])
                    } else {
                        await window.AesCanopyDnaStore.saveOverride(accountId, {[dim.key]: {[leaf]: Number(tplVal && tplVal[leaf]) || 0}})
                    }
                    await _refresh()
                })
                grid.appendChild(leafToggle)
            }
            wrap.appendChild(grid)
        }
        return wrap
    }

    async function open() {
        _ensureModal()
        await _refresh()
        _modal.style.display = "flex"
    }

    function close() {
        if (_modal) _modal.style.display = "none"
    }

    window.AesCanopyDnaAccountEditor = {open, close}
})()
