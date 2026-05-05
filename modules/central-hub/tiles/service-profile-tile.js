"use strict"

/**
 * Service Profiles tile — surfaces cached AS service profiles in the hub
 * and lets the user edit Y/C/F levels per category in place. POSTs run
 * via RouteAssistantServiceProfileApplier; cache reads/writes go through
 * RouteAssistantServiceProfileScraper.
 *
 * Two body modes:
 *   - Table: list of cached profiles + a "Refresh from AS" CTA. Click a
 *     row to enter editor.
 *   - Editor: per-category rows of Y/C/F selects pre-populated from a
 *     fresh GET of the AS detail page. Footer Save/Discard/Refresh.
 *
 * The base tile.refresh() is suppressed while the editor is open so that
 * concurrent storage writes (e.g. the apply log being appended) don't
 * blow away the user's pending edits.
 */
class CentralHubServiceProfileTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "service-profile"
        this.title = "Service Profiles"
        this.section = "operations"
        this.priority = 10
        this.requiresAirline = true

        this._applier = null
        this._applyLog = null

        this._editingProfileId = null
        this._editorFormContext = null
        this._editorBusy = false
        this._editorError = null
    }

    watchedStorageKeys() {
        return [
            "routeAssistant:serviceProfilesList",
            "routeAssistant:serviceProfile:",
            "routeAssistant:serviceProfileApplyLog"
        ]
    }

    openHref() { return null }

    _ensureDeps() {
        if (!this.ctx || !this.ctx.server) return false
        if (!this._applyLog) {
            this._applyLog = new window.RouteAssistantServiceProfileApplyLog()
        }
        if (!this._applier) {
            this._applier = new window.RouteAssistantServiceProfileApplier(
                this.ctx.server,
                {applyLog: this._applyLog}
            )
        }
        return true
    }

    /**
     * Suppress full-body refresh while editing — only update the header
     * status. The base implementation re-runs renderBody on every storage
     * change, which would clobber pending select changes.
     */
    async refresh() {
        if (this._editingProfileId == null) {
            return super.refresh()
        }
        if (this._refreshing) return
        if (!this.root) return
        this._refreshing = true
        try {
            let status
            if (this.requiresAirline && (!this.ctx || !this.ctx.airline)) {
                status = {badge: "NO AIRLINE", badgeKind: "muted", summary: "Airline context unavailable on this page."}
            } else {
                status = await this.loadStatus(this.ctx)
            }
            this._renderHeader(status)
            this._lastStatus = status
        } catch (err) {
            console.warn("[AES Hub] service-profile tile refresh failed", err)
        } finally {
            this._refreshing = false
        }
    }

    async loadStatus(ctx) {
        const list = await window.RouteAssistantServiceProfileScraper.loadList()
        const profiles = list && Array.isArray(list.profiles) ? list.profiles : []
        const reputation = window.AesCompanyReputationStore
            ? await window.AesCompanyReputationStore.loadLatest()
            : null
        const ratingTail = reputation && reputation.ratingLabel
            ? " · rating " + reputation.ratingLabel
            : ""
        if (!profiles.length) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Visit a profile page to populate" + ratingTail
            }
        }
        return {
            badge: String(profiles.length),
            badgeKind: window.CentralHubStatusBadges.KIND.INFO,
            summary: profiles.length + " profile" + (profiles.length === 1 ? "" : "s") + " cached" + ratingTail
        }
    }

    async renderBody(ctx, host) {
        host.textContent = ""
        if (!this._ensureDeps()) {
            const p = document.createElement("p")
            p.textContent = "Server context unavailable."
            host.appendChild(p)
            return
        }
        const T = window.AESTokens
        if (this._editingProfileId != null) {
            await this._renderEditor(host, T)
        } else {
            await this._renderTable(host, T)
        }
    }

    // ------------------------------------------------------------------
    // Table mode
    // ------------------------------------------------------------------

    async _renderTable(host, T) {
        const list = await window.RouteAssistantServiceProfileScraper.loadList()
        const profiles = list && Array.isArray(list.profiles) ? list.profiles : []

        host.appendChild(this._buildToolbar(T, {
            mode: "table",
            onRefreshAll: () => this._handleRefreshAll(host, T)
        }))

        if (!profiles.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:" + T.sp[2] + " 0 0 0;"
            empty.textContent = "No cached profiles. Click \"Refresh from AS\" to fetch the list."
            host.appendChild(empty)
            return
        }

        const detailMap = await window.RouteAssistantServiceProfileScraper.loadAllDetails()
        const reputation = window.AesCompanyReputationStore
            ? await window.AesCompanyReputationStore.loadLatest()
            : null
        const strip = this._buildReputationStrip(reputation, detailMap, T)
        if (strip) host.appendChild(strip)

        const table = document.createElement("table")
        table.style.cssText = [
            "width:100%",
            "border-collapse:collapse",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "margin-top:" + T.sp[2]
        ].join(";")

        const thead = document.createElement("thead")
        const trh = document.createElement("tr")
        for (const label of ["Name", "Min km", "Default", "Y", "C", "F", "Impact", ""]) {
            const th = document.createElement("th")
            th.textContent = label
            th.style.cssText = [
                "text-align:left",
                "padding:" + T.sp[1] + " " + T.sp[2],
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "color:" + T.color.slate,
                "font-weight:" + T.fw.display,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase",
                "font-size:" + T.fs.micro
            ].join(";")
            trh.appendChild(th)
        }
        thead.appendChild(trh)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        for (const p of profiles) {
            const detail = detailMap.get(p.id) || null
            tbody.appendChild(this._buildTableRow(p, detail, T))
        }
        table.appendChild(tbody)
        host.appendChild(table)
    }

    _buildTableRow(profile, detail, T) {
        const tr = document.createElement("tr")
        tr.style.cssText = "cursor:pointer;"
        tr.addEventListener("mouseenter", () => { tr.style.background = T.color.bone2 })
        tr.addEventListener("mouseleave", () => { tr.style.background = "transparent" })
        tr.addEventListener("click", (e) => {
            if (e.target.closest("a")) return
            this._enterEditor(profile.id)
        })

        const cellStyle = [
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "color:" + T.color.oxide
        ].join(";")

        const cells = [
            profile.name || "(unnamed)",
            isFinite(profile.minDistanceKm) ? String(profile.minDistanceKm) : "—",
            profile.isDefault ? "default" : "",
            this._fmtScore(detail && detail.classScore && detail.classScore.Y),
            this._fmtScore(detail && detail.classScore && detail.classScore.C),
            this._fmtScore(detail && detail.classScore && detail.classScore.F),
            this._fmtImpact(detail)
        ]
        for (const text of cells) {
            const td = document.createElement("td")
            td.textContent = text
            td.style.cssText = cellStyle
            tr.appendChild(td)
        }

        const tdEdit = document.createElement("td")
        tdEdit.style.cssText = cellStyle
        const hint = document.createElement("span")
        hint.textContent = "edit →"
        hint.style.cssText = "color:" + T.color.rust + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
        tdEdit.appendChild(hint)
        tr.appendChild(tdEdit)

        return tr
    }

    _fmtScore(v) {
        if (v == null || !isFinite(v)) return "—"
        return Number(v).toFixed(2)
    }

    _fmtImpact(detail) {
        if (!detail || !detail.categories) return "—"
        const rows = this._rankCategoryImpact(detail)
        if (!rows.length) return "—"
        return rows.slice(0, 2).map(r => this._humaniseCategory(r.category)).join(", ")
    }

    _rankCategoryImpact(detail) {
        const weights = {
            drinks: 0.80, snacks: 0.85, entrees: 1.00, additionalEntrees: 0.95,
            foodPresentation: 0.90, headphones: 0.65,
            newspapersMagazines: 0.45, flightMagazines: 0.40
        }
        const out = []
        const categories = (detail && detail.categories) || {}
        for (const catKey in categories) {
            const cat = categories[catKey] || {}
            const vals = ["Y", "C", "F"].map(cls => Number(cat[cls])).filter(isFinite)
            if (!vals.length) continue
            const avg = vals.reduce((s, v) => s + v, 0) / vals.length
            out.push({
                category: catKey,
                avgLevel: avg,
                weight: weights[catKey] != null ? weights[catKey] : 0.5
            })
        }
        return out.sort((a, b) => (a.avgLevel - b.avgLevel) || (b.weight - a.weight))
    }

    _buildReputationStrip(reputation, detailMap, T) {
        const weak = []
        if (detailMap && typeof detailMap.forEach === "function") {
            detailMap.forEach(detail => {
                const top = this._rankCategoryImpact(detail)[0]
                if (top) weak.push({
                    profile: detail.name || ("#" + detail.id),
                    category: top.category,
                    avgLevel: top.avgLevel,
                    weight: top.weight
                })
            })
        }
        weak.sort((a, b) => (a.avgLevel - b.avgLevel) || (b.weight - a.weight))
        if ((!reputation || !reputation.ratingLabel) && !weak.length) return null
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "margin-top:" + T.sp[2],
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "color:" + T.color.oxide
        ].join(";")
        const parts = []
        if (reputation && reputation.ratingLabel) {
            parts.push("rating " + reputation.ratingLabel + " (" + (reputation.ratingScore || "—") + "/10)")
        }
        if (weak.length) {
            const w = weak[0]
            parts.push("weak brand cell " + w.profile + " · " + this._humaniseCategory(w.category))
        }
        wrap.textContent = parts.join(" · ")
        return wrap
    }

    async _handleRefreshAll(host, T) {
        const toast = window.RouteAssistantToast
        const fresh = new window.RouteAssistantServiceProfileScraper(this.ctx.server)
        try {
            await fresh.syncAll()
            if (toast) toast.success("Service profiles refreshed.")
        } catch (e) {
            console.warn("[AES Hub] service-profile syncAll failed", e)
            if (toast) toast.error("Refresh failed: " + (e && e.message || String(e)))
        }
        if (this._editingProfileId == null) {
            await this._renderBodySafe()
        }
    }

    // ------------------------------------------------------------------
    // Editor mode
    // ------------------------------------------------------------------

    _enterEditor(profileId) {
        this._editingProfileId = Number(profileId)
        this._editorFormContext = null
        this._editorError = null
        this._renderBodySafe()
    }

    _exitEditor() {
        this._editingProfileId = null
        this._editorFormContext = null
        this._editorError = null
        this._editorBusy = false
        this._renderBodySafe()
    }

    async _renderEditor(host, T) {
        const profileId = this._editingProfileId
        const detail = await window.RouteAssistantServiceProfileScraper.loadDetail(profileId)
        const profileName = (detail && detail.name) || ("Profile " + profileId)

        host.appendChild(this._buildToolbar(T, {
            mode: "editor",
            profileId,
            profileName,
            onBack: () => this._exitEditor(),
            onRefresh: () => this._handleRefreshOne(host, T),
            openHref: "/action/enterprise/serviceProfile?id=" + profileId
        }))

        if (!this._editorFormContext && !this._editorError) {
            this._editorBusy = true
            const stub = document.createElement("p")
            stub.textContent = "Loading profile form…"
            stub.style.cssText = "color:" + T.color.slate + ";margin:" + T.sp[2] + " 0;"
            host.appendChild(stub)
            try {
                const snapshot = await this._applier.fetchFormSnapshot(profileId)
                if (!snapshot) {
                    this._editorError = "Couldn't load the profile form from AS."
                } else {
                    this._editorFormContext = snapshot.formContext
                }
            } catch (e) {
                this._editorError = (e && e.message) || String(e)
            } finally {
                this._editorBusy = false
            }
            if (this._editingProfileId === profileId) {
                await this._renderBodySafe()
            }
            return
        }

        if (this._editorError) {
            const err = document.createElement("p")
            err.textContent = this._editorError
            err.style.cssText = "color:" + T.color.rust + ";margin:" + T.sp[2] + " 0;"
            host.appendChild(err)
            return
        }

        const formContext = this._editorFormContext
        host.appendChild(this._buildEditorForm(formContext, T))

        host.appendChild(this._buildEditorFooter(T, {
            onSave:    () => this._handleSave(host, T),
            onDiscard: () => this._exitEditor()
        }))
    }

    _buildEditorForm(formContext, T) {
        const wrap = document.createElement("div")
        wrap.dataset.role = "service-profile-editor-form"
        wrap.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr auto auto auto",
            "gap:" + T.sp[1] + " " + T.sp[3],
            "align-items:center",
            "margin-top:" + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body
        ].join(";")

        const headerLabels = ["Category", "Y", "C", "F"]
        for (const lbl of headerLabels) {
            const h = document.createElement("div")
            h.textContent = lbl
            h.style.cssText = [
                "color:" + T.color.slate,
                "font-weight:" + T.fw.display,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase",
                "font-size:" + T.fs.micro,
                "padding-bottom:" + T.sp[1],
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
            ].join(";")
            wrap.appendChild(h)
        }

        const seen = []
        for (const prefix in formContext.prefixToCategory) {
            const cat = formContext.prefixToCategory[prefix]
            if (seen.indexOf(cat) >= 0) continue
            seen.push(cat)

            const label = document.createElement("div")
            label.textContent = this._humaniseCategory(cat)
            label.style.cssText = "color:" + T.color.oxide + ";"
            wrap.appendChild(label)

            for (const cls of ["y", "c", "f"]) {
                const cell = document.createElement("div")
                const radioName = prefix + cls
                const group = formContext.radiosByName[radioName]
                if (!group) {
                    cell.textContent = "—"
                    cell.style.cssText = "color:" + T.color.slate + ";text-align:center;"
                } else {
                    cell.appendChild(this._buildSelect(radioName, group, T))
                }
                wrap.appendChild(cell)
            }
        }

        return wrap
    }

    _buildSelect(radioName, group, T) {
        const sel = document.createElement("select")
        sel.dataset.radioName = radioName
        sel.dataset.originalValue = group.checked != null ? group.checked : ""
        sel.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:2px " + T.sp[1],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body
        ].join(";")
        for (const v of group.values) {
            const opt = document.createElement("option")
            opt.value = v
            opt.textContent = v
            if (v === group.checked) opt.selected = true
            sel.appendChild(opt)
        }
        return sel
    }

    _buildEditorFooter(T, handlers) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "justify-content:flex-end",
            "gap:" + T.sp[2],
            "margin-top:" + T.sp[3],
            "padding-top:" + T.sp[2],
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule
        ].join(";")

        const discard = this._mkButton("Discard", T, "ghost")
        discard.addEventListener("click", handlers.onDiscard)
        wrap.appendChild(discard)

        const save = this._mkButton("Save changes", T, "primary")
        save.dataset.role = "save"
        save.addEventListener("click", handlers.onSave)
        wrap.appendChild(save)

        return wrap
    }

    _buildToolbar(T, opts) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[2],
            "padding-bottom:" + T.sp[2],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
        ].join(";")

        if (opts.mode === "editor") {
            const back = this._mkButton("← Back", T, "ghost")
            back.addEventListener("click", opts.onBack)
            wrap.appendChild(back)

            const title = document.createElement("span")
            title.textContent = opts.profileName
            title.style.cssText = [
                "flex:1 1 auto",
                "font-family:" + T.font.display,
                "font-weight:" + T.fw.display,
                "color:" + T.color.oxide,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps
            ].join(";")
            wrap.appendChild(title)

            if (opts.openHref) {
                const link = document.createElement("a")
                link.href = opts.openHref
                link.target = "_blank"
                link.rel = "noopener"
                link.textContent = "Open in AS ↗"
                link.style.cssText = "color:" + T.color.rust + ";text-decoration:none;font-family:" + T.font.display + ";font-size:" + T.fs.body + ";"
                wrap.appendChild(link)
            }

            const refresh = this._mkButton("Refresh from AS", T, "ghost")
            refresh.addEventListener("click", opts.onRefresh)
            wrap.appendChild(refresh)
        } else {
            const title = document.createElement("span")
            title.textContent = "Cached profiles"
            title.style.cssText = [
                "flex:1 1 auto",
                "font-family:" + T.font.display,
                "font-weight:" + T.fw.display,
                "color:" + T.color.oxide,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps
            ].join(";")
            wrap.appendChild(title)

            const refresh = this._mkButton("Refresh from AS", T, "primary")
            refresh.addEventListener("click", opts.onRefreshAll)
            wrap.appendChild(refresh)
        }

        return wrap
    }

    _mkButton(label, T, kind) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        const isPrimary = kind === "primary"
        btn.style.cssText = [
            "background:" + (isPrimary ? T.color.oxide : "transparent"),
            "color:"      + (isPrimary ? T.color.bone  : T.color.oxide),
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer",
            "transition:" + T.tr.fast
        ].join(";")
        btn.addEventListener("mouseenter", () => {
            btn.style.background = T.color.rust
            btn.style.borderColor = T.color.rust
            btn.style.color = T.color.bone
        })
        btn.addEventListener("mouseleave", () => {
            btn.style.background = isPrimary ? T.color.oxide : "transparent"
            btn.style.borderColor = T.color.oxide
            btn.style.color = isPrimary ? T.color.bone : T.color.oxide
        })
        return btn
    }

    _humaniseCategory(slug) {
        if (!slug) return ""
        // Reverse the slugify camelCase: split on capitals, capitalise each word.
        const parts = String(slug).replace(/([A-Z])/g, " $1").trim().split(/\s+/)
        return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ")
    }

    async _handleRefreshOne(host, T) {
        const profileId = this._editingProfileId
        if (profileId == null) return
        const toast = window.RouteAssistantToast
        const fresh = new window.RouteAssistantServiceProfileScraper(this.ctx.server)
        try {
            await fresh.scrapeDetail(profileId)
            const snapshot = await this._applier.fetchFormSnapshot(profileId)
            if (snapshot) {
                this._editorFormContext = snapshot.formContext
                this._editorError = null
                if (toast) toast.success("Profile refreshed from AS.")
            } else {
                this._editorError = "Couldn't load the profile form from AS."
                if (toast) toast.error(this._editorError)
            }
        } catch (e) {
            this._editorError = (e && e.message) || String(e)
            if (toast) toast.error("Refresh failed: " + this._editorError)
        }
        if (this._editingProfileId === profileId) {
            await this._renderBodySafe()
        }
    }

    async _handleSave(host, T) {
        const profileId = this._editingProfileId
        if (profileId == null) return
        const formContext = this._editorFormContext
        if (!formContext) return
        const toast = window.RouteAssistantToast

        const changes = this._collectChanges(host, formContext)
        if (!Object.keys(changes).length) {
            if (toast) toast.info("No changes to save.")
            return
        }

        const saveBtn = host.querySelector('button[data-role="save"]')
        if (saveBtn) {
            saveBtn.disabled = true
            saveBtn.style.opacity = "0.6"
            saveBtn.textContent = "Saving…"
        }

        let result = null
        try {
            result = await this._applier.apply(profileId, changes, {source: "tile"})
        } catch (e) {
            if (toast) toast.error("Apply threw: " + (e && e.message || String(e)))
            if (saveBtn) {
                saveBtn.disabled = false
                saveBtn.style.opacity = ""
                saveBtn.textContent = "Save changes"
            }
            return
        }

        if (!result || result.status === "failed") {
            const msg = result && result.error && result.error.message
                ? result.error.message
                : "Apply failed."
            if (toast) toast.error(msg)
            if (saveBtn) {
                saveBtn.disabled = false
                saveBtn.style.opacity = ""
                saveBtn.textContent = "Save changes"
            }
            return
        }

        if (result.status === "noop") {
            if (toast) toast.info("No effective changes.")
            if (saveBtn) {
                saveBtn.disabled = false
                saveBtn.style.opacity = ""
                saveBtn.textContent = "Save changes"
            }
            return
        }

        // posted — refresh the scraper cache so the table reflects the new
        // state. Use a fresh scraper instance so the in-memory session
        // cache from before the POST doesn't shadow the live page.
        try {
            const fresh = new window.RouteAssistantServiceProfileScraper(this.ctx.server)
            await fresh.scrapeDetail(profileId)
        } catch (e) {
            console.warn("[AES Hub] scrapeDetail after apply failed", e)
        }

        if (toast) {
            if (result.verified) {
                toast.success("Service profile updated.")
            } else {
                toast.warn("Posted, but verification didn't match. Check AS to confirm.")
            }
        }
        this._exitEditor()
    }

    _collectChanges(host, formContext) {
        const out = {}
        const selects = host.querySelectorAll('select[data-radio-name]')
        for (const sel of selects) {
            const radioName = sel.dataset.radioName
            const original  = sel.dataset.originalValue || ""
            const value     = sel.value
            if (value === original) continue
            if (!radioName || radioName.length < 3) continue
            const prefix    = radioName.slice(0, 2).toLowerCase()
            const clsLetter = radioName.slice(2, 3).toLowerCase()
            const category  = formContext.prefixToCategory[prefix]
            const clsKey    = window.RouteAssistantServiceProfileApplier.CLASS_LETTER_TO_KEY[clsLetter]
            if (!category || !clsKey) continue
            if (!out[category]) out[category] = {}
            const n = parseInt(value, 10)
            out[category][clsKey] = isFinite(n) ? n : value
        }
        return out
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "service-profile",
        section: "operations",
        priority: 10,
        factory: () => new CentralHubServiceProfileTile()
    })
}
