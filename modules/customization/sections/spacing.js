"use strict";

/**
 * Studio §04 — Spacing & Geometry.
 *
 * Phase 1 shipped only the density toggle. Phase 2 adds:
 *   - Per-step sliders for sp-1..sp-7 (4-step grid)
 *   - Border widths bw-1, bw-2, bw-3
 *   - Border radius (brutalism wants 0; users may want some)
 *
 * Each slider writes its --aes-* token directly into scope:global.
 * Density toggle remains at the top — it's a higher-level mode that
 * skin CSS keys off (data-aes-density attr).
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioSpacingSection) return;

    /* Default (px) values — used to seed sliders before any override. */
    const SP = [
        { v: "--aes-sp-1", base: 4,  min: 0,  max: 12, label: "sp-1" },
        { v: "--aes-sp-2", base: 8,  min: 2,  max: 20, label: "sp-2" },
        { v: "--aes-sp-3", base: 12, min: 4,  max: 28, label: "sp-3" },
        { v: "--aes-sp-4", base: 16, min: 6,  max: 36, label: "sp-4" },
        { v: "--aes-sp-5", base: 24, min: 10, max: 56, label: "sp-5" },
        { v: "--aes-sp-6", base: 32, min: 14, max: 80, label: "sp-6" },
        { v: "--aes-sp-7", base: 48, min: 20, max: 120, label: "sp-7" }
    ];
    const GEOM = [
        { v: "--aes-bw-1",   base: 1, min: 0, max: 4, label: "Border 1" },
        { v: "--aes-bw-2",   base: 2, min: 0, max: 6, label: "Border 2" },
        { v: "--aes-bw-3",   base: 3, min: 0, max: 8, label: "Border 3" },
        { v: "--aes-radius", base: 0, min: 0, max: 24, label: "Radius" }
    ];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const slider = window.AESStudioSlider;
        const skin = window.AESSiteSkin;
        const store = window.AESCustomizationStore;
        if (!slider || !store) return;

        // Global density (Phase 1, legacy — covers unstamped markup) ───
        const card = document.createElement("div");
        card.style.cssText = [
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "padding:" + T.sp[3],
            "margin-bottom:" + T.sp[3]
        ].join(";");
        const dHead = document.createElement("div");
        dHead.textContent = "GLOBAL DENSITY";
        dHead.style.cssText = headStyle(T);
        card.appendChild(dHead);
        const dSub = document.createElement("div");
        dSub.textContent = "Applies to legacy markup that has not opted into per-surface stamps.";
        dSub.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + T.color.slate + ";margin-bottom:" + T.sp[2];
        card.appendChild(dSub);
        const seg = document.createElement("div");
        seg.style.cssText = "display:flex;gap:0";
        const opts = [
            { id: "comfortable", label: "Comfortable" },
            { id: "compact",     label: "Compact" }
        ];
        function paintSeg() {
            const cur = skin && skin.getDensity ? skin.getDensity() : "comfortable";
            Array.from(seg.children).forEach(function (b) {
                const active = b.dataset.optId === cur;
                b.style.cssText = segStyle(T, active);
            });
        }
        for (const opt of opts) {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.optId = opt.id;
            b.textContent = opt.label;
            b.addEventListener("click", function (e) {
                e.preventDefault();
                if (skin && skin.setDensity) skin.setDensity(opt.id);
                paintSeg();
            });
            seg.appendChild(b);
        }
        paintSeg();
        card.appendChild(seg);
        host.appendChild(card);

        // B-2 — per-surface density matrix (Phase 2, granular) ─────────
        host.appendChild(perSurfaceMatrix(T, store));

        // Spacing scale
        host.appendChild(sectionHead(T, "SPACING SCALE", "Per-step sliders. The 4px grid is a guideline, not a constraint."));
        for (const s of SP) {
            host.appendChild(pxSlider(T, slider, store, s));
        }

        host.appendChild(divider(T));

        // Geometry
        host.appendChild(sectionHead(T, "GEOMETRY", "Border widths and corner radius. Brutalism = 0 radius; nudge if you must."));
        for (const g of GEOM) {
            host.appendChild(pxSlider(T, slider, store, g));
        }

        host.appendChild(divider(T));
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset spacing & geometry to defaults";
        reset.style.cssText = btnStyle(T);
        reset.addEventListener("click", function (e) {
            e.preventDefault();
            const tokens = {};
            for (const s of SP) tokens[s.v] = null;
            for (const g of GEOM) tokens[g.v] = null;
            store.setOverridesBatch(tokens);
        });
        host.appendChild(reset);
    }

    /* B-2 — per-surface density matrix.
       Surfaces stamp data-aes-surface (see modules/_shared/surface-stamp.js
       and central-hub/{tile,shell}.js). The applier emits scoped density
       overrides keyed off this attribute. "Comfortable" stores user intent
       but emits no rule (inherits global). */
    const SURFACES = [
        { id: "panel",  label: "Panel",  hint: "Section containers" },
        { id: "tile",   label: "Tile",   hint: "Hub tiles" },
        { id: "modal",  label: "Modal",  hint: "Dialogs / overlays" },
        { id: "table",  label: "Table",  hint: "Data tables" },
        { id: "card",   label: "Card",   hint: "Inline cards" }
    ];
    const SURFACE_DENSITIES = ["compact", "comfortable", "spacious"];

    function perSurfaceMatrix(T, store) {
        const wrap = document.createElement("div");
        wrap.style.cssText = [
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "padding:" + T.sp[3],
            "margin-bottom:" + T.sp[5]
        ].join(";");

        const head = document.createElement("div");
        head.textContent = "PER-SURFACE DENSITY";
        head.style.cssText = headStyle(T);
        wrap.appendChild(head);

        const sub = document.createElement("div");
        sub.textContent = "Override spacing per surface kind. Only stamped surfaces apply (panel & tile today; modals/tables opt in via AesSurface.stamp).";
        sub.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + T.color.slate + ";margin-bottom:" + T.sp[3];
        wrap.appendChild(sub);

        const grid = document.createElement("div");
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:120px repeat(3, minmax(0, 1fr))",
            "gap:0"
        ].join(";");

        // Header row
        const colHeads = ["", "Compact", "Comfortable", "Spacious"];
        for (const ch of colHeads) {
            const cell = document.createElement("div");
            cell.textContent = ch.toUpperCase();
            cell.style.cssText = [
                "padding:" + T.sp[2],
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "font-weight:" + T.fw.display,
                "letter-spacing:" + T.track.caps,
                "color:" + T.color.slate,
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
            ].join(";");
            grid.appendChild(cell);
        }

        // One row per surface
        for (const s of SURFACES) {
            const lbl = document.createElement("div");
            const lblTitle = document.createElement("div");
            lblTitle.textContent = s.label;
            lblTitle.style.cssText = [
                "font-family:" + T.font.display,
                "font-weight:" + T.fw.display,
                "font-size:" + T.fs.small,
                "letter-spacing:" + T.track.caps,
                "color:" + T.color.oxide,
                "text-transform:uppercase"
            ].join(";");
            const lblHint = document.createElement("div");
            lblHint.textContent = s.hint;
            lblHint.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + T.color.slate + ";margin-top:2px";
            lbl.append(lblTitle, lblHint);
            lbl.style.cssText = "padding:" + T.sp[2] + ";display:flex;flex-direction:column;justify-content:center";
            grid.appendChild(lbl);

            for (const d of SURFACE_DENSITIES) {
                const cell = document.createElement("button");
                cell.type = "button";
                cell.dataset.surface = s.id;
                cell.dataset.density = d;
                cell.style.cssText = matrixCellStyle(T, false);
                const dot = document.createElement("span");
                dot.textContent = "●";
                dot.style.cssText = "font-size:" + T.fs.body + ";";
                cell.appendChild(dot);
                cell.addEventListener("click", function (e) {
                    e.preventDefault();
                    store.setDensityFor(s.id, d).then(paintGrid);
                });
                grid.appendChild(cell);
            }
        }

        function paintGrid() {
            const cur = store.densityFor(null) || {};
            Array.from(grid.querySelectorAll("button[data-surface]")).forEach(function (b) {
                const surfaceVal = cur[b.dataset.surface] || "comfortable";
                const active = surfaceVal === b.dataset.density;
                b.style.cssText = matrixCellStyle(T, active);
            });
        }

        store.subscribe(paintGrid);
        paintGrid();
        wrap.appendChild(grid);

        // Reset button
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset all surfaces to comfortable";
        reset.style.cssText = btnStyle(T);
        reset.style.marginTop = T.sp[3];
        reset.addEventListener("click", function (e) {
            e.preventDefault();
            store.patch({ density: { bySurface: "__CLEAR__" } });
        });
        wrap.appendChild(reset);

        return wrap;
    }

    function matrixCellStyle(T, active) {
        return [
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + (active ? T.color.rust : T.color.bone),
            "color:" + (active ? T.color.bone : T.color.slate),
            "cursor:pointer",
            "text-align:center",
            "transition:background " + T.tr.fast
        ].join(";");
    }

    function pxSlider(T, slider, store, spec) {
        const cur = readPx(spec.v, spec.base);
        return slider.render({
            label: spec.label,
            value: cur,
            min: spec.min, max: spec.max, step: 1,
            unit: "px",
            precision: 0,
            onChange: function (n) {
                store.setGlobalOverride(spec.v, n + "px");
            }
        });
    }

    function readPx(cssVar, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
            const n = parseFloat(v);
            if (isFinite(n)) return n;
        } catch (_) {}
        return fallback;
    }

    function headStyle(T) {
        return [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "margin-bottom:" + T.sp[2]
        ].join(";");
    }

    function segStyle(T, active) {
        return [
            "flex:1 1 auto",
            "padding:" + T.sp[2] + " " + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + (active ? T.color.oxide : T.color.bone),
            "color:" + (active ? T.color.bone : T.color.oxide),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
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
            "cursor:pointer",
            "margin-top:" + T.sp[3]
        ].join(";");
    }

    function divider(T) {
        const d = document.createElement("hr");
        d.style.cssText = [
            "border:none",
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "margin:" + T.sp[5] + " 0"
        ].join(";");
        return d;
    }

    function sectionHead(T, title, sub) {
        const h = document.createElement("div");
        h.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-bottom:" + T.sp[3];
        const t = document.createElement("div");
        t.textContent = title;
        t.style.cssText = headStyle(T);
        const s = document.createElement("div");
        s.textContent = sub;
        s.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.small + ";color:" + T.color.slate;
        h.append(t, s);
        return h;
    }

    window.AESStudioSpacingSection = { render };
})();
