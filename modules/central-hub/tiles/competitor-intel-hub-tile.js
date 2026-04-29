"use strict"

/**
 * Competitor Intel Hub tile.
 *
 * At-a-glance: number of cached enterprises on this server, plus a
 * recent-diff count (events from the last 7 days). "Open" launches
 * the full hub modal via `AesCompetitorIntelHost.open()`.
 *
 * Body: brief breakdown — companies / routes / ORS / change events.
 * Click row in the body opens the hub on the corresponding tab.
 */
class CentralHubCompetitorIntelHubTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "competitor-intel-hub"
        this.title = "Competitor Hub"
        this.section = "routes"
        this.priority = 45
        this.requiresAirline = false
    }

    watchedStorageKeys() {
        return ["competitorIntel:"]
    }

    openHandler() {
        return () => {
            if (window.AesCompetitorIntelHost) {
                window.AesCompetitorIntelHost.open()
            }
        }
    }

    async _scanServer() {
        const server = (this.ctx && this.ctx.server) || ""
        const all = await chrome.storage.local.get(null)
        const counts = {enterprises: 0, edges: 0, orsRoutes: 0, recentDiffs: 0}
        const sevenDaysAgo = Date.now() - 7 * 86400000
        const entPrefix = "competitorIntel:enterprise:" + (server ? server + ":" : "")
        const edgPrefix = "competitorIntel:edge:" + (server ? server + ":" : "")
        const snapPrefix = "competitorIntel:snapshots:" + (server ? server + ":" : "")
        const orsAcct   = "routeAssistant:ors:acct:"
        const orsLegacy = "routeAssistant:ors:"

        for (const k in all) {
            const v = all[k]
            if (!v) continue
            if (k.startsWith(entPrefix)) counts.enterprises++
            else if (k.startsWith(edgPrefix)) counts.edges++
            else if (k.startsWith(snapPrefix) && Array.isArray(v.snapshots) && window.AesCompetitorDiff) {
                const snaps = v.snapshots
                for (let i = 1; i < snaps.length; i++) {
                    const curr = snaps[i]
                    if (!curr || curr.at < sevenDaysAgo) continue
                    const evs = window.AesCompetitorDiff.compare(snaps[i - 1], curr)
                    counts.recentDiffs += (evs && evs.length) || 0
                }
            }
            else if (k.startsWith(orsAcct) || k.startsWith(orsLegacy)) {
                if (v.hub && v.dest) counts.orsRoutes++
            }
        }
        return counts
    }

    async loadStatus() {
        const counts = await this._scanServer()
        this._lastCounts = counts
        const KIND = window.CentralHubStatusBadges.KIND
        if (counts.enterprises === 0 && counts.edges === 0) {
            return {
                badge:     "0",
                badgeKind: KIND.MUTED,
                summary:   "No competitor data cached yet — visit a markets page or run the bulk scan."
            }
        }
        const recentTxt = counts.recentDiffs > 0
            ? counts.recentDiffs + " change" + (counts.recentDiffs === 1 ? "" : "s") + " · 7d"
            : "no recent changes"
        return {
            badge:     String(counts.enterprises),
            badgeKind: counts.recentDiffs > 0 ? KIND.INFO : KIND.DEFAULT,
            summary:   counts.enterprises + " enterprises · " + counts.edges + " edges · " + recentTxt
        }
    }

    async renderBody(ctx, host) {
        host.innerHTML = ""
        const counts = this._lastCounts || await this._scanServer()
        host.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:6px;font-size:11px;"

        const breakdown = [
            ["companies",     "Enterprises", counts.enterprises],
            ["routes",        "Edges",       counts.edges],
            ["ors",           "ORS routes",  counts.orsRoutes],
            ["change-log",    "Changes · 7d",counts.recentDiffs]
        ]
        for (const [tab, label, n] of breakdown) {
            const row = document.createElement("button")
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
                + "padding:5px 8px;background:transparent;border:1px solid var(--aes-paper-rule);"
                + "border-radius:3px;cursor:pointer;font-size:11px;color:var(--aes-oxide);"
                + "font-family:inherit;text-align:left;"
            row.innerHTML = `<span>${label}</span><span style="font-family:ui-monospace,monospace;color:var(--aes-cobalt);">${n}</span>`
            row.addEventListener("click", () => {
                if (tab === "change-log") {
                    if (window.AesChangeLogModal) {
                        window.AesChangeLogModal.open({initialDomains: ["competitor-intel"]})
                    }
                } else if (window.AesCompetitorIntelHost) {
                    window.AesCompetitorIntelHost.open()
                }
            })
            host.append(row)
        }

        const note = document.createElement("div")
        note.style.cssText = "margin-top:4px;color:var(--aes-slate);font-size:10px;line-height:1.4;"
        note.textContent = "Click a row to open the hub on that tab. The change log shows snapshot-to-snapshot diffs across all cached competitors."
        host.append(note)
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "competitor-intel-hub",
        section:  "routes",
        priority: 45,
        factory:  () => new CentralHubCompetitorIntelHubTile()
    })
}
