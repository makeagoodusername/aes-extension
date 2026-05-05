"use strict"

/**
 * CanvasAdvisorCard — renders one Advisor suggestion in the rail.
 *
 * Severity drives the left border color (info=cobalt, warn=amber,
 * error=crimson). Actions are optional: when set, render a button that
 * runs the action and resolves the suggestion.
 *
 * Resolved suggestions emit `canvas:advisor-suggestion-resolved` so the
 * engine can record the disposition (accepted vs. dismissed) for
 * debouncing and the future "what did the advisor say last time" tab.
 */
class CanvasAdvisorCard {

    static render(suggestion) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const card = document.createElement("article")
        card.className = "aes-canvas-advisor-card"
        card.setAttribute("role", "listitem")
        card.setAttribute("aria-label", "Advisor suggestion: " + (suggestion.kind || "info"))
        card.dataset.suggestionId = suggestion.id || ""
        const sev = suggestion.severity || "info"
        const borderColor = sev === "error" ? (T ? T.color.crimson : "#A02034")
            : sev === "warn"  ? (T ? T.color.amber   : "#B8861F")
            :                    (T ? T.color.cobalt  : "#3656A8")
        card.style.cssText = [
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "border-left:3px solid " + borderColor,
            "padding:8px 10px",
            "display:flex",
            "flex-direction:column",
            "gap:4px"
        ].join(";")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:6px;"
        const sevTag = document.createElement("span")
        sevTag.textContent = sev.toUpperCase()
        sevTag.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;letter-spacing:0.08em;color:" + borderColor + ";"
        const kind = document.createElement("span")
        kind.style.cssText = "flex:1 1 auto;font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        kind.textContent = suggestion.kind || ""
        head.append(sevTag, kind)
        card.append(head)

        const msg = document.createElement("div")
        msg.style.cssText = "font-size:11px;line-height:1.4;color:" + (T ? T.color.oxide : "#2B2520") + ";"
        msg.textContent = suggestion.message || ""
        card.append(msg)

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:6px;margin-top:4px;"
        if (suggestion.action && suggestion.action.label && typeof suggestion.action.run === "function") {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = suggestion.action.label
            btn.style.cssText = CanvasAdvisorCard._btnStyle(T, "primary")
            btn.addEventListener("click", () => {
                try { suggestion.action.run() }
                catch (e) { console.warn("[AES Canvas] advisor action threw", e) }
                CanvasAdvisorCard._resolve(card, suggestion, true)
            })
            actions.append(btn)
        }
        const dismiss = document.createElement("button")
        dismiss.type = "button"
        dismiss.textContent = "Dismiss"
        dismiss.style.cssText = CanvasAdvisorCard._btnStyle(T, "ghost")
        dismiss.addEventListener("click", () => CanvasAdvisorCard._resolve(card, suggestion, false))
        actions.append(dismiss)
        card.append(actions)
        return card
    }

    static _btnStyle(T, kind) {
        const base = [
            "padding:3px 8px",
            "font-size:10px",
            "text-transform:uppercase",
            "letter-spacing:0.06em",
            "cursor:pointer",
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-weight:" + (T ? T.fw.bold : "700")
        ]
        if (kind === "primary") {
            base.push("background:" + (T ? T.color.cobalt : "#3656A8"))
            base.push("color:#fff")
            base.push("border-color:" + (T ? T.color.cobalt : "#3656A8"))
        } else {
            base.push("background:" + (T ? T.color.bone : "#F4F1EA"))
            base.push("color:" + (T ? T.color.oxide : "#2B2520"))
        }
        return base.join(";")
    }

    static _resolve(card, suggestion, accepted) {
        // Record the disposition for debouncing / history.
        try {
            if (typeof window !== "undefined" && window.AesCanvasStateStore && suggestion) {
                const key = suggestion.dedupeKey || (suggestion.kind + ":" + (suggestion.signature || ""))
                if (!accepted) window.AesCanvasStateStore.rememberDismissed(key).catch(() => {})
            }
            if (typeof window !== "undefined" && window.CentralHubBus && suggestion) {
                window.CentralHubBus.emit(window.AesCanvasEvents.ADVISOR_SUGGESTION_RESOLVED,
                    {id: suggestion.id, accepted: !!accepted})
            }
        } catch (_) {}
        if (card && card.parentElement) card.parentElement.removeChild(card)
    }
}

if (typeof window !== "undefined") {
    window.CanvasAdvisorCard = CanvasAdvisorCard
}
