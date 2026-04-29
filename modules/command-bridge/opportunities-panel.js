"use strict"

/**
 * Command Bridge slice CB-3 — cross-account opportunities pane.
 *
 * Reads AesStrategyPortfolio.scanAll() — already an existing aggregator
 * over registered accounts + persisted fleet rosters + cached schedules
 * — and renders one card per server with three slices:
 *
 *   - Sister inventory: airlines on this server, fleet count + last
 *     scrape age, sorted by activity.
 *   - Shared hubs: IATA codes flown out of by 2+ sisters (overlap is
 *     where joint pricing / shared interline tends to matter).
 *   - Overlapping routes: ORIG-DEST pairs flown by 2+ sisters, with
 *     per-airline weekly leg counts when available.
 *
 * All read-only. The portfolio scanner is pure over storage; mounting
 * this surface won't trigger any AS POST or scrape.
 *
 * Rendered cold: when scanAll() yields no servers (no fleet rosters
 * scraped yet, fresh install, etc) the pane shows a guidance card
 * pointing the user at the standard scrape flow on the AS dashboard.
 */
class AesBridgeOpportunitiesPanel {
    constructor(opts) {
        this.host = (opts && opts.host) || null
        this._dispose = null
    }

    async mount() {
        if (!this.host) return
        if (typeof window.AesStrategyPortfolio === "undefined") {
            this._renderUnavailable()
            return
        }
        await this._refresh()
        const handler = (changes, area) => {
            if (area !== "local") return
            // The portfolio reads many keys; cheap heuristic — refresh on
            // any aesStrategy:*, fleet roster, or schedule store write.
            let dirty = false
            for (const k in changes) {
                if (k.indexOf("aesStrategy") === 0) { dirty = true; break }
                if (k.indexOf("aesFleetRoster") === 0) { dirty = true; break }
                if (k.indexOf("aesAfp:schedule") === 0) { dirty = true; break }
                if (k === "aesAccounts") { dirty = true; break }
            }
            if (!dirty) return
            this._refresh().catch(() => {})
        }
        chrome.storage.onChanged.addListener(handler)
        this._dispose = () => {
            try { chrome.storage.onChanged.removeListener(handler) } catch (_) { /* noop */ }
        }
    }

    dispose() {
        if (typeof this._dispose === "function") {
            try { this._dispose() } catch (_) { /* noop */ }
            this._dispose = null
        }
    }

    _renderUnavailable() {
        this.host.innerHTML = ""
        const stub = document.createElement("div")
        stub.className = "aes-bridge__stub"
        stub.innerHTML = '<strong>Cross-account opportunities</strong>AesStrategyPortfolio is not loaded — the bridge.html page does not currently load <code>modules/strategy/portfolio.js</code> and its dependencies. This pane lights up once the bridge bundle is extended.'
        this.host.appendChild(stub)
    }

    async _refresh() {
        let map
        try { map = await window.AesStrategyPortfolio.scanAll() }
        catch (e) {
            this._renderError(e)
            return
        }
        this._render(map)
    }

    _renderError(e) {
        this.host.innerHTML = ""
        const head = document.createElement("div")
        head.className = "aes-bridge__section-head"
        const h = document.createElement("h2")
        h.className = "aes-bridge__h2"
        h.textContent = "Cross-account opportunities"
        head.appendChild(h)
        this.host.appendChild(head)
        const stub = document.createElement("div")
        stub.className = "aes-bridge__stub"
        stub.textContent = "Scan failed: " + (e && e.message ? e.message : String(e))
        this.host.appendChild(stub)
    }

    _render(servers) {
        this.host.innerHTML = ""
        const head = document.createElement("div")
        head.className = "aes-bridge__section-head"
        const h = document.createElement("h2")
        h.className = "aes-bridge__h2"
        h.textContent = "Cross-account opportunities"
        head.appendChild(h)
        const counter = document.createElement("span")
        counter.className = "aes-bridge__counter"
        const serverCount = servers ? servers.size : 0
        counter.textContent = serverCount + " " + (serverCount === 1 ? "server" : "servers")
        head.appendChild(counter)
        this.host.appendChild(head)

        if (!servers || !servers.size) {
            const empty = document.createElement("div")
            empty.className = "aes-bridge__stub"
            empty.innerHTML = '<strong>No portfolio data yet</strong>Open AS, run "Scrape everything" from the dashboard hub for each server. Fleet rosters and schedules cache locally; this pane reads them — no network on the bridge side.'
            this.host.appendChild(empty)
            return
        }

        const grid = document.createElement("div")
        grid.className = "aes-bridge__opps-grid"
        const sortedServers = Array.from(servers.entries()).sort((a, b) => {
            const an = (a[1] && a[1].airlines && a[1].airlines.length) || 0
            const bn = (b[1] && b[1].airlines && b[1].airlines.length) || 0
            return bn - an || (a[0] < b[0] ? -1 : 1)
        })
        for (const [server, blob] of sortedServers) {
            grid.appendChild(this._buildServerCard(server, blob))
        }
        this.host.appendChild(grid)
    }

