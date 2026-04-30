"use strict";

/**
 * Unified Settings — Modules tab.
 *
 * Renders a second-level rail of registered module adapters from
 * AesUnifiedSettingsRegistry. Clicking an adapter calls its mount(host)
 * into the right-hand pane. Empty registry shows an explanatory note —
 * adapters land in B-5.
 */
(function () {
    if (typeof window === "undefined") return;
    window.AesUnifiedSettingsTabs = window.AesUnifiedSettingsTabs || {};
    if (window.AesUnifiedSettingsTabs.modules) return;

    let activeId = null;
    let activeUnmount = null;

    function tokens() { return window.AESTokens; }

    function render(host, opts) {
        if (!host) return;
        host.textContent = "";
        if (opts && opts.moduleId) activeId = String(opts.moduleId);

        const reg = window.AesUnifiedSettingsRegistry;
        const list = reg ? reg.list() : [];

        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;min-height:0;height:100%";

        const rail = document.createElement("nav");
        rail.style.cssText = [
            "flex:0 0 220px",
            "border-right:1px solid var(--aes-paper-rule)",
            "background:var(--aes-bone)",
            "overflow-y:auto",
            "padding:8px 0"
        ].join(";");

        const pane = document.createElement("section");
        pane.style.cssText = "flex:1 1 auto;overflow:auto;padding:18px 20px;background:var(--aes-bone)";

        if (!list.length) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding:32px;text-align:center;color:var(--aes-slate);font-style:italic";
            empty.textContent = "No module adapters registered yet.";
            pane.appendChild(empty);
        } else {
            for (const m of list) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.dataset.moduleId = m.moduleId;
                btn.textContent = (m.icon ? m.icon + "  " : "") + m.label;
                btn.style.cssText = railItemStyle(m.moduleId === activeId);
                btn.addEventListener("click", function () {
                    selectModule(m.moduleId, list, rail, pane);
                });
                rail.appendChild(btn);
            }

            // Default selection: explicit moduleId, else first in list.
            const target = activeId && list.some(function (m) { return m.moduleId === activeId; })
                ? activeId : list[0].moduleId;
            selectModule(target, list, rail, pane);
        }

        wrap.append(rail, pane);
        host.appendChild(wrap);
    }

    function selectModule(moduleId, list, rail, pane) {
        if (typeof activeUnmount === "function") {
            try { activeUnmount(); } catch (_) {}
            activeUnmount = null;
        }
        activeId = moduleId;
        Array.from(rail.children).forEach(function (b) {
            b.style.cssText = railItemStyle(b.dataset.moduleId === moduleId);
        });
        pane.textContent = "";
        const entry = list.find(function (m) { return m.moduleId === moduleId; });
        if (!entry) return;
        try {
            entry.mount(pane);
            if (entry.unmount) {
                activeUnmount = function () { entry.unmount(pane); };
            }
        } catch (e) {
            console && console.warn && console.warn("[unified-settings module]", moduleId, e);
            pane.textContent = "Module failed to render.";
        }
    }

    function railItemStyle(active) {
        return [
            "display:block",
            "width:100%",
            "padding:10px 14px",
            "border:none",
            "background:" + (active ? "var(--aes-oxide)" : "transparent"),
            "color:" + (active ? "var(--aes-bone)" : "var(--aes-oxide)"),
            "font-family:'Inter Tight',system-ui,sans-serif",
            "font-weight:700",
            "font-size:11px",
            "letter-spacing:0.06em",
            "text-transform:uppercase",
            "cursor:pointer",
            "text-align:left"
        ].join(";");
    }

    function teardown() {
        if (typeof activeUnmount === "function") {
            try { activeUnmount(); } catch (_) {}
            activeUnmount = null;
        }
    }

    window.AesUnifiedSettingsTabs.modules = { render: render, teardown: teardown };
})();
