"use strict"

/**
 * Compact live status strip for the Station Automation queue + run.
 *
 * Mounted in two places — the Schedule Management panel and the Route
 * Assistant header — so users who enqueued airports through the new
 * OpenStationsModal can see queue size, active-run progress, and the last
 * completed run's outcome without bouncing to the dashboard.
 *
 * The dashboard's Station Automation tab still owns the full per-airport log
 * + run-launch button; this strip is intentionally read-only and summary-only.
 *
 * Live updates: subscribes to chrome.storage.onChanged and re-renders when
 * either the queue record or any per-airport result blob for the active run
 * changes. Worker tabs writing results trigger an immediate strip refresh.
 */
class StationAutomationStatusStrip {
    /**
     * @param {Object} opts
     * @param {string} opts.server
     * @param {string} opts.airlineCode
     * @param {HTMLElement} opts.container — element the strip will live inside
     * @param {"full"|"compact"} [opts.style] — "compact" renders inline text only
     */
    constructor(opts) {
        if (!opts || !opts.server || !opts.airlineCode || !opts.container) {
            throw new Error("StationAutomationStatusStrip: server + airlineCode + container required")
        }
        this.server = opts.server
        this.airlineCode = opts.airlineCode
        this.container = opts.container
        this.style = opts.style === "compact" ? "compact" : "full"

        this._record = null
        this._run = null
        this._results = {}
        this._listener = null
        this._refreshing = false
        this._refreshQueued = false
        this._disposed = false
    }

    async mount() {
        await this._refresh()
        this._listener = (changes, area) => {
            if (area !== "local") return
            const queueKey = this.server + this.airlineCode + "stationAutomationQueue"
            const runPrefix = this.server + this.airlineCode + "stationAutomationRun:"
            for (const k in changes) {
                if (k === queueKey || k.indexOf(runPrefix) === 0) {
                    this._scheduleRefresh()
                    return
                }
            }
        }
        chrome.storage.onChanged.addListener(this._listener)
    }

    dispose() {
        this._disposed = true
        if (this._listener) {
            chrome.storage.onChanged.removeListener(this._listener)
            this._listener = null
        }
    }

    _scheduleRefresh() {
        if (this._refreshing) { this._refreshQueued = true; return }
        this._refresh().catch(err => console.warn("[AES status-strip] refresh failed", err))
    }

    async _refresh() {
        if (this._disposed) return
        this._refreshing = true
        try {
            this._record = await StationAutomationStorage.load(this.server, this.airlineCode)
            const runId = this._record && this._record.activeRunId
            if (runId) {
                this._run = await StationAutomationStorage.loadRun(this.server, this.airlineCode, runId)
                this._results = this._run
                    ? await StationAutomationStorage.loadResults(this.server, this.airlineCode, runId)
                    : {}
            } else {
                this._run = null
                this._results = {}
            }
            this._render()
        } finally {
            this._refreshing = false
            if (this._refreshQueued) {
                this._refreshQueued = false
                this._scheduleRefresh()
            }
        }
    }

    _render() {
        if (this._disposed) return
        const summary = this._summarize()
        this.container.innerHTML = ""

        if (summary.kind === "empty" && this.style === "compact") {
            // Compact: hide entirely when there's nothing to say.
            this.container.style.display = "none"
            return
        }
        this.container.style.display = ""

        if (this.style === "compact") {
            this.container.append(this._renderCompact(summary))
        } else {
            this.container.append(this._renderFull(summary))
        }
    }

