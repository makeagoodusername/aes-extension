"use strict"

/**
 * CentralHubTileRegistry — static registry of tile factories.
 *
 * Tile modules call register() at load time. The shell asks the registry
 * for tiles per section, instantiates each via factory(), and mounts them.
 *
 * Registration spec:
 *   {
 *     id:       string  // unique
 *     section:  "fleet" | "routes" | "finance" | "tools"
 *     priority: number  // sort within section, lower first (default 100)
 *     factory:  () => CentralHubTile
 *   }
 *
 * Re-registering the same id replaces the previous entry — useful for
 * hot-reload during dev, harmless in production.
 */
class CentralHubTileRegistry {
    static _tiles = []
    static _subscribers = new Set()

    static register(spec) {
        if (!spec || !spec.id || !spec.section || typeof spec.factory !== "function") {
            console.warn("[AES Hub] invalid tile registration", spec)
            return () => {}
        }
        spec = this._normalizeSpec(spec)
        const idx = this._tiles.findIndex(t => t.id === spec.id)
        const prev = idx >= 0 ? this._tiles[idx] : null
        if (idx >= 0) this._tiles[idx] = spec
        else this._tiles.push(spec)
        this._notify(prev ? "updated" : "registered", spec, prev)
        return () => {
            const curIdx = this._tiles.findIndex(t => t.id === spec.id)
            if (curIdx < 0 || this._tiles[curIdx] !== spec) return
            const removed = this._tiles.splice(curIdx, 1)[0]
            this._notify("unregistered", removed, null)
        }
    }

    static all() {
        return this._tiles.slice().sort((a, b) =>
            (a.priority || 100) - (b.priority || 100)
        )
    }

    static get(id) {
        return this._tiles.find(t => t.id === id) || null
    }

    static forSection(section) {
        return this.all().filter(t => t.section === section)
    }

    static subscribe(fn) {
        if (typeof fn !== "function") return () => {}
        this._subscribers.add(fn)
        return () => this._subscribers.delete(fn)
    }

    static summary() {
        return this.all().map(t => ({
            id:       t.id,
            section:  t.section,
            priority: typeof t.priority === "number" && isFinite(t.priority) ? t.priority : 100,
            topics:   Array.isArray(t.topics) ? t.topics.slice() : (t.section ? [t.section] : []),
            cardKind: t.cardKind || "regular"
        }))
    }

    static _normalizeSpec(spec) {
        const priority = Number(spec.priority)
        return Object.assign({}, spec, {
            id:       String(spec.id),
            section:  String(spec.section),
            priority: Number.isFinite(priority) ? priority : 100,
            topics:   Array.isArray(spec.topics)
                ? spec.topics.filter(t => typeof t === "string" && t)
                : undefined
        })
    }

    static _notify(kind, spec, previous) {
        const event = {kind, spec, previous}
        for (const fn of Array.from(this._subscribers)) {
            try { fn(event) }
            catch (err) { console.warn("[AES Hub] tile registry subscriber threw", err) }
        }
        if (typeof window !== "undefined" && window.CentralHubBus
                && typeof window.CentralHubBus.emit === "function") {
            window.CentralHubBus.emit("tile-registered", {
                kind,
                tileId: spec && spec.id,
                section: spec && spec.section,
                priority: spec && spec.priority
            })
        }
    }
}

if (typeof window !== "undefined") {
    window.CentralHubTileRegistry = CentralHubTileRegistry
}
