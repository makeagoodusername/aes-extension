/* ===========================================================
   AES "CONCRETE" — js/design-tokens.js
   Mirror of design-tokens.css as a JS object on window.AESTokens.
   Used by modules that build DOM with inline `style.cssText` strings
   instead of (or in addition to) class-based styling.
   Source of truth is the CSS file; this file MUST stay in sync.
   =========================================================== */

(function () {
    "use strict";

    if (typeof window === "undefined") { return; }
    if (window.AESTokens) { return; }

    const T = {
        color: {
            // Bone family — light surfaces
            bone:       "#F4F1EA",
            bone2:      "#ECE7DC",
            bone3:      "#E0DAC8",
            paperRule:  "#C9C0B0",

            // Oxide family — text & structure
            oxide:      "#2B2520",
            oxide2:     "#4A413B",
            slate:      "#7A6F66",

            // Dark variant — toasts, status overlays
            oxideBg:    "#1A1612",
            oxideBg2:   "#28221C",
            boneFg:     "#F4F1EA",
            oxideRule:  "#4A413B",

            // Signal accent
            rust:        "#B8472A",
            rustSoft:    "rgba(184, 71, 42, 0.12)",
            rustDeep:    "#8B3520",
            rustFg:      "#F4F1EA",

            // Status (semantic only)
            cobalt:        "#3656A8",
            cobaltSoft:    "rgba(54, 86, 168, 0.14)",
            moss:          "#2F5F3F",
            mossSoft:      "rgba(47, 95, 63, 0.14)",
            amber:         "#B8861F",
            amberSoft:     "rgba(184, 134, 31, 0.14)",
            crimson:       "#8B2727",
            crimsonSoft:   "rgba(139, 39, 39, 0.14)"
        },

        font: {
            display: "'Inter Tight', 'Helvetica Now Display', 'Helvetica Neue', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            mono:    "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        },

        fs: {
            micro:   "10px",
            small:   "11px",
            body:    "12px",
            lead:    "14px",
            h3:      "18px",
            h2:      "24px",
            h1:      "36px",
            display: "56px"
        },

        fw: {
            regular: 400,
            medium:  500,
            bold:    700,
            display: 800,
            black:   900
        },

        lh: {
            tight: 1.15,
            body:  1.4
        },

        track: {
            caps: "0.08em",
            mono: "0.02em"
        },

        sp: {
            1: "4px",
            2: "8px",
            3: "12px",
            4: "16px",
            5: "24px",
            6: "32px",
            7: "48px"
        },

        geom: {
            radius: "0",
            bw1:    "1px",
            bw2:    "2px",
            bw3:    "3px"
        },

        z: {
            base:    1,
            overlay: 100,
            panel:   1000,
            popover: 9000,
            modal:   10000,
            toast:   10001
        },

        tr: {
            fast:   "80ms linear",
            medium: "140ms linear"
        }
    };

    // Convenience helpers —
    // Build a panel-card style string in one line:
    //   el.style.cssText = AESTokens.styles.panel();
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

    window.AESTokens = T;
})();
