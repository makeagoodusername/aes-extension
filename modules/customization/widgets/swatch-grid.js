"use strict";

/**
 * AES Customization — swatch grid widget.
 *
 * Renders the registry's color tokens as a hard-edged grid of squares.
 * Clicking a swatch opens a popover with hex / rgb / hsl inputs (and a
 * native `<input type="color">` for visual picking). Edits commit on
 * blur or Enter; Esc reverts.
 *
 * Phase 1 scope: hex input + native picker. RGB/HSL inputs deferred
 * to Phase 2 alongside the contrast pairing matrix.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioSwatchGrid) return;

    const T_FALLBACK = {
        color: { bone: "var(--aes-bone)", oxide: "var(--aes-oxide)", oxide2: "var(--aes-oxide-2)",
                 slate: "var(--aes-slate)", rust: "var(--aes-rust)", bone2: "var(--aes-bone-2)",
                 paperRule: "var(--aes-paper-rule)" },
        font: { display: "var(--aes-font-display)", mono: "var(--aes-font-mono)" },
        fs: { micro: "var(--aes-fs-micro)", small: "var(--aes-fs-small)", body: "var(--aes-fs-body)" },
        sp: { 1: "var(--aes-sp-1)", 2: "var(--aes-sp-2)", 3: "var(--aes-sp-3)", 4: "var(--aes-sp-4)" },
        geom: { bw1: "var(--aes-bw-1)", bw2: "var(--aes-bw-2)" },
        track: { caps: "var(--aes-tracking-caps)", mono: "var(--aes-tracking-mono)" }
    };
    function tokens() { return window.AESTokens || T_FALLBACK; }

    /**
     * @param {{group?: string}} [opts]
     * @returns {HTMLElement}
     */
    function render(opts) {
        const T = tokens();
        const reg = window.AESTokenRegistry;
        const store = window.AESCustomizationStore;
        const filter = (opts && opts.group) || null;
        const colors = reg ? reg.list(function (t) {
            if (t.format !== "color") return false;
            if (filter) return t.group === filter;
            return t.group === "color"; // default: only the primary palette
        }) : [];

        const grid = document.createElement("div");
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(auto-fill, minmax(120px, 1fr))",
            "gap:" + T.sp[3],
            "margin-top:" + T.sp[3]
        ].join(";");

        for (const tok of colors) {
            grid.appendChild(buildSwatch(T, tok, store));
        }
        return grid;
    }

    function buildSwatch(T, tok, store) {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = [
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "display:flex",
            "flex-direction:column",
            "min-height:120px"
        ].join(";");

        const fill = document.createElement("div");
        fill.style.cssText = [
            "flex:1 1 auto",
            "min-height:64px",
            "background:var(" + tok.var + ")",
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.oxide,
            "cursor:pointer"
        ].join(";");
        wrapper.appendChild(fill);

        const meta = document.createElement("div");
        meta.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "color:" + T.color.oxide,
            "letter-spacing:" + T.track.mono,
            "display:flex",
            "justify-content:space-between",
            "align-items:center"
        ].join(";");
        const label = document.createElement("span");
        label.textContent = tok.label.toUpperCase();
        label.style.fontWeight = "700";
        const ovr = document.createElement("span");
        ovr.style.cssText = "color:" + T.color.rust + ";font-weight:700";
        meta.appendChild(label);
        meta.appendChild(ovr);
        wrapper.appendChild(meta);

        const value = document.createElement("div");
        value.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "color:" + T.color.oxide2,
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule
        ].join(";");
        wrapper.appendChild(value);

        function refresh() {
            if (!store) return;
            const scope = store.getCurrentScope();
            const overrides = store.scopeOverrides(scope);
            const overridden = Object.prototype.hasOwnProperty.call(overrides, tok.var);
            ovr.textContent = overridden ? "OVR" : "";
            // For non-global scope, show the per-scope value if set,
            // otherwise the resolved global value (which is what the
            // scope inherits from). Hex-shaped values fit in the cell.
            if (overridden) {
                value.textContent = String(overrides[tok.var]);
            } else {
                const literal = readLiteral(tok.var);
                value.textContent = literal || tok.default;
            }
        }
        refresh();
        if (store) {
            store.subscribe(refresh);
            store.subscribeScope(refresh);
        }

        fill.addEventListener("click", function (e) {
            e.stopPropagation();
            openPopover(T, tok, fill, store);
        });
        return wrapper;
    }

    function readLiteral(cssVar) {
        try {
            return getComputedStyle(document.documentElement)
                .getPropertyValue(cssVar).trim();
        } catch (_) { return ""; }
    }

    let activePopover = null;
    function closePopover() {
        if (activePopover) { activePopover.remove(); activePopover = null; }
    }

    function openPopover(T, tok, anchor, store) {
        closePopover();
        const rect = anchor.getBoundingClientRect();
        const pop = document.createElement("div");
        pop.setAttribute("data-aes-studio-popover", "1");
        pop.style.cssText = [
            "position:fixed",
            "left:" + Math.round(rect.left) + "px",
            "top:" + Math.round(rect.bottom + 4) + "px",
            "width:280px",
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "padding:" + T.sp[3],
            "z-index:" + (window.AESTokens ? window.AESTokens.z.popover : 9000),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "box-shadow:4px 4px 0 " + T.color.oxide
        ].join(";");

        const title = document.createElement("div");
        title.textContent = tok.label.toUpperCase() + "  ·  " + tok.var;
        title.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "color:" + T.color.oxide2,
            "letter-spacing:" + T.track.mono,
            "margin-bottom:" + T.sp[2]
        ].join(";");
        pop.appendChild(title);

        const current = readLiteral(tok.var) || tok.default;
        const isHex = /^#[0-9a-fA-F]{3,8}$/.test(current);

        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:" + T.sp[2] + ";align-items:stretch";
        const picker = document.createElement("input");
        picker.type = "color";
        picker.style.cssText = "width:64px;height:48px;border:" + T.geom.bw1 + " solid " + T.color.oxide + ";padding:0;background:transparent;cursor:pointer";
        if (isHex && current.length >= 7) picker.value = current.slice(0, 7);

        const hex = document.createElement("input");
        hex.type = "text";
        hex.value = current;
        hex.style.cssText = [
            "flex:1 1 auto",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide
        ].join(";");
        row.append(picker, hex);
        pop.appendChild(row);

        function commit(v) {
            const value = String(v || "").trim();
            if (!value) return;
            if (store) store.setOverride(tok.var, value);
        }
        picker.addEventListener("input", function () { commit(picker.value); hex.value = picker.value; });
        hex.addEventListener("change", function () { commit(hex.value); });
        hex.addEventListener("keydown", function (e) {
            if (e.key === "Enter")  { commit(hex.value); closePopover(); }
            if (e.key === "Escape") { closePopover(); }
        });

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:" + T.sp[2] + ";margin-top:" + T.sp[3] + ";justify-content:space-between";
        const reset = button(T, "Reset in this scope", function () {
            if (store) store.setOverride(tok.var, null);
            closePopover();
        });
        const done = button(T, "Done", function () { closePopover(); }, true);
        actions.append(reset, done);
        pop.appendChild(actions);

        document.body.appendChild(pop);
        activePopover = pop;
        setTimeout(function () { hex.focus(); hex.select(); }, 0);

        function outside(e) {
            if (!pop.contains(e.target)) {
                closePopover();
                document.removeEventListener("mousedown", outside, true);
            }
        }
        setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
    }

    function button(T, label, onClick, primary) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = [
            "background:" + (primary ? T.color.oxide : T.color.bone),
            "color:" + (primary ? T.color.bone : T.color.oxide),
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
        b.addEventListener("click", function (e) { e.preventDefault(); onClick(); });
        return b;
    }

    window.AESStudioSwatchGrid = { render, closePopover };
})();
