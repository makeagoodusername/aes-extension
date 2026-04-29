/**
 * Restructure slice D — In-panel wave preset editor.
 *
 * Was: Wave View was read-only against `SchedulePresets`. The user had to
 * leave the panel for the dashboard's Schedule Management page to create
 * or edit a preset, and the default starter preset shipped with
 * `composition: {0,0,0}` so every route landed in the read-only "Unplaced"
 * strip with no inline way to grant capacity. The wave function was
 * nominally there but practically unusable.
 *
 * Now: composition spinners (S / M / L) live on each wave's swim-lane
 * label, time windows are editable inline, waves can be added or
 * deleted from the panel itself, and the empty-state surfaces a
 * "+ Create wave plan for <HUB>" CTA that calls
 * `SchedulePresets.create` directly with sensible defaults.
 *
 * All mutations write through `SchedulePresets.update` (or `.create`,
 * `.remove`, `.duplicate`) — the dashboard's Schedule Management page
 * sees every edit immediately because they share the same store. The
 * wave-overlay's Gantt re-runs whenever a save lands so the user sees
 * flights populate / shift / disappear in real time.
 */
class RouteAssistantWaveEditor {

    /**
     * Build a sensible starter preset for `hub` and persist it. Used by
     * the empty-state CTA so first-time users don't have to learn the
     * Schedule Management UI before they can use Wave View.
     *
     * Defaults:
     *  - one wave, named "Wave 1"
     *  - arr 06:00–06:30, dep 07:15–07:45 (45 min ground; common HUB)
     *  - composition 4/2/1 (S/M/L) — leaves room for typical narrowbody
     *    operations without forcing the user to discover spinners first
     */
    static async createStarterPreset(hubIata) {
        const hub = String(hubIata || "").toUpperCase()
        const w = SchedulePresets.newWave("Wave 1")
        w.composition = {shortHaul: 4, mediumHaul: 2, longHaul: 1}
        const created = await SchedulePresets.create({
            name:  "Wave plan for " + hub,
            hub:   hub,
            waves: [w]
        })
        RouteAssistantWaveEditor._emitPresetUpdated(created)
        return created
    }

