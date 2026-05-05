/**
 * F slice 4 — Wave Draft Store.
 *
 * Lets a user fork the active preset into a sandboxed draft that they
 * can spinner-edit, time-edit, add waves to, etc., without polluting the
 * live preset. When happy, they promote the draft back into the
 * baseline (overwrite) or save it as a new variant (createTweaked-style)
 * — both via the regular `SchedulePresets` API. When done iterating
 * (discard / promote), the draft preset is cleaned up.
 *
 * The actual edits piggyback on `SchedulePresets`'s CRUD: a draft is
 * just a real preset whose existence is tracked in a per-hub record so
 * the panel knows which preset is "the draft" (and which one is its
 * baseline) without changing the edit pipeline.
 *
 * Storage:
 *   key:   `routeAssistant:waveDraft:<HUB>`  (acctKey-scoped, one
 *          draft per hub at a time)
 *   value: {
 *     draftPresetId:        SchedulePresets id of the duplicate
 *     baselineId:           SchedulePresets id of the original
 *     baselineUpdatedAt:    timestamp of baseline at draft-creation
 *     baselineSnapshot:     deep-clone of the baseline's waves + factors
 *                           (for A/B compare even after baseline drifts)
 *     createdAt:            ts
 *   }
 *
 * No DOM. Pure Chrome storage I/O.
 */
class RouteAssistantWaveDraftStore {

    static SCOPE_PREFIX  = "routeAssistant:waveDraft"
    static LEGACY_PREFIX = "routeAssistant:waveDraft:"

    static _key(hub) {
        const hubU = String(hub || "").toUpperCase()
        if (typeof acctKey === "function") {
            return acctKey(RouteAssistantWaveDraftStore.SCOPE_PREFIX, hubU)
        }
        return RouteAssistantWaveDraftStore.LEGACY_PREFIX + hubU
    }

    static _legacyKey(hub) {
        return RouteAssistantWaveDraftStore.LEGACY_PREFIX
            + String(hub || "").toUpperCase()
    }

    /** Read the active draft record for a hub, or null. */
    static async load(hub) {
        const hubU = String(hub || "").toUpperCase()
        if (!hubU) return null
        const ns = RouteAssistantWaveDraftStore._key(hubU)
        const lg = RouteAssistantWaveDraftStore._legacyKey(hubU)
        try {
            if (ns === lg) {
                const out = await chrome.storage.local.get([ns])
                return out[ns] || null
            }
            const out = await chrome.storage.local.get([ns, lg])
            return out[ns] || out[lg] || null
        } catch (e) {
            if (window.AESSiteSkin?.handleInvalidatedContext?.(e)) return null
            console.warn("[AES wave-draft] load failed:", e)
            return null
        }
    }

    /** Replace the draft record. Pass null to delete. */
    static async save(hub, record) {
        const hubU = String(hub || "").toUpperCase()
        if (!hubU) return
        const key = RouteAssistantWaveDraftStore._key(hubU)
        try {
            if (!record) await chrome.storage.local.remove([key])
            else await chrome.storage.local.set({[key]: record})
        } catch (e) {
            if (window.AESSiteSkin?.handleInvalidatedContext?.(e)) return
            console.warn("[AES wave-draft] save failed:", e)
        }
    }

    /** Drop the draft record without touching the SchedulePresets store. */
    static async clear(hub) {
        await RouteAssistantWaveDraftStore.save(hub, null)
    }

    /**
     * Fork the active preset into a draft. Duplicates via
     * `SchedulePresets.duplicate`, renames the copy "[Draft] <name>",
     * captures a baseline snapshot, and persists the link record.
     *
     * @param {string} hub
     * @param {object} baselinePreset - the live preset to fork
     * @returns {object|null} the duplicated draft preset, or null on failure
     */
    static async beginDraft(hub, baselinePreset) {
        const hubU = String(hub || "").toUpperCase()
        if (!hubU || !baselinePreset || !baselinePreset.id) return null
        if (typeof SchedulePresets === "undefined") return null
        const dup = await SchedulePresets.duplicate(baselinePreset.id)
        if (!dup) return null
        const draftName = "[Draft] " + (baselinePreset.name || "Wave plan")
        await SchedulePresets.update(dup.id, {name: draftName})
        const refreshed = (await SchedulePresets.load()).presets.find(p => p.id === dup.id)
            || dup
        const record = {
            draftPresetId:     dup.id,
            baselineId:        baselinePreset.id,
            baselineUpdatedAt: baselinePreset.updatedAt || null,
            baselineSnapshot:  RouteAssistantWaveDraftStore._snapshot(baselinePreset),
            createdAt:         Date.now()
        }
        await RouteAssistantWaveDraftStore.save(hubU, record)
        return refreshed
    }

