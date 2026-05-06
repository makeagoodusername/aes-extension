"use strict";

(function () {
    if (typeof window === "undefined") return;
    window.AesUnifiedSettingsTabs = window.AesUnifiedSettingsTabs || {};
    if (window.AesUnifiedSettingsTabs.features) return;

    const TOGGLE_KEY = "aes-feature-toggles";
    const FEATURES = [
        { id: "route-assistant", label: "Route Assistant", desc: "Show the Route Assistant panel on hub pages." },
        { id: "competitor-intel", label: "Competitor Intel", desc: "Enable competitor tracking and threat scoring." },
        { id: "fleet-hub", label: "Fleet Hub", desc: "Enable the Fleet Hub interface." },
        { id: "inventory", label: "Inventory Tweaks", desc: "Enable AES inventory enhancements." },
        { id: "strategy", label: "Strategy Automations", desc: "Enable automated strategy recommendations." },
        { id: "canvas", label: "Schedule Canvas", desc: "Enable the advanced DND Schedule Canvas UI." },
        { id: "dashboard-legacy", label: "Legacy Dashboard Panels", desc: "Enable the legacy full-page dashboard UI (Route Management, Used Aircraft Scanner, etc). Turn off to save memory and hide deprecated features." }
    ];

    async function loadToggles() {
        return new Promise((resolve) => {
            chrome.storage.local.get([TOGGLE_KEY], function(res) {
                resolve(res[TOGGLE_KEY] || {});
            });
        });
    }

    async function saveToggles(toggles) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [TOGGLE_KEY]: toggles }, () => {
                try {
                    localStorage.setItem("aes-feature-toggles-sync", JSON.stringify(toggles));
                } catch(e) {}
                resolve();
            });
        });
    }

    async function render(host, opts) {
        if (!host) return;
        host.textContent = "";

        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:16px;max-width:600px;margin:0 auto;padding:24px 0;";

        const head = document.createElement("div");
        const title = document.createElement("h2");
        title.textContent = "Features";
        title.style.cssText = "margin:0;font-size:18px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--aes-oxide)";
        const sub = document.createElement("div");
        sub.textContent = "Enable or disable large AES modules to save memory or hide features you don't use.";
        sub.style.cssText = "margin-top:4px;color:var(--aes-slate);font-size:12px;line-height:1.4";
        head.append(title, sub);
        wrap.appendChild(head);

        const listEl = document.createElement("div");
        listEl.style.cssText = "display:flex;flex-direction:column;gap:12px;";
        wrap.appendChild(listEl);

        const toggles = await loadToggles();

        for (const feature of FEATURES) {
            const isEnabled = toggles[feature.id] !== false;

            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--aes-bone-2);border:1px solid var(--aes-paper-rule);border-radius:var(--aes-radius);";

            const info = document.createElement("div");
            const name = document.createElement("div");
            name.textContent = feature.label;
            name.style.cssText = "font-weight:700;color:var(--aes-oxide);font-size:14px;";
            const desc = document.createElement("div");
            desc.textContent = feature.desc;
            desc.style.cssText = "font-size:12px;color:var(--aes-slate);margin-top:2px;";
            info.append(name, desc);

            const toggleWrap = document.createElement("label");
            toggleWrap.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = isEnabled;
            const toggleLabel = document.createElement("span");
            toggleLabel.textContent = isEnabled ? "ON" : "OFF";
            toggleLabel.style.cssText = "font-family:var(--aes-font-mono);font-size:12px;font-weight:700;";
            toggleLabel.style.color = isEnabled ? "var(--aes-moss)" : "var(--aes-slate)";

            checkbox.addEventListener("change", async (e) => {
                const checked = e.target.checked;
                toggleLabel.textContent = checked ? "ON" : "OFF";
                toggleLabel.style.color = checked ? "var(--aes-moss)" : "var(--aes-slate)";

                const t = await loadToggles();
                t[feature.id] = checked;
                await saveToggles(t);

                toggleLabel.textContent = "SAVED";
                setTimeout(() => {
                    toggleLabel.textContent = checked ? "ON" : "OFF";
                }, 1000);
            });

            toggleWrap.append(checkbox, toggleLabel);
            row.append(info, toggleWrap);
            listEl.appendChild(row);
        }

        host.appendChild(wrap);
    }

    function teardown() {}

    window.AesUnifiedSettingsTabs.features = { render, teardown };
})();
