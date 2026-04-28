"use strict";

/**
 * Studio §06 — Motion.
 *
 * Two controls:
 *   1. Enable / disable transitions globally — overrides --aes-tr-* to
 *      `0s` when off so any cssText concatenated with these tokens
 *      becomes instant.
 *   2. Speed multiplier 0.5×–2× — scales the default 80ms / 140ms
 *      durations proportionally.
 *
 * Honours `prefers-reduced-motion: reduce` automatically — when the
 * user's OS asks for reduced motion, the transitions are forced to
 * 0s regardless of user setting (with a clear UI hint).
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioMotionSection) return;

    const TR_BASE = {
        "--aes-tr-fast":   80,    // ms
        "--aes-tr-medium": 140
    };

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const slider = window.AESStudioSlider;
        const store = window.AESCustomizationStore;
        if (!slider || !store) return;

        const reduced = systemPrefersReducedMotion();

        // OS hint
        if (reduced) {
            const hint = document.createElement("div");
            hint.style.cssText = [
                "padding:" + T.sp[3],
                "background:" + T.color.amberSoft,
                "border-left:" + T.geom.bw3 + " solid " + T.color.amber,
                "color:" + T.color.oxide,
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.small,
                "margin-bottom:" + T.sp[4]
            ].join(";");
            hint.textContent = "OS reports prefers-reduced-motion — AES will use instant transitions regardless of the controls below.";
            host.appendChild(hint);
        }

        // Enable/disable toggle
        host.appendChild(toggleCard(T, store));

        // Speed slider
        const speedHead = sectionHead(T, "SPEED", "Multiplier applied to all transition durations");
        host.appendChild(speedHead);
        const cur = readMultiplier();
        host.appendChild(slider.render({
            label: "Speed",
            value: cur,
            min: 0.25, max: 4, step: 0.25,
            unit: "×",
            precision: 2,
            onChange: function (n) { applySpeed(n); },
            onCommit: function (n) { applySpeed(n); }
        }));

        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset motion to defaults";
        reset.style.cssText = [
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
            "margin-top:" + T.sp[4]
        ].join(";");
        reset.addEventListener("click", function (e) {
            e.preventDefault();
            store.setOverridesBatch({
                "--aes-tr-fast": null,
                "--aes-tr-medium": null
            });
        });
        host.appendChild(reset);
    }

    function toggleCard(T, store) {
        const card = document.createElement("div");
        card.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "padding:" + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "margin-bottom:" + T.sp[5]
        ].join(";");
        const left = document.createElement("div");
        const t = document.createElement("div");
        t.textContent = "TRANSITIONS";
        t.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";");
        const sub = document.createElement("div");
        sub.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.small + ";color:" + T.color.slate + ";margin-top:2px";
        const ovr = store.globalOverrides();
        const isOff = (ovr["--aes-tr-fast"] === "0s") && (ovr["--aes-tr-medium"] === "0s");
        sub.textContent = isOff ? "OFF — all animations instant" : "ON — durations apply per token";
        left.append(t, sub);
        card.appendChild(left);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = isOff ? "Enable" : "Disable";
        btn.style.cssText = [
            "padding:" + T.sp[2] + " " + T.sp[4],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + (isOff ? T.color.bone : T.color.oxide),
            "color:" + (isOff ? T.color.oxide : T.color.bone),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:700",
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            if (isOff) {
                store.patch({ scopes: { global: {
                    "--aes-tr-fast": null,
                    "--aes-tr-medium": null
                } } });
            } else {
                store.setOverridesBatch({
                    "--aes-tr-fast": "0s",
                    "--aes-tr-medium": "0s"
                });
            }
        });
        card.appendChild(btn);
        return card;
    }

    function readMultiplier() {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue("--aes-tr-fast").trim();
            const m = /^([\d.]+)\s*ms/.exec(v);
            if (m) {
                const ms = parseFloat(m[1]);
                if (isFinite(ms) && ms > 0) {
                    const ratio = ms / TR_BASE["--aes-tr-fast"];
                    return Math.max(0.25, Math.min(4, ratio));
                }
            }
        } catch (_) {}
        return 1.0;
    }

    function applySpeed(mult) {
        const store = window.AESCustomizationStore;
        if (!store) return;
        const tokens = {};
        for (const tok of Object.keys(TR_BASE)) {
            const ms = TR_BASE[tok] * mult;
            tokens[tok] = ms.toFixed(0) + "ms linear";
        }
        store.setOverridesBatch(tokens);
    }

    function systemPrefersReducedMotion() {
        try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
        catch (_) { return false; }
    }

    function sectionHead(T, title, sub) {
        const h = document.createElement("div");
        h.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-bottom:" + T.sp[3];
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
        h.append(t, s);
        return h;
    }

    window.AESStudioMotionSection = { render };
})();
