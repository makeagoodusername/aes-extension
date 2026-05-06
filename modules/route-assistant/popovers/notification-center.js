/**
 * RouteAssistantNotificationCenter
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantNotificationCenter {
    constructor(panel) {
        this.panel = panel;
    }

open(anchor) {
    const existing = document.getElementById("aes-notification-center")
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing)
        return
    }
    const popover = document.createElement("div")
    popover.id = "aes-notification-center"
    popover.style.cssText = "position:fixed;background:#0f1623;border:1px solid #374151;"
        + "border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,0.5);z-index:10001;"
        + "padding:0;font:12px/1.4 sans-serif;color:#f3f4f6;min-width:340px;max-width:480px;"
        + "max-height:60vh;display:flex;flex-direction:column;"
    const r = anchor.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    popover.style.top  = Math.min(vh - 80, r.bottom + 4) + "px"
    // Right-align under the button.
    popover.style.left = Math.max(8, Math.min(vw - 350, r.right - 340)) + "px"

    // ---- Header --------------------------------------------------
    const head = document.createElement("div")
    head.style.cssText = "padding:8px 12px;border-bottom:1px solid #374151;"
        + "display:flex;align-items:center;gap:8px;"
    const title = document.createElement("strong")
    title.textContent = "🔔 Notification center"
    title.style.flex = "1"
    head.append(title)

    const history = (typeof RouteAssistantToast !== "undefined")
        ? RouteAssistantToast.getHistory()
        : []
    const count = document.createElement("span")
    count.textContent = history.length + (history.length === 1 ? " toast" : " toasts")
    count.style.cssText = "color:#9ca3af;font-size:11px;"
    head.append(count)

    const clearBtn = document.createElement("button")
    clearBtn.textContent = "Clear"
    clearBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #475569;"
        + "border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;"
    clearBtn.title = "Clear in-session history (does not affect saved data)."
    clearBtn.disabled = !history.length
    if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
    clearBtn.addEventListener("click", () => {
        if (typeof RouteAssistantToast !== "undefined") RouteAssistantToast.clearHistory()
        close()
    })
    head.append(clearBtn)
    popover.append(head)

    // ---- Body --------------------------------------------------
    const body = document.createElement("div")
    body.style.cssText = "overflow-y:auto;padding:4px 0;flex:1;"
    if (!history.length) {
        const empty = document.createElement("div")
        empty.style.cssText = "padding:20px 12px;color:#6b7280;text-align:center;font-size:11px;"
        empty.textContent = "No toasts yet — confirmations will land here as you work."
        body.append(empty)
    } else {
        // Newest first.
        for (let i = history.length - 1; i >= 0; i--) {
            body.append(this.panel._buildNotificationRow(history[i]))
        }
    }
    popover.append(body)

    // ---- Footer hint ------------------------------------------
    const foot = document.createElement("div")
    foot.style.cssText = "padding:6px 10px;border-top:1px solid #374151;color:#6b7280;font-size:10px;"
    foot.textContent = "Click any entry to re-fire its action (when available). History is in-memory — closing the tab clears it."
    popover.append(foot)

    document.body.appendChild(popover)
    const close = () => {
        if (popover.parentNode) popover.parentNode.removeChild(popover)
        document.removeEventListener("click",   onDocClick, true)
        document.removeEventListener("keydown", onKey)
    }
    const onDocClick = (e) => {
        if (popover.contains(e.target)) return
        if (e.target === anchor || (anchor && anchor.contains && anchor.contains(e.target))) return
        close()
    }
    const onKey = (e) => { if (e.key === "Escape") close() }
    setTimeout(() => {
        document.addEventListener("click",   onDocClick, true)
        document.addEventListener("keydown", onKey)
    }, 0)
}

/** Single row in the notification center. */
}

window.RouteAssistantNotificationCenter = RouteAssistantNotificationCenter;
