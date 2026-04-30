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
        host.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:8px;font-size:11px;"

        const breakdown = [
            ["companies",     "Enterprises", counts.enterprises],
            ["routes",        "Edges",       counts.edges],
            ["ors",           "ORS routes",  counts.orsRoutes],
            ["change-log",    "Changes · 7d",counts.recentDiffs]
        ]
        for (const [tab, label, n] of breakdown) {
            const row = document.createElement("button")
            row.type = "button"
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
                + "padding:5px 8px;background:transparent;border:1px solid var(--aes-paper-rule);"
                + "border-radius:3px;cursor:pointer;font-size:11px;color:var(--aes-oxide);"
                + "font-family:inherit;text-align:left;"
            row.innerHTML = `<span>${label}</span><span style="font-family:ui-monospace,monospace;color:var(--aes-cobalt);">${n}</span>`
            row.addEventListener("click", () => {
                if (tab === "change-log") {
                    if (window.AesChangeLogModal && typeof window.AesChangeLogModal.open === "function") {
                        window.AesChangeLogModal.open({initialDomains: ["competitor-intel"]})
                    }
                } else if (window.AesCompetitorIntelHost
                        && typeof window.AesCompetitorIntelHost.open === "function") {
                    window.AesCompetitorIntelHost.open()
                }
            })
            host.append(row)
        }

        // F-DASH-502 — utility actions: watchlist preview + bulk refresh.
        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;"

        const wlBtn = this._makeActionBtn("Show watchlist (top 5)")
        wlBtn.addEventListener("click", () => this._renderWatchlist(host, ctx))
        actions.append(wlBtn)

        const drillBtn = this._makeActionBtn("Drilldown enterprises →")
        drillBtn.addEventListener("click", () => {
            if (window.AesCompetitorIntelHost
                    && typeof window.AesCompetitorIntelHost.open === "function") {
                window.AesCompetitorIntelHost.open()
            }
        })
        actions.append(drillBtn)

        const scanBtn = this._makeActionBtn("Refresh stale enterprises")
        const runnerAvail = !!(window.AesCompetitorOutlineRunner
            && typeof window.AesCompetitorOutlineRunner.runForServer === "function")
        scanBtn.disabled = !runnerAvail
        if (!runnerAvail) {
            scanBtn.title = "Outline runner not loaded — visit a competitor page to scrape."
        }
        scanBtn.addEventListener("click", async () => {
            const server = (this.ctx && this.ctx.server) || ""
            if (!server || !runnerAvail) return
            scanBtn.disabled = true
            const orig = scanBtn.textContent
            scanBtn.textContent = "Scanning…"
            try {
                const res = await window.AesCompetitorOutlineRunner.runForServer({server})
                scanBtn.textContent = res && res.success
                    ? "Refreshed " + (res.refreshed || 0)
                    : "Scan failed"
            } catch (e) {
                console.warn("[AES competitor-intel-hub] bulk scan failed", e)
                scanBtn.textContent = "Scan failed"
            }
            setTimeout(() => {
                scanBtn.textContent = orig
                scanBtn.disabled = false
                this.refresh().catch(() => {})
            }, 2500)
        })
        actions.append(scanBtn)
        host.append(actions)

        const note = document.createElement("div")
        note.style.cssText = "margin-top:4px;color:var(--aes-slate);font-size:10px;line-height:1.4;"
        note.textContent = "Rows open the hub on that tab. The change log shows snapshot-to-snapshot diffs across all cached competitors. The bulk scan refreshes only enterprises past the deep TTL."
        host.append(note)
    }

    _makeActionBtn(label) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.style.cssText = "padding:4px 10px;background:var(--aes-bone-2,transparent);"
            + "color:var(--aes-oxide);border:1px solid var(--aes-oxide);"
            + "border-radius:3px;cursor:pointer;font-size:11px;font-family:inherit;"
        return b
    }

    async _renderWatchlist(host, ctx) {
        const old = host.querySelector("[data-aes-watchlist]")
        if (old) old.remove()
        const wrap = document.createElement("div")
        wrap.dataset.aesWatchlist = "1"
        wrap.style.cssText = "margin-top:4px;padding:6px 8px;border:1px solid var(--aes-paper-rule);"
            + "border-radius:3px;font-size:11px;background:var(--aes-bone-2,transparent);"
        const heading = document.createElement("div")
        heading.style.cssText = "font-weight:600;margin-bottom:4px;color:var(--aes-oxide);"
        heading.textContent = "Watchlist · top threats"
        wrap.append(heading)
        if (!window.AesCompetitorWatchlist
                || typeof window.AesCompetitorWatchlist.derive !== "function") {
            const p = document.createElement("div")
            p.style.cssText = "color:var(--aes-slate);"
            p.textContent = "Watchlist module not loaded."
            wrap.append(p)
            host.append(wrap)
            return
        }
        const server = (ctx && ctx.server) || (this.ctx && this.ctx.server) || ""
        if (!server) {
            const p = document.createElement("div")
            p.style.cssText = "color:var(--aes-slate);"
            p.textContent = "Server context unavailable."
            wrap.append(p)
            host.append(wrap)
            return
        }
        try {
            // AesCompetitorWatchlist.derive() returns an Array directly
            // (see modules/competitor-intel/watchlist.js:38–93) — earlier
            // code expected `{items: [...]}`; that shape never shipped.
            const ranked = await window.AesCompetitorWatchlist.derive({server})
            const items = Array.isArray(ranked) ? ranked : []
            if (!items.length) {
                const p = document.createElement("div")
                p.style.cssText = "color:var(--aes-slate);"
                p.textContent = "No competitors cached yet — open one to seed."
                wrap.append(p)
            } else {
                for (const it of items.slice(0, 5)) {
                    const row = document.createElement("div")
                    row.style.cssText = "display:flex;justify-content:space-between;gap:6px;padding:2px 0;"
                    const left = document.createElement("span")
                    left.style.cssText = "color:var(--aes-oxide);"
                    left.textContent = (it.code ? "[" + it.code + "] " : "") + (it.name || it.id)
                    const right = document.createElement("span")
                    right.style.cssText = "font-family:ui-monospace,monospace;color:var(--aes-cobalt);"
                    right.textContent = "score " + (it.score != null ? it.score.toFixed(2) : "?")
                    row.append(left, right)
                    wrap.append(row)
                }
            }
        } catch (e) {
            console.warn("[AES competitor-intel-hub] watchlist derive failed", e)
            const p = document.createElement("div")
            p.style.cssText = "color:var(--aes-slate);"
            p.textContent = "Watchlist derive failed — see console."
            wrap.append(p)
        }
        host.append(wrap)
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
