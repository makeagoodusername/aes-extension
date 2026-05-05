"use strict";

/**
 * Cross-page command-trigger repairs.
 *
 * The command-palette core now loads on every AS app/action page. This
 * late-loaded shim keeps the global keyboard affordances aligned with the
 * navbar markup exposed by modules/aes-menu.js.
 */
;(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.__aesCommandPaletteGlobalTriggerFixes) return;
    window.__aesCommandPaletteGlobalTriggerFixes = true;

    function openAesMenu() {
        const trigger = document.querySelector(".aes-menu__trigger");
        if (trigger && typeof trigger.click === "function") {
            trigger.click();
            return;
        }

        const panel = document.querySelector(".aes-menu__panel");
        if (!panel) return;
        const container = panel.closest("li");
        if (container) {
            container.classList.add("open", "show");
        }
        panel.style.display = "block";
    }

    function registerChord() {
        const chords = window.AESPaletteChords;
        if (!chords || typeof chords.register !== "function") return false;
        chords.register({
            id: "chord:g-g",
            sequence: ["g", "g"],
            run: openAesMenu
        });
        return true;
    }

    if (registerChord()) return;

    let waited = 0;
    const timer = setInterval(function () {
        waited += 100;
        if (registerChord() || waited >= 5000) clearInterval(timer);
    }, 100);
})();
