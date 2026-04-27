/**
 * Restructure slice A — Yield heatmap view module.
 *
 * Heatmap view replaces the table with a hubs × destinations matrix
 * coloured by the picked metric (score / profit / market share). The
 * matrix renderer pulls data from each hub's published top-routes
 * snapshot in storage.
 *
 * Slice A delegates straight to the existing `_renderHeatmap`.
 */
class RouteAssistantHeatmapView {

    static get id() { return "heatmap" }
    static get label() { return "Heatmap" }

    static render(panel, sorted) {
        panel._renderHeatmap(sorted)
    }
}
