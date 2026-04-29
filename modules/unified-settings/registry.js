"use strict";

/**
 * Unified Settings — module-registration contract.
 *
 * Module owners register a settings adapter once at load time:
 *
 *   AesUnifiedSettingsRegistry.register({
 *     moduleId: "route-assistant",
 *     label:    "Route Assistant",
 *     icon:     "🧭",          // optional (renders as text in the rail)
 *     mount:    function (host) { ... },
 *     unmount:  function (host) { ... },   // optional cleanup
 *     search:   function () {              // optional search index source
 *       return [{ label: "Scoring weights", deepLinkPath: "scoring" }, ...];
 *     }
 *   });
 *
 * The shell's Modules tab renders a second-level rail of registered
 * adapters and calls mount(host) when the user clicks one.
 *
 * Re-registering the same moduleId replaces the prior entry. Returns
 * an unregister function from register().
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AesUnifiedSettingsRegistry) return;

    const byId = new Map();
    const subs = new Set();

    function notify(kind, payload) {
        for (const fn of Array.from(subs)) {
            try { fn({ kind: kind, payload: payload }); }
            catch (e) { console && console.warn && console.warn("[unified-settings registry]", e); }
        }
    }

    function register(spec) {
        if (!spec || typeof spec !== "object") return function () {};
        const moduleId = String(spec.moduleId || "").trim();
        if (!moduleId) return function () {};
        if (typeof spec.mount !== "function") return function () {};
        const entry = {
            moduleId: moduleId,
            label:    String(spec.label || moduleId),
            icon:     spec.icon ? String(spec.icon) : "",
            mount:    spec.mount,
            unmount:  typeof spec.unmount === "function" ? spec.unmount : null,
            search:   typeof spec.search === "function" ? spec.search : null
        };
        byId.set(moduleId, entry);
        notify("registered", entry);
        return function unregister() {
            if (byId.get(moduleId) === entry) {
                byId.delete(moduleId);
                notify("unregistered", entry);
            }
        };
    }

    function get(moduleId) {
        return byId.get(moduleId) || null;
    }

    function list() {
        return Array.from(byId.values()).sort(function (a, b) {
            return a.label.localeCompare(b.label);
        });
    }

    function subscribe(fn) {
        if (typeof fn !== "function") return function () {};
        subs.add(fn);
        return function () { subs.delete(fn); };
    }

    window.AesUnifiedSettingsRegistry = { register, get, list, subscribe };
})();
