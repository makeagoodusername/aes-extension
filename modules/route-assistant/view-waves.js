/**
 * Restructure slice A — Wave view module.
 *
 * Wave view replaces the table with a Gantt-style timeline of the
 * recommended wave structure for the top-N scored rows, built via
 * `ScheduleBuilder` + the user's selected `SchedulePresets` record.
 * The Gantt rendering itself lives in `wave-overlay.js`; the panel's
 * `_renderWaveOverlay` wires the preset picker, hub picker, header
 * and click handlers around it.
 *
 * Slice A keeps the existing panel implementation intact and just
 * routes through here for dispatcher uniformity. Slice D will move
 * the editor (composition spinners, add/remove wave) into a new
 * `wave-editor.js` that this module composes.
 */
class RouteAssistantWaveView {

    static get id() { return "waves" }
    static get label() { return "Waves" }

    /**
     * `_renderWaveOverlay` is async (it loads SchedulePresets on first
     * call). The dispatcher in `_renderRows` doesn't await — render is
     * fire-and-forget; the panel renders header/status synchronously
     * and the wave Gantt populates `tableHost` when the promise lands.
     */
    static render(panel, sorted) {
        return panel._renderWaveOverlay(sorted)
    }
}
