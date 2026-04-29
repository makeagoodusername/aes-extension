"use strict"

/**
 * Data-flow inspector tile — turns the cross-module data infrastructure
 * (AesDataBus + AesView + AesCleanup) into a live, debuggable artifact.
 *
 * Four panes:
 *   ▸ Recent activity      — the last ~20 bus emits across all topics
 *   ▸ Topics               — every topic with emit count, last-at, source mix
 *   ▸ Views                — every reactive view with deps, compute time, errors
 *   ▸ Caches               — registered cleanup callbacks with last-run-at
 *
 * The header badge shows total emit count; click "Clear" to reset history.
 * While expanded, the body re-renders every 1.5s — the bus is in-memory and
 * doesn't fire chrome.storage.onChanged, so polling is the simplest path.
 *
 * Read-only inspector — no writes. The cleanup-registry's `runOne()` button
 * is the one mutation, gated behind an explicit click.
 */
class CentralHubDataFlowInspectorTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "data-flow-inspector"
        this.title = "Data flow"
        this.section = "tools"
        this.priority = 11   // just after diagnostics (9), before settings
        this.requiresAirline = false

        this._tickTimer = null
        this._lastRenderAt = 0
    }

    async loadStatus() {
        const total = window.AesDataBus
            ? window.AesDataBus.stats().reduce((s, t) => s + t.count, 0)
            : 0
        const viewCount = window.AesView
            ? window.AesView.list().length
            : 0
        const cleanupCount = window.AesCleanup
            ? window.AesCleanup.list().length
            : 0
        const summary = `${total} emits · ${viewCount} views · ${cleanupCount} caches`
        return {
            badge:     window.AesDataBus ? String(total) : "OFF",
            badgeKind: window.AesDataBus ? (total > 0 ? "default" : "muted") : "muted",
            summary:   summary
        }
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        // Refresh header counters when any topic fires.
        if (window.AesDataBus && window.AesDataBus.on) {
            // Wildcard isn't supported — instead, re-render header on a low-rate
            // tick driven by the body when expanded, OR cheaply on every emit by
            // installing a global subscriber. The latter requires walking topic
            // names, so tick-based is simpler.
        }
    }

    toggle() {
        super.toggle()
        if (this.expanded) this._startTick()
        else this._stopTick()
    }

    _startTick() {
        this._stopTick()
        this._tickTimer = setInterval(() => {
            if (this.expanded && this.bodyEl) this._renderBodySafe().catch(() => {})
            this.refresh().catch(() => {})
        }, 1500)
    }

    _stopTick() {
        if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null }
    }

    dispose() {
        this._stopTick()
        super.dispose()
    }

    async renderBody(ctx, hostEl) {
        const T = window.AESTokens
        hostEl.textContent = ""
        hostEl.style.cssText = [
            "padding:" + T.sp[3],
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[3],
            "font-family:" + T.font.display
        ].join(";")

        if (!window.AesDataBus) {
            this._renderEmptyState(hostEl, "Data bus not loaded — foundation missing.")
            return
        }

        hostEl.append(this._renderToolbar())
        hostEl.append(this._renderActivityPane())
        hostEl.append(this._renderTopicsPane())
        hostEl.append(this._renderViewsPane())
        hostEl.append(this._renderCachesPane())

        this._lastRenderAt = Date.now()
    }

    _renderToolbar() {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:" + T.sp[2] + ";align-items:center;"

        const note = document.createElement("span")
        note.style.cssText = "flex:1 1 auto;color:" + T.color.slate + ";font-size:" + T.fs.small + ";"
        note.textContent = "Live trace · refreshing every 1.5s while expanded"
        wrap.append(note)

        wrap.append(this._btn("Clear history", () => {
            window.AesDataBus.clearHistory()
            this._renderBodySafe().catch(() => {})
        }))
        wrap.append(this._btn("Run all cleanups", async () => {
            if (!window.AesCleanup) return
            await window.AesCleanup.runAll({reason: "manual-tile"})
            this._renderBodySafe().catch(() => {})
        }))
        wrap.append(this._btn("Recompute all views", async () => {
            if (!window.AesView) return
            for (const v of window.AesView.list()) window.AesView.invalidate(v.name)
        }))

        return wrap
    }

    _renderActivityPane() {
        const T = window.AESTokens
        const pane = this._pane("Recent activity")
        const events = window.AesDataBus.history({limit: 20})
        if (!events.length) {
            this._renderEmptyState(pane, "No bus activity yet — interact with the panel to see emits.")
            return pane
        }
        const list = document.createElement("div")
        list.style.cssText = [
            "display:grid",
            "grid-template-columns:auto 1fr auto",
            "gap:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "max-height:240px",
            "overflow:auto"
        ].join(";")
        for (const e of events) {
            const t = document.createElement("span")
            t.textContent = this._fmtTime(e.at)
            t.style.color = T.color.slate

            const topic = document.createElement("span")
            topic.textContent = e.topic
            topic.style.cssText = "color:" + T.color.oxide + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            topic.title = JSON.stringify(e, null, 2)

            const src = document.createElement("span")
            src.textContent = e.source === "local" ? "·local" : "·remote"
            src.style.cssText = "color:" + (e.source === "local" ? T.color.moss : T.color.oxide2) + ";"

            list.append(t, topic, src)
        }
        pane.append(list)
        return pane
    }

    _renderTopicsPane() {
        const T = window.AESTokens
        const pane = this._pane("Topics")
        const stats = window.AesDataBus.stats()
        if (!stats.length) {
            this._renderEmptyState(pane, "No topics registered — substrate may have failed to load.")
            return pane
        }
        const list = document.createElement("div")
        list.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr auto auto auto",
            "gap:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small
        ].join(";")
        // Header row
        for (const h of ["Topic", "Count", "Last", "Subs"]) {
            const cell = document.createElement("span")
            cell.textContent = h
            cell.style.cssText = "color:" + T.color.slate + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            list.append(cell)
        }
        for (const s of stats) {
            const topic = document.createElement("span")
            topic.textContent = s.topic
            topic.title = s.topic
            topic.style.cssText = "color:" + T.color.oxide + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"

            const count = document.createElement("span")
            count.textContent = String(s.count)
            count.style.textAlign = "right"

            const last = document.createElement("span")
            last.textContent = s.lastAt ? this._fmtAgo(s.lastAt) : "—"
            last.style.cssText = "color:" + T.color.slate + ";text-align:right;"

            const subs = document.createElement("span")
            subs.textContent = s.hasSubscribers ? "✓" : "—"
            subs.style.cssText = "color:" + (s.hasSubscribers ? T.color.moss : T.color.slate) + ";text-align:center;"

            list.append(topic, count, last, subs)
        }
        pane.append(list)
        return pane
    }

    _renderViewsPane() {
        const T = window.AESTokens
        const pane = this._pane("Reactive views")
        if (!window.AesView) {
            this._renderEmptyState(pane, "View engine not loaded.")
            return pane
        }
        const views = window.AesView.list()
        if (!views.length) {
            this._renderEmptyState(pane, "No views computed. View routes:fuel-context populates after first scoring pass.")
            return pane
        }
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        for (const v of views) {
            const row = document.createElement("div")
            row.style.cssText = [
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "border-radius:" + T.geom.radius,
                "padding:" + T.sp[2],
                "background:" + T.color.bone2,
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.small
            ].join(";")
            const head = document.createElement("div")
            head.style.cssText = "display:flex;gap:" + T.sp[2] + ";align-items:baseline;"
            const name = document.createElement("strong")
            name.textContent = v.name
            name.style.color = T.color.oxide
            const status = document.createElement("span")
            status.textContent = v.error
                ? "ERROR"
                : (v.recomputing ? "computing…"
                    : (v.hasValue ? `${v.computedMs}ms · ${this._fmtAgo(v.computedAt)}` : "pending"))
            status.style.cssText = "color:" + (v.error ? T.color.rust : T.color.slate) + ";flex:1 1 auto;text-align:right;"
            head.append(name, status)
            row.append(head)

            const deps = document.createElement("div")
            deps.style.cssText = "color:" + T.color.slate + ";white-space:pre-wrap;margin-top:" + T.sp[1] + ";"
            deps.textContent = "deps: " + (v.deps.length ? v.deps.join(", ") : "(none)")
            row.append(deps)

            if (v.error) {
                const err = document.createElement("div")
                err.style.cssText = "color:" + T.color.rust + ";margin-top:" + T.sp[1] + ";"
                err.textContent = v.error
                row.append(err)
            }

            const dependents = window.AesView.dependents(v.name)
            if (dependents.length) {
                const dep = document.createElement("div")
                dep.style.cssText = "color:" + T.color.moss + ";margin-top:" + T.sp[1] + ";"
                dep.textContent = "feeds: " + dependents.join(", ")
                row.append(dep)
            }

            list.append(row)
        }
        pane.append(list)
        return pane
    }

    _renderCachesPane() {
        const T = window.AESTokens
        const pane = this._pane("Cache cleanups")
        if (!window.AesCleanup) {
            this._renderEmptyState(pane, "Cleanup registry not loaded.")
            return pane
        }
        const list = window.AesCleanup.list()
        if (!list.length) {
            this._renderEmptyState(pane, "No cleanup runs yet — alarm-driven; first sweep at next 4h tick.")
            return pane
        }
        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr auto auto auto",
            "gap:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small
        ].join(";")
        for (const h of ["Cache", "Last run", "Result", "Actions"]) {
            const cell = document.createElement("span")
            cell.textContent = h
            cell.style.cssText = "color:" + T.color.slate + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";"
            grid.append(cell)
        }
        for (const c of list) {
            const name = document.createElement("span")
            name.textContent = c.name
            name.style.color = T.color.oxide

            const lastRun = document.createElement("span")
            lastRun.textContent = c.lastRunAt ? this._fmtAgo(c.lastRunAt) : "never"
            lastRun.style.cssText = "color:" + T.color.slate + ";text-align:right;"

            const result = document.createElement("span")
            const r = c.lastResult
            if (r && typeof r === "object" && (r.removed != null || r.kept != null)) {
                result.textContent = `−${r.removed || 0} kept ${r.kept || 0}`
            } else if (r && r.error) {
                result.textContent = "error"
                result.style.color = T.color.rust
            } else {
                result.textContent = "—"
            }
            result.style.fontFamily = T.font.mono

            const actions = document.createElement("span")
            const runBtn = this._btn("Run", async () => {
                await window.AesCleanup.runOne(c.name)
                this._renderBodySafe().catch(() => {})
            }, {sm: true})
            actions.append(runBtn)

            grid.append(name, lastRun, result, actions)
        }
        pane.append(grid)
        return pane
    }

    _pane(title) {
        const T = window.AESTokens
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        const h = document.createElement("h4")
        h.textContent = title
        h.style.cssText = [
            "margin:0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate
        ].join(";")
        wrap.append(h)
        return wrap
    }

    _btn(label, onClick, opts) {
        const T = window.AESTokens
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.style.cssText = [
            "background:transparent",
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + ((opts && opts.sm) ? "1px " + T.sp[1] : T.sp[1] + " " + T.sp[2]),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "cursor:pointer"
        ].join(";")
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick() })
        return b
    }

    _fmtTime(at) {
        if (!at) return "—"
        const d = new Date(at)
        const hh = String(d.getHours()).padStart(2, "0")
        const mm = String(d.getMinutes()).padStart(2, "0")
        const ss = String(d.getSeconds()).padStart(2, "0")
        return `${hh}:${mm}:${ss}`
    }

    _fmtAgo(at) {
        if (!at) return "—"
        const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
        if (s < 1) return "just now"
        if (s < 60) return s + "s"
        if (s < 3600) return Math.floor(s / 60) + "m"
        if (s < 86400) return Math.floor(s / 3600) + "h"
        return Math.floor(s / 86400) + "d"
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "data-flow-inspector",
        section:  "tools",
        priority: 11,
        factory:  () => new CentralHubDataFlowInspectorTile()
    })
    window.CentralHubDataFlowInspectorTile = CentralHubDataFlowInspectorTile
}
