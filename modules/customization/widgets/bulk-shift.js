"use strict";

/**
 * AES Customization — bulk-shift widget.
 *
 * Three sliders that nudge the entire colour palette in HSL space:
 *   HUE       -180° to +180°
 *   SATURATION -100% to +100%
 *   LIGHTNESS  -100% to +100%
 *
 * "Bake" applies the current shift as overrides; "Revert" clears them.
 * The sliders preview live (overrides flow through the engine on every
 * input event), so users see the change as they drag.
 *
 * Conversion: read each token's literal hex via getComputedStyle → HSL,
 * apply delta, hex back, write override. Bulk operations are cheap —
 * just a few hex/HSL conversions per token.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioBulkShift) return;

    // Tokens that participate in the bulk shift — only the primary
    // chromatic palette. Status colours (cobalt/moss/amber/crimson) are
    // semantic; we don't want hue-shifting to muddy "warning yellow"
    // into a rust. Same for paper rules.
    const TARGETS = [
        "--aes-bone", "--aes-bone-2", "--aes-bone-3",
        "--aes-oxide", "--aes-oxide-2", "--aes-slate",
        "--aes-rust", "--aes-rust-deep"
    ];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const slider = window.AESStudioSlider;
        const store = window.AESCustomizationStore;
        if (!slider || !store) return;

        let dh = 0, ds = 0, dl = 0;

        const intro = document.createElement("div");
        intro.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.slate,
            "margin-bottom:" + T.sp[2]
        ].join(";");
        intro.textContent = "BULK SHIFT — preview live, BAKE to commit, REVERT to undo.";
        host.appendChild(intro);

        function previewAll() {
            const tokens = {};
            for (const tok of TARGETS) {
                const lit = readLit(tok);
                const rgb = parseColor(lit);
                if (!rgb) continue;
                const hsl = rgbToHsl(rgb);
                const shifted = [
                    (hsl[0] + dh + 360) % 360,
                    clamp(hsl[1] + ds, 0, 100),
                    clamp(hsl[2] + dl, 0, 100)
                ];
                tokens[tok] = rgbToHex(hslToRgb(shifted));
            }
            // Single batched scope-aware write through the store
            store.setOverridesBatch(tokens);
        }

        host.appendChild(slider.render({
            label: "Hue",
            value: 0, min: -180, max: 180, step: 1,
            unit: "°", onChange: function (n) { dh = n; previewAll(); }
        }));
        host.appendChild(slider.render({
            label: "Saturation",
            value: 0, min: -100, max: 100, step: 1,
            unit: "%", onChange: function (n) { ds = n; previewAll(); }
        }));
        host.appendChild(slider.render({
            label: "Lightness",
            value: 0, min: -100, max: 100, step: 1,
            unit: "%", onChange: function (n) { dl = n; previewAll(); }
        }));

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:" + T.sp[2] + ";margin-top:" + T.sp[3];
        actions.appendChild(button(T, "Revert", function () {
            dh = ds = dl = 0;
            const tokens = {};
            for (const tok of TARGETS) tokens[tok] = null;
            store.setOverridesBatch(tokens);
            render(host);
        }));
        actions.appendChild(button(T, "Bake", function () {
            // Already written via previewAll; baking is just clearing
            // the local deltas so a subsequent shift starts from the
            // already-baked values.
            dh = ds = dl = 0;
            render(host);
        }));
        host.appendChild(actions);
    }

    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
    function readLit(cssVar) {
        try { return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim(); }
        catch (_) { return ""; }
    }

    function parseColor(s) {
        if (!s) return null;
        const t = s.trim();
        const h6 = /^#([0-9a-fA-F]{6})$/.exec(t);
        if (h6) {
            const h = h6[1];
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
        const h3 = /^#([0-9a-fA-F]{3})$/.exec(t);
        if (h3) {
            const h = h3[1];
            return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
        }
        const rgba = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(t);
        if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
        return null;
    }

    function rgbToHsl(rgb) {
        const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0;
        const l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h = h * 60;
        }
        return [h, s * 100, l * 100];
    }

    function hslToRgb(hsl) {
        const h = hsl[0] / 360, s = hsl[1] / 100, l = hsl[2] / 100;
        if (s === 0) {
            const v = Math.round(l * 255);
            return [v, v, v];
        }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        function hue(t) {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        }
        return [
            Math.round(hue(h + 1/3) * 255),
            Math.round(hue(h) * 255),
            Math.round(hue(h - 1/3) * 255)
        ];
    }

    function rgbToHex(rgb) {
        function pad(n) { return n.toString(16).padStart(2, "0"); }
        return "#" + pad(rgb[0]) + pad(rgb[1]) + pad(rgb[2]);
    }

    function button(T, label, onClick) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:700",
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
        b.addEventListener("click", function (e) { e.preventDefault(); onClick(); });
        return b;
    }

    window.AESStudioBulkShift = { render };
})();
