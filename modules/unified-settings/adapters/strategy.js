"use strict";

/**
 * Unified Settings — Strategy adapter.
 *
 * Read-only summary of the strategy tier + per-domain enables; deeper
 * editing happens through the existing Strategy panel/tile. No
 * `_renderSettings()` extraction — adapter only consumes the public
 * AesStrategySettings.{load,save,defaults,resolveTier} API.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Strategy", "Tier, risk profile, and per-domain auto-apply gates."));

        const ns = window.AesStrategySettings;
        if (!ns || typeof ns.load !== "function") {
            host.appendChild(H.notice("Strategy not loaded on this page."));
            return;
        }

        const card = H.card();
        const status = document.createElement("div");
        status.textContent = "Loading…";
        status.style.cssText = "font-size:12px;color:#5A4F45";
        card.appendChild(status);
        host.appendChild(card);

        ns.load().then(function (s) {
            card.textContent = "";
            const tier = ns.resolveTier ? ns.resolveTier(s) : (s && s.tier) || "preview-only";
            card.appendChild(H.row("Tier",         tier));
            card.appendChild(H.row("Risk profile", s.riskProfile || "balanced"));
            card.appendChild(H.row("Schedule apply", s.scheduleApplyEnabled ? "ON" : "off"));
            card.appendChild(H.row("Service moves",  s.serviceMovesEnabled  ? "ON" : "off"));
            card.appendChild(H.row("Price moves",    s.priceMovesEnabled    ? "ON" : "off"));
            card.appendChild(H.row("Crew moves",     s.crewMovesEnabled     ? "ON" : "off"));
            card.appendChild(H.row("Route creation", s.routeCreationEnabled ? "ON" : "off"));

            const a = H.actions();
            a.appendChild(H.actionBtn("Open Strategy panel →", function () {
                H.closeModalThen(function () {
                    if (window.AesStrategyTuningPanel && typeof window.AesStrategyTuningPanel.open === "function") {
                        window.AesStrategyTuningPanel.open();
                    } else if (window.AesFleetCommandPanel && typeof window.AesFleetCommandPanel.open === "function") {
                        window.AesFleetCommandPanel.open();
                    }
                });
            }, { primary: true }));
            card.appendChild(a);
        }).catch(function (e) {
            card.textContent = "";
            card.appendChild(H.notice("Failed to load strategy settings."));
            console && console.warn && console.warn("[unified-settings strategy adapter]", e);
        });
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "strategy",
        label:    "Strategy",
        icon:     "◇",
        mount:    mount
    });
})();
