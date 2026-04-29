"use strict";

/**
 * Unified Settings — Strategy adapter.
 *
 * Read-only summary of tier + per-domain enables, then six editable cards
 * for the evidence-based decision tunables that drive price-moves,
 * service-moves, and route-creation: pricing guards, route-creation gates,
 * objective, autoTick loop, anti-spiral economics floor, and service-cost
 * weights. Every input shows the current value (defaults match prior
 * frozen literals byte-for-byte) and writes back through
 * AesStrategySettings.save so existing engine call-sites pick up the
 * change on next snapshot composition.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;

    const SERVICE_CATEGORY_KEYS = [
        "drinks", "snacks", "entrees", "additionalEntrees",
        "headphones", "newspapersMagazines", "flightMagazines", "foodPresentation"
    ];

    function _statusEl() {
        const s = document.createElement("span");
        s.style.cssText = "font-size:11px;color:" + H.COLORS.slate + ";margin-left:8px";
        return s;
    }

    function _flashSaved(status) {
        if (!status) return;
        status.textContent = "Saved";
        setTimeout(function () { if (status) status.textContent = ""; }, 1800);
    }

    function _input(opts) {
        const o = opts || {};
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:12px";
        const span = document.createElement("span");
        span.textContent = o.label || "";
        span.style.cssText = "color:" + H.COLORS.oxide + ";font-weight:600";
        const input = document.createElement("input");
        input.type = o.type || "number";
        if (o.min != null)  input.min  = String(o.min);
        if (o.max != null)  input.max  = String(o.max);
        if (o.step != null) input.step = String(o.step);
        if (o.type === "checkbox") input.checked = !!o.value;
        else if (o.value != null) input.value = String(o.value);
        input.style.cssText = [
            "border:1px solid " + H.COLORS.rule,
            "background:" + H.COLORS.bone,
            "padding:3px 6px",
            "font-family:'JetBrains Mono',monospace",
            "font-size:11px",
            "min-width:" + (o.type === "checkbox" ? "20px" : "80px"),
            "text-align:" + (o.type === "checkbox" ? "left" : "right")
        ].join(";");
        wrap.append(span, input);
        return {row: wrap, input: input};
    }

    function _select(opts) {
        const o = opts || {};
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:12px";
        const span = document.createElement("span");
        span.textContent = o.label || "";
        span.style.cssText = "color:" + H.COLORS.oxide + ";font-weight:600";
        const sel = document.createElement("select");
        sel.style.cssText = [
            "border:1px solid " + H.COLORS.rule,
            "background:" + H.COLORS.bone,
            "padding:3px 6px",
            "font-family:inherit",
            "font-size:11px",
            "min-width:140px"
        ].join(";");
        for (const opt of (o.options || [])) {
            const op = document.createElement("option");
            op.value = opt.value;
            op.textContent = opt.label;
            if (opt.value === o.value) op.selected = true;
            sel.appendChild(op);
        }
        wrap.append(span, sel);
        return {row: wrap, input: sel};
    }

    function _saveAndStatus(ns, host, partial, status, btn) {
        if (btn) btn.disabled = true;
        if (status) status.textContent = "Saving…";
        ns.save(partial).then(function () {
            _flashSaved(status);
            mount(host);
        }).catch(function (e) {
            console && console.warn && console.warn("[unified-settings strategy adapter] save", e);
            if (status) status.textContent = "Save failed";
        }).finally(function () {
            if (btn) btn.disabled = false;
        });
    }

    function _cardTitle(text) {
        const t = document.createElement("div");
        t.textContent = text.toUpperCase();
        t.style.cssText = "font-weight:700;font-size:11px;letter-spacing:0.08em;color:"
            + H.COLORS.oxide + ";margin-bottom:8px";
        return t;
    }

    // ── Cards ──────────────────────────────────────────────────────────

    function _summaryCard(s, ns, host) {
        const card = H.card();
        const tier = ns.resolveTier ? ns.resolveTier(s) : (s && s.tier) || "preview-only";
        card.appendChild(_cardTitle("Tier & domain enables"));
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
        return card;
    }

    function _pricingGuardsCard(s, ns, host) {
        const card = H.card();
        card.appendChild(_cardTitle("Pricing guards"));
        const deadband = _input({label: "Price deadband (%)", value: s.priceDeadband, min: 0, max: 50, step: 1});
        const maxMove  = _input({label: "Max price move / window (%)", value: s.maxPriceMovePerWindow, min: 0, max: 50, step: 1});
        card.append(deadband.row, maxMove.row);
        const a = H.actions();
        const status = _statusEl();
        const save = H.actionBtn("Save", function () {
            _saveAndStatus(ns, host, {
                priceDeadband:         Number(deadband.input.value),
                maxPriceMovePerWindow: Number(maxMove.input.value)
            }, status, save);
        }, { primary: true });
        a.append(save, status);
        card.appendChild(a);
        return card;
    }

    function _routeCreationCard(s, ns, host) {
        const card = H.card();
        card.appendChild(_cardTitle("Route creation gates"));
        const threshold = _input({label: "Score threshold (0–1)",       value: s.routeCreationThreshold, min: 0, max: 1, step: 0.05});
        const orsTarget = _input({label: "Min ORS target (0–1)",        value: s.minOrsTarget,           min: 0, max: 1, step: 0.05});
        const minF      = _input({label: "Min frequency / week",        value: (s.routeCreation && s.routeCreation.minFrequency) || 1,    min: 1, max: 28, step: 1});
        const maxF      = _input({label: "Max frequency / week",        value: (s.routeCreation && s.routeCreation.maxFrequency) || 14,   min: 1, max: 28, step: 1});
        const pricePct  = _input({label: "Default starting price (%)",  value: (s.routeCreation && s.routeCreation.defaultPricePct) || 100, min: 50, max: 200, step: 1});
        card.append(threshold.row, orsTarget.row, minF.row, maxF.row, pricePct.row);
        const a = H.actions();
        const status = _statusEl();
        const save = H.actionBtn("Save", function () {
            _saveAndStatus(ns, host, {
                routeCreationThreshold: Number(threshold.input.value),
                minOrsTarget:           Number(orsTarget.input.value),
                routeCreation: {
                    minFrequency:    Number(minF.input.value),
                    maxFrequency:    Number(maxF.input.value),
                    defaultPricePct: Number(pricePct.input.value)
                }
            }, status, save);
        }, { primary: true });
        a.append(save, status);
        card.appendChild(a);
        return card;
    }

    function _objectiveCard(s, ns, host) {
        const card = H.card();
        card.appendChild(_cardTitle("Decision objective"));
        const obj = s.objective || {kind: "balanced", custom: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}};
        const kindOpts = [
            {value: "maxShare",  label: "maxShare"},
            {value: "maxProfit", label: "maxProfit"},
            {value: "balanced",  label: "balanced"},
            {value: "custom",    label: "custom"}
        ];
        const kind = _select({label: "Kind", value: obj.kind, options: kindOpts});
        const share  = _input({label: "Custom shareWeight",  value: (obj.custom && obj.custom.shareWeight)  || 0, min: 0, max: 1, step: 0.05});
        const profit = _input({label: "Custom profitWeight", value: (obj.custom && obj.custom.profitWeight) || 0, min: 0, max: 1, step: 0.05});
        const rank   = _input({label: "Custom rankWeight",   value: (obj.custom && obj.custom.rankWeight)   || 0, min: 0, max: 1, step: 0.05});
        const note = document.createElement("div");
        note.style.cssText = "font-size:10px;color:" + H.COLORS.slate + ";margin:4px 0 0;line-height:1.4";
        note.textContent = "Custom weights are normalised to sum 1 on save. Non-custom kinds use built-in presets.";
        card.append(kind.row, share.row, profit.row, rank.row, note);
        const a = H.actions();
        const status = _statusEl();
        const save = H.actionBtn("Save", function () {
            _saveAndStatus(ns, host, {
                objective: {
                    kind: kind.input.value,
                    custom: {
                        shareWeight:  Number(share.input.value),
                        profitWeight: Number(profit.input.value),
                        rankWeight:   Number(rank.input.value)
                    }
                }
            }, status, save);
        }, { primary: true });
        a.append(save, status);
        card.appendChild(a);
        return card;
    }

    function _autoTickCard(s, ns, host) {
        const card = H.card();
        card.appendChild(_cardTitle("AutoTick loop"));
        const at = s.autoTick || {};
        const dom = at.domains || {};
        const enabled  = _input({label: "Loop enabled",            type: "checkbox", value: at.enabled !== false});
        const interval = _input({label: "Interval (min)",          value: at.intervalMin || 30,           min: 1, max: 1440, step: 1});
        const cooldown = _input({label: "Cooldown after apply (min)", value: at.cooldownMin || 30,        min: 0, max: 1440, step: 1});
        const maxDec   = _input({label: "Max decisions / tick",    value: at.maxDecisionsPerTick || 5,    min: 0, max: 100,  step: 1});
        const cap24    = _input({label: "Silent-auto cap / 24h",   value: at.silentAutoCap24h || 10,      min: 0, max: 1000, step: 1});
        const dSched   = _input({label: "Domain: schedule",        type: "checkbox", value: !!dom.schedule});
        const dService = _input({label: "Domain: service",         type: "checkbox", value: !!dom.service});
        const dPrice   = _input({label: "Domain: price",           type: "checkbox", value: !!dom.price});
        const dCrew    = _input({label: "Domain: crew",            type: "checkbox", value: !!dom.crew});
        const dRoute   = _input({label: "Domain: routeCreation",   type: "checkbox", value: !!dom.routeCreation});
        card.append(enabled.row, interval.row, cooldown.row, maxDec.row, cap24.row,
            dSched.row, dService.row, dPrice.row, dCrew.row, dRoute.row);
        const a = H.actions();
        const status = _statusEl();
        const save = H.actionBtn("Save", function () {
            _saveAndStatus(ns, host, {
                autoTick: {
                    enabled:             enabled.input.checked,
                    intervalMin:         Number(interval.input.value),
                    cooldownMin:         Number(cooldown.input.value),
                    maxDecisionsPerTick: Number(maxDec.input.value),
                    silentAutoCap24h:    Number(cap24.input.value),
                    domains: {
                        schedule:      dSched.input.checked,
                        service:       dService.input.checked,
                        price:         dPrice.input.checked,
                        crew:          dCrew.input.checked,
                        routeCreation: dRoute.input.checked
                    }
                }
            }, status, save);
        }, { primary: true });
        a.append(save, status);
        card.appendChild(a);
        return card;
    }

    function _economicsCard(s, ns, host) {
        const card = H.card();
        card.appendChild(_cardTitle("Anti-spiral economics floor"));
        const econ = s.economics || {};
        const floor = _input({
            label: "Competitor income floor / week",
            value: econ.competitorIncomeFloorWeekly != null ? econ.competitorIncomeFloorWeekly : 5000,
            min: 0, max: 1e9, step: 100
        });
        const note = document.createElement("div");
        note.style.cssText = "font-size:10px;color:" + H.COLORS.slate + ";margin:4px 0 0;line-height:1.4";
        note.textContent = "Below this competitor weekly profit, downward price moves and service upgrades are dampened to avoid race-to-zero (NORTH-STAR §4.17).";
        card.append(floor.row, note);
        const a = H.actions();
        const status = _statusEl();
        const save = H.actionBtn("Save", function () {
            _saveAndStatus(ns, host, {
                economics: {competitorIncomeFloorWeekly: Number(floor.input.value)}
            }, status, save);
        }, { primary: true });
        a.append(save, status);
        card.appendChild(a);
        return card;
    }

    function _serviceCostsCard(s, ns, host) {
        const card = H.card();
        card.appendChild(_cardTitle("Service-cost weights"));
        const sc = s.serviceCosts || {};
        const cw = sc.categoryWeights || {};
        const cm = sc.classMultipliers || {};
        const catRows = SERVICE_CATEGORY_KEYS.map(function (k) {
            return {key: k, ctl: _input({label: "Category · " + k, value: cw[k] != null ? cw[k] : null, min: 0, max: 100, step: 0.1})};
        });
        for (const c of catRows) card.appendChild(c.ctl.row);
        const dc = _input({label: "Default category cost", value: sc.defaultCategoryCost != null ? sc.defaultCategoryCost : 2.0, min: 0, max: 100, step: 0.1});
        card.appendChild(dc.row);
        const mY = _input({label: "Class multiplier · Y", value: cm.Y != null ? cm.Y : 1,   min: 0, max: 100, step: 0.1});
        const mC = _input({label: "Class multiplier · C", value: cm.C != null ? cm.C : 3.6, min: 0, max: 100, step: 0.1});
        const mF = _input({label: "Class multiplier · F", value: cm.F != null ? cm.F : 9,   min: 0, max: 100, step: 0.1});
        card.append(mY.row, mC.row, mF.row);
        const note = document.createElement("div");
        note.style.cssText = "font-size:10px;color:" + H.COLORS.slate + ";margin:4px 0 0;line-height:1.4";
        note.textContent = "Service-moves uses these to rank the cost-aware vs lift-first perturbation packs. Empty values fall back to the engine's frozen defaults.";
        card.appendChild(note);
        const a = H.actions();
        const status = _statusEl();
        const save = H.actionBtn("Save", function () {
            const weights = {};
            for (const c of catRows) {
                const v = Number(c.ctl.input.value);
                if (Number.isFinite(v)) weights[c.key] = v;
            }
            _saveAndStatus(ns, host, {
                serviceCosts: {
                    categoryWeights:     weights,
                    classMultipliers:    {Y: Number(mY.input.value), C: Number(mC.input.value), F: Number(mF.input.value)},
                    defaultCategoryCost: Number(dc.input.value)
                }
            }, status, save);
        }, { primary: true });
        a.append(save, status);
        card.appendChild(a);
        return card;
    }

    // ── Mount ──────────────────────────────────────────────────────────

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Strategy", "Tier, risk profile, and the evidence-based knobs that drive every price, service, and route proposal."));

        const ns = window.AesStrategySettings;
        if (!ns || typeof ns.load !== "function") {
            host.appendChild(H.notice("Strategy not loaded on this page."));
            return;
        }

        const placeholder = H.card();
        placeholder.textContent = "Loading…";
        host.appendChild(placeholder);

        ns.load().then(function (s) {
            host.removeChild(placeholder);
            host.appendChild(_summaryCard(s, ns, host));
            host.appendChild(_pricingGuardsCard(s, ns, host));
            host.appendChild(_routeCreationCard(s, ns, host));
            host.appendChild(_objectiveCard(s, ns, host));
            host.appendChild(_autoTickCard(s, ns, host));
            host.appendChild(_economicsCard(s, ns, host));
            host.appendChild(_serviceCostsCard(s, ns, host));
        }).catch(function (e) {
            host.removeChild(placeholder);
            host.appendChild(H.notice("Failed to load strategy settings."));
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
