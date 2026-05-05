"use strict";

/**
 * Studio §11 — Numerals.
 *
 * Four controls writing customization.numerals via single batched patch:
 *   - Style: tabular-nums vs proportional-nums (font-variant-numeric)
 *   - Currency: symbol / code / none
 *   - Time format: 24h / 12h
 *   - Thousands separator: , / . / space / none
 *
 * Style is applied immediately by the customization applier via a global
 * [data-aes-numeric] rule. Currency / time / separator are stored for
 * downstream consumers (formatters in modules read them); applier does
 * not transform these — modules opt in by reading store.numerals().
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioNumeralsSection) return;

    const STYLE_OPTS = [
        { id: "tabular",      label: "Tabular",      hint: "Equal-width digits — column-aligns numbers." },
        { id: "proportional", label: "Proportional", hint: "Variable-width digits — matches body text." }
    ];
    const CURRENCY_OPTS = [
        { id: "symbol", label: "Symbol",  hint: "$, €, £" },
        { id: "code",   label: "Code",    hint: "USD, EUR, GBP" },
        { id: "none",   label: "None",    hint: "No prefix/suffix." }
    ];
    const TIME_OPTS = [
        { id: "24h", label: "24-hour", hint: "13:45" },
        { id: "12h", label: "12-hour", hint: "1:45 PM" }
    ];
    const SEP_OPTS = [
        { id: ",",     label: "Comma",    hint: "1,234,567" },
        { id: ".",     label: "Period",   hint: "1.234.567" },
        { id: "space", label: "Space",    hint: "1 234 567" },
        { id: "none",  label: "None",     hint: "1234567" }
    ];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const store = window.AESCustomizationStore;
        if (!T || !store) return;

        host.appendChild(introCard(T));

        host.appendChild(group(T, store, "STYLE", "style", STYLE_OPTS, "tabular"));
        host.appendChild(group(T, store, "CURRENCY", "currency", CURRENCY_OPTS, "symbol"));
        host.appendChild(group(T, store, "TIME FORMAT", "time", TIME_OPTS, "24h"));
        host.appendChild(group(T, store, "THOUSANDS SEPARATOR", "separator", SEP_OPTS, ","));

        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset numerals to defaults";
        reset.style.cssText = btnStyle(T);
        reset.style.marginTop = T.sp[3];
        reset.addEventListener("click", function (e) {
            e.preventDefault();
            store.patch({ numerals: "__CLEAR__" });
        });
        host.appendChild(reset);
    }

    function introCard(T) {
        const card = document.createElement("div");
        card.style.cssText = [
            "padding:" + T.sp[3],
            "background:" + T.color.bone2,
            "border-left:" + T.geom.bw3 + " solid " + T.color.cobalt,
            "color:" + T.color.oxide,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "margin-bottom:" + T.sp[4]
        ].join(";");
        card.textContent = "Style applies globally to elements stamped data-aes-numeric. Currency / time / separator are stored for module formatters to read.";
        return card;
    }

    function group(T, store, title, key, opts, fallback) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom:" + T.sp[5];
        const head = document.createElement("div");
        head.textContent = title;
        head.style.cssText = [
            "font-family:" + T.font.display,
            "font-weight:" + T.fw.display,
            "font-size:" + T.fs.lead,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "margin-bottom:" + T.sp[2]
        ].join(";");
        wrap.appendChild(head);

        const row = document.createElement("div");
        row.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(" + opts.length + ", minmax(0, 1fr))",
            "gap:0"
        ].join(";");

        function paint() {
            const cur = (store.numerals() || {})[key] || fallback;
            Array.from(row.children).forEach(function (cell) {
                const active = cell.dataset.optId === cur;
                cell.style.cssText = optStyle(T, active);
            });
        }

        for (const opt of opts) {
            const cell = document.createElement("button");
            cell.type = "button";
            cell.dataset.optId = opt.id;
            cell.style.cssText = optStyle(T, false);
            const lbl = document.createElement("div");
            lbl.textContent = opt.label;
            lbl.style.cssText = [
                "font-family:" + T.font.display,
                "font-weight:" + T.fw.display,
                "font-size:" + T.fs.body,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase"
            ].join(";");
            const hint = document.createElement("div");
            hint.textContent = opt.hint;
            hint.style.cssText = [
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.micro,
                "margin-top:" + T.sp[1],
                "opacity:0.72"
            ].join(";");
            cell.append(lbl, hint);
            cell.addEventListener("click", function (e) {
                e.preventDefault();
                const node = {};
                node[key] = opt.id;
                store.setNumerals(node).then(paint);
            });
            row.appendChild(cell);
        }
        store.subscribe(paint);
        paint();
        wrap.appendChild(row);
        return wrap;
    }

    function optStyle(T, active) {
        return [
            "padding:" + T.sp[2] + " " + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + (active ? T.color.cobalt : T.color.bone),
            "color:" + (active ? T.color.bone : T.color.oxide),
            "cursor:pointer",
            "text-align:left",
            "transition:background " + T.tr.fast
        ].join(";");
    }

    function btnStyle(T) {
        return [
            "padding:" + T.sp[2] + " " + T.sp[3],
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
    }

    window.AESStudioNumeralsSection = { render };
})();
