"use strict"

/**
 * Strategy Briefing tile (Slice 16) — "Since your last visit" surface.
 *
 * Composes the AesStrategyBriefing report and renders four cards
 * (Applied / Drifted / Opportunities / Risk) on the Central Hub. Auto-
 * opens a full-detail modal once per game-week boundary.
 *
 * Section "operations" priority 0 — sits above World View on the
 * dashboard so it's the first thing the user sees each session.
 *
 * Wrapped in an IIFE because the manifest content_scripts injection model
 * shares a single global scope across every tile file, and at least one
 * sibling (strategy-slot-trading-tile.js) declared a top-level `function
 * _text(T, s)` that overwrote our 1-arg `_text(s)` — turning every
 * "no data yet" string into a TypeError. Keep helpers strictly local.
 */
;(function () {
class CentralHubStrategyBriefingTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "strategy-briefing"
        this.title = "Executive Briefing"
        this.section = "operations"
        this.priority = 0
        this.requiresAirline = true

        this._briefing       = null
        this._modalRoot      = null
        this._autoOpenChecked = false
    }

    watchedStorageKeys() {
        return [
            "aesStrategy:audit",
            "aesStrategy:learn:outcomes",
            "aesStrategy:plan:applied",
            "aesStrategy:autoTick:last",
            "aesStrategy:lastSeenAt",
            "routeAssistant:pricingApplyLog",
            "settings"
        ]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this._mountCtx = ctx || null
        this.subscribeBus("strategy:decision-applied", () => {
            this.refresh().catch(() => {})
        })
        this.subscribeBus("briefing:dismissed", () => {
            this.refresh().catch(() => {})
        })
        // Defer auto-open until after first refresh so the badge + body
        // render before the modal interrupts. Skipped on subsequent mounts
        // by the per-bucket guard inside _maybeAutoOpen.
        if (!this._autoOpenChecked) {
            this._autoOpenChecked = true
            let scheduledActiveSection = null
            try {
                const got = await chrome.storage.local.get(["centralHub:settings"])
                scheduledActiveSection = got
                    && got["centralHub:settings"]
                    && got["centralHub:settings"].activeSection || null
            } catch (_) {}
            setTimeout(() => {
                this._maybeAutoOpen({scheduledActiveSection}).catch(() => {})
            }, 1500)
        }
        if (window.AesRelay && window.AesDataBus) {
            const off = window.AesRelay.subscribeWithReplay(window.AesDataBus, "data:account:bootstrapped", () => {
                this.refresh().catch(() => {})
            })
            if (typeof off === "function") this._busDisposers.push(off)
        }
    }

    openHandler() {
        return async () => {
            // _openFullBriefing early-returns if `_briefing` is null. When the
            // user clicks Open before the first loadStatus() resolves (or on a
            // page where buildBriefing() hasn't been called yet because the
            // tile hasn't refreshed), the click would silently no-op. Compose
            // a briefing on demand so the modal always opens.
            if (!this._briefing && window.AesStrategyBriefing
                    && typeof window.AesStrategyBriefing.buildBriefing === "function") {
                try {
                    const ctx = this._mountCtx || this.ctx || {}
                    const accountId = (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
                    this._briefing = await window.AesStrategyBriefing.buildBriefing({
                        server:    ctx.server  || null,
                        airline:   ctx.airline || null,
                        accountId: accountId
                    })
                } catch (e) {
                    console.warn("[AES briefing tile] open buildBriefing threw", e)
                }
            }
            this._openFullBriefing()
            setTimeout(() => {
                if (!this._modalRoot && typeof this._showOpenFallbackFeedback === "function") {
                    this._showOpenFallbackFeedback()
                }
            }, 100)
        }
    }

    // ── Status ──────────────────────────────────────────────────────────

    async loadStatus(ctx) {
        const KIND = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND
        if (!window.AesStrategyBriefing) {
            return {badge: "OFF", badgeKind: KIND ? KIND.MUTED : "muted",
                    summary: "AesStrategyBriefing module not loaded — refresh the dashboard."}
        }
        let report
        try {
            report = await window.AesStrategyBriefing.buildBriefing({
                server:    ctx && ctx.server  || null,
                airline:   ctx && ctx.airline || null,
                accountId: (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
            })
        } catch (err) {
            console.warn("[AES briefing tile] buildBriefing failed", err)
            return {badge: "ERR", badgeKind: KIND ? KIND.WARN : "warn",
                    summary: "Briefing build failed — see console."}
        }
        this._briefing = report

        const newCount = report.applied.length
            + report.opportunities.length
            + (report.drifted ? 1 : 0)
            + (report.risk && report.risk.kind !== "none" ? 1 : 0)

        const tone = report.risk && report.risk.severity === "err"
            ? (KIND ? KIND.ERR : "err")
            : report.drifted
                ? (KIND ? KIND.WARN : "warn")
                : (newCount > 0 ? (KIND ? KIND.OK : "ok") : (KIND ? KIND.MUTED : "muted"))

        const summary = report.windowDays + "d window · "
            + report.applied.length + " applied · "
            + report.opportunities.length + " opportunities · "
            + (report.drifted ? "drift " + _fmtPct(report.drifted.driftPct) : "no drift")
            + (report.risk && report.risk.kind !== "none" ? " · " + report.risk.summary : "")

        return {
            badge:     newCount > 0 ? newCount + " NEW" : "NONE",
            badgeKind: tone,
            summary:   summary
        }
    }

    // ── Body — 2x2 card grid ────────────────────────────────────────────

    async renderBody(ctx, hostEl) {
        hostEl.textContent = ""
        const T = window.AESTokens
        const report = this._briefing
            || await window.AesStrategyBriefing.buildBriefing({
                server:    ctx && ctx.server  || null,
                airline:   ctx && ctx.airline || null,
                accountId: (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
            }).catch(() => null)
        if (!report) {
            hostEl.appendChild(_text("Briefing builder unavailable on this page."))
            return
        }
        this._briefing = report

        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:2fr 1fr",
            "grid-template-rows:auto auto",
            "gap:" + T.sp[3],
            "margin-bottom:" + T.sp[3]
        ].join(";")
        grid.appendChild(this._renderAppliedCard(report))
        grid.appendChild(this._renderDriftCard(report))
        grid.appendChild(this._renderOpportunitiesCard(report))
        grid.appendChild(this._renderRiskCard(report))
        hostEl.appendChild(grid)

        const footer = document.createElement("div")
        footer.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:center",
            "padding:" + T.sp[2] + " 0",
            "border-top:1px solid " + T.color.paperRule,
            "color:" + T.color.oxide2,
            "font:11px " + T.font.display
        ].join(";")
        const meta = document.createElement("span")
        meta.textContent = "Window opens " + _fmtRelative(report.sinceMs)
            + (report.weekId ? " · current week " + report.weekId : "")
        footer.appendChild(meta)

        const cta = document.createElement("button")
        cta.type = "button"
        cta.textContent = "Open full briefing →"
        cta.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:none",
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font:600 11px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        cta.addEventListener("click", () => this._openFullBriefing())
        footer.appendChild(cta)
        hostEl.appendChild(footer)
    }

    _renderAppliedCard(report) {
        const T = window.AESTokens
        const card = _card(T, "Applied", report.applied.length + " in last " + report.windowDays + "d")
        if (!report.applied.length) {
            card.appendChild(_text("No applied decisions in this window. Once you apply a plan, the engine starts measuring outcomes here."))
            return card
        }
        for (const item of report.applied) {
            const row = document.createElement("div")
            row.style.cssText = [
                "display:flex",
                "justify-content:space-between",
                "gap:" + T.sp[2],
                "padding:" + T.sp[1] + " 0",
                "border-bottom:1px dashed " + T.color.paperRule
            ].join(";")
            const left = document.createElement("div")
            left.style.cssText = "min-width:0;flex:1 1 auto;"
            const title = document.createElement("div")
            title.style.cssText = "font:600 12px " + T.font.display + ";color:" + T.color.oxide
                                + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            title.textContent = _domainGlyph(item.domain) + " " + (item.summary || _scopeLabel(item.scope))
            left.appendChild(title)
            const sub = document.createElement("div")
            sub.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
            sub.textContent = _fmtRelative(item.ts) + " · " + (item.status || "?")
            left.appendChild(sub)
            row.appendChild(left)

            const right = document.createElement("div")
            right.style.cssText = "flex:0 0 auto;text-align:right;font:11px " + T.font.mono + ";"
            if (item.predicted && item.observed) {
                right.appendChild(_chip(T, _fmtImpact(item.predicted), "muted"))
                const obsTone = item.driftTone === "err" ? "err" : item.driftTone === "warn" ? "warn" : "ok"
                right.appendChild(_chip(T, _fmtImpact(item.observed), obsTone))
            } else if (item.predicted) {
                right.appendChild(_chip(T, _fmtImpact(item.predicted), "muted"))
                right.appendChild(_chip(T, "obs pending", "muted"))
            } else {
                right.appendChild(_chip(T, "no estimate", "muted"))
            }
            row.appendChild(right)
            card.appendChild(row)
        }
        return card
    }

    _renderDriftCard(report) {
        const T = window.AESTokens
        const card = _card(T, "Drifted", report.drifted ? "largest gap" : "all aligned")
        if (!report.drifted) {
            card.appendChild(_text("No drifted outcomes — predictions and observations agree within tolerance."))
            return card
        }
        const d = report.drifted
        const metricLine = document.createElement("div")
        metricLine.style.cssText = "font:600 12px " + T.font.display + ";color:" + T.color.oxide + ";"
        metricLine.textContent = _metricLabel(d.metric)
        card.appendChild(metricLine)

        const valueLine = document.createElement("div")
        valueLine.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";margin:2px 0;"
        valueLine.textContent = "pred " + _fmtNum(d.predicted) + " · obs " + _fmtNum(d.observed)
        card.appendChild(valueLine)

        const driftLine = document.createElement("div")
        const tone = d.driftTone === "err" ? T.color.crimson : d.driftTone === "warn" ? T.color.amber : T.color.moss
        driftLine.style.cssText = "font:600 12px " + T.font.mono + ";color:" + tone + ";"
        driftLine.textContent = "drift " + _fmtPct(d.driftPct)
        card.appendChild(driftLine)

        if (d.deltaWeights && Object.keys(d.deltaWeights).length) {
            const wLine = document.createElement("div")
            wLine.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";margin-top:" + T.sp[1] + ";"
            const top = Object.entries(d.deltaWeights)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                .slice(0, 2)
                .map(([k, v]) => k + " " + (v > 0 ? "+" : "") + v.toFixed(2))
                .join(" · ")
            wLine.textContent = "weights nudged: " + top
            card.appendChild(wLine)
        }
        return card
    }

    _renderOpportunitiesCard(report) {
        const T = window.AESTokens
        const card = _card(T, "Opportunities", report.opportunities.length + " fresh")
        if (!report.opportunities.length) {
            card.appendChild(_text("No fresh proposals. Open Strategy → Compose to refresh."))
            return card
        }
        for (const op of report.opportunities) {
            const row = document.createElement("div")
            row.style.cssText = [
                "display:flex",
                "justify-content:space-between",
                "gap:" + T.sp[2],
                "padding:" + T.sp[1] + " 0",
                "border-bottom:1px dashed " + T.color.paperRule,
                "cursor:pointer"
            ].join(";")
            row.addEventListener("click", () => {
                this._emitBus("briefing:item-actioned", {kind: "opportunity", target: op.decisionId})
                this._openStrategyPanel()
            })
            const left = document.createElement("div")
            left.style.cssText = "min-width:0;flex:1 1 auto;"
            const title = document.createElement("div")
            title.style.cssText = "font:600 12px " + T.font.display + ";color:" + T.color.oxide
                                + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            title.textContent = _kindGlyph(op.kind) + " " + (op.title || op.subtitle || "—")
            left.appendChild(title)
            if (op.subtitle && op.subtitle !== op.title) {
                const sub = document.createElement("div")
                sub.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2
                                  + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                sub.textContent = op.subtitle
                left.appendChild(sub)
            }
            row.appendChild(left)
            if (op.impact) {
                const tone = op.impact.tone || "ok"
                const right = _chip(T, _fmtImpact(op.impact), tone)
                right.style.alignSelf = "center"
                row.appendChild(right)
            }
            card.appendChild(row)
        }
        return card
    }

    _renderRiskCard(report) {
        const T = window.AESTokens
        const r = report.risk || {kind: "none", severity: "ok", summary: "All systems nominal"}
        const tone = r.severity === "err" ? T.color.crimson : r.severity === "warn" ? T.color.amber : T.color.moss
        const card = _card(T, "Risk", r.kind === "none" ? "ok" : r.kind)
        const head = document.createElement("div")
        head.style.cssText = "font:600 12px " + T.font.display + ";color:" + tone + ";"
        head.textContent = r.summary
        card.appendChild(head)
        if (r.detail) {
            const det = document.createElement("div")
            det.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";margin-top:" + T.sp[1] + ";"
            det.textContent = r.detail
            card.appendChild(det)
        }
        if (r.ctaLabel) {
            const cta = document.createElement("button")
            cta.type = "button"
            cta.textContent = r.ctaLabel
            cta.style.cssText = [
                "margin-top:" + T.sp[2],
                "background:transparent",
                "color:" + tone,
                "border:1px solid " + tone,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[1] + " " + T.sp[2],
                "font:600 11px " + T.font.display,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase",
                "cursor:pointer"
            ].join(";")
            cta.addEventListener("click", () => this._handleRiskCta(r.ctaTarget))
            card.appendChild(cta)
        }
        return card
    }

    // ── Modal — full briefing ───────────────────────────────────────────

    _openFullBriefing() {
        if (this._modalRoot) return
        const T = window.AESTokens
        const report = this._briefing
        if (!report) return

        const overlay = document.createElement("div")
        overlay.className = "aes-briefing-modal"
        overlay.dataset.aesStrategySurface = "briefing"
        overlay.tabIndex = -1
        overlay.style.cssText = [
            "position:fixed", "inset:0", "z-index:2147483640",
            "background:rgba(11,18,32,0.7)",
            "display:flex", "align-items:center", "justify-content:center",
            "padding:" + T.sp[4]
        ].join(";")
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._closeModal({reason: "outside-click"})
        })

        const dialog = document.createElement("div")
        dialog.className = "aes-briefing-dialog"
        dialog.setAttribute("role", "dialog")
        dialog.setAttribute("aria-modal", "true")
        dialog.setAttribute("aria-label", "Executive briefing")
        dialog.style.cssText = [
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "max-width:880px", "width:100%",
            "max-height:90vh",
            "display:flex", "flex-direction:column",
            "overflow:hidden"
        ].join(";")

        const header = document.createElement("div")
        header.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "padding:" + T.sp[3] + " " + T.sp[4],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone2
        ].join(";")
        const title = document.createElement("h2")
        title.style.cssText = [
            "margin:0",
            "font:" + T.fw.display + " " + T.fs.h2 + " " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.oxide
        ].join(";")
        title.textContent = "Executive Briefing"
        header.appendChild(title)

        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "✕"
        closeBtn.setAttribute("aria-label", "Close")
        closeBtn.style.cssText = [
            "background:transparent", "border:none",
            "color:" + T.color.oxide,
            "font:600 18px " + T.font.display,
            "cursor:pointer", "padding:" + T.sp[1] + " " + T.sp[2]
        ].join(";")
        closeBtn.addEventListener("click", () => this._closeModal({reason: "close-button"}))
        header.appendChild(closeBtn)
        dialog.appendChild(header)

        const subhead = document.createElement("div")
        subhead.style.cssText = [
            "padding:" + T.sp[2] + " " + T.sp[4],
            "color:" + T.color.oxide2,
            "font:11px " + T.font.display,
            "border-bottom:1px solid " + T.color.paperRule
        ].join(";")
        subhead.textContent = "Window opens " + _fmtRelative(report.sinceMs)
            + " · " + report.windowDays + " day(s)"
            + (report.weekId ? " · current week " + report.weekId : "")
            + (report.airline ? " · " + report.airline : "")
        dialog.appendChild(subhead)

        const content = document.createElement("div")
        content.style.cssText = ["flex:1 1 auto", "overflow:auto", "padding:" + T.sp[4]].join(";")
        content.appendChild(this._renderModalSection("Applied · top " + report.applied.length, this._renderModalApplied(report)))
        content.appendChild(this._renderModalSection("Drifted outcome", this._renderModalDrift(report)))
        content.appendChild(this._renderModalSection("Opportunities · top " + report.opportunities.length, this._renderModalOpportunities(report)))
        content.appendChild(this._renderModalSection("Risk", this._renderModalRisk(report)))
        if (report.diagnostics && (report.diagnostics.missing.length || report.diagnostics.notes.length)) {
            content.appendChild(this._renderModalSection("Diagnostics", this._renderModalDiagnostics(report)))
        }
        dialog.appendChild(content)

        const footer = document.createElement("div")
        footer.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "padding:" + T.sp[3] + " " + T.sp[4],
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone2
        ].join(";")
        const tag = document.createElement("span")
        tag.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
        tag.textContent = "Mark as read updates 'since your last visit' to now."
        footer.appendChild(tag)
        const markBtn = document.createElement("button")
        markBtn.type = "button"
        markBtn.textContent = "Mark as read"
        markBtn.style.cssText = [
            "background:" + T.color.oxide, "color:" + T.color.bone,
            "border:none", "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font:600 12px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        markBtn.addEventListener("click", () => {
            this._writeLastSeen().catch(() => {})
            this._closeModal({reason: "mark-as-read"})
        })
        footer.appendChild(markBtn)
        dialog.appendChild(footer)

        overlay.appendChild(dialog)
        document.body.appendChild(overlay)
        this._modalRoot = overlay

        const escHandler = (e) => {
            if (e.key === "Escape" || e.key === "Esc" || e.code === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                this._closeModal({reason: "escape"})
            }
        }
        document.addEventListener("keydown", escHandler, true)
        overlay.addEventListener("keydown", escHandler, true)
        this._modalEsc = escHandler
        setTimeout(() => {
            try { overlay.focus({preventScroll: true}) } catch (_) {}
        }, 0)

        this._emitBus("briefing:opened", {windowDays: report.windowDays})
    }

    _closeModal(opts) {
        if (!this._modalRoot) return
        if (this._modalEsc) {
            document.removeEventListener("keydown", this._modalEsc, true)
            try { this._modalRoot.removeEventListener("keydown", this._modalEsc, true) } catch (_) {}
        }
        try { this._modalRoot.remove() } catch (_) {}
        this._modalRoot = null
        this._modalEsc  = null
        this._emitBus("briefing:dismissed", opts || {})
    }

    _renderModalSection(title, body) {
        const T = window.AESTokens
        const sec = document.createElement("section")
        sec.style.cssText = "margin-bottom:" + T.sp[4] + ";"
        const h = document.createElement("h3")
        h.textContent = title
        h.style.cssText = [
            "margin:0 0 " + T.sp[2],
            "font:" + T.fw.display + " " + T.fs.lead + " " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.oxide
        ].join(";")
        sec.appendChild(h)
        sec.appendChild(body)
        return sec
    }

    _renderModalApplied(report) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        if (!report.applied.length) {
            wrap.appendChild(_text("No applied decisions in this window."))
            return wrap
        }
        for (const item of report.applied) {
            const card = document.createElement("div")
            card.style.cssText = [
                "border:1px solid " + T.color.paperRule,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[2],
                "margin-bottom:" + T.sp[2],
                "background:" + T.color.bone2
            ].join(";")
            const head = document.createElement("div")
            head.style.cssText = "display:flex;justify-content:space-between;gap:" + T.sp[3] + ";"
            const title = document.createElement("div")
            title.style.cssText = "font:600 13px " + T.font.display + ";color:" + T.color.oxide + ";"
            title.textContent = _domainGlyph(item.domain) + " " + (item.summary || _scopeLabel(item.scope))
            head.appendChild(title)
            const ts = document.createElement("div")
            ts.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";"
            ts.textContent = _fmtRelative(item.ts)
            head.appendChild(ts)
            card.appendChild(head)

            const meta = document.createElement("div")
            meta.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";margin:" + T.sp[1] + " 0;"
            meta.textContent = "domain " + (item.domain || "?") + " · status " + (item.status || "?")
                            + " · scope " + _scopeLabel(item.scope)
            card.appendChild(meta)

            const chips = document.createElement("div")
            chips.style.cssText = "display:flex;gap:" + T.sp[2] + ";flex-wrap:wrap;margin-bottom:" + T.sp[2] + ";"
            if (item.predicted) chips.appendChild(_chip(T, "pred " + _fmtImpact(item.predicted), "muted"))
            if (item.observed)  chips.appendChild(_chip(T, "obs " + _fmtImpact(item.observed),
                item.driftTone === "err" ? "err" : item.driftTone === "warn" ? "warn" : "ok"))
            if (item.drift != null) chips.appendChild(_chip(T, "drift " + _fmtPct(item.drift),
                item.driftTone === "err" ? "err" : item.driftTone === "warn" ? "warn" : "ok"))
            card.appendChild(chips)

            if (Array.isArray(item.rationale) && item.rationale.length) {
                const ration = document.createElement("ul")
                ration.style.cssText = "margin:0;padding-left:" + T.sp[3] + ";font:12px " + T.font.display + ";color:" + T.color.oxide + ";"
                for (const r of item.rationale) {
                    const li = document.createElement("li")
                    li.textContent = r
                    ration.appendChild(li)
                }
                card.appendChild(ration)
            }

            const det = document.createElement("details")
            det.style.cssText = "margin-top:" + T.sp[2] + ";"
            const sum = document.createElement("summary")
            sum.style.cssText = "cursor:pointer;font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
            sum.textContent = "Source envelope (raw)"
            det.appendChild(sum)
            const pre = document.createElement("pre")
            pre.style.cssText = [
                "margin:" + T.sp[1] + " 0 0",
                "padding:" + T.sp[2],
                "background:" + T.color.bone,
                "border:1px solid " + T.color.paperRule,
                "border-radius:" + T.geom.radius,
                "font:11px " + T.font.mono,
                "color:" + T.color.oxide,
                "max-height:200px", "overflow:auto", "white-space:pre-wrap"
            ].join(";")
            try { pre.textContent = JSON.stringify(item.raw, null, 2) }
            catch (_) { pre.textContent = "(could not serialize)" }
            det.appendChild(pre)
            card.appendChild(det)

            wrap.appendChild(card)
        }
        return wrap
    }

    _renderModalDrift(report) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        if (!report.drifted) {
            wrap.appendChild(_text("No drifted outcomes within tolerance — predictions are matching observations."))
            return wrap
        }
        const d = report.drifted
        const tone = d.driftTone === "err" ? T.color.crimson : d.driftTone === "warn" ? T.color.amber : T.color.moss
        const card = document.createElement("div")
        card.style.cssText = [
            "border:1px solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[3],
            "background:" + T.color.bone2
        ].join(";")

        const metric = document.createElement("div")
        metric.style.cssText = "font:600 14px " + T.font.display + ";color:" + T.color.oxide + ";"
        metric.textContent = _metricLabel(d.metric)
        card.appendChild(metric)

        const chips = document.createElement("div")
        chips.style.cssText = "display:flex;gap:" + T.sp[2] + ";flex-wrap:wrap;margin:" + T.sp[2] + " 0;"
        chips.appendChild(_chip(T, "pred " + _fmtNum(d.predicted), "muted"))
        chips.appendChild(_chip(T, "obs " + _fmtNum(d.observed), tone === T.color.crimson ? "err" : tone === T.color.amber ? "warn" : "ok"))
        chips.appendChild(_chip(T, "drift " + _fmtPct(d.driftPct), tone === T.color.crimson ? "err" : tone === T.color.amber ? "warn" : "ok"))
        card.appendChild(chips)

        const meta = document.createElement("div")
        meta.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
        meta.textContent = "applied " + _fmtRelative(d.applyTs) + " · observed " + _fmtRelative(d.afterTs)
        card.appendChild(meta)

        if (d.deltaWeights && Object.keys(d.deltaWeights).length) {
            const wHead = document.createElement("div")
            wHead.style.cssText = "margin-top:" + T.sp[3] + ";font:600 12px " + T.font.display + ";color:" + T.color.oxide + ";"
            wHead.textContent = "Weight nudge that followed"
            card.appendChild(wHead)
            const wList = document.createElement("ul")
            wList.style.cssText = "margin:" + T.sp[1] + " 0 0;padding-left:" + T.sp[3] + ";font:12px " + T.font.mono + ";color:" + T.color.oxide + ";"
            for (const [k, v] of Object.entries(d.deltaWeights)) {
                const li = document.createElement("li")
                li.textContent = k + " " + (v > 0 ? "+" : "") + v.toFixed(3)
                wList.appendChild(li)
            }
            card.appendChild(wList)
        } else {
            const note = document.createElement("div")
            note.style.cssText = "margin-top:" + T.sp[2] + ";font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
            note.textContent = "No weight nudge logged — auto-learn may be paused or under min-samples threshold."
            card.appendChild(note)
        }
        wrap.appendChild(card)
        return wrap
    }

    _renderModalOpportunities(report) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        if (!report.opportunities.length) {
            wrap.appendChild(_text("No fresh opportunities composed. Open Strategy → Compose to refresh the plan."))
            return wrap
        }
        for (const op of report.opportunities) {
            const card = document.createElement("div")
            card.style.cssText = [
                "border:1px solid " + T.color.paperRule,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[2],
                "margin-bottom:" + T.sp[2],
                "background:" + T.color.bone2
            ].join(";")
            const head = document.createElement("div")
            head.style.cssText = "display:flex;justify-content:space-between;gap:" + T.sp[3] + ";"
            const title = document.createElement("div")
            title.style.cssText = "font:600 13px " + T.font.display + ";color:" + T.color.oxide + ";"
            title.textContent = _kindGlyph(op.kind) + " " + (op.title || op.subtitle || "—")
            head.appendChild(title)
            if (op.impact) {
                head.appendChild(_chip(T, _fmtImpact(op.impact), op.impact.tone || "ok"))
            }
            card.appendChild(head)

            if (op.subtitle && op.subtitle !== op.title) {
                const sub = document.createElement("div")
                sub.style.cssText = "font:12px " + T.font.display + ";color:" + T.color.oxide2 + ";margin:" + T.sp[1] + " 0;"
                sub.textContent = op.subtitle
                card.appendChild(sub)
            }

            if (Array.isArray(op.rationale) && op.rationale.length) {
                const ration = document.createElement("ul")
                ration.style.cssText = "margin:0;padding-left:" + T.sp[3] + ";font:12px " + T.font.display + ";color:" + T.color.oxide + ";"
                for (const r of op.rationale) {
                    const li = document.createElement("li")
                    li.textContent = r
                    ration.appendChild(li)
                }
                card.appendChild(ration)
            }

            const cta = document.createElement("button")
            cta.type = "button"
            cta.textContent = "Apply this →"
            cta.style.cssText = [
                "margin-top:" + T.sp[2],
                "background:" + T.color.oxide, "color:" + T.color.bone,
                "border:none", "border-radius:" + T.geom.radius,
                "padding:" + T.sp[1] + " " + T.sp[3],
                "font:600 11px " + T.font.display,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase",
                "cursor:pointer"
            ].join(";")
            cta.addEventListener("click", () => {
                this._emitBus("briefing:item-actioned", {kind: "opportunity", target: op.decisionId})
                this._openStrategyPanel()
            })
            card.appendChild(cta)
            wrap.appendChild(card)
        }
        return wrap
    }

    _renderModalRisk(report) {
        const T = window.AESTokens
        const r = report.risk || {kind: "none", severity: "ok", summary: "All systems nominal", detail: ""}
        const tone = r.severity === "err" ? T.color.crimson : r.severity === "warn" ? T.color.amber : T.color.moss
        const card = document.createElement("div")
        card.style.cssText = [
            "border-left:3px solid " + tone,
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2
        ].join(";")
        const h = document.createElement("div")
        h.style.cssText = "font:600 14px " + T.font.display + ";color:" + tone + ";"
        h.textContent = r.summary
        card.appendChild(h)
        if (r.detail) {
            const d = document.createElement("div")
            d.style.cssText = "font:12px " + T.font.display + ";color:" + T.color.oxide + ";margin-top:" + T.sp[1] + ";"
            d.textContent = r.detail
            card.appendChild(d)
        }
        if (r.ctaLabel) {
            const cta = document.createElement("button")
            cta.type = "button"
            cta.textContent = r.ctaLabel
            cta.style.cssText = [
                "margin-top:" + T.sp[2],
                "background:transparent",
                "color:" + tone,
                "border:1px solid " + tone,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[1] + " " + T.sp[3],
                "font:600 11px " + T.font.display,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase",
                "cursor:pointer"
            ].join(";")
            cta.addEventListener("click", () => this._handleRiskCta(r.ctaTarget))
            card.appendChild(cta)
        }
        return card
    }

    _renderModalDiagnostics(report) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";"
        if (report.diagnostics.missing.length) {
            const m = document.createElement("div")
            m.textContent = "Missing inputs: " + report.diagnostics.missing.join(", ")
            wrap.appendChild(m)
        }
        for (const note of report.diagnostics.notes) {
            const n = document.createElement("div")
            n.textContent = "· " + note
            wrap.appendChild(n)
        }
        return wrap
    }

    // ── Auto-open guard ─────────────────────────────────────────────────

    async _maybeAutoOpen(opts) {
        opts = opts || {}
        try {
            const settingsGot = await chrome.storage.local.get(["settings", "centralHub:settings"])
            const hubSettings = settingsGot && settingsGot["centralHub:settings"]
            const activeSection = hubSettings && hubSettings.activeSection
            if (opts.scheduledActiveSection && opts.scheduledActiveSection !== this.section) return
            if (opts.scheduledActiveSection && activeSection
                    && activeSection !== opts.scheduledActiveSection) return
            if (activeSection && activeSection !== this.section) return
            const expanded = Array.isArray(hubSettings && hubSettings.expandedTiles)
                ? hubSettings.expandedTiles.map(String)
                : []
            if (expanded.some(id => id !== this.id && /^strategy/.test(id))) return
            if (document.querySelector("[data-aes-strategy-surface], .aes-strategy-modal, .aes-layered-panel")) return
            const cfg = settingsGot
                && settingsGot.settings
                && settingsGot.settings.strategy
                && settingsGot.settings.strategy.briefing
            if (cfg && cfg.briefingAutoOpen === false) return
        } catch (_) { /* fall through */ }

        const accountId = (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
        const ctx = this._mountCtx || {}
        const server = ctx.server || null
        const airline = ctx.airline || null
        // Per-airline fallback when account-registry hasn't populated
        // `__aesAccountId` yet — keeps cold-start / sign-out / multi-airline
        // sessions from sharing one global `briefingLastWeekId` bucket.
        const guardKey = accountId
            ? "aesStrategy:briefingLastWeekId:acct:" + accountId
            : (server && airline)
                ? "aesStrategy:briefingLastWeekId:server:" + server + ":airline:" + airline
                : server
                    ? "aesStrategy:briefingLastWeekId:server:" + server
                    : "aesStrategy:briefingLastWeekId"

        if (!this._briefing && window.AesStrategyBriefing) {
            try {
                const ctx = this._mountCtx || {}
                this._briefing = await window.AesStrategyBriefing.buildBriefing({
                    server:    ctx.server  || null,
                    airline:   ctx.airline || null,
                    accountId: accountId
                })
            } catch (_) { return }
        }

        const report = this._briefing
        if (!report || !report.autoOpenBucketId) return
        if (!report.applied.length && !report.opportunities.length
            && !report.drifted && (!report.risk || report.risk.kind === "none")) return

        let lastBucketId = null
        try {
            const got = await chrome.storage.local.get([guardKey])
            lastBucketId = got[guardKey] || null
        } catch (_) {}
        if (lastBucketId === report.autoOpenBucketId) return

        try { await chrome.storage.local.set({[guardKey]: report.autoOpenBucketId}) }
        catch (_) {}
        this._openFullBriefing()
    }

    async _writeLastSeen() {
        const accountId = (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
        const key = accountId ? "aesStrategy:lastSeenAt:acct:" + accountId : "aesStrategy:lastSeenAt"
        const rec = {ts: Date.now(), weekId: (this._briefing && this._briefing.weekId) || null}
        try { await chrome.storage.local.set({[key]: rec}) } catch (_) {}
    }

    // ── CTA handlers ────────────────────────────────────────────────────

    _handleRiskCta(target) {
        if (!target) return
        if (target === "open-strategy-panel") this._openStrategyPanel()
        else if (target === "open-pricing-settings") this._openRoutePanelToSettings()
        else if (target === "open-ra-panel") this._openRoutePanel()
        else if (target === "open-settings") this._openRoutePanelToSettings()
        else if (typeof target === "string" && target.startsWith("/")) {
            try { window.location.href = target } catch (_) {}
        }
    }

    _openStrategyPanel(opts) {
        try {
            if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                const ret = window.AesStrategyPanel.open(opts || {})
                if (ret && typeof ret.catch === "function") {
                    ret.catch(e => console.warn("[AES briefing tile] open strategy panel failed", e))
                }
            }
        } catch (e) { console.warn("[AES briefing tile] open strategy panel threw", e) }
    }

    _openRoutePanel() {
        try {
            if (window.RouteAssistantPanel && typeof window.RouteAssistantPanel.open === "function") {
                window.RouteAssistantPanel.open()
            }
        } catch (_) {}
    }

    _openRoutePanelToSettings() {
        this._openStrategyPanel({section: "settings", domain: "price"})
    }

    _emitBus(name, payload) {
        try { if (window.CentralHubBus && window.CentralHubBus.emit) window.CentralHubBus.emit(name, payload || {}) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus && window.AesStrategy.bus.emit)
                window.AesStrategy.bus.emit(name, payload || {}) } catch (_) {}
    }
}

