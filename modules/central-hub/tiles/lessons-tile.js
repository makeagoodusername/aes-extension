"use strict"

/**
 * AES Strategy — Lessons tile (Slice 26 Phase 2).
 *
 * Surface for `AesStrategyLessonMiner.loadAll()`. Each row carries one
 * cluster: distance band × incumbent band × hub × equipment family with
 * its observed favourable rate vs the global rate. Lift > 0 means the
 * cluster outperformed the engine's average; lift < 0 means it
 * underperformed and is a candidate to flag in the next plan.
 *
 * Read-only — no apply path. The lesson rows are informational; the user
 * either reads, dismisses, or feeds the cluster's hint back into the
 * plan via the existing strategy panel.
 *
 * Refresh triggers:
 *   - on tile expand
 *   - on `data:strategy:lesson:mined` bus event
 *   - on storage change at `aesStrategy:lessons:`
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    function _fmtPct(p) {
        if (!isFinite(p)) return "—"
        const sign = p >= 0 ? "+" : ""
        return sign + (p * 100).toFixed(1) + "%"
    }
    function _fmtBand(c) {
        const parts = []
        parts.push((c.distanceBand || "?") + " dist")
        parts.push((c.incumbentBand || "?") + " inc")
        if (c.hub && c.hub !== "*") parts.push("hub " + c.hub)
        if (c.equipFamily && c.equipFamily !== "*") parts.push(c.equipFamily)
        return parts.join(" · ")
    }

    class CentralHubLessonsTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "lessons"
            this.title = "Engine learned"
            this.section = "tools"
            this.priority = 10
            this.requiresAirline = false
            this._cache = null
            this._wired = false
        }

        watchedStorageKeys() { return ["aesStrategy:lessons"] }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    window.CentralHubBus.on("data:strategy:lesson:mined", () => {
                        this._cache = null
                        this.refresh && this.refresh()
                    })
                }
            } catch (_) {}
        }

        async _compute() {
            this._wireBus()
            if (!window.AesStrategyLessonMiner
                    || typeof window.AesStrategyLessonMiner.loadAll !== "function") {
                return {lessons: [], reason: "lesson-miner not loaded"}
            }
            const lessons = await window.AesStrategyLessonMiner.loadAll()
            return {lessons: lessons || [], reason: null}
        }

        async loadStatus() {
            this._cache = await this._compute()
            const KIND = window.CentralHubStatusBadges.KIND
            const lessons = this._cache.lessons
            if (!lessons.length) {
                return {badge: "—", badgeKind: KIND.MUTED, summary: this._cache.reason || "no lessons yet"}
            }
            const flags = lessons.filter(l => l.lift < -0.10).length
            if (flags > 0) {
                return {badge: String(flags), badgeKind: KIND.WARN, summary: flags + " under-performing pattern(s)"}
            }
            return {badge: String(lessons.length), badgeKind: KIND.OK,
                summary: lessons.length + " pattern(s) observed"}
        }

        async renderBody(_ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            if (!this._cache) this._cache = await this._compute()
            const {lessons, reason} = this._cache

            if (!lessons.length) {
                const p = document.createElement("p")
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8")
                    + ";margin:0;font-size:11px;line-height:1.5"
                p.textContent = reason
                    || "No patterns yet. Lessons accrue once outcomes are captured (~1 week after the first apply)."
                hostEl.appendChild(p)
                return
            }

            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px"
            for (const lesson of lessons) {
                list.appendChild(this._renderRow(lesson, T))
            }
            hostEl.appendChild(list)

            const foot = document.createElement("div")
            foot.style.cssText = "margin-top:8px;font-size:10px;color:"
                + (T && T.color.slate || "#94a3b8") + ";line-height:1.4"
            foot.textContent = "Lift = bucket favourable rate − global rate. n ≥ 3 required. Top 10 by |lift|·√n."
            hostEl.appendChild(foot)
        }

        _renderRow(lesson, T) {
            const row = document.createElement("div")
            const positive = lesson.lift >= 0
            const accent = positive ? "#34d399" : "#f87171"
            row.style.cssText = "display:grid;grid-template-columns:1fr 56px 56px;gap:8px;"
                + "align-items:center;padding:6px 8px;background:rgba(148,163,184,0.05);border-radius:3px;"
                + "border-left:3px solid " + accent

            const desc = document.createElement("div")
            desc.style.cssText = "font-size:11.5px;line-height:1.35;overflow:hidden"
            const top = document.createElement("div")
            top.style.cssText = "font-weight:600"
            top.textContent = _fmtBand(lesson.attrCluster)
            desc.appendChild(top)
            const sub = document.createElement("div")
            sub.style.cssText = "font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8")
            sub.textContent = lesson.supportFavorable + " favourable / "
                + lesson.supportUnfavorable + " unfavourable"
            desc.appendChild(sub)
            row.appendChild(desc)

            const lift = document.createElement("div")
            lift.style.cssText = "font-size:11.5px;font-weight:600;color:" + accent + ";text-align:right"
            lift.textContent = _fmtPct(lesson.lift)
            row.appendChild(lift)

            const n = document.createElement("div")
            n.style.cssText = "font-size:11px;color:" + (T && T.color.slate || "#94a3b8") + ";text-align:right"
            n.textContent = "n=" + lesson.n
            row.appendChild(n)

            return row
        }
    }

    window.CentralHubLessonsTile = CentralHubLessonsTile
    if (window.CentralHubTileRegistry
            && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id:       "lessons",
            section:  "tools",
            priority: 10,
            factory:  () => new CentralHubLessonsTile()
        })
    }
})()
