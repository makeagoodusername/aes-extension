"use strict";

/**
 * AES Customization — applier.
 *
 * Builds and maintains a single <style id="aes-customization-overrides">
 * element appended to <head>. The element's textContent is regenerated
 * whenever the customization store changes; the browser re-resolves
 * every `var(--aes-*)` reference in already-painted DOM, so all
 * modules pick up the new values without any re-render.
 *
 * Cascade order (lowest specificity first):
 *   1. Preset       — :root layer
 *   2. Global scope — :root layer (later in source wins ties)
 *
 * Phase 2 will add per-section, per-tile, per-component layers using
 * higher-specificity selectors. The applier is structured so callers
 * can extend without reworking the cascade.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESCustomizationApplier) return;

    const STYLE_ID = "aes-customization-overrides";

    function ensureEl() {
        let el = document.getElementById(STYLE_ID);
        if (el) return el;
        el = document.createElement("style");
        el.id = STYLE_ID;
        el.setAttribute("data-aes", "customization");
        const head = document.head || document.documentElement;
        if (head) head.appendChild(el);
        return el;
    }

    /* Reject anything that could break out of the declaration (`;`, `}`),
       inject markup (`<`, `>`), or smuggle backslash escapes. Also reject
       newlines/tabs and other control characters. */
    function safeValue(s) {
        if (s == null) return null;
        const v = String(s).trim();
        if (!v) return null;
        for (let i = 0; i < v.length; i++) {
            const c = v.charCodeAt(i);
            if (c < 0x20 || c === 0x7f) return null;       // control chars
        }
        if (v.indexOf(";") !== -1) return null;
        if (v.indexOf("{") !== -1 || v.indexOf("}") !== -1) return null;
        if (v.indexOf("<") !== -1 || v.indexOf(">") !== -1) return null;
        if (v.indexOf("\\") !== -1) return null;
        return v;
    }

    function ruleBlock(selector, tokenMap, comment) {
        const decls = [];
        const keys = Object.keys(tokenMap);
        for (const k of keys) {
            if (k.indexOf("--") !== 0) continue;
            const v = safeValue(tokenMap[k]);
            if (v == null) continue;
            decls.push("  " + k + ": " + v + ";");
        }
        if (!decls.length) return "";
        const lines = [];
        if (comment) lines.push("/* " + comment + " */");
        lines.push(selector + " {");
        lines.push(decls.join("\n"));
        lines.push("}");
        return lines.join("\n");
    }

    /* B-1 density token table — compact/spacious shift the spacing scale
       inside a stamped surface. Comfortable is the inherited default
       and emits no rule. */
    const DENSITY_TOKENS = {
        compact: {
            "--aes-sp-2": "6px",
            "--aes-sp-3": "10px",
            "--aes-sp-4": "13px",
            "--aes-sp-5": "18px",
            "--aes-sp-6": "24px"
        },
        spacious: {
            "--aes-sp-2": "10px",
            "--aes-sp-3": "16px",
            "--aes-sp-4": "20px",
            "--aes-sp-5": "32px",
            "--aes-sp-6": "44px"
        }
    };

    /* Numeric scalar mapping for --aes-ornament-intensity, mirrored to
       the body attribute so skin CSS can gate via attribute selectors. */
    const INTENSITY_SCALAR = { none: "0", subtle: "1", moderate: "2", full: "3" };

    function build(snapshot) {
        const blocks = [];

        const store = window.AESCustomizationStore;
        const preset = store ? store.activePreset() : null;
        if (preset && preset.tokens) {
            blocks.push(ruleBlock(":root", preset.tokens, "preset: " + (preset.id || "?")));
        }

        const global = (snapshot && snapshot.scopes && snapshot.scopes.global) || {};
        if (Object.keys(global).length) {
            blocks.push(ruleBlock(":root", global, "global overrides"));
        }

        /* Per-section overrides. Selectors target the data-section attr
           that central-hub stamps on each section root. Specificity
           (0,1,0) wins over the :root layer. */
        const sectionScopes = (snapshot && snapshot.scopes && snapshot.scopes.section) || {};
        for (const id of Object.keys(sectionScopes)) {
            const tokens = sectionScopes[id];
            if (tokens && Object.keys(tokens).length) {
                blocks.push(ruleBlock('[data-section="' + cssIdent(id) + '"]', tokens, "section: " + id));
            }
        }

        /* Per-tile overrides. data-tile-id is stamped by tile.js on
           every tile root. Same specificity (0,1,0) as section, but
           emitted later so it wins ties. */
        const tileScopes = (snapshot && snapshot.scopes && snapshot.scopes.tile) || {};
        for (const id of Object.keys(tileScopes)) {
            const tokens = tileScopes[id];
            if (tokens && Object.keys(tokens).length) {
                blocks.push(ruleBlock('[data-tile-id="' + cssIdent(id) + '"]', tokens, "tile: " + id));
            }
        }

        /* B-1 ornament intensity — drives skin CSS gating and any
           module that wants to read the numeric scalar. */
        const intensity = (snapshot && snapshot.ornament && snapshot.ornament.intensity) || "moderate";
        const scalar = INTENSITY_SCALAR[intensity] || "2";
        blocks.push(ruleBlock(":root", { "--aes-ornament-intensity": scalar }, "ornament intensity"));

        /* B-1 per-surface density. Each entry emits its own scoped block
           so an unstamped surface continues to inherit the global cascade. */
        const densityBySurface = (snapshot && snapshot.density && snapshot.density.bySurface) || {};
        for (const surface of Object.keys(densityBySurface)) {
            const v = densityBySurface[surface];
            const tokens = DENSITY_TOKENS[v];
            if (tokens) {
                blocks.push(ruleBlock(
                    '[data-aes-surface="' + cssIdent(surface) + '"]',
                    tokens,
                    "density: " + surface + "=" + v
                ));
            }
        }

        /* B-1 numeric formatting — affects elements stamped with
           data-aes-numeric (or any descendant of a stamped surface). */
        const num = (snapshot && snapshot.numerals) || {};
        if (num.style) {
            const variant = num.style === "tabular" ? "tabular-nums lining-nums" : "proportional-nums";
            const feat = num.style === "tabular" ? '"tnum","lnum"' : '"pnum"';
            blocks.push(
                "/* numerals: " + num.style + " */\n" +
                "[data-aes-numeric] {\n" +
                "  font-variant-numeric: " + variant + ";\n" +
                "  font-feature-settings: " + feat + ";\n" +
                "}"
            );
        }

        return blocks.filter(Boolean).join("\n\n");
    }

    /* Defensive sanitiser for IDs that flow into selectors. The store
       only ever stores IDs we register, but a malformed JSON import
       could carry garbage; refuse anything outside [a-zA-Z0-9_-]. */
    function cssIdent(s) {
        return String(s).replace(/[^a-zA-Z0-9_-]/g, "");
    }

    /* Flip body[data-aes-skin] from the active preset's optional `skin`
       field. Used by deco-ivory / deco-noir to switch on the Art Deco
       ornament layer in css/skin/skin-art-deco.css. Other presets leave
       the attribute unset, so the ornament layer stays inert.

       Also writes body[data-aes-ornament] from the customization
       ornament intensity so skin CSS attribute selectors can gate
       effects per intensity level. */
    function applySkin() {
        const body = document.body;
        if (!body) return;
        const store = window.AESCustomizationStore;
        const preset = store ? store.activePreset() : null;
        const skin = preset && typeof preset.skin === "string" ? preset.skin : "";
        const safe = skin.replace(/[^a-zA-Z0-9_-]/g, "");
        if (safe) {
            if (body.getAttribute("data-aes-skin") !== safe) {
                body.setAttribute("data-aes-skin", safe);
            }
        } else if (body.hasAttribute("data-aes-skin")) {
            body.removeAttribute("data-aes-skin");
        }

        const intensity = store && typeof store.ornamentIntensity === "function"
            ? store.ornamentIntensity() : "moderate";
        const safeIntensity = String(intensity).replace(/[^a-z]/g, "");
        if (safeIntensity) {
            if (body.getAttribute("data-aes-ornament") !== safeIntensity) {
                body.setAttribute("data-aes-ornament", safeIntensity);
            }
        }
    }

    function apply() {
        const store = window.AESCustomizationStore;
        const snapshot = store ? store.get() : null;
        const css = build(snapshot);
        const el = ensureEl();
        if (el.textContent !== css) {
            el.textContent = css;
        }
        applySkin();
    }

    function boot() {
        const store = window.AESCustomizationStore;
        if (!store) return;
        store.load().then(function () { apply(); });
        store.subscribe(function () { apply(); });
    }

    window.AESCustomizationApplier = {
        STYLE_ID,
        boot,
        apply,
        _build: build
    };
})();
