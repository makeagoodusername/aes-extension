"use strict"

/**
 * Phase 3 Lane B — wave-preset metadata side-store.
 *
 * Adds tags, role, color-token, and pin assignments to existing presets
 * WITHOUT growing the canonical SchedulePresets record (which is shared
 * with the wave engine and should stay focused on geometry + composition).
 *
 * Storage key:
 *   aesCanopy:wavePresetMeta = {
 *     schemaVersion: 1,
 *     byPresetId: {
 *       [presetId]: {
 *         tags: string[],            // free-form, lowercase normalised
 *         role: string,              // "shuttle"|"intercon"|"redeye"|"" — free-form
 *         colorToken: string,        // matches design-token palette
 *         pinnedTo: {orgs:[], regions:[], hubs:[]}
 *       }
 *     }
 *   }
 *
 * Class C, canopy-scope. One blob spans accounts because wave presets
 * themselves live at a canopy-wide scope (SchedulePresets) and metadata
 * follows the data.
 *
 * GC contract: load() optionally accepts the current presets list and
 * drops orphan ids on next save. The pure read path (load()) is non-
 * destructive — it returns the raw block as-is so consumers can audit
 * stale entries. Use compactAgainst(presetIds) to actually GC.
 */
;(function () {
    if (window.AesWavePresetMetaStore) return

    const KEY = "aesCanopy:wavePresetMeta"

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesAfp && window.AesAfp.bus) window.AesAfp.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
    }

    function _defaults() {
        return {schemaVersion: 1, byPresetId: {}}
    }

    function _emptyMeta() {
        return {tags: [], role: "", colorToken: "", pinnedTo: {orgs: [], regions: [], hubs: []}}
    }

    function _normTag(t) {
        return String(t || "").trim().toLowerCase().replace(/\s+/g, "-")
    }

    function _normMeta(raw) {
        const m = _emptyMeta()
        if (!raw || typeof raw !== "object") return m
        if (Array.isArray(raw.tags)) {
            const seen = new Set()
            for (const t of raw.tags) {
                const norm = _normTag(t)
                if (norm && !seen.has(norm)) { seen.add(norm); m.tags.push(norm) }
            }
        }
        if (typeof raw.role === "string")       m.role       = raw.role.trim().toLowerCase()
        if (typeof raw.colorToken === "string") m.colorToken = raw.colorToken.trim()
        if (raw.pinnedTo && typeof raw.pinnedTo === "object") {
            for (const k of ["orgs", "regions", "hubs"]) {
                if (Array.isArray(raw.pinnedTo[k])) {
                    m.pinnedTo[k] = raw.pinnedTo[k]
                        .map(x => (k === "hubs" ? String(x).toUpperCase() : String(x)))
                        .filter(Boolean)
                }
            }
        }
        return m
    }

    async function load() {
        if (typeof chrome === "undefined" || !chrome.storage) return _defaults()
        const out = await chrome.storage.local.get([KEY])
        const raw = out[KEY] || _defaults()
        const block = Object.assign(_defaults(), raw)
        if (!block.byPresetId || typeof block.byPresetId !== "object") block.byPresetId = {}
        // Normalise on read so consumers always see canonical shape.
        const normed = {}
        for (const [id, meta] of Object.entries(block.byPresetId)) {
            normed[id] = _normMeta(meta)
        }
        block.byPresetId = normed
        return block
    }

    async function _save(block) {
        if (typeof chrome === "undefined" || !chrome.storage) return
        await chrome.storage.local.set({[KEY]: block})
        _emit("canopy:wave-meta-changed", {schemaVersion: block.schemaVersion})
    }

    /**
     * Patch one preset's metadata. Pass partial fields; missing fields
     * inherit existing values. Pass `tags: ["a", "b"]` to replace the tag
     * list; use addTag/removeTag for incremental edits.
     */
    async function setMeta(presetId, partial) {
        if (!presetId) return null
        const block = await load()
        const cur = block.byPresetId[presetId] || _emptyMeta()
        const next = _normMeta(Object.assign({}, cur, partial || {}))
        block.byPresetId[presetId] = next
        await _save(block)
        return next
    }

    async function addTag(presetId, tag) {
        const norm = _normTag(tag)
        if (!presetId || !norm) return null
        const block = await load()
        const cur = block.byPresetId[presetId] || _emptyMeta()
        if (cur.tags.indexOf(norm) === -1) cur.tags.push(norm)
        block.byPresetId[presetId] = cur
        await _save(block)
        return cur
    }

    async function removeTag(presetId, tag) {
        const norm = _normTag(tag)
        if (!presetId || !norm) return null
        const block = await load()
        const cur = block.byPresetId[presetId]
        if (!cur) return null
        cur.tags = cur.tags.filter(t => t !== norm)
        block.byPresetId[presetId] = cur
        await _save(block)
        return cur
    }

    async function pinTo(presetId, kind, id) {
        if (!presetId || !id || ["orgs", "regions", "hubs"].indexOf(kind) === -1) return null
        const block = await load()
        const cur = block.byPresetId[presetId] || _emptyMeta()
        const value = (kind === "hubs") ? String(id).toUpperCase() : String(id)
        if (cur.pinnedTo[kind].indexOf(value) === -1) cur.pinnedTo[kind].push(value)
        block.byPresetId[presetId] = cur
        await _save(block)
        return cur
    }

    async function unpin(presetId, kind, id) {
        if (!presetId || ["orgs", "regions", "hubs"].indexOf(kind) === -1) return null
        const block = await load()
        const cur = block.byPresetId[presetId]
        if (!cur) return null
        const value = (kind === "hubs") ? String(id).toUpperCase() : String(id)
        cur.pinnedTo[kind] = cur.pinnedTo[kind].filter(x => x !== value)
        block.byPresetId[presetId] = cur
        await _save(block)
        return cur
    }

    async function removeMeta(presetId) {
        if (!presetId) return false
        const block = await load()
        if (!block.byPresetId[presetId]) return false
        delete block.byPresetId[presetId]
        await _save(block)
        return true
    }

    async function getMeta(presetId) {
        const block = await load()
        return block.byPresetId[presetId] || _emptyMeta()
    }

    async function getTagsFor(presetId) {
        const m = await getMeta(presetId)
        return m.tags.slice()
    }

    /**
     * GC orphan entries — call after preset deletion or periodically.
     * `livePresetIds` is the canonical list (e.g. SchedulePresets.load()
     * → presets.map(p => p.id)). Returns the count of dropped entries.
     */
    async function compactAgainst(livePresetIds) {
        if (!Array.isArray(livePresetIds)) return 0
        const live = new Set(livePresetIds.map(String))
        const block = await load()
        const dropped = []
        for (const id of Object.keys(block.byPresetId)) {
            if (!live.has(id)) dropped.push(id)
        }
        for (const id of dropped) delete block.byPresetId[id]
        if (dropped.length) await _save(block)
        return dropped.length
    }

    window.AesWavePresetMetaStore = {
        load, getMeta, getTagsFor,
        setMeta, removeMeta,
        addTag, removeTag,
        pinTo, unpin,
        compactAgainst,
        KEY
    }
})()
