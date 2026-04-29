"use strict";

/**
 * Unified Settings — Route Assistant adapter.
 *
 * When an RA panel instance exists, embeds the full settings UI directly
 * into the modal pane via `RouteAssistantPanel#renderSettingsInto(host)`
 * (B-5.1). Falls back to a summary card with a CTA to the legacy drawer
 * when no instance is mounted on the current page.
 *
 * On unmount the adapter calls `unmountModalSettings()` so subsequent
 * re-renders triggered from drawer code go to the drawer DOM, not the
 * (now-removed) modal pane.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;

    function currentInstance() {
        return window.RouteAssistantPanel && window.RouteAssistantPanel._currentInstance;
    }

    function mount(host) {
        if (!host) return;
        host.textContent = "";

        const inst = currentInstance();
        if (inst && typeof inst.renderSettingsInto === "function") {
            inst.renderSettingsInto(host);
            return;
        }

        // Fallback path — no RA panel on this page, render the summary card.
        host.appendChild(H.header("Route Assistant", "Scoring weights, filters, pricing, wave layout, and apply guards."));

        const ns = window.RouteAssistantSettings;
        if (!ns || typeof ns.load !== "function") {
            host.appendChild(H.notice("Route Assistant not loaded on this page. Navigate to a hub or markets page to access its settings."));
            return;
        }

        const card = H.card();
        const status = document.createElement("div");
        status.textContent = "Loading…";
        status.style.cssText = "font-size:12px;color:#5A4F45";
        card.appendChild(status);
        host.appendChild(card);

        Promise.resolve(ns.load()).then(function (s) {
            card.textContent = "";
            card.appendChild(H.row("Panel mode",        s.panelMode || "table"));
            card.appendChild(H.row("Auto-propose",      s.autoProposeEnabled ? "ON" : "off"));
            card.appendChild(H.row("Apply guard",       s.applyGuardEnabled === false ? "off" : "ON"));
            card.appendChild(H.row("Min ORS target",    s.minOrsTarget != null ? String(s.minOrsTarget) : "—"));
            card.appendChild(H.row("Watchlist size",    (window.RouteAssistantWatchlist && typeof window.RouteAssistantWatchlist.size === "function")
                ? window.RouteAssistantWatchlist.size() : "—"));

            const note = document.createElement("div");
            note.style.cssText = "font-size:11px;color:#7A6F66;margin-top:10px;line-height:1.5";
            note.textContent = "Settings drawer requires the RA panel to be visible — open it from a hub page first.";
            card.appendChild(note);
        }).catch(function (e) {
            card.textContent = "";
            card.appendChild(H.notice("Failed to load Route Assistant settings."));
            console && console.warn && console.warn("[unified-settings ra adapter]", e);
        });
    }

    function unmount() {
        const inst = currentInstance();
        if (inst && typeof inst.unmountModalSettings === "function") {
            inst.unmountModalSettings();
        }
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "route-assistant",
        label:    "Route Assistant",
        icon:     "△",
        mount:    mount,
        unmount:  unmount
    });
})();