// ── Free helpers ────────────────────────────────────────────────────────

function _text(s) {
    const T = window.AESTokens
    const el = document.createElement("div")
    el.style.cssText = "color:" + T.color.oxide2 + ";font:12px " + T.font.display + ";"
    el.textContent = s
    return el
}

function _card(T, title, subtitle) {
    const card = document.createElement("div")
    card.style.cssText = [
        "border:1px solid " + T.color.paperRule,
        "border-radius:" + T.geom.radius,
        "padding:" + T.sp[2] + " " + T.sp[3],
        "background:" + T.color.bone2,
        "min-height:90px"
    ].join(";")
    const head = document.createElement("div")
    head.style.cssText = [
        "display:flex", "justify-content:space-between", "align-items:baseline",
        "margin-bottom:" + T.sp[2],
        "padding-bottom:" + T.sp[1],
        "border-bottom:1px solid " + T.color.paperRule
    ].join(";")
    const t = document.createElement("span")
    t.textContent = title
    t.style.cssText = "font:600 11px " + T.font.display + ";letter-spacing:" + T.track.caps
                    + ";text-transform:uppercase;color:" + T.color.oxide + ";"
    head.appendChild(t)
    if (subtitle) {
        const s = document.createElement("span")
        s.textContent = subtitle
        s.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
        head.appendChild(s)
    }
    card.appendChild(head)
    return card
}

