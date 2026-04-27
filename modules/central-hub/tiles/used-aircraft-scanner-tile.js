"use strict"

/**
 * Used Aircraft Scanner tile — exposes saved presets and the most recent
 * scan session at a glance. The full scanner UI (preset editor + family
 * grid + concurrent tab orchestration) stays in the legacy
 * `displayUsedAircraftScanner()` handler in content_dashboard.js until the
 * CH-4 cutover; the hub provides quick visibility + a one-click route to
 * the AS aircraft market page where the scanner mounts.
 *
 * Reads:
 *   settings.usedAircraftScanner               — UsedAircraftPresets shape
 *   <server>marketScan:<scanId>                — MarketScanSession session
 */
class CentralHubUasTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "used-aircraft-scanner"
        this.title = "Used Scanner"
        this.section = "fleet"
        this.priority = 30
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return [
            "settings",
            (ctx && ctx.server || "") + "marketScan:"
        ]
    }

    openHref() { return "/app/aircraft/market" }

    async _loadBlock() {
        try {
            if (typeof window.UsedAircraftPresets === "function") {
                return await window.UsedAircraftPresets.load()
            }
        } catch (_) { /* fall through */ }
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const block = settings.usedAircraftScanner || {presets: [], lastScanId: null}
        return block
    }

    async _loadLastSession(scanId) {
        if (!scanId) return null
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return null
        try {
            if (typeof window.MarketScanSession === "function") {
                return await window.MarketScanSession.loadSession(server, scanId)
            }
        } catch (_) { /* fall through */ }
        const key = server + "marketScan:" + scanId
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    async loadStatus() {
        const block = await this._loadBlock()
        const session = await this._loadLastSession(block && block.lastScanId)
        const presetCount = (block && block.presets && block.presets.length) || 0

        if (session && session.status === "running") {
            const queue = Array.isArray(session.queue) ? session.queue : []
            const done = queue.filter(q => q.status === "done" || q.status === "error").length
            return {
                badge: "RUNNING",
                badgeKind: window.CentralHubStatusBadges.KIND.WARN,
                summary: "Scan in progress · " + done + " / " + queue.length + " types"
            }
        }
        if (session && session.finishedAt) {
            const when = new Date(session.finishedAt).toISOString().substring(0, 10)
            return {
                badge: presetCount + " PRESETS",
                badgeKind: window.CentralHubStatusBadges.KIND.OK,
                summary: "Last scan " + when + " · " + (session.presetName || "(unnamed)")
            }
        }
        return {
            badge: presetCount ? presetCount + " PRESETS" : "NO PRESETS",
            badgeKind: presetCount
                ? window.CentralHubStatusBadges.KIND.DEFAULT
                : window.CentralHubStatusBadges.KIND.MUTED,
            summary: presetCount
                ? "No completed scans yet — pick a preset and start one."
                : "Save a preset on /app/aircraft/market or via the legacy dashboard."
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const block = await this._loadBlock()
        const presets = (block && block.presets) || []

        if (!presets.length) {
            const note = document.createElement("p")
            note.style.cssText = "color:" + T.color.slate + ";margin:0 0 " + T.sp[2] + " 0;"
            note.textContent = "No presets defined. Use the legacy dashboard ‘Used Aircraft Scanner’ section below to create one."
            host.appendChild(note)
        } else {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[3] + ";"
            for (const p of presets) {
                const chip = document.createElement("span")
                chip.style.cssText = [
                    "display:inline-flex",
                    "align-items:center",
                    "gap:" + T.sp[1],
                    "padding:2px " + T.sp[2],
                    "background:" + T.color.bone2,
                    "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                    "border-radius:" + T.geom.radius,
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.micro,
                    "letter-spacing:" + T.track.mono,
                    "text-transform:uppercase"
                ].join(";")
                const name = document.createElement("span")
                name.textContent = p.name || "(unnamed)"
                const types = document.createElement("span")
                types.style.color = T.color.slate
                types.textContent = "· " + ((p.types && p.types.length) || 0) + " types"
                chip.append(name, types)
                wrap.appendChild(chip)
            }
            host.appendChild(wrap)
        }

        const session = await this._loadLastSession(block && block.lastScanId)
        if (session) {
            const T2 = window.AESTokens
            const note = document.createElement("div")
            note.style.cssText = [
                "padding:" + T2.sp[2] + " " + T2.sp[3],
                "background:" + T2.color.bone2,
                "border:" + T2.geom.bw1 + " solid " + T2.color.paperRule,
                "color:" + T2.color.oxide2,
                "font-family:" + T2.font.mono,
                "font-size:" + T2.fs.body,
                "letter-spacing:" + T2.track.mono
            ].join(";")
            const queue = Array.isArray(session.queue) ? session.queue : []
            const done = queue.filter(q => q.status === "done").length
            const err = queue.filter(q => q.status === "error").length
            const started = session.startedAt ? new Date(session.startedAt).toISOString().substring(0, 16).replace("T", " ") : "?"
            note.textContent = "Last session: " + (session.presetName || "(unnamed)")
                + " · status " + session.status + " · started " + started
                + " · " + done + " ok / " + err + " err / " + queue.length + " total"
            host.appendChild(note)
        }
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "used-aircraft-scanner",
        section: "fleet",
        priority: 30,
        factory: () => new CentralHubUasTile()
    })
}
