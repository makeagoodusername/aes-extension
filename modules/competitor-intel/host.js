"use strict"

/**
 * Competitor Intel Hub — entry point.
 *
 * `AesCompetitorIntelHost.open(serverId?)` mounts the hub-shell modal,
 * loads server-scoped competitor data (enterprises, snapshots, edges, ORS,
 * own-fleet flight numbers), and hands it to the shell to render. The
 * shell owns the UI lifecycle; this module owns data discovery + the
 * single open() call.
 *
 * Servers are discovered by scanning `competitorIntel:enterprise:` keys —
 * any server with at least one cached enterprise shows up in the picker.
 * Defaults to the current page's server when present.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelHost) return

    const ENTERPRISE_PREFIX = "competitorIntel:enterprise:"
    const EDGE_PREFIX       = "competitorIntel:edge:"
    const ORS_LEGACY_PREFIX = "routeAssistant:ors:"
    const ORS_ACCT_PREFIX   = "routeAssistant:ors:acct:"

    async function discoverServers() {
        const all = await chrome.storage.local.get(null)
        const servers = new Set()
        for (const k in all) {
            if (!k.startsWith(ENTERPRISE_PREFIX)) continue
            const rest = k.slice(ENTERPRISE_PREFIX.length)
            const colon = rest.indexOf(":")
            if (colon > 0) servers.add(rest.slice(0, colon))
        }
        // Always include the current server so an empty cache still has a
        // valid picker entry.
        const current = currentServer()
        if (current) servers.add(current)
        return Array.from(servers).sort()
    }

    function currentServer() {
        try {
            if (typeof AES !== "undefined" && AES.getServerName) {
                return AES.getServerName() || null
            }
        } catch (_) {}
        return null
    }

    async function loadServerData(server) {
        if (!server) return _emptyData(server)
        const all = await chrome.storage.local.get(null)
        const enterprises = new Map()
        const snapshots   = new Map()
        const edges       = new Map()
        const orsRoutes   = new Map()

        const entPrefix = ENTERPRISE_PREFIX + server + ":"
        const edgPrefix = EDGE_PREFIX + server + ":"
        const snapPrefix = "competitorIntel:snapshots:" + server + ":"

        for (const k in all) {
            const v = all[k]
            if (!v || typeof v !== "object") continue
            if (k.startsWith(entPrefix)) {
                if (v.enterpriseId) enterprises.set(String(v.enterpriseId), v)
            } else if (k.startsWith(edgPrefix)) {
                const key = (v.hub && v.dest) ? (v.hub + "-" + v.dest) : k.slice(edgPrefix.length)
                edges.set(key, v)
            } else if (k.startsWith(snapPrefix)) {
                if (v.enterpriseId && Array.isArray(v.snapshots)) {
                    snapshots.set(String(v.enterpriseId), v.snapshots)
                }
            } else if (k.startsWith(ORS_ACCT_PREFIX) || k.startsWith(ORS_LEGACY_PREFIX)) {
                if (!v.hub || !v.dest) continue
                const key = String(v.hub).toUpperCase() + "-" + String(v.dest).toUpperCase()
                // Prefer the most recently scraped record per route; account-
                // scoped wins ties because it's the canonical post-L1 path.
                const prior = orsRoutes.get(key)
                const isAcct = k.startsWith(ORS_ACCT_PREFIX)
                if (!prior
                        || (isAcct && !prior._isAcct)
                        || ((v.scrapedAt || 0) > (prior.scrapedAt || 0))) {
                    orsRoutes.set(key, Object.assign({_isAcct: isAcct, _key: k}, v))
                }
            }
        }

        const ourHubs = await _resolveOurHubs(server)
        return {
            server, enterprises, snapshots, edges, orsRoutes, ourHubs,
            scannedAt: Date.now()
        }
    }

    async function _resolveOurHubs(server) {
        const set = new Set()
        try {
            const data = await chrome.storage.local.get(["settings"])
            const ra = data.settings && data.settings.routeAssistant
            if (ra && Array.isArray(ra.recentHubs)) {
                for (const h of ra.recentHubs) {
                    if (typeof h === "string" && /^[A-Z]{3}$/.test(h)) set.add(h)
                }
            }
        } catch (_) {}
        // Also include any hubs the current account's own enterprise records
        // expose via the contractual-partners cache (best-effort).
        try {
            const all = await chrome.storage.local.get(null)
            for (const k in all) {
                if (!k.startsWith("routeAssistant:ticketPrice")) continue
                const v = all[k]
                if (v && v.hub && /^[A-Z]{3}$/.test(String(v.hub).toUpperCase())) {
                    set.add(String(v.hub).toUpperCase())
                }
            }
        } catch (_) {}
        return set
    }

    function _emptyData(server) {
        return {
            server: server || null,
            enterprises: new Map(),
            snapshots:   new Map(),
            edges:       new Map(),
            orsRoutes:   new Map(),
            ourHubs:     new Set(),
            scannedAt:   Date.now()
        }
    }

    /**
     * Open the hub modal. Idempotent — calling while already open swaps
     * the active server if `serverId` differs.
     */
    async function open(serverId) {
        if (!window.AesCompetitorIntelShell) {
            console.warn("[AES competitor-intel] hub-shell not loaded")
            return
        }
        const servers = await discoverServers()
        const server = serverId || currentServer() || servers[0] || null
        const data = await loadServerData(server)
        const ctx = {
            server,
            servers,
            data,
            reload: async (nextServerId) => {
                const s = nextServerId || server
                const d = await loadServerData(s)
                return {server: s, data: d}
            }
        }
        window.AesCompetitorIntelShell.open(ctx)
    }

    window.AesCompetitorIntelHost = {
        open,
        discoverServers,
        loadServerData,
        currentServer
    }
})()
