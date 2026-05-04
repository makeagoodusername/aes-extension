"use strict";

/**
 * Unified Settings — Per-cabin pricing adapter.
 *
 * Surfaces the per-class autopricer config the data layer added in
 * profit-estimator + pricing-applier + price-moves + per-class proposer:
 *
 *   • settings.routeAssistant.pricing.apply.classes.{Y,C,F,Cargo}.{enabled,
 *                                                                   deadband,
 *                                                                   maxMove}
 *   • settings.routeAssistant.economics.classYields.{Y,C,F}.{yieldPerKm,
 *                                                              loadFactorMin,
 *                                                              loadFactorMax,
 *                                                              demandSensitivity}
 *   • settings.routeAssistant.economics.classShares.{Y,C,F}
 *
 * Lives as its own moduleId so the user finds it under the Modules tab as
 * "Per-cabin pricing" — separate from the busy Route Assistant tab whose
 * settings drawer is rendered directly by the RA panel itself.
 *
 * No mutating writes outside `RouteAssistantSettings.save(...)`. Edits are
 * partial (only the `pricing.apply.classes` and `economics.classYields/Shares`
 * sub-trees), so unrelated RA settings are untouched.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsRegistry) return;

    const H = window.AesUnifiedSettingsAdapterHelpers;
    const PAX_CLASSES = ["Y", "C", "F"];
    const ALL_CLASSES = ["Y", "C", "F", "Cargo"];
    const CLASS_LABEL = { Y: "Economy", C: "Business", F: "First", Cargo: "Cargo" };

    function _toggle(label, checked, onChange) {
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;padding:4px 0";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!checked;
        cb.addEventListener("change", function () { onChange(cb.checked); });
        const t = document.createElement("span");
        t.textContent = label;
        t.style.cssText = "color:" + H.COLORS.oxide + ";font-weight:600";
        wrap.append(cb, t);
        return wrap;
    }

    function _numInput(label, value, opts, onChange) {
        const o = opts || {};
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0;font-size:12px";
        const l = document.createElement("span");
        l.textContent = label;
        l.style.cssText = "color:" + H.COLORS.oxide + ";font-weight:600;flex:1";
        const inp = document.createElement("input");
        inp.type = "number";
        if (o.step != null)  inp.step = String(o.step);
        if (o.min != null)   inp.min = String(o.min);
        if (o.max != null)   inp.max = String(o.max);
        if (o.placeholder)   inp.placeholder = o.placeholder;
        inp.value = value == null ? "" : String(value);
        inp.style.cssText = [
            "border:1px solid " + H.COLORS.rule,
            "background:" + H.COLORS.bone,
            "color:" + H.COLORS.oxide,
            "padding:3px 6px",
            "font-family:'JetBrains Mono',monospace",
            "font-size:11px",
            "width:90px",
            "text-align:right"
        ].join(";");
        let lastSent = inp.value;
        const fire = function () {
            if (inp.value === lastSent) return;
            lastSent = inp.value;
            const raw = inp.value.trim();
            const n = raw === "" ? null : Number(raw);
            onChange(raw === "" ? null : (isFinite(n) ? n : null));
        };
        inp.addEventListener("change", fire);
        inp.addEventListener("blur", fire);
        wrap.append(l, inp);
        return wrap;
    }

    function _classCard(cls, settings, persist) {
        const card = H.card();
        const head = document.createElement("div");
        head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px";
        const title = document.createElement("div");
        title.textContent = CLASS_LABEL[cls] + " (" + cls + ")";
        title.style.cssText = "font-weight:800;font-size:13px;letter-spacing:0.06em;color:" + H.COLORS.oxide;
        head.appendChild(title);
        card.appendChild(head);

        const pricing = settings.pricing || {};
        const apply  = pricing.apply || {};
        const gates  = apply.classes || {};
        const gate   = gates[cls] || {};
        const yields = (settings.economics && settings.economics.classYields) || {};
        const cy     = yields[cls] || {};
        const shares = (settings.economics && settings.economics.classShares) || {};
        const silentEnabled = pricing.silentAutoPerClassEnabled || {};
        const silentMaxStep = pricing.silentAutoPerClassMaxStepPct || {};
        const silentMinDemand = pricing.silentAutoPerClassMinDemandPool || {};

        // Gate: enabled toggle.
        card.appendChild(_toggle("Auto-pricer enabled for this cabin",
            gate.enabled !== false,
            function (v) {
                persist({ pricing: { apply: { classes: _patchKey(gates, cls, "enabled", v) } } });
            }
        ));

        // Per-class deadband + maxMove.
        card.appendChild(_numInput("Deadband %  (warn above |Δ|)", gate.deadband,
            { step: 0.5, min: 0, placeholder: "inherit" },
            function (v) {
                persist({ pricing: { apply: { classes: _patchKey(gates, cls, "deadband", v) } } });
            }
        ));
        card.appendChild(_numInput("Max move %  (block above)", gate.maxMove,
            { step: 0.5, min: 0, placeholder: "inherit" },
            function (v) {
                persist({ pricing: { apply: { classes: _patchKey(gates, cls, "maxMove", v) } } });
            }
        ));

        const autoSep = document.createElement("div");
        autoSep.style.cssText = "height:1px;background:" + H.COLORS.rule + ";margin:10px 0";
        card.appendChild(autoSep);
        const autoLabel = document.createElement("div");
        autoLabel.textContent = "Silent auto-pricing — class-specific demand gate";
        autoLabel.style.cssText = "font-size:10px;letter-spacing:0.08em;color:" + H.COLORS.slate + ";text-transform:uppercase;margin-bottom:4px";
        card.appendChild(autoLabel);
        card.appendChild(_toggle("Eligible for silent auto-pricing",
            silentEnabled[cls] !== false,
            function (v) {
                persist({ pricing: { silentAutoPerClassEnabled: _patchValue(silentEnabled, cls, v) } });
            }
        ));
        card.appendChild(_numInput("Silent max step %", silentMaxStep[cls],
            { step: 0.5, min: 0, placeholder: "global" },
            function (v) {
                persist({ pricing: { silentAutoPerClassMaxStepPct: _patchValue(silentMaxStep, cls, v) } });
            }
        ));
        card.appendChild(_numInput(cls === "Cargo" ? "Min cargo demand pool" : "Min pax demand pool",
            silentMinDemand[cls],
            { step: cls === "Cargo" ? 100 : 1, min: 0, placeholder: cls === "Cargo" ? "1000" : cls === "Y" ? "50" : cls === "C" ? "10" : "5" },
            function (v) {
                persist({ pricing: { silentAutoPerClassMinDemandPool: _patchValue(silentMinDemand, cls, v) } });
            }
        ));

        // Passenger cabins: yield + LF range + demand sensitivity + share.
        if (cls !== "Cargo") {
            const sep = document.createElement("div");
            sep.style.cssText = "height:1px;background:" + H.COLORS.rule + ";margin:10px 0";
            card.appendChild(sep);
            const econLabel = document.createElement("div");
            econLabel.textContent = "Economics — drives byClass profit";
            econLabel.style.cssText = "font-size:10px;letter-spacing:0.08em;color:" + H.COLORS.slate + ";text-transform:uppercase;margin-bottom:4px";
            card.appendChild(econLabel);

            card.appendChild(_numInput("Yield (AS$/pax-km)", cy.yieldPerKm,
                { step: 0.01, min: 0, placeholder: "0.10" },
                function (v) {
                    persist({ economics: { classYields: _patchClassYield(yields, cls, "yieldPerKm", v) } });
                }
            ));
            card.appendChild(_numInput("Cabin share (0–1)", shares[cls],
                { step: 0.01, min: 0, max: 1, placeholder: cls === "Y" ? "0.78" : cls === "C" ? "0.16" : "0.06" },
                function (v) {
                    persist({ economics: { classShares: _patchValue(shares, cls, v) } });
                }
            ));
            card.appendChild(_numInput("Load-factor min (paxScore=0)", cy.loadFactorMin,
                { step: 0.01, min: 0, max: 1, placeholder: cls === "Y" ? "0.55" : cls === "C" ? "0.45" : "0.30" },
                function (v) {
                    persist({ economics: { classYields: _patchClassYield(yields, cls, "loadFactorMin", v) } });
                }
            ));
            card.appendChild(_numInput("Load-factor max (paxScore=10)", cy.loadFactorMax,
                { step: 0.01, min: 0, max: 1, placeholder: cls === "Y" ? "0.92" : cls === "C" ? "0.85" : "0.75" },
                function (v) {
                    persist({ economics: { classYields: _patchClassYield(yields, cls, "loadFactorMax", v) } });
                }
            ));
            card.appendChild(_numInput("Demand sensitivity (0–1)", cy.demandSensitivity,
                { step: 0.05, min: 0, max: 1, placeholder: "0" },
                function (v) {
                    persist({ economics: { classYields: _patchClassYield(yields, cls, "demandSensitivity", v) } });
                }
            ));
        } else {
            const sep = document.createElement("div");
            sep.style.cssText = "height:1px;background:" + H.COLORS.rule + ";margin:10px 0";
            card.appendChild(sep);
            const stratLabel = document.createElement("div");
            stratLabel.textContent = "Strategy engine — cargo participation";
            stratLabel.style.cssText = "font-size:10px;letter-spacing:0.08em;color:" + H.COLORS.slate + ";text-transform:uppercase;margin-bottom:4px";
            card.appendChild(stratLabel);
            // Mirrors the silentAutoPerClassEnabled.Cargo toggle but at the
            // strategy snapshot layer (proposePriceMoves includeCargo). Both
            // gates must allow cargo for a strategy-objective move to fire.
            card.appendChild(_toggle("Include cargo in strategy snapshot moves",
                pricing.silentAutoIncludeCargo !== false,
                function (v) {
                    persist({ pricing: { silentAutoIncludeCargo: v } });
                }
            ));

            const sep2 = document.createElement("div");
            sep2.style.cssText = "height:1px;background:" + H.COLORS.rule + ";margin:10px 0";
            card.appendChild(sep2);
            const econLabel = document.createElement("div");
            econLabel.textContent = "Economics — drives cargo profit";
            econLabel.style.cssText = "font-size:10px;letter-spacing:0.08em;color:" + H.COLORS.slate + ";text-transform:uppercase;margin-bottom:4px";
            card.appendChild(econLabel);

            const econ = settings.economics || {};
            card.appendChild(_numInput("Cargo yield (AS$/kg-km)", econ.cargoYieldPerKgKm,
                { step: 0.001, min: 0, placeholder: "0.04" },
                function (v) {
                    persist({ economics: { cargoYieldPerKgKm: v } });
                }
            ));
            card.appendChild(_numInput("Fallback cargo LF", econ.cargoLoadFactor,
                { step: 0.01, min: 0, max: 1, placeholder: "0.60" },
                function (v) {
                    persist({ economics: { cargoLoadFactor: v } });
                }
            ));
            card.appendChild(_numInput("Cargo LF min (cargoScore=0)", econ.cargoLoadFactorMin,
                { step: 0.01, min: 0, max: 1, placeholder: "0.40" },
                function (v) {
                    persist({ economics: { cargoLoadFactorMin: v } });
                }
            ));
            card.appendChild(_numInput("Cargo LF max (cargoScore=10)", econ.cargoLoadFactorMax,
                { step: 0.01, min: 0, max: 1, placeholder: "0.85" },
                function (v) {
                    persist({ economics: { cargoLoadFactorMax: v } });
                }
            ));
            card.appendChild(_numInput("Cargo demand sensitivity (0–1)", econ.cargoYieldDemandSensitivity,
                { step: 0.05, min: 0, max: 1, placeholder: "0" },
                function (v) {
                    persist({ economics: { cargoYieldDemandSensitivity: v } });
                }
            ));
        }

        return card;
    }

    function _patchKey(gates, cls, k, v) {
        const out = Object.assign({}, gates);
        out[cls] = Object.assign({}, gates[cls] || {}, { [k]: v });
        return out;
    }
    function _patchClassYield(cy, cls, k, v) {
        const out = Object.assign({}, cy);
        out[cls] = Object.assign({}, cy[cls] || {}, { [k]: v });
        return out;
    }
    function _patchValue(map, k, v) {
        const out = Object.assign({}, map);
        out[k] = v;
        return out;
    }

    function _deepMerge(a, b) {
        const out = Object.assign({}, a);
        for (const k in b) {
            if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])
                    && a && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) {
                out[k] = _deepMerge(a[k], b[k]);
            } else {
                out[k] = b[k];
            }
        }
        return out;
    }

    function _persist(patch, current, onSaved) {
        const merged = _deepMerge(current, patch);
        // Preferred path: when RouteAssistantSettings.save is loaded on this
        // page, route through it so the data-bus broadcast + L2 account-
        // scoped storage path fire as designed.
        if (window.RouteAssistantSettings && typeof window.RouteAssistantSettings.save === "function") {
            return Promise.resolve(window.RouteAssistantSettings.save(merged))
                .then(function (next) {
                    if (typeof onSaved === "function") onSaved(next);
                    return next;
                })
                .catch(function (e) {
                    console && console.warn && console.warn("[per-cabin-pricing] save failed", e);
                    return current;
                });
        }
        // Fallback: pages that do not load the RA bundle still load the
        // shared settings bridge. Keep the same queued, account-scoped write
        // path instead of replacing the whole settings blob directly.
        if (window.AesSettings
                && typeof window.AesSettings.getAreaScoped === "function"
                && typeof window.AesSettings.saveAreaScoped === "function") {
            return Promise.resolve(window.AesSettings.getAreaScoped("routeAssistant"))
                .then(function (stored) {
                    const next = _deepMerge(stored || {}, patch);
                    const id = (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null;
                    return window.AesSettings.saveAreaScoped("routeAssistant", next, id)
                        .then(function (saved) {
                            const result = saved || next;
                            if (typeof window.AesDataBus !== "undefined"
                                    && typeof window.AesDataBus.emit === "function") {
                                window.AesDataBus.emit("data:route-assistant:settings:saved", {
                                    accountId: id || null,
                                    sections:  Object.keys(patch || {})
                                });
                            }
                            if (typeof onSaved === "function") onSaved(result);
                            return result;
                        });
                })
                .catch(function (e) {
                    console && console.warn && console.warn("[per-cabin-pricing] bridge save failed", e);
                    return current;
                });
        }
        console && console.warn && console.warn("[per-cabin-pricing] settings bridge unavailable; save skipped");
        return Promise.resolve(current);
    }

    // Fallback loader for pages that don't bundle RouteAssistantSettings.
    // Reads `settings.routeAssistant` directly and overlays the per-cabin
    // defaults this adapter cares about so the form has values to render
    // even before the user has saved anything.
    function _loadFallback() {
        if (window.AesSettings && typeof window.AesSettings.getAreaScoped === "function") {
            return Promise.resolve(window.AesSettings.getAreaScoped("routeAssistant"))
                .then(function (ra) {
                    return _deepMerge({
                        economics: {
                            classYields: {
                                Y: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92, demandSensitivity: 0 },
                                C: { yieldPerKm: 0.32, loadFactorMin: 0.45, loadFactorMax: 0.85, demandSensitivity: 0 },
                                F: { yieldPerKm: 0.65, loadFactorMin: 0.30, loadFactorMax: 0.75, demandSensitivity: 0 }
                            },
                            classShares: { Y: 0.86, C: 0.11, F: 0.03 }
                        },
                        pricing: { apply: { classes: {} } }
                    }, ra || {});
                });
        }
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(["settings"], function (data) {
                    const ra = (data && data.settings && data.settings.routeAssistant) || {};
                    resolve(_deepMerge({
                        economics: {
                            classYields: {
                                Y: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92, demandSensitivity: 0 },
                                C: { yieldPerKm: 0.32, loadFactorMin: 0.45, loadFactorMax: 0.85, demandSensitivity: 0 },
                                F: { yieldPerKm: 0.65, loadFactorMin: 0.30, loadFactorMax: 0.75, demandSensitivity: 0 }
                            },
                            classShares: { Y: 0.78, C: 0.16, F: 0.06 }
                        },
                        pricing: { apply: { classes: {
                            Y:     { enabled: true, deadband: null, maxMove: null },
                            C:     { enabled: true, deadband: null, maxMove: null },
                            F:     { enabled: true, deadband: null, maxMove: null },
                            Cargo: { enabled: true, deadband: null, maxMove: null }
                        }}}
                    }, ra));
                });
            } catch (e) {
                resolve({});
            }
        });
    }

    function mount(host) {
        if (!host) return;
        host.textContent = "";
        host.appendChild(H.header("Per-cabin pricing",
            "Y / C / F / Cargo settings for the autopricer. Disable a cabin to leave it untouched on apply; tighter deadband or maxMove overrides the route-level threshold for that one cabin."));

        let live = null;
        const cardsHost = document.createElement("div");
        host.appendChild(cardsHost);

        function render() {
            cardsHost.textContent = "";
            const persist = function (patch) {
                _persist(patch, live, function (next) {
                    live = next;
                    render();
                });
            };
            for (const cls of ALL_CLASSES) {
                cardsHost.appendChild(_classCard(cls, live, persist));
            }
            if (window.RouteAssistantProfitEstimator) {
                const sample = _samplePreview(live);
                if (sample) cardsHost.appendChild(sample);
            }
        }

        const status = document.createElement("div");
        status.textContent = "Loading…";
        status.style.cssText = "font-size:12px;color:" + H.COLORS.slate;
        cardsHost.appendChild(status);

        // Prefer the in-page RA store (so saves broadcast on the data bus
        // and account-scope correctly); fall back to the shared settings
        // bridge on pages that don't bundle the RA modules.
        const loader = (window.RouteAssistantSettings && typeof window.RouteAssistantSettings.load === "function")
            ? window.RouteAssistantSettings.load()
            : _loadFallback();

        Promise.resolve(loader).then(function (s) {
            live = s || {};
            render();
        }).catch(function (e) {
            cardsHost.textContent = "";
            cardsHost.appendChild(H.notice("Failed to load settings: " + (e && e.message || e)));
        });
    }

    function _samplePreview(settings) {
        try {
            const E = window.RouteAssistantProfitEstimator;
            const econ = Object.assign({}, settings.economics || {});
            const r = E.estimate({
                distanceKm: 4000,
                spec: { seats: 250, range: 11000, speed: 850, cargoCapacity: 8000 },
                frequency: 7,
                paxScore: 6,
                cargoScore: 5,
                economics: Object.assign({
                    loadFactorMin: 0.5, loadFactorMax: 0.95, yieldPerKm: 0.10,
                    cargoYieldPerKgKm: 0.04, cargoLoadFactorMin: 0.4, cargoLoadFactorMax: 0.85,
                    fuelCostPerHour: 2500
                }, econ)
            });
            if (!r || !r.breakdown) return null;
            const card = H.card();
            const t = document.createElement("div");
            t.textContent = "PREVIEW — 250-seat widebody, 4000 km, paxScore 6, cargoScore 5, freq 7×/wk";
            t.style.cssText = "font-weight:800;font-size:11px;letter-spacing:0.06em;color:" + H.COLORS.oxide + ";margin-bottom:6px";
            card.appendChild(t);
            const bc = r.breakdown.byClass;
            if (bc) {
                for (const cls of ALL_CLASSES) {
                    const line = bc[cls];
                    if (!line) continue;
                    const txt = cls + " · " + (line.seats != null ? line.seats : line.cargoKg) + (cls === "Cargo" ? "kg" : " seats")
                        + " · LF " + (line.loadFactor || 0).toFixed(2)
                        + " · yield " + (line.yieldPerKm || line.effYield).toFixed(2)
                        + " · $" + (line.revenue || 0).toLocaleString() + "/flight"
                        + " · $" + (line.revenuePerWeek || 0).toLocaleString() + "/wk";
                    card.appendChild(H.row(cls, txt.split(" · ").slice(1).join(" · ")));
                }
            } else {
                card.appendChild(H.notice("byClass not populated — check that economics.classYields has at least one cabin set."));
            }
            const total = H.row("paxRevenue", "$" + (r.breakdown.paxRevenue || 0).toLocaleString());
            card.appendChild(total);
            const profit = H.row("profit / flight", "$" + (r.profitPerFlight || 0).toLocaleString());
            card.appendChild(profit);
            return card;
        } catch (e) {
            return null;
        }
    }

    window.AesUnifiedSettingsRegistry.register({
        moduleId: "per-cabin-pricing",
        label:    "Per-cabin pricing",
        icon:     "✈",
        mount:    mount
    });
})();