    /** Append a new wave to a preset, staggered ~4h after the last wave. */
    static async addWave(presetId) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const n = preset.waves.length
        const newWave = SchedulePresets.newWave("Wave " + (n + 1))
        const baseHr = Math.min(22, 6 + 4 * n)
        const fmt = (h, m) => String(Math.max(0, Math.min(23, h))).padStart(2, "0")
            + ":" + String(m).padStart(2, "0")
        newWave.arrivalWindow   = {start: fmt(baseHr,     0),  end: fmt(baseHr,     30)}
        newWave.departureWindow = {start: fmt(baseHr + 1, 15), end: fmt(baseHr + 1, 45)}
        // Inherit composition from the previous wave so the user doesn't
        // have to dial it in twice for a balanced day.
        if (n > 0 && preset.waves[n - 1].composition) {
            newWave.composition = Object.assign({}, preset.waves[n - 1].composition)
        }
        preset.waves.push(newWave)
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        return preset
    }

    /** Remove a wave by id. No-op if it's the only wave (we keep at least one). */
    static async removeWave(presetId, waveId) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset || preset.waves.length <= 1) return null
        preset.waves = preset.waves.filter(w => w.id !== waveId)
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        return preset
    }

    /**
     * Patch the composition of a single wave. `partial` is shallow-merged
     * over the existing composition so callers can write `{shortHaul: 5}`
     * without clobbering medium/long.
     */
    static async updateWaveComposition(presetId, waveId, partial) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const wave = preset.waves.find(w => w.id === waveId)
        if (!wave) return null
        wave.composition = Object.assign(
            {shortHaul: 0, mediumHaul: 0, longHaul: 0},
            wave.composition || {},
            partial
        )
        // Clamp to [0, 99] — UI never offers negatives but defensive.
        for (const k of ["shortHaul", "mediumHaul", "longHaul"]) {
            const v = Number(wave.composition[k])
            wave.composition[k] = isFinite(v) ? Math.max(0, Math.min(99, Math.floor(v))) : 0
        }
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        return preset
    }

    /**
     * Patch a single time field on a wave. `field` is one of
     * "arrivalStart" / "arrivalEnd" / "departureStart" / "departureEnd".
     * `time` is "HH:MM" — invalid input is rejected silently.
     */
    static async updateWaveTime(presetId, waveId, field, time) {
        if (!/^\d{2}:\d{2}$/.test(String(time))) return null
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const wave = preset.waves.find(w => w.id === waveId)
        if (!wave) return null
        if (!wave.arrivalWindow)   wave.arrivalWindow   = {start: "06:00", end: "06:30"}
        if (!wave.departureWindow) wave.departureWindow = {start: "07:15", end: "07:45"}
        if (field === "arrivalStart")   wave.arrivalWindow.start   = time
        if (field === "arrivalEnd")     wave.arrivalWindow.end     = time
        if (field === "departureStart") wave.departureWindow.start = time
        if (field === "departureEnd")   wave.departureWindow.end   = time
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        return preset
    }

    /**
     * Phase 3 Lane A — duplicate `waveId` and append the clone with all
     * times shifted by `staggerMin` (default 180 ≈ 3h). composition,
     * subBands, byDay, priority, geo, kin, preferredAircraft, etc all
     * deep-copy. The clone gets a fresh wave id so wave-overrides aren't
     * accidentally inherited.
     */
    static async cloneWave(presetId, waveId, staggerMin) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const src = preset.waves.find(w => w.id === waveId)
        if (!src) return null
        const stagger = isFinite(Number(staggerMin)) ? Number(staggerMin) : 180
        const dup = JSON.parse(JSON.stringify(src))
        // Fresh id — SchedulePresets.newWave generates a UUIDish.
        const tmp = SchedulePresets.newWave(src.label || "Wave")
        dup.id = tmp.id
        dup.label = (src.label || "Wave") + " (copy)"
        dup.arrivalWindow   = RouteAssistantWaveEditor._shiftWindow(src.arrivalWindow,   stagger)
        dup.departureWindow = RouteAssistantWaveEditor._shiftWindow(src.departureWindow, stagger)
        if (Array.isArray(src.subBands)) {
            dup.subBands = src.subBands.map(sb => Object.assign({}, sb, {
                id: (typeof tmp.id === "string" ? tmp.id : "sb") + "-" + Math.random().toString(36).slice(2, 6),
                start: RouteAssistantWaveEditor._shiftHHMM(sb.start, stagger),
                end:   RouteAssistantWaveEditor._shiftHHMM(sb.end,   stagger)
            }))
        }
        // Reset wave-override-touching state so clones land clean.
        dup.archivedAt = null
        preset.waves.push(dup)
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        try { if (window.CentralHubBus) window.CentralHubBus.emit("waveeditor:wave-cloned",
            {presetId, sourceId: waveId, cloneId: dup.id}) } catch (_) {}
        return preset
    }

    /**
     * Phase 3 Lane A — toggle archivedAt on a wave. Archived waves are
     * filtered out of new placement assignment by wave-overlay's existing
     * `_buildAssignment` logic; existing forced-placement overrides stay
     * visible so the user can release them manually.
     *
     * Pass `archived: true` to archive, `false` to un-archive. Default
     * toggle when `archived` is undefined.
     */
    static async archiveWave(presetId, waveId, archived) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const wave = preset.waves.find(w => w.id === waveId)
        if (!wave) return null
        const wantArchived = (typeof archived === "boolean") ? archived : !wave.archivedAt
        wave.archivedAt = wantArchived ? Date.now() : null
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        try { if (window.CentralHubBus) window.CentralHubBus.emit("waveeditor:wave-archived",
            {presetId, waveId, archived: wantArchived}) } catch (_) {}
        return preset
    }

    /**
     * Phase 3 Lane A — split a wave at HH:MM. Produces two sequential
     * waves: the first keeps the start half (arr.start..at, dep.start..at)
     * and the second takes the end half. Composition splits proportionally
     * by total window minutes. subBands are partitioned by start time.
     */
    static async splitWave(presetId, waveId, atHHMM) {
        if (!/^\d{2}:\d{2}$/.test(String(atHHMM))) return null
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const idx = preset.waves.findIndex(w => w.id === waveId)
        if (idx < 0) return null
        const src = preset.waves[idx]
        const at = RouteAssistantWaveEditor._parseHHMM(atHHMM)
        const arrS = RouteAssistantWaveEditor._parseHHMM(src.arrivalWindow && src.arrivalWindow.start)
        const arrE = RouteAssistantWaveEditor._parseHHMM(src.arrivalWindow && src.arrivalWindow.end)
        const depS = RouteAssistantWaveEditor._parseHHMM(src.departureWindow && src.departureWindow.start)
        const depE = RouteAssistantWaveEditor._parseHHMM(src.departureWindow && src.departureWindow.end)
        if (!isFinite(at) || !isFinite(arrS) || !isFinite(arrE)) return null
        if (at <= arrS || at >= depE) return null

        const totalMin = depE - arrS
        const firstMin = at - arrS
        const ratio = Math.max(0, Math.min(1, firstMin / Math.max(1, totalMin)))

        const splitComp = (key) => {
            const v = Number((src.composition || {})[key]) || 0
            const a = Math.round(v * ratio)
            return [a, Math.max(0, v - a)]
        }
        const [s1, s2] = splitComp("shortHaul")
        const [m1, m2] = splitComp("mediumHaul")
        const [l1, l2] = splitComp("longHaul")

        const fmt = (m) => {
            const mm = Math.max(0, Math.min(24 * 60 - 1, Math.round(m)))
            return String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0")
        }
        const tmp = SchedulePresets.newWave("part 2")
        const partA = JSON.parse(JSON.stringify(src))
        const partB = JSON.parse(JSON.stringify(src))
        partB.id = tmp.id
        partA.label = (src.label || "Wave") + " · 1"
        partB.label = (src.label || "Wave") + " · 2"
        partA.arrivalWindow   = {start: fmt(arrS), end: fmt(Math.min(arrE, at))}
        partA.departureWindow = {start: fmt(depS), end: fmt(Math.min(depE, at))}
        partB.arrivalWindow   = {start: fmt(Math.max(arrS, at)), end: fmt(arrE)}
        partB.departureWindow = {start: fmt(Math.max(depS, at)), end: fmt(depE)}
        partA.composition = {shortHaul: s1, mediumHaul: m1, longHaul: l1}
        partB.composition = {shortHaul: s2, mediumHaul: m2, longHaul: l2}
        if (Array.isArray(src.subBands)) {
            partA.subBands = src.subBands.filter(sb =>
                RouteAssistantWaveEditor._parseHHMM(sb.start) < at)
            partB.subBands = src.subBands.filter(sb =>
                RouteAssistantWaveEditor._parseHHMM(sb.start) >= at)
        }

        preset.waves.splice(idx, 1, partA, partB)
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        try { if (window.CentralHubBus) window.CentralHubBus.emit("waveeditor:wave-split",
            {presetId, sourceId: waveId, partAId: partA.id, partBId: partB.id, at: atHHMM}) } catch (_) {}
        return preset
    }

    /**
     * Phase 3 Lane A — patch the per-day composition of a wave for one
     * dayIdx (0..6, 0 = Sunday). null entries inherit from `wave.composition`.
     * Pass `dayIdx = "*"` and `partial = null` to clear all per-day
     * overrides on the wave.
     */
    static async setWaveByDayComposition(presetId, waveId, dayIdx, partial) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const wave = preset.waves.find(w => w.id === waveId)
        if (!wave) return null
        if (!wave.composition || typeof wave.composition !== "object") {
            wave.composition = {shortHaul: 0, mediumHaul: 0, longHaul: 0}
        }
        if (!Array.isArray(wave.composition.byDay)) wave.composition.byDay = [null,null,null,null,null,null,null]
        if (dayIdx === "*" && partial === null) {
            wave.composition.byDay = [null,null,null,null,null,null,null]
        } else {
            const i = Number(dayIdx)
            if (!isFinite(i) || i < 0 || i > 6) return null
            if (partial === null) {
                wave.composition.byDay[i] = null
            } else if (partial && typeof partial === "object") {
                const cur = wave.composition.byDay[i] || {
                    shortHaul:  wave.composition.shortHaul  || 0,
                    mediumHaul: wave.composition.mediumHaul || 0,
                    longHaul:   wave.composition.longHaul   || 0
                }
                const next = Object.assign({}, cur, partial)
                for (const k of ["shortHaul", "mediumHaul", "longHaul"]) {
                    const v = Number(next[k])
                    next[k] = isFinite(v) ? Math.max(0, Math.min(99, Math.floor(v))) : 0
                }
                wave.composition.byDay[i] = next
            }
        }
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        return preset
    }

    /**
     * Phase 3 Lane A — append a SubBand to wave.subBands[]. The kind is
     * "arrival" | "departure" | "groundOnly" (Lane C ownership for the
     * groundOnly maintenance hint per §A.3 / §C plumbing).
     */
    static async addSubBand(presetId, waveId, partial) {
        const block = await SchedulePresets.load()
        const preset = block.presets.find(p => p.id === presetId)
        if (!preset) return null
        const wave = preset.waves.find(w => w.id === waveId)
        if (!wave) return null
        if (!Array.isArray(wave.subBands)) wave.subBands = []
        const p = partial || {}
        const sb = (typeof SchedulePresets.newSubBand === "function")
            ? SchedulePresets.newSubBand(p.kind, p.start, p.end, p.label)
            : {
                id: "sb-" + Math.random().toString(36).slice(2, 8),
                kind: (p.kind === "departure" || p.kind === "groundOnly") ? p.kind : "arrival",
                start: p.start || "06:00",
                end:   p.end   || "06:15",
                weight: 1,
                label: p.label || ""
            }
        if (isFinite(Number(p.weight))) sb.weight = Number(p.weight)
        wave.subBands.push(sb)
        await SchedulePresets.update(presetId, {waves: preset.waves})
        RouteAssistantWaveEditor._emitPresetUpdated(preset)
        return preset
    }

    /** Internal — minute-of-day parsing/shift helpers reused by clone/split. */
    static _parseHHMM(s) {
        if (typeof s !== "string") return NaN
        const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
        if (!m) return NaN
        return Number(m[1]) * 60 + Number(m[2])
    }
    static _shiftHHMM(s, deltaMin) {
        const v = RouteAssistantWaveEditor._parseHHMM(s)
        if (!isFinite(v)) return s
        const next = Math.max(0, Math.min(24 * 60 - 1, v + Number(deltaMin || 0)))
        return String(Math.floor(next / 60)).padStart(2, "0") + ":" + String(next % 60).padStart(2, "0")
    }
    static _shiftWindow(win, deltaMin) {
        if (!win) return win
        return {
            start: RouteAssistantWaveEditor._shiftHHMM(win.start, deltaMin),
            end:   RouteAssistantWaveEditor._shiftHHMM(win.end,   deltaMin)
        }
    }

    /**
     * Track B — broadcast a same-page notification so wave-strip /
     * wave-overlay can refresh without polling. Cross-page propagation
     * still runs through chrome.storage.onChanged on the SchedulePresets
     * write (each subscriber listens for "settings" key changes).
     */
    static _emitPresetUpdated(preset) {
        if (!preset) return
        if (typeof window === "undefined") return
        if (typeof window.CentralHubBus === "undefined") return
        try {
            window.CentralHubBus.emit("waves:preset-updated", {
                presetId: preset.id || null,
                hub:      preset.hub || null,
                source:   "wave-editor"
            })
        } catch (_) { /* non-fatal */ }
    }

    /**
     * Render the empty-state card with a "+ Create wave plan for <HUB>"
     * CTA. Triggered by the panel when the user enters Wave mode without
     * any preset configured (or with no preset matching the picked hub).
     */
    static renderEmptyState(host, hubIata, opts) {
        host.innerHTML = ""
        const o = opts || {}
        const hub = String(hubIata || "this hub").toUpperCase()

        const card = document.createElement("div")
        card.style.cssText = "margin:18px 0;padding:18px;border:1px dashed #7c3aed;"
            + "background:rgba(124,58,237,0.06);border-radius:4px;color:#e5e7eb;"
            + "display:flex;flex-direction:column;gap:10px;align-items:flex-start;"
        const title = document.createElement("strong")
        title.textContent = "No wave plan yet for " + hub
        title.style.cssText = "font-size:13px;"
        card.append(title)

        const desc = document.createElement("div")
        desc.style.cssText = "font-size:11px;color:#cbd5e1;line-height:1.5;"
        desc.innerHTML = "A <em>wave plan</em> reserves arrival + departure slots and tells the auto-scheduler "
            + "how many short / medium / long-haul flights belong in each wave. "
            + "Pick the starter to get a single morning wave; tune capacities + add waves directly in the panel."
        card.append(desc)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:4px;"

        const createBtn = document.createElement("button")
        createBtn.type = "button"
        createBtn.textContent = "+ Create wave plan for " + hub
        createBtn.style.cssText = "background:var(--aes-rust);color:var(--aes-bone);"
            + "border:var(--aes-bw-1) solid var(--aes-rust);padding:6px 14px;cursor:pointer;"
            + "font-family:var(--aes-font-display);text-transform:uppercase;"
            + "letter-spacing:var(--aes-tracking-caps);font-size:var(--aes-fs-small);"
            + "font-weight:var(--aes-fw-bold);"
        createBtn.addEventListener("click", async () => {
            createBtn.disabled = true
            createBtn.textContent = "Creating…"
            try {
                const preset = await RouteAssistantWaveEditor.createStarterPreset(hub)
                if (o.onCreated) o.onCreated(preset)
            } catch (e) {
                console.error("[AES wave editor] createStarterPreset failed:", e)
                createBtn.disabled = false
                createBtn.textContent = "+ Create wave plan for " + hub
            }
        })
        btnRow.append(createBtn)

        if (o.dashboardUrl) {
            const link = document.createElement("a")
            link.href = o.dashboardUrl
            link.target = "_blank"
            link.rel = "noopener"
            link.textContent = "or open Schedule Management →"
            link.style.cssText = "color:#a78bfa;text-decoration:none;font-size:11px;"
            btnRow.append(link)
        }
        card.append(btnRow)
        host.append(card)
    }

    /**
     * Replace the static lane label rendered by `wave-overlay.js` with
     * editable controls — composition spinners, time inputs, delete.
     * Called via the `onEnhanceLabel` callback that the wave-overlay
     * accepts in editor mode.
     *
     * The wave-overlay's lane label is a 140px-wide column; the editor
     * controls are tuned to fit there without horizontal scroll.
     */
    static enhanceLaneLabel(labelEl, wave, preset, opts) {
        if (!labelEl || !wave) return
        const o = opts || {}
        labelEl.innerHTML = ""
        labelEl.style.padding = "4px 6px"

        // Wave label + delete button row
        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;justify-content:space-between;"
            + "margin-bottom:3px;gap:4px;"
        const lbl = document.createElement("strong")
        lbl.textContent = wave.label || "Wave"
        lbl.style.cssText = "font-size:11px;color:#cbd5e1;"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"
        const del = document.createElement("button")
        del.type = "button"
        del.textContent = "✕"
        del.title = "Delete this wave"
        del.style.cssText = "background:transparent;color:#94a3b8;"
            + "border:1px solid #475569;border-radius:2px;"
            + "padding:0 4px;cursor:pointer;font-size:9px;line-height:1.4;"
        del.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            if (o.onRemoveWave) o.onRemoveWave(wave.id)
        })
        top.append(lbl, del)
        labelEl.append(top)

        // Composition spinners — S / M / L. Click +/- to adjust by 1.
        const compRow = document.createElement("div")
        compRow.style.cssText = "display:flex;gap:2px;margin-bottom:3px;"
        const SPEC = [
            {key: "shortHaul",  tag: "S"},
            {key: "mediumHaul", tag: "M"},
            {key: "longHaul",   tag: "L"}
        ]
        for (const s of SPEC) {
            compRow.append(RouteAssistantWaveEditor._mkSpinner(wave, s.key, s.tag, o))
        }
        labelEl.append(compRow)

        // Time inputs — arr start/end, dep start/end. HTML5 time inputs
        // are 50px wide here; tight but readable.
        labelEl.append(RouteAssistantWaveEditor._mkTimeRow(
            "arr", wave.arrivalWindow,   "arrivalStart",   "arrivalEnd",   wave, o))
        labelEl.append(RouteAssistantWaveEditor._mkTimeRow(
            "dep", wave.departureWindow, "departureStart", "departureEnd", wave, o))
    }

    /** Internal — one S/M/L spinner. */
    static _mkSpinner(wave, key, tag, opts) {
        const v = (wave.composition && wave.composition[key]) || 0
        const wrap = document.createElement("span")
        wrap.style.cssText = "display:inline-flex;align-items:center;"
            + "border:1px solid #374151;border-radius:2px;"
            + "background:#0f1623;font-family:var(--aes-font-mono);"
            + "font-size:9px;color:#cbd5e1;flex:1;min-width:0;"

        const minus = document.createElement("button")
        minus.type = "button"
        minus.textContent = "−"
        minus.title = "Decrement " + tag
        minus.disabled = v <= 0
        minus.style.cssText = "background:transparent;color:" + (v <= 0 ? "#475569" : "#cbd5e1") + ";"
            + "border:0;width:14px;height:14px;cursor:" + (v <= 0 ? "not-allowed" : "pointer") + ";"
            + "line-height:1;padding:0;font-size:10px;"

        const num = document.createElement("span")
        num.textContent = String(v)
        num.style.cssText = "min-width:14px;text-align:center;font-weight:bold;"
            + "color:" + (v > 0 ? "#cbd5e1" : "#6b7280") + ";"

        const plus = document.createElement("button")
        plus.type = "button"
        plus.textContent = "+"
        plus.title = "Increment " + tag
        plus.style.cssText = "background:transparent;color:#cbd5e1;border:0;"
            + "width:14px;height:14px;cursor:pointer;line-height:1;padding:0;font-size:10px;"

        const lab = document.createElement("span")
        lab.textContent = tag
        lab.style.cssText = "padding:0 3px;color:#94a3b8;border-left:1px solid #374151;"

        minus.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation()
            const cur = (wave.composition && wave.composition[key]) || 0
            if (cur > 0 && opts.onComposition) opts.onComposition(wave.id, {[key]: cur - 1})
        })
        plus.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation()
            const cur = (wave.composition && wave.composition[key]) || 0
            if (opts.onComposition) opts.onComposition(wave.id, {[key]: cur + 1})
        })

        wrap.append(minus, num, plus, lab)
        return wrap
    }

    /** Internal — one "label HH:MM – HH:MM" editor row. */
    static _mkTimeRow(label, window, fStart, fEnd, wave, opts) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;align-items:center;gap:2px;"
            + "font-size:9px;color:#94a3b8;"
            + "font-family:var(--aes-font-mono);margin-top:1px;"

        const lab = document.createElement("span")
        lab.textContent = label
        lab.style.cssText = "min-width:18px;color:#6b7280;"
        row.append(lab)

        const w = window || {start: "00:00", end: "00:00"}
        const start = document.createElement("input")
        start.type = "time"
        start.value = w.start || "00:00"
        const inputCss = "background:#0f1623;color:#cbd5e1;"
            + "border:1px solid #374151;padding:0 1px;font-size:9px;"
            + "font-family:var(--aes-font-mono);width:46px;"
            + "color-scheme:dark;"
        start.style.cssText = inputCss

        const end = document.createElement("input")
        end.type = "time"
        end.value = w.end || "00:00"
        end.style.cssText = inputCss

        const dash = document.createElement("span")
        dash.textContent = "–"
        dash.style.cssText = "color:#6b7280;"

        row.append(start, dash, end)

        start.addEventListener("change", () => {
            if (opts.onTime) opts.onTime(wave.id, fStart, start.value)
        })
        end.addEventListener("change", () => {
            if (opts.onTime) opts.onTime(wave.id, fEnd, end.value)
        })
        return row
    }

    /**
     * Render the preset CRUD strip — preset dropdown + actions
     * (New / Duplicate / Rename / Delete). Returned as a DocumentFragment
     * so the caller (`_buildWaveHeader` in panel.js) can append it
     * inline alongside the existing topN / hub-picker controls.
     *
     * Callbacks in `opts`:
     *   - onPickPreset(id)
     *   - onAfterCreate(preset)
     *   - onAfterDuplicate(preset)
     *   - onAfterRename(preset)
     *   - onAfterDelete(presetId)
     */
    static renderPresetActions(preset, presets, opts) {
        const o = opts || {}
        const frag = document.createDocumentFragment()

        const presetSel = document.createElement("select")
        presetSel.style.cssText = "background:#0f1623;color:#f3f4f6;"
            + "border:1px solid #374151;border-radius:3px;padding:2px 4px;font-size:11px;"
        presetSel.title = "Active wave preset. New / Duplicate / Delete actions to the right."
        if (!presets.length) {
            const opt = document.createElement("option")
            opt.value = ""
            opt.textContent = "(no presets)"
            presetSel.append(opt)
            presetSel.disabled = true
        } else {
            for (const p of presets) {
                const opt = document.createElement("option")
                opt.value = p.id
                opt.textContent = p.name + (p.hub ? " — " + p.hub : "")
                if (preset && p.id === preset.id) opt.selected = true
                presetSel.append(opt)
            }
            presetSel.addEventListener("change", () => {
                if (o.onPickPreset) o.onPickPreset(presetSel.value)
            })
        }
        frag.append(presetSel)

        const mkBtn = (label, title, onClick, disabled) => {
            const b = document.createElement("button")
            b.type = "button"
            b.textContent = label
            b.title = title
            b.disabled = !!disabled
            b.style.cssText = "background:" + (disabled ? "#1f2937" : "#374151") + ";"
                + "color:" + (disabled ? "#6b7280" : "#e5e7eb") + ";"
                + "border:1px solid " + (disabled ? "#1f2937" : "#475569") + ";"
                + "border-radius:3px;padding:2px 8px;font-size:11px;"
                + "cursor:" + (disabled ? "not-allowed" : "pointer") + ";"
            if (!disabled && onClick) b.addEventListener("click", onClick)
            return b
        }

        // + New
        frag.append(mkBtn("+ New", "Create a new empty wave preset for this hub.", async () => {
            const hub = (o.hubIata || "").toUpperCase()
            const name = window.prompt("Name for the new wave plan:",
                hub ? "Wave plan for " + hub : "New wave plan")
            if (!name) return
            const w = SchedulePresets.newWave("Wave 1")
            const created = await SchedulePresets.create({name: name, hub: hub, waves: [w]})
            if (o.onAfterCreate) o.onAfterCreate(created)
        }))

        // ⧉ Duplicate
        frag.append(mkBtn("⧉ Dup", "Duplicate the active preset (waves + factors).",
            async () => {
                const dup = await SchedulePresets.duplicate(preset.id)
                if (dup && o.onAfterDuplicate) o.onAfterDuplicate(dup)
            }, !preset))

        // ✎ Rename
        frag.append(mkBtn("✎ Rename", "Rename the active preset.",
            async () => {
                const next = window.prompt("Rename wave plan:", preset.name)
                if (!next || next === preset.name) return
                const updated = await SchedulePresets.update(preset.id, {name: next.trim()})
                if (updated && o.onAfterRename) o.onAfterRename(updated)
            }, !preset))

        // ✕ Delete
        frag.append(mkBtn("✕ Del", "Delete the active preset (irreversible).",
            async () => {
                if (!window.confirm("Delete wave plan \"" + preset.name + "\"?")) return
                const ok = await SchedulePresets.remove(preset.id)
                if (ok && o.onAfterDelete) o.onAfterDelete(preset.id)
            }, !preset))

        return frag
    }
}
