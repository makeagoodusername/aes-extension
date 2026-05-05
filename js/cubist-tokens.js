/* ===========================================================
   AES "FACET" — js/cubist-tokens.js
   Cubist-specific token map. Mirror of the Cubist additions in
   css/design-tokens.css and css/cubist.css, exposed as
   window.AESCubistTokens for JS callers building inline cssText.

   The brutalist core (bone/oxide/slate/rust) stays on AESTokens.
   AESCubistTokens carries only the polygon library and Cubist
   geometry — additive, never overriding existing tokens.

   Like js/design-tokens.js: each getter returns a `var(--aes-*)`
   reference rather than a literal, so changing the CSS custom
   property at runtime updates inline-styled callers on next paint.
   =========================================================== */

(function () {
    "use strict";

    if (typeof window === "undefined") { return; }
    if (window.AESCubistTokens) { return; }

    function v(cssVar) { return "var(" + cssVar + ")"; }

    const C = {
        /* ---- Polygon clip-path references (mirror cubist.css) - */
        poly: {
            wedgeTL:    v("--poly-wedge-tl"),
            wedgeTR:    v("--poly-wedge-tr"),
            wedgeBL:    v("--poly-wedge-bl"),
            wedgeBR:    v("--poly-wedge-br"),
            pentagonR:  v("--poly-pentagon-r"),
            pentagonL:  v("--poly-pentagon-l"),
            pentagonT:  v("--poly-pentagon-t"),
            pentagonB:  v("--poly-pentagon-b"),
            lozengeC:   v("--poly-lozenge-c"),
            trapezoidT: v("--poly-trapezoid-t"),
            trapezoidB: v("--poly-trapezoid-b"),
            rect:       v("--poly-rect")
        },

        /* ---- Shape names accepted as Facet({shape}) ----------- */
        shapes: [
            "wedge-tl", "wedge-tr", "wedge-bl", "wedge-br",
            "pentagon-r", "pentagon-l", "pentagon-t", "pentagon-b",
            "lozenge-c", "trapezoid-t", "trapezoid-b", "rect"
        ],

        /* ---- Cubist geometry tokens --------------------------- */
        seam: {
            angle: v("--aes-cubist-seam-angle"),
            color: v("--aes-oxide"),
            width: v("--aes-bw-1")
        },

        pivot: {
            amount: v("--aes-cubist-pivot")
        },

        ghost: {
            offset: v("--aes-cubist-ghost-offset"),
            alpha:  v("--aes-cubist-ghost-alpha")
        },

        /* ---- Cubist palette (signal accents on top of AES) ---- */
        palette: {
            vermilion:     v("--aes-vermilion"),
            vermilionSoft: v("--aes-vermilion-soft"),
            viridian:      v("--aes-viridian"),
            viridianSoft:  v("--aes-viridian-soft"),
            gold:          v("--aes-gold"),
            goldSoft:      v("--aes-gold-soft")
        },

        /* ---- Composition presets ------------------------------ */
        compositions: ["totem", "landscape", "still-life"],

        /* ---- Active flag — true when body.aes-cubist is set --- */
        isActive: function () {
            try {
                return document.body && document.body.classList &&
                       document.body.classList.contains("aes-cubist");
            } catch (_) { return false; }
        }
    };

    window.AESCubistTokens = C;

    // CB2 — universal body-class toggle so cubist surfaces outside the
    // Central Hub (Flight Studio, etc.) activate from the same setting.
    // Hub's shell.js also toggles this class on its own mount; idempotent.
    (function bootstrapCubistBody() {
        if (typeof chrome === "undefined" || !chrome.storage) return;
        const KEY = "centralHub:settings";

        function apply(on) {
            try {
                if (document.body && document.body.classList) {
                    document.body.classList.toggle("aes-cubist", !!on);
                }
            } catch (_) { /* noop */ }
        }

        function readAndApply() {
            chrome.storage.local.get([KEY], function (blob) {
                const s = blob && blob[KEY];
                apply(s && s.cubistMode);
            });
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", readAndApply, {once: true});
        } else {
            readAndApply();
        }

        try {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return;
                if (!changes[KEY]) return;
                const next = changes[KEY].newValue;
                apply(next && next.cubistMode);
            });
        } catch (_) { /* noop */ }
    })();
})();
