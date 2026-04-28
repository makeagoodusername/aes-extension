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

        // Density at the top (preserved from Phase 1)
        const card = document.createElement("div");
        card.style.cssText = [
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "padding:" + T.sp[3],
            "margin-bottom:" + T.sp[5]
        ].join(";");
        const dHead = document.createElement("div");
        dHead.textContent = "DENSITY";
        dHead.style.cssText = headStyle(T);
        card.appendChild(dHead);
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
