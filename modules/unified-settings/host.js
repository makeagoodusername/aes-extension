"use strict";

/**
 * Unified Settings — host (public API).
 *
 * window.AesUnifiedSettings = {
 *   open(opts?), close(), toggle(),
 *   register(moduleSpec),         // proxy to AesUnifiedSettingsRegistry
 *   setActiveTab(tabId),
 *   runSearch(query)
 * }
 *
 * opts: {tab?, moduleId?, deepLinkPath?}
 *   tab         — "customisation" | "modules" | "account" | "data" | "about"
 *   moduleId    — when tab === "modules", which module page to show
 *   deepLinkPath — module-specific anchor id (e.g. "scoring")
 *
 * Lazy-mount: shell.js builds DOM on first open(), tears down on close()
 * so the page stays light when the user isn't looking at settings.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AesUnifiedSettings) return;

    function ensureShell() {
        return window.AesUnifiedSettingsShell || null;
    }

    function open(opts) {
        const shell = ensureShell();
        if (!shell) return;
        shell.open(opts || {});
    }

    function close() {
        const shell = ensureShell();
        if (shell) shell.close();
    }

    function toggle(opts) {
        const shell = ensureShell();
        if (!shell) return;
        if (shell.isOpen && shell.isOpen()) shell.close();
        else shell.open(opts || {});
    }

    function setActiveTab(tabId) {
        const shell = ensureShell();
        if (shell && typeof shell.setActiveTab === "function") {
            shell.setActiveTab(tabId);
        }
    }

    function runSearch(query) {
        const shell = ensureShell();
        if (shell && typeof shell.runSearch === "function") {
            shell.runSearch(query);
        }
    }

    function register(spec) {
        if (!window.AesUnifiedSettingsRegistry) return function () {};
        return window.AesUnifiedSettingsRegistry.register(spec);
    }

    window.AesUnifiedSettings = {
        open,
        close,
        toggle,
        setActiveTab,
        runSearch,
        register
    };
})();
