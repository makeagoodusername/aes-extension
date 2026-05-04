"use strict"

/**
 * Route Launcher — slot finder.
 *
 * Returns the next plausible departure HH:MM for a given aircraft based
 * on the configured slot strategy. AS's "New Flight Number" form takes
 * a single time of day; week-day placement is implicit in the resulting
 * schedule grid.
 *
 * Strategies (defaults from AesRouteLauncherDefaults):
 *   - "earliest-gap"        scan active draft + persisted AFP schedule, then
 *                           return the first hub-local gap that can hold the
 *                           proposed flight + turnaround inside 06:00-22:00
 *   - "fixed-time"          always return defaultDepartureTime
 *   - "daily-round-robin"   defaultDepartureTime + (legCount * 4h) mod 24
 *
 * Reads the active draft (`aircraftFlightPlan:draft:<server>:<aircraftId>`)
 * via AesAfpActiveDraftStore and, when available, the persisted AFP schedule
 * (`aircraftFlightPlan:schedule:<server>:<aircraftId>`). This keeps launcher
 * submits from defaulting into the middle of an aircraft's live plan.
 */
class AesRouteLauncherSlotFinder {
    static MIN_HOUR = 6
    static MAX_HOUR = 22
    static FALLBACK = "09:00"
    static STEP_MIN = 5

    static async findSlot(server, aircraftId, opts) {
        const o = opts || {}
        const strategy = o.strategy || "earliest-gap"
        const dflt = o.defaultDepartureTime || AesRouteLauncherSlotFinder.FALLBACK
        const turn = Number.isFinite(o.turnaroundMin) ? o.turnaroundMin : 30
        const hasFlightMin = Number.isFinite(o.flightMin)
        const flightMin = hasFlightMin ? o.flightMin : 60

        if (strategy === "fixed-time") return dflt

        const legs = await AesRouteLauncherSlotFinder._legsOf(server, aircraftId)
        if (strategy === "daily-round-robin") {
            const offset = (legs.length * 4) % 24
            const base = AesRouteLauncherSlotFinder._parse(dflt) || {h: 9, m: 0}
            return AesRouteLauncherSlotFinder._fmt((base.h + offset) % 24, base.m)
        }

        if (!legs.length) return dflt
        if (o.requireKnownDuration && !hasFlightMin) return null
        const gap = AesRouteLauncherSlotFinder.suggestSlotFromLegs(legs, {
            originIata:           o.originIata,
            defaultDepartureTime: dflt,
            turnaroundMin:        turn,
            flightMin:            flightMin
        })
        if (gap) return gap
        if (o.requireConflictFree) return null

        const lastArrivalMin = AesRouteLauncherSlotFinder._lastArrivalMin(legs, flightMin)
        if (lastArrivalMin == null) return dflt
        const proposedMin = (lastArrivalMin + turn) % (24 * 60)
        return AesRouteLauncherSlotFinder._clampToWindow(proposedMin, dflt)
    }

    static suggestSlotFromLegs(legs, opts) {
        const o = opts || {}
        const originIata = AesRouteLauncherSlotFinder._iata(o.originIata)
        const dflt = o.defaultDepartureTime || AesRouteLauncherSlotFinder.FALLBACK
        const defaultMin = AesRouteLauncherSlotFinder._parseMin(dflt)
        const turn = Number.isFinite(o.turnaroundMin) ? o.turnaroundMin : 30
        const flightMin = Number.isFinite(o.flightMin) ? o.flightMin : 60
        const neededMin = Math.max(5, flightMin + Math.max(0, turn))
        const normalized = AesRouteLauncherSlotFinder._normaliseLegs(legs)
        if (!normalized.length) return dflt

        const windows = originIata
            ? AesRouteLauncherSlotFinder._hubWindows(normalized, originIata, turn)
            : AesRouteLauncherSlotFinder._openWindows(normalized)
        if (!windows.length) return null

        const ordered = AesRouteLauncherSlotFinder._orderedCandidateStarts(defaultMin)
        for (const start of ordered) {
            const h = Math.floor(start / 60)
            if (h < AesRouteLauncherSlotFinder.MIN_HOUR || h >= AesRouteLauncherSlotFinder.MAX_HOUR) continue
            for (const w of windows) {
                if (start < w.start || start + neededMin > w.end) continue
                return AesRouteLauncherSlotFinder._fmt(Math.floor(start / 60), start % 60)
            }
        }
        return null
    }

    static async _legsOf(server, aircraftId) {
        if (typeof window === "undefined") return []
        const out = []
        if (window.AesAfpScheduleStore) {
            try {
                const schedule = await window.AesAfpScheduleStore.load(server, aircraftId)
                if (schedule && Array.isArray(schedule.legs)) out.push(...schedule.legs)
            } catch (_) { /* fall through */ }
        }
        if (!window.AesAfpActiveDraftStore) return out
        try {
            const draft = await window.AesAfpActiveDraftStore.load(server, aircraftId)
            if (draft && Array.isArray(draft.flights)) out.push(...draft.flights)
        } catch (_) { /* fall through */ }
        return out
    }

