"use strict"

;(function () {
    if (typeof window !== "undefined") {
        if (window.SchedulePresets) return
    }
    const ScheduleFactors = (typeof window !== "undefined" && window.ScheduleFactors) || globalThis.ScheduleFactors

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
     *
     * Additive Phase-1 fields (Wave Mechanics Expansion):
     *   - pinned/starredAt: palette ordering hints
     *   - geography:        {region, country, federation} for Lane B
     *   - kinPresetId:      cross-account ref (Letter L9)
     *   - templateRevision: bumps on every wave-set change
     *   - appliesToFleets:  soft fleet hint (Lane C may hard-constrain)
     *   - schedule:         {weekPattern, dayMask:bool[7]} day-of-week mask
     * All optional — legacy presets reading without these stay valid.
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
            updatedAt: Date.now(),
            pinned:           false,
            starredAt:        null,
            geography:        {region: null, country: null, federation: null},
            kinPresetId:      null,
            templateRevision: 1,
            appliesToFleets:  [],
            schedule:         {weekPattern: "daily", dayMask: [true, true, true, true, true, true, true]}
        }
    }

    /**
     * Builds a fresh wave record. Keep wave defaults conservative: 30-min
     * arrival/departure windows with a 45-min connection gap is a common
     * starting point for medium hubs.
     *
     * Additive Phase-1 fields (Wave Mechanics Expansion):
     *   - subBands:         enriched sub-windows inside the rectangle
     *   - composition.byDay 7 × {S,M,L} | null  (null inherits composition)
     *   - priority          0..99 — wave-route-fitter tiebreak
     *   - pinDestinations   wave-scoped destination overrides
     *   - preferredAircraft {ids:[], types:[]} soft allocator hint
     *   - kin               {coordinatedHubs[], allianceTier}
     *   - geo               {region, country}
     *   - routePolicy       "auto"|"lockedSet"|"templateOnly"
     *   - notes             free-text per wave
     *   - archivedAt        soft-delete; UI hides; preserves overrides
     * Legacy waves without these read fine — consumers default-guard.
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
                longHaul: 0,
                byDay: null
            },
            subBands:           [],
            priority:           50,
            pinDestinations:    [],
            preferredAircraft:  {ids: [], types: []},
            kin:                {coordinatedHubs: [], allianceTier: "none"},
            geo:                {region: null, country: null},
            routePolicy:        "auto",
            notes:              "",
            archivedAt:         null
        }
    }

    /**
     * Builds a fresh sub-band record. Sub-bands enrich a wave's
     * arrivalWindow/departureWindow rectangle — e.g. a thick arrival window
     * with a "premium" sub-band 06:10–06:25 where wide-bodies must land.
     *
     * The wave's outer arrival/departureWindow stays canonical and captures
     * the rectangle that contains all sub-bands; sub-band-aware code reads
     * the sub-bands directly while wave-route-fitter (legacy) keeps reading
     * the rectangle without changes.
     */
    static newSubBand(kind, start, end, label) {
        const validKind = (kind === "arrival" || kind === "departure" || kind === "groundOnly")
            ? kind : "arrival"
        return {
            id: "sb" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
            kind:   validKind,
            start:  start || "06:00",
            end:    end   || "06:15",
            weight: 1,
            label:  label || ""
        }
    }

    static _enqueueWrite(fn) {
        if (!SchedulePresets._writeQueue) SchedulePresets._writeQueue = Promise.resolve()
        const run = SchedulePresets._writeQueue.catch(() => {}).then(fn)
        SchedulePresets._writeQueue = run.catch(() => {})
        return run
    }

    static _settingsApi() {
        const root = (typeof globalThis !== "undefined")
            ? globalThis
            : (typeof window !== "undefined" ? window : null)
        const api = root && root.AesSettings
        return api && typeof api.getArea === "function" && typeof api.saveArea === "function"
            ? api
            : null
    }

    static async _getArea() {
        const api = SchedulePresets._settingsApi()
        if (api) {
            return await api.getArea("scheduleManagement")
        }
        const data = await chrome.storage.local.get(["settings"])
        const settings = data && data.settings && typeof data.settings === "object"
            ? data.settings
            : {}
        const area = settings.scheduleManagement
        return area && typeof area === "object" && !Array.isArray(area) ? area : {}
    }

    static async _saveArea(block) {
        const api = SchedulePresets._settingsApi()
        if (api) {
            await api.saveArea("scheduleManagement", block)
            return block
        }
        throw new Error("AesSettings.saveArea unavailable; load modules/_shared/settings-bridge.js before schedule presets")
    }

    static async _readBlock() {
        const stored = await SchedulePresets._getArea()
        return Object.assign({}, SchedulePresets._defaults(), stored)
    }

    static async _writeBlock(block) {
        const current = Object.assign({}, SchedulePresets._defaults(), block || {})
        await SchedulePresets._saveArea(current)
        return current
    }

    /** Reads `settings.scheduleManagement`, lazily initialising it if missing. */
    static async load() {
        const stored = await SchedulePresets._getArea()
        const merged = Object.assign({}, SchedulePresets._defaults(), stored)
        // Lazy-init: if the area was never written, persist defaults so the
        // shape exists for subsequent reads.
        if (!stored || Object.keys(stored).length === 0) {
            await SchedulePresets._saveArea(merged)
        }
        return merged
    }

    /** Persists a partial update to settings.scheduleManagement. */
    static async save(partial) {
        return SchedulePresets._enqueueWrite(async () => {
            const current = Object.assign(
                {}, SchedulePresets._defaults(),
                await SchedulePresets._getArea(),
                partial
            )
            await SchedulePresets._saveArea(current)
            return current
        })
    }

    /**
     * Inserts a new preset. Returns the inserted record (with generated id).
     * @param {object} partial - any fields to override on the default preset
     */
    static async create(partial) {
        return SchedulePresets._enqueueWrite(async () => {
            const block = await SchedulePresets._readBlock()
            block.presets = Array.isArray(block.presets) ? block.presets.slice() : []
            const preset = Object.assign(SchedulePresets.newPreset(partial?.name), partial || {})
            // newPreset() already set createdAt/updatedAt; keep them consistent
            preset.createdAt = preset.createdAt || Date.now()
            preset.updatedAt = Date.now()
            block.presets.push(preset)
            if (!block.defaultPresetId) block.defaultPresetId = preset.id
            await SchedulePresets._writeBlock(block)
            return preset
        })
    }

    /**
     * Patches a preset in place. `fields` is shallowly merged; nested
     * `factors` and `waves` should be passed in full to avoid losing keys.
     *
     * When `fields.waves` is present the additive `templateRevision`
     * counter bumps so palette / Gantt subscribers can render an "edited"
     * marker without diffing the whole wave list.
     */
    static async update(id, fields) {
        return SchedulePresets._enqueueWrite(async () => {
            const block = await SchedulePresets._readBlock()
            block.presets = Array.isArray(block.presets) ? block.presets.slice() : []
            const preset = block.presets.find(p => p.id === id)
            if (!preset) return null
            const wavesChanged = fields && Object.prototype.hasOwnProperty.call(fields, "waves")
            Object.assign(preset, fields, {updatedAt: Date.now()})
            if (wavesChanged) {
                preset.templateRevision = Number(preset.templateRevision || 0) + 1
            }
            await SchedulePresets._writeBlock(block)
            return preset
        })
    }

    static async remove(id) {
        return SchedulePresets._enqueueWrite(async () => {
            const block = await SchedulePresets._readBlock()
            block.presets = Array.isArray(block.presets) ? block.presets : []
            const before = block.presets.length
            block.presets = block.presets.filter(p => p.id !== id)
            if (block.presets.length === before) return false
            if (block.defaultPresetId === id) {
                block.defaultPresetId = block.presets[0]?.id || null
            }
            await SchedulePresets._writeBlock(block)
            return true
        })
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
        return SchedulePresets._enqueueWrite(async () => {
            const block = await SchedulePresets._readBlock()
            block.presets = Array.isArray(block.presets) ? block.presets.slice() : []
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
            await SchedulePresets._writeBlock(block)
            return copy
        })
    }
}

SchedulePresets._writeQueue = Promise.resolve()

if (typeof window !== "undefined") {
    window.SchedulePresets = SchedulePresets
}
})()
