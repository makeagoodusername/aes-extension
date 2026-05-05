"use strict"

/**
 * CentralHubSignalWeather — Slice E3 hero band.
 *
 * A compact 3-column severity band that surfaces active strategy +
 * conductor signals seen in the last 24h. Mounts between the activity
 * strip and the hero strip. Read-only: signals are observed via the
 * CentralHubBus topics; no storage writes, no scrapers, no AS POSTs.
 *
 * Topics observed:
 *   signal:strategy:crew-pressure       (severity 0..1, hint payload)
 *   signal:strategy:competitor-threat   (typesPresent[])
 *   signal:strategy:cash-low            (runwayWeeks)
 *   signal:strategy:wear-pressure       (severity, aircraftId)
 *   signal:conductor:tier:promoted      (fromTier → toTier)
 *   signal:conductor:drift              (polarity, magnitude)
 *   signal:conductor:baseline:tick      (informational; ignored visually)
 *   signal:briefing:risk-loaded         (Federation wave)
 *
 * Each event lands as a {topic, ts, severity, label} row. Rows are bucketed
 * into alert / warn / info columns and TTL-decay out at 24h. Click a row →
 * `CentralHubBus.emit("open-tile", …)` to scroll to the originating tile.
 *
 * Settings gate `centralHub.signalWeather.enabled` (default true). When
 * disabled, mount() returns null so shell.js skips appending the row.
 */
class CentralHubSignalWeather {
    static TTL_MS = 24 * 3600 * 1000
    static MAX_PER_BUCKET = 6

    constructor() {
        this.root = null
        this._bus = (typeof window !== "undefined" && window.CentralHubBus) || null
        this._handlers = []
        this._events = []   // {topic, ts, severity, label, focus}
    }

    static _isEnabled() {
        try {
            const s = (typeof window !== "undefined" && window.CentralHubSettings)
                || (typeof window !== "undefined" && window.AesCentralHubSettings)
            const cached = s && typeof s.cached === "function" ? s.cached() : null
            if (cached && cached.signalWeather && cached.signalWeather.enabled === false) return false
        } catch (_) { /* default-on */ }
        return true
    }

