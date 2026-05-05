"use strict"

/**
 * ScrapeArchiveModal — dashboard surface for run history and explicit cache
 * cleanup. Reads AesScrapeRunArchiveStore, which owns all storage mutation.
 */
class ScrapeArchiveModal {
    constructor(host) {
        this.host = {
            server:  String((host && host.server) || ""),
            airline: String((host && host.airline) || "")
        }
        this.root = null
        this.body = null
        this.banner = null
        this.range = "today"
        this.keep = "24h"
        this.includeCache = false
        this.runs = []
    }

    static open(host) {
        const modal = new ScrapeArchiveModal(host)
        modal.mount()
        return modal
    }

    mount() {
        if (this.root) return
        const T = ScrapeArchiveModal._tokens()
        const overlay = document.createElement("div")
        overlay.className = "aes-scrape-archive-overlay"
        overlay.style.cssText = [
            "position:fixed",
            "inset:0",
            "background:rgba(20,20,20,0.58)",
            "z-index:99996",
            "display:flex",
            "align-items:flex-start",
            "justify-content:center",
            "padding:" + T.sp[4],
            "box-sizing:border-box"
        ].join(";")

        const card = document.createElement("div")
        card.className = "aes-scrape-archive-card aes-panel"
        card.style.cssText = [
            "width:min(980px,100%)",
            "max-height:90vh",
            "overflow:auto",
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[4],
            "font-family:" + T.font.display,
            "box-sizing:border-box"
        ].join(";")

        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:" + T.sp[3] + ";margin-bottom:" + T.sp[3] + ";"
        const titleWrap = document.createElement("div")
        const title = document.createElement("h2")
        title.textContent = "Scrape cache"
        title.style.cssText = [
            "margin:0",
            "font-size:" + T.fs.h2,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps
        ].join(";")
        const subtitle = document.createElement("div")
        subtitle.textContent = (this.host.server || "?") + " / " + (this.host.airline || "?")
        subtitle.style.cssText = "margin-top:" + T.sp[1] + ";color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.mono + ";"
        titleWrap.append(title, subtitle)
        const close = ScrapeArchiveModal._button(T, "Close", "ghost")
        close.addEventListener("click", () => this.unmount())
        header.append(titleWrap, close)
        card.appendChild(header)

        this.banner = document.createElement("div")
        this.banner.style.cssText = [
            "display:none",
            "margin-bottom:" + T.sp[3],
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "font-size:" + T.fs.body
        ].join(";")
        card.appendChild(this.banner)

        card.appendChild(this._buildControls(T))

        this.body = document.createElement("div")
        this.body.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        card.appendChild(this.body)

        overlay.appendChild(card)
        document.body.appendChild(overlay)
        this.root = overlay
        this.reload()
    }

    unmount() {
        if (!this.root) return
        try { document.body.removeChild(this.root) } catch (_) {}
        this.root = null
        this.body = null
        this.banner = null
    }

    _buildControls(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "align-items:flex-end",
            "justify-content:space-between",
            "gap:" + T.sp[3],
            "flex-wrap:wrap",
            "margin-bottom:" + T.sp[3],
            "padding-bottom:" + T.sp[3],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
        ].join(";")

        const left = document.createElement("div")
        left.style.cssText = "display:flex;align-items:flex-end;gap:" + T.sp[2] + ";flex-wrap:wrap;"
        const range = this._select(T, "Show", [
            ["today", "Today"],
            ["24h", "24 hours"],
            ["7d", "7 days"],
            ["all", "All"]
        ], this.range)
        range.select.addEventListener("change", () => {
            this.range = range.select.value
            this.reload()
        })
        const refresh = ScrapeArchiveModal._button(T, "Refresh", "ghost")
        refresh.addEventListener("click", () => this.reload())
        left.append(range.wrap, refresh)

        const right = document.createElement("div")
        right.style.cssText = "display:flex;align-items:flex-end;gap:" + T.sp[2] + ";flex-wrap:wrap;"
        const keep = this._select(T, "Keep", [
            ["1h", "Last hour"],
            ["6h", "Last 6 hours"],
            ["24h", "Last 24 hours"],
            ["today", "Today"],
            ["7d", "Last 7 days"],
            ["none", "Nothing"]
        ], this.keep)
        keep.select.addEventListener("change", () => { this.keep = keep.select.value })

        const cacheLabel = document.createElement("label")
        cacheLabel.style.cssText = "display:flex;align-items:center;gap:" + T.sp[1] + ";font-size:" + T.fs.body + ";color:" + T.color.oxide2 + ";"
        const cacheInput = document.createElement("input")
        cacheInput.type = "checkbox"
        cacheInput.checked = this.includeCache
        cacheInput.title = "Also remove scrape cache keys from cleared runs when no retained run still references them."
        cacheInput.addEventListener("change", () => { this.includeCache = cacheInput.checked })
        const cacheText = document.createElement("span")
        cacheText.textContent = "Remove touched data"
        cacheText.title = cacheInput.title
        cacheLabel.append(cacheInput, cacheText)

