"use strict"

/**
 * Centered floating modal that hosts a SchedulePanel for one aircraft.
 * Replaces the inline-sibling-row pattern from the previous schedule-row.js
 * — focus-grabbing modal, backdrop dim, ESC + click-out + X close.
 *
 * Single-open invariant: opening on aircraft B closes whatever is open
 * for aircraft A first. Modeled on Route Assistant's import-diff modal
 * (modules/route-assistant/panel.js:_showImportDiffModal).
 *
 * SchedulePanel itself is from modules/schedule-management/schedule-panel.js
 * — the constructor takes (rootEl, ctx) so the overlay just hands it a
 * mounting div and the per-aircraft context.
 */
class FleetHubScheduleOverlay {

    static OVERLAY_CLASS = "aes-fleet-hub-schedule-overlay"
    static _activeAircraftId = null
    static _activeOverlayEl = null
    static _activePanel = null
    static _activeKeydown = null

    /**
     * Open the overlay for one aircraft. If it's already open for THIS
     * aircraft, close it (toggle behavior matches the old S inline panel).
     * If it's open for a different one, close that first.
     *
     * @param {object} args - {row: RowRecord, ctx: {server, airlineCode}}
     */
    static async open(args) {
        const row = args && args.row
        const ctx = (args && args.ctx) || {}
        if (!row) return

        const aircraftId = String(row.aircraftId)
        if (FleetHubScheduleOverlay._activeAircraftId === aircraftId) {
            FleetHubScheduleOverlay.close()
            return
        }
        FleetHubScheduleOverlay.close()

        // Backdrop: full-viewport dim, blocks clicks behind. clicking the
        // backdrop (but not the modal) closes — matches Route Assistant's
        // modal precedent.
        const overlay = document.createElement("div")
        overlay.className = FleetHubScheduleOverlay.OVERLAY_CLASS
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);"
            + "z-index:10001;display:flex;align-items:center;justify-content:center;"
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) FleetHubScheduleOverlay.close()
        })

        // Modal — wide enough for the two-column schedule editor; tall but
        // capped so it doesn't overflow on small screens; internal scroll.
        const modal = document.createElement("div")
        modal.style.cssText = "background:#fff;color:#222;border:1px solid #c5cdd6;"
            + "border-radius:6px;box-shadow:0 14px 40px rgba(0,0,0,0.35);"
            + "min-width:720px;width:88vw;max-width:1280px;"
            + "max-height:90vh;display:flex;flex-direction:column;overflow:hidden;"

        // Header strip — context line + close button.
        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px 14px;"
            + "border-bottom:1px solid #e2e6ea;background:#f7f8fa;font-size:13px;"
        const titleEl = document.createElement("div")
        titleEl.style.cssText = "flex:1 1 auto;min-width:0;font-weight:600;color:#222;"
        const hubLabel = row.hub
            ? row.hub
            : "(unknown hub — set the aircraft's location by visiting its Flight Plan tab)"
        titleEl.textContent = "Schedule Management — "
            + (row.registration || row.aircraftId)
            + " · " + (row.equipment || "?")
            + " · hub " + hubLabel
        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.className = "btn btn-default btn-sm"
        closeBtn.textContent = "Close"
        closeBtn.title = "Close (Esc)"
        closeBtn.addEventListener("click", () => FleetHubScheduleOverlay.close())
        header.append(titleEl, closeBtn)

        // Body — internal scroll region; the AFP wave-plan summary mounts
        // first, then SchedulePanel renders the editor underneath.
        const body = document.createElement("div")
        body.style.cssText = "flex:1 1 auto;overflow:auto;padding:14px 16px;background:#fff;"

        const summaryHost = document.createElement("div")
        summaryHost.style.cssText = "margin-bottom:14px;padding:10px 12px;border:1px solid #e2e6ea;"
            + "border-radius:4px;background:#fafbfc;"
        body.appendChild(summaryHost)
        FleetHubScheduleOverlay._renderAfpSummary(summaryHost, row, aircraftId)

        const editorHost = document.createElement("div")
        body.appendChild(editorHost)

        modal.append(header, body)
        overlay.append(modal)
        document.body.appendChild(overlay)

        FleetHubScheduleOverlay._activeAircraftId = aircraftId
        FleetHubScheduleOverlay._activeOverlayEl = overlay

        // ESC closes — capture so we beat any AS handlers below us in the tree.
        FleetHubScheduleOverlay._activeKeydown = (e) => {
            if (e.key === "Escape") {
                e.preventDefault()
                FleetHubScheduleOverlay.close()
            }
        }
        document.addEventListener("keydown", FleetHubScheduleOverlay._activeKeydown, true)

        if (typeof SchedulePanel !== "function") {
            editorHost.innerHTML = "<div class=\"aes-meta\" style=\"color:#a33;\">"
                + "SchedulePanel module is not loaded; cannot render schedule UI."
                + "</div>"
            return
        }

        try {
            const panel = new SchedulePanel(editorHost, {
                server:      ctx.server,
                airlineCode: ctx.airlineCode,
                hub:         row.hub || "",
                aircraftId:  aircraftId
            })
            FleetHubScheduleOverlay._activePanel = panel
            await panel.render()
        } catch (e) {
            console.warn("[AES Fleet Hub] SchedulePanel render failed", e)
            editorHost.innerHTML = "<div class=\"aes-meta\" style=\"color:#a33;\">"
                + "Schedule panel failed to render — see console.</div>"
        }
    }

    /**
     * Slim read-only view of the per-aircraft wave plan written by the AFP
     * page (modules/aircraft-flight-plan/wave-applier.js → AesAfpActiveDraftStore).
     * Lets the user see the drafted plan without leaving the fleets page +
     * jump straight to the AFP page where editing actually happens.
     */
    static async _renderAfpSummary(host, row, aircraftId) {
        // F-9228-606: every interpolation below flows into innerHTML, and
        // several fields originate from user-controlled inputs (preset
        // labels, registrations, IATAs from edit dialogs). Escape every
        // dynamic field before concat. Same pattern as optimizer-drilldown.
        const _esc = (s) => String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        const server = ctx.server
            || (typeof AES !== "undefined" && AES.getServerName && AES.getServerName())
            || ""
        const ctaHref = "/app/fleets/aircraft/" + encodeURIComponent(aircraftId) + "/0"
        const headline = _esc(row.registration || aircraftId) + " · wave plan"
        const noStore = "<div style=\"font-size:12px;color:#666;\">"
            + "<b>" + headline + "</b><br>"
            + "Active-draft store unavailable on this page. "
            + "<a href=\"" + ctaHref + "\" target=\"_blank\" rel=\"noopener\">Open Flight Plan tab</a>."
            + "</div>"
        if (typeof AesAfpActiveDraftStore === "undefined") {
            host.innerHTML = noStore
            return
        }

        let draft = null
        try { draft = await AesAfpActiveDraftStore.load(server, aircraftId) }
        catch (e) { console.warn("[AES Fleet Hub] active-draft load failed", e) }

        const flights = (draft && Array.isArray(draft.flights)) ? draft.flights : []
        const applied = (draft && draft.appliedLegs)   ? Object.keys(draft.appliedLegs).length   : 0
        const dismissed = (draft && draft.dismissedLegs) ? Object.keys(draft.dismissedLegs).length : 0

        const cta = '<a href="' + ctaHref + '" target="_blank" rel="noopener" '
            + 'style="font-size:11px;padding:3px 8px;background:#1d4ed8;color:#fff;'
            + 'border-radius:3px;text-decoration:none;">Open Flight Plan tab →</a>'

        if (!flights.length) {
            host.innerHTML = '<div style="display:flex;align-items:center;gap:10px;">'
                + '<div style="flex:1 1 auto;font-size:12px;color:#444;">'
                + '<b>' + headline + '</b><br>'
                + 'No wave plan saved. Generate one on the per-aircraft page.'
                + '</div>'
                + cta + '</div>'
            return
        }

        const presetLine = (draft.presetId ? "preset " + _esc(draft.presetId) : "(no preset)")
            + (draft.hub ? " · hub " + _esc(draft.hub) : "")
            + " · " + flights.length + " leg" + (flights.length === 1 ? "" : "s")
            + " · " + applied + " applied · " + dismissed + " dismissed"

        const rowsHtml = flights.slice(0, 12).map(f => {
            const isApplied   = !!(draft.appliedLegs   && draft.appliedLegs[f.seq])
            const isDismissed = !!(draft.dismissedLegs && draft.dismissedLegs[f.seq])
            const arrow = (f.direction === "inbound") ? "←" : "→"
            const od = _esc(f.origin || "?") + " " + arrow + " " + _esc(f.destination || "?")
            const time = _esc(f.depTimeLocal || "—")
            const status = isApplied ? '<span style="color:#15803d;">applied</span>'
                          : isDismissed ? '<span style="color:#999;">dismissed</span>'
                          : '<span style="color:#666;">pending</span>'
            return '<tr><td style="padding:2px 6px;">' + _esc(f.waveLabel || f.waveId || "") + '</td>'
                + '<td style="padding:2px 6px;font-weight:600;">' + od + '</td>'
                + '<td style="padding:2px 6px;font-variant-numeric:tabular-nums;">' + time + '</td>'
                + '<td style="padding:2px 6px;">' + status + '</td></tr>'
        }).join("")
        const more = flights.length > 12
            ? '<div style="font-size:10px;color:#999;margin-top:2px;">'
              + '+' + (flights.length - 12) + ' more legs — see Flight Plan tab</div>'
            : ""

        host.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">'
            + '<div style="flex:1 1 auto;font-size:12px;color:#444;">'
            + '<b>' + headline + '</b><br>'
            + '<span style="color:#666;font-size:11px;">' + presetLine + '</span>'
            + '</div>' + cta + '</div>'
            + '<table style="width:100%;border-collapse:collapse;font-size:11px;color:#222;">'
            + rowsHtml + '</table>' + more
    }

    /** Close the currently-open overlay. Idempotent. */
    static close() {
        if (FleetHubScheduleOverlay._activePanel
                && typeof FleetHubScheduleOverlay._activePanel.dispose === "function") {
            try { FleetHubScheduleOverlay._activePanel.dispose() }
            catch (e) { console.warn("[AES Fleet Hub] panel dispose threw", e) }
        }
        if (FleetHubScheduleOverlay._activeKeydown) {
            document.removeEventListener("keydown", FleetHubScheduleOverlay._activeKeydown, true)
        }
        if (FleetHubScheduleOverlay._activeOverlayEl
                && FleetHubScheduleOverlay._activeOverlayEl.parentNode) {
            FleetHubScheduleOverlay._activeOverlayEl.parentNode.removeChild(
                FleetHubScheduleOverlay._activeOverlayEl)
        }
        FleetHubScheduleOverlay._activeAircraftId = null
        FleetHubScheduleOverlay._activeOverlayEl = null
        FleetHubScheduleOverlay._activePanel = null
        FleetHubScheduleOverlay._activeKeydown = null
    }
}

if (typeof window !== "undefined") {
    window.FleetHubScheduleOverlay = FleetHubScheduleOverlay
}
