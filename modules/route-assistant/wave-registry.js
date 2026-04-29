"use strict"

/**
 * Phase 3 Lane B — wave preset registry.
 *
 * Pure aggregator over `SchedulePresets.load()` + `AesWavePresetMetaStore.load()`
 * + the canopy regions/orgs blocks. Returns an indexed view that the
 * wave-palette, Fleet Command modal, and rebalance proposers consume.
 *
 * The registry never writes — it's a read facade. Editing tags / pin
 * assignments goes through `AesWavePresetMetaStore`. Editing waves
 * themselves goes through `RouteAssistantWaveEditor`.
 *
 * Output shape:
 *
 *   {
 *     presets: PresetWithMeta[],          // every preset enriched with .tags / .role / .pinnedTo
 *     byTag:   {[tag]: presetId[]},
 *     byHub:   {[hub]: presetId[]},
 *     byRole:  {[role]: presetId[]},
 *     defaults: {                          // most-specific-first resolver
 *       forOrg(orgId)     -> presetId|null,
 *       forRegion(regionId)-> presetId|null,
 *       forHub(hubIata)   -> presetId|null,
 *       forRole(role)     -> presetId|null
 *     }
 *   }
 *
 * Memoization: 2-second TTL keyed on (presets.length, presets-version-stamps,
 * meta-version-stamp). chrome.storage.onChanged invalidates on any of:
 *   "settings" (presets live there), "aesCanopy:wavePresetMeta".
 */
