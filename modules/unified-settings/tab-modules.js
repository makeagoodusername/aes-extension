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

    const HUB_OVERVIEW_ID = "hub-overview";
    let activeId = null;
    let activeUnmount = null;

    function tokens() { return window.AESTokens; }

    function render(host, opts) {
        if (!host) return;
        host.textContent = "";
        if (opts && opts.moduleId) activeId = String(opts.moduleId);

        const reg = window.AesUnifiedSettingsRegistry;
        const settingsAdapters = reg ? reg.list() : [];
        const list = moduleEntries(settingsAdapters);

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
                ? activeId
                : (list.some(function (m) { return m.moduleId === HUB_OVERVIEW_ID; })
                    ? HUB_OVERVIEW_ID
                    : list[0].moduleId);
            selectModule(target, list, rail, pane);
        }

        wrap.append(rail, pane);
        host.appendChild(wrap);
    }

    function moduleEntries(settingsAdapters) {
        const entries = [];
        if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.all === "function") {
            entries.push({
                moduleId: HUB_OVERVIEW_ID,
                label: "Hub Modules",
                icon: "H",
                mount: function (host) { mountHubOverview(host, settingsAdapters || []); }
            });
        }
        return entries.concat(settingsAdapters || []);
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

    function mountHubOverview(host, settingsAdapters) {
        if (!host) return;

        const p1 = window.AesSettings ? window.AesSettings.getArea("featureToggles") : Promise.resolve({});

        p1.then(function(toggles) {
            host.textContent = "";
            const rows = hubTileRows();
            const mounted = rows.filter(function (r) { return r.mounted; }).length;
            const expanded = rows.filter(function (r) { return r.expanded; }).length;

            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;flex-direction:column;gap:16px";

            const head = document.createElement("div");
            head.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:16px";
            const titleBlock = document.createElement("div");
            const title = document.createElement("h2");
            title.textContent = "Hub Modules";
            title.style.cssText = "margin:0;font-size:18px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--aes-oxide)";
            const sub = document.createElement("div");
            sub.textContent = "Registered hub tiles, settings adapters, and runtime state for this page.";
            sub.style.cssText = "margin-top:4px;color:var(--aes-slate);font-size:12px;line-height:1.4";
            titleBlock.append(title, sub);
            head.appendChild(titleBlock);

            const dashboardBtn = smallButton("Open dashboard", function () {
                if (window.location && window.location.pathname.indexOf("/app/enterprise/dashboard") < 0) {
                    window.location.href = "/app/enterprise/dashboard";
                }
            }, {disabled: !(window.location && window.location.pathname.indexOf("/app/enterprise/dashboard") < 0)});
            head.appendChild(dashboardBtn);
            wrap.appendChild(head);

            const stats = document.createElement("div");
            stats.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px";
            stats.append(
                statCell("registered", rows.length),
                statCell("mounted", mounted),
                statCell("expanded", expanded),
                statCell("adapters", (settingsAdapters || []).length)
            );
            wrap.appendChild(stats);

            wrap.appendChild(featureTogglesList(toggles || {}));
            wrap.appendChild(tileTable(rows));
            wrap.appendChild(adapterList(settingsAdapters || []));

            host.appendChild(wrap);
        });
    }

    function featureTogglesList(toggles) {
        const section = panelSection("Feature Toggles");
        const list = document.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--aes-paper-rule);background:var(--aes-bone);";

        const features = [
            { id: "routeAssistant", label: "Route Assistant" },
            { id: "stationAutomation", label: "Station Automation" },
            { id: "usedAircraftScanner", label: "Used Aircraft Scanner" },
            { id: "inventory", label: "Inventory" },
            { id: "competitorMonitoring", label: "Competitor Monitoring" },
            { id: "scheduleManagement", label: "Schedule Management" },
            { id: "flightsFrom", label: "Flights From" }
        ];

        features.forEach(function (f) {
            const row = document.createElement("label");
            row.style.cssText = "display:flex;align-items:center;gap:12px;cursor:pointer;font-size:13px;color:var(--aes-oxide);margin:0;";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            // Default to true if the toggle is completely absent
            checkbox.checked = toggles[f.id] !== false;

            checkbox.addEventListener("change", function () {
                toggles[f.id] = checkbox.checked;
                if (window.AesSettings && typeof window.AesSettings.saveArea === "function") {
                    window.AesSettings.saveArea("featureToggles", toggles);
                }
            });

            const text = document.createTextNode(f.label);
            row.appendChild(checkbox);
            row.appendChild(text);
            list.appendChild(row);
        });

        section.appendChild(list);
        return section;
    }

    function hubTileRows() {
        const reg = window.CentralHubTileRegistry;
        let specs = [];
        try { specs = reg && typeof reg.all === "function" ? reg.all() : []; }
        catch (_) { specs = []; }

        const shell = window.__aesCentralHub || null;
        const mountedMap = shell && shell.tilesById && typeof shell.tilesById.get === "function"
            ? shell.tilesById
            : null;
        const ctx = shell ? { server: shell.server || "", airline: shell.airline || "" } : {};

        return specs.map(function (spec) {
            const tile = mountedMap ? mountedMap.get(spec.id) : null;
            const feeds = safeList(tile, "feedSlices", ctx);
            const watches = safeList(tile, "watchedStorageKeys", ctx);
            return {
                id: spec.id,
                title: (tile && tile.title) || titleFromId(spec.id),
                section: spec.section || "",
                sectionLabel: sectionLabel(spec.section || ""),
                priority: spec.priority == null ? 100 : spec.priority,
                topics: Array.isArray(spec.topics) ? spec.topics.slice() : (spec.section ? [spec.section] : []),
                feeds: feeds,
                watches: watches,
                mounted: !!tile,
                expanded: !!(tile && tile.expanded),
                status: tile ? (tile.expanded ? "expanded" : "mounted") : "registered"
            };
        });
    }

    function tileTable(rows) {
        const section = panelSection("Hub tile registry");
        if (!rows.length) {
            section.appendChild(emptyText("No hub tiles are registered on this page."));
            return section;
        }

        const table = document.createElement("div");
        table.style.cssText = [
            "display:grid",
            "grid-template-columns:minmax(160px,1.3fr) 120px 74px 98px minmax(140px,1fr) auto",
            "gap:0",
            "border:1px solid var(--aes-paper-rule)",
            "overflow:auto",
            "font-size:12px"
        ].join(";");

        ["Tile", "Section", "Priority", "State", "Hooks", "Action"].forEach(function (h) {
            const cell = document.createElement("div");
            cell.textContent = h;
            cell.style.cssText = headerCellStyle();
            table.appendChild(cell);
        });

        rows.forEach(function (row) {
            table.appendChild(cell(row.title + "\n" + row.id, "font-weight:700;color:var(--aes-oxide);white-space:pre-line"));
            table.appendChild(cell(row.sectionLabel || row.section || "-"));
            table.appendChild(cell(String(row.priority), "text-align:right;font-family:var(--aes-font-mono)"));
            table.appendChild(stateCell(row));
            table.appendChild(cell(hookSummary(row), "color:var(--aes-slate);font-family:var(--aes-font-mono);font-size:11px"));

            const action = document.createElement("div");
            action.style.cssText = bodyCellStyle() + ";text-align:right";
            action.appendChild(smallButton("Open", function () {
                if (!window.CentralHubBus || typeof window.CentralHubBus.emit !== "function") return;
                window.CentralHubBus.emit("open-tile", {
                    tileId: row.id,
                    expand: true,
                    scrollIntoView: true,
                    source: "unified-settings:modules"
                });
            }, {disabled: !(window.CentralHubBus && typeof window.CentralHubBus.emit === "function")}));
            table.appendChild(action);
        });

        section.appendChild(table);
        return section;
    }

    function adapterList(adapters) {
        const section = panelSection("Settings adapters");
        if (!adapters.length) {
            section.appendChild(emptyText("No module settings adapters are registered yet."));
            return section;
        }

        const list = document.createElement("div");
        list.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px";
        adapters.forEach(function (m) {
            const card = document.createElement("div");
            card.style.cssText = "border:1px solid var(--aes-paper-rule);background:var(--aes-bone);padding:12px;display:flex;flex-direction:column;gap:8px";
            const title = document.createElement("div");
            title.textContent = (m.icon ? m.icon + "  " : "") + m.label;
            title.style.cssText = "font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--aes-oxide);font-size:12px";
            const id = document.createElement("div");
            id.textContent = m.moduleId;
            id.style.cssText = "font-family:var(--aes-font-mono);font-size:11px;color:var(--aes-slate)";
            const actions = document.createElement("div");
            actions.appendChild(smallButton("Configure", function () {
                if (window.AesUnifiedSettings && typeof window.AesUnifiedSettings.open === "function") {
                    window.AesUnifiedSettings.open({tab: "modules", moduleId: m.moduleId});
                }
            }));
            card.append(title, id, actions);
            list.appendChild(card);
        });
        section.appendChild(list);
        return section;
    }

    function panelSection(titleText) {
        const section = document.createElement("section");
        section.style.cssText = "display:flex;flex-direction:column;gap:10px";
        const title = document.createElement("h3");
        title.textContent = titleText;
        title.style.cssText = "margin:0;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--aes-oxide);border-bottom:1px solid var(--aes-paper-rule);padding-bottom:6px";
        section.appendChild(title);
        return section;
    }

    function statCell(label, value) {
        const cell = document.createElement("div");
        cell.style.cssText = "border:1px solid var(--aes-paper-rule);background:var(--aes-bone);padding:10px 12px";
        const k = document.createElement("div");
        k.textContent = label;
        k.style.cssText = "font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--aes-slate)";
        const v = document.createElement("div");
        v.textContent = String(value);
        v.style.cssText = "font-family:var(--aes-font-mono);font-size:18px;font-weight:800;color:var(--aes-oxide);margin-top:3px";
        cell.append(k, v);
        return cell;
    }

    function stateCell(row) {
        const c = document.createElement("div");
        c.style.cssText = bodyCellStyle();
        const pill = document.createElement("span");
        pill.textContent = row.status.toUpperCase();
        const color = row.expanded ? "var(--aes-moss)" : (row.mounted ? "var(--aes-cobalt)" : "var(--aes-slate)");
        pill.style.cssText = "display:inline-block;border:1px solid " + color + ";color:" + color
            + ";padding:2px 6px;font-size:10px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase";
        c.appendChild(pill);
        return c;
    }

    function cell(text, extraStyle) {
        const c = document.createElement("div");
        c.textContent = text;
        c.style.cssText = bodyCellStyle() + (extraStyle ? ";" + extraStyle : "");
        return c;
    }

    function headerCellStyle() {
        return "padding:7px 8px;background:var(--aes-bone-2);border-bottom:1px solid var(--aes-oxide);"
            + "font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--aes-slate)";
    }

    function bodyCellStyle() {
        return "padding:8px;border-bottom:1px solid var(--aes-paper-rule);min-width:0;overflow-wrap:anywhere";
    }

    function smallButton(label, onClick, opts) {
        const o = opts || {};
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.disabled = !!o.disabled;
        btn.style.cssText = [
            "padding:5px 9px",
            "background:" + (o.primary ? "var(--aes-oxide)" : "transparent"),
            "color:" + (o.primary ? "var(--aes-bone)" : "var(--aes-oxide)"),
            "border:1px solid var(--aes-oxide)",
            "font-family:var(--aes-font-display)",
            "font-size:11px",
            "font-weight:800",
            "letter-spacing:0.06em",
            "text-transform:uppercase",
            "cursor:" + (o.disabled ? "not-allowed" : "pointer"),
            "opacity:" + (o.disabled ? "0.5" : "1")
        ].join(";");
        if (onClick) btn.addEventListener("click", function (e) { e.preventDefault(); onClick(); });
        return btn;
    }

    function emptyText(text) {
        const el = document.createElement("div");
        el.textContent = text;
        el.style.cssText = "padding:16px;color:var(--aes-slate);font-style:italic;border:1px dashed var(--aes-paper-rule);background:var(--aes-bone)";
        return el;
    }

    function safeList(tile, method, ctx) {
        if (!tile || typeof tile[method] !== "function") return [];
        try {
            const out = tile[method](ctx);
            return Array.isArray(out) ? out.filter(function (v) { return typeof v === "string" && v; }) : [];
        } catch (_) {
            return [];
        }
    }

    function hookSummary(row) {
        const parts = [];
        if (row.topics && row.topics.length) parts.push("topics " + row.topics.join(","));
        if (row.feeds && row.feeds.length) parts.push("feeds " + row.feeds.length);
        if (row.watches && row.watches.length) parts.push("watches " + row.watches.length);
        return parts.length ? parts.join(" · ") : "-";
    }

    function sectionLabel(id) {
        const nav = window.CentralHubNav;
        const sections = nav && Array.isArray(nav.SECTIONS) ? nav.SECTIONS : [];
        const found = sections.find(function (s) { return s.id === id; });
        return found ? found.label : id;
    }

    function titleFromId(id) {
        return String(id || "")
            .split("-")
            .filter(Boolean)
            .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
            .join(" ");
    }

    function teardown() {
        if (typeof activeUnmount === "function") {
            try { activeUnmount(); } catch (_) {}
            activeUnmount = null;
        }
    }

    window.AesUnifiedSettingsTabs.modules = { render: render, teardown: teardown };
})();
