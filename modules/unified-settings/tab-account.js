"use strict";

/**
 * Unified Settings — Account tab.
 *
 * Three card CTAs that open existing canopy sub-pages (Orgs, Regions,
 * Roles). Full canopy embedding deferred — those pages already self-mount
 * as full-screen overlays which would conflict with this modal's own
 * close behavior.
 */
(function () {
    if (typeof window === "undefined") return;
    window.AesUnifiedSettingsTabs = window.AesUnifiedSettingsTabs || {};
    if (window.AesUnifiedSettingsTabs.account) return;

    const CARDS = [
        {
            id: "orgs",
            title: "Organisations",
            blurb: "Manage canopy groups (parent/child airline roll-ups).",
            check: function () { return !!window.AesCanopyOrgsSettingsPage; },
            open:  function () { window.AesCanopyOrgsSettingsPage.open(); }
        },
        {
            id: "regions",
            title: "Geographic regions",
            blurb: "Country/region groupings for analytics and exports.",
            check: function () { return !!window.AesCanopyRegionsSettingsPage; },
            open:  function () { window.AesCanopyRegionsSettingsPage.open(); }
        },
        {
            id: "roles",
            title: "Kin roles",
            blurb: "Conglomerate role per airline (alpha/beta/etc).",
            check: function () { return !!window.AesCanopyRolesSettingsPage; },
            open:  function () { window.AesCanopyRolesSettingsPage.open(); }
        },
        {
            id: "dna-template",
            title: "Strategy DNA",
            blurb: "Global template the canopy uses to rank decisions and score fit.",
            check: function () { return !!window.AesCanopyDnaWizard; },
            open:  function () { window.AesCanopyDnaWizard.open({reason: "edit"}); }
        },
        {
            id: "dna-account",
            title: "Per-account DNA",
            blurb: "Override the template per airline (leaf-level inherit/override).",
            check: function () { return !!window.AesCanopyDnaAccountEditor; },
            open:  function () { window.AesCanopyDnaAccountEditor.open(); }
        },
        {
            id: "admin-dashboard",
            title: "Canopy Admin Dashboard",
            blurb: "Top-level overview of conglomerate financial health and combined reserves.",
            check: function () { return !!window.AesCanopyAdminDashboard; },
            open:  function () { window.AesCanopyAdminDashboard.open(); }
        }
    ];

    function render(host) {
        if (!host) return;
        host.textContent = "";

        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:18px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px";

        for (const c of CARDS) {
            const card = document.createElement("div");
            card.style.cssText = [
                "padding:14px 16px",
                "border:2px solid var(--aes-oxide)",
                "background:var(--aes-bone)",
                "box-shadow:4px 4px 0 var(--aes-oxide)",
                "display:flex",
                "flex-direction:column",
                "gap:8px"
            ].join(";");

            const t = document.createElement("div");
            t.textContent = c.title.toUpperCase();
            t.style.cssText = "font-weight:800;font-size:12px;letter-spacing:0.08em;color:var(--aes-oxide)";
            const b = document.createElement("div");
            b.textContent = c.blurb;
            b.style.cssText = "font-size:11px;color:var(--aes-oxide-2);line-height:1.4";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = "Open →";
            btn.style.cssText = [
                "align-self:flex-start",
                "border:1px solid var(--aes-oxide)",
                "background:var(--aes-oxide)",
                "color:var(--aes-bone)",
                "padding:6px 12px",
                "font-family:inherit",
                "font-size:11px",
                "font-weight:700",
                "letter-spacing:0.06em",
                "cursor:pointer"
            ].join(";");
            btn.disabled = !c.check();
            if (btn.disabled) btn.style.opacity = "0.4";
            btn.addEventListener("click", function () {
                if (!c.check()) return;
                if (window.AesUnifiedSettings) window.AesUnifiedSettings.close();
                c.open();
            });

            card.append(t, b, btn);
            wrap.appendChild(card);
        }
        host.appendChild(wrap);
    }

    window.AesUnifiedSettingsTabs.account = { render: render };
})();