function _chip(T, label, tone) {
    const map = {
        ok:    {color: T.color.moss,    bg: T.color.mossSoft},
        warn:  {color: T.color.amber,   bg: T.color.amberSoft},
        err:   {color: T.color.crimson, bg: T.color.crimsonSoft},
        muted: {color: T.color.oxide2,  bg: "transparent"}
    }
    const s = map[tone] || map.muted
    const chip = document.createElement("span")
    chip.textContent = label
    chip.style.cssText = [
        "display:inline-block",
        "padding:1px 6px",
        "margin:1px 2px",
        "border:1px solid " + s.color,
        "border-radius:10px",
        "background:" + s.bg,
        "color:" + s.color,
        "font:600 10px " + T.font.mono,
        "letter-spacing:0.04em",
        "text-transform:uppercase"
    ].join(";")
    return chip
}

function _domainGlyph(d) {
    return ({pricing: "💲", "service-profile": "🍽", "flight-numbers": "🔢",
             strategy: "🎯", "auto-scheduler": "🛫", "afp-audit": "📋"})[d] || "•"
}

function _kindGlyph(k) {
    return ({schedule: "🛫", service: "🍽", price: "💲", crew: "👤",
             routeCreation: "✈", competitorReaction: "↺"})[k] || "•"
}

