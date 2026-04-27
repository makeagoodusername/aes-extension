/**
 * CRUD wrapper for `settings.scheduleManagement` — the per-extension
 * configuration block holding wave/composition presets plus a few
 * generation defaults.
 *
 * Mirrors the UsedAircraftPresets pattern: presets live inside the single
 * `settings` storage key so they survive across servers/airlines and are
 * editable from the dashboard panel.
 *
 * A preset describes one *template* of how a hub's flying day is shaped
 * (when waves happen, how many flights of which haul-length per wave,
 * what factors must hold). Generated schedules — the per-airline output
 * of running a preset — live separately in `schedule-store.js`.
 */
class SchedulePresets {
    static _defaults() {
        return {
            presets: [],
            defaultPresetId: null,
            lastBuildId: null
        }
    }

    /**
     * Builds a fresh preset record with sensible factor defaults and one
     * empty wave. Caller is responsible for persisting via create() / save().
     *
     * Optional provenance fields (Track 4 slot optimizer, slice 4e):
     *   - tweakedFrom:  source preset id when this is an auto-tweaked variant
     *   - tweakedAt:    Date.now() of the tweak run
     *   - tweakedFor:   aircraftId the tweak optimized against
     * Plain user-created presets leave all three undefined; the picker UI
     * keys on `tweakedFrom` to render the 🔧 glyph.
     */
    static newPreset(name) {
        return {
            id: "p" + Date.now().toString(36),
            name: (name || "New schedule preset").trim() || "New schedule preset",
            hub: "",
            waves: [SchedulePresets.newWave("Wave 1")],
            factors: ScheduleFactors.defaultFactors(),
            notes: "",
            createdAt: Date.now(),
            updatedAt: Date.now()
        }
    }

    /**
     * Builds a fresh wave record. Keep wave defaults conservative: 30-min
     * arrival/departure windows with a 45-min connection gap is a common
     * starting point for medium hubs.
     */
    static newWave(label) {
        return {
            id: "w" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
            label: label || "Untitled wave",
            arrivalWindow:   {start: "06:00", end: "06:30"},
            departureWindow: {start: "07:15", end: "07:45"},
            composition: {
                shortHaul: 0,
                mediumHaul: 0,
                longHaul: 0
            }
        }
    }

    /** Reads `settings.scheduleManagement`, lazily initialising it if missing. */
    static async load() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const defaults = SchedulePresets._defaults()
        const block = Object.assign({}, defaults, settings.scheduleManagement || {})
        if (!settings.scheduleManagement) {
            settings.scheduleManagement = block
            await chrome.storage.local.set({settings: settings})
        }
        return block
    }

    /** Persists a partial update to settings.scheduleManagement. */
    static async save(partial) {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const current = Object.assign(
            {}, SchedulePresets._defaults(),
            settings.scheduleManagement || {},
            partial
        )
        settings.scheduleManagement = current
        await chrome.storage.local.set({settings: settings})
        return current
    }

    /**
     * Inserts a new preset. Returns the inserted record (with generated id).
     * @param {object} partial - any fields to override on the default preset
     */
    static async create(partial) {
        const block = await SchedulePresets.load()
        const preset = Object.assign(SchedulePresets.newPreset(partial?.name), partial || {})
        // newPreset() already set createdAt/updatedAt; keep them consistent
        preset.createdAt = preset.createdAt || Date.now()
        preset.updatedAt = Date.now()
        block.presets.push(preset)
        if (!block.defaultPresetId) block.defaultPresetId = preset.id
        await SchedulePresets.save({presets: block.presets, defaultPresetId: block.defaultPresetId})
        return preset
    }

    /**
     * Patches a preset in place. `fields` is shallowly merged; nested
     * `factors` and `waves` should be passed in full to avoid losing keys.
     */
    static async update(id, fields) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === id)
        if (!preset) return null
        Object.assign(preset, fields, {updatedAt: Date.now()})
        await SchedulePresets.save({presets: block.presets})
        return preset
    }

    static async remove(id) {
        const block = await SchedulePresets.load()
        const before = block.presets.length
        block.presets = block.presets.filter(p => p.id !== id)
        if (block.presets.length === before) return false
        if (block.defaultPresetId === id) {
            block.defaultPresetId = block.presets[0]?.id || null
        }
        await SchedulePresets.save({
            presets: block.presets,
            defaultPresetId: block.defaultPresetId
        })
        return true
    }

    /**
     * Track 4 slice 4e — saves an auto-tweaked variant of a base preset.
     *
     * Reuses `create()` (don't fork CRUD paths) but stamps three
     * provenance fields onto the new record so the picker UI can mark
     * tweaked variants with the 🔧 glyph and a future cleanup sweep
     * can locate orphan auto-saves.
     *
     *   tweakedFrom: <base preset id>
     *   tweakedAt:   Date.now()
     *   tweakedFor:  <aircraftId> (server-scoped at the call site)
     *
     * @param {object} args
     * @param {object} args.base source preset (must have id, hub, factors)
     * @param {Array}  args.waves replacement wave list (deep-cloned by create)
     * @param {string|number} args.tweakedFor aircraftId
     * @param {string} [args.nameSuffix] override the default " · auto-tweaked"
     * @returns {Promise<object>} the inserted preset (with id)
     */
    static async createTweaked(args) {
        const a = args || {}
        if (!a.base || !a.base.id) throw new Error("createTweaked: base.id required")
        const suffix = (typeof a.nameSuffix === "string" && a.nameSuffix.length > 0)
            ? a.nameSuffix
            : " · auto-tweaked"
        const partial = {
            name:    String(a.base.name || "Schedule preset") + suffix,
            hub:     a.base.hub || "",
            waves:   Array.isArray(a.waves) ? a.waves : (a.base.waves || []),
            // Deep-clone factors so a future tweak doesn't mutate the source.
            factors: JSON.parse(JSON.stringify(a.base.factors || ScheduleFactors.defaultFactors())),
            notes:   a.base.notes || "",
            tweakedFrom: a.base.id,
            tweakedAt:   Date.now(),
            tweakedFor:  String(a.tweakedFor || "")
        }
        return await SchedulePresets.create(partial)
    }

    /**
     * Convenience: clones a preset with a new id and " (copy)" suffix on the
     * name. Useful for letting users derive variants from a working preset.
     */
    static async duplicate(id) {
        const block = await SchedulePresets.load()
        const source = block.presets.find(p => p.id === id)
        if (!source) return null
        const copy = JSON.parse(JSON.stringify(source))
        copy.id = "p" + Date.now().toString(36)
        copy.name = source.name + " (copy)"
        copy.createdAt = Date.now()
        copy.updatedAt = Date.now()
        // Re-key waves so wave ids are unique within the new preset.
        copy.waves = (copy.waves || []).map(w => Object.assign({}, w, {
            id: "w" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36)
        }))
        block.presets.push(copy)
        await SchedulePresets.save({presets: block.presets})
        return copy
    }
}
