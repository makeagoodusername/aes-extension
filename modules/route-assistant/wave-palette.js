"use strict"

/**
 * Cmd-Shift-K wave palette — the "easy access" surface for 50+ aircraft,
 * multi-org, multi-region setups.
 *
 * Three-pane modal:
 *   left:   filter pane (search input + filter chips + recent ring)
 *   center: filtered preset list (pinned first, then starred, then rest)
 *   right:  read-only Gantt preview of the highlighted preset
 *
 * Search syntax (parsed in _parseQuery):
 *   "MIA"            → filter by preset.hub IATA (3 uppercase letters)
 *   "+pin"           → only pinned
 *   "+star"          → only starred
 *   "+fleet:<id>"    → presets with appliesToFleets containing <id>
 *   "@<orgname>"     → kinPresetId resolved to org name (Lane B; stub today)
 *   anything else    → fuzzy match on preset.name (case-insensitive)
 *
 * Keymap defaults:
 *   Mod+Shift+K   open palette
 *   ↑ / ↓         navigate
 *   Enter         activate (sets active preset; emits wavepalette:preset-activated)
 *   Mod+Enter     open in RA Wave View (focus-route bus event)
 *   P             toggle pin (writes preset.pinned via SchedulePresets.update)
 *   S             toggle star (per-account; via wave-favorites-store)
 *   Esc           close
 *
 * Bus events:
 *   out: wavepalette:open                {trigger}
 *   out: wavepalette:close               {durMs}
 *   out: wavepalette:preset-activated    {presetId, hub}
 *   out: wavepalette:preset-pinned       {presetId, pinned}
 *
 * Reads:
 *   - SchedulePresets.load()                  (canonical presets)
 *   - RouteAssistantWaveFavoritesStore        (per-account stars + recent ring)
 *   - RouteAssistantWaveKeybindsStore         (chord overrides)
 *
 * Phase 1 scope: filter by hub + +pin + +star + name fuzzy. Geography
 * filter (region tree) and kin-org filter come in Phase 3 when Lane B's
 * canopy stores ship.
 */
