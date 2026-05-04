"use strict"

/**
 * Per-airline hub-management preferences for the Fleet Command Center:
 * which hubs the user has deleted from the local view and any custom display
 * labels. The persisted field is still named hiddenHubs for compatibility
 * with older builds.
 *
 *   fleetHub:hubManagement:<server>:<airlineCode> →
 *     {server, airlineCode,
 *      hiddenHubs: ["LHR", ...],          // IATA list, suppressed locally
 *      labels:     { CVG: "Cincinnati Ops" },
 *      updatedAt:  number}
 *
 * Deleted hubs disappear from the hub grid; their aircraft fall into
 * UNASSIGNED until the user restores them. Labels are display-only — the
 * IATA remains the canonical identifier for every store keyed by hub.
 */
class FleetHubHubManagement {
    static PREFIX = "fleetHub:hubManagement:"

    static _key(server, airlineCode) {
        return FleetHubHubManagement.PREFIX
            + String(server || "")
            + ":"
            + String(airlineCode || "")
    }

    static keyFor(server, airlineCode) {
        return FleetHubHubManagement._key(server, airlineCode)
    }

    static _empty(server, airlineCode) {
        return {
            server:      String(server || ""),
            airlineCode: String(airlineCode || ""),
            hiddenHubs:  [],
            labels:      {},
            updatedAt:   null
        }
    }

    static async load(server, airlineCode) {
        const empty = FleetHubHubManagement._empty(server, airlineCode)
        if (!server || !airlineCode) return empty
        const key = FleetHubHubManagement._key(server, airlineCode)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") return empty
        const hiddenHubs = Array.isArray(rec.hiddenHubs)
            ? Array.from(new Set(rec.hiddenHubs
                .filter(s => typeof s === "string" && s)
                .map(s => s.toUpperCase())))
            : []
        const labels = (rec.labels && typeof rec.labels === "object" && !Array.isArray(rec.labels))
            ? Object.fromEntries(Object.entries(rec.labels)
                .filter(([k, v]) => typeof k === "string" && k && typeof v === "string" && v)
                .map(([k, v]) => [k.toUpperCase(), v]))
            : {}
        return {
            server:      rec.server      || empty.server,
            airlineCode: rec.airlineCode || empty.airlineCode,
            hiddenHubs,
            labels,
            updatedAt:   typeof rec.updatedAt === "number" && isFinite(rec.updatedAt) ? rec.updatedAt : null
        }
    }

    static async _save(server, airlineCode, patch) {
        if (!server || !airlineCode) return null
        const existing = await FleetHubHubManagement.load(server, airlineCode)
        const next = {
            ...existing,
            ...patch,
            server, airlineCode,
            updatedAt: Date.now()
        }
        const key = FleetHubHubManagement._key(server, airlineCode)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    static async hide(server, airlineCode, iata) {
        const norm = String(iata || "").toUpperCase()
        if (!norm) return null
        const cur = await FleetHubHubManagement.load(server, airlineCode)
        if (cur.hiddenHubs.includes(norm)) return cur
        return FleetHubHubManagement._save(server, airlineCode, {
            hiddenHubs: cur.hiddenHubs.concat([norm])
        })
    }

    /**
     * User-facing delete action for Fleet Command Center hub cards.
     * This is intentionally a local UI deletion: AirlineSim data, saved
     * schedules, presets, and aircraft locations stay untouched. The hub is
     * suppressed until restored, and any display label is cleared so a future
     * restore starts from the canonical IATA.
     */
    static async deleteHub(server, airlineCode, iata) {
        const norm = String(iata || "").toUpperCase()
        if (!norm) return null
        const cur = await FleetHubHubManagement.load(server, airlineCode)
        const labels = {...cur.labels}
        delete labels[norm]
        const hiddenHubs = cur.hiddenHubs.includes(norm)
            ? cur.hiddenHubs.slice()
            : cur.hiddenHubs.concat([norm])
        return FleetHubHubManagement._save(server, airlineCode, {hiddenHubs, labels})
    }

    static async unhide(server, airlineCode, iata) {
        const norm = String(iata || "").toUpperCase()
        if (!norm) return null
        const cur = await FleetHubHubManagement.load(server, airlineCode)
        if (!cur.hiddenHubs.includes(norm)) return cur
        return FleetHubHubManagement._save(server, airlineCode, {
            hiddenHubs: cur.hiddenHubs.filter(h => h !== norm)
        })
    }

    static async setLabel(server, airlineCode, iata, label) {
        const norm = String(iata || "").toUpperCase()
        if (!norm) return null
        const cur = await FleetHubHubManagement.load(server, airlineCode)
        const trimmed = String(label || "").trim()
        const labels = {...cur.labels}
        if (trimmed) labels[norm] = trimmed
        else delete labels[norm]
        return FleetHubHubManagement._save(server, airlineCode, {labels})
    }
}

if (typeof window !== "undefined") {
    window.FleetHubHubManagement = FleetHubHubManagement
}
