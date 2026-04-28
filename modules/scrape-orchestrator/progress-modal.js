"use strict"

/**
 * ScrapeProgressModal — full-pane brutalist overlay rendered while a
 * scrape run is active. Shows per-phase progress bars, the active job's
 * URL, total counts, ETA, and a Cancel button.
 *
 * Subscribes to the ScrapeOrchestrator's progress callbacks. Owns
 * nothing about scheduling — the orchestrator drives, the modal renders.
 */
class ScrapeProgressModal {
    constructor() {
        this.root = null
        this.phaseEls = new Map()    // phaseId → {root, label, bar, count, current}
        this.startedAt = 0
        this.aborted = false
        this._activePhase = null
        this._totalCounts = {}       // phaseId → expected total
        this._completed   = {}       // phaseId → completed count
        this._failed      = {}       // phaseId → failed count
        this._failedJobs  = []       // [{phaseId, url, error}] across the whole run
        this.onCancel = null
        this.onClose  = null
    }

    mount() {
        if (this.root) return
        const T = window.AESTokens
        this.root = this._buildRoot(T)
        document.body.appendChild(this.root)
        this.startedAt = Date.now()
    }

    unmount() {
        if (!this.root) return
        try { document.body.removeChild(this.root) } catch (_) {}
        this.root = null
        this.phaseEls.clear()
    }

    setPhases(phaseSpecs) {
        if (!this.root) return
        const list = this.root.querySelector(".aes-scrape-modal__phases")
        if (!list) return
        list.textContent = ""
        this.phaseEls.clear()
        for (const p of phaseSpecs) {
            const phaseRow = this._buildPhaseRow(window.AESTokens, p.id, p.label)
            this.phaseEls.set(p.id, phaseRow)
            list.appendChild(phaseRow.root)
        }
    }

    onPhaseStart({phaseId, label}) {
        this._activePhase = phaseId
        const row = this.phaseEls.get(phaseId)
        if (!row) return
        const T = window.AESTokens
        row.label.style.color = T.color.rust
        row.bar.style.background = T.color.rustSoft
    }

    onPhaseDone({phaseId, total, succeeded, failed, skipped}) {
        const row = this.phaseEls.get(phaseId)
        if (!row) return
        const T = window.AESTokens
        if (skipped || total === 0) {
            row.label.style.color = T.color.slate
            row.count.textContent = "skipped"
        } else {
            row.label.style.color = (failed > 0) ? T.color.amber : T.color.moss
            row.count.textContent = succeeded + " / " + total + (failed ? " · " + failed + " failed" : "")
        }
        row.fill.style.width = "100%"
    }

    onProgress(event) {
        if (!event || !event.type) return
        const T = window.AESTokens

        if (event.type === "job-start") {
            const row = this.phaseEls.get(event.phaseId)
            if (row) row.current.textContent = ScrapeProgressModal._truncate(event.url || "", 64)
            return
        }
        if (event.type === "job-done" || event.type === "job-fail") {
            const phase = event.phaseId
            this._totalCounts[phase] = event.total
            if (event.type === "job-done") {
                this._completed[phase] = (this._completed[phase] || 0) + 1
            } else {
                this._failed[phase] = (this._failed[phase] || 0) + 1
                this._failedJobs.push({phaseId: phase, url: event.url || "", error: event.error || ""})
            }
            const row = this.phaseEls.get(phase)
            if (row) {
                const done = (this._completed[phase] || 0) + (this._failed[phase] || 0)
                row.count.textContent = done + " / " + event.total
                    + ((this._failed[phase] || 0) > 0 ? " · " + this._failed[phase] + " failed" : "")
                row.fill.style.width = Math.min(100, Math.round((done / event.total) * 100)) + "%"
            }
            this._updateEta()
            return
        }
        if (event.type === "breaker-trip") {
            const recent = Array.isArray(event.recentFails) && event.recentFails.length
                ? event.recentFails
                : this._failedJobs.slice(-3)
            const lines = ["Halted — 3 consecutive job failures. 10-minute cooldown."]
            for (const f of recent) {
                const url = ScrapeProgressModal._truncate(f.url || "", 80)
                const err = f.error ? " — " + f.error : ""
                lines.push("· " + url + err)
            }
            this._showBanner(lines.join("\n"), "alert", true)
            return
        }
        if (event.type === "run-done") {
            const reason = event.reason || "done"
            if (reason !== "done" && reason !== "aborted") {
                this._showBanner("Phase ended: " + reason, "warn", false)
            }
            return
        }
        if (event.type === "phase-post-run") {
            // ORS bulk run completed — surface a small note.
            const note = event.result && event.result.totalRoutes
                ? "ORS bulk run done · " + event.result.totalRoutes + " routes"
                : "ORS bulk run skipped"
            this._showBanner(note, "info", false)
        }
    }

