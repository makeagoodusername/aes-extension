/**
 * Restructure slice A — ORS Sandbox view module.
 *
 * Sandbox view replaces the table with a per-route ORS pricing simulator
 * (price × frequency × comfort sliders → projected rank, share, pax/wk,
 * revenue/wk, profit/wk). Read-only against AS — the sandbox never
 * writes prices back; that's the Auto-Pricing T3 pipeline.
 *
 * Slice A delegates to the existing `_renderOrsSandbox` implementation;
 * the model + observation stores it depends on are unchanged.
 */
class RouteAssistantSandboxView {

    static get id() { return "sandbox" }
    static get label() { return "Sandbox" }

    static render(panel, sorted) {
        panel._renderOrsSandbox(sorted)
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantSandboxView = RouteAssistantSandboxView
}
