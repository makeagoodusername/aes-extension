"use strict"

/**
 * On-page panel injected into `/app/info/enterprises/<id>`. Renders the
 * competitor profile: identity card (banner + alliance + base country),
 * fleet summary, hubs grouped by country, top routes derived from RA
 * markets cache, and a Sync now action.
 *
 * Idempotent — `render()` reuses the same container DOM node so repeated
 * renders don't duplicate.
 */
class AesCompetitorEnterprisePanel {
    static CONTAINER_ID = "aes-competitor-enterprise-panel"

    constructor({host, settings} = {}) {
        this._host = host
        this._settings = settings || {}
        this._container = null
    }

    render(profile) {
        const container = this._ensureContainer()
        if (!container) return
        container.innerHTML = ""
        container.appendChild(this._buildHeader(profile))
        container.appendChild(this._buildSettingsBlock())
        container.appendChild(this._buildProfileCard(profile))
        const fleet = this._buildFleetSummary(profile)
        if (fleet) container.appendChild(fleet)
        container.appendChild(this._buildHubsBlock(profile))
        container.appendChild(this._buildRoutesBlock(profile))
    }

    _buildSettingsBlock() {
        return AesCompetitorSettingsUi.build({
            settings: this._settings,
            onSave: async (updates) => {
                const merged = await AesCompetitorSettings.save(updates)
                this._settings = merged
                if (this._host) this._host._settings = merged
            }
        })
    }

    _ensureContainer() {
        let existing = document.getElementById(AesCompetitorEnterprisePanel.CONTAINER_ID)
        if (existing) {
            this._container = existing
            return existing
        }
        const anchor = AesCompetitorEnterprisePanel._findAnchor()
        if (!anchor) return null

        const container = document.createElement("div")
        container.id = AesCompetitorEnterprisePanel.CONTAINER_ID
        container.className = "as-panel aes-competitor-enterprise-panel"
        anchor.after(container)
        this._container = container
        return container
    }

    static _findAnchor() {
        const all = document.querySelectorAll(".container-fluid")
        if (all.length >= 3) {
            const heading = all[2].querySelector("h2")
            if (heading) return heading
        }
        const fallback = document.querySelector("h1 + .as-panel, .container-fluid .as-panel")
        return fallback || null
    }

    _buildHeader(profile) {
        const h = document.createElement("div")
        h.className = "aes-competitor-heading"

        const title = document.createElement("h3")
        title.textContent = "AES — Competitor Intelligence"
        h.appendChild(title)

        if (this._settings && this._settings.ui && this._settings.ui.showFreshnessPill !== false) {
            const pills = AesCompetitorEnterprisePanel._freshnessPills(profile)
            if (pills) h.appendChild(pills)
        }

        const actions = document.createElement("div")
        actions.className = "aes-competitor-actions"
        h.appendChild(actions)

        const sync = document.createElement("button")
        sync.type = "button"
        sync.className = "aes-competitor-button-bulk"
        sync.textContent = "Sync now"
        sync.addEventListener("click", () => { this._runBulkSync(actions, sync) })
        actions.appendChild(sync)

        return h
    }

    _runBulkSync(actionsContainer, syncButton) {
        if (!this._host || typeof this._host.bulkSync !== "function") return
        const progress = AesCompetitorEnterprisePanel._buildProgressUi()
        syncButton.replaceWith(progress.root)

        const {scanner, promise} = this._host.bulkSync(({done, total, currentLabel}) => {
            progress.bar.value = done
            progress.bar.max = Math.max(total, 1)
            const pct = total ? Math.round((done / total) * 100) : 0
            progress.label.textContent = `Syncing ${done}/${total} (${pct}%)` +
                (currentLabel ? " · " + currentLabel : "")
        })

        progress.abort.addEventListener("click", () => {
            scanner.abort()
            progress.label.textContent = "Aborting…"
            progress.abort.disabled = true
        })

        promise.finally(() => {
            if (document.contains(progress.root)) {
                progress.root.replaceWith(syncButton)
            }
        })
    }

    static _buildProgressUi() {
        const root = document.createElement("div")
        root.className = "aes-competitor-progress"
        const bar = document.createElement("progress")
        bar.className = "aes-competitor-progress__bar"
        bar.value = 0
        bar.max = 1
        const label = document.createElement("span")
        label.className = "aes-competitor-progress__label"
        label.textContent = "Starting…"
        const abort = document.createElement("button")
        abort.type = "button"
        abort.className = "aes-competitor-button-abort"
        abort.textContent = "Abort"
        root.appendChild(bar)
        root.appendChild(label)
        root.appendChild(abort)
        return {root, bar, label, abort}
    }

