"use strict";

/**
 * Unified Settings — Competitor Intel adapter.
 *
 * Brief overview card. Full settings editing is in the Competitor
 * Outline panel itself; this adapter is a discovery surface.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Competitor Intel", "Outline scans, rival route tracking, counter-aircraft."));

        const card = H.card();
        const desc = document.createElement("div");
        desc.style.cssText = "font-size:12px;color:var(--aes-oxide);line-height:1.5;margin-bottom:10px";
        desc.textContent = "Competitor Intel watches rival airlines on routes you fly. Settings live alongside the outline panel so they apply within the user's hub context.";
        card.appendChild(desc);

        const a = H.actions();
        const hasPanel = !!(window.AesCompetitorOutlinePanel && typeof window.AesCompetitorOutlinePanel.open === "function");
        a.appendChild(H.actionBtn("Open Competitor Outline →", function () {
            H.closeModalThen(function () {
                if (hasPanel) window.AesCompetitorOutlinePanel.open();
            });
        }, { primary: true, disabled: !hasPanel }));
        card.appendChild(a);

        if (!hasPanel) {
            card.appendChild(H.notice("Competitor Outline not loaded on this page. Navigate to a hub or markets page first."));
        }
        host.appendChild(card);
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "competitor-intel",
        label:    "Competitor Intel",
        icon:     "◬",
        mount:    mount
    });
})();
