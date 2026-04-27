"use strict"

/**
 * On-page panel injected into `/app/info/airports/<id>`. Renders a
 * carriers table mirroring AS's Stations block with extras: alliance
 * icon, banner thumbnail (from RA cache), "is mine" highlight, and
 * Sync now action (wired in slice 4).
 *
 * Idempotent — `render()` reuses the same container DOM node across
 * subsequent calls so the panel doesn't duplicate when the host
 * triggers a re-render.
 */
class AesCompetitorAirportPanel {
    static CONTAINER_ID = "aes-competitor-airport-panel"

    constructor({host, settings} = {}) {
        this._host = host
        this._settings = settings || {}
        this._container = null
    }

    render(view) {
        const container = this._ensureContainer()
        if (!container) return
        container.innerHTML = ""
        container.appendChild(this._buildHeader(view))
        container.appendChild(this._buildSettingsBlock())
        container.appendChild(this._buildStatusLine(view))
        container.appendChild(this._buildTable(view))
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
        let existing = document.getElementById(AesCompetitorAirportPanel.CONTAINER_ID)
        if (existing) {
            this._container = existing
            return existing
        }

        const anchor = AesCompetitorAirportPanel._findAnchor()
        if (!anchor) return null

        const container = document.createElement("div")
        container.id = AesCompetitorAirportPanel.CONTAINER_ID
        container.className = "as-panel aes-competitor-airport-panel"
        anchor.after(container)
        this._container = container
        return container
    }

    static _findAnchor() {
        const candidates = document.querySelectorAll(".as-page .container-fluid .as-panel, .container-fluid .as-panel")
        return candidates.length ? candidates[candidates.length - 1] : null
    }

    _buildHeader(view) {
        const h = document.createElement("div")
        h.className = "aes-competitor-heading"

        const title = document.createElement("h3")
        title.textContent = "AES — Competitor Intelligence"
        h.appendChild(title)

        if (this._settings && this._settings.ui && this._settings.ui.showFreshnessPill !== false) {
            const pill = AesCompetitorAirportPanel._freshnessPill(view && view.airport && view.airport.scrapedAt)
            if (pill) h.appendChild(pill)
        }

        const actions = document.createElement("div")
        actions.className = "aes-competitor-actions"
        h.appendChild(actions)

        const sync = document.createElement("button")
        sync.type = "button"
        sync.className = "aes-competitor-button-bulk"
        sync.textContent = "Sync now"
        sync.addEventListener("click", () => {
            this._runBulkSync(actions, sync)
        })
        actions.appendChild(sync)

        return h
    }