function _scopeLabel(scope) {
    if (!scope) return "—"
    if (scope.hub && scope.dest) return scope.hub + "→" + scope.dest
    if (scope.tail) return "tail " + scope.tail
    if (scope.profileId) return "profile " + scope.profileId
    if (scope.planId) return "plan " + String(scope.planId).slice(0, 8)
    return "—"
}

function _metricLabel(m) {
    return ({weeklyProfit: "Weekly profit", orsAvg: "Average ORS Y", paxLfMean: "Mean pax LF"})[m] || m
}

function _fmtImpact(im) {
    if (!im || im.value == null) return "—"
    const v = Number(im.value)
    if (im.unit === "$/wk") return (v >= 0 ? "+" : "") + "$" + Math.round(v).toLocaleString() + "/wk"
    if (im.unit === "ORS")  return (v >= 0 ? "+" : "") + v.toFixed(2) + " ORS"
    if (im.unit === "ppl")  return (v >= 0 ? "+" : "") + v.toFixed(1) + "pp"
    return String(v)
}

function _fmtNum(v) {
    if (typeof v !== "number" || !isFinite(v)) return "—"
    if (Math.abs(v) >= 10000) return Math.round(v).toLocaleString()
    if (Math.abs(v) >= 100)   return v.toFixed(0)
    return v.toFixed(2)
}

function _fmtPct(p) {
    if (typeof p !== "number" || !isFinite(p)) return "—"
    return (p >= 0 ? "+" : "") + (p * 100).toFixed(1) + "%"
}

function _fmtRelative(ts) {
    if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "—"
    const ms = Date.now() - ts
    if (ms < 60_000) return "just now"
    const min = Math.floor(ms / 60_000)
    if (min < 60) return min + "m ago"
    const hr = Math.floor(min / 60)
    if (hr < 48) return hr + "h ago"
    const d = Math.floor(hr / 24)
    return d + "d ago"
}

window.CentralHubStrategyBriefingTile = CentralHubStrategyBriefingTile

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "strategy-briefing",
        section:  "operations",
        priority: 0,
        factory:  () => new CentralHubStrategyBriefingTile()
    })
}
})();
