"use strict";

/**
 * Unified Settings — Schedule Management adapter.
 *
 * Surfaces the schedule-management presets store summary; full editing
 * happens in the Schedule Management panel embedded on hub pages.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Schedule Management", "Wave templates, composition presets, generation defaults."));

        const card = H.card();
        const status = document.createElement("div");
        status.textContent = "Loading…";
        status.style.cssText = "font-size:12px;color:var(--aes-oxide-2)";
        card.appendChild(status);
        host.appendChild(card);

        const settings = window.AesSettings;
        if (!settings || typeof settings.getArea !== "function") {
            card.textContent = "";
            card.appendChild(H.notice("Settings bridge unavailable on this page."));
            return;
        }

        Promise.resolve(settings.getArea("scheduleManagement")).then(function (s) {
            card.textContent = "";
            const presets = (s && Array.isArray(s.presets)) ? s.presets : [];
            card.appendChild(H.row("Presets",         presets.length));
            card.appendChild(H.row("Default preset",  (s && s.defaultPresetId) || "—"));
            card.appendChild(H.row("Last build",      (s && s.lastBuildId) || "—"));

            const note = document.createElement("div");
            note.style.cssText = "font-size:11px;color:var(--aes-slate);margin-top:10px;line-height:1.5";
            note.textContent = "Edit presets from the Schedule Management panel on a hub page (/app/com/scheduling/*).";
            card.appendChild(note);
        }).catch(function (e) {
            card.textContent = "";
            card.appendChild(H.notice("Failed to load schedule-management settings."));
            console && console.warn && console.warn("[unified-settings sm adapter]", e);
        });
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "schedule-management",
        label:    "Schedule Management",
        icon:     "▦",
        mount:    mount
    });
})();
