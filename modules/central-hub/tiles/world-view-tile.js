"use strict"

/**
 * Central Hub — World View tile.
 *
 * A network-scale, hub-oriented dashboard. Renders:
 *   - Hub picker chips
 *   - Summary metric strip
 *   - Geographic world-map of destinations (size = freq × competition,
 *     color = competition pressure, glyph = carrier class)
 *   - Wave Gantt of three banks (W2)
 *   - Squarified treemap of destinations
 *   - Alliance + interline recommendations (W4)
 *
 * Read-only. Click on any destination emits `focus-route` (and
 * `focus-enterprise` when the dominant carrier is known) on the
 * Central Hub bus, which drives cross-tile drill-in.
 */
class CentralHubWorldViewTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "world-view"
        this.title = "World View"
        this.section = "operations"
        this.priority = 30
        this.requiresAirline = true

        this._focusedHub = null
        this._network = null
        this._loading = false
    }

    watchedStorageKeys() {
        const keys = []
        if (window.WorldViewSettings) keys.push(window.WorldViewSettings.prefix() + ":")
        if (window.WorldViewNetworkCache) keys.push(window.WorldViewNetworkCache.prefix() + ":")
        if (typeof AllianceOverviewScraper !== "undefined" && AllianceOverviewScraper.CACHE_KEY) {
            keys.push(AllianceOverviewScraper.CACHE_KEY)
        }
        keys.push("aesStrategy:plan:applied")
        return keys
    }

    openHref() { return null }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this.subscribeBus("focus-route", ({hub, dest}) => {
            if (!hub || !dest) return
            const code = String(hub).toUpperCase()
            if (this._focusedHub && this._focusedHub === code) return
            this._focusedHub = code
            if (!this.expanded) this.toggle()
            this._persistFocus(code)
            this._renderBodySafe()
        })
    }

    async _persistFocus(hub) {
        if (!window.WorldViewSettings) return
        try {
            await window.WorldViewSettings.patch(this.ctx && this.ctx.airline, {
                focusedHub: hub,
                lastFocusedAt: Date.now()
            })
        } catch (e) {
            console.warn("[AES WorldView] persist focus failed", e)
        }
    }

    async _resolveFocusedHub(snapshot) {
        const hubs = (snapshot && Array.isArray(snapshot.hubs))
            ? snapshot.hubs.map(h => h && h.iata).filter(Boolean).map(s => s.toUpperCase())
            : []
        if (this._focusedHub && hubs.includes(this._focusedHub)) return this._focusedHub
        if (window.WorldViewSettings) {
            try {
                const s = await window.WorldViewSettings.load(this.ctx && this.ctx.airline)
                const persisted = s && s.focusedHub ? String(s.focusedHub).toUpperCase() : null
                if (persisted && hubs.includes(persisted)) {
                    this._focusedHub = persisted
                    return persisted
                }
            } catch (_) {}
        }
        return hubs[0] || null
    }

    async _loadSnapshot() {
        if (typeof window.AesStrategy === "undefined" || !window.AesStrategy.snapshot) return null
        try {
            return await window.AesStrategy.snapshot({
                server: this.ctx && this.ctx.server,
                airlineCode: this.ctx && this.ctx.airline
            })
        } catch (e) {
            console.warn("[AES WorldView] snapshot failed", e)
            return null
        }
    }

    async _loadAlliance() {
        if (typeof AllianceOverviewScraper === "undefined") return null
        try { return await AllianceOverviewScraper.loadRecord() }
        catch (_) { return null }
    }

    async _buildOrLoadNetwork(snapshot, alliance, hub) {
        const server = (snapshot && snapshot.server) || (this.ctx && this.ctx.server)
        const airline = (snapshot && snapshot.airlineCode) || (this.ctx && this.ctx.airline)

        const ownIds = await this._collectOwnEnterpriseIds()
        const partnerCache = await this._loadPartnerCache(server, ownIds)

        if (window.WorldViewNetworkCache) {
            const cached = await window.WorldViewNetworkCache.get(server, airline, hub)
            if (cached) {
                // Cache valid only if alliance + partner cache haven't moved on.
                const cachedAt = (cached.sourceFreshness && cached.sourceFreshness.allianceTs) || 0
                const allianceTs = (alliance && alliance.scrapedAt) || 0
                const cachedPartnerCount = cached.carrierIndex
                    && Array.isArray(cached.carrierIndex.partnerByEnterpriseId)
                    ? cached.carrierIndex.partnerByEnterpriseId.length
                    : 0
                const liveSameSize = partnerCache.size === cachedPartnerCount
                if (allianceTs <= cachedAt + 1000 && liveSameSize) return cached
            }
        }

        if (!window.WorldViewNetworkBuilder) return null
        const network = window.WorldViewNetworkBuilder.build({
            snapshot: snapshot,
            alliance: alliance,
            partnerCache: partnerCache,
            ownEnterpriseIds: ownIds,
            hub: hub
        })

        if (window.WorldViewNetworkCache) {
            try { await window.WorldViewNetworkCache.put(server, airline, hub, network) }
            catch (_) {}
        }
        return network
    }

    async _collectOwnEnterpriseIds() {
        try {
            if (window.RouteAssistantSettings && window.RouteAssistantSettings.load) {
                const s = await window.RouteAssistantSettings.load()
                if (s && s.carriers && Array.isArray(s.carriers.myEnterpriseIds)) {
                    return s.carriers.myEnterpriseIds.map(String).filter(Boolean)
                }
            }
        } catch (e) { console.warn("[AES WorldView] own-ids load failed", e) }
        return []
    }

    async _loadPartnerCache(server, ownIds) {
        const map = new Map()
        if (!ownIds || !ownIds.length) return map
        if (typeof window.RouteAssistantContractualPartnersScraper === "undefined") return map
        try {
            // Each own enterprise's record carries a `.partners` list whose
            // entries are foreign carriers and the relations we have with
            // them (ALLIANCE / INTERLINING / …). Flatten across all our
            // sister enterprises so the classifier can answer "do I have
            // any agreement with carrier X?" in one lookup.
            const records = await window.RouteAssistantContractualPartnersScraper
                .bulkLoadCache(ownIds)
            if (records && typeof records.forEach === "function") {
                records.forEach((rec) => {
                    if (!rec || !Array.isArray(rec.partners)) return
                    for (const p of rec.partners) {
                        if (!p || p.partnerId == null) continue
                        const id = String(p.partnerId)
                        const cur = map.get(id) || []
                        const rels = Array.isArray(p.relations) ? p.relations : []
                        for (const r of rels) {
                            const u = String(r || "").toUpperCase()
                            if (u && cur.indexOf(u) === -1) cur.push(u)
                        }
                        map.set(id, cur)
                    }
                })
            }
        } catch (e) {
            console.warn("[AES WorldView] partner cache load failed", e)
        }
        return map
    }

    async loadStatus() {
        const KIND = window.CentralHubStatusBadges.KIND
        const snapshot = await this._loadSnapshot()
        if (!snapshot) {
            return {badge: "—", badgeKind: KIND.MUTED, summary: "Strategy snapshot unavailable on this page."}
        }
        const hubs = (snapshot.hubs || []).map(h => h && h.iata).filter(Boolean)
        const totalRoutes = (snapshot.hubs || []).reduce((s, h) => s + ((h && Array.isArray(h.byRoute)) ? h.byRoute.length : 0), 0)
        const alliance = await this._loadAlliance()
        const allyMembers = (alliance && Array.isArray(alliance.members)) ? alliance.members.length : 0
        const summary = hubs.length
            ? hubs.length + " HUB" + (hubs.length === 1 ? "" : "S")
                + " · " + totalRoutes + " route" + (totalRoutes === 1 ? "" : "s")
                + (allyMembers ? " · " + allyMembers + " ally member" + (allyMembers === 1 ? "" : "s") : "")
            : "No hubs in snapshot"
        return {
            badge: hubs.length ? String(hubs.length) : "—",
            badgeKind: hubs.length ? KIND.INFO : KIND.MUTED,
            summary: summary
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""

        if (this._loading) return
        this._loading = true
        try {
            const snapshot = await this._loadSnapshot()
            if (!snapshot) {
                this._renderEmptyState(host, "Strategy snapshot unavailable. Reload the dashboard or visit /app/com/scheduling/<HUB> to seed top-routes.")
                return
            }

            const alliance = await this._loadAlliance()
            const hubs = (snapshot.hubs || []).map(h => h && h.iata).filter(Boolean).map(s => s.toUpperCase())
            const focusedHub = await this._resolveFocusedHub(snapshot)
            this._focusedHub = focusedHub

            // Hub picker first — always visible even when there's no data.
            const pickerHost = document.createElement("div")
            host.appendChild(pickerHost)
            window.WorldViewHubPicker.render(pickerHost, {
                hubs: hubs,
                focused: focusedHub,
                onPick: async (iata) => {
                    this._focusedHub = iata
                    await this._persistFocus(iata)
                    this._renderBodySafe()
                }
            })

            if (!focusedHub) {
                this._renderEmptyState(host, "Pick a hub above. If no hubs appear, visit /app/com/scheduling/<HUB> for any hub to seed the snapshot.", {marginTop: T.sp[2]})
                return
            }

            // Build (or pull from cache) the network for the focused hub.
            const network = await this._buildOrLoadNetwork(snapshot, alliance, focusedHub)
            this._network = network
            if (!network || !network.destinations.length) {
                this._renderEmptyState(host, "No destinations cached for " + focusedHub + ". Open the route-assistant on /app/com/scheduling/" + focusedHub + " once to seed top-routes.", {marginTop: T.sp[2]})
                return
            }

            // Summary strip.
            const summaryHost = document.createElement("div")
            host.appendChild(summaryHost)
            window.WorldViewSummaryStrip.render(summaryHost, network)

            // Two-column body: world-map (full width) on top; treemap +
            // recommendations (placeholder until W4) below in a 2:1 grid.
            const mapHost = document.createElement("div")
            host.appendChild(mapHost)
            window.WorldViewWorldMap.render(mapHost, network, {
                onPick: (d) => this._emitFocusRoute(focusedHub, d),
                onPickEnterprise: (id, d) => this._emitFocusEnterprise(id, focusedHub, d)
            })

            // Wave pane placeholder (W2 fills it in).
            if (window.WorldViewWavePane && window.WorldViewWavePane.render) {
                const waveHost = document.createElement("div")
                host.appendChild(waveHost)
                try { window.WorldViewWavePane.render(waveHost, network, {
                    onFlightClick: (flight, route) => {
                        if (!route) return
                        this._emitFocusRoute(focusedHub, {dest: route.destination || route.dest})
                    }
                }) } catch (e) { console.warn("[AES WorldView] wave-pane render failed", e) }
            }

            // Bottom row: treemap + recommendations (W4).
            const bottom = document.createElement("div")
            bottom.style.cssText = [
                "display:grid",
                "grid-template-columns:minmax(0, 2fr) minmax(0, 1fr)",
                "gap:" + T.sp[3],
                "margin-top:" + T.sp[3]
            ].join(";")
            host.appendChild(bottom)

            const treemapHost = document.createElement("div")
            bottom.appendChild(treemapHost)
            window.WorldViewDestinationsTreemap.render(treemapHost, network, {
                onPick: (d) => this._emitFocusRoute(focusedHub, d),
                onPickEnterprise: (id, d) => this._emitFocusEnterprise(id, focusedHub, d)
            })

            const recsHost = document.createElement("div")
            bottom.appendChild(recsHost)
            if (window.WorldViewRecommendationsPane && window.WorldViewRecommendationsPane.render) {
                try {
                    const enterprises = await this._loadEnterprisesForRecs(network)
                    const allianceRecs = window.WorldViewRecommendAlliance
                        ? window.WorldViewRecommendAlliance.rank({
                            network: network,
                            enterprises: enterprises,
                            hub: focusedHub,
                            limit: 5
                        })
                        : []
                    const partnerCacheMap = await this._loadPartnerCache(
                        network.server, network.carrierIndex.ownEnterpriseIds || []
                    )
                    const interlineRecs = window.WorldViewRecommendInterline
                        ? window.WorldViewRecommendInterline.rank({
                            network: network,
                            enterprises: enterprises,
                            partnerCache: partnerCacheMap,
                            hub: focusedHub,
                            limit: 8
                        })
                        : []
                    window.WorldViewRecommendationsPane.render(recsHost, network, {
                        allianceRecs: allianceRecs,
                        interlineRecs: interlineRecs,
                        onPickEnterprise: (id, dest) => this._emitFocusEnterprise(id, focusedHub, {dest: dest})
                    })
                } catch (e) {
                    console.warn("[AES WorldView] recommendations render failed", e)
                    this._renderEmptyState(recsHost, "Recommendations unavailable (see console).")
                }
            } else {
                this._renderRecommendationsPlaceholder(recsHost)
            }

            // Warnings footer (if any).
            if (network.warnings && network.warnings.length) {
                const wrap = document.createElement("details")
                wrap.style.cssText = "margin-top:" + T.sp[2] + ";color:" + T.color.slate + ";font-family:" + T.font.display + ";font-size:" + T.fs.micro + ";"
                const sum = document.createElement("summary")
                sum.textContent = network.warnings.length + " diagnostic" + (network.warnings.length === 1 ? "" : "s")
                sum.style.cursor = "pointer"
                wrap.appendChild(sum)
                const ul = document.createElement("ul")
                ul.style.cssText = "margin:" + T.sp[1] + " 0 0 " + T.sp[3] + ";padding:0;"
                for (const w of network.warnings) {
                    const li = document.createElement("li")
                    li.textContent = w
                    ul.appendChild(li)
                }
                wrap.appendChild(ul)
                host.appendChild(wrap)
            }
        } catch (err) {
            console.warn("[AES WorldView] renderBody failed", err)
            this._renderEmptyState(host, "World View failed to render. See console.")
        } finally {
            this._loading = false
        }
    }

    _renderRecommendationsPlaceholder(host) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        const wrap = document.createElement("div")
        wrap.style.cssText = ws.panelBox()
        const title = document.createElement("h4")
        title.style.cssText = ws.paneTitle()
        title.textContent = "RECOMMENDATIONS"
        wrap.appendChild(title)
        const p = document.createElement("p")
        p.style.cssText = "color:" + T.color.slate + ";margin:0;font-family:" + T.font.display + ";font-size:" + T.fs.body + ";"
        p.textContent = "Alliance + interline recommendations land in slice W4."
        wrap.appendChild(p)
        host.appendChild(wrap)
    }

    async _loadEnterprisesForRecs(network) {
        const out = new Map()
        if (typeof window.AesCompetitorStore === "undefined") return out
        const server = network && network.server
        if (!server) return out

        const ids = new Set()
        // Dominant carriers across the focused hub's destinations.
        for (const d of (network.destinations || [])) {
            const id = d && d.competition && d.competition.dominantEnterpriseId
            if (id) ids.add(String(id))
        }
        // Own + sister airline enterprises.
        for (const id of (network.carrierIndex && network.carrierIndex.ownEnterpriseIds) || []) {
            ids.add(String(id))
        }
        // Alliance members — so the alliance ranker has something to bucket
        // when our own alliance is the only one with any cached members.
        if (network.myAlliance && Array.isArray(network.myAlliance.members)) {
            for (const m of network.myAlliance.members) {
                const id = m && (m.enterpriseId || m.id)
                if (id) ids.add(String(id))
            }
        }
        if (!ids.size) return out

        try {
            const recs = await window.AesCompetitorStore.bulkLoadEnterprises(server, Array.from(ids))
            if (recs && typeof recs.forEach === "function") {
                recs.forEach((rec, id) => {
                    if (rec) out.set(String(id), rec)
                })
            } else if (recs && typeof recs === "object") {
                for (const k of Object.keys(recs)) {
                    if (recs[k]) out.set(String(k), recs[k])
                }
            }
        } catch (e) {
            console.warn("[AES WorldView] enterprise bulk load failed", e)
        }
        return out
    }

    _emitFocusRoute(hub, dest) {
        if (!window.CentralHubBus || !window.CentralHubBus.emit) return
        const destIata = (dest && dest.dest) || (dest && dest.destIata) || null
        if (!destIata) return
        try {
            window.CentralHubBus.emit("focus-route", {
                hub: hub,
                dest: destIata,
                source: "world-view"
            })
        } catch (e) { console.warn("[AES WorldView] focus-route emit failed", e) }
    }

    _emitFocusEnterprise(enterpriseId, hub, dest) {
        if (!enterpriseId) return
        if (!window.CentralHubBus || !window.CentralHubBus.emit) return
        try {
            window.CentralHubBus.emit("focus-enterprise", {
                enterpriseId: String(enterpriseId),
                hub: hub,
                dest: dest && dest.dest,
                source: "world-view"
            })
        } catch (e) { console.warn("[AES WorldView] focus-enterprise emit failed", e) }
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "world-view",
        section: "operations",
        priority: 30,
        factory: () => new CentralHubWorldViewTile()
    })
}