;(function () {
    if (window.RouteAssistantWavePalette) return

    let _modal       = null
    let _selectedIdx = 0
    let _results     = []
    let _opened      = 0
    let _searchEl    = null
    let _listEl      = null
    let _previewEl   = null

    function _bus() {
        const buses = []
        try { if (window.AesAfp && window.AesAfp.bus) buses.push(window.AesAfp.bus) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) buses.push(window.AesStrategy.bus) } catch (_) {}
        try { if (window.CentralHubBus) buses.push(window.CentralHubBus) } catch (_) {}
        return buses
    }

    function _emit(event, payload) {
        for (const b of _bus()) { try { b.emit(event, payload) } catch (_) {} }
    }

    /**
     * Lightweight inline fuzzy scorer (no fuse.js — vanilla per North Star §4.11).
     * Higher score = better match; 0 means no match.
     */
    function _fuzzyScore(haystack, needle) {
        if (!needle) return 1
        if (!haystack) return 0
        const h = String(haystack).toLowerCase()
        const n = String(needle).toLowerCase()
        if (h.indexOf(n) === 0) return 100             // prefix match
        if (h.indexOf(n) >= 0)  return 50              // substring
        // letter-by-letter sequential
        let hi = 0, score = 0
        for (let ni = 0; ni < n.length; ni++) {
            const ch = n[ni]
            const found = h.indexOf(ch, hi)
            if (found < 0) return 0
            score += (found === hi) ? 2 : 1
            hi = found + 1
        }
        return score
    }

    function _parseQuery(raw) {
        const q = String(raw || "").trim()
        const out = {hub: null, pin: false, star: false, fleet: null, org: null,
                     tags: [], role: null, name: ""}
        if (!q) return out
        const tokens = q.split(/\s+/)
        for (const tok of tokens) {
            if (tok === "+pin") { out.pin = true; continue }
            if (tok === "+star") { out.star = true; continue }
            if (tok.startsWith("+fleet:")) { out.fleet = tok.slice(7); continue }
            if (tok.startsWith("@")) { out.org = tok.slice(1).toLowerCase(); continue }
            // Phase 3 — #tag matches preset metadata tags (prefix match).
            if (tok.startsWith("#") && tok.length > 1) {
                out.tags.push(tok.slice(1).toLowerCase())
                continue
            }
            // Phase 3 — /role matches preset metadata role (prefix match).
            if (tok.startsWith("/") && tok.length > 1) {
                out.role = tok.slice(1).toLowerCase()
                continue
            }
            if (/^[A-Z]{3}$/.test(tok)) { out.hub = tok; continue }
            // accumulate residual tokens as name fuzzy
            out.name = (out.name + " " + tok).trim()
        }
        return out
    }

    async function _gather() {
        const block = (typeof SchedulePresets !== "undefined")
            ? await SchedulePresets.load()
            : {presets: []}
        const presets = Array.isArray(block.presets) ? block.presets.slice() : []
        const fav = (typeof RouteAssistantWaveFavoritesStore !== "undefined")
            ? await RouteAssistantWaveFavoritesStore.load()
            : {byPresetId: {}}
        const recent = (typeof RouteAssistantWaveFavoritesStore !== "undefined")
            ? await RouteAssistantWaveFavoritesStore.listRecent(8)
            : []
        // Phase 3 — pull tag/role metadata so #tag and /role filters can match.
        const meta = (typeof window !== "undefined" && window.AesWavePresetMetaStore)
            ? await window.AesWavePresetMetaStore.load() : {byPresetId: {}}
        // Phase 3 — pull org list so @orgname filter can resolve to ids.
        const orgsBlock = (typeof window !== "undefined" && window.AesCanopyOrgsStore)
            ? await window.AesCanopyOrgsStore.load() : null
        return {
            presets,
            favByPresetId: fav.byPresetId || {},
            metaByPresetId: meta.byPresetId || {},
            orgsByName: _indexOrgsByName(orgsBlock),
            recent
        }
    }

    function _indexOrgsByName(orgsBlock) {
        const out = {}
        if (!orgsBlock || !orgsBlock.orgs) return out
        for (const o of Object.values(orgsBlock.orgs)) {
            const k = String(o.name || "").toLowerCase()
            if (k) out[k] = o.id
        }
        return out
    }

    function _filterAndRank(state, query) {
        const q = _parseQuery(query)
        const {presets, favByPresetId, metaByPresetId, orgsByName} = state
        const scored = []
        // Phase 3 — resolve @orgname to a set of org ids for the filter pass.
        let wantedOrgIds = null
        if (q.org && orgsByName) {
            wantedOrgIds = new Set()
            for (const [name, id] of Object.entries(orgsByName)) {
                if (name.indexOf(q.org) >= 0) wantedOrgIds.add(id)
            }
            if (!wantedOrgIds.size) return []
        }
        for (const p of presets) {
            if (q.hub && String(p.hub || "").toUpperCase() !== q.hub) continue
            if (q.pin && !p.pinned) continue
            const star = !!(favByPresetId[p.id] && favByPresetId[p.id].starredAt)
            if (q.star && !star) continue
            if (q.fleet) {
                const list = Array.isArray(p.appliesToFleets) ? p.appliesToFleets : []
                if (!list.some(x => String(x) === String(q.fleet))) continue
            }
            const meta = metaByPresetId[p.id] || {}
            const tags = Array.isArray(meta.tags) ? meta.tags : []
            const role = typeof meta.role === "string" ? meta.role : ""
            // Phase 3 — every #tag must hit at least one of the preset's tags.
            if (q.tags.length) {
                const allMatch = q.tags.every(needle =>
                    tags.some(t => t === needle || t.indexOf(needle) === 0))
                if (!allMatch) continue
            }
            if (q.role) {
                if (!(role === q.role || role.indexOf(q.role) === 0)) continue
            }
            if (wantedOrgIds) {
                const pinnedOrgs = (meta.pinnedTo && Array.isArray(meta.pinnedTo.orgs)) ? meta.pinnedTo.orgs : []
                if (!pinnedOrgs.some(id => wantedOrgIds.has(id))) continue
            }
            // name fuzzy
            const nameScore = _fuzzyScore(p.name, q.name)
            if (q.name && nameScore === 0) continue
            // base score: pinned beats star beats neither; recent boosts;
            // Phase 3 adds a tag-hit boost so an exact tag match outranks
            // a partial-name fuzzy hit.
            const base = (p.pinned ? 1000 : 0) + (star ? 500 : 0)
            const recentRec = favByPresetId[p.id] || {}
            const recentBoost = recentRec.lastUsedAt
                ? Math.max(0, 200 - Math.floor((Date.now() - recentRec.lastUsedAt) / (3600 * 1000)))
                : 0
            const tagBoost = q.tags.length
                ? q.tags.reduce((acc, needle) =>
                    acc + (tags.some(t => t === needle) ? 300 : (tags.some(t => t.indexOf(needle) === 0) ? 150 : 0)), 0)
                : 0
            scored.push({
                preset: p, score: base + nameScore + recentBoost + tagBoost,
                starred: star, tags, role
            })
        }
        scored.sort((a, b) => b.score - a.score)
        return scored
    }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-wave-palette"
        root.style.position    = "fixed"
        root.style.inset       = "0"
        root.style.background  = "rgba(15,23,42,0.55)"
        root.style.zIndex      = "999990"
        root.style.display     = "none"
        root.style.alignItems  = "flex-start"
        root.style.justifyContent = "center"
        root.style.paddingTop  = "10vh"
        root.addEventListener("click", (e) => {
            if (e.target === root) close()
        })

        const box = document.createElement("div")
        box.style.width        = "min(960px, 92vw)"
        box.style.maxHeight    = "78vh"
        box.style.background   = "#0f172a"
        box.style.color        = "#e2e8f0"
        box.style.border       = "1px solid rgba(148,163,184,0.25)"
        box.style.borderRadius = "8px"
        box.style.boxShadow    = "0 24px 64px rgba(0,0,0,0.5)"
        box.style.display      = "grid"
        box.style.gridTemplateColumns = "1fr 1.4fr 1.6fr"
        box.style.fontFamily   = "ui-sans-serif, system-ui, sans-serif"
        box.style.overflow     = "hidden"
        root.appendChild(box)

        // --- left pane: search + filters ---------------------------------
        const left = document.createElement("div")
        left.style.padding = "12px"
        left.style.borderRight = "1px solid rgba(148,163,184,0.18)"
        left.style.overflowY = "auto"
        const searchWrap = document.createElement("div")
        searchWrap.style.marginBottom = "8px"
        const search = document.createElement("input")
        search.type = "text"
        search.placeholder = "Search · MIA · +pin · #tag · /role · @org · name…"
        search.style.width = "100%"
        search.style.padding = "8px"
        search.style.borderRadius = "4px"
        search.style.border = "1px solid rgba(148,163,184,0.35)"
        search.style.background = "#1e293b"
        search.style.color = "#e2e8f0"
        search.style.fontFamily = "ui-monospace, monospace"
        search.style.fontSize = "12px"
        search.addEventListener("input", () => _refresh())
        search.addEventListener("keydown", _onSearchKey)
        searchWrap.appendChild(search)
        left.appendChild(searchWrap)

        const filterChips = document.createElement("div")
        filterChips.style.fontSize = "11px"
        filterChips.style.color = "#94a3b8"
        filterChips.innerHTML = [
            '<div style="margin-bottom:6px">Quick filters:</div>',
            '<div style="display:flex;flex-wrap:wrap;gap:4px">',
            '  <span data-q="+pin" style="cursor:pointer;padding:2px 6px;border-radius:3px;background:#1e293b">+pin</span>',
            '  <span data-q="+star" style="cursor:pointer;padding:2px 6px;border-radius:3px;background:#1e293b">+star</span>',
            '</div>'
        ].join("\n")
        filterChips.addEventListener("click", (e) => {
            const t = e.target
            if (!(t && t.dataset && t.dataset.q)) return
            const cur = search.value.trim()
            search.value = (cur ? cur + " " : "") + t.dataset.q
            _refresh()
            search.focus()
        })
        left.appendChild(filterChips)

        const recentLabel = document.createElement("div")
        recentLabel.textContent = "Recent"
        recentLabel.style.fontSize = "11px"
        recentLabel.style.color = "#64748b"
        recentLabel.style.marginTop = "16px"
        recentLabel.style.marginBottom = "4px"
        left.appendChild(recentLabel)
        const recentList = document.createElement("div")
        recentList.id = "aes-wave-palette-recent"
        recentList.style.fontSize = "12px"
        left.appendChild(recentList)

        // --- center pane: results ----------------------------------------
        const center = document.createElement("div")
        center.style.padding = "8px 0"
        center.style.overflowY = "auto"
        const list = document.createElement("div")
        list.id = "aes-wave-palette-list"
        center.appendChild(list)

        // --- right pane: preview -----------------------------------------
        const right = document.createElement("div")
        right.style.padding = "12px"
        right.style.borderLeft = "1px solid rgba(148,163,184,0.18)"
        right.style.overflowY = "auto"
        const preview = document.createElement("div")
        preview.id = "aes-wave-palette-preview"
        preview.style.fontSize = "12px"
        right.appendChild(preview)

        box.appendChild(left)
        box.appendChild(center)
        box.appendChild(right)

        _searchEl = search
        _listEl = list
        _previewEl = preview
        _modal = root
        document.body.appendChild(root)
        return root
    }

    function _onSearchKey(event) {
        if (event.key === "ArrowDown") { event.preventDefault(); _move(+1); return }
        if (event.key === "ArrowUp")   { event.preventDefault(); _move(-1); return }
        if (event.key === "Enter")     { event.preventDefault(); _activate(_selectedIdx); return }
        if (event.key === "Escape")    { event.preventDefault(); close(); return }
        // shortcut keys
        if (event.key === "p" || event.key === "P") {
            if (_results[_selectedIdx]) {
                event.preventDefault()
                _togglePin(_results[_selectedIdx].preset.id)
            }
            return
        }
        if (event.key === "s" || event.key === "S") {
            if (_results[_selectedIdx]) {
                event.preventDefault()
                _toggleStar(_results[_selectedIdx].preset.id)
            }
            return
        }
    }

    function _move(delta) {
        if (!_results.length) return
        _selectedIdx = (_selectedIdx + delta + _results.length) % _results.length
        _renderList()
    }

    async function _refresh() {
        const state = await _gather()
        const q     = _searchEl ? _searchEl.value : ""
        _results = _filterAndRank(state, q)
        if (_selectedIdx >= _results.length) _selectedIdx = 0
        _renderList()
        _renderRecent(state)
    }

    function _renderList() {
        if (!_listEl) return
        const html = []
        for (let i = 0; i < _results.length; i++) {
            const {preset: p, starred} = _results[i]
            const sel = (i === _selectedIdx)
            const hub = p.hub || "·"
            const wcount = (p.waves || []).length
            const pin = p.pinned ? "★" : ""
            const star = starred ? "✦" : ""
            html.push(
                '<div data-idx="' + i + '" style="' +
                'display:flex;justify-content:space-between;align-items:center;' +
                'padding:6px 12px;cursor:pointer;font-size:13px;' +
                'background:' + (sel ? "rgba(59,130,246,0.18)" : "transparent") + '">' +
                '<div><span style="font-weight:500">' + _escape(p.name) + '</span>' +
                '<span style="color:#94a3b8;margin-left:8px;font-size:11px">' +
                hub + ' · ' + wcount + 'w</span></div>' +
                '<div style="color:#fbbf24;font-size:11px">' + pin + ' ' + star + '</div>' +
                '</div>'
            )
        }
        if (!_results.length) {
            html.push('<div style="padding:24px;color:#64748b;text-align:center;font-size:12px">No presets match.</div>')
        }
        _listEl.innerHTML = html.join("")
        _listEl.querySelectorAll("[data-idx]").forEach(el => {
            el.addEventListener("click", () => {
                const i = Number(el.dataset.idx)
                _selectedIdx = i
                _renderList()
                _renderPreview()
            })
            el.addEventListener("dblclick", () => _activate(Number(el.dataset.idx)))
        })
        _renderPreview()
    }

    function _renderRecent(state) {
        const wrap = document.getElementById("aes-wave-palette-recent")
        if (!wrap) return
        const html = []
        for (const r of (state.recent || [])) {
            const p = state.presets.find(pp => pp.id === r.presetId)
            if (!p) continue
            html.push(
                '<div data-recent-id="' + p.id + '" style="' +
                'cursor:pointer;padding:3px 4px;font-size:12px;color:#cbd5e1">' +
                _escape(p.name) + ' <span style="color:#64748b">' + (p.hub || "") + '</span>' +
                '</div>'
            )
        }
        wrap.innerHTML = html.join("") || '<div style="color:#64748b;font-size:11px">(none yet)</div>'
        wrap.querySelectorAll("[data-recent-id]").forEach(el => {
            el.addEventListener("click", () => {
                const id = el.dataset.recentId
                const idx = _results.findIndex(r => r.preset.id === id)
                if (idx >= 0) { _selectedIdx = idx; _renderList(); _activate(idx) }
            })
        })
    }

    function _renderPreview() {
        if (!_previewEl) return
        const sel = _results[_selectedIdx]
        if (!sel) {
            _previewEl.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;font-size:12px">No preset selected.</div>'
            return
        }
        const p = sel.preset
        const waves = Array.isArray(p.waves) ? p.waves : []
        const html = ['<div style="margin-bottom:8px"><div style="font-size:14px;font-weight:600">' + _escape(p.name) + '</div>',
                      '<div style="color:#94a3b8;font-size:11px">' + (p.hub || "(no hub)") + ' · ' +
                      waves.length + ' waves · rev ' + (p.templateRevision || 1) + '</div></div>']
        for (const w of waves) {
            const arr = (w.arrivalWindow && w.arrivalWindow.start) || "?"
            const dep = (w.departureWindow && w.departureWindow.start) || "?"
            const c = w.composition || {}
            const sb = (Array.isArray(w.subBands) ? w.subBands.length : 0)
            html.push(
                '<div style="padding:6px 0;border-top:1px solid rgba(148,163,184,0.12);font-size:12px">' +
                '<div>' + _escape(w.label || "Wave") +
                (w.archivedAt ? ' <span style="color:#64748b">(archived)</span>' : '') +
                '</div>' +
                '<div style="color:#94a3b8;font-size:11px">' +
                'arr ' + arr + ' · dep ' + dep + ' · ' +
                'S' + (c.shortHaul || 0) + '/M' + (c.mediumHaul || 0) + '/L' + (c.longHaul || 0) +
                (sb ? ' · ' + sb + ' sub-band' + (sb !== 1 ? 's' : '') : '') +
                '</div>' +
                '</div>'
            )
        }
        if (Array.isArray(p.appliesToFleets) && p.appliesToFleets.length) {
            html.push('<div style="margin-top:8px;color:#64748b;font-size:11px">Applies to fleets: ' +
                      p.appliesToFleets.map(_escape).join(", ") + '</div>')
        }
        _previewEl.innerHTML = html.join("")
    }

    async function _activate(idx) {
        const sel = _results[idx]
        if (!sel) return
        const p = sel.preset
        if (typeof RouteAssistantWaveFavoritesStore !== "undefined") {
            try { await RouteAssistantWaveFavoritesStore.noteUsed(p.id) } catch (_) {}
        }
        _emit("wavepalette:preset-activated", {presetId: p.id, hub: p.hub || null})
        close()
    }

    async function _togglePin(presetId) {
        if (!presetId || typeof SchedulePresets === "undefined") return
        const block = await SchedulePresets.load()
        const p = block.presets.find(x => x.id === presetId)
        if (!p) return
        const newVal = !p.pinned
        await SchedulePresets.update(presetId, {pinned: newVal})
        _emit("wavepalette:preset-pinned", {presetId, pinned: newVal})
        _refresh()
    }

    async function _toggleStar(presetId) {
        if (!presetId || typeof RouteAssistantWaveFavoritesStore === "undefined") return
        await RouteAssistantWaveFavoritesStore.toggleStar(presetId)
        _refresh()
    }

    function _escape(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    async function open(trigger) {
        _ensureModal()
        _opened = Date.now()
        _modal.style.display = "flex"
        _searchEl.value = ""
        _selectedIdx = 0
        await _refresh()
        _searchEl.focus()
        _emit("wavepalette:open", {trigger: trigger || "manual"})
    }

    function close() {
        if (!_modal) return
        _modal.style.display = "none"
        const dur = _opened ? (Date.now() - _opened) : 0
        _emit("wavepalette:close", {durMs: dur})
        _opened = 0
    }

    function isOpen() { return !!(_modal && _modal.style.display !== "none") }

    /* --- key binding installer ---------------------------------------- */

    let _keyAttached = false
    async function bindKeys() {
        if (_keyAttached) return
        _keyAttached = true
        document.addEventListener("keydown", async (event) => {
            // Only one chord today: palette open. ESC handled by drag-arbiter
            // or by the modal itself.
            if (typeof RouteAssistantWaveKeybindsStore === "undefined") return
            const chord = await RouteAssistantWaveKeybindsStore.resolve("palette.open")
            if (!chord) return
            if (RouteAssistantWaveKeybindsStore.matches(event, chord)) {
                event.preventDefault()
                if (isOpen()) close()
                else open("keybind")
            }
        }, true)
    }

    window.RouteAssistantWavePalette = {
        open, close, isOpen, bindKeys
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => bindKeys())
        } else {
            bindKeys()
        }
    }
})()
