/**
 * Restructure slice A — Table view module.
 *
 * The table is the default Route Assistant view: every scored, filtered,
 * sorted row gets one row in a wide columnar table with COLUMNS-driven
 * cell renderers. This module is a thin dispatcher; the heavy lifting
 * still lives in `RouteAssistantPanel._drawTable` / `_buildTable` /
 * `RouteAssistantPanel.COLUMNS` because those closures reach into ~50
 * other panel methods (popovers, override editors, etc.) and a true
 * extraction is a multi-slice migration.
 *
 * Slice A's contract is *only* to centralise dispatch behind
 * `RouteAssistantPanel._activeView()` so subsequent slices can swap the
 * pill bar UX, error-shell the dispatch, and progressively pull internals
 * into per-mode files without touching `_renderRows`.
 */
class RouteAssistantTableView {

    /** Stable identifier for the dispatcher and the pill selector. */
    static get id() { return "table" }

    /** Display label for the pill selector (slice B). */
    static get label() { return "Table" }

    /**
     * Render the table into the panel's `tableHost`. Delegates straight
     * back to the panel's existing implementation so this slice is a
     * no-op refactor.
     */
    static render(panel, sorted) {
        panel._drawTable(sorted)
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantTableView = RouteAssistantTableView
}
