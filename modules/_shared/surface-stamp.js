"use strict";

/**
 * AES Surface Stamp — tag an element as a customisation surface.
 *
 * The customization applier emits per-surface rules under
 * `[data-aes-surface="<kind>"]` selectors (per-surface density today,
 * future per-surface palette/typography). For those rules to take
 * effect a surface element must carry the matching attribute.
 *
 * Central-hub tile.js / shell.js stamp `tile` and `panel` automatically.
 * Modal / table / card consumers opt in via this helper so the call site
 * stays a single line.
 *
 * Surface kinds match modules/customization/applier.js DENSITY_TOKENS
 * keys and modules/customization/store.js DENSITY_VALUES allow-list.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AesSurface) return;

    const KINDS = ["panel", "tile", "modal", "table", "card"];

    function stamp(el, kind) {
        if (!el || !el.setAttribute) return;
        if (KINDS.indexOf(kind) < 0) return;
        if (el.getAttribute("data-aes-surface") === kind) return;
        el.setAttribute("data-aes-surface", kind);
    }

    function unstamp(el) {
        if (!el || !el.removeAttribute) return;
        if (el.hasAttribute("data-aes-surface")) {
            el.removeAttribute("data-aes-surface");
        }
    }

    window.AesSurface = { stamp, unstamp, KINDS };
})();
