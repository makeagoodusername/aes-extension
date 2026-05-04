"use strict"

/**
 * Letter M slice M1 — Family tile.
 *
 * Surfaces the conglomerate-orchestration view: kin count, top cross-kin
 * proposals, family role coverage, "Re-detect" CTA. Designed for the
 * dashboard `fleet` section right above Fleet Command (priority 4 vs 5).
 *
 * Read-only in v1: every proposal is advisory. M2/M3+ slices wire the
 * apply paths via the existing actuators (per invariant M-A).
 *
 * Defensive states:
 *   - No `AesCanopyAffiliations` loaded                → "M0/L4 stack not loaded"
 *   - Fewer than 2 self-classified kin                 → "Unlocks at 2+ kin"
 *   - 2+ kin but no top routes cached for both        → "Visit RA panel on each kin's hubs"
 *   - 2+ kin + populated topRoutes + zero gaps       → "No cross-kin opportunities yet"
 *   - 2+ kin + ≥1 gap                                  → top-3 proposals + Open Family Briefing CTA
 */
class CentralHubFamilyTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "family"
        this.title = "Family"
        this.section = "fleet"
        this.priority = 4
        this.requiresAirline = false
        this._cache = null   // {kinCount, proposals, diagnostics, computedAt}
    }

    watchedStorageKeys() {
        // The base class matches via `key.indexOf(prefix) === 0`. The
        // per-hub topRoutes shape `routeAssistant:topRoutes:<HUB>` matches
        // either form, but the global single-key shape `routeAssistant:topRoutes`
        // (written by panel.js:_publishTopRoutes) would NOT match the
        // colon-suffixed prefix. Drop the trailing colon so both writers
        // trigger refresh.
        return [
            "aesCanopy:affiliations",
            "aesCanopy:roles",
            "aesCanopy:orgs",
            "routeAssistant:topRoutes",
            "aesAccounts"
        ]
    }

    openHandler() {
        return async () => {
            // F-9228-701: when collapsed, expand the tile (the body is the
            // briefing surface today); when already expanded, scroll the
            // tile into view so the user gets visible feedback. Without
            // this, an expanded-tile click is a silent no-op.
            if (!this.expanded) this.toggle()
            else if (this.root && typeof this.root.scrollIntoView === "function") {
                try { this.root.scrollIntoView({behavior: "smooth", block: "center"}) }
                catch (_) { /* best-effort */ }
            }
        }
    }

    async _compute() {
        if (!window.AesCanopyAffiliations || !window.AesCanopyInterlineGapDetector) {
            return {kinCount: 0, proposals: [], diagnostics: {reason: "canopy stack not fully loaded"}, computedAt: Date.now()}
        }
        let kinCount = 0
        try {
            const ids = await window.AesCanopyAffiliations.listKinIds()
            kinCount = ids.length
        } catch (_) {}

        let proposals = []
        let diagnostics = null
        if (window.AesStrategy && typeof window.AesStrategy.proposeKinHandoffMovesWithDiagnostics === "function") {
            try {
                const r = await window.AesStrategy.proposeKinHandoffMovesWithDiagnostics(null, await this._readSettings())
                proposals = r.proposals || []
                diagnostics = r.diagnostics || null
            } catch (_) {}
        }
        return {kinCount, proposals, diagnostics, computedAt: Date.now()}
    }

    async _readSettings() {
        try {
            const out = await chrome.storage.local.get(["settings"])
            return out.settings || {}
        } catch (_) { return {} }
    }

    async loadStatus() {
        this._cache = await this._compute()
        const {kinCount, proposals, diagnostics} = this._cache
        const KIND = window.CentralHubStatusBadges.KIND
        if (kinCount < 2) {
            return {
                badge:     "1 KIN",
                badgeKind: KIND.MUTED,
                summary:   "Cross-kin coordination unlocks at 2+ kin"
            }
        }
        if (!proposals.length) {
            const why = diagnostics && diagnostics.reason ? diagnostics.reason : "no opportunities found"
            return {
                badge:     String(kinCount) + " KIN",
                badgeKind: KIND.OK,
                summary:   "0 cross-kin opportunities · " + why
            }
        }
        return {
            badge:     String(proposals.length),
            badgeKind: KIND.WARN,
            summary:   kinCount + " kin · " + proposals.length + " interline-first opportunit" + (proposals.length === 1 ? "y" : "ies")
        }
    }

    async renderBody(_ctx, host) {
        const T = window.AESTokens
        // Re-entrancy guard — concurrent renders from the shell's
        // open-tile flow + storage refreshes (e.g. routeAssistant:topRoutes
        // writes during an RA scrape session) would otherwise both clear
        // and append, doubling the action strip + proposal cards.
        const gen = (this._renderGen = (this._renderGen || 0) + 1)
        host.textContent = ""

        // Action strip — re-detect + open settings shortcut
        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap"
        const detectBtn = document.createElement("button")
        detectBtn.type = "button"
        detectBtn.textContent = "Re-detect kin"
        detectBtn.title = "Auto-classify enterprises from your myEnterpriseIds + cached contractual partners. Skips any user override."
        detectBtn.style.cssText = [
            "background:" + (T && T.color.bone || "#1e293b"),
            "border:1px solid " + (T && T.color.slate || "rgba(148,163,184,0.35)"),
            "color:" + (T && T.color.text || "#e2e8f0"),
            "padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px"
        ].join(";")
        detectBtn.addEventListener("click", async () => {
            detectBtn.disabled = true
            const orig = detectBtn.textContent
            detectBtn.textContent = "Detecting…"
            try {
                if (window.AesCanopyAffiliations) {
                    await window.AesCanopyAffiliations.autoClassifyFromContractualPartners()
                }
            } catch (_) {}
            try { await this.refresh() } catch (_) {}
            detectBtn.disabled = false
            detectBtn.textContent = orig
        })
        actions.appendChild(detectBtn)

        const rolesBtn = document.createElement("button")
        rolesBtn.type = "button"
        rolesBtn.textContent = "Open Kin Roles →"
        rolesBtn.style.cssText = detectBtn.style.cssText
        rolesBtn.disabled = !window.AesCanopyRolesSettingsPage
        rolesBtn.addEventListener("click", () => {
            if (window.AesCanopyRolesSettingsPage) window.AesCanopyRolesSettingsPage.open()
        })
        actions.appendChild(rolesBtn)
        host.appendChild(actions)

        if (!this._cache) this._cache = await this._compute()
        if (gen !== this._renderGen) return
        const {kinCount, proposals, diagnostics} = this._cache

        if (kinCount < 2) {
            const help = document.createElement("p")
            help.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";margin:0;font-size:11px;line-height:1.5"
            help.innerHTML =
                "Letter M conglomerate orchestration becomes active once at least 2 of your enterprises are classified as <code>self</code>.<br>" +
                "<strong>Quick start:</strong> ensure <code>settings.routeAssistant.carriers.myEnterpriseIds</code> lists your own AS enterprises (RA panel → Carriers expander), then click <em>Re-detect kin</em> above."
            host.appendChild(help)
            return
        }

        if (!proposals.length) {
            const note = document.createElement("p")
            note.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";margin:0;font-size:11px;line-height:1.5"
            note.textContent = "No cross-kin opportunities surfaced. " +
                ((diagnostics && diagnostics.reason) ? "Reason: " + diagnostics.reason + "." : "") +
                " Visit each kin's RA panel hubs to populate topRoutes caches."
            host.appendChild(note)
            return
        }

        // Top-3 proposal cards inline — full briefing arrives in M7.
        const topN = Math.min(3, proposals.length)
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:6px"
        for (let i = 0; i < topN; i++) {
            list.appendChild(this._renderProposalCard(proposals[i], T))
        }
        host.appendChild(list)

        if (proposals.length > topN) {
            const more = document.createElement("p")
            more.style.cssText = "color:" + (T && T.color.slate || "#64748b") + ";margin:8px 0 0;font-size:10px"
            more.textContent = "+ " + (proposals.length - topN) + " more — full briefing surface arrives in M7."
            host.appendChild(more)
        }
    }

    _renderProposalCard(p, T) {
        const card = document.createElement("div")
        card.style.cssText = [
            "background:rgba(148,163,184,0.06)",
            "border-left:3px solid " + (p.gapKind === "shared-airport" ? "#06b6d4" : "#10b981"),
            "border-radius:3px",
            "padding:8px 10px"
        ].join(";")
        const headline = document.createElement("div")
        headline.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px"
        const left = document.createElement("div")
        left.style.cssText = "font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px"
        const headlineText = document.createElement("span")
        headlineText.textContent = (p.kinIds[0] + " ⇄ " + p.kinIds[1]) + " · " + p.hubs[0] + " → " + p.destIata +
            (p.viaHub ? " (via " + p.viaHub + ")" : "")
        left.appendChild(headlineText)
        // L7 — destination country chip (lazy resolve via region-resolver).
        if (window.AesCanopyRegionResolver) {
            const geoChip = document.createElement("span")
            geoChip.style.cssText = "font-size:10px;color:#67e8f9;background:rgba(34,211,238,0.10);"
                + "border:1px solid rgba(34,211,238,0.35);padding:0 4px;border-radius:3px;"
            left.appendChild(geoChip)
            this._attachProposalCountryChip(geoChip, p.destIata)
        }
        // DNA-fit pill on the proposal — scores the route shape against the
        // primary kin's effective DNA. Renders async to avoid blocking the
        // synchronous tile body render path.
        if (window.AesCanopyDnaFit && window.AesCanopyDnaStore) {
            const pillHost = document.createElement("span")
            left.appendChild(pillHost)
            this._attachProposalFitPill(pillHost, p)
        }
        const right = document.createElement("div")
        right.style.cssText = "font-size:11px;color:#10b981;font-family:ui-monospace,monospace"
        const delta = p.predicted && p.predicted.familyDeltaPerWeek
        right.textContent = delta && delta > 0 ? "+~$" + Math.round(delta) + "/wk" : ""
        headline.appendChild(left)
        headline.appendChild(right)
        card.appendChild(headline)

        const sug = document.createElement("div")
        sug.style.cssText = "font-size:11px;color:" + (T && T.color.text || "#cbd5e1") + ";margin-bottom:4px"
        sug.textContent = p.payload && p.payload.suggestion || ""
        card.appendChild(sug)

        if (p.rationale && p.rationale.length) {
            const ul = document.createElement("ul")
            ul.style.cssText = "margin:4px 0 0 18px;padding:0;font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8")
            for (const line of p.rationale.slice(0, 3)) {
                const li = document.createElement("li")
                li.textContent = line
                ul.appendChild(li)
            }
            card.appendChild(ul)
        }
        return card
    }

    async _attachProposalFitPill(host, proposal) {
        try {
            const accountId = await this._kinIdToAccountId(proposal.kinIds && proposal.kinIds[0])
            // Score the SOURCE kin's account-level alignment with effective DNA —
            // the proposal pill answers "how well does this kin currently fit its
            // DNA?" rather than route-level fit, which needs L6/L7 enrichment for
            // country resolution. Skip silently if observation is unavailable.
            if (!accountId || !window.AesCanopyDnaDrift) return
            const dna = await window.AesCanopyDnaStore.effectiveDna(accountId)
            const observed = await window.AesCanopyDnaDrift.observedStateFor(accountId)
            if (!observed || !Object.keys(observed).length) return
            const result = window.AesCanopyDnaFit.dnaFitScoreAccountState(dna, observed)
            if (!result || !result.breakdown || !Object.keys(result.breakdown).length) return
            window.AesCanopyDnaFit.renderInto(host, result, {label: proposal.kinIds[0] + " fit vs DNA"})
        } catch (_) {}
    }

    async _attachProposalCountryChip(host, destIata) {
        if (!destIata || !host) return
        try {
            let server = ""
            try { server = (typeof AES !== "undefined" && AES.getServerName) ? (AES.getServerName() || "") : "" } catch (_) { server = "" }
            const seeder = window.AesCanopyGeographySeeder
            const regionsStore = window.AesCanopyRegionsStore
            const resolver = window.AesCanopyRegionResolver
            const geoBase = window.AesGeographyBase
            if (!resolver) return
            const demand = (window.RouteAssistantDemandStore && typeof window.RouteAssistantDemandStore.get === "function")
                ? await window.RouteAssistantDemandStore.get(destIata) : null
            const countryIdMap = (server && seeder && typeof seeder.load === "function")
                ? await seeder.load(server) : null
            const regionsBlock = (regionsStore && typeof regionsStore.load === "function")
                ? await regionsStore.load() : null
            const r = resolver.resolve({iata: destIata, demand, countryIdMap, regionsBlock, geographyBase: geoBase})
            if (!r || (!r.iso2 && r.countryId == null)) {
                host.remove()
                return
            }
            host.textContent = r.iso2 || ("c" + r.countryId)
            const t = []
            if (r.iso2)       t.push("ISO2: " + r.iso2)
            if (r.continent)  t.push("Continent: " + r.continent)
            if (r.regionName) t.push("Region: " + r.regionName)
            host.title = t.join(" · ")
        } catch (_) { try { host.remove() } catch (__) {} }
    }

    async _kinIdToAccountId(kinId) {
        if (!kinId || !window.AesCanopyAffiliations) return null
        try {
            const all = await window.AesCanopyAffiliations.getAll()
            for (const eid in all) {
                const r = all[eid]
                if (r && r.kind === "self" && r.kinId === kinId && r.accountId) return r.accountId
            }
        } catch (_) {}
        return null
    }
}

if (typeof window !== "undefined") {
    window.CentralHubFamilyTile = CentralHubFamilyTile
    if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id:       "family",
            section:  "fleet",
            priority: 4,
            factory:  () => new CentralHubFamilyTile()
        })
    }
}