    /**
     * Copy the draft's waves + factors back into the baseline preset.
     * Then delete the draft preset and clear the record. Returns the
     * updated baseline preset, or null on failure.
     */
    static async promoteToBaseline(hub) {
        const hubU = String(hub || "").toUpperCase()
        const rec = await RouteAssistantWaveDraftStore.load(hubU)
        if (!rec || typeof SchedulePresets === "undefined") return null
        const block = await SchedulePresets.load()
        const draft    = block.presets.find(p => p.id === rec.draftPresetId)
        const baseline = block.presets.find(p => p.id === rec.baselineId)
        if (!draft) {
            // Draft was deleted out from under us; just clear the record.
            await RouteAssistantWaveDraftStore.clear(hubU)
            return null
        }
        if (!baseline) {
            // Baseline was deleted; promote the draft into a fresh
            // preset by removing the [Draft] prefix.
            const cleanName = (draft.name || "Wave plan")
                .replace(/^\[Draft\]\s*/i, "")
            await SchedulePresets.update(draft.id, {name: cleanName})
            await RouteAssistantWaveDraftStore.clear(hubU)
            return draft
        }
        await SchedulePresets.update(rec.baselineId, {
            waves:   draft.waves,
            factors: draft.factors
        })
        await SchedulePresets.remove(draft.id)
        await RouteAssistantWaveDraftStore.clear(hubU)
        const finalBlock = await SchedulePresets.load()
        return finalBlock.presets.find(p => p.id === rec.baselineId) || null
    }

    /**
     * Save the draft as a new variant (keeps both baseline and the new
     * variant intact). Renames the draft from "[Draft] X" to "X (variant)"
     * and stamps `tweakedFrom` so existing variant-tracking UI picks it
     * up. Clears the draft record.
     */
    static async saveAsVariant(hub) {
        const hubU = String(hub || "").toUpperCase()
        const rec = await RouteAssistantWaveDraftStore.load(hubU)
        if (!rec || typeof SchedulePresets === "undefined") return null
        const block = await SchedulePresets.load()
        const draft = block.presets.find(p => p.id === rec.draftPresetId)
        if (!draft) {
            await RouteAssistantWaveDraftStore.clear(hubU)
            return null
        }
        const cleanName = (draft.name || "Wave plan")
            .replace(/^\[Draft\]\s*/i, "") + " (variant)"
        await SchedulePresets.update(draft.id, {
            name:        cleanName,
            tweakedFrom: rec.baselineId,
            tweakedAt:   Date.now()
        })
        await RouteAssistantWaveDraftStore.clear(hubU)
        const finalBlock = await SchedulePresets.load()
        return finalBlock.presets.find(p => p.id === rec.draftPresetId) || null
    }

    /**
     * Discard the draft — delete the draft preset and clear the record.
     * Returns the baseline preset id so the caller can switch back to it.
     */
    static async discard(hub) {
        const hubU = String(hub || "").toUpperCase()
        const rec = await RouteAssistantWaveDraftStore.load(hubU)
        if (!rec) return null
        if (typeof SchedulePresets !== "undefined") {
            try { await SchedulePresets.remove(rec.draftPresetId) }
            catch (e) { /* preset may already be gone */ }
        }
        await RouteAssistantWaveDraftStore.clear(hubU)
        return rec.baselineId || null
    }

    /**
     * Detect baseline drift — has the baseline preset been edited (in
     * another tab, by Track 4, etc.) since the draft was created? Used
     * by the panel to surface an "out-of-date" banner so the user knows
     * the deltas may be stale.
     */
    static async hasBaselineDrifted(hub, presets) {
        const rec = await RouteAssistantWaveDraftStore.load(hub)
        if (!rec || !rec.baselineUpdatedAt) return false
        const baseline = (presets || []).find(p => p.id === rec.baselineId)
        if (!baseline || !baseline.updatedAt) return false
        return Number(baseline.updatedAt) > Number(rec.baselineUpdatedAt)
    }

    /** Snapshot the bits of a preset that the diff renders against. */
    static _snapshot(preset) {
        if (!preset) return null
        try {
            return JSON.parse(JSON.stringify({
                waves:   preset.waves,
                factors: preset.factors
            }))
        } catch (e) {
            return null
        }
    }
}
