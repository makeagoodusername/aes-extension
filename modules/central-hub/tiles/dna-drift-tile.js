"use strict"

/**
 * Letter L slice L5 — DNA drift tile.
 *
 * Surfaces per-account drift between observed state and effective DNA. Lives
 * in the dashboard `fleet` section right under Family tile (priority 5 vs 4).
 *
 * Read-only per NORTH-STAR §4.1: the tile reports drift; user fixes it via
 * the per-account DNA editor (or by editing the template).
 *
 * Recompute triggers:
 *   - on tile expand
 *   - on bus events: canopy:dna-changed · canopy:dna-override-changed · canopy:roles-changed · canopy:affiliations-changed
 *   - throttled to once per 30s per account so a flurry of overrides
 *     during editor use doesn't flood the bus
 */
class CentralHubDnaDriftTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "dna-drift"
        this.title = "DNA drift"
        this.section = "fleet"
        this.priority = 5
        this.requiresAirline = false
        this._cache = null            // {reports: [], computedAt}
        this._lastComputeByAccount = new Map()
        this._wired = false
    }

    watchedStorageKeys() {
        return [
            "aesCanopy:dna",
            "aesCanopy:dnaOverride:acct:",
            "aesAccounts"
        ]
    }

    openHandler() {
        return async () => {
            if (!this.expanded) this.toggle()
            if (window.AesCanopyDnaAccountEditor) window.AesCanopyDnaAccountEditor.open()
        }
    }

    _wireBus() {
        if (this._wired) return
        const handler = () => { this._cache = null; this.refresh && this.refresh() }
        try { if (window.CentralHubBus) {
            window.CentralHubBus.on("canopy:dna-changed", handler)
            window.CentralHubBus.on("canopy:dna-override-changed", handler)
            window.CentralHubBus.on("canopy:roles-changed", handler)
            window.CentralHubBus.on("canopy:affiliations-changed", handler)
        } } catch (_) {}
        this._wired = true
    }

    async _compute() {
        this._wireBus()
        if (!window.AesCanopyDnaStore || !window.AesCanopyDnaDrift) {
            return {reports: [], reason: "DNA stack not loaded", computedAt: Date.now()}
        }
        if (!window.AesAccountRegistry) {
            return {reports: [], reason: "account registry missing", computedAt: Date.now()}
        }

        const accounts = await window.AesAccountRegistry.list()
        if (!accounts.length) return {reports: [], reason: "no accounts registered", computedAt: Date.now()}

        // Restrict to self-classified accounts when affiliations are loaded.
        // Without affiliations, score every account (better signal than nothing).
        const selfIds = await this._listSelfAccountIds(accounts)
        const filtered = selfIds.size > 0
            ? accounts.filter(a => selfIds.has(a.id))
            : accounts

        const now = Date.now()
        const reports = []
        for (const acc of filtered) {
            const last = this._lastComputeByAccount.get(acc.id) || 0
            if (now - last < 30000 && this._cache) {
                const cached = (this._cache.reports || []).find(r => r.accountId === acc.id)
                if (cached) { reports.push(cached); continue }
            }
            try {
                const eff = await window.AesCanopyDnaStore.effectiveDna(acc.id)
                const observed = await window.AesCanopyDnaDrift.observedStateFor(acc.id)
                const report = window.AesCanopyDnaDrift.diffObservedAgainstEffective(observed, eff, {accountId: acc.id})
                report.displayName = acc.displayName || acc.airlineIdentity || acc.id
                report.server = acc.server || ""
                reports.push(report)
                this._lastComputeByAccount.set(acc.id, now)
            } catch (_) {}
        }

        // Sort by drift (lowest score first — most drift on top)
        reports.sort((a, b) => a.driftScore - b.driftScore)
        this._cache = {reports, computedAt: now}
        return this._cache
    }

    async _listSelfAccountIds(accounts) {
        const out = new Set()
        if (!window.AesCanopyAffiliations) return out
        try {
            const all = await window.AesCanopyAffiliations.getAll()
            // affiliations stores by enterpriseId, accounts are by accountId.
            // Use the cross-link `accountId` if present.
            for (const eid in all) {
                const r = all[eid]
                if (r && r.kind === "self" && r.accountId) out.add(r.accountId)
            }
        } catch (_) {}
        return out
    }

    async loadStatus() {
        this._cache = await this._compute()
        const {reports, reason} = this._cache
        const KIND = window.CentralHubStatusBadges.KIND
        if (!reports.length) {
            return {badge: "—", badgeKind: KIND.MUTED, summary: reason || "no DNA reports"}
        }
        const misaligned = reports.filter(r => (r.dimensions || []).some(d => d.status === "misaligned")).length
        const drifting   = reports.filter(r => (r.dimensions || []).some(d => d.status === "drifting")).length
        if (misaligned > 0) {
            return {badge: misaligned + " ⚠", badgeKind: KIND.WARN, summary: misaligned + " misaligned · " + drifting + " drifting"}
        }
        if (drifting > 0) {
            return {badge: drifting, badgeKind: KIND.OK, summary: "0 misaligned · " + drifting + " drifting"}
        }
        return {badge: "OK", badgeKind: KIND.OK, summary: reports.length + " account" + (reports.length === 1 ? "" : "s") + " aligned"}
    }

    async renderBody(_ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        if (!this._cache) this._cache = await this._compute()
        const {reports, reason} = this._cache

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap"
        const editBtn = document.createElement("button")
        editBtn.type = "button"
        editBtn.textContent = "Per-account DNA →"
        editBtn.style.cssText = this._btnStyle(T)
        editBtn.disabled = !window.AesCanopyDnaAccountEditor
        editBtn.addEventListener("click", () => {
            if (window.AesCanopyDnaAccountEditor) window.AesCanopyDnaAccountEditor.open()
        })
        actions.appendChild(editBtn)
        const tplBtn = document.createElement("button")
        tplBtn.type = "button"
        tplBtn.textContent = "Edit DNA template →"
        tplBtn.style.cssText = this._btnStyle(T)
        tplBtn.disabled = !window.AesCanopyDnaWizard
        tplBtn.addEventListener("click", () => {
            if (window.AesCanopyDnaWizard) window.AesCanopyDnaWizard.open({reason: "edit"})
        })
        actions.appendChild(tplBtn)
        host.appendChild(actions)

        if (!reports.length) {
            const p = document.createElement("p")
            p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";margin:0;font-size:11px;line-height:1.5"
            p.textContent = "No DNA reports — " + (reason || "set up the template via the wizard, then revisit.")
            host.appendChild(p)
            return
        }

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:6px"
        for (const report of reports) list.appendChild(this._renderReportCard(report, T))
        host.appendChild(list)
    }

    _renderReportCard(report, T) {
        const card = document.createElement("div")
        card.style.cssText = "background:rgba(148,163,184,0.06);border-left:3px solid " + this._driftColor(report.driftScore) + ";border-radius:3px;padding:8px 10px"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:4px"
        const name = document.createElement("div")
        name.style.cssText = "font-size:12px;font-weight:600"
        name.textContent = report.displayName + (report.server ? " · " + report.server : "")
        head.appendChild(name)
        const fitHost = document.createElement("div")
        if (window.AesCanopyDnaFit) {
            window.AesCanopyDnaFit.renderInto(fitHost, {score: report.driftScore, breakdown: this._breakdownFromReport(report)}, {label: "DNA fit"})
        }
        head.appendChild(fitHost)
        card.appendChild(head)

        const dims = report.dimensions || []
        const flagged = dims.filter(d => d.status === "misaligned" || d.status === "drifting")
        if (flagged.length) {
            const ul = document.createElement("ul")
            ul.style.cssText = "margin:4px 0 0 16px;padding:0;font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8")
            for (const d of flagged.slice(0, 4)) {
                const li = document.createElement("li")
                const tag = d.status === "misaligned" ? "⚠ " : "· "
                li.textContent = tag + d.message
                if (d.status === "misaligned") li.style.color = "#fca5a5"
                ul.appendChild(li)
            }
            card.appendChild(ul)
        } else {
            const note = document.createElement("div")
            note.style.cssText = "font-size:10.5px;color:#94a3b8"
            note.textContent = "All dimensions aligned within tolerance."
            card.appendChild(note)
        }
        return card
    }

    _driftColor(score) {
        if (score >= 0.7) return "#10b981"
        if (score >= 0.4) return "#f59e0b"
        return "#ef4444"
    }

    _breakdownFromReport(report) {
        const out = {}
        for (const d of (report.dimensions || [])) {
            const c = d.status === "aligned" ? 1 : (d.status === "drifting" ? 0.6 : (d.status === "misaligned" ? 0.2 : null))
            out[d.dimName] = {weight: 1, contribution: c, why: d.message || d.status}
        }
        return out
    }

    _btnStyle(T) {
        return [
            "background:" + (T && T.color.bone || "#1e293b"),
            "border:1px solid " + (T && T.color.slate || "rgba(148,163,184,0.35)"),
            "color:" + (T && T.color.text || "#e2e8f0"),
            "padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px"
        ].join(";")
    }
}

if (typeof window !== "undefined") {
    window.CentralHubDnaDriftTile = CentralHubDnaDriftTile
    if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register(new CentralHubDnaDriftTile())
    }
}
