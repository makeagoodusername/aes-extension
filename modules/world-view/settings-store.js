"use strict"

/**
 * WorldViewSettings — per-airline persisted state for the World View tile.
 *
 * Key: worldView:settings:<airline>. Sister airlines on the same server
 * each get their own focused-hub memory; mirrors RouteAssistantSettings
 * scoping. Keyed without server because we always know the airline code
 * and AS keeps airline codes globally unique.
 *
 * Shape:
 *   {focusedHub, viewMode, expandedSubpanes, lastFocusedAt}
 *
 * Settings are read on every tile refresh; never cached in tile instance
 * vars, so a second tab editing the same airline reflects immediately.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewSettings) return

    const PREFIX = "worldView:settings"

    function _key(airline) {
        const a = (airline || "_default").toString().trim().toLowerCase()
        return PREFIX + ":" + a
    }

    function _defaults() {
        return {
            focusedHub: null,
            viewMode: "single",            // future: "compare" for W5 split
            expandedSubpanes: {            // collapse-state per subpane
                map: true, wave: true, treemap: true, recommendations: true
            },
            lastFocusedAt: 0
        }
    }

    function _merge(persisted) {
        const d = _defaults()
        if (!persisted || typeof persisted !== "object") return d
        return Object.assign({}, d, persisted, {
            expandedSubpanes: Object.assign({}, d.expandedSubpanes, persisted.expandedSubpanes || {})
        })
    }

    const WorldViewSettings = {
        async load(airline) {
            const k = _key(airline)
            const out = await chrome.storage.local.get([k])
            return _merge(out[k])
        },

        async save(airline, settings) {
            const k = _key(airline)
            const merged = _merge(settings)
            await chrome.storage.local.set({[k]: merged})
            return merged
        },

        async patch(airline, partial) {
            const cur = await this.load(airline)
            const next = Object.assign({}, cur, partial)
            if (partial && partial.expandedSubpanes) {
                next.expandedSubpanes = Object.assign({}, cur.expandedSubpanes, partial.expandedSubpanes)
            }
            return this.save(airline, next)
        },

        keyFor(airline) { return _key(airline) },
        prefix() { return PREFIX }
    }

    window.WorldViewSettings = WorldViewSettings
})()
