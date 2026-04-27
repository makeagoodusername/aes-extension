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

    static register(spec) {
        if (!spec || !spec.id || !spec.section || typeof spec.factory !== "function") {
            console.warn("[AES Hub] invalid tile registration", spec)
            return
        }
        const idx = this._tiles.findIndex(t => t.id === spec.id)
        if (idx >= 0) { this._tiles[idx] = spec; return }
        this._tiles.push(spec)
    }

    static all() {
        return this._tiles.slice().sort((a, b) =>
            (a.priority || 100) - (b.priority || 100)
        )
    }

    static forSection(section) {
        return this.all().filter(t => t.section === section)
    }
}

if (typeof window !== "undefined") {
    window.CentralHubTileRegistry = CentralHubTileRegistry
}