    /**
     * Computes the visual state from the queue + run + results.
     * Returns one of:
     *   {kind: "empty"}
     *   {kind: "queued",  airports, countries}
     *   {kind: "running", done, total, ok, existing, skipped, failed, pct}
     *   {kind: "done",    done, total, ok, existing, skipped, failed, finishedAt}
     */
    _summarize() {
        const queue = (this._record && this._record.queue) || []
        const run = this._run

        if (run) {
            const counts = StationAutomationStatusStrip._countResults(this._results)
            const done = Object.keys(this._results).length
            const total = run.total || 0
            const finished = run.status === "done"
                || run.status === "completed"
                || (total > 0 && done >= total)
            const pct = total ? Math.round((done / total) * 100) : 0
            if (finished) {
                return {
                    kind: "done", done, total,
                    ok: counts.ok, existing: counts.existing,
                    skipped: counts.skipped, failed: counts.failed,
                    finishedAt: run.finishedAt || null,
                }
            }
            return {
                kind: "running", done, total, pct,
                ok: counts.ok, existing: counts.existing,
                skipped: counts.skipped, failed: counts.failed,
            }
        }

        if (queue.length) {
            let airports = 0
            for (const e of queue) {
                if (e && e.airportWhitelist && e.airportWhitelist.length) {
                    airports += e.airportWhitelist.length
                }
            }
            return {kind: "queued", countries: queue.length, airports}
        }

        return {kind: "empty"}
    }

    static _countResults(results) {
        const counts = {ok: 0, existing: 0, skipped: 0, failed: 0}
        for (const k in results) {
            const r = results[k]
            const s = r && r.status
            if (s === "ok") counts.ok++
            else if (s === "skipped-existing") counts.existing++
            else if (s === "skipped") counts.skipped++
            else if (s === "failed") counts.failed++
        }
        return counts
    }

    // ---------- Full rendering (Schedule Management panel) ----------

    _renderFull(s) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"
            + "padding:10px 12px;border:1px solid #374151;border-radius:4px;"
            + "background:#0f1623;color:#d1d5db;font-size:12px;"

        if (s.kind === "empty") {
            wrap.style.color = "#6b7280"
            wrap.textContent = "Queue empty. Use the button below to bulk-add airports from scraped data."
            return wrap
        }

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:8px;"
        const dot = document.createElement("span")
        dot.style.cssText = "width:8px;height:8px;border-radius:50%;flex-shrink:0;"
        const label = document.createElement("span")
        label.style.cssText = "font-weight:600;color:#f3f4f6;"

        if (s.kind === "queued") {
            dot.style.background = "#3b82f6"
            label.textContent = "Queued"
            const detail = document.createElement("span")
            detail.style.color = "#9ca3af"
            const cw = s.airports
                ? `${s.airports} airport${s.airports === 1 ? "" : "s"} across ${s.countries} ${s.countries === 1 ? "country" : "countries"}`
                : `${s.countries} ${s.countries === 1 ? "country" : "countries"} (threshold-based)`
            detail.textContent = "— " + cw
            head.append(dot, label, detail, this._spacer(), this._dashboardLink())
            wrap.append(head)
            return wrap
        }

        if (s.kind === "running") {
            dot.style.background = "#fbbf24"
            dot.style.animation = "aes-pulse 1s ease-in-out infinite"
            label.textContent = "Running"
            const detail = document.createElement("span")
            detail.style.color = "#9ca3af"
            detail.textContent = `— ${s.done}/${s.total} processed`
            head.append(dot, label, detail, this._spacer(), this._dashboardLink())
            wrap.append(head)

            wrap.append(this._renderProgressBar(s.pct))
            wrap.append(this._renderCountChips(s, true))
            this._ensurePulseKeyframes()
            return wrap
        }

