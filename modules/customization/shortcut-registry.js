"use strict";

/**
 * AES Customization — shortcut registry.
 *
 * Canonical id-keyed list of every keyboard action. Replaces the static
 * array that used to live inside keyboard-shortcuts.js. Only the `keys`
 * binding (and a `disabled` flag) is overrideable per action; the
 * action itself (`go`/`action` callback) stays in code so users can't
 * inject behavior via storage.
 *
 * Resolution merges the customization store's `shortcuts` patches over
 * the defaults. The matcher in keyboard-shortcuts.js indexes by id at
 * registry-change time, so rebinds take effect after one storage event.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESShortcutRegistry) return;

    const HUB_RE = /\/app\/com\/scheduling\/([^/?#]+)/;
    const ENTERPRISE_RE = /\/app\/info\/enterprises\/([^/?#]+)/;

    /* DEFAULTS — id → {keys, desc, go|action}. `keys` follows the same
       grammar as the existing matcher: a space-separated chord like
       `g d`, or a single key like `/` or `?`. */
    const DEFAULTS = [
        { id: "nav.dashboard",   keys: "g d", desc: "Dashboard",          go: () => "/app/enterprise/dashboard" },
        { id: "nav.fleet",       keys: "g f", desc: "Fleets",             go: () => "/app/fleets" },
        { id: "nav.scheduling",  keys: "g s", desc: "Scheduling (hub)",   go: () => {
            const m = location.pathname.match(HUB_RE);
            return m ? "/app/com/scheduling/" + m[1] : null;
        } },
        { id: "nav.accounting",  keys: "g a", desc: "Accounting",         go: () => "/app/finance/accounting" },
        { id: "nav.leasing",     keys: "g l", desc: "Leasing",            go: () => "/app/finance/leasing" },
        { id: "nav.inventory",   keys: "g i", desc: "Inventory (hub)",    go: () => {
            const m = location.pathname.match(HUB_RE);
            return m ? "/app/com/inventory/" + m[1] : "/app/com/inventory";
        } },
        { id: "nav.markets",     keys: "g m", desc: "Markets (hub)",      go: () => {
            const m = location.pathname.match(HUB_RE);
            return m ? "/app/com/markets/" + m[1] : null;
        } },
        { id: "nav.stations",    keys: "g o", desc: "Stations / ops",     go: () => "/app/ops/stations" },
        { id: "nav.enterprise",  keys: "g e", desc: "Enterprise info",    go: () => {
            const m = location.pathname.match(ENTERPRISE_RE);
            return m ? "/app/info/enterprises/" + m[1] : null;
        } },
        { id: "nav.settings",    keys: "g x", desc: "Settings",           go: () => "/app/enterprise/settings" },
        { id: "studio.toggle",   keys: "g c", desc: "Customization Studio", action: function () {
            const host = window.AESCustomizationHost;
            if (host && typeof host.toggle === "function") host.toggle();
        } },
        { id: "page.search",     keys: "/",   desc: "Focus search/filter input", action: "focusFilter" },
        { id: "page.help",       keys: "?",   desc: "Show shortcuts",     action: "showHelp" },
        { id: "page.escape",     keys: "Esc", desc: "Close popover/help / clear filter", action: null }
    ];

    const BY_ID = Object.create(null);
    for (const d of DEFAULTS) BY_ID[d.id] = d;

    /**
     * Snapshot of resolved shortcuts — defaults overlaid with the user's
     * `keys` and `disabled` patches from the customization store. Action
     * callables stay from DEFAULTS so storage cannot inject code.
     */
    function resolved() {
        const out = [];
        const overrides = (window.AESCustomizationStore
            && window.AESCustomizationStore.shortcutOverrides()) || {};
        for (const d of DEFAULTS) {
            const ov = overrides[d.id];
            const keys = (ov && typeof ov.keys === "string" && ov.keys.trim())
                ? ov.keys.trim() : d.keys;
            const disabled = !!(ov && ov.disabled);
            out.push({
                id: d.id,
                keys: keys,
                defaultKeys: d.keys,
                disabled: disabled,
                desc: d.desc,
                go: d.go,
                action: d.action
            });
        }
        return out;
    }

    /**
     * @returns {Array<{id, keysA, keysB}>} pairs of conflicting bindings
     */
    function conflicts(list) {
        const items = list || resolved();
        const seen = Object.create(null);
        const out = [];
        for (const it of items) {
            if (it.disabled) continue;
            const k = it.keys;
            if (!k) continue;
            if (seen[k]) {
                out.push({ id: it.id, keysA: k, conflictsWith: seen[k] });
            } else {
                seen[k] = it.id;
            }
        }
        return out;
    }

    function getById(id) { return BY_ID[id] || null; }

    window.AESShortcutRegistry = {
        DEFAULTS,
        resolved,
        conflicts,
        getById
    };
})();
