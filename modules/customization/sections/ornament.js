"use strict";

/**
 * Studio §06b — Ornament intensity.
 *
 * 4-stop selector (None / Subtle / Moderate / Full) writing
 * customization.ornament.intensity. The applier in modules/customization
 * /applier.js mirrors the value to body[data-aes-ornament] and
 * :root{--aes-ornament-intensity} so skin CSS (css/skin/skin-art-deco.css)
 * gates effects accordingly.
 *
 * Inert outside the deco skin — the skin CSS only applies under
 * body[data-aes-skin="art-deco"], which is set by deco-ivory / deco-noir
 * presets. Choosing a different preset leaves intensity stored but
 * unused.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioOrnamentSection) return;

    const STOPS = [
        { id: "none",     label: "None",     hint: "Palette only — ornament suppressed." },
        { id: "subtle",   label: "Subtle",   hint: "Tabular numerics, hairline rules, light fluting." },
        { id: "moderate", label: "Moderate", hint: "Stepped frames, drop-caps, sunburst behind KPIs." },
        { id: "full",     label: "Full",     hint: "Everything: heavy fluting, double-rule modal frames." }
    ];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const store = window.AESCustomizationStore;
        if (!T || !store) return;

        host.appendChild(introCard(T));
        host.appendChild(stopsRow(T, store));
        host.appendChild(activePreviewCard(T, store));

        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset to default (moderate)";
        reset.style.cssText = btnStyle(T);
        reset.addEventListener("click", function (e) {
            e.preventDefault();
            store.setOrnamentIntensity("moderate");
        });
        host.appendChild(reset);
    }

    function introCard(T) {
        const card = document.createElement("div");
        card.style.cssText = [
            "padding:" + T.sp[3],
            "background:" + T.color.bone2,
            "border-left:" + T.geom.bw3 + " solid " + T.color.rust,
            "color:" + T.color.oxide,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "margin-bottom:" + T.sp[4]
        ].join(";");
        card.textContent = "Ornament effects only render under the Art Deco skin. Pick a Deco preset on §01 Theme to see them.";
        return card;
    }

    function stopsRow(T, store) {
        const wrap = document.createElement("div");
        wrap.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(4, minmax(0, 1fr))",
            "gap:0",
            "margin-bottom:" + T.sp[5]
        ].join(";");

        function paint() {
            const cur = store.ornamentIntensity();
            Array.from(wrap.children).forEach(function (cell) {
                const active = cell.dataset.stopId === cur;
                cell.style.cssText = stopStyle(T, active);
            });
        }

        for (const stop of STOPS) {
            const cell = document.createElement("button");
            cell.type = "button";
            cell.dataset.stopId = stop.id;
            cell.style.cssText = stopStyle(T, false);
            const lbl = document.createElement("div");
            lbl.textContent = stop.label;
            lbl.style.cssText = [
                "font-family:" + T.font.display,
                "font-weight:" + T.fw.display,
                "font-size:" + T.fs.lead,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase"
            ].join(";");
            const hint = document.createElement("div");
            hint.textContent = stop.hint;
            hint.style.cssText = [
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.micro,
                "margin-top:" + T.sp[1],
                "opacity:0.78"
            ].join(";");
            cell.append(lbl, hint);
            cell.addEventListener("click", function (e) {
                e.preventDefault();
                store.setOrnamentIntensity(stop.id).then(paint);
            });
            wrap.appendChild(cell);
        }

        store.subscribe(paint);
        paint();
        return wrap;
    }

    function activePreviewCard(T, store) {
        const card = document.createElement("div");
        card.style.cssText = [
            "padding:" + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "margin-bottom:" + T.sp[4]
        ].join(";");
        const head = document.createElement("div");
        head.textContent = "ACTIVE INTENSITY";
        head.style.cssText = [
            "font-family:" + T.font.display,
            "font-weight:" + T.fw.display,
            "font-size:" + T.fs.small,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate,
            "margin-bottom:" + T.sp[2]
        ].join(";");
        const value = document.createElement("div");
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "color:" + T.color.oxide
        ].join(";");
        function paint() {
            value.textContent = store.ornamentIntensity().toUpperCase();
        }
        store.subscribe(paint);
        paint();
        card.append(head, value);
        return card;
    }

    function stopStyle(T, active) {
        return [
            "padding:" + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + (active ? T.color.rust : T.color.bone),
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

    window.AESStudioOrnamentSection = { render };
})();
