"use strict";

/**
 * AES Command Palette — legend seed.
 *
 * Boot-time legend population for the four substrate surfaces:
 *   - palette        (Cmd-K, Esc, ↑/↓, Enter, ?)
 *   - navigation     (g g, etc.) — owned by aes-menu but seeded here
 *                    so the legend isn't empty when the user first opens it
 *   - customization  (g c — open Studio)
 *   - settings       (g s — open Unified Settings)
 *
 * Each section is registered idempotently — re-running the seed (e.g.
 * after a hot reload) replaces the entries cleanly because the underlying
 * legend.js stores by sectionId.
 *
 * Also registers the `g g`, `g s`, `g c` chord sequences with the
 * AESPaletteChords buffer when present. Single-key bindings continue to
 * work; the chord buffer is purely additive.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AESCommandPalette) return;
    if (window.__AESPaletteLegendSeeded) return;
    window.__AESPaletteLegendSeeded = true;

    const palette = window.AESCommandPalette;
    const chords  = window.AESPaletteChords;

    function seed(section, entries) {
        if (typeof palette.registerLegend !== "function") return;
        try { palette.registerLegend({sectionId: section, entries: entries}); }
        catch (_) { /* idempotent */ }
    }

    seed("palette", [
        { keys: "Cmd-K / Ctrl-K", desc: "Open command palette." },
        { keys: "Esc",            desc: "Close palette / clear chord buffer." },
        { keys: "↑ / ↓",          desc: "Move selection." },
        { keys: "Enter",          desc: "Run selected command." },
        { keys: "?",              desc: "Open this hotkey reference." }
    ]);

    seed("navigation", [
        { keys: "g g", desc: "Open AES menu (top-nav dropdown)." },
        { keys: "g s", desc: "Open Unified Settings modal." },
        { keys: "g c", desc: "Open Customization Studio." },
        { keys: "Shift-D", desc: "Cycle UI density (compact ↔ comfortable)." }
    ]);

    seed("customization", [
        { keys: "g c",   desc: "Toggle Customization Studio." },
        { keys: "Esc",   desc: "Close Studio (preserves dirty state)." },
        { keys: "1 — 8", desc: "Inside Studio: jump to numbered section." }
    ]);

    seed("settings", [
        { keys: "g s",  desc: "Toggle Unified Settings." },
        { keys: "←/→",  desc: "Switch tabs in the rail." },
        { keys: "Esc",  desc: "Close settings." }
    ]);

    // Wire chord sequences for the 'g _' family if the chord buffer is loaded.
    if (chords && typeof chords.register === "function") {
        chords.register({
            id: "chord:g-g",
            sequence: ["g", "g"],
            run: function () {
                // Open the AES menu dropdown if the menu instance is exposed.
                const menu = document.querySelector(".aes-menu__panel");
                const btn = document.querySelector(".aes-menu__button");
                if (btn && typeof btn.click === "function") {
                    btn.click();
                    return;
                }
                if (menu) menu.style.display = "block";
            }
        });
        chords.register({
            id: "chord:g-s",
            sequence: ["g", "s"],
            available: function () {
                return !!(window.AesUnifiedSettings && typeof window.AesUnifiedSettings.open === "function")
                    || !!(window.AesUnifiedSettingsShell && typeof window.AesUnifiedSettingsShell.open === "function");
            },
            run: function () {
                if (window.AesUnifiedSettings && typeof window.AesUnifiedSettings.open === "function") {
                    window.AesUnifiedSettings.open();
                    return;
                }
                if (window.AesUnifiedSettingsShell && typeof window.AesUnifiedSettingsShell.open === "function") {
                    window.AesUnifiedSettingsShell.open();
                }
            }
        });
        chords.register({
            id: "chord:g-c",
            sequence: ["g", "c"],
            available: function () {
                return !!(window.AESCustomizationHost && typeof window.AESCustomizationHost.toggle === "function")
                    || !!(window.AESCustomizationStudio && typeof window.AESCustomizationStudio.toggle === "function");
            },
            run: function () {
                if (window.AESCustomizationHost && typeof window.AESCustomizationHost.toggle === "function") {
                    window.AESCustomizationHost.toggle();
                    return;
                }
                if (window.AESCustomizationStudio && typeof window.AESCustomizationStudio.toggle === "function") {
                    window.AESCustomizationStudio.toggle();
                }
            }
        });
    }
})();