    onDone({aborted}) {
        const T = window.AESTokens
        const banner = this.root && this.root.querySelector(".aes-scrape-modal__banner")
        if (!banner) return
        if (aborted) {
            banner.textContent = "Aborted. Tabs cleaned up."
            banner.style.background = T.color.amberSoft
            banner.style.color      = T.color.amber
            banner.style.borderColor= T.color.amber
        } else {
            const elapsed = Math.round((Date.now() - this.startedAt) / 1000)
            banner.textContent = "Scrape complete in " + elapsed + "s. Closing in 5s…"
            banner.style.background = T.color.mossSoft
            banner.style.color      = T.color.moss
            banner.style.borderColor= T.color.moss
        }
        banner.style.display = "block"
        const closeBtn = this.root && this.root.querySelector(".aes-scrape-modal__close-btn")
        if (closeBtn) {
            closeBtn.style.display = "inline-block"
            closeBtn.textContent = "Close"
        }
        const cancelBtn = this.root && this.root.querySelector(".aes-scrape-modal__cancel-btn")
        if (cancelBtn) cancelBtn.style.display = "none"
        if (!aborted) {
            setTimeout(() => { if (typeof this.onClose === "function") this.onClose() }, 5000)
        }
    }

    onError({message, phase}) {
        this._showBanner("Error" + (phase ? " in " + phase : "") + ": " + message, "alert", false)
    }

    _showBanner(text, kind, sticky) {
        const T = window.AESTokens
        const banner = this.root && this.root.querySelector(".aes-scrape-modal__banner")
        if (!banner) return
        banner.textContent = text
        banner.style.whiteSpace = "pre-line"
        const palette = window.CentralHubStatusBadges._palette(kind || "info")
        banner.style.background  = palette.bg
        banner.style.color       = palette.fg
        banner.style.borderColor = palette.border
        banner.style.display     = "block"
        if (!sticky) {
            setTimeout(() => { if (banner) banner.style.display = "none" }, 5000)
        }
    }

    _updateEta() {
        if (!this.root) return
        const etaEl = this.root.querySelector(".aes-scrape-modal__eta")
        if (!etaEl) return
        const elapsed = (Date.now() - this.startedAt) / 1000
        const totalDone = Object.values(this._completed).reduce((a, b) => a + b, 0)
                        + Object.values(this._failed).reduce((a, b) => a + b, 0)
        if (!totalDone) return
        const totalExpected = Object.values(this._totalCounts).reduce((a, b) => a + b, 0)
        if (!totalExpected) return
        const avgPerJob = elapsed / totalDone
        const remaining = Math.max(0, totalExpected - totalDone)
        const etaSec = Math.round(avgPerJob * remaining)
        etaEl.textContent = "~" + ScrapeProgressModal._fmtDuration(etaSec) + " remaining · "
            + totalDone + " / " + totalExpected + " jobs"
    }

    static _fmtDuration(seconds) {
        if (seconds < 60) return seconds + "s"
        const m = Math.floor(seconds / 60)
        const s = seconds % 60
        return m + "m " + s + "s"
    }

    static _truncate(s, max) {
        if (s.length <= max) return s
        return s.substring(0, max - 1) + "…"
    }

