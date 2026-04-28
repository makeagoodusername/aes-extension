"use strict";

/**
 * AES Customization — slider widget.
 *
 * A hard-edged numeric slider for token nudging. Used by spacing,
 * typography, motion, and bulk-shift sections. The track is a 2px
 * oxide line; the thumb is a bone square with a 2px oxide border;
 * value/unit labels are mono. Keyboard arrows step by `step`,
 * Shift-arrows by 10× step.
 *
 * The widget is uncontrolled — the caller passes initial/min/max/step
 * and an onChange callback fired whenever the value changes.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioSlider) return;

    /**
     * @param {{
     *   label: string,
     *   value: number,
     *   min: number,
     *   max: number,
     *   step: number,
     *   unit?: string,
     *   defaultValue?: number,
     *   precision?: number,
     *   onChange: (n: number) => void,
     *   onCommit?: (n: number) => void
     * }} opts
     * @returns {HTMLElement}
     */
    function render(opts) {
        const T = window.AESTokens;
        const wrap = document.createElement("div");
        wrap.style.cssText = [
            "display:grid",
            "grid-template-columns:160px 1fr 80px",
            "gap:" + T.sp[3],
            "align-items:center",
            "padding:" + T.sp[1] + " 0"
        ].join(";");

        const lbl = document.createElement("div");
        lbl.textContent = opts.label;
        lbl.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:" + T.fw.bold,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";");
        wrap.appendChild(lbl);

        const input = document.createElement("input");
        input.type = "range";
        input.min = String(opts.min);
        input.max = String(opts.max);
        input.step = String(opts.step);
        input.value = String(opts.value);
        input.style.cssText = [
            "width:100%",
            "height:24px",
            "appearance:none",
            "-webkit-appearance:none",
            "background:transparent",
            "cursor:pointer",
            "margin:0"
        ].join(";");
        // Style thumb + track via a tiny scoped <style> tag once
        ensureSliderStyle();
        input.classList.add("aes-studio-slider");
        wrap.appendChild(input);

        const meta = document.createElement("div");
        meta.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[1],
            "justify-content:flex-end"
        ].join(";");
        const value = document.createElement("input");
        value.type = "text";
        value.value = formatValue(input.value, opts);
        value.style.cssText = [
            "width:60px",
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "text-align:right",
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "letter-spacing:" + T.track.mono,
            "box-sizing:border-box"
        ].join(";");
        meta.appendChild(value);
        wrap.appendChild(meta);

        function emit() {
            const n = Number(input.value);
            value.value = formatValue(input.value, opts);
            opts.onChange(n);
        }
        input.addEventListener("input", emit);
        input.addEventListener("change", function () {
            if (opts.onCommit) opts.onCommit(Number(input.value));
        });
        value.addEventListener("change", function () {
            const n = Number(value.value);
            if (!isFinite(n)) { value.value = formatValue(input.value, opts); return; }
            const clamped = Math.max(opts.min, Math.min(opts.max, n));
            input.value = String(clamped);
            emit();
            if (opts.onCommit) opts.onCommit(clamped);
        });

        wrap.setValue = function (n) {
            input.value = String(n);
            value.value = formatValue(input.value, opts);
        };
        return wrap;
    }

    function formatValue(v, opts) {
        const n = Number(v);
        const p = opts.precision != null ? opts.precision : 0;
        return n.toFixed(p) + (opts.unit || "");
    }

    let styleInjected = false;
    function ensureSliderStyle() {
        if (styleInjected) return;
        styleInjected = true;
        const s = document.createElement("style");
        s.textContent =
            ".aes-studio-slider::-webkit-slider-runnable-track { height:2px; background:var(--aes-oxide); border:none; }\n" +
            ".aes-studio-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:14px; height:14px; background:var(--aes-bone); border:2px solid var(--aes-oxide); margin-top:-6px; cursor:pointer; }\n" +
            ".aes-studio-slider::-moz-range-track { height:2px; background:var(--aes-oxide); border:none; }\n" +
            ".aes-studio-slider::-moz-range-thumb { width:14px; height:14px; background:var(--aes-bone); border:2px solid var(--aes-oxide); border-radius:0; cursor:pointer; }\n" +
            ".aes-studio-slider:focus-visible { outline:none; }\n" +
            ".aes-studio-slider:focus-visible::-webkit-slider-thumb { background:var(--aes-rust); border-color:var(--aes-rust-deep); }\n" +
            ".aes-studio-slider:focus-visible::-moz-range-thumb { background:var(--aes-rust); border-color:var(--aes-rust-deep); }\n";
        document.head.appendChild(s);
    }

    window.AESStudioSlider = { render };
})();
