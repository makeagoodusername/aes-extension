"use strict";

/**
 * Content script for the AS Pricing Adjustment page
 * (`/action/enterprise/flightsPrices?adjust=true`).
 *
 * Mounts the AES recommendations panel into the empty `.col-md-9` slot
 * to the right of AS's native bulk-adjustment form. The panel reads the
 * form's filter state on every change, asks
 * `RouteAssistantFlightsPricesBridge` for per-route per-class
     * recommendations, and routes Apply through the existing per-route
     * applier. Proven pricing scopes default live; `dryRunOnly:true`,
     * `enabled:false`, or `liveScopes.bulkRecommended:false` can still
     * clamp this page back to dry-run.
 *
 * The native AS form is left intact — the AES panel is an alternative
 * path next to it, never a replacement.
 */
(function() {
    "use strict";

    if (!isAdjustPage()) return;

    let _booted = false;

    document.addEventListener("DOMContentLoaded", bootstrap);
    if (document.readyState === "interactive" || document.readyState === "complete") {
        bootstrap();
    }

    function isAdjustPage() {
        try {
            const url = new URL(window.location.href);
            return /flightsPrices/i.test(url.pathname) && url.searchParams.get("adjust") === "true";
        } catch (e) { return false; }
    }

    async function bootstrap() {
        if (_booted) return;
        _booted = true;

        const slot = findMountSlot();
        if (!slot) {
            console.warn("[AES flightsPrices] no .col-md-9 mount slot — skipping panel");
            return;
        }

        const PanelApi  = window.RouteAssistantFlightsPricesPanel;
        const BridgeApi = window.RouteAssistantFlightsPricesBridge;
        if (!PanelApi || !BridgeApi || typeof RouteAssistantPricingApplier === "undefined") {
            console.warn("[AES flightsPrices] dependencies not loaded; check manifest order");
            return;
        }

        // Settings — load via RouteAssistantSettings if present (so the
        // bridge sees the user's gate config), fall back to a permissive
        // default. Mirrors the inventory + RA panel bootstrap pattern.
        let settings = {};
        if (typeof RouteAssistantSettings !== "undefined" && RouteAssistantSettings.load) {
            try {
                const ra = await RouteAssistantSettings.load();
                settings = { routeAssistant: ra || {} };
            } catch (e) { console.warn("[AES flightsPrices] settings load failed", e); }
        }

        const server = (typeof AES !== "undefined" && AES.getServerName)
            ? AES.getServerName() : window.location.hostname.split(".")[0];
        const airline = (typeof AES !== "undefined" && AES.getAirlineIdentity)
            ? (AES.getAirlineIdentity() || "") : "";

        const applier = buildApplier(server, settings);
        const bridge  = new BridgeApi.RouteAssistantFlightsPricesBridge(server, airline, settings);
        const panel   = new PanelApi.RouteAssistantFlightsPricesPanel({ bridge, applier, settings });

        const host = document.createElement("div");
        host.className = "aes-fp-host";
        slot.appendChild(host);
        panel.mount(host);

        // Initial recommendation pass + filter-change subscription.
        const refresh = debounce(() => panel.refresh(readFormFilter()), 250);
        wireFormChange(refresh);
        refresh();
    }

    // ------------------------------------------------------------------

    function findMountSlot() {
        // Prefer the explicit empty col-md-9 next to the form. If the page
        // markup ever changes shape, fall back to the title's container.
        const cols = document.querySelectorAll("div.row > .col-md-9");
        for (const c of cols) {
            // Pick the first empty col-md-9 we find (the form sits in
            // col-md-3, the right-hand col-md-9 is empty in the snapshot).
            if (!c.querySelector("form") && c.children.length === 0) return c;
        }
        // Fallback: append below the title.
        const title = document.getElementById("title");
        if (title && title.parentElement) {
            const wrap = document.createElement("div");
            wrap.style.marginTop = "16px";
            title.parentElement.appendChild(wrap);
            return wrap;
        }
        return null;
    }

    function readFormFilter() {
        const form = document.querySelector("form[action='flightsPrices'], form[action$='flightsPrices']")
            || document.querySelector("form.as-panel");
        if (!form) return {};
        const get = (sel) => {
            const el = form.querySelector(sel);
            return el ? el.value : "";
        };
        const isChecked = (name) => {
            const cb = form.querySelector('input[name="' + name + '"]');
            return !!(cb && cb.checked);
        };
        const classes = [];
        if (isChecked("economy"))  classes.push("Y");
        if (isChecked("business")) classes.push("C");
        if (isChecked("first"))    classes.push("F");
        if (isChecked("cargo"))    classes.push("Cargo");
        return {
            fromCode:         get("#fromCode"),
            toCode:           get("#toCode"),
            serviceProfileId: get("#serviceProfileId"),
            base:             get("#base"),
            classes
        };
    }

    function wireFormChange(handler) {
        const form = document.querySelector("form[action='flightsPrices'], form[action$='flightsPrices']")
            || document.querySelector("form.as-panel");
        if (!form) return;
        form.addEventListener("change", handler);
        // Submit interception — never let the AS native bulk-form submit
        // sneak past silently. We don't BLOCK the form (the user may want
        // the native uniform adjustment); we only refresh our preview to
        // keep the UI honest while the page transitions.
        form.addEventListener("submit", () => handler());
    }

    function debounce(fn, ms) {
        let t = null;
        return function() {
            if (t) clearTimeout(t);
            t = setTimeout(() => { t = null; fn(); }, ms);
        };
    }

    function buildApplier(server, settings) {
        const ra = (settings && settings.routeAssistant) || {};
        const cfg = (ra.pricing && ra.pricing.apply) || {};
        const gate = {
            dryRunOnly:   cfg.dryRunOnly === true,
            applyEnabled: cfg.enabled !== false
        };
        const log = (typeof RouteAssistantPricingApplyLog !== "undefined" && server)
            ? new RouteAssistantPricingApplyLog({
                limit:         cfg.pricingApplyLogLimit  || 200,
                perRouteLimit: cfg.perRouteApplyLogLimit || 20
            })
            : null;
        return new RouteAssistantPricingApplier(server, {
            dryRunOnly:               gate.dryRunOnly,
            applyEnabled:             gate.applyEnabled,
            liveScopes:               Object.assign(
                {manual: true, bulk: true, silentAuto: true, bulkRecommended: true},
                cfg.liveScopes || {}
            ),
            cooldownMinPerRoute:      cfg.cooldownMinPerRoute,
            cooldownMinGlobal:        cfg.cooldownMinGlobal,
            warnAboveDeltaPct:        cfg.warnAboveDeltaPct,
            applyLog:                 log,
            circuitBreakerThreshold:  cfg.circuitBreakerThreshold,
            circuitBreakerCooldownMs: cfg.circuitBreakerCooldownMs,
            circuitBreakerTrippedAt:  cfg.circuitBreakerTrippedAt
        });
    }
})();
