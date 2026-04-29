"use strict";

/**
 * Studio §08 — Dashboard.
 *
 * Cascade-overhaul controls layered above the existing customization
 * tokens. These write to `centralHub:settings` (NOT the customization
 * store) because they affect the live dashboard layout, not the visual
 * cascade. Visual tokens (--aes-tile-bleed, chrome opacity, min-col)
 * are handled in the Spacing section like the rest of the design tokens.
 *
 * Controls:
 *   1. Layout mode — Classic | Cascade
 *   2. Salience weights — 6 sliders driving CentralHubSalience.salienceFor
 *   3. Reset salience weights to defaults
 *
 * Read-mostly: the cascade layout is driven by the same settings the
 * topbar selector edits. This section is the canonical place for users
 * who want to dial in the salience scorer without touching the topbar.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioDashboardSection) return;

    const LAYOUT_OPTS = [
        { id: "classic", label: "Classic", hint: "Section flow — tiles ordered by priority within fleet / routes / operations / finance / tools." },
        { id: "cascade", label: "Cascade", hint: "Salience-ranked masonry across topics. Higher signal density floats to the top." }
    ];

    const WEIGHT_KEYS = [
        { key: "priority", label: "Priority",       hint: "Base ordering from each tile's hand-tuned priority value (lower = louder)." },
        { key: "pin",      label: "Pin",            hint: "Bonus when a tile is in pinnedTiles[]. Defaults aggressive — pinned tiles dominate." },
        { key: "recent",   label: "Recents",        hint: "Decaying bonus from the recents ring (top 5 most-recently-opened tiles)." },
        { key: "hubFeed",  label: "Feed unread",    hint: "Log-compressed bonus from HubFeed slices keyed `hub:tile:<id>:unread`." },
        { key: "signal",   label: "Signal density", hint: "Conductor signals (last hour) matching a tile's salienceDomains[]. Log-compressed." },
        { key: "pulse",    label: "Pulse",          hint: "Reserved channel — tiles can emit a 0..1 pulse on the bus to bump their own salience." }
    ];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        if (!T) return;
        if (!window.CentralHubSettings) {
            host.textContent = "CentralHubSettings unavailable — load the central-hub bundle first.";
            return;
        }

        host.appendChild(introCard(T));
        host.appendChild(layoutModeBlock(T));
        host.appendChild(salienceBlock(T));
        host.appendChild(resetBlock(T));
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
        card.textContent = "Cascade flips the dashboard from a fixed section flow into a salience-ranked waterfall. The visual chrome (bleed strip, chrome opacity, min column width) lives in the Spacing section as design tokens.";
        return card;
    }

    function layoutModeBlock(T) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom:" + T.sp[5];
        wrap.appendChild(blockHeader(T, "LAYOUT"));

        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:" + T.sp[2] + ";";
        for (const opt of LAYOUT_OPTS) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.dataset.layout = opt.id;
            btn.textContent = opt.label.toUpperCase();
            btn.title = opt.hint;
            btn.style.cssText = optionBtnStyle(T, false);
            btn.addEventListener("click", async function () {
                const settings = await window.CentralHubSettings.load();
                if (settings.layoutMode === opt.id) return;
                settings.layoutMode = opt.id;
                await window.CentralHubSettings.save(settings);
                _paintLayoutButtons(wrap, T, opt.id);
            });
            row.appendChild(btn);
        }
        wrap.appendChild(row);

        // Initial paint — read settings async, paint when resolved.
        window.CentralHubSettings.load().then(function (s) {
            _paintLayoutButtons(wrap, T, s.layoutMode || "classic");
        });

        return wrap;
    }

    function _paintLayoutButtons(wrap, T, activeId) {
        const btns = wrap.querySelectorAll("button[data-layout]");
        for (const b of btns) {
            const isActive = b.dataset.layout === activeId;
            b.style.cssText = optionBtnStyle(T, isActive);
        }
    }

    function salienceBlock(T) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom:" + T.sp[5];
        wrap.appendChild(blockHeader(T, "SALIENCE WEIGHTS"));

        const note = document.createElement("div");
        note.style.cssText = [
            "color:" + T.color.slate,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "margin-bottom:" + T.sp[3],
            "line-height:1.4"
        ].join(";");
        note.textContent = "Each input contributes a normalized 0..1 value, multiplied by the weight. Salience is the sum. Set a weight to 0 to drop that input entirely.";
        wrap.appendChild(note);

        const defaults = (window.CentralHubSalience && window.CentralHubSalience.DEFAULT_WEIGHTS) || {};

        for (const w of WEIGHT_KEYS) {
            wrap.appendChild(slider(T, w.key, w.label, w.hint, defaults[w.key]));
        }
        return wrap;
    }

    function slider(T, key, label, hint, defaultVal) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:" + T.sp[3] + ";margin-bottom:" + T.sp[2];

        const lbl = document.createElement("span");
        lbl.textContent = label;
        lbl.title = hint;
        lbl.style.cssText = [
            "flex:0 0 140px",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.oxide,
            "cursor:help"
        ].join(";");

        const inp = document.createElement("input");
        inp.type = "range";
        inp.min = "0";
        inp.max = "10";
        inp.step = "0.1";
        inp.style.cssText = "flex:1 1 auto";

        const stamp = document.createElement("span");
        stamp.style.cssText = [
            "flex:0 0 48px",
            "text-align:right",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "color:" + T.color.slate
        ].join(";");

        // Initial value + display.
        window.CentralHubSettings.load().then(function (s) {
            const cur = (s.salienceWeights && typeof s.salienceWeights[key] === "number")
                ? s.salienceWeights[key] : defaultVal;
            inp.value = String(cur);
            stamp.textContent = Number(cur).toFixed(1);
        });

        let saveTimer = null;
        inp.addEventListener("input", function () {
            stamp.textContent = Number(inp.value).toFixed(1);
            clearTimeout(saveTimer);
            saveTimer = setTimeout(async function () {
                const s = await window.CentralHubSettings.load();
                const next = Object.assign({}, s.salienceWeights || {});
                next[key] = Number(inp.value);
                s.salienceWeights = next;
                await window.CentralHubSettings.save(s);
            }, 200);
        });

        row.append(lbl, inp, stamp);
        return row;
    }

    function resetBlock(T) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset salience weights to defaults";
        reset.style.cssText = btnStyle(T);
        reset.addEventListener("click", async function (e) {
            e.preventDefault();
            const s = await window.CentralHubSettings.load();
            s.salienceWeights = {};
            await window.CentralHubSettings.save(s);
            // Re-render the section so the sliders snap to defaults.
            const host = reset.parentElement;
            if (host && host.parentElement) render(host.parentElement);
        });
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-top:" + T.sp[3];
        wrap.appendChild(reset);
        return wrap;
    }

    function blockHeader(T, label) {
        const head = document.createElement("div");
        head.textContent = label;
        head.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "padding-bottom:" + T.sp[1],
            "margin-bottom:" + T.sp[3]
        ].join(";");
        return head;
    }

    function optionBtnStyle(T, isActive) {
        return [
            "background:" + (isActive ? T.color.oxide : "transparent"),
            "color:" + (isActive ? T.color.bone : T.color.oxide),
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
    }

    function btnStyle(T) {
        return [
            "background:transparent",
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[2] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
    }

    window.AESStudioDashboardSection = { render: render };
})();
