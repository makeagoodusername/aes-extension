/**
 * RouteAssistantConfigMenu
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantConfigMenu {
    constructor(panel) {
        this.panel = panel;
    }

open(anchor) {
    const existing = document.getElementById("aes-config-menu")
    if (existing) { existing.parentNode.removeChild(existing); return }
    const menu = document.createElement("div")
    menu.id = "aes-config-menu"
    menu.style.cssText = "position:absolute;background:#0f1623;border:1px solid #374151;"
        + "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);z-index:10000;"
        + "padding:4px 0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:200px;"
    const rect = anchor.getBoundingClientRect()
    menu.style.top  = (rect.bottom + 4) + "px"
    menu.style.left = (rect.right  - 200) + "px"
    const mkItem = (label, fn) => {
        const item = document.createElement("div")
        item.textContent = label
        item.style.cssText = "padding:6px 12px;cursor:pointer;"
        item.addEventListener("mouseenter", () => item.style.background = "#1f2937")
        item.addEventListener("mouseleave", () => item.style.background = "")
        item.addEventListener("click", () => { close(); fn() })
        return item
    }
    const close = () => {
        if (menu.parentNode) menu.parentNode.removeChild(menu)
        document.removeEventListener("click", onDocClick, true)
        document.removeEventListener("keydown", onKey)
    }
    const onDocClick = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close() }
    const onKey = (e) => { if (e.key === "Escape") close() }
    menu.append(
        mkItem("Export config → file", () => this.panel._exportConfig()),
        mkItem("Import config ← file", () => this.panel._openImportConfig())
    )
    document.body.appendChild(menu)
    setTimeout(() => {
        document.addEventListener("click",   onDocClick, true)
        document.addEventListener("keydown", onKey)
    }, 0)
}

/**
 * U4 — single discoverable entry point for every per-row action.
 * Sections (separated by hairline rules): edit-data, memory
 * (watchlist/note), workflow, AS deep-links, clipboard, multi-
 * select. Items that anchor popovers (profit modifier, service
 * config, route note) re-use the row `<tr>` as anchor so the
 * popover opens beside the row even after the menu has closed.
 */
}

window.RouteAssistantConfigMenu = RouteAssistantConfigMenu;
