"use strict"

/**
 * Route Launcher — aircraft picker UI.
 *
 * Reads the fleet roster via AesFleetRoster.loadCurrent(), groups by hub
 * (resolved from each aircraft's active draft, falling back to "(unknown)"
 * when no draft exists), and renders a clickable list. The selected
 * aircraft is highlighted; clicking another swaps the selection.
 *
 * Pure render module — owns no state, accepts a callback. The controller
 * keeps the active selection.
 */
class AesRouteLauncherAircraftPicker {
    constructor(opts) {
        const o = opts || {}
        this.server      = String(o.server || "")
        this.airlineCode = String(o.airlineCode || "")
        this.onPick      = typeof o.onPick === "function" ? o.onPick : () => {}
        this.activeId    = String(o.activeId || "")
        this._fleet      = null
        this._hubByAcId  = new Map()
    }

    setActive(aircraftId) {
        this.activeId = String(aircraftId || "")
    }

    async render(host) {
        const T = window.AESTokens
        host.textContent = ""
        host.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[1],
            "max-height:300px",
            "overflow-y:auto",
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2]
        ].join(";")

        if (!window.AesFleetRoster) {
            host.appendChild(this._muted(T, "Fleet roster module not loaded."))
            return
        }
        const fleet = await window.AesFleetRoster.loadCurrent()
        this._fleet = fleet
        const aircraft = (fleet && fleet.aircraft) || []
        if (!aircraft.length) {
            host.appendChild(this._muted(T, "No fleet found. Visit /app/fleets to scrape your roster, then come back."))
            return
        }

        await this._resolveHubs(aircraft)
        const groups = this._groupByHub(aircraft)
        for (const [hub, list] of groups) {
            host.appendChild(this._renderGroupHeader(T, hub, list.length))
            for (const a of list) host.appendChild(this._renderRow(T, a, hub))
        }
    }

    _renderGroupHeader(T, hub, count) {
        const h = document.createElement("div")
        h.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.slate,
            "padding:" + T.sp[1] + " 0 " + T.sp[0] + " 0",
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "margin-top:" + T.sp[1]
        ].join(";")
        h.textContent = (hub || "—") + " · " + count
        return h
    }

    _renderRow(T, a, hub) {
        const row = document.createElement("button")
        row.type = "button"
        const isActive = String(a.aircraftId) === this.activeId
        row.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "background:" + (isActive ? T.color.cobaltSoft : "transparent"),
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + (isActive ? T.color.cobalt : "transparent"),
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono,
            "cursor:pointer",
            "text-align:left"
        ].join(";")
        row.dataset.aircraftId = a.aircraftId

        const reg = document.createElement("span")
        reg.textContent = a.registration || "(?)"
        reg.style.cssText = "flex:0 0 100px;font-weight:" + T.fw.bold + ";"

        const eq = document.createElement("span")
        eq.textContent = a.equipment || "(?)"
        eq.style.cssText = "flex:1 1 auto;color:" + T.color.oxide2 + ";min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"

        const id = document.createElement("span")
        id.textContent = "#" + a.aircraftId
        id.style.cssText = "flex:0 0 auto;color:" + T.color.slate + ";font-size:" + T.fs.micro + ";"

        row.append(reg, eq, id)
        row.addEventListener("click", () => {
            this.activeId = String(a.aircraftId)
            this.onPick({aircraftId: String(a.aircraftId), registration: a.registration, equipment: a.equipment, typeId: a.typeId, hub})
        })
        return row
    }

    _muted(T, text) {
        const p = document.createElement("p")
        p.style.cssText = "color:" + T.color.slate + ";margin:" + T.sp[2] + " 0;"
        p.textContent = text
        return p
    }

    async _resolveHubs(aircraft) {
        this._hubByAcId.clear()
        await Promise.all(aircraft.map(async a => {
            if (window.AesAfpActiveDraftStore) {
                try {
                    const d = await window.AesAfpActiveDraftStore.load(this.server, a.aircraftId)
                    if (d && d.hub) this._hubByAcId.set(String(a.aircraftId), d.hub)
                } catch (_) { /* skip */ }
            }
            if (!this._hubByAcId.has(String(a.aircraftId)) && window.AesAfpStateStore) {
                try {
                    const s = await window.AesAfpStateStore.load(this.server, a.aircraftId)
                    const loc = s && /^[A-Z]{3}$/.test(String(s.currentLocationIata || "").toUpperCase())
                        ? String(s.currentLocationIata).toUpperCase() : null
                    if (loc) this._hubByAcId.set(String(a.aircraftId), loc)
                } catch (_) { /* skip */ }
            }
            if (!this._hubByAcId.has(String(a.aircraftId))) {
                const loc = /^[A-Z]{3}$/.test(String(a.location || "").toUpperCase())
                    ? String(a.location).toUpperCase() : null
                if (loc) this._hubByAcId.set(String(a.aircraftId), loc)
            }
        }))
    }

    _groupByHub(aircraft) {
        const groups = new Map()
        for (const a of aircraft) {
            const hub = this._hubByAcId.get(String(a.aircraftId)) || "(unknown)"
            const list = groups.get(hub) || []
            list.push(a)
            groups.set(hub, list)
        }
        return new Map([...groups.entries()].sort((a, b) => {
            if (a[0] === "(unknown)") return 1
            if (b[0] === "(unknown)") return -1
            return a[0].localeCompare(b[0])
        }))
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherAircraftPicker = AesRouteLauncherAircraftPicker
}
