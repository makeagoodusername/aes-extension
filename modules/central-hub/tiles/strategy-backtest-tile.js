"use strict"

/**
 * Strategy backtest tile (Slice 15).
 *
 * Replays the last N weeks of `AccountingSnapshotStore` through the
 * current strategy weights and shows the engine-vs-actual cumulative
 * P&L delta — "engine would have made $X more / less than what
 * actually happened over the last 12 weeks".
 *
 * The compute lives in `AesStrategyBacktest.run()` (already shipped);
 * this tile is the user-facing surface. Result is cached to
 * `aesStrategy:backtest:lastRun[:acct:<id>]` so the body renders the
 * last numbers without re-running every refresh — the user clicks
 * "Run again" when they want a fresh backtest.
 *
 * No POSTs. Read-only over AccountingSnapshotStore + AesStrategyOutcomes.
 */
class CentralHubStrategyBacktestTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "strategy-backtest"
        this.title = "Strategy Backtest"
        this.section = "tools"
        this.priority = 7
        this.requiresAirline = false
    }

    static KEY_BASE = "aesStrategy:backtest:lastRun"
    static DEFAULT_WEEKS = 12

    watchedStorageKeys() {
        return [CentralHubStrategyBacktestTile.KEY_BASE]
    }

    feedSlices() { return [] }

    static _scopedKey(accountId) {
        return accountId
            ? CentralHubStrategyBacktestTile.KEY_BASE + ":acct:" + accountId
            : CentralHubStrategyBacktestTile.KEY_BASE
    }

    /**
     * BacktestResult shape: {perWeek[], actualCum[], hypotheticalCum?,
     * cumulativeDelta?, summary:{weeksWithData,…notes[]}, durationMs}.
     * No `ok` flag is present — the run() function returns _empty() with
     * notes when the bundle can't be loaded. Treat presence of any
     * weeks-with-data (or a non-empty actualCum) as success.
     */
    static _hasBacktestData(rec) {
        if (!rec || typeof rec !== "object") return false
        const w = rec.summary && Number(rec.summary.weeksWithData)
        if (isFinite(w) && w > 0) return true
        if (Array.isArray(rec.actualCum) && rec.actualCum.length) return true
        if (Array.isArray(rec.perWeek)   && rec.perWeek.length)   return true
        return false
    }

    /**
     * Best-effort one-line reason from a backtest record's notes — used
     * when the badge needs to explain *why* there's no data without
     * ballooning into a full body render.
     */
    static _noteSummary(rec) {
        const notes = rec && rec.summary && Array.isArray(rec.summary.notes)
            ? rec.summary.notes
            : (rec && Array.isArray(rec.notes) ? rec.notes : [])
        if (!notes || !notes.length) return null
        return "Last run · " + notes[0]
    }

    async _loadLast() {
        try {
            const id = window.__aesAccountId || null
            const key = CentralHubStrategyBacktestTile._scopedKey(id)
            const got = await chrome.storage.local.get([key, CentralHubStrategyBacktestTile.KEY_BASE])
            return got[key] || got[CentralHubStrategyBacktestTile.KEY_BASE] || null
        } catch (_) { return null }
    }

    async _saveLast(record) {
        try {
            const id = window.__aesAccountId || null
            const key = CentralHubStrategyBacktestTile._scopedKey(id)
            const writes = {}
            writes[key] = record
            if (!id) writes[CentralHubStrategyBacktestTile.KEY_BASE] = record
            await chrome.storage.local.set(writes)
        } catch (e) {
            console.warn("[AES backtest tile] save failed", e)
        }
    }

    async loadStatus() {
        const KIND = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND
        if (!window.AesStrategyBacktest || typeof window.AesStrategyBacktest.run !== "function") {
            return {badge: "OFF", badgeKind: KIND ? KIND.MUTED : "muted",
                    summary: "AesStrategyBacktest not loaded — open the dashboard."}
        }
        const last = await this._loadLast()
        // BacktestResult shape doesn't carry an `ok` flag (only RecommendResult
        // does). Treat presence of weeks-with-data OR a populated cumulative
        // series as "we have a real backtest", and surface the engine's notes
        // when the run completed with zero weeks (e.g. missing-server-or-airline,
        // no-accounting-history). See modules/strategy/backtest.js _empty().
        if (!last || !CentralHubStrategyBacktestTile._hasBacktestData(last)) {
            const hint = CentralHubStrategyBacktestTile._noteSummary(last)
            return {badge: "—", badgeKind: KIND ? KIND.MUTED : "muted",
                    summary: hint || "No backtest run yet — open the tile to run one."}
        }
        const cumulative = Number(last.cumulativeDelta) || 0
        const sign = cumulative > 0 ? "+" : (cumulative < 0 ? "−" : "")
        const tone = cumulative > 0 ? (KIND ? KIND.OK : "ok")
            : (cumulative < 0 ? (KIND ? KIND.WARN : "warn") : (KIND ? KIND.MUTED : "muted"))
        const ts = last.ts ? new Date(last.ts).toISOString().substring(0, 10) : "?"
        return {
            badge:     sign + "$" + Math.abs(Math.round(cumulative)).toLocaleString(),
            badgeKind: tone,
            summary:   "Last backtest " + ts + " · "
                       + (last.weeks || CentralHubStrategyBacktestTile.DEFAULT_WEEKS) + "wk · "
                       + (cumulative >= 0
                            ? "engine would have outperformed actual"
                            : "engine would have underperformed actual")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""

        if (!window.AesStrategyBacktest || typeof window.AesStrategyBacktest.run !== "function") {
            host.appendChild(this._note(T,
                "AesStrategyBacktest module not loaded on this page."))
            return
        }

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "margin-bottom:" + T.sp[3] + ";"
        const title = document.createElement("strong")
        title.textContent = "12-week replay"
        title.style.cssText = "color:" + T.color.oxide + ";font-family:" + T.font.display
            + ";text-transform:uppercase;letter-spacing:" + T.track.caps
            + ";font-size:" + T.fs.body + ";"
        const runBtn = this._smallBtn(T, "Run backtest")
        runBtn.addEventListener("click", () => this._runAndRender(T, host, runBtn))
        head.append(title, runBtn)
        host.appendChild(head)

        const body = document.createElement("div")
        body.dataset.role = "backtest-body"
        host.appendChild(body)

        const last = await this._loadLast()
        if (last && CentralHubStrategyBacktestTile._hasBacktestData(last)) {
            this._renderResult(T, body, last)
        } else if (last && Array.isArray(last.summary && last.summary.notes) && last.summary.notes.length) {
            // Last run completed but produced no per-week data. Show the
            // engine's notes so the user understands why (e.g.
            // no-accounting-history, missing-server-or-airline).
            this._renderResult(T, body, last)
        } else {
            const hint = document.createElement("div")
            hint.style.cssText = "color:" + T.color.slate + ";font-style:italic;"
                + "font-size:" + T.fs.body + ";"
            hint.textContent = "Click Run backtest to replay the last 12 weeks of accounting "
                + "history through the current strategy weights."
            body.appendChild(hint)
        }
    }

    async _runAndRender(T, host, btn) {
        const body = host.querySelector('[data-role="backtest-body"]')
        if (!body) return
        const oldLabel = btn.textContent
        btn.disabled = true
        btn.textContent = "Running…"
        body.textContent = "Replaying 12 weeks of accounting history…"
        body.style.color = T.color.slate
        body.style.fontStyle = "italic"
        try {
            const ctx = await this._resolveCtx()
            const result = await window.AesStrategyBacktest.run({
                server:      ctx.server,
                airlineCode: ctx.airlineCode,
                weeks:       CentralHubStrategyBacktestTile.DEFAULT_WEEKS,
                accountId:   ctx.accountId
            })
            const stamped = Object.assign({ts: Date.now(),
                weeks: CentralHubStrategyBacktestTile.DEFAULT_WEEKS}, result || {})
            await this._saveLast(stamped)
            body.style.color = T.color.oxide2
            body.style.fontStyle = "normal"
            body.textContent = ""
            this._renderResult(T, body, stamped)
            this.refresh().catch(() => {})
        } catch (e) {
            body.style.color = T.color.crimson || T.color.warn || T.color.oxide
            body.textContent = "Backtest failed: " + ((e && e.message) || String(e))
        } finally {
            btn.disabled = false
            btn.textContent = oldLabel
        }
    }

    async _resolveCtx() {
        const out = {server: null, airlineCode: null, accountId: null}
        try {
            // `AES` is a script-scoped binding from helpers.js (MV3 content
            // scripts don't attach top-level `class` declarations to window),
            // so bare references resolve while window.AES is undefined.
            // Mirrors the pattern used by accounting-tile.js / cash-feed.js.
            if (typeof AES !== "undefined" && typeof AES.getServerName === "function") {
                out.server = AES.getServerName()
            }
            if (typeof AES !== "undefined" && typeof AES.getAirlineIdentity === "function") {
                const id = AES.getAirlineIdentity()
                if (id) out.airlineCode = id.airline || id.code || id
            }
            out.accountId = window.__aesAccountId || null
            if (!out.accountId && window.AesAccountRegistry
                    && typeof window.AesAccountRegistry.computeId === "function"
                    && out.server && out.airlineCode) {
                out.accountId = await window.AesAccountRegistry.computeId(out.server, out.airlineCode)
            }
        } catch (_) { /* best-effort context */ }
        return out
    }

    _renderResult(T, host, result) {
        host.textContent = ""
        // BacktestResult has no `ok` flag — treat "no per-week data" as the
        // failure path, surfacing the engine's `summary.notes` so the user
        // sees the real cause (missing-server-or-airline, no-accounting-
        // history, income-bulk-read-failed, …) instead of the literal
        // word "unknown".
        if (!CentralHubStrategyBacktestTile._hasBacktestData(result)) {
            const notes = (result && result.summary && Array.isArray(result.summary.notes))
                ? result.summary.notes
                : (Array.isArray(result && result.notes) ? result.notes : [])
            const reason = (notes && notes.length) ? notes.join("; ")
                : (result && result.errorNote) || "no per-week data"
            const err = document.createElement("div")
            err.style.cssText = "color:" + T.color.slate + ";"
            err.textContent = "Backtest could not run: " + reason
            host.appendChild(err)
            return
        }
        const cumulative = Number(result.cumulativeDelta) || 0
        const sign = cumulative > 0 ? "+" : (cumulative < 0 ? "−" : "")
        const headline = document.createElement("div")
        headline.style.cssText = "font:600 18px " + T.font.mono
            + ";color:" + (cumulative > 0 ? T.color.oxide : T.color.slate)
            + ";margin-bottom:" + T.sp[2] + ";"
        headline.textContent = "Δ cumulative: " + sign + "$"
            + Math.abs(Math.round(cumulative)).toLocaleString() + " over "
            + (result.weeks || CentralHubStrategyBacktestTile.DEFAULT_WEEKS) + " weeks"
        host.appendChild(headline)

        // Inline ASCII-style chart — simple, no external deps. Each row
        // shows wk-N · actual · hypothetical · delta.
        const actual = Array.isArray(result.actualCum) ? result.actualCum : []
        const hypo   = Array.isArray(result.hypotheticalCum) ? result.hypotheticalCum : []
        if (actual.length) {
            const tbl = document.createElement("table")
            tbl.style.cssText = "border-collapse:collapse;font:12px " + T.font.mono
                + ";color:" + T.color.oxide2 + ";width:100%;"
            const thead = document.createElement("thead")
            const trh = document.createElement("tr")
            for (const h of ["Wk", "Actual cum", "Hypo cum", "Δ"]) {
                const th = document.createElement("th")
                th.textContent = h
                th.style.cssText = "text-align:right;padding:" + T.sp[1] + ";"
                    + "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
                    + "color:" + T.color.slate + ";text-transform:uppercase;letter-spacing:"
                    + T.track.caps + ";"
                trh.appendChild(th)
            }
            thead.appendChild(trh)
            tbl.appendChild(thead)
            const tbody = document.createElement("tbody")
            const len = Math.max(actual.length, hypo.length)
            for (let i = 0; i < len; i++) {
                const tr = document.createElement("tr")
                const a  = isFinite(actual[i]) ? actual[i] : null
                const hv = isFinite(hypo[i])   ? hypo[i]   : null
                const d  = (a != null && hv != null) ? (hv - a) : null
                const cells = [
                    "wk-" + (len - i),
                    a  != null ? "$" + Math.round(a).toLocaleString()  : "—",
                    hv != null ? "$" + Math.round(hv).toLocaleString() : "—",
                    d  != null ? ((d >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(d)).toLocaleString()) : "—"
                ]
                for (let c = 0; c < cells.length; c++) {
                    const td = document.createElement("td")
                    td.textContent = cells[c]
                    td.style.cssText = "text-align:right;padding:" + T.sp[1] + ";"
                        + (c === 3 && d != null
                            ? "color:" + (d >= 0 ? T.color.oxide : T.color.slate) + ";"
                            : "")
                    tr.appendChild(td)
                }
                tbody.appendChild(tr)
            }
            tbl.appendChild(tbody)
            host.appendChild(tbl)
        } else {
            const note = document.createElement("div")
            note.style.cssText = "color:" + T.color.slate + ";font-style:italic;"
            note.textContent = "Replay returned no per-week series — accounting history may be empty."
            host.appendChild(note)
        }

        // Summary footer — top-line aggregates already produced by run().
        if (result.summary && typeof result.summary === "object") {
            const summary = document.createElement("div")
            summary.style.cssText = "margin-top:" + T.sp[2] + ";font-size:" + T.fs.bodySmall
                + ";color:" + T.color.slate + ";"
            const parts = []
            if (result.summary.actualTotal != null) {
                parts.push("actual " + this._fmtMoney(result.summary.actualTotal))
            }
            if (result.summary.hypotheticalTotal != null) {
                parts.push("hypo " + this._fmtMoney(result.summary.hypotheticalTotal))
            }
            if (result.summary.weightSimilarity != null) {
                parts.push("weights " + Math.round(result.summary.weightSimilarity * 100) + "% aligned")
            }
            summary.textContent = parts.join(" · ")
            host.appendChild(summary)
        }
    }

    _fmtMoney(n) {
        const v = Number(n) || 0
        return (v >= 0 ? "$" : "−$") + Math.abs(Math.round(v)).toLocaleString()
    }

    _smallBtn(T, label) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = label
        btn.style.cssText = "background:" + T.color.bone + ";border:" + T.geom.bw1
            + " solid " + T.color.paperRule + ";padding:" + T.sp[1] + " " + T.sp[2]
            + ";font:600 11px " + T.font.display + ";text-transform:uppercase;"
            + "letter-spacing:" + T.track.caps + ";color:" + T.color.oxide + ";cursor:pointer;"
        return btn
    }

    _note(T, text) {
        const d = document.createElement("div")
        d.textContent = text
        d.style.cssText = "color:" + T.color.slate + ";font-style:italic;font-size:" + T.fs.body + ";"
        return d
    }
}

if (typeof window !== "undefined") {
    window.CentralHubStrategyBacktestTile = CentralHubStrategyBacktestTile
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "strategy-backtest",
        section:  "tools",
        priority: 7,
        factory:  () => new CentralHubStrategyBacktestTile()
    })
}
