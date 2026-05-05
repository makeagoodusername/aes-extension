"use strict"

/**
 * Regions sub-page modal — lists every user-defined region, lets the
 * user create / rename / delete and edit membership (continents + ISO2
 * codes + AS countryIds). Also exposes per-region defaults
 * (defaultPresetId, utilizationTarget, maintTargetRatio) consumed by
 * Lane B's wave registry and Lane C's optimizer rollups.
 *
 * Storage backed by AesCanopyRegionsStore.
 */
;(function () {
    if (window.AesCanopyRegionsSettingsPage) return

    let _modal = null
    let _state = {regions: [], defaults: {}, selectedId: null}

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    async function _refresh() {
        if (!window.AesCanopyRegionsStore) {
            _state.regions = []; _state.defaults = {}
        } else {
            const block = await window.AesCanopyRegionsStore.load()
            _state.regions = Object.values(block.regions || {})
                .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
            _state.defaults = block.defaults || {}
        }
        _render()
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-regions-settings"
        root.style.cssText =
            "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999987;" +
            "display:none;align-items:flex-start;justify-content:center;padding-top:8vh;"
        root.addEventListener("click", (e) => { if (e.target === root) close() })
        const box = document.createElement("div")
        box.style.cssText =
            "width:min(960px,92vw);max-height:80vh;background:#0f172a;color:#e2e8f0;" +
            "border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;" +
            "flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;"
        root.appendChild(box)
        const header = document.createElement("div")
        header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(148,163,184,0.18)"
        header.innerHTML = '<div style="font-weight:600;font-size:14px">Geographic Regions</div>'
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px"
        closeBtn.addEventListener("click", () => close())
        header.appendChild(closeBtn)
        box.appendChild(header)
        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:240px 1fr;flex:1;overflow:hidden"
        body.innerHTML =
            '<div id="aes-regions-list" style="border-right:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:8px"></div>' +
            '<div id="aes-regions-detail" style="overflow-y:auto;padding:12px"></div>'
        box.appendChild(body)
        const footer = document.createElement("div")
        footer.style.cssText = "padding:8px 16px;border-top:1px solid rgba(148,163,184,0.18);font-size:11px;color:#94a3b8"
        footer.innerHTML = 'Tip: regions match by country (most specific) → ISO2 → continent. Defaults seed from <code style="color:#cbd5e1">AesGeographyBase</code>.'
        box.appendChild(footer)
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
        const host = document.getElementById("aes-regions-list")
        if (!host) return
        const html = []
        html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">')
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em">Regions (' + _state.regions.length + ')</div>')
        html.push('<button data-action="create" style="background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px">+ New</button>')
        html.push('</div>')
        for (const r of _state.regions) {
            const sel = (r.id === _state.selectedId)
            const total = (r.countries || []).length + (r.iso2Codes || []).length + (r.continents || []).length
            html.push(
                '<div data-id="' + _esc(r.id) + '" style="' +
                'cursor:pointer;padding:6px 8px;border-radius:3px;font-size:12px;margin-bottom:2px;' +
                (sel ? "background:rgba(59,130,246,0.18);" : "") + '">' +
                _esc(r.name) +
                '<div style="color:#64748b;font-size:10px;margin-top:2px">' +
                total + ' selector' + (total === 1 ? '' : 's') +
                '</div></div>'
            )
        }
        html.push('<div style="margin-top:12px"><button data-action="reset" style="background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px;width:100%">Reset to defaults</button></div>')
        host.innerHTML = html.join("")
        host.querySelectorAll("[data-id]").forEach(el => {
            el.addEventListener("click", () => {
                _state.selectedId = el.dataset.id
                _render()
            })
        })
        const create = host.querySelector('[data-action="create"]')
        if (create) create.addEventListener("click", async () => {
            const name = window.prompt("New region name:", "Trans-Pacific")
            if (!name) return
            const r = await window.AesCanopyRegionsStore.create({name})
            _state.selectedId = r.id
            await _refresh()
        })
        const reset = host.querySelector('[data-action="reset"]')
        if (reset) reset.addEventListener("click", async () => {
            if (!window.confirm("Reset all regions to default seeds? Custom regions will be lost.")) return
            await window.AesCanopyRegionsStore.resetToSeeds()
            _state.selectedId = null
            await _refresh()
        })
    }

    function _renderDetail() {
        const host = document.getElementById("aes-regions-detail")
        if (!host) return
        const r = _state.regions.find(x => x.id === _state.selectedId)
        if (!r) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px">Select a region or create one</div>'
            return
        }
        const continents = (window.AesGeographyBase && window.AesGeographyBase.listContinents)
            ? window.AesGeographyBase.listContinents() : []
        const html = []
        html.push('<div style="display:flex;gap:8px;margin-bottom:12px">')
        html.push('<input type="text" id="aes-region-name" value="' + _esc(r.name) + '" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:6px 8px;border-radius:3px;font-size:13px;flex:1">')
        html.push('<button data-action="rename" style="background:#3b82f6;border:none;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:11px">Rename</button>')
        html.push('<button data-action="delete" style="background:transparent;border:1px solid #ef4444;color:#ef4444;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:11px">Delete</button>')
        html.push('</div>')

        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Continents</div>')
        html.push('<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">')
        for (const c of continents) {
            const on = Array.isArray(r.continents) && r.continents.indexOf(c.id) >= 0
            html.push('<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:3px 8px;border-radius:3px;background:' +
                     (on ? "rgba(59,130,246,0.18)" : "rgba(148,163,184,0.06)") + '">' +
                     '<input type="checkbox" data-continent="' + _esc(c.id) + '"' + (on ? " checked" : "") +
                     ' style="margin:0">' + _esc(c.label) + '</label>')
        }
        html.push('</div>')

        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">ISO2 codes</div>')
        html.push('<input type="text" id="aes-region-iso2" placeholder="DE,FR,IT (comma-separated)" value="' +
                  _esc((r.iso2Codes || []).join(",")) +
                  '" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:6px 8px;border-radius:3px;font-size:12px;width:100%;margin-bottom:12px">')

        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">AS countryIds</div>')
        html.push('<input type="text" id="aes-region-country-ids" placeholder="123,456 (comma-separated)" value="' +
                  _esc((r.countries || []).join(",")) +
                  '" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:6px 8px;border-radius:3px;font-size:12px;width:100%;margin-bottom:12px">')

        html.push('<button data-action="saveMembership" style="background:#3b82f6;border:none;color:#fff;padding:6px 16px;border-radius:3px;cursor:pointer;font-size:11px">Save membership</button>')

        // Defaults
        const d = _state.defaults[r.id] || {}
        html.push('<div style="margin-top:24px;padding-top:12px;border-top:1px solid rgba(148,163,184,0.18)">')
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Defaults (Lane B/C consumers)</div>')
        html.push('<div style="display:grid;grid-template-columns:160px 1fr;gap:6px 12px;font-size:12px;align-items:center">')
        html.push('<div>Default preset id</div><input type="text" id="aes-region-default-preset" value="' +
                  _esc(d.defaultPresetId || "") + '" placeholder="(none)" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:4px 6px;border-radius:3px;font-size:11px">')
        html.push('<div>Utilization target</div><input type="number" id="aes-region-util-target" min="0" max="1" step="0.05" value="' +
                  (d.utilizationTarget != null ? d.utilizationTarget : "") +
                  '" placeholder="0.0–1.0" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:4px 6px;border-radius:3px;font-size:11px">')
        html.push('<div>Maint target ratio</div><input type="number" id="aes-region-maint-target" min="80" max="120" step="0.5" value="' +
                  (d.maintTargetRatio != null ? d.maintTargetRatio : "") +
                  '" placeholder="(default)" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:4px 6px;border-radius:3px;font-size:11px">')
        html.push('</div>')
        html.push('<button data-action="saveDefaults" style="background:#3b82f6;border:none;color:#fff;padding:6px 16px;border-radius:3px;cursor:pointer;font-size:11px;margin-top:8px">Save defaults</button>')
        html.push('</div>')

        host.innerHTML = html.join("")
        const renameBtn = host.querySelector('[data-action="rename"]')
        const deleteBtn = host.querySelector('[data-action="delete"]')
        const saveMembership = host.querySelector('[data-action="saveMembership"]')
        const saveDefaults = host.querySelector('[data-action="saveDefaults"]')

        if (renameBtn) renameBtn.addEventListener("click", async () => {
            const newName = (host.querySelector("#aes-region-name").value || "").trim()
            if (!newName || newName === r.name) return
            await window.AesCanopyRegionsStore.update(r.id, {name: newName})
            await _refresh()
        })
        if (deleteBtn) deleteBtn.addEventListener("click", async () => {
            if (!window.confirm("Delete '" + r.name + "'? This cannot be undone.")) return
            await window.AesCanopyRegionsStore.remove(r.id)
            _state.selectedId = null
            await _refresh()
        })
        if (saveMembership) saveMembership.addEventListener("click", async () => {
            const continents = []
            host.querySelectorAll("[data-continent]").forEach(el => {
                if (el.checked) continents.push(el.dataset.continent)
            })
            const iso2Raw = (host.querySelector("#aes-region-iso2").value || "")
                .toUpperCase().split(",").map(s => s.trim()).filter(Boolean)
            const cidsRaw = (host.querySelector("#aes-region-country-ids").value || "")
                .split(",").map(s => Number(s.trim())).filter(n => isFinite(n))
            await window.AesCanopyRegionsStore.update(r.id, {
                continents,
                iso2Codes: iso2Raw,
                countries: cidsRaw
            })
            await _refresh()
        })
        if (saveDefaults) saveDefaults.addEventListener("click", async () => {
            const dp = (host.querySelector("#aes-region-default-preset").value || "").trim() || null
            const utRaw = host.querySelector("#aes-region-util-target").value
            const mtRaw = host.querySelector("#aes-region-maint-target").value
            const ut = utRaw === "" ? null : Number(utRaw)
            const mt = mtRaw === "" ? null : Number(mtRaw)
            await window.AesCanopyRegionsStore.setDefault(r.id, {
                defaultPresetId: dp,
                utilizationTarget: (isFinite(ut) ? ut : null),
                maintTargetRatio: (isFinite(mt) ? mt : null)
            })
            await _refresh()
        })
    }

    async function open() {
        _ensureModal()
        await _refresh()
        _modal.style.display = "flex"
    }

    function close() {
        if (_modal) _modal.style.display = "none"
    }

    window.AesCanopyRegionsSettingsPage = {open, close}
})()