    static _lastArrivalMin(legs, fallbackFlightMin) {
        let latest = null
        for (const f of legs) {
            const dep = AesRouteLauncherSlotFinder._parse(f.depTimeLocal || f.depTime)
            if (!dep) continue
            const dur = Number.isFinite(f.flightMin) ? f.flightMin
                      : Number.isFinite(f.blockMin)  ? f.blockMin
                      : fallbackFlightMin
            const arrMin = (dep.h * 60 + dep.m + dur) % (24 * 60)
            if (latest == null || arrMin > latest) latest = arrMin
        }
        return latest
    }

    static _clampToWindow(min, fallback) {
        const h = Math.floor(min / 60)
        const m = min % 60
        if (h < AesRouteLauncherSlotFinder.MIN_HOUR || h >= AesRouteLauncherSlotFinder.MAX_HOUR) {
            return fallback
        }
        return AesRouteLauncherSlotFinder._fmt(h, m)
    }

    static _parse(hhmm) {
        if (typeof hhmm !== "string") return null
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
        if (!m) return null
        const h = Number(m[1])
        const mm = Number(m[2])
        if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
        if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
        return {h, m: mm}
    }

    static _parseMin(hhmm) {
        const p = AesRouteLauncherSlotFinder._parse(hhmm)
        return p ? p.h * 60 + p.m : 9 * 60
    }

    static _fmt(h, m) {
        return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0")
    }

    static _iata(v) {
        const s = String(v || "").toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : null
    }

    static _normaliseLegs(legs) {
        const out = []
        for (const leg of Array.isArray(legs) ? legs : []) {
            const dep = AesRouteLauncherSlotFinder._parse(leg && (leg.depTimeLocal || leg.depTime))
            if (!dep) continue
            const depMin = dep.h * 60 + dep.m
            const durationMin = Number.isFinite(leg.durationMin) ? Number(leg.durationMin)
                : Number.isFinite(leg.blockMin) ? Number(leg.blockMin)
                : Number.isFinite(leg.flightMin) ? Number(leg.flightMin)
                : 60
            const dayIdx = Number.isFinite(leg.dayIdx) ? Number(leg.dayIdx) : null
            out.push({
                dayIdx,
                depMin,
                arrMin: depMin + Math.max(5, durationMin),
                origin: AesRouteLauncherSlotFinder._iata(leg.origin),
                destination: AesRouteLauncherSlotFinder._iata(leg.destination)
            })
        }
        return out
    }

    static _orderedCandidateStarts(defaultMin) {
        const step = AesRouteLauncherSlotFinder.STEP_MIN
        const out = []
        for (let i = 0; i < 24 * 60; i += step) {
            out.push((defaultMin + i) % (24 * 60))
        }
        return out
    }

    static _hubWindows(legs, hub, turn) {
        const hasDayData = legs.some(leg => Number.isFinite(leg.dayIdx))
        const byDay = new Map()
        for (const leg of legs) {
            const day = Number.isFinite(leg.dayIdx) ? ((leg.dayIdx % 7) + 7) % 7 : 0
            if (!byDay.has(day)) byDay.set(day, [])
            byDay.get(day).push(leg)
        }

        const buildForDay = (day) => {
            const windows = []
            const list = (byDay.get(day) || []).slice().sort((a, b) => a.depMin - b.depMin)
            if (!list.length) return [{start: 0, end: 24 * 60}]
            for (let i = 0; i < list.length; i++) {
                const current = list[i]
                if (i === 0 && current.origin === hub && current.depMin > 0) {
                    windows.push({start: 0, end: current.depMin})
                }
                if (current.destination !== hub) continue
                const start = (current.arrMin % (24 * 60)) + Math.max(0, turn)
                if (start >= 24 * 60) continue
                let end = 24 * 60
                for (let j = i + 1; j < list.length; j++) {
                    if (list[j].origin === hub && list[j].depMin >= start) {
                        end = list[j].depMin
                        break
                    }
                }
                if (end > start) windows.push({start, end})
            }
            return windows
        }

        if (!hasDayData) return buildForDay(0)

        let common = [{start: 0, end: 24 * 60}]
        for (let day = 0; day < 7; day++) {
            common = AesRouteLauncherSlotFinder._intersectWindows(common, buildForDay(day))
            if (!common.length) break
        }
        return common
    }

    static _openWindows(legs) {
        const intervals = []
        for (const leg of legs) {
            intervals.push({
                start: Math.max(0, leg.depMin),
                end: Math.min(24 * 60, leg.arrMin)
            })
        }
        intervals.sort((a, b) => a.start - b.start)
        const windows = []
        let cursor = 0
        for (const it of intervals) {
            if (it.start > cursor) windows.push({start: cursor, end: it.start})
            cursor = Math.max(cursor, it.end)
        }
        if (cursor < 24 * 60) windows.push({start: cursor, end: 24 * 60})
        return windows
    }

    static _intersectWindows(a, b) {
        const out = []
        for (const wa of a) {
            for (const wb of b) {
                const start = Math.max(wa.start, wb.start)
                const end = Math.min(wa.end, wb.end)
                if (end > start) out.push({start, end})
            }
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherSlotFinder = AesRouteLauncherSlotFinder
}
