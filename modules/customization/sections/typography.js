"use strict";

/**
 * Studio §03 — Typography.
 *
 * Font family selectors (display + mono), proportional font-size scale
 * slider, letter-spacing and line-height nudges.
 *
 * Font scale: a multiplier 0.8…1.4 that uniformly scales every
 * --aes-fs-* token. Implemented by writing each token as
 * `calc(<base>px * <mult>)` so future scale changes recompute live.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioTypographySection) return;

    const FONT_PRESETS = {
        display: [
            { id: "inter-tight",    label: "Inter Tight",
              value: "'Inter Tight', 'Helvetica Now Display', 'Helvetica Neue', system-ui, sans-serif" },
            { id: "ibm-plex-sans",  label: "IBM Plex Sans",
              value: "'IBM Plex Sans', system-ui, sans-serif" },
            { id: "system-ui",      label: "System UI",
              value: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
            { id: "georgia",        label: "Georgia (serif)",
              value: "Georgia, 'Times New Roman', serif" },
            { id: "monospace",      label: "Monospace (terminal)",
              value: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace" }
        ],
        mono: [
            { id: "jetbrains-mono", label: "JetBrains Mono",
              value: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace" },
            { id: "ibm-plex-mono",  label: "IBM Plex Mono",
              value: "'IBM Plex Mono', ui-monospace, monospace" },
            { id: "sf-mono",        label: "SF Mono / Menlo",
              value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }
        ]
    };

    /* Base px of each font-size token — used by the proportional scale
       slider. Same as defaults in design-tokens.css. */
    const FS_BASE = {
        "--aes-fs-micro":   10,
        "--aes-fs-small":   11,
        "--aes-fs-body":    12,
        "--aes-fs-lead":    14,
        "--aes-fs-h3":      18,
        "--aes-fs-h2":      24,
        "--aes-fs-h1":      36,
        "--aes-fs-display": 56
    };

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const slider = window.AESStudioSlider;
        const store = window.AESCustomizationStore;
        if (!store || !slider) return;

        host.appendChild(fontPicker(T, store, "display", "--aes-font-display", "Display family"));
        host.appendChild(fontPicker(T, store, "mono", "--aes-font-mono", "Monospace family"));

        host.appendChild(divider(T));

        // Scale multiplier
        const scaleHead = sectionHead(T, "SIZE SCALE", "Multiplier applied to all font-size tokens (default 1.00)");
        host.appendChild(scaleHead);
        const currentScale = readScaleMultiplier();
        const scaleSlider = slider.render({
            label: "Multiplier",
            value: currentScale,
            min: 0.8, max: 1.4, step: 0.05,
            unit: "×",
            precision: 2,
            onChange: function (n) { applyScale(n); },
            onCommit: function (n) { applyScale(n); }
        });
        host.appendChild(scaleSlider);

        host.appendChild(divider(T));

        // Letter spacing
        const trackHead = sectionHead(T, "TRACKING", "Letter spacing for caps / mono");
        host.appendChild(trackHead);
        host.appendChild(emSlider(T, slider, "Caps tracking", "--aes-tracking-caps", 0.08));
        host.appendChild(emSlider(T, slider, "Mono tracking", "--aes-tracking-mono", 0.02));

        host.appendChild(divider(T));

        // Line height
        const lhHead = sectionHead(T, "LEADING", "Line height for tight / body");
        host.appendChild(lhHead);
        host.appendChild(unitlessSlider(T, slider, "Tight", "--aes-lh-tight", 1.15));
        host.appendChild(unitlessSlider(T, slider, "Body",  "--aes-lh-body",  1.4));
    }

    function fontPicker(T, store, kind, cssVar, label) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[1] + ";margin-bottom:" + T.sp[3];
        const lbl = document.createElement("div");
        lbl.textContent = label.toUpperCase();
        lbl.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:" + T.fw.bold,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";");
        wrap.appendChild(lbl);

        const chips = document.createElement("div");
        chips.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[1];
        const overrides = store.globalOverrides();
        const current = overrides[cssVar] || readVar(cssVar);
        for (const preset of FONT_PRESETS[kind]) {
            const active = current && current.indexOf(preset.value.split(",")[0].replace(/^['"]|['"]$/g, "")) === 0;
            const c = chip(T, preset.label, function () {
                store.setGlobalOverride(cssVar, preset.value);
            }, active);
            // preview the typeface in its own font-family
            c.style.fontFamily = preset.value;
            chips.appendChild(c);
        }
        wrap.appendChild(chips);

        // Custom value input
        const customRow = document.createElement("div");
        customRow.style.cssText = "display:flex;gap:" + T.sp[2] + ";margin-top:" + T.sp[1];
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "custom font-family stack";
        input.value = current || "";
        input.style.cssText = [
            "flex:1 1 auto",
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small
        ].join(";");
        const apply = chip(T, "Apply", function () {
            const v = input.value.trim();
            if (v) store.setGlobalOverride(cssVar, v);
        });
        const reset = chip(T, "Reset", function () {
            store.setGlobalOverride(cssVar, null);
            input.value = "";
        });
        customRow.append(input, apply, reset);
        wrap.appendChild(customRow);

        return wrap;
    }

    function readScaleMultiplier() {
        // Detect existing scale by reading --aes-fs-body and dividing.
        try {
            const body = getComputedStyle(document.documentElement).getPropertyValue("--aes-fs-body").trim();
            const px = parseFloat(body);
            if (isFinite(px) && px > 0) return Math.max(0.8, Math.min(1.4, px / FS_BASE["--aes-fs-body"]));
        } catch (_) {}
        return 1.0;
    }

    function applyScale(mult) {
        const store = window.AESCustomizationStore;
        if (!store) return;
        const tokens = {};
        for (const tok of Object.keys(FS_BASE)) {
            tokens[tok] = (FS_BASE[tok] * mult).toFixed(1) + "px";
        }
        store.setOverridesBatch(tokens);
    }

    function emSlider(T, slider, label, cssVar, baseEm) {
        const initial = parseEm(readVar(cssVar)) || baseEm;
        return slider.render({
            label: label,
            value: initial,
            min: 0, max: 0.3, step: 0.005,
            unit: "em",
            precision: 3,
            onChange: function (n) {
                window.AESCustomizationStore.setGlobalOverride(cssVar, n.toFixed(3) + "em");
            }
        });
    }

    function unitlessSlider(T, slider, label, cssVar, base) {
        const initial = parseFloat(readVar(cssVar)) || base;
        return slider.render({
            label: label,
            value: initial,
            min: 1.0, max: 2.0, step: 0.05,
            precision: 2,
            onChange: function (n) {
                window.AESCustomizationStore.setGlobalOverride(cssVar, n.toFixed(2));
            }
        });
    }

    function parseEm(s) {
        if (!s) return null;
        const m = /^([\d.]+)\s*em$/.exec(s.trim());
        return m ? parseFloat(m[1]) : null;
    }

    function readVar(cssVar) {
        try { return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim(); }
        catch (_) { return ""; }
    }

    function chip(T, label, onClick, active) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[3],
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + (active ? T.color.oxide : T.color.bone),
            "color:" + (active ? T.color.bone : T.color.oxide),
            "font-size:" + T.fs.small,
            "font-weight:" + (active ? T.fw.bold : T.fw.medium),
            "cursor:pointer"
        ].join(";");
        b.addEventListener("click", function (e) { e.preventDefault(); onClick(); });
        return b;
    }

    function divider(T) {
        const d = document.createElement("hr");
        d.style.cssText = [
            "border:none",
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "margin:" + T.sp[4] + " 0"
        ].join(";");
        return d;
    }

    function sectionHead(T, title, sub) {
        const head = document.createElement("div");
        head.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-bottom:" + T.sp[2];
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
        s.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.small + ";color:" + T.color.slate;
        head.append(t, s);
        return head;
    }

    window.AESStudioTypographySection = { render };
})();
