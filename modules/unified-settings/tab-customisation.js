"use strict";

/**
 * Unified Settings — Customisation tab.
 *
 * Embeds the existing AESCustomizationStudio (rail + canvas split) inside
 * the modal's canvas. The studio's slide-out drawer (`g c`) is unaffected;
 * this is a second mount path via AESCustomizationStudio.renderInto(host).
 */
(function () {
    if (typeof window === "undefined") return;
    window.AesUnifiedSettingsTabs = window.AesUnifiedSettingsTabs || {};
    if (window.AesUnifiedSettingsTabs.customisation) return;

    function render(host) {
        if (!host) return;
        host.textContent = "";
        const studio = window.AESCustomizationStudio;
        if (studio && typeof studio.renderInto === "function") {
            studio.renderInto(host);
            return;
        }
        const ph = document.createElement("div");
        ph.style.cssText = "padding:32px;text-align:center;color:var(--aes-slate);font-style:italic";
        ph.textContent = "Customization Studio unavailable.";
        host.appendChild(ph);
    }

    window.AesUnifiedSettingsTabs.customisation = { render: render };
})();