;(function () {
    if (window.AesWaveRegistry) return

    const TTL_MS = 2000
    let _cache = null

    async function _safe(fn, fallback) {
        try {
            const v = fn()
            return (v && typeof v.then === "function") ? await v : v
        } catch (_) { return fallback }
    }

    async function build() {
        const cacheKey = await _cacheKey()
        if (_cache && _cache.key === cacheKey && (Date.now() - _cache.builtAt) < TTL_MS) {
            return _cache.view
        }

        const presetsBlock = await _safe(
            () => (typeof SchedulePresets !== "undefined") ? SchedulePresets.load() : null,
            null
        )
        const metaBlock = await _safe(
            () => window.AesWavePresetMetaStore && window.AesWavePresetMetaStore.load(),
            null
        )
        const presets = (presetsBlock && Array.isArray(presetsBlock.presets))
            ? presetsBlock.presets : []
        const byPresetId = (metaBlock && metaBlock.byPresetId) || {}

        const enriched = presets.map(p => {
            const meta = byPresetId[p.id] || {}
            return Object.assign({}, p, {
                tags:     Array.isArray(meta.tags)    ? meta.tags    : [],
                role:     typeof meta.role === "string" ? meta.role  : "",
                colorToken: meta.colorToken || "",
                pinnedTo: (meta.pinnedTo && typeof meta.pinnedTo === "object")
                    ? {
                        orgs:    Array.isArray(meta.pinnedTo.orgs)    ? meta.pinnedTo.orgs.slice()    : [],
                        regions: Array.isArray(meta.pinnedTo.regions) ? meta.pinnedTo.regions.slice() : [],
                        hubs:    Array.isArray(meta.pinnedTo.hubs)    ? meta.pinnedTo.hubs.slice()    : []
                    }
                    : {orgs: [], regions: [], hubs: []}
            })
        })

        const byTag  = {}
        const byHub  = {}
        const byRole = {}
        const byOrg     = {}
        const byRegion  = {}
        for (const p of enriched) {
            for (const t of p.tags) {
                if (!byTag[t]) byTag[t] = []
                byTag[t].push(p.id)
            }
            const hub = String(p.hub || "").toUpperCase()
            if (hub) {
                if (!byHub[hub]) byHub[hub] = []
                byHub[hub].push(p.id)
            }
            if (p.role) {
                if (!byRole[p.role]) byRole[p.role] = []
                byRole[p.role].push(p.id)
            }
            for (const orgId of p.pinnedTo.orgs) {
                if (!byOrg[orgId]) byOrg[orgId] = []
                byOrg[orgId].push(p.id)
            }
            for (const rid of p.pinnedTo.regions) {
                if (!byRegion[rid]) byRegion[rid] = []
                byRegion[rid].push(p.id)
            }
        }

        // Rank-aware default resolver: ties broken by `pinned` flag, then
        // most-recent `templateRevision`, then alphabetical name.
        function _pickBest(ids) {
            if (!ids || !ids.length) return null
            const candidates = ids
                .map(id => enriched.find(p => p.id === id))
                .filter(Boolean)
            if (!candidates.length) return null
            candidates.sort((a, b) => {
                const ap = a.pinned ? 1 : 0
                const bp = b.pinned ? 1 : 0
                if (ap !== bp) return bp - ap
                const ar = Number(a.templateRevision) || 0
                const br = Number(b.templateRevision) || 0
                if (ar !== br) return br - ar
                return String(a.name || "").localeCompare(String(b.name || ""))
            })
            return candidates[0].id
        }

        const defaults = {
            forOrg(orgId)       { return _pickBest(byOrg[orgId]) },
            forRegion(regionId) { return _pickBest(byRegion[regionId]) },
            forHub(hubIata)     { return _pickBest(byHub[String(hubIata || "").toUpperCase()]) },
            forRole(role)       { return _pickBest(byRole[String(role || "").toLowerCase()]) }
        }

        const view = {
            presets:  enriched,
            byTag, byHub, byRole, byOrg, byRegion,
            defaults,
            totals: {
                presets:    enriched.length,
                tagged:     enriched.filter(p => p.tags.length).length,
                rolled:     enriched.filter(p => !!p.role).length,
                pinned:     enriched.filter(p => p.pinnedTo.orgs.length || p.pinnedTo.regions.length || p.pinnedTo.hubs.length).length,
                tags:       Object.keys(byTag).length,
                hubs:       Object.keys(byHub).length,
                roles:      Object.keys(byRole).length
            }
        }
        _cache = {key: cacheKey, view, builtAt: Date.now()}
        return view
    }

    async function _cacheKey() {
        // Cheap signature without re-reading the whole stores.
        const a = await _safe(
            () => (typeof SchedulePresets !== "undefined") ? SchedulePresets.load() : null, null)
        const b = await _safe(
            () => window.AesWavePresetMetaStore && window.AesWavePresetMetaStore.load(), null)
        const presetsSig = a && Array.isArray(a.presets)
            ? a.presets.length + ":" + a.presets.map(p => (p.id || "?") + "@" + (p.templateRevision || 0)).join(",")
            : "0"
        const metaSig = b && b.byPresetId
            ? Object.keys(b.byPresetId).sort().join(",")
            : "0"
        return presetsSig + "|" + metaSig
    }

    function invalidate() { _cache = null }

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            if (changes.settings || changes["aesCanopy:wavePresetMeta"]) _cache = null
        })
    }

    /**
     * Convenience: search the registry. Mirrors the wave-palette syntax —
     * #tag for tags, @org for orgs (resolved via canopy orgs store),
     * /role for roles, hub IATA for hubs, plain text fuzzy on name.
     * Returns presets in match-strength order. Async because @org needs
     * the orgs store.
     */
    async function search(query) {
        const view = await build()
        const q = String(query || "").trim()
        if (!q) return view.presets.slice()
        const tokens = q.split(/\s+/)
        let candidates = view.presets.slice()

        let orgsBlock = null
        for (const tok of tokens) {
            const lower = tok.toLowerCase()
            if (tok.startsWith("#") && tok.length > 1) {
                const tag = tok.slice(1).toLowerCase()
                candidates = candidates.filter(p =>
                    p.tags.some(t => t === tag || t.indexOf(tag) === 0))
            } else if (tok === "+pin") {
                candidates = candidates.filter(p => p.pinned === true)
            } else if (tok === "+star") {
                candidates = candidates.filter(p => p.starredAt != null)
            } else if (tok.startsWith("/") && tok.length > 1) {
                const role = tok.slice(1).toLowerCase()
                candidates = candidates.filter(p =>
                    p.role === role || p.role.indexOf(role) === 0)
            } else if (tok.startsWith("@") && tok.length > 1) {
                if (!orgsBlock) {
                    orgsBlock = await _safe(
                        () => window.AesCanopyOrgsStore && window.AesCanopyOrgsStore.load(), null)
                }
                if (!orgsBlock) { candidates = []; break }
                const wanted = tok.slice(1).toLowerCase()
                const matchOrgIds = Object.values(orgsBlock.orgs || {})
                    .filter(o => String(o.name || "").toLowerCase().indexOf(wanted) >= 0)
                    .map(o => o.id)
                if (!matchOrgIds.length) { candidates = []; break }
                const set = new Set(matchOrgIds)
                candidates = candidates.filter(p => p.pinnedTo.orgs.some(id => set.has(id)))
            } else if (/^[A-Z]{3}$/i.test(tok)) {
                const hub = tok.toUpperCase()
                candidates = candidates.filter(p =>
                    String(p.hub || "").toUpperCase() === hub
                    || p.pinnedTo.hubs.indexOf(hub) >= 0)
            } else {
                candidates = candidates.filter(p =>
                    String(p.name || "").toLowerCase().indexOf(lower) >= 0
                    || p.tags.some(t => t.indexOf(lower) >= 0))
            }
        }
        return candidates
    }

    window.AesWaveRegistry = {build, invalidate, search}
})()
