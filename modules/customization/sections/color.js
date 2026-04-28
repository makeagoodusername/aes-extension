"use strict";

/**
 * Studio §02 — Colour.
 *
 * 14-token swatch grid + popover editor. The grid is rendered by the
 * shared widget (modules/customization/widgets/swatch-grid.js); this
 * file is the section wrapper that handles the section header, the
 * group filter (Primary / Cubist / Dark), and the bulk reset.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioColorSection) return;

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const widget = window.AESStudioSwatchGrid;
        const store = window.AESCustomizationStore;

        const groupBar = document.createElement("div");
        groupBar.style.cssText = [
            "display:flex",
            "gap:" + T.sp[1],
            "margin-bottom:" + T.sp[2]
        ].join(";");

        const groups = [
            { id: "color",        label: "Primary palette" },
            { id: "color-cubist", label: "Cubist accents" },
            { id: "color-dark",   label: "Dark surfaces" }
        ];
        let currentGroup = "color";
        const gridSlot = document.createElement("div");
        function paintGrid() {
            gridSlot.textContent = "";
            gridSlot.appendChild(widget.render({ group: currentGroup }));
        }
        for (const g of groups) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = g.label;
            btn.dataset.groupId = g.id;
            btn.style.cssText = tabStyle(T, g.id === currentGroup);
            btn.addEventListener("click", function () {
                currentGroup = g.id;
                Array.from(groupBar.children).forEach(function (el) {
                    el.style.cssText = tabStyle(T, el.dataset.groupId === currentGroup);
                });
                paintGrid();
            });
            groupBar.appendChild(btn);
        }
        host.appendChild(groupBar);
        host.appendChild(gridSlot);
        paintGrid();

        // Contrast pairing matrix
        const matrixHead = sectionHead(T, "CONTRAST PAIRINGS", "WCAG 2.1 ratio · click cell to focus the foreground token");
        host.appendChild(matrixHead);
        const matrixHost = document.createElement("div");
        matrixHost.style.cssText = "margin-bottom:" + T.sp[5] + ";overflow-x:auto";
        host.appendChild(matrixHost);
        if (window.AESStudioContrastMatrix) {
            window.AESStudioContrastMatrix.render(matrixHost);
        }

        // Bulk shift sliders
        const shiftHead = sectionHead(T, "BULK SHIFT", "Nudge hue / saturation / lightness across bone, oxide, and rust families");
        host.appendChild(shiftHead);
        const shiftHost = document.createElement("div");
        shiftHost.style.cssText = "margin-bottom:" + T.sp[5];
        host.appendChild(shiftHost);
        if (window.AESStudioBulkShift) {
            window.AESStudioBulkShift.render(shiftHost);
        }
    }

    function sectionHead(T, title, sub) {
        const head = document.createElement("div");
        head.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:2px",
            "margin-top:" + T.sp[5],
            "padding-bottom:" + T.sp[2],
            "margin-bottom:" + T.sp[3],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.oxide
        ].join(";");
        const t = document.createElement("div");
        t.textContent = title;
        t.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";");
        const s = document.createElement("div");
        s.textContent = sub;
        s.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.slate
        ].join(";");
        head.append(t, s);
        return head;
    }

    function tabStyle(T, active) {
        return [
            "padding:" + T.sp[1] + " " + T.sp[3],
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + (active ? T.color.oxide : T.color.bone),
            "color:" + (active ? T.color.bone : T.color.oxide),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:700",
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
    }

    window.AESStudioColorSection = { render };
})();