    _buildProfileCard(profile) {
        const card = document.createElement("div")
        card.className = "aes-competitor-profile-card"

        const ent = profile && profile.enterprise
        if (!ent) {
            card.textContent = "No data yet — click Sync now."
            return card
        }

        if (ent.bannerUrl) {
            const banner = document.createElement("img")
            banner.src = ent.bannerUrl
            banner.alt = ""
            banner.className = "aes-competitor-banner"
            card.appendChild(banner)
        }

        const meta = document.createElement("div")
        meta.className = "aes-competitor-profile-meta"

        const name = document.createElement("h4")
        name.textContent = ent.name || ("#" + (profile.enterpriseId || ""))
        if (ent.iata) {
            const code = document.createElement("span")
            code.className = "aes-competitor-iata"
            code.textContent = " (" + ent.iata + ")"
            name.appendChild(code)
        }
        meta.appendChild(name)

        const facts = document.createElement("ul")
        facts.className = "aes-competitor-facts"
        if (ent.alliance) {
            const li = document.createElement("li")
            li.innerHTML = `Alliance: <a href="/app/info/alliances/${escapeHtml(ent.alliance.id)}">${escapeHtml(ent.alliance.name || "#" + ent.alliance.id)}</a>`
            facts.appendChild(li)
        }
        if (ent.baseCountry) {
            const li = document.createElement("li")
            li.innerHTML = `Base country: <a href="/app/info/countries/${escapeHtml(ent.baseCountry.id)}">${escapeHtml(ent.baseCountry.name || ent.baseCountry.id)}</a>`
            facts.appendChild(li)
        }
        if (ent.scrapedAt) {
            const li = document.createElement("li")
            li.textContent = "Last scraped: " + AesCompetitorEnterprisePanel._formatAgo(ent.scrapedAt)
            facts.appendChild(li)
        }
        if (ent.parserNotes) {
            const li = document.createElement("li")
            li.className = "aes-competitor-parser-notes"
            li.textContent = "Note: " + ent.parserNotes
            facts.appendChild(li)
        }
        meta.appendChild(facts)

        card.appendChild(meta)
        return card
    }

    _buildFleetSummary(profile) {
        const ent = profile && profile.enterprise
        const fleet = ent && ent.fleet
        if (!fleet) return null

        const block = document.createElement("div")
        block.className = "aes-competitor-fleet-summary"

        const heading = document.createElement("h4")
        heading.textContent = "Fleet & operations"
        block.appendChild(heading)

        const dl = document.createElement("dl")
        dl.className = "aes-competitor-dl"
        const pushPair = (label, value) => {
            if (value == null) return
            const dt = document.createElement("dt")
            dt.textContent = label
            const dd = document.createElement("dd")
            dd.textContent = typeof value === "number" ? Intl.NumberFormat().format(value) : String(value)
            dl.appendChild(dt)
            dl.appendChild(dd)
        }
        pushPair("Aircraft",  fleet.aircraftCount)
        pushPair("Stations",  fleet.stationsCount)
        pushPair("Employees", fleet.employeeCount)
        pushPair("Passengers/wk", fleet.paxCarried)
        pushPair("Cargo/wk",  fleet.cargoCarried)
        pushPair("Rating",    fleet.rating)
        block.appendChild(dl)
        return block
    }

    _buildHubsBlock(profile) {
        const block = document.createElement("div")
        block.className = "aes-competitor-hubs-block"

        const heading = document.createElement("h4")
        heading.textContent = "Hubs"
        block.appendChild(heading)

        const groups = (profile && profile.hubsByCountry) || []
        if (!groups.length) {
            const empty = document.createElement("p")
            empty.textContent = "No hubs parsed."
            block.appendChild(empty)
            return block
        }

        for (const group of groups) {
            const det = document.createElement("details")
            det.className = "aes-competitor-hub-group"
            det.open = true
            const summary = document.createElement("summary")
            summary.className = "aes-competitor-hub-group__country"
            const countSpan = document.createElement("span")
            countSpan.className = "aes-competitor-hub-group__count"
            countSpan.textContent = " (" + group.hubs.length + ")"
            summary.textContent = group.countryName || "Unknown"
            summary.appendChild(countSpan)
            det.appendChild(summary)

            const ul = document.createElement("ul")
            ul.className = "aes-competitor-hub-list"
            for (const h of group.hubs) {
                const li = document.createElement("li")
                const code = document.createElement("strong")
                code.textContent = h.iata || "?"
                li.appendChild(code)
                if (h.weeklyDepartures != null) {
                    const dep = document.createElement("span")
                    dep.textContent = " · " + Intl.NumberFormat().format(h.weeklyDepartures) + " flights/wk"
                    li.appendChild(dep)
                }
                if (h.airportId) {
                    const link = document.createElement("a")
                    link.href = "/app/info/airports/" + encodeURIComponent(h.airportId)
                    link.textContent = " open"
                    link.className = "aes-competitor-link-view"
                    li.appendChild(link)
                }
                ul.appendChild(li)
            }
            det.appendChild(ul)
            block.appendChild(det)
        }
        return block
    }