        // done
        dot.style.background = s.failed ? "#f87171" : "#34d399"
        label.textContent = s.failed ? "Last run (with failures)" : "Last run"
        const detail = document.createElement("span")
        detail.style.color = "#9ca3af"
        detail.textContent = `— ${s.done}/${s.total} processed${s.finishedAt ? " · " + this._relTime(s.finishedAt) : ""}`
        head.append(dot, label, detail, this._spacer(), this._dashboardLink("Details"))
        wrap.append(head)
        wrap.append(this._renderCountChips(s, false))
        return wrap
    }

    _renderProgressBar(pct) {
        const track = document.createElement("div")
        track.style.cssText = "height:6px;background:#1f2937;border-radius:3px;overflow:hidden;"
        const fill = document.createElement("div")
        fill.style.cssText = `height:100%;background:#fbbf24;width:${pct}%;`
            + `transition:width 0.3s ease-out;`
        track.append(fill)
        return track
    }

    _renderCountChips(s, includePending) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;font-size:11px;"
        const chip = (label, value, color) => {
            if (!value && label !== "Opened") return null
            const el = document.createElement("span")
            el.style.cssText = `padding:1px 6px;border-radius:8px;`
                + `background:${color}22;color:${color};border:1px solid ${color}55;`
            el.textContent = `${label} ${value}`
            return el
        }
        const items = [
            chip("Opened",    s.ok,       "#34d399"),
            chip("Existing",  s.existing, "#9ca3af"),
            chip("Skipped",   s.skipped,  "#fbbf24"),
            chip("Failed",    s.failed,   "#f87171"),
        ]
        if (includePending) {
            const pending = Math.max(0, (s.total || 0) - (s.done || 0))
            if (pending) items.push(chip("Pending", pending, "#60a5fa"))
        }
        for (const c of items) if (c) row.append(c)
        return row
    }

    _dashboardLink(label) {
        const a = document.createElement("a")
        a.textContent = label || "Open Station Automation"
        a.href = "#"
        a.style.cssText = "color:#93c5fd;text-decoration:none;font-size:11px;flex-shrink:0;"
        a.addEventListener("click", e => {
            e.preventDefault()
            this._navigateToDashboard()
        })
        return a
    }

    _spacer() {
        const s = document.createElement("span")
        s.style.flex = "1"
        return s
    }

    // ---------- Compact rendering (Route Assistant header) ----------

    _renderCompact(s) {
        const span = document.createElement("span")
        span.style.cssText = "font-size:11px;padding:2px 6px;border-radius:8px;line-height:1.3;"
            + "display:inline-flex;align-items:center;gap:4px;cursor:pointer;"

        if (s.kind === "queued") {
            span.style.background = "#1e3a8a"
            span.style.color = "#bfdbfe"
            span.textContent = `${s.airports || s.countries} queued`
            span.title = `${s.airports || s.countries} airports waiting in the Station Automation queue. Click to open.`
        } else if (s.kind === "running") {
            span.style.background = "#78350f"
            span.style.color = "#fde68a"
            span.textContent = `${s.done}/${s.total} ⏵`
            span.title = `Station Automation running — ${s.done}/${s.total} processed.`
        } else if (s.kind === "done") {
            span.style.background = s.failed ? "#7f1d1d" : "#064e3b"
            span.style.color = s.failed ? "#fecaca" : "#a7f3d0"
            span.textContent = s.failed
                ? `${s.ok}/${s.total} (${s.failed} failed)`
                : `${s.ok}/${s.total} ✓`
            span.title = `Last run: ${s.ok} opened, ${s.existing} existing, ${s.skipped} skipped, ${s.failed} failed.`
        }
        span.addEventListener("click", () => this._navigateToDashboard())
        return span
    }

    // ---------- Helpers ----------

    _navigateToDashboard() {
        // The dashboard URL is the same on every server; preserve the AS host.
        const host = window.location.hostname
        const url = `https://${host}/app/enterprise/dashboard`
        // Open in a new tab so the user doesn't lose their scheduling-page state.
        window.open(url, "_blank")
    }

    _relTime(ms) {
        const diff = Date.now() - ms
        if (diff < 0) return "just now"
        if (diff < 60_000) return "just now"
        if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago"
        if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago"
        return Math.round(diff / 86_400_000) + "d ago"
    }

    _ensurePulseKeyframes() {
        if (document.getElementById("aes-status-strip-keyframes")) return
        const s = document.createElement("style")
        s.id = "aes-status-strip-keyframes"
        s.textContent = "@keyframes aes-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }"
        document.head.append(s)
    }
}