    _runBulkSync(actionsContainer, syncButton) {
        if (!this._host || typeof this._host.bulkSync !== "function") return
        const progress = AesCompetitorAirportPanel._buildProgressUi()
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
            // host re-rendered the panel; this DOM is gone unless the
            // host failed to render — in that case manually restore.
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

    _buildStatusLine(view) {
        const line = document.createElement("p")
        line.className = "aes-competitor-status-line"

        if (!view || !view.airport) {
            line.textContent = "No data yet — click Sync now."
            return line
        }
        const carriers = view.airport.carriers || []
        const alliances = new Set()
        for (const c of carriers) if (c.allianceId) alliances.add(c.allianceId)
        const ago = AesCompetitorAirportPanel._formatAgo(view.airport.scrapedAt)
        const parts = [`${carriers.length} carriers`]
        if (alliances.size) parts.push(`${alliances.size} alliances`)
        if (view.airport.iata) parts.push(`IATA ${view.airport.iata}`)
        parts.push(`last sync ${ago}`)
        line.textContent = parts.join(" · ")

        if (view.airport.parserNotes) {
            const note = document.createElement("span")
            note.className = "aes-competitor-parser-notes"
            note.textContent = " — note: " + view.airport.parserNotes
            line.appendChild(note)
        }
        return line
    }

    _buildTable(view) {
        const wrapper = document.createElement("div")
        wrapper.className = "as-table-well"

        const carriers = (view && view.airport && view.airport.carriers) || []
        if (!carriers.length) {
            const empty = document.createElement("p")
            empty.textContent = "No carriers parsed."
            wrapper.appendChild(empty)
            return wrapper
        }

        const sortMode = (this._settings && this._settings.ui && this._settings.ui.defaultSort) || "weeklyDepartures"
        const sorted = carriers.slice().sort((a, b) => {
            if (sortMode === "name") return (a.enterpriseName || "").localeCompare(b.enterpriseName || "")
            return (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0)
        })

        const table = document.createElement("table")
        table.className = "table table-bordered table-striped table-hover aes-competitor-carriers-table"

        const thead = document.createElement("thead")
        thead.innerHTML = "<tr><th>#</th><th></th><th>Enterprise</th><th>Alliance</th><th>IL</th><th class='aes-text-right'>Weekly</th><th></th></tr>"
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        const enterpriseMeta = (view && view.enterpriseMeta) || new Map()
        const showLogos = this._settings && this._settings.ui && this._settings.ui.showAllianceLogos !== false

        sorted.forEach((c, i) => {
            const tr = document.createElement("tr")
            if (c.isOurs) tr.classList.add("aes-is-ours")

            const meta = enterpriseMeta.get(String(c.enterpriseId))

            const tdRank = document.createElement("td")
            tdRank.textContent = String(i + 1)
            tdRank.className = "aes-text-right"
            tr.appendChild(tdRank)

            const tdLogo = document.createElement("td")
            tdLogo.className = "aes-competitor-logo-cell"
            if (showLogos && meta && meta.avatarUrl) {
                const img = document.createElement("img")
                img.src = meta.avatarUrl
                img.alt = ""
                img.className = "aes-competitor-avatar"
                tdLogo.appendChild(img)
            }
            tr.appendChild(tdLogo)

            const tdName = document.createElement("td")
            const nameLink = document.createElement("a")
            nameLink.href = "/app/info/enterprises/" + encodeURIComponent(c.enterpriseId)
            nameLink.textContent = c.enterpriseName || ("#" + c.enterpriseId)
            tdName.appendChild(nameLink)
            if (meta && meta.iata) {
                const iataSpan = document.createElement("span")
                iataSpan.className = "aes-competitor-iata"
                iataSpan.textContent = " (" + meta.iata + ")"
                tdName.appendChild(iataSpan)
            }
            tr.appendChild(tdName)

            const tdAlliance = document.createElement("td")
            if (c.allianceId) {
                const link = document.createElement("a")
                link.href = "/app/info/alliances/" + encodeURIComponent(c.allianceId)
                link.textContent = "#" + c.allianceId
                tdAlliance.appendChild(link)
            } else {
                tdAlliance.textContent = "—"
            }
            tr.appendChild(tdAlliance)

            const tdIL = document.createElement("td")
            tdIL.className = "aes-text-center"
            tdIL.textContent = c.isInterlining ? "✓" : ""
            tr.appendChild(tdIL)

            const tdDep = document.createElement("td")
            tdDep.className = "aes-text-right"
            tdDep.textContent = c.weeklyDepartures != null ? Intl.NumberFormat().format(c.weeklyDepartures) : "—"
            tr.appendChild(tdDep)

            const tdAct = document.createElement("td")
            const profileLink = document.createElement("a")
            profileLink.href = "/app/info/enterprises/" + encodeURIComponent(c.enterpriseId)
            profileLink.textContent = "View"
            profileLink.className = "aes-competitor-link-view"
            tdAct.appendChild(profileLink)
            if (c.officeId) {
                const ttLink = document.createElement("a")
                ttLink.href = "/app/info/timetable?office=" + encodeURIComponent(c.officeId)
                ttLink.textContent = " · TT"
                ttLink.className = "aes-competitor-link-tt"
                tdAct.appendChild(ttLink)
            }
            tr.appendChild(tdAct)

            tbody.appendChild(tr)
        })

        table.appendChild(tbody)
        wrapper.appendChild(table)
        return wrapper
    }

    static _freshnessPill(scrapedAt) {
        if (!scrapedAt) return null
        const ageMs = Date.now() - scrapedAt
        let level = "green"
        if (ageMs > 7 * 86400000) level = "red"
        else if (ageMs > 24 * 3600000) level = "amber"
        const span = document.createElement("span")
        span.className = "aes-competitor-freshness-pill aes-competitor-freshness-pill--" + level
        span.textContent = AesCompetitorAirportPanel._formatAgo(scrapedAt)
        return span
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