    mount() {
        if (!CentralHubSignalWeather._isEnabled()) return null
        if (!this._bus || typeof this._bus.on !== "function") return null
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const root = document.createElement("div")
        root.className = "aes-central-hub__signal-weather"
        root.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(3, 1fr)",
            "gap:6px",
            "padding:6px 12px",
            "border-bottom:1px solid " + (T && T.color && T.color.slate || "rgba(148,163,184,0.18)"),
            "font-size:10.5px",
            "background:" + (T && T.color && T.color.bone || "rgba(15,23,42,0.7)")
        ].join(";")
        this.root = root
        this._renderColumns(T)
        this._subscribe()
        return root
    }

    dispose() {
        for (const {topic, fn} of this._handlers) {
            try { this._bus.off && this._bus.off(topic, fn) } catch (_) {}
        }
        this._handlers = []
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
        this.root = null
    }

    _subscribe() {
        const subs = [
            ["signal:strategy:crew-pressure",      (p) => this._on("strategy", p && p.severity > 0.66 ? "alert" : "warn",
                                                               "Crew pressure" + (p && p.severity ? " · " + (p.severity * 100).toFixed(0) + "%" : ""),
                                                               {tileId: "crew-management"})],
            ["signal:strategy:competitor-threat",  (p) => this._on("strategy", "warn",
                                                               "Competitor activity" + (p && p.routes && p.routes.length ? " · " + p.routes.length + " routes" : ""),
                                                               {tileId: "competitor-intel-hub"})],
            ["signal:strategy:cash-low",           (p) => this._on("strategy", p && p.runwayWeeks < 4 ? "alert" : "warn",
                                                               "Cash runway" + (p && p.runwayWeeks ? " · " + p.runwayWeeks + " wks" : ""),
                                                               {tileId: "accounting"})],
            ["signal:strategy:wear-pressure",      (p) => this._on("strategy", p && p.severity > 0.66 ? "alert" : "warn",
                                                               "Fleet wear" + (p && p.aircraftId ? " · " + p.aircraftId : ""),
                                                               {tileId: "aircraft-flight-plan"})],
            ["signal:conductor:tier:promoted",     (p) => this._on("conductor", "info",
                                                               (p && p.scenarioId ? p.scenarioId + ": " : "") + (p && p.fromTier || "?") + " → " + (p && p.toTier || "?"),
                                                               {tileId: "conductor-trust"})],
            ["signal:conductor:drift",             (p) => this._on("conductor", p && p.polarity === "neg" ? "alert" : "warn",
                                                               (p && p.scenarioId ? p.scenarioId + " drift" : "Drift") + (p && p.magnitude ? " · " + p.magnitude.toFixed(2) : ""),
                                                               {tileId: "drift"})],
            ["signal:briefing:risk-loaded",        (p) => {
                if (!p || !p.count) return
                this._on("briefing", "info", "Briefing: " + p.count + " open risks", {tileId: "strategy-briefing"})
            }]
        ]
        for (const [topic, fn] of subs) {
            try { this._bus.on(topic, fn) }
            catch (_) { continue }
            this._handlers.push({topic, fn})
        }
    }

    _on(category, severity, label, focus) {
        const ts = Date.now()
        this._events.push({category, severity, label, focus, ts})
        // TTL prune.
        const cutoff = ts - CentralHubSignalWeather.TTL_MS
        this._events = this._events.filter(e => e.ts >= cutoff)
        // Cap per bucket from the front (oldest first).
        const buckets = {alert: 0, warn: 0, info: 0}
        const kept = []
        for (let i = this._events.length - 1; i >= 0; i--) {
            const e = this._events[i]
            const sev = e.severity
            if ((buckets[sev] || 0) < CentralHubSignalWeather.MAX_PER_BUCKET) {
                buckets[sev]++
                kept.push(e)
            }
        }
        this._events = kept.reverse()
        if (this.root) this._renderColumns((typeof window !== "undefined" && window.AESTokens) || null)
    }

    _renderColumns(T) {
        if (!this.root) return
        this.root.textContent = ""
        const buckets = {alert: [], warn: [], info: []}
        for (const e of this._events) {
            if (buckets[e.severity]) buckets[e.severity].push(e)
        }
        const cols = [
            ["alert", "#f87171"],
            ["warn",  "#facc15"],
            ["info",  "#60a5fa"]
        ]
        for (const [name, color] of cols) {
            const col = document.createElement("div")
            col.style.cssText = "display:flex;flex-direction:column;gap:3px;min-height:18px"
            const head = document.createElement("div")
            head.style.cssText = "color:" + color + ";font-weight:600;text-transform:uppercase;letter-spacing:0.06em;font-size:9.5px;line-height:1"
            head.textContent = name + (buckets[name].length ? " · " + buckets[name].length : "")
            col.appendChild(head)
            const list = buckets[name].slice().reverse()                  // newest first
            for (const e of list) {
                const row = document.createElement("button")
                row.type = "button"
                row.title = e.category + " · " + new Date(e.ts).toLocaleTimeString()
                row.textContent = e.label
                row.style.cssText = [
                    "background:transparent",
                    "border:none",
                    "color:" + (T && T.color && T.color.text || "#e2e8f0"),
                    "padding:0",
                    "text-align:left",
                    "font-size:10.5px",
                    "cursor:pointer",
                    "white-space:nowrap",
                    "overflow:hidden",
                    "text-overflow:ellipsis"
                ].join(";")
                row.addEventListener("click", () => {
                    if (!e.focus || !this._bus || typeof this._bus.emit !== "function") return
                    try { this._bus.emit("open-tile", e.focus) } catch (_) {}
                })
                col.appendChild(row)
            }
            if (!list.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "color:" + (T && T.color && T.color.slate || "#94a3b8") + ";font-size:10px"
                empty.textContent = "—"
                col.appendChild(empty)
            }
            this.root.appendChild(col)
        }
    }
}

if (typeof window !== "undefined") {
    window.CentralHubSignalWeather = CentralHubSignalWeather
}
