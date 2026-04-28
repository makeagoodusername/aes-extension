"use strict"

/**
 * Route Launcher — append-only log of one-click flight creations.
 *
 * One record per submission at:
 *   chrome.storage.local["routeLauncher:log:<server>:<id>"]
 *
 * Record shape:
 *   {id, ts, server, airline, aircraftId, registration, hub, dest,
 *    depTime, pricePct, service, status, error?, durationMs?, retries?}
 *
 * status ∈ "queued" | "in-flight" | "created" | "failed"
 *
 * The status feed reads back via list() (sorted desc by ts, capped to N).
 * trim() drops everything older than KEEP_MAX so the log doesn't grow
 * unbounded.
 */
class AesRouteLauncherLog {
    static PREFIX   = "routeLauncher:log:"
    static KEEP_MAX = 200

    static _key(server, id) {
        return AesRouteLauncherLog.PREFIX + String(server || "") + ":" + String(id || "")
    }

    static newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }

    static async append(record) {
        if (!record || !record.server) return null
        const id = record.id || AesRouteLauncherLog.newId()
        const next = Object.assign({}, record, {id, ts: record.ts || Date.now()})
        const key = AesRouteLauncherLog._key(record.server, id)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    static async update(server, id, patch) {
        if (!server || !id || !patch) return null
        const key = AesRouteLauncherLog._key(server, id)
        const out = await chrome.storage.local.get([key])
        const cur = out[key]
        if (!cur || typeof cur !== "object") return null
        const next = Object.assign({}, cur, patch)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    static async list(server, limit) {
        if (!server) return []
        const all = await chrome.storage.local.get(null)
        const prefix = AesRouteLauncherLog.PREFIX + String(server) + ":"
        const out = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (rec && typeof rec === "object") out.push(rec)
        }
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
        return (limit && limit > 0) ? out.slice(0, limit) : out
    }

    static async trim(server) {
        if (!server) return
        const all = await chrome.storage.local.get(null)
        const prefix = AesRouteLauncherLog.PREFIX + String(server) + ":"
        const keys = Object.keys(all).filter(k => k.indexOf(prefix) === 0)
        if (keys.length <= AesRouteLauncherLog.KEEP_MAX) return
        const recs = keys.map(k => ({k, ts: (all[k] && all[k].ts) || 0}))
        recs.sort((a, b) => b.ts - a.ts)
        const drop = recs.slice(AesRouteLauncherLog.KEEP_MAX).map(r => r.k)
        if (drop.length) await chrome.storage.local.remove(drop)
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherLog = AesRouteLauncherLog
}
