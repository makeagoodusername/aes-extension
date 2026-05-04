/* ===========================================================
   AES "CONCRETE" — js/design-tokens.js
   Mirror of design-tokens.css as a JS object on window.AESTokens.

   Each token getter returns a CSS `var(--aes-*)` reference rather than
   a literal value. Modules concatenate these into `style.cssText`; the
   browser resolves the variable on every paint, so changing the CSS
   custom property at runtime updates every existing inline-styled
   element instantly without re-rendering. The customization engine
   exploits this — see modules/customization/applier.js.

   The CSS file (css/design-tokens.css) is the source of truth for
   default values. This file holds the JS-side map from camelCase paths
   to CSS variable names. They MUST stay in sync.

   For the rare caller that needs a resolved literal (color math,
   string comparison), use `AESTokens.literal.color.bone` which reads
   the computed value off `:root`.
   =========================================================== */

(function () {
    "use strict";

    if (typeof window === "undefined") { return; }
    if (window.AESTokens) { return; }

    function v(cssVar) { return "var(" + cssVar + ")"; }

    const T = {
        color: {
            bone:        v("--aes-bone"),
            bone2:       v("--aes-bone-2"),
            bone3:       v("--aes-bone-3"),
            paperRule:   v("--aes-paper-rule"),

            oxide:       v("--aes-oxide"),
            oxide2:      v("--aes-oxide-2"),
            slate:       v("--aes-slate"),

            oxideBg:     v("--aes-oxide-bg"),
            oxideBg2:    v("--aes-oxide-bg-2"),
            boneFg:      v("--aes-bone-fg"),
            oxideRule:   v("--aes-oxide-rule"),

            rust:        v("--aes-rust"),
            rustSoft:    v("--aes-rust-soft"),
            rustDeep:    v("--aes-rust-deep"),
            rustFg:      v("--aes-rust-fg"),

            cobalt:      v("--aes-cobalt"),
            cobaltSoft:  v("--aes-cobalt-soft"),
            moss:        v("--aes-moss"),
            mossSoft:    v("--aes-moss-soft"),
            amber:       v("--aes-amber"),
            amberSoft:   v("--aes-amber-soft"),
            crimson:     v("--aes-crimson"),
            crimsonSoft: v("--aes-crimson-soft"),

            // Cubist accents — additive; consumed under body.aes-cubist
            vermilion:     v("--aes-vermilion"),
            vermilionSoft: v("--aes-vermilion-soft"),
            viridian:      v("--aes-viridian"),
            viridianSoft:  v("--aes-viridian-soft"),
            gold:          v("--aes-gold"),
            goldSoft:      v("--aes-gold-soft")
        },

        font: {
            display: v("--aes-font-display"),
            mono:    v("--aes-font-mono")
        },

        fs: {
            micro:   v("--aes-fs-micro"),
            small:   v("--aes-fs-small"),
            body:    v("--aes-fs-body"),
            lead:    v("--aes-fs-lead"),
            h3:      v("--aes-fs-h3"),
            h2:      v("--aes-fs-h2"),
            h1:      v("--aes-fs-h1"),
            display: v("--aes-fs-display")
        },

        fw: {
            regular: v("--aes-fw-regular"),
            medium:  v("--aes-fw-medium"),
            bold:    v("--aes-fw-bold"),
            display: v("--aes-fw-display"),
            black:   v("--aes-fw-black")
        },

        lh: {
            tight: v("--aes-lh-tight"),
            body:  v("--aes-lh-body")
        },

        track: {
            caps: v("--aes-tracking-caps"),
            mono: v("--aes-tracking-mono")
        },

        sp: {
            0: "0",
            1: v("--aes-sp-1"),
            2: v("--aes-sp-2"),
            3: v("--aes-sp-3"),
            4: v("--aes-sp-4"),
            5: v("--aes-sp-5"),
            6: v("--aes-sp-6"),
            7: v("--aes-sp-7")
        },

        geom: {
            radius: v("--aes-radius"),
            bw1:    v("--aes-bw-1"),
            bw2:    v("--aes-bw-2"),
            bw3:    v("--aes-bw-3")
        },

        z: {
            base:    v("--aes-z-base"),
            overlay: v("--aes-z-overlay"),
            panel:   v("--aes-z-panel"),
            popover: v("--aes-z-popover"),
            modal:   v("--aes-z-modal"),
            toast:   v("--aes-z-toast")
        },

        tr: {
            fast:   v("--aes-tr-fast"),
            medium: v("--aes-tr-medium")
        }
    };

    // Convenience helpers — unchanged behaviour. The strings they produce
    // now carry `var(--aes-*)` references, so they recolor live as the
    // customization engine writes new values to the cascade.
    T.styles = {
        panel: function (opts) {
            const dark = opts && opts.dark;
            const bg = dark ? T.color.oxideBg : T.color.bone;
            const fg = dark ? T.color.boneFg : T.color.oxide;
            return [
                "background:" + bg,
                "color:" + fg,
                "border:" + T.geom.bw2 + " solid " + T.color.oxide,
                "border-radius:" + T.geom.radius,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "line-height:" + T.lh.body,
                "box-sizing:border-box"
            ].join(";");
        },
        panelHeader: function () {
            return [
                "display:flex",
                "align-items:center",
                "gap:" + T.sp[2],
                "padding:" + T.sp[2] + " " + T.sp[3],
                "background:" + T.color.bone2,
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "box-shadow:0 " + T.sp[1] + " 0 0 " + T.color.bone +
                              ", 0 calc(" + T.sp[1] + " + 1px) 0 0 " + T.color.oxide,
                "margin-bottom:calc(" + T.sp[1] + " + 1px)"
            ].join(";");
        },
        title: function () {
            return [
                "font-family:" + T.font.display,
                "font-size:" + T.fs.lead,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "color:" + T.color.oxide,
                "margin:0",
                "line-height:" + T.lh.tight
            ].join(";");
        },
        mono: function () {
            return [
                "font-family:" + T.font.mono,
                "letter-spacing:" + T.track.mono
            ].join(";");
        }
    };

    // Escape hatch — read the resolved literal off :root for callers that
    // need to do colour math or string compare. Lazy, no upkeep cost when
    // unused. Returns "" if the document hasn't loaded the CSS yet.
    function readLiteral(cssVar) {
        try {
            return getComputedStyle(document.documentElement)
                .getPropertyValue(cssVar)
                .trim();
        } catch (_) {
            return "";
        }
    }

    T.literal = {
        color: new Proxy({}, {
            get: function (_, k) {
                const map = {
                    bone: "--aes-bone", bone2: "--aes-bone-2", bone3: "--aes-bone-3",
                    paperRule: "--aes-paper-rule",
                    oxide: "--aes-oxide", oxide2: "--aes-oxide-2", slate: "--aes-slate",
                    oxideBg: "--aes-oxide-bg", oxideBg2: "--aes-oxide-bg-2",
                    boneFg: "--aes-bone-fg", oxideRule: "--aes-oxide-rule",
                    rust: "--aes-rust", rustSoft: "--aes-rust-soft",
                    rustDeep: "--aes-rust-deep", rustFg: "--aes-rust-fg",
                    cobalt: "--aes-cobalt", cobaltSoft: "--aes-cobalt-soft",
                    moss: "--aes-moss", mossSoft: "--aes-moss-soft",
                    amber: "--aes-amber", amberSoft: "--aes-amber-soft",
                    crimson: "--aes-crimson", crimsonSoft: "--aes-crimson-soft",
                    vermilion: "--aes-vermilion", vermilionSoft: "--aes-vermilion-soft",
                    viridian: "--aes-viridian", viridianSoft: "--aes-viridian-soft",
                    gold: "--aes-gold", goldSoft: "--aes-gold-soft"
                };
                const cssVar = map[k];
                return cssVar ? readLiteral(cssVar) : "";
            }
        })
    };

    window.AESTokens = T;
})();
