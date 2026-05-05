"use strict";

/**
 * Unified Settings — Fleet Command adapter.
 *
 * Quick-access card. Fleet Command's settings live alongside Strategy
 * (shared store via AesStrategySettings); this adapter focuses on the
 * fleet-side toggles and the CTA to open the panel.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Fleet Command", "Bulk fleet planning and apply pipeline."));

        const card = H.card();
        const desc = document.createElement("div");
        desc.style.cssText = "font-size:12px;color:var(--aes-oxide);line-height:1.5;margin-bottom:10px";
        desc.textContent = "Fleet Command shares the strategy tier and apply guards. Edits flow through the strategy settings store; the panel itself is the workspace.";
        card.appendChild(desc);

        const a = H.actions();
        const hasPanel = !!(window.AesFleetCommandPanel && typeof window.AesFleetCommandPanel.open === "function");
        a.appendChild(H.actionBtn("Open Fleet Command →", function () {
            H.closeModalThen(function () {
                if (hasPanel) window.AesFleetCommandPanel.open();
            });
        }, { primary: true, disabled: !hasPanel }));
        card.appendChild(a);

        if (!hasPanel) {
            card.appendChild(H.notice("Fleet Command not loaded on this page. Open the Fleet Hub or any /app/com/* page first."));
        }
        host.appendChild(card);
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "fleet-command",
        label:    "Fleet Command",
        icon:     "◈",
        mount:    mount
    });
})();
