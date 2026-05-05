"use strict"

/**
 * Letter M slice M0 — kin roles sub-page modal.
 *
 * Lists every registered account and lets the user view + override the
 * conglomerate role assigned by `AesCanopyRoleDetector`. Backed by
 * `AesCanopyRoleStore`.
 *
 * Mirrors `orgs-settings-page.js` / `regions-settings-page.js` shape so
 * the three canopy management pages feel consistent.
 *
 * Public API:
 *   AesCanopyRolesSettingsPage.open()
 *   AesCanopyRolesSettingsPage.close()
 */
;(function () {
    if (window.AesCanopyRolesSettingsPage) return

    let _modal = null
    let _state = {accounts: [], roles: {}, selectedId: null, detections: new Map()}

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    async function _loadAccountRegistry() {
        if (!window.AesAccountRegistry) return []
        try {
            const list = await window.AesAccountRegistry.list()
            return Array.isArray(list) ? list : []
        } catch (_) { return [] }
    }

    async function _loadRoles() {
        if (!window.AesCanopyRoleStore) return {}
        try {
            return await window.AesCanopyRoleStore.getAll()
        } catch (_) { return {} }
    }

    /**
     * Re-run the detector against the live FleetCommand view (federated)
     * if it's loaded. Updates the role-store via `applyDetection` so the
     * detection survives a page reload, then returns the in-memory map.
     */
    async function _runDetector() {
        const out = new Map()
        if (!window.AesCanopyRoleDetector) return out
        if (!window.AesFleetCommand) return out
        try {
            const view = await window.AesFleetCommand.build()
            const detections = window.AesCanopyRoleDetector.detectAllFromFleetCommand(view)
            for (const [accountId, det] of detections.entries()) {
                if (window.AesCanopyRoleStore) {
                    try { await window.AesCanopyRoleStore.applyDetection(accountId, det) } catch (_) {}
                }
                out.set(accountId, det)
            }
        } catch (_) {}
        return out
    }

    async function _refresh(opts) {
        const reDetect = !!(opts && opts.detect)
        _state.accounts = await _loadAccountRegistry()
        if (reDetect) {
            _state.detections = await _runDetector()
        }
        _state.roles = await _loadRoles()
        if (!_state.selectedId && _state.accounts.length) {
            _state.selectedId = _state.accounts[0].id
        }
        _render()
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-roles-settings"
        root.style.cssText =
            "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999987;" +
            "display:none;align-items:flex-start;justify-content:center;padding-top:8vh;"
        root.addEventListener("click", (e) => { if (e.target === root) close() })
        const box = document.createElement("div")
        box.style.cssText =
            "width:min(960px,94vw);max-height:82vh;background:#0f172a;color:#e2e8f0;" +
            "border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;" +
            "flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;"
        root.appendChild(box)

        const header = document.createElement("div")
        header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(148,163,184,0.18)"
        header.innerHTML =
            '<div style="display:flex;flex-direction:column">' +
            '<div style="font-weight:600;font-size:14px">Kin roles</div>' +
            '<div style="font-size:11px;color:#94a3b8">Assign each airline its conglomerate role for cross-kin coordination (Letter M slice M0).</div>' +
            '</div>'
        const headerActions = document.createElement("div")
        headerActions.style.cssText = "display:flex;gap:6px;align-items:center"
        const detectBtn = document.createElement("button")
        detectBtn.id = "aes-roles-detect"
        detectBtn.textContent = "Re-detect all"
        detectBtn.title = "Re-run the heuristic detector against the federated FleetCommand view. Only changes role assignments where no user override is in place."
        detectBtn.style.cssText = "background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px"
        detectBtn.addEventListener("click", async () => {
            detectBtn.disabled = true
            detectBtn.textContent = "Detecting…"
            try { await _refresh({detect: true}) } catch (_) {}
            detectBtn.disabled = false
            detectBtn.textContent = "Re-detect all"
        })
        headerActions.appendChild(detectBtn)
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
            '<div id="aes-roles-list" style="border-right:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:8px"></div>' +
            '<div id="aes-roles-detail" style="overflow-y:auto;padding:14px"></div>'
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
        const host = document.getElementById("aes-roles-list")
        if (!host) return
        const html = []
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">')
        html.push('Accounts (' + _state.accounts.length + ')</div>')
        if (!_state.accounts.length) {
            html.push('<div style="font-size:11px;color:#64748b;padding:12px;text-align:center;font-style:italic">No accounts registered yet — visit AS pages to populate the registry.</div>')
        }
        for (const acc of _state.accounts) {
            const id = acc.id || ""
            const sel = (id === _state.selectedId)
            const rec = _state.roles[id]
            const role = rec ? rec.role : "unclassified"
            const label = window.AesCanopyRoleStore ? window.AesCanopyRoleStore.roleLabel(role) : role
            const color = window.AesCanopyRoleStore ? window.AesCanopyRoleStore.roleColor(role) : "#94a3b8"
            const overridden = rec && rec.roleAutoDetected === false
            html.push(
                '<div data-id="' + _esc(id) + '" style="' +
                'cursor:pointer;padding:8px;border-radius:3px;font-size:12px;margin-bottom:3px;' +
                (sel ? "background:rgba(59,130,246,0.18);" : "") + '">' +
                '<div style="display:flex;align-items:center;gap:6px">' +
                '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + '"></span>' +
                '<span style="font-weight:500">' + _esc(acc.displayName || acc.airlineIdentity || id) + '</span>' +
                (overridden ? '<span title="User override is in place" style="font-size:9px;color:#fbbf24">★</span>' : '') +
                '</div>' +
                '<div style="color:#94a3b8;font-size:10px;margin-top:3px;padding-left:14px">' +
                _esc(label) + ' · ' + _esc(acc.server || "?") +
                '</div>' +
                '</div>'
            )
        }
        host.innerHTML = html.join("")
        host.querySelectorAll("[data-id]").forEach(el => {
            el.addEventListener("click", () => {
                _state.selectedId = el.dataset.id
                _render()
            })
        })
    }

    function _renderDetail() {
        const host = document.getElementById("aes-roles-detail")
        if (!host) return
        const acc = _state.accounts.find(a => a.id === _state.selectedId)
        if (!acc) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px">Select an account on the left.</div>'
            return
        }
        const rec = _state.roles[acc.id] || {role: "unclassified", roleAutoDetected: true, autoDetectedRole: null, autoDetectedSignals: [], brandFloor: {}, primaryHubs: [], secondaryHubs: [], excludedHubs: [], notes: ""}
        const detection = _state.detections.get(acc.id) || null
        const ROLE_IDS = (window.AesCanopyRoleStore && window.AesCanopyRoleStore.ROLE_IDS) || []
        const ROLE_LABELS = (window.AesCanopyRoleStore && window.AesCanopyRoleStore.ROLE_LABELS) || {}
        const overridden = rec.roleAutoDetected === false

        const html = []
        html.push('<div style="margin-bottom:10px">')
        html.push('<div style="font-size:13px;font-weight:600">' + _esc(acc.displayName || acc.airlineIdentity || acc.id) + '</div>')
        html.push('<div style="font-size:11px;color:#94a3b8">' + _esc(acc.server || "?") + ' · ' + _esc(acc.airlineIdentity || acc.id) + '</div>')
        html.push('</div>')

        // Role picker
        html.push('<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">')
        html.push('<label style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;min-width:60px">Role</label>')
        html.push('<select id="aes-role-select" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:6px 8px;border-radius:3px;font-size:12px;flex:1">')
        html.push('<option value="unclassified"' + (rec.role === "unclassified" ? " selected" : "") + '>' + _esc(ROLE_LABELS.unclassified || "Unclassified") + '</option>')
        for (const r of ROLE_IDS) {
            html.push('<option value="' + _esc(r) + '"' + (rec.role === r ? " selected" : "") + '>' + _esc(ROLE_LABELS[r] || r) + '</option>')
        }
        html.push('</select>')
        if (overridden) {
            html.push('<button id="aes-role-reset" title="Drop the user override and revert to the auto-detected role." style="background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:11px">Reset to detected</button>')
        }
        html.push('</div>')

        // Detection summary
        const detRole = detection ? detection.role : (rec.autoDetectedRole || null)
        const detSignals = detection ? detection.signals : (rec.autoDetectedSignals || [])
        const detConf = detection ? detection.confidence : (rec.autoDetectedConfidence || 0)
        html.push('<div style="background:rgba(148,163,184,0.06);border-radius:4px;padding:10px 12px;margin:10px 0;font-size:11px">')
        html.push('<div style="color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Auto-detected</div>')
        if (detRole) {
            html.push('<div style="font-size:12px;color:#e2e8f0">' + _esc(ROLE_LABELS[detRole] || detRole) + ' · confidence ' + Math.round((detConf || 0) * 100) + '%</div>')
            if (detSignals && detSignals.length) {
                html.push('<ul style="margin:6px 0 0 18px;padding:0;color:#cbd5e1">')
                for (const s of detSignals) html.push('<li>' + _esc(s) + '</li>')
                html.push('</ul>')
            }
        } else {
            html.push('<div style="color:#64748b;font-style:italic">No detection yet. Click "Re-detect all" in the header.</div>')
        }
        html.push('</div>')

        // Hubs
        html.push('<div style="margin-top:12px">')
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Hubs</div>')
        html.push('<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:11px">')
        html.push('<label>Primary</label><input id="aes-role-primaryhubs" type="text" value="' + _esc((rec.primaryHubs || []).join(", ")) + '" placeholder="e.g. JFK, LHR" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:4px 8px;border-radius:3px;font-family:ui-monospace,monospace">')
        html.push('<label>Secondary</label><input id="aes-role-secondaryhubs" type="text" value="' + _esc((rec.secondaryHubs || []).join(", ")) + '" placeholder="e.g. BOS, ORD" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:4px 8px;border-radius:3px;font-family:ui-monospace,monospace">')
        html.push('<label>Excluded</label><input id="aes-role-excludedhubs" type="text" value="' + _esc((rec.excludedHubs || []).join(", ")) + '" placeholder="hubs this kin should NOT enter" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:4px 8px;border-radius:3px;font-family:ui-monospace,monospace">')
        html.push('</div>')
        html.push('</div>')

        // Brand floor
        html.push('<div style="margin-top:12px">')
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Brand floor (advisory)</div>')
        html.push('<div style="font-size:10px;color:#64748b;margin-bottom:6px">Per-class price floor that other kin should not undercut. M2 anti-cannibalization reads these. Empty = no floor.</div>')
        html.push('<div style="display:grid;grid-template-columns:auto 1fr auto 1fr auto 1fr;gap:6px 8px;align-items:center;font-size:11px">')
        html.push('<label>Y</label><input id="aes-role-bf-y" type="number" min="0" value="' + _esc(rec.brandFloor && rec.brandFloor.Y != null ? rec.brandFloor.Y : "") + '" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:4px 8px;border-radius:3px;font-family:ui-monospace,monospace;width:80px">')
        html.push('<label>C</label><input id="aes-role-bf-c" type="number" min="0" value="' + _esc(rec.brandFloor && rec.brandFloor.C != null ? rec.brandFloor.C : "") + '" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:4px 8px;border-radius:3px;font-family:ui-monospace,monospace;width:80px">')
        html.push('<label>F</label><input id="aes-role-bf-f" type="number" min="0" value="' + _esc(rec.brandFloor && rec.brandFloor.F != null ? rec.brandFloor.F : "") + '" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:4px 8px;border-radius:3px;font-family:ui-monospace,monospace;width:80px">')
        html.push('</div>')
        html.push('</div>')

        // Notes
        html.push('<div style="margin-top:12px">')
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Notes</div>')
        html.push('<textarea id="aes-role-notes" rows="3" placeholder="Why this kin holds this role; any standing instructions for cross-kin proposers." style="width:100%;background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:6px 8px;border-radius:3px;font-family:ui-sans-serif;font-size:12px;box-sizing:border-box;resize:vertical">' + _esc(rec.notes || "") + '</textarea>')
        html.push('</div>')

        // Save / cancel
        html.push('<div style="margin-top:14px;display:flex;justify-content:flex-end;gap:6px">')
        html.push('<button id="aes-role-save" style="background:#3b82f6;border:none;color:#fff;padding:6px 16px;border-radius:3px;cursor:pointer;font-size:11px">Save</button>')
        html.push('</div>')

        host.innerHTML = html.join("")

        const sel = host.querySelector("#aes-role-select")
        const resetBtn = host.querySelector("#aes-role-reset")
        const saveBtn = host.querySelector("#aes-role-save")

        if (resetBtn) resetBtn.addEventListener("click", async () => {
            await window.AesCanopyRoleStore.resetToDetected(acc.id)
            await _refresh()
        })

        if (saveBtn) saveBtn.addEventListener("click", async () => {
            const newRole = sel.value
            const primaryHubs = _parseIataList(host.querySelector("#aes-role-primaryhubs").value)
            const secondaryHubs = _parseIataList(host.querySelector("#aes-role-secondaryhubs").value)
            const excludedHubs = _parseIataList(host.querySelector("#aes-role-excludedhubs").value)
            const yV = host.querySelector("#aes-role-bf-y").value
            const cV = host.querySelector("#aes-role-bf-c").value
            const fV = host.querySelector("#aes-role-bf-f").value
            const brandFloor = {
                Y: yV === "" ? null : Number(yV),
                C: cV === "" ? null : Number(cV),
                F: fV === "" ? null : Number(fV)
            }
            const notes = host.querySelector("#aes-role-notes").value
            // setRole flips roleAutoDetected to false (user override is absolute).
            if (newRole !== rec.role || rec.roleAutoDetected !== false) {
                await window.AesCanopyRoleStore.setRole(acc.id, newRole, {source: "user"})
            }
            await window.AesCanopyRoleStore.update(acc.id, {primaryHubs, secondaryHubs, excludedHubs, brandFloor, notes})
            await _refresh()
        })
    }

    function _parseIataList(raw) {
        if (!raw) return []
        return String(raw).split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{3}$/.test(s)).slice(0, 32)
    }

    async function open() {
        _ensureModal()
        // First open: refresh accounts + role records, then run detector for
        // any accounts without a stored detection.
        await _refresh()
        const needsDetect = (_state.accounts || []).some(acc => {
            const r = _state.roles[acc.id]
            return !r || !r.autoDetectedAt
        })
        if (needsDetect) {
            await _refresh({detect: true})
        }
        _modal.style.display = "flex"
    }

    function close() {
        if (_modal) _modal.style.display = "none"
    }

    window.AesCanopyRolesSettingsPage = {open, close}
})()
