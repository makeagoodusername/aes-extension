"use strict";

/**
 * Unified Settings — Aircraft Flight Plan adapter.
 *
 * AFP's settings live in `modules/aircraft-flight-plan/settings-extension.js`
 * which renders directly into AS's flight plan page DOM. This adapter
 * surfaces a quick-access card with the path to AFP and a brief
 * description so users can find it from the unified settings shell.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;
    const AFP_HINT = "/app/fleets/aircraft/<id>/1";

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Aircraft Flight Plan", "Auto-scheduling, wave layout, maintenance budget."));

        const card = H.card();
        const desc = document.createElement("div");
        desc.style.cssText = "font-size:12px;color:var(--aes-oxide);line-height:1.5;margin-bottom:10px";
        desc.textContent = "AFP settings render inline on each aircraft's flight-plan page. The auto-scheduler, wave strip, and maintenance widgets all live there.";
        card.appendChild(desc);

        card.appendChild(H.row("Page", AFP_HINT));
        card.appendChild(H.row("Active",
            (window.AesAfp && typeof window.AesAfp.isActive === "function" && window.AesAfp.isActive()) ? "yes" : "no"));
        host.appendChild(card);

        const tip = H.notice(
            "To configure AFP behaviour, open any aircraft's flight-plan tab. The settings extension mounts inline."
        );
        host.appendChild(tip);
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "aircraft-flight-plan",
        label:    "Aircraft Flight Plan",
        icon:     "✈",
        mount:    mount
    });
})();
