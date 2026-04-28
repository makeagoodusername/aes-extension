"use strict";

/**
 * AES Customization — host.
 *
 * Boots the applier and wires the Studio toggle hotkey. Runs on every
 * AS page (manifest content_scripts, alongside design-tokens.js) so
 * theme changes propagate everywhere.
 *
 * Studio mounting is lazy — panel-shell.js loads on the dashboard /
 * fleets / scheduling pages where it's actually useful. On other pages
 * the hotkey is unbound, which keeps the keyboard-shortcuts registry
 * simple (a single `studio.toggle` action that no-ops when the shell
 * isn't loaded).
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESCustomizationHost) return;

    function bootApplier() {
        const a = window.AESCustomizationApplier;
        if (a && typeof a.boot === "function") a.boot();
    }

    function open() {
        const shell = window.AESCustomizationStudio;
        if (shell && typeof shell.open === "function") {
            shell.open();
            return true;
        }
        return false;
    }

    function close() {
        const shell = window.AESCustomizationStudio;
        if (shell && typeof shell.close === "function") {
            shell.close();
            return true;
        }
        return false;
    }

    function toggle() {
        const shell = window.AESCustomizationStudio;
        if (shell && typeof shell.toggle === "function") {
            shell.toggle();
            return true;
        }
        return false;
    }

    window.AESCustomizationHost = {
        open, close, toggle
    };

    bootApplier();
})();
