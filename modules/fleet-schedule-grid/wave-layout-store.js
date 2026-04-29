"use strict"

/**
 * Fleet Schedule Grid — wave layout store.
 *
 * The grid lets users overlay up to 5 wave templates from `SchedulePresets`
 * on top of every aircraft's lane. They can re-color, fade, or drag-shift
 * a wave (Slice 2) — those changes live HERE, not in the saved preset, so
 * experimenting on the grid never mutates the user's wave templates.
 *
 *   chrome.storage.local["fleetScheduleGrid:waveLayout:<server>:<airlineCode>"]
 *     = {schemaVersion: 1, layers: WaveLayer[], fadeRatio}
 *
 * WaveLayer shape:
 *   {
 *     id:           string,    // unique per-grid layer id
 *     presetId:     string,    // ref to SchedulePresets record
 *     waveId:       string,    // ref to a specific Wave inside that preset
 *     hub:          string,    // cached hub IATA — survives preset deletion
 *     name:         string,    // cached preset.name + " — " + wave.label
 *     color:        string,    // CSS color (HSL string from picker)
 *     opacity:      number,    // 0..1, default 0.35
 *     role:         string,    // "active" (drives allocator) or "comparison"
 *     timeShiftMin: number,    // global shift on both windows (default 0)
 *     arrShiftMin:  number,    // independent arrival-only shift (Alt-drag, slice 2)
 *     depShiftMin:  number,    // independent departure-only shift (Alt-drag, slice 2)
 *     days:         boolean[], // length 7 Mon..Sun; default [true]*7
 *     addedAt:      number
 *   }
 *
 * `role` partitions the band visuals: active layers render solid + multiply
 * blended; comparison layers render dashed + lower opacity. A hub gets at
 * most one active layer at a time — `setActiveForHub` enforces this by
 * removing any prior active layer with the same hub before upserting.
 *
 * Hard cap of 5 active layers — matched to `MAX_LAYERS`. Any save() that
 * would exceed this returns null without touching storage; the caller is
 * expected to surface a "remove a layer first" hint.
 */
class FleetScheduleGridWaveLayoutStore {
    static PREFIX = "fleetScheduleGrid:waveLayout:"
    static SCHEMA_VERSION = 1
    static MAX_LAYERS = 5
    static DEFAULT_FADE_RATIO = 0.25
    static DEFAULT_OPACITY = 0.35

    static _key(server, airlineCode) {
        return FleetScheduleGridWaveLayoutStore.PREFIX
             + String(server || "")
             + ":"
             + String(airlineCode || "")
    }

    static _empty() {
        return {
            schemaVersion: FleetScheduleGridWaveLayoutStore.SCHEMA_VERSION,
            layers:        [],
            fadeRatio:     FleetScheduleGridWaveLayoutStore.DEFAULT_FADE_RATIO
        }
    }

