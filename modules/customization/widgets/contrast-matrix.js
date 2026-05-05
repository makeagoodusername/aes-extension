"use strict";

/**
 * AES Customization — contrast pairing matrix.
 *
 * Renders a small grid: rows = background tokens, columns = foreground
 * tokens, cells = WCAG 2.1 contrast ratio with AA/AAA stamp.
 * AAA > 7, AA > 4.5, LG (large-text AA) > 3, fail otherwise. Click a
 * cell to jump straight to editing whichever token has lower contrast.
 *
 * Uses getComputedStyle to resolve var(--aes-*) → hex, then runs the
 * relative-luminance formula. Recomputed on every store change.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioContrastMatrix) return;

    // Pairs we actually care about — bg/fg combos that show up in real UI
    const BACKGROUNDS = ["--aes-bone", "--aes-bone-2", "--aes-oxide-bg", "--aes-rust", "--aes-cobalt"];
    const FOREGROUNDS = ["--aes-oxide", "--aes-oxide-2", "--aes-bone", "--aes-rust", "--aes-bone-fg"];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const tbl = document.createElement("table");
        tbl.style.cssText = [
            "border-collapse:collapse",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.oxide
        ].join(";");

        const head = document.createElement("tr");
        head.appendChild(cornerCell(T));
        for (const fg of FOREGROUNDS) head.appendChild(headerCell(T, fg, "fg"));
        tbl.appendChild(head);

        for (const bg of BACKGROUNDS) {
            const row = document.createElement("tr");
            row.appendChild(headerCell(T, bg, "bg"));
            for (const fg of FOREGROUNDS) {
                row.appendChild(matrixCell(T, bg, fg));
            }
            tbl.appendChild(row);
        }
        host.appendChild(tbl);
    }

    function cornerCell(T) {
        const td = document.createElement("td");
        td.textContent = "BG ↓ / FG →";
        td.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-size:" + T.fs.micro,
            "background:" + T.color.bone2,
            "color:" + T.color.oxide2,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps
        ].join(";");
        return td;
    }

    function headerCell(T, cssVar, kind) {
        const td = document.createElement("td");
        const lbl = cssVar.replace("--aes-", "").toUpperCase();
        td.textContent = lbl;
        td.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-size:" + T.fs.micro,
            "background:" + (kind === "bg" ? "var(" + cssVar + ")" : T.color.bone),
            "color:" + (kind === "bg" && isDark(cssVar) ? T.color.bone : T.color.oxide),
            "white-space:nowrap"
        ].join(";");
        return td;
    }

    function matrixCell(T, bgVar, fgVar) {
        const td = document.createElement("td");
        td.style.cssText = [
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "padding:" + T.sp[2],
            "background:var(" + bgVar + ")",
            "color:var(" + fgVar + ")",
            "text-align:center",
            "min-width:64px",
            "cursor:pointer"
        ].join(";");
        function refresh() {
            const ratio = contrastRatio(bgVar, fgVar);
            td.textContent = ratio.toFixed(2);
            const stamp = stampOf(ratio);
            td.title = bgVar + " on " + fgVar + " = " + ratio.toFixed(2) + " — " + stamp;
            td.appendChild(buildStamp(T, stamp));
        }
        refresh();
        const store = window.AESCustomizationStore;
        if (store) store.subscribe(refresh);
        td.addEventListener("click", function () {
            // Jump into editing whichever token has lower luminance contrast effect
            const swatchHost = window.AESStudioSwatchGrid;
            if (!swatchHost) return;
            // Open the swatch popover for the foreground token (most common edit)
            // by simulating the click flow. For now, just notify the user.
            const evt = new CustomEvent("aes-studio:focus-token", { detail: { cssVar: fgVar } });
            document.dispatchEvent(evt);
        });
        return td;
    }

    function buildStamp(T, stamp) {
        const sp = document.createElement("span");
        sp.textContent = " " + stamp;
        sp.style.cssText = [
            "display:inline-block",
            "margin-left:" + T.sp[1],
            "padding:0 4px",
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "border:1px solid currentColor",
            "vertical-align:middle"
        ].join(";");
        return sp;
    }

    function stampOf(r) {
        if (r >= 7) return "AAA";
        if (r >= 4.5) return "AA";
        if (r >= 3) return "LG";
        return "FAIL";
    }

    function readVar(cssVar) {
        try {
            return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
        } catch (_) { return ""; }
    }

    function isDark(cssVar) {
        const hex = readVar(cssVar);
        const rgb = parseColor(hex);
        if (!rgb) return false;
        const lum = relLum(rgb);
        return lum < 0.5;
    }

    function contrastRatio(bgVar, fgVar) {
        const bg = parseColor(readVar(bgVar));
        const fg = parseColor(readVar(fgVar));
        if (!bg || !fg) return 1;
        const l1 = relLum(bg);
        const l2 = relLum(fg);
        const lighter = Math.max(l1, l2);
        const darker  = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
    }

    function parseColor(s) {
        if (!s) return null;
        const t = s.trim();
        const hex3 = /^#([0-9a-fA-F]{3})$/.exec(t);
        if (hex3) {
            const h = hex3[1];
            return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
        }
        const hex6 = /^#([0-9a-fA-F]{6})$/.exec(t);
        if (hex6) {
            const h = hex6[1];
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
        const rgba = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(t);
        if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
        return null;
    }

    function relLum(rgb) {
        const norm = rgb.map(function (v) {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * norm[0] + 0.7152 * norm[1] + 0.0722 * norm[2];
    }

    window.AESStudioContrastMatrix = { render, _contrastRatio: contrastRatio };
})();
