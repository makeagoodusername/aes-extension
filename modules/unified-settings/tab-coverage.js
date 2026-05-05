"use strict";

/**
 * AES Unified Settings — Coverage tab.
 *
 * Read-only diagnostics surface listing every AS page family that
 * `site-skin/bootstrap.js` knows how to classify, plus the depth of
 * AES skin coverage (deep / thin / global / absent). Useful when the
 * user wonders "why does this page look unstyled" — the table makes
 * the gap obvious. Reuses the FreshnessPill component (depthBand mode)
 * for status chips so the visual vocabulary stays consistent with the
 * tile freshness pills.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AesUnifiedSettingsTabs) window.AesUnifiedSettingsTabs = {};
    if (window.AesUnifiedSettingsTabs.coverage) return;

    function el(tag, style, text) {
        const e = document.createElement(tag);
        if (style) e.style.cssText = style;
        if (text != null) e.textContent = text;
        return e;
    }

    function depthBandToken(depth) {
        switch (depth) {
            case "deep":   return "deep";
            case "thin":   return "thin";
            case "global": return "current";   // global is acceptable, render blue
            case "absent": return "absent";
            default:       return "absent";
        }
    }

    function depthLabel(depth) {
        switch (depth) {
            case "deep":   return "Deep";
            case "thin":   return "Thin";
            case "global": return "Global";
            case "absent": return "None";
            default:       return depth || "?";
        }
    }

    function render(host) {
        if (!host) return;
        host.textContent = "";
        const T = window.AESTokens || {};
        const sp = T.sp || {};
        const color = T.color || {};

        const wrap = el("div", "padding:" + (sp[5] || "24px"));

        const heading = el("div", [
            "margin-bottom:" + (sp[3] || "12px")
        ].join(";"));
        const h = el("h2", [
            "margin:0 0 " + (sp[1] || "4px") + " 0",
            "font-family:" + (T.font && T.font.display || "sans-serif"),
            "font-size:" + (T.fs && T.fs.h3 || "18px"),
            "font-weight:" + (T.fw && T.fw.display || "800"),
            "letter-spacing:" + (T.track && T.track.caps || "0.08em"),
            "text-transform:uppercase",
            "color:" + (color.oxide || "#2B2520")
        ].join(";"), "Site-skin coverage");
        const sub = el("p", [
            "margin:0",
            "font-family:" + (T.font && T.font.display || "sans-serif"),
            "font-size:" + (T.fs && T.fs.body || "12px"),
            "color:" + (color.oxide2 || "#4A413B"),
            "line-height:" + (T.lh && T.lh.body || "1.4")
        ].join(";"),
            "Each AirlineSim page family is classified by site-skin/bootstrap.js " +
            "and styled by a matching css/skin/skin-*.css file. Deep coverage " +
            "matches skin-info.css depth (header rhythm, tabular numerals, " +
            "density-aware spacing). Thin = skeletal. Global = inherits skin-global.css " +
            "only (no page-specific polish). None = no skin treatment.");
        heading.append(h, sub);
        wrap.appendChild(heading);

        const coverage = window.AESSkinCoverage;
        if (!coverage) {
            wrap.appendChild(el("p",
                "color:" + (color.crimson || "#8B2727"),
                "AESSkinCoverage not available — module not loaded yet."));
            host.appendChild(wrap);
            return;
        }

        const rows = coverage.report();
        const table = document.createElement("table");
        table.style.cssText = [
            "width:100%",
            "border-collapse:collapse",
            "font-family:" + (T.font && T.font.display || "sans-serif"),
            "font-size:" + (T.fs && T.fs.small || "11px")
        ].join(";");

        const thead = document.createElement("thead");
        const trh = document.createElement("tr");
        const headers = ["Page family", "Sample path", "CSS file", "Lines", "Depth", "Classified by"];
        for (const h of headers) {
            const th = document.createElement("th");
            th.textContent = h;
            th.style.cssText = [
                "text-align:left",
                "padding:" + (sp[2] || "8px") + " " + (sp[3] || "12px"),
                "border-bottom:2px solid " + (color.oxide || "#2B2520"),
                "background:" + (color.bone2 || "#ECE7DC"),
                "text-transform:uppercase",
                "letter-spacing:" + (T.track && T.track.caps || "0.08em"),
                "font-weight:" + (T.fw && T.fw.display || "800"),
                "font-size:" + (T.fs && T.fs.micro || "10px"),
                "color:" + (color.oxide || "#2B2520")
            ].join(";");
            trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const row of rows) {
            const tr = document.createElement("tr");
            const isCurrent = row.isCurrentPage;
            tr.style.cssText = [
                "background:" + (isCurrent ? (color.rustSoft || "rgba(184,71,42,0.12)") : "transparent"),
                "border-bottom:1px solid " + (color.paperRule || "#C9C0B0")
            ].join(";");

            const cells = [
                {text: row.pageKind + (isCurrent ? "  ← current" : ""), mono: true},
                {text: row.sample, mono: true},
                {text: row.skinFile, mono: true},
                {text: String(row.skinLines || 0), mono: true, align: "right"},
                {pill: row.depth},
                {text: row.classifiedBy, mono: true}
            ];
            for (const c of cells) {
                const td = document.createElement("td");
                td.style.cssText = [
                    "padding:" + (sp[2] || "8px") + " " + (sp[3] || "12px"),
                    "vertical-align:middle",
                    "color:" + (color.oxide || "#2B2520"),
                    "text-align:" + (c.align || "left"),
                    c.mono ? "font-family:" + (T.font && T.font.mono || "monospace") : ""
                ].filter(Boolean).join(";");
                if (c.pill) {
                    if (window.AESFreshnessPill && typeof window.AESFreshnessPill.mount === "function") {
                        window.AESFreshnessPill.mount(td, {
                            depthBand: depthBandToken(c.pill),
                            label: depthLabel(c.pill),
                            dense: true
                        });
                    } else {
                        td.textContent = depthLabel(c.pill);
                    }
                } else {
                    td.textContent = c.text;
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        wrap.appendChild(table);

        const footer = el("p", [
            "margin-top:" + (sp[4] || "16px"),
            "font-family:" + (T.font && T.font.mono || "monospace"),
            "font-size:" + (T.fs && T.fs.micro || "10px"),
            "color:" + (color.slate || "#7A6F66")
        ].join(";"),
            "Diagnostic only — read-only. Append to css/skin/skin-*.css to extend " +
            "coverage; new page-kind classifiers go in modules/site-skin/bootstrap.js " +
            "pageKindFromPath().");
        wrap.appendChild(footer);

        host.appendChild(wrap);
    }

    function teardown() { /* no listeners to release */ }

    window.AesUnifiedSettingsTabs.coverage = {render, teardown};
})();