    _buildServerCard(server, blob) {
        const card = document.createElement("article")
        card.className = "aes-bridge__opps-card"

        const head = document.createElement("header")
        head.className = "aes-bridge__opps-card-head"
        const title = document.createElement("h3")
        title.className = "aes-bridge__h3"
        title.textContent = String(server || "?").toUpperCase()
        head.appendChild(title)
        const tally = document.createElement("span")
        tally.className = "aes-bridge__counter"
        const a = (blob.airlines || []).length
        const oh = (blob.overlapHubs || []).length
        const orx = (blob.overlapRoutes || []).length
        tally.textContent = a + " sister" + (a === 1 ? "" : "s")
            + " · " + oh + " shared hub" + (oh === 1 ? "" : "s")
            + " · " + orx + " shared route" + (orx === 1 ? "" : "s")
        head.appendChild(tally)
        card.appendChild(head)

        // Airlines list
        if ((blob.airlines || []).length) {
            const sub = document.createElement("h4")
            sub.className = "aes-bridge__opps-sub"
            sub.textContent = "Sisters"
            card.appendChild(sub)
            const list = document.createElement("ul")
            list.className = "aes-bridge__opps-list"
            for (const a of blob.airlines) list.appendChild(this._buildAirlineRow(a))
            card.appendChild(list)
        }

        // Shared hubs
        if ((blob.overlapHubs || []).length) {
            const sub = document.createElement("h4")
            sub.className = "aes-bridge__opps-sub"
            sub.textContent = "Shared hubs"
            card.appendChild(sub)
            const chips = document.createElement("div")
            chips.className = "aes-bridge__opps-chips"
            for (const h of blob.overlapHubs) {
                const c = document.createElement("span")
                c.className = "aes-bridge__opps-chip"
                c.textContent = h.iata + " · " + h.airlines.length + " sisters"
                c.title = h.airlines.join(" · ")
                chips.appendChild(c)
            }
            card.appendChild(chips)
        }

        // Overlapping routes (cap shown at 12; full count in tally)
        if ((blob.overlapRoutes || []).length) {
            const sub = document.createElement("h4")
            sub.className = "aes-bridge__opps-sub"
            sub.textContent = "Overlap routes"
            card.appendChild(sub)
            const list = document.createElement("ul")
            list.className = "aes-bridge__opps-list"
            const capped = blob.overlapRoutes.slice(0, 12)
            for (const r of capped) list.appendChild(this._buildRouteRow(r))
            if (blob.overlapRoutes.length > capped.length) {
                const more = document.createElement("p")
                more.className = "aes-bridge__hint"
                more.textContent = "+" + (blob.overlapRoutes.length - capped.length) + " more"
                card.appendChild(more)
            }
            card.appendChild(list)
        }

        return card
    }

    _buildAirlineRow(a) {
        const li = document.createElement("li")
        li.className = "aes-bridge__opps-row"
        const name = document.createElement("a")
        name.href = "https://" + a.server + ".airlinesim.aero/app/enterprise/dashboard"
        name.target = "_blank"
        name.rel = "noreferrer noopener"
        name.className = "aes-bridge__opps-row-name"
        name.textContent = a.displayName || a.airline || a.accountId
        const meta = document.createElement("span")
        meta.className = "aes-bridge__opps-row-meta"
        const lastScrape = a.lastScrape ? AesBridgeOpportunitiesPanel._fmtAge(a.lastScrape) : "no scrape"
        meta.textContent = a.fleetCount + " tail" + (a.fleetCount === 1 ? "" : "s")
            + " · " + (a.routes ? a.routes.length : 0) + " route" + ((a.routes && a.routes.length === 1) ? "" : "s")
            + " · " + lastScrape
        li.append(name, meta)
        return li
    }

    _buildRouteRow(r) {
        const li = document.createElement("li")
        li.className = "aes-bridge__opps-row"
        const name = document.createElement("span")
        name.className = "aes-bridge__opps-row-name aes-bridge__opps-row-name--mono"
        name.textContent = r.route
        const meta = document.createElement("span")
        meta.className = "aes-bridge__opps-row-meta"
        if (r.legs && typeof r.legs === "object") {
            const parts = []
            for (const airline of r.airlines) {
                const n = r.legs[airline]
                parts.push(airline + (typeof n === "number" ? " " + n + "/wk" : ""))
            }
            meta.textContent = parts.join(" · ")
        } else {
            meta.textContent = r.airlines.join(" · ")
        }
        li.append(name, meta)
        return li
    }

    static _fmtAge(ts) {
        const d = Date.now() - Number(ts)
        if (!isFinite(d) || d < 0) return "—"
        if (d < 60_000)        return "just now"
        if (d < 3_600_000)     return Math.floor(d / 60_000) + "m ago"
        if (d < 86_400_000)    return Math.floor(d / 3_600_000) + "h ago"
        return Math.floor(d / 86_400_000) + "d ago"
    }
}

if (typeof window !== "undefined") {
    window.AesBridgeOpportunitiesPanel = AesBridgeOpportunitiesPanel
}
