"use strict"

/**
 * AesConductorRoutineStore — storage-backed registry of active and recent
 * routine instances. A routine instance is a stateful, multi-step playbook
 * spawned by a scenario fire and advancing through states as further
 * signals/scenarios land.
 *
 * Storage:
 *   aesConductor:routines:<server>:<airline>  → Instance[]
 *
 * Cap 100 total instances (active + completed + expired). Eviction order
 * on cap: completed/expired first, then oldest active.
 *
 * Instance shape:
 *   {
 *     instanceId:   "<spawnedAt>-<counter>",
 *     routineDefId: "MaintenanceRebalance",
 *     target:       "FGM007",
 *     state:        "observing",
 *     spawnedAt:    1735000000000,
 *     lastEventAt:  1735000000000,
 *     completedAt:  null,
 *     history:      [{at, from, to, reason}],
 *     scratch:      {fireCount: 1, ...}    // routine-specific working memory
 *   }
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorRoutineStore) return

    const PREFIX = "aesConductor:routines:"
    const CAP    = 100

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    async function _read(key) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return []
        try {
            const blob = await chrome.storage.local.get([key])
            const arr = blob && blob[key]
            return Array.isArray(arr) ? arr : []
        } catch (_) { return [] }
    }

    async function _write(key, arr) {
        if (!key) return
        if (arr.length > CAP) {
            const completed = []
            const active    = []
            for (const i of arr) {
                if (i && (i.state === "completed" || i.state === "expired")) completed.push(i)
                else                                                          active.push(i)
            }
            completed.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
            active.sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0))
            const trimmed = []
            const overflow = arr.length - CAP
            const dropped  = []
            while (dropped.length < overflow && completed.length) dropped.push(completed.shift())
            while (dropped.length < overflow && active.length)    dropped.push(active.shift())
            for (const i of arr) if (!dropped.includes(i)) trimmed.push(i)
            arr = trimmed
        }
        try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
    }

    /**
     * H-004 — Tail-Promise queue per storage key. Serializes read-modify-write
     * mutators (append/update/clear) so two concurrent callers cannot both
     * read the same baseline array and have the second clobber the first's
     * write. Pure reads (all/active/findActive) skip the queue.
     */
    const _tails = Object.create(null)
    function _enqueue(key, work) {
        const prev = _tails[key] || Promise.resolve()
        const next = prev.then(work, work)
        _tails[key] = next.catch(() => { /* drop chain errors */ })
        return next
    }

    async function all(host) {
        return await _read(_key(host))
    }

    async function active(host) {
        const arr = await _read(_key(host))
        return arr.filter(i => i && i.state !== "completed" && i.state !== "expired")
    }

    async function findActive(host, routineDefId, target) {
        const arr = await active(host)
        return arr.find(i => i.routineDefId === routineDefId && i.target === target) || null
    }

    async function append(host, instance) {
        const key = _key(host)
        if (!key || !instance) return
        return _enqueue(key, async () => {
            const arr = await _read(key)
            arr.push(instance)
            await _write(key, arr)
        })
    }

    async function update(host, instance) {
        const key = _key(host)
        if (!key || !instance) return
        return _enqueue(key, async () => {
            const arr = await _read(key)
            const idx = arr.findIndex(i => i && i.instanceId === instance.instanceId)
            if (idx < 0) arr.push(instance)
            else         arr[idx] = instance
            await _write(key, arr)
        })
    }

    async function clear(host) {
        const key = _key(host)
        if (!key) return
        return _enqueue(key, async () => {
            try { await chrome.storage.local.set({[key]: []}) } catch (_) { /* noop */ }
        })
    }

    window.AesConductorRoutineStore = {all, active, findActive, append, update, clear, PREFIX, CAP}
})()