    static _normLayer(l) {
        if (!l || typeof l !== "object") return null
        const days = Array.isArray(l.days) && l.days.length === 7
            ? l.days.map(d => !!d)
            : [true, true, true, true, true, true, true]
        const role = (l.role === "active") ? "active" : "comparison"
        return {
            id:           String(l.id || ("layer-" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36))),
            presetId:     String(l.presetId || ""),
            waveId:       String(l.waveId   || ""),
            hub:          String(l.hub      || "").toUpperCase(),
            name:         String(l.name     || ""),
            color:        String(l.color    || "hsl(200,60%,60%)"),
            role:         role,
            opacity:      typeof l.opacity      === "number" && isFinite(l.opacity)      ? Math.max(0.05, Math.min(1, l.opacity))      : FleetScheduleGridWaveLayoutStore.DEFAULT_OPACITY,
            timeShiftMin: typeof l.timeShiftMin === "number" && isFinite(l.timeShiftMin) ? Math.round(l.timeShiftMin) : 0,
            arrShiftMin:  typeof l.arrShiftMin  === "number" && isFinite(l.arrShiftMin)  ? Math.round(l.arrShiftMin)  : 0,
            depShiftMin:  typeof l.depShiftMin  === "number" && isFinite(l.depShiftMin)  ? Math.round(l.depShiftMin)  : 0,
            days,
            addedAt:      typeof l.addedAt === "number" && isFinite(l.addedAt) ? l.addedAt : Date.now()
        }
    }

    /** Returns the stored block, or an empty default. Never throws. */
    static async load(server, airlineCode) {
        if (!server) return FleetScheduleGridWaveLayoutStore._empty()
        const key = FleetScheduleGridWaveLayoutStore._key(server, airlineCode)
        let blob = null
        try { blob = await chrome.storage.local.get([key]) }
        catch (_) { return FleetScheduleGridWaveLayoutStore._empty() }
        const rec = blob && blob[key]
        if (!rec || typeof rec !== "object") return FleetScheduleGridWaveLayoutStore._empty()
        if (rec.schemaVersion !== FleetScheduleGridWaveLayoutStore.SCHEMA_VERSION) {
            return FleetScheduleGridWaveLayoutStore._empty()
        }
        const layers = (Array.isArray(rec.layers) ? rec.layers : [])
            .map(FleetScheduleGridWaveLayoutStore._normLayer)
            .filter(Boolean)
            .slice(0, FleetScheduleGridWaveLayoutStore.MAX_LAYERS)
        const fadeRatio = (typeof rec.fadeRatio === "number" && rec.fadeRatio >= 0 && rec.fadeRatio <= 1)
            ? rec.fadeRatio
            : FleetScheduleGridWaveLayoutStore.DEFAULT_FADE_RATIO
        return {schemaVersion: FleetScheduleGridWaveLayoutStore.SCHEMA_VERSION, layers, fadeRatio}
    }

    /** Persist a full block. Cap-enforced. Returns the saved record. */
    static async save(server, airlineCode, block) {
        if (!server) return null
        const key = FleetScheduleGridWaveLayoutStore._key(server, airlineCode)
        const layers = (Array.isArray(block && block.layers) ? block.layers : [])
            .map(FleetScheduleGridWaveLayoutStore._normLayer)
            .filter(Boolean)
            .slice(0, FleetScheduleGridWaveLayoutStore.MAX_LAYERS)
        const next = {
            schemaVersion: FleetScheduleGridWaveLayoutStore.SCHEMA_VERSION,
            layers,
            fadeRatio: (typeof (block && block.fadeRatio) === "number" && block.fadeRatio >= 0 && block.fadeRatio <= 1)
                ? block.fadeRatio
                : FleetScheduleGridWaveLayoutStore.DEFAULT_FADE_RATIO
        }
        try { await chrome.storage.local.set({[key]: next}) }
        catch (_) { return null }
        return next
    }

    /**
     * Insert or update a single layer in-place by `id`. Returns the saved
     * block, or null if save would exceed the layer cap.
     */
    static async upsertLayer(server, airlineCode, layer) {
        const block = await FleetScheduleGridWaveLayoutStore.load(server, airlineCode)
        const norm = FleetScheduleGridWaveLayoutStore._normLayer(layer)
        if (!norm) return null
        const idx = block.layers.findIndex(l => l.id === norm.id)
        if (idx >= 0) {
            block.layers[idx] = norm
        } else {
            if (block.layers.length >= FleetScheduleGridWaveLayoutStore.MAX_LAYERS) {
                return null
            }
            block.layers.push(norm)
        }
        return FleetScheduleGridWaveLayoutStore.save(server, airlineCode, block)
    }

    /**
     * Hub Plan Workbench — atomically replaces any existing role:"active"
     * layer for `hub` with the supplied layer (whose role is forced to
     * "active"). Comparison layers for the same hub are untouched. The
     * cap counts active + comparison together, so callers should ensure
     * the cap won't be busted (the picker enforces 1 active + 2 compares).
     */
    static async setActiveForHub(server, airlineCode, hub, layer) {
        const block = await FleetScheduleGridWaveLayoutStore.load(server, airlineCode)
        const HUB = String(hub || "").toUpperCase()
        const norm = FleetScheduleGridWaveLayoutStore._normLayer(
            Object.assign({}, layer, {role: "active", hub: HUB})
        )
        if (!norm) return null
        // Drop any prior active layer for this hub.
        block.layers = block.layers.filter(l => !(l.role === "active" && l.hub === HUB))
        // Replace by id if one already exists, else append (cap-checked).
        const idx = block.layers.findIndex(l => l.id === norm.id)
        if (idx >= 0) {
            block.layers[idx] = norm
        } else {
            if (block.layers.length >= FleetScheduleGridWaveLayoutStore.MAX_LAYERS) {
                return null
            }
            block.layers.push(norm)
        }
        return FleetScheduleGridWaveLayoutStore.save(server, airlineCode, block)
    }

    static async removeLayer(server, airlineCode, layerId) {
        const block = await FleetScheduleGridWaveLayoutStore.load(server, airlineCode)
        const before = block.layers.length
        block.layers = block.layers.filter(l => l.id !== String(layerId))
        if (block.layers.length === before) return block
        return FleetScheduleGridWaveLayoutStore.save(server, airlineCode, block)
    }

    /** Adds `deltaMin` to `timeShiftMin` (or to a specific kind for Alt-drag). */
    static async shiftLayer(server, airlineCode, layerId, deltaMin, kind) {
        const block = await FleetScheduleGridWaveLayoutStore.load(server, airlineCode)
        const layer = block.layers.find(l => l.id === String(layerId))
        if (!layer) return null
        const k = kind || "both"
        if (k === "arr") layer.arrShiftMin = (layer.arrShiftMin || 0) + Math.round(deltaMin)
        else if (k === "dep") layer.depShiftMin = (layer.depShiftMin || 0) + Math.round(deltaMin)
        else { layer.timeShiftMin = (layer.timeShiftMin || 0) + Math.round(deltaMin) }
        return FleetScheduleGridWaveLayoutStore.save(server, airlineCode, block)
    }

    static async clear(server, airlineCode) {
        const key = FleetScheduleGridWaveLayoutStore._key(server, airlineCode)
        try { await chrome.storage.local.remove([key]) }
        catch (_) {}
        return FleetScheduleGridWaveLayoutStore._empty()
    }

    /**
     * Subscribe to cross-tab updates. Callback fires with (server, airlineCode, newBlock|null).
     * Returns an unwatch function. Cheap; one global onChanged listener per call.
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(FleetScheduleGridWaveLayoutStore.PREFIX) !== 0) continue
                const tail = key.slice(FleetScheduleGridWaveLayoutStore.PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server = tail.slice(0, sep)
                const airlineCode = tail.slice(sep + 1)
                try { cb(server, airlineCode, changes[key].newValue || null) }
                catch (e) { console.warn("[AES FSG] wave-layout-store watch handler threw", e) }
            }
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) { return () => {} }
        return () => { try { chrome.storage.onChanged.removeListener(handler) } catch (_) {} }
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridWaveLayoutStore = FleetScheduleGridWaveLayoutStore
}
