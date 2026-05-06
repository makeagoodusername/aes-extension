/**
 * RouteAssistantRowContextMenu
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantRowContextMenu {
    constructor(panel) {
        this.panel = panel;
    }

open(row, x, y, anchorEl) {
    const existing = document.getElementById("aes-row-context-menu")
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
    const menu = document.createElement("div")
    menu.id = "aes-row-context-menu"
    menu.style.cssText = "position:fixed;background:#0f1623;border:1px solid #374151;"
        + "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);z-index:10000;"
        + "padding:4px 0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:240px;"
    const close = () => {
        if (menu.parentNode) menu.parentNode.removeChild(menu)
        document.removeEventListener("click",   onDocClick, true)
        document.removeEventListener("keydown", onKey)
    }
    const mkItem = (label, fn) => {
        const item = document.createElement("div")
        item.textContent = label
        item.style.cssText = "padding:6px 12px;cursor:pointer;"
        item.addEventListener("mouseenter", () => item.style.background = "#1f2937")
        item.addEventListener("mouseleave", () => item.style.background = "")
        item.addEventListener("click", () => { close(); fn() })
        return item
    }
    const mkSep = () => {
        const sep = document.createElement("div")
        sep.style.cssText = "height:1px;background:#1f2937;margin:4px 0;"
        return sep
    }
    const onDocClick = (e) => { if (!menu.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === "Escape") close() }

    const hubU    = String(this.panel.hubIata || "").toUpperCase()
    const destU   = String(row.destIata || "").toUpperCase()
    const pairKey = hubU + "-" + destU
    const watchlistOn = !!(this.panel._watchlist && this.panel._watchlist.has(pairKey))

    // --- Edit data ---
    menu.append(
        mkItem("Modify yield / LF…",      () => this.panel._openOverrideEditor(row)),
        mkItem("Edit profit modifier…",   () => this.panel._openProfitModifierPopover(row, anchorEl)),
        mkItem("Edit service config…",    () => this.panel._openServiceConfigPopover(row, anchorEl)),
        mkItem(row.routeNoteText ? "Edit note…" : "Add note…",
                                          () => this.panel._openRouteNotePopover(row, anchorEl)),
        mkItem("Interlining…",
                                          () => this.panel._openInterlinePopover(row, anchorEl)),
        mkSep()
    )

    // --- Memory ---
    menu.append(
        mkItem(watchlistOn ? "★ Remove from watchlist" : "☆ Add to watchlist",
                                          () => this.panel._toggleWatchlist(hubU, destU)),
        mkSep()
    )

    // --- Workflow ---
    menu.append(
        mkItem("Open in ORS Sandbox 🧪",  () => this.panel._openInOrsSandbox(row)),
        // Tier 3 — Apply price entry. Always rendered (even before a
        // markets scrape lands) because the modal does its own fresh
        // GET handshake against /app/com/markets/<HUB><DEST>; cached
        // ownPricing only seeds the input defaults. Permanent live mode
        // now leaves the Apply path armed unless rehearsal mode is
        // explicitly enabled.
        mkItem("Apply price…",            () => this.panel._openPricingApplyModal({
            hub: hubU, dest: destU, source: "manual", row
        }))
    )
    // Q10 — Opening checklist for NEW-status routes only.
    if (row && row.status === "NEW") {
        menu.append(mkItem("Opening checklist…", () => this.panel._openRouteOpeningChecklist(row)))
    }
    menu.append(mkSep())

    // --- AS deep-links ---
    const openTab = (path) => () => window.open(path, "_blank")
    menu.append(
        mkItem("↗ Scheduling page",       openTab("/app/com/scheduling/" + hubU + destU)),
        mkItem("↗ Markets page",          openTab("/app/com/markets/"    + hubU + destU)),
        mkItem("↗ ORS info page",         openTab("/app/info/ors")),
        mkSep()
    )

    // --- Clipboard ---
    const writeClip = (text) => async () => {
        try {
            await navigator.clipboard.writeText(text)
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.success("Copied: " + text)
            }
        } catch (e) {
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.error("Copy failed: " + (e && e.message ? e.message : e))
            }
        }
    }
    menu.append(
        mkItem("Copy " + destU,               writeClip(destU)),
        mkItem("Copy " + hubU + "→" + destU,  writeClip(hubU + "→" + destU))
    )

    // U5 multi-select — conditional Add/Remove entry. Only when ≥1
    // route is already selected (avoids cluttering the menu in the
    // 0-selected default case). Avoids duplicating "Edit overrides
    // for N+1" / "Compare with" — those live in the U12 footer.
    const selSize = this.panel._selectedRoutes ? this.panel._selectedRoutes.size : 0
    if (selSize > 0) {
        const inSel = this.panel._selectedRoutes.has(destU)
        const label = inSel
            ? "Remove " + destU + " from selection (" + selSize + ")"
            : "Add " + destU + " to selection (" + selSize + ")"
        menu.append(mkSep(), mkItem(label, () => {
            this.panel._toggleRouteSelection(destU)
            this.panel._selectAnchorDest = destU
            this.panel._renderRows()
        }))
    }

    document.body.appendChild(menu)
    // Position via fixed coords AFTER measuring height — clamp to viewport.
    const vw = window.innerWidth, vh = window.innerHeight
    const mh = menu.offsetHeight || 320, mw = menu.offsetWidth || 240
    menu.style.top  = Math.min(vh - mh - 4, y) + "px"
    menu.style.left = Math.min(vw - mw - 4, x) + "px"
    setTimeout(() => {
        document.addEventListener("click",   onDocClick, true)
        document.addEventListener("keydown", onKey)
    }, 0)
}

/**
 * Right-click drill-in target — pins the route on the sandbox state
 * and enables sandbox mode in one step. Persists `lastRouteIata` and
 * `enabled = true` so the next mount restores the same view.
 */
async _openInOrsSandbox(row) {
    if (!row || !row.destIata) return
    this.panel._orsSandboxRoute  = {hub: this.panel.hubIata, dest: row.destIata, _row: row}
    this.panel._orsSandboxResult = null
    this.panel._orsSandboxPinnedResult = null
    const cfg = Object.assign({}, this.panel.settings.orsSandbox || {})
    cfg.enabled = true
    cfg.lastRouteIata = row.destIata
    this.panel.settings.orsSandbox = cfg
    try { await RouteAssistantSettings.save({orsSandbox: cfg}) } catch (e) { /* non-fatal */ }
    this.panel._render()
}

/**
 * Q10 route opening checklist — small modal listing prerequisites
 * for a NEW-status route + ✓/✗ status per item + "fix this" link.
 * Triggered from the right-click menu when row.status === "NEW".
 *
 * Each item is a derivation against existing row decorations and
 * cached records (no fresh I/O); the "fix this" link is a deep-link
 * or a setting-drawer pointer.
 */
}

window.RouteAssistantRowContextMenu = RouteAssistantRowContextMenu;
