"use strict";

/**
 * Command palette section auto-deriver.
 *
 * Synthesises "Jump to <section>" commands from CentralHubNav.SECTIONS.
 * Each command activates the named section by emitting open-tile with
 * the first tile of that section as the target — cheaper than wiring
 * a second bus event for "section-only" navigation.
 *
 * Dashboard-only; other pages don't load central-hub.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AESCommandRegistry) return;
    if (!window.CentralHubNav) return;
    if (!window.CentralHubBus) return;

    const reg = window.AESCommandRegistry;
    const nav = window.CentralHubNav;
    const bus = window.CentralHubBus;
    const tileReg = window.CentralHubTileRegistry;

    const sections = Array.isArray(nav.SECTIONS) ? nav.SECTIONS : [];

    for (const sec of sections) {
        if (!sec || !sec.id) continue;
        reg.register({
            id: "nav.section." + sec.id,
            scope: "dashboard",
            label: "Jump to " + (sec.label || sec.id),
            hint: "Scroll the dashboard to the " + (sec.label || sec.id).toLowerCase() + " section.",
            keywords: ["section", "nav", "jump", sec.id, sec.label || ""],
            run: function () {
                /* Pick the first tile of the section as the scroll
                   anchor. If the section is empty, no-op gracefully. */
                let anchorTileId = null;
                if (tileReg && typeof tileReg.forSection === "function") {
                    try {
                        const tiles = tileReg.forSection(sec.id);
                        if (tiles && tiles.length) anchorTileId = tiles[0].id;
                    } catch (_) {}
                }
                if (anchorTileId) {
                    bus.emit("open-tile", {
                        tileId: anchorTileId,
                        expand: false,
                        scrollIntoView: true,
                        source: "command-palette:section"
                    });
                }
            }
        });
    }
})();