        const clear = ScrapeArchiveModal._button(T, "Clear", "primary")
        clear.title = "Clear archive records older than the selected retention window."
        clear.addEventListener("click", () => this.clear())
        right.append(keep.wrap, cacheLabel, clear)

        wrap.append(left, right)
        return wrap
    }

    _select(T, label, options, value) {
        const wrap = document.createElement("label")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.mono + ";"
        const text = document.createElement("span")
        text.textContent = label
        const select = document.createElement("select")
        select.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        for (const opt of options) {
            const node = document.createElement("option")
            node.value = opt[0]
            node.textContent = opt[1]
            select.appendChild(node)
        }
        select.value = value
        wrap.append(text, select)
        return {wrap, select}
    }

    async reload() {
        if (!this.body) return
        if (!window.AesScrapeRunArchiveStore) {
            this.body.textContent = "Archive store not loaded."
            return
        }
        this.body.textContent = "Loading..."
        try {
            this.runs = await window.AesScrapeRunArchiveStore.list({
                host: this.host,
                sinceMs: this._rangeStart(),
                limit: 80
            })
            this.render()
        } catch (e) {
            this.body.textContent = "Failed to load scrape records."
        }
    }

    render() {
        if (!this.body) return
        const T = ScrapeArchiveModal._tokens()
        this.body.textContent = ""
        if (!this.runs.length) {
            const empty = document.createElement("div")
            empty.textContent = "No scrape records in this window."
            empty.style.cssText = "padding:" + T.sp[3] + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";border-radius:" + T.geom.radius + ";color:" + T.color.slate + ";"
            this.body.appendChild(empty)
            return
        }
        for (const run of this.runs) {
            this.body.appendChild(this._runRow(T, run))
        }
    }

    _runRow(T, run) {
        const details = document.createElement("details")
        details.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2],
            "background:" + T.color.bone2
        ].join(";")

        const summary = document.createElement("summary")
        summary.style.cssText = "cursor:pointer;list-style:none;display:flex;align-items:center;gap:" + T.sp[2] + ";flex-wrap:wrap;"
        const status = run.aborted ? "aborted" : (run.haltReason ? "halted" : "done")
        const statusEl = document.createElement("span")
        statusEl.textContent = status
        statusEl.style.cssText = [
            "text-transform:uppercase",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "color:" + (status === "done" ? T.color.moss : T.color.amber)
        ].join(";")
        const main = document.createElement("span")
        main.style.cssText = "font-weight:" + T.fw.display + ";"
        main.textContent = (run.source || "manual") + " - " + ScrapeArchiveModal._fmtDate(run.startedAt)
        const counts = document.createElement("span")
        counts.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + T.color.oxide2 + ";letter-spacing:" + T.track.mono + ";"
        counts.textContent = (run.totals.succeeded || 0) + "/" + (run.totals.total || 0)
            + " jobs" + (run.totals.failed ? " - " + run.totals.failed + " failed" : "")
            + " - " + (run.storageKeys || []).length + " keys"
        const duration = document.createElement("span")
        duration.style.cssText = counts.style.cssText
        duration.textContent = ScrapeArchiveModal._fmtDuration(Math.round((run.durationMs || 0) / 1000))
        summary.append(statusEl, main, counts, duration)
        details.appendChild(summary)

        const phaseGrid = document.createElement("div")
        phaseGrid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:" + T.sp[2] + ";margin-top:" + T.sp[2] + ";"
        const phases = run.perPhase || {}
        for (const id of Object.keys(phases)) {
            const p = phases[id]
            const cell = document.createElement("div")
            cell.style.cssText = "background:" + T.color.bone + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";border-radius:" + T.geom.radius + ";padding:" + T.sp[2] + ";"
            const name = document.createElement("div")
            name.textContent = p.label || id
            name.style.cssText = "font-weight:" + T.fw.display + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";font-size:" + T.fs.body + ";"
            const meta = document.createElement("div")
            meta.textContent = p.skipped ? "skipped" : ((p.succeeded || 0) + "/" + (p.total || 0) + " ok" + (p.failed ? " - " + p.failed + " failed" : ""))
            meta.style.cssText = "margin-top:4px;color:" + T.color.oxide2 + ";font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.mono + ";"
            cell.append(name, meta)
            phaseGrid.appendChild(cell)
        }
        details.appendChild(phaseGrid)

        if (run.failedJobs && run.failedJobs.length) {
            details.appendChild(this._textBlock(T, "Failures", run.failedJobs.slice(0, 20).map(f =>
                (f.phaseId || "?") + " / " + (f.jobId || "?") + " - " + (f.error || "failed")
            )))
        }
        if (run.storageKeys && run.storageKeys.length) {
            details.appendChild(this._textBlock(T, "Touched keys", run.storageKeys.slice(0, 120)))
        }
        return details
    }

    _textBlock(T, label, lines) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:" + T.sp[2] + ";"
        const title = document.createElement("div")
        title.textContent = label
        title.style.cssText = "font-weight:" + T.fw.display + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";font-size:" + T.fs.body + ";margin-bottom:4px;"
        const pre = document.createElement("pre")
        pre.textContent = lines.join("\n")
        pre.style.cssText = [
            "margin:0",
            "max-height:180px",
            "overflow:auto",
            "white-space:pre-wrap",
            "word-break:break-word",
            "background:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide2
        ].join(";")
        wrap.append(title, pre)
        return wrap
    }

    async clear() {
        if (!window.AesScrapeRunArchiveStore) return
        const cutoff = this._keepCutoff()
        const targetText = this.keep === "none"
            ? "all scrape records"
            : "scrape records older than " + this._keepLabel()
        const cacheText = this.includeCache ? " and touched cached data" : ""
        if (!confirm("Clear " + targetText + cacheText + "?")) return
        try {
            const result = await window.AesScrapeRunArchiveStore.clearBefore(cutoff, {
                host: this.host,
                includeCache: this.includeCache
            })
            this._showBanner("Cleared " + result.removedRecords + " records"
                + (this.includeCache ? " and " + result.removedCacheKeys + " cache keys." : "."))
            await this.reload()
        } catch (e) {
            this._showBanner("Clear failed: " + ((e && e.message) || String(e)), true)
        }
    }

    _showBanner(text, warn) {
        if (!this.banner) return
        const T = ScrapeArchiveModal._tokens()
        this.banner.textContent = text
        this.banner.style.display = "block"
        this.banner.style.background = warn ? T.color.amberSoft : T.color.mossSoft
        this.banner.style.color = warn ? T.color.amber : T.color.moss
        this.banner.style.borderColor = warn ? T.color.amber : T.color.moss
    }

    _rangeStart() {
        if (!window.AesScrapeRunArchiveStore) return 0
        if (this.range === "today") return window.AesScrapeRunArchiveStore.startOfToday()
        if (this.range === "24h") return Date.now() - 24 * 60 * 60 * 1000
        if (this.range === "7d") return Date.now() - 7 * 24 * 60 * 60 * 1000
        return 0
    }

    _keepCutoff() {
        if (this.keep === "none") return Infinity
        if (this.keep === "today" && window.AesScrapeRunArchiveStore) return window.AesScrapeRunArchiveStore.startOfToday()
        const map = {
            "1h":  1 * 60 * 60 * 1000,
            "6h":  6 * 60 * 60 * 1000,
            "24h": 24 * 60 * 60 * 1000,
            "7d":  7 * 24 * 60 * 60 * 1000
        }
        return Date.now() - (map[this.keep] || map["24h"])
    }

    _keepLabel() {
        const map = {
            "1h": "the last hour",
            "6h": "the last 6 hours",
            "24h": "the last 24 hours",
            "today": "today",
            "7d": "the last 7 days"
        }
        return map[this.keep] || "the selected window"
    }

    static _button(T, text, kind) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = text
        const primary = kind === "primary"
        btn.style.cssText = [
            "background:" + (primary ? T.color.oxide : "transparent"),
            "color:" + (primary ? T.color.bone : T.color.oxide),
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";")
        return btn
    }

    static _fmtDate(ts) {
        if (!ts) return "-"
        try { return new Date(ts).toLocaleString() } catch (_) { return "-" }
    }

    static _fmtDuration(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return "0s"
        if (seconds < 60) return seconds + "s"
        const m = Math.floor(seconds / 60)
        const s = seconds % 60
        if (m < 60) return m + "m " + s + "s"
        const h = Math.floor(m / 60)
        return h + "h " + (m % 60) + "m"
    }

    static _tokens() {
        return window.AESTokens || {
            sp: {1: "4px", 2: "8px", 3: "12px", 4: "16px"},
            fs: {micro: "11px", body: "13px", h2: "20px"},
            fw: {display: "700"},
            track: {caps: "0.06em", mono: "0"},
            font: {display: "sans-serif", mono: "monospace"},
            geom: {bw1: "1px", bw2: "2px", radius: "4px"},
            color: {
                bone: "#faf7ef",
                bone2: "#f3efe5",
                oxide: "#26211d",
                oxide2: "#4e4640",
                slate: "#6b7280",
                paperRule: "#d8d0c3",
                moss: "#3f7f4f",
                mossSoft: "#e7f4ea",
                amber: "#9a5b00",
                amberSoft: "#fff4d4"
            }
        }
    }
}

if (typeof window !== "undefined") {
    window.ScrapeArchiveModal = ScrapeArchiveModal
}