    _buildRoutesBlock(profile) {
        const block = document.createElement("div")
        block.className = "aes-competitor-routes-block"

        const heading = document.createElement("h4")
        heading.textContent = "Top routes"
        block.appendChild(heading)

        const byFlights = (profile && profile.topPairsByFlights) || []
        const byShare   = (profile && profile.topPairsByShare) || []

        if (!byFlights.length && !byShare.length) {
            const hint = document.createElement("p")
            hint.className = "aes-competitor-hint"
            hint.textContent = "No routes parsed. Visit market analysis pages to populate edge data, or click Sync now."
            block.appendChild(hint)
            return block
        }

        const sortMode = this._routesSort || "flights"
        const tabs = document.createElement("div")
        tabs.className = "aes-competitor-routes-tabs"
        const flightsBtn = document.createElement("button")
        flightsBtn.type = "button"
        flightsBtn.textContent = `Flights (${byFlights.length})`
        flightsBtn.className = "aes-competitor-tab" + (sortMode === "flights" ? " aes-is-active" : "")
        flightsBtn.addEventListener("click", () => { this._routesSort = "flights"; this.render(profile) })
        const shareBtn = document.createElement("button")
        shareBtn.type = "button"
        shareBtn.textContent = `Share (${byShare.length})`
        shareBtn.className = "aes-competitor-tab" + (sortMode === "share" ? " aes-is-active" : "")
        shareBtn.disabled = !byShare.length
        shareBtn.addEventListener("click", () => { this._routesSort = "share"; this.render(profile) })
        tabs.appendChild(flightsBtn)
        tabs.appendChild(shareBtn)
        block.appendChild(tabs)

        const rows = sortMode === "share" ? byShare : byFlights

        const table = document.createElement("table")
        table.className = "table table-bordered table-striped table-hover aes-competitor-routes-table"
        const valueHeader = sortMode === "share" ? "Share %" : "Weekly"
        table.innerHTML = `<thead><tr><th>#</th><th>Hub</th><th>Dest</th><th class='aes-text-right'>${valueHeader}</th><th></th></tr></thead>`
        const tbody = document.createElement("tbody")
        rows.forEach((r, i) => {
            const tr = document.createElement("tr")
            const value = sortMode === "share"
                ? (r.sharePctPax != null ? r.sharePctPax.toFixed(1) + "%" : "—")
                : Intl.NumberFormat().format(r.weeklyFlights || 0)
            tr.innerHTML =
                `<td class="aes-text-right">${i + 1}</td>` +
                `<td>${escapeHtml(r.hub)}</td>` +
                `<td>${escapeHtml(r.dest)}</td>` +
                `<td class="aes-text-right">${value}</td>` +
                `<td><a href="/app/com/markets/${encodeURIComponent(r.hub)}${encodeURIComponent(r.dest)}">market</a></td>`
            tbody.appendChild(tr)
        })
        table.appendChild(tbody)
        block.appendChild(table)
        return block
    }

    static _freshnessPills(profile) {
        const wrap = document.createElement("span")
        wrap.className = "aes-competitor-freshness-pills"

        const ent = profile && profile.enterprise
        const fresh = (profile && profile.freshness) || {airports: "stale", meta: "stale", deep: "stale"}

        const pillFor = (label, state) => {
            const span = document.createElement("span")
            const cls =
                state === "fresh"   ? "aes-competitor-freshness-pill--green" :
                state === "partial" ? "aes-competitor-freshness-pill--amber" :
                state === "missing" ? "aes-competitor-freshness-pill--amber" :
                                      "aes-competitor-freshness-pill--red"
            span.className = "aes-competitor-freshness-pill " + cls
            span.textContent = label + ": " + state
            return span
        }
        wrap.appendChild(pillFor("airports", fresh.airports))
        wrap.appendChild(pillFor("meta",     fresh.meta))
        wrap.appendChild(pillFor("deep",     fresh.deep))

        if (ent && ent.scrapedAt) {
            const ago = document.createElement("span")
            ago.className = "aes-competitor-freshness-ago"
            ago.textContent = AesCompetitorEnterprisePanel._formatAgo(ent.scrapedAt)
            wrap.appendChild(ago)
        }
        return wrap
    }

    static _formatAgo(scrapedAt) {
        if (!scrapedAt) return "never"
        const ageMs = Date.now() - scrapedAt
        const min = Math.floor(ageMs / 60000)
        if (min < 1) return "just now"
        if (min < 60) return min + "m ago"
        const hr = Math.floor(min / 60)
        if (hr < 24) return hr + "h ago"
        const days = Math.floor(hr / 24)
        return days + "d ago"
    }
}
