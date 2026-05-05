"use strict";

/**
 * Command palette tile auto-deriver.
 *
 * Walks CentralHubTileRegistry.all() at load time and synthesises
 * one "open" command per tile. Each command emits open-tile via
 * CentralHubBus, which the shell's existing handler picks up to
 * activate the section, scroll into view, and expand the tile.
 *
 * Re-runs on registry changes (which happen at module load time as
 * each tile module's register() call lands). Uses an idempotent
 * registration set so re-derivation doesn't leak duplicate commands.
 *
 * Only meaningful on pages where central-hub mounts (dashboard) —
 * other pages don't load the tile registry, so this file is a no-op.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AESCommandRegistry) return;
    if (!window.CentralHubTileRegistry) return;
    if (!window.CentralHubBus) return;

    const palette = window.AESCommandPalette;
    const reg = window.AESCommandRegistry;
    const tileReg = window.CentralHubTileRegistry;
    const bus = window.CentralHubBus;
    const registered = new Map();   // tileId → unregister fn

    function tileLabel(id) {
        const stripped = String(id || "").replace(/-tile$/, "");
        const words = stripped.split("-").filter(Boolean);
        if (!words.length) return id;
        return words.map(function (w, i) {
            if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
            return w;
        }).join(" ");
    }

    function syncCommands() {
        let tiles = [];
        try { tiles = tileReg.all(); }
        catch (e) { console && console.warn && console.warn("[palette deriver/tiles]", e); return; }

        const seen = new Set();
        for (const spec of tiles) {
            if (!spec || !spec.id) continue;
            seen.add(spec.id);
            if (registered.has(spec.id)) continue;

            const tileId = spec.id;
            const labelStem = tileLabel(tileId);
            const openUnreg = reg.register({
                id: "tile.open." + tileId,
                scope: "dashboard",
                label: "Open " + labelStem + " tile",
                hint: "Activates section " + (spec.section || "—") + " and expands the tile.",
                keywords: [tileId, spec.section || "", "open", "tile"],
                run: function () {
                    bus.emit("open-tile", {
                        tileId: tileId,
                        expand: true,
                        scrollIntoView: true,
                        source: "command-palette"
                    });
                }
            });
            const focusUnreg = reg.register({
                id: "tile.focus." + tileId,
                scope: "dashboard",
                label: "Focus " + labelStem + " tile",
                hint: "Scrolls the tile into view without expanding it.",
                keywords: [tileId, spec.section || "", "focus", "scroll", "tile"],
                run: function () {
                    bus.emit("open-tile", {
                        tileId: tileId,
                        expand: false,
                        scrollIntoView: true,
                        source: "command-palette"
                    });
                }
            });
            registered.set(tileId, function () { try { openUnreg(); } catch (_) {} try { focusUnreg(); } catch (_) {} });
        }

        // Drop registrations for tiles no longer present
        for (const [tileId, unreg] of Array.from(registered)) {
            if (!seen.has(tileId)) {
                try { unreg(); } catch (_) {}
                registered.delete(tileId);
            }
        }
    }

    /* Initial sync: run after a short tick so any post-load tile
       registrations have a chance to land. Future tile registrations
       trigger another sync via the tile registry subscription below. */
    setTimeout(syncCommands, 0);

    if (typeof tileReg.subscribe === "function") {
        tileReg.subscribe(function () {
            syncCommands();
        });
    }

    /* Back-compat for older tile registry builds, and harmless when the
       registry subscription above is available. */
    if (typeof bus.on === "function") {
        bus.on("tile-registered", syncCommands);
    }

    /* Expose for debugging / forced re-sync. */
    window.AESPaletteTilesDeriver = { sync: syncCommands };

    /* Hotkey legend for tile shortcuts (currently none registered, but
       reserve the section so future per-tile chords slot in cleanly). */
    if (palette && typeof palette.registerLegend === "function") {
        palette.registerLegend({
            sectionId: "tiles",
            entries: [
                { keys: "Cmd-K → \"Open <tile>\"", desc: "Open any registered hub tile from the palette." }
            ]
        });
    }
})();