    _buildRoot(T) {
        const overlay = document.createElement("div")
        overlay.className = "aes-scrape-modal-overlay"
        overlay.style.cssText = [
            "position:fixed",
            "inset:0",
            "background:rgba(20, 20, 20, 0.55)",
            "z-index:99997",
            "display:flex",
            "align-items:flex-start",
            "justify-content:center",
            "padding:" + T.sp[4]
        ].join(";")

        const card = document.createElement("div")
        card.className = "aes-scrape-modal-card aes-panel"
        card.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[4],
            "max-width:760px",
            "width:100%",
            "max-height:90vh",
            "overflow-y:auto",
            "font-family:" + T.font.display
        ].join(";")

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:" + T.sp[3] + ";margin-bottom:" + T.sp[3] + ";"
        const heading = document.createElement("h2")
        heading.textContent = "Scrape in progress"
        heading.style.cssText = [
            "margin:0",
            "font-size:" + T.fs.h2,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps
        ].join(";")
        const eta = document.createElement("div")
        eta.className = "aes-scrape-modal__eta"
        eta.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.mono + ";"
        eta.textContent = "starting…"
        header.append(heading, eta)
        card.appendChild(header)

        const banner = document.createElement("div")
        banner.className = "aes-scrape-modal__banner"
        banner.style.cssText = [
            "display:none",
            "padding:" + T.sp[2],
            "margin-bottom:" + T.sp[3],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "font-size:" + T.fs.body
        ].join(";")
        card.appendChild(banner)

        const phases = document.createElement("div")
        phases.className = "aes-scrape-modal__phases"
        phases.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[3] + ";"
        card.appendChild(phases)

        const buttons = document.createElement("div")
        buttons.style.cssText = "display:flex;gap:" + T.sp[2] + ";justify-content:flex-end;"
        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.className = "aes-scrape-modal__cancel-btn"
        cancelBtn.textContent = "Cancel"
        cancelBtn.style.cssText = [
            "background:transparent",
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";")
        cancelBtn.addEventListener("click", () => {
            this.aborted = true
            cancelBtn.disabled = true
            cancelBtn.textContent = "Cancelling…"
            if (typeof this.onCancel === "function") this.onCancel()
        })
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.className = "aes-scrape-modal__close-btn"
        closeBtn.textContent = "Close"
        closeBtn.style.cssText = cancelBtn.style.cssText + ";display:none;"
        closeBtn.addEventListener("click", () => { if (typeof this.onClose === "function") this.onClose() })
        buttons.append(cancelBtn, closeBtn)
        card.appendChild(buttons)

        overlay.appendChild(card)
        return overlay
    }

    _buildPhaseRow(T, phaseId, label) {
        const row = document.createElement("div")
        row.className = "aes-scrape-modal__phase"
        row.dataset.phaseId = phaseId
        row.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2]
        ].join(";")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:" + T.sp[2] + ";"
        const labelEl = document.createElement("span")
        labelEl.textContent = label
        labelEl.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate
        ].join(";")
        const countEl = document.createElement("span")
        countEl.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.micro + ";"
        countEl.textContent = "queued"
        head.append(labelEl, countEl)
        row.appendChild(head)

        const bar = document.createElement("div")
        bar.style.cssText = [
            "height:6px",
            "margin-top:" + T.sp[1],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "position:relative"
        ].join(";")
        const fill = document.createElement("div")
        fill.style.cssText = [
            "height:100%",
            "width:0%",
            "background:" + T.color.rust,
            "transition:width 200ms"
        ].join(";")
        bar.appendChild(fill)
        row.appendChild(bar)

        const current = document.createElement("div")
        current.style.cssText = "margin-top:" + T.sp[1] + ";color:" + T.color.slate
            + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        current.textContent = ""
        row.appendChild(current)

        return {root: row, label: labelEl, count: countEl, bar: bar, fill: fill, current: current}
    }
}

if (typeof window !== "undefined") {
    window.ScrapeProgressModal = ScrapeProgressModal
}
