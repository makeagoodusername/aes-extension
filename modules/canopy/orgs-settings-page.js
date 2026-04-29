"use strict"

/**
 * Organisations sub-page modal — lists every user-defined org, lets the
 * user create / rename / delete, and edit member account/airline tuples.
 *
 * Storage backed by AesCanopyOrgsStore. No POSTs. Read-write via the
 * existing canopy:orgs-changed bus event.
 *
 * Public API:
 *   AesCanopyOrgsSettingsPage.open()
 *   AesCanopyOrgsSettingsPage.close()
 */
;(function () {
    if (window.AesCanopyOrgsSettingsPage) return

    let _modal = null
    let _state = {orgs: [], selectedId: null, registry: []}

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    async function _loadAccountRegistry() {
        if (!window.AesAccountRegistry) return []
        try {
            const block = await window.AesAccountRegistry.list()
            return Array.isArray(block) ? block : []
        } catch (_) { return [] }
    }

    async function _refresh() {
        if (!window.AesCanopyOrgsStore) {
            _state.orgs = []
        } else {
            _state.orgs = await window.AesCanopyOrgsStore.listOrgs()
        }
        _state.registry = await _loadAccountRegistry()
        _render()
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-orgs-settings"
        root.style.cssText =
            "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999987;" +
            "display:none;align-items:flex-start;justify-content:center;padding-top:8vh;"
        root.addEventListener("click", (e) => { if (e.target === root) close() })
        const box = document.createElement("div")
        box.style.cssText =
            "width:min(900px,92vw);max-height:80vh;background:#0f172a;color:#e2e8f0;" +
            "border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;" +
            "flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;"
        root.appendChild(box)
        const header = document.createElement("div")
        header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(148,163,184,0.18)"
        header.innerHTML = '<div style="font-weight:600;font-size:14px">Organisations</div>'
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px"
        closeBtn.addEventListener("click", () => close())
        header.appendChild(closeBtn)
        box.appendChild(header)
        const body = document.createElement("div")
        body.style.cssText = "display:grid;grid-template-columns:240px 1fr;flex:1;overflow:hidden"
        body.innerHTML =
            '<div id="aes-orgs-list" style="border-right:1px solid rgba(148,163,184,0.18);overflow-y:auto;padding:8px"></div>' +
            '<div id="aes-orgs-detail" style="overflow-y:auto;padding:12px"></div>'
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
        const host = document.getElementById("aes-orgs-list")
        if (!host) return
        const html = []
        html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">')
        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em">Orgs (' + _state.orgs.length + ')</div>')
        html.push('<button data-action="create" style="background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px">+ New</button>')
        html.push('</div>')
        for (const org of _state.orgs) {
            const sel = (org.id === _state.selectedId)
            html.push(
                '<div data-id="' + _esc(org.id) + '" style="' +
                'cursor:pointer;padding:6px 8px;border-radius:3px;font-size:12px;' +
                (sel ? "background:rgba(59,130,246,0.18);" : "") + '">' +
                _esc(org.name) +
                '<div style="color:#64748b;font-size:10px;margin-top:2px">' +
                (org.members ? org.members.length + ' member' + (org.members.length === 1 ? '' : 's') : 'no members') +
                '</div></div>'
            )
        }
        if (!_state.orgs.length) {
            html.push('<div style="font-size:11px;color:#64748b;padding:12px;text-align:center;font-style:italic">No orgs yet — click + New</div>')
        }
        host.innerHTML = html.join("")
        host.querySelectorAll("[data-id]").forEach(el => {
            el.addEventListener("click", () => {
                _state.selectedId = el.dataset.id
                _render()
            })
        })
        const create = host.querySelector('[data-action="create"]')
        if (create) create.addEventListener("click", async () => {
            const name = window.prompt("New organisation name:", "Asia Operations")
            if (!name) return
            const org = await window.AesCanopyOrgsStore.create({name})
            _state.selectedId = org.id
            await _refresh()
        })
    }

    function _renderDetail() {
        const host = document.getElementById("aes-orgs-detail")
        if (!host) return
        const org = _state.orgs.find(o => o.id === _state.selectedId)
        if (!org) {
            host.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px">Select an org or create one</div>'
            return
        }
        const html = []
        html.push('<div style="display:flex;justify-content:space-between;margin-bottom:12px">')
        html.push('<input type="text" id="aes-org-name" value="' + _esc(org.name) + '" style="background:#1e293b;border:1px solid rgba(148,163,184,0.35);color:#e2e8f0;padding:6px 8px;border-radius:3px;font-size:13px;flex:1;margin-right:8px">')
        html.push('<button data-action="rename" style="background:#3b82f6;border:none;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:11px">Rename</button>')
        html.push('<button data-action="delete" style="background:transparent;border:1px solid #ef4444;color:#ef4444;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:11px;margin-left:6px">Delete</button>')
        html.push('</div>')

        html.push('<div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px">Members</div>')
        if (!org.members || !org.members.length) {
            html.push('<div style="color:#64748b;font-size:12px;font-style:italic;margin-bottom:8px">No members yet</div>')
        } else {
            for (let i = 0; i < org.members.length; i++) {
                const m = org.members[i]
                html.push('<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;background:rgba(148,163,184,0.06);border-radius:3px;margin-bottom:4px;font-size:12px">')
                html.push('<span>' + _esc(m.server) + ' / ' + _esc(m.airlineCode || "(any)") + ' · ' +
                          (m.aircraftIds == null ? 'all tails' : (m.aircraftIds.length + ' tail' + (m.aircraftIds.length === 1 ? '' : 's'))) +
                          '</span>')
                html.push('<button data-remove="' + i + '" style="background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:14px">✕</button>')
                html.push('</div>')
            }
        }

        // Add member from registry
        if (_state.registry.length) {
            html.push('<div style="margin-top:8px"><select id="aes-org-add" style="background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);padding:6px;border-radius:3px;font-size:11px;width:70%">')
            html.push('<option value="">Add account…</option>')
            for (const acc of _state.registry) {
                const id = acc.id || ""
                const lbl = (acc.displayName || acc.airlineIdentity || id) + " · " + (acc.server || "?")
                html.push('<option value="' + _esc(id) + '">' + _esc(lbl) + '</option>')
            }
            html.push('</select> <button data-action="addMember" style="background:#3b82f6;border:none;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:11px;margin-left:6px">Add</button></div>')
        } else {
            html.push('<div style="font-size:11px;color:#64748b;font-style:italic;margin-top:8px">Visit AS pages to populate the account registry first</div>')
        }

        // Default preset for this org (Lane B integration)
        html.push('<div style="margin-top:16px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Default preset</div>')
        html.push('<div id="aes-org-default-preset" style="font-size:12px;color:#64748b">' + _esc(org.defaultPresetId || "(none — set via wave palette context menu — Phase 3)") + '</div>')

        host.innerHTML = html.join("")
        const renameBtn = host.querySelector('[data-action="rename"]')
        const deleteBtn = host.querySelector('[data-action="delete"]')
        const addBtn = host.querySelector('[data-action="addMember"]')
        const nameInput = host.querySelector("#aes-org-name")
        const addSelect = host.querySelector("#aes-org-add")

        if (renameBtn) renameBtn.addEventListener("click", async () => {
            const newName = (nameInput.value || "").trim()
            if (!newName || newName === org.name) return
            await window.AesCanopyOrgsStore.update(org.id, {name: newName})
            await _refresh()
        })
        if (deleteBtn) deleteBtn.addEventListener("click", async () => {
            if (!window.confirm("Delete '" + org.name + "'? This cannot be undone.")) return
            await window.AesCanopyOrgsStore.remove(org.id)
            _state.selectedId = null
            await _refresh()
        })
        host.querySelectorAll("[data-remove]").forEach(el => {
            el.addEventListener("click", async () => {
                const idx = Number(el.dataset.remove)
                const newMembers = org.members.slice()
                newMembers.splice(idx, 1)
                await window.AesCanopyOrgsStore.update(org.id, {members: newMembers})
                await _refresh()
            })
        })
        if (addBtn) addBtn.addEventListener("click", async () => {
            const accountId = addSelect.value
            if (!accountId) return
            const acc = _state.registry.find(a => a.id === accountId)
            if (!acc) return
            const newMembers = (org.members || []).slice()
            newMembers.push({
                accountId,
                server: acc.server || "",
                airlineCode: acc.airlineIdentity || "",
                aircraftIds: null
            })
            await window.AesCanopyOrgsStore.update(org.id, {members: newMembers})
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

    window.AesCanopyOrgsSettingsPage = {open, close}
})()
