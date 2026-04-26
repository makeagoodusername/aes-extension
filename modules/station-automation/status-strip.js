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
 *
 * Visual styling consumes design-tokens.css + components.css primitives
 * (.aes-dot, .aes-badge, .aes-progress, .aes-link). Zero hardcoded hex.
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
        wrap.className = "aes-status-strip"
        wrap.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:var(--aes-sp-1)",
            "padding:var(--aes-sp-2) var(--aes-sp-3)",
            "border:var(--aes-bw-1) solid var(--aes-paper-rule)",
            "background:var(--aes-bone-2)",
            "color:var(--aes-oxide)",
            "font-family:var(--aes-font-display)",
            "font-size:var(--aes-fs-body)"
        ].join(";")

        if (s.kind === "empty") {
            wrap.style.color = "var(--aes-slate)"
            wrap.style.fontStyle = "italic"
            wrap.textContent = "QUEUE EMPTY — USE BUTTON BELOW TO BULK-ADD AIRPORTS."
            wrap.style.textTransform = "uppercase"
            wrap.style.letterSpacing = "var(--aes-tracking-caps)"
            wrap.style.fontSize = "var(--aes-fs-small)"
            return wrap
        }

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:var(--aes-sp-2);"

        const dot = document.createElement("span")
        dot.className = "aes-dot " + this._dotVariantFor(s)

        const label = document.createElement("span")
        label.style.cssText = [
            "font-family:var(--aes-font-display)",
            "font-weight:var(--aes-fw-display)",
            "text-transform:uppercase",
            "letter-spacing:var(--aes-tracking-caps)",
            "font-size:var(--aes-fs-small)",
            "color:var(--aes-oxide)"
        ].join(";")

        const detail = document.createElement("span")
        detail.style.cssText = [
            "font-family:var(--aes-font-mono)",
            "font-size:var(--aes-fs-small)",
            "color:var(--aes-oxide-2)",
            "letter-spacing:var(--aes-tracking-mono)"
        ].join(";")

        if (s.kind === "queued") {
            label.textContent = "QUEUED"
            const cw = s.airports
                ? `${s.airports} airport${s.airports === 1 ? "" : "s"} across ${s.countries} ${s.countries === 1 ? "country" : "countries"}`
                : `${s.countries} ${s.countries === 1 ? "country" : "countries"} (threshold-based)`
            detail.textContent = "— " + cw.toUpperCase()
            head.append(dot, label, detail, this._spacer(), this._dashboardLink())
            wrap.append(head)
            return wrap
        }

        if (s.kind === "running") {
            label.textContent = "RUNNING"
            detail.textContent = `— ${s.done}/${s.total} PROCESSED`
            head.append(dot, label, detail, this._spacer(), this._dashboardLink())
            wrap.append(head)
            wrap.append(this._renderProgressBar(s.pct, "amber"))
            wrap.append(this._renderCountChips(s, true))
            return wrap
        }

        // done
        label.textContent = s.failed ? "LAST RUN — FAILURES" : "LAST RUN"
        detail.textContent = `— ${s.done}/${s.total} PROCESSED${s.finishedAt ? " · " + this._relTime(s.finishedAt) : ""}`
        head.append(dot, label, detail, this._spacer(), this._dashboardLink("DETAILS"))
        wrap.append(head)
        wrap.append(this._renderCountChips(s, false))
        return wrap
    }

    _dotVariantFor(s) {
        if (s.kind === "queued")  return "aes-dot--info"
        if (s.kind === "running") return "aes-dot--warn"
        if (s.kind === "done")    return s.failed ? "aes-dot--error" : "aes-dot--success"
        return ""
    }

    _renderProgressBar(pct, variantHint) {
        const track = document.createElement("div")
        const variant = variantHint ? "aes-progress--" + variantHint : ""
        track.className = ("aes-progress " + variant).trim()
        const fill = document.createElement("div")
        fill.className = "aes-progress__fill"
        fill.style.width = pct + "%"
        track.append(fill)
        return track
    }

    _renderCountChips(s, includePending) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:var(--aes-sp-1);flex-wrap:wrap;"
        const chip = (label, value, variant) => {
            if (!value && label !== "OPENED") return null
            const el = document.createElement("span")
            el.className = "aes-badge" + (variant ? " aes-badge--" + variant : "")
            el.textContent = `${label} ${value}`
            return el
        }
        const items = [
            chip("OPENED",   s.ok,       "moss"),
            chip("EXISTING", s.existing, ""),
            chip("SKIPPED",  s.skipped,  "amber"),
            chip("FAILED",   s.failed,   "crimson"),
        ]
        if (includePending) {
            const pending = Math.max(0, (s.total || 0) - (s.done || 0))
            if (pending) items.push(chip("PENDING", pending, "cobalt"))
        }
        for (const c of items) if (c) row.append(c)
        return row
    }

    _dashboardLink(label) {
        const a = document.createElement("a")
        a.textContent = label || "OPEN STATION AUTOMATION"
        a.href = "#"
        a.className = "aes-link"
        a.style.cssText = [
            "font-family:var(--aes-font-display)",
            "font-size:var(--aes-fs-micro)",
            "font-weight:var(--aes-fw-bold)",
            "text-transform:uppercase",
            "letter-spacing:var(--aes-tracking-caps)",
            "flex-shrink:0",
            "white-space:nowrap"
        ].join(";")
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
        span.className = "aes-badge"
        span.style.cssText = "cursor:pointer;display:inline-flex;align-items:center;gap:var(--aes-sp-1);"

        if (s.kind === "queued") {
            span.classList.add("aes-badge--cobalt")
            span.textContent = `${s.airports || s.countries} QUEUED`
            span.title = `${s.airports || s.countries} airports waiting in the Station Automation queue. Click to open.`
        } else if (s.kind === "running") {
            span.classList.add("aes-badge--amber")
            span.textContent = `${s.done}/${s.total} ⏵`
            span.title = `Station Automation running — ${s.done}/${s.total} processed.`
        } else if (s.kind === "done") {
            if (s.failed) {
                span.classList.add("aes-badge--crimson")
                span.textContent = `${s.ok}/${s.total} (${s.failed} FAILED)`
            } else {
                span.classList.add("aes-badge--moss")
                span.textContent = `${s.ok}/${s.total} ✓`
            }
            span.title = `Last run: ${s.ok} opened, ${s.existing} existing, ${s.skipped} skipped, ${s.failed} failed.`
        }
        span.addEventListener("click", () => this._navigateToDashboard())
        return span
    }

    // ---------- Helpers ----------

    _navigateToDashboard() {
        const host = window.location.hostname
        const url = `https://${host}/app/enterprise/dashboard`
        window.open(url, "_blank")
    }

    _relTime(ms) {
        const diff = Date.now() - ms
        if (diff < 0) return "JUST NOW"
        if (diff < 60_000) return "JUST NOW"
        if (diff < 3_600_000) return Math.round(diff / 60_000) + "M AGO"
        if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "H AGO"
        return Math.round(diff / 86_400_000) + "D AGO"
    }
}
