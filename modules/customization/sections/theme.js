"use strict";

/**
 * Studio §01 — Theme.
 *
 * Preset library + JSON import/export. Phase 1 only — fork/save UI
 * deferred to Phase 2 (the data model already supports user-defined
 * presets, see preset-codec.js).
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioThemeSection) return;

    function tokens() { return window.AESTokens; }

    function render(host) {
        host.textContent = "";
        const T = tokens();
        const store = window.AESCustomizationStore;
        const presets = window.AESPresets ? window.AESPresets.listBuiltIn() : [];

        // Active preset chips
        const dock = document.createElement("div");
        dock.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "gap:" + T.sp[2],
            "margin-bottom:" + T.sp[4]
        ].join(";");

        for (const p of presets) {
            dock.appendChild(presetChip(T, p, store));
        }
        host.appendChild(dock);

        // Description of the active preset
        const desc = document.createElement("div");
        desc.style.cssText = [
            "padding:" + T.sp[3],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "color:" + T.color.oxide2,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "line-height:1.5",
            "margin-bottom:" + T.sp[4]
        ].join(";");
        function refreshDesc() {
            const active = store ? store.activePreset() : null;
            desc.textContent = active ? (active.description || active.name) : "—";
        }
        refreshDesc();
        if (store) store.subscribe(refreshDesc);
        host.appendChild(desc);

        // Import / Export buttons
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:" + T.sp[2];
        actions.appendChild(button(T, "Export JSON ↓", function () {
            const codec = window.AESPresetCodec;
            if (!codec) return;
            const bundle = codec.exportBundle();
            if (bundle) codec.downloadJson(bundle);
        }));
        actions.appendChild(button(T, "Import JSON ↑", function () { openImportDialog(T); }));
        actions.appendChild(button(T, "Reset overrides", function () {
            if (store) store.clearGlobalOverrides();
        }));
        host.appendChild(actions);

        // Footer note about deferred phases / known limits
        const note = document.createElement("div");
        note.style.cssText = [
            "margin-top:" + T.sp[5],
            "padding:" + T.sp[3],
            "border-left:" + T.geom.bw3 + " solid " + T.color.rust,
            "background:" + T.color.bone2,
            "color:" + T.color.oxide2,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "line-height:1.5"
        ].join(";");
        note.innerHTML = ""; // safety; we use textContent below
        note.textContent = "Phase 1 — global scope only. Some legacy panels (route-assistant, used-aircraft scanner) still use hardcoded hex values and won't recolor; full coverage in v0.7.";
        host.appendChild(note);
    }

    function presetChip(T, preset, store) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.presetId = preset.id;
        const isActive = function () { return store && store.activePresetId() === preset.id; };
        function paint() {
            const active = isActive();
            chip.style.cssText = [
                "padding:" + T.sp[2] + " " + T.sp[3],
                "border:" + T.geom.bw2 + " solid " + T.color.oxide,
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
        chip.textContent = preset.name + (isActive() ? " *" : "");
        paint();
        if (store) store.subscribe(function () {
            chip.textContent = preset.name + (isActive() ? " *" : "");
            paint();
        });
        chip.addEventListener("click", function (e) {
            e.preventDefault();
            if (store) store.setActivePreset(preset.id);
        });
        return chip;
    }

    function button(T, label, onClick) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = [
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
        b.addEventListener("click", function (e) { e.preventDefault(); onClick(); });
        return b;
    }

    function openImportDialog(T) {
        const overlay = document.createElement("div");
        overlay.style.cssText = [
            "position:fixed", "inset:0",
            "background:rgba(26,22,18,0.6)",
            "z-index:" + (window.AESTokens ? window.AESTokens.z.modal : 10000),
            "display:flex", "align-items:center", "justify-content:center"
        ].join(";");
        const panel = document.createElement("div");
        panel.style.cssText = [
            "width:480px", "max-width:90vw",
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "padding:" + T.sp[4],
            "font-family:" + T.font.display,
            "color:" + T.color.oxide,
            "box-shadow:6px 6px 0 " + T.color.oxide
        ].join(";");
        const title = document.createElement("div");
        title.textContent = "IMPORT THEME JSON";
        title.style.cssText = "font-size:" + T.fs.lead + ";font-weight:800;margin-bottom:" + T.sp[3] + ";text-transform:uppercase;letter-spacing:" + T.track.caps;
        const ta = document.createElement("textarea");
        ta.placeholder = '{ "schema": "aes-customization-export", ... }';
        ta.style.cssText = [
            "width:100%", "height:200px",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "padding:" + T.sp[2],
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "background:" + T.color.bone2,
            "color:" + T.color.oxide,
            "box-sizing:border-box",
            "resize:vertical"
        ].join(";");
        const status = document.createElement("div");
        status.style.cssText = "min-height:18px;margin-top:" + T.sp[2] + ";font-family:" + T.font.mono + ";font-size:" + T.fs.small;
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:" + T.sp[2] + ";justify-content:flex-end;margin-top:" + T.sp[3];
        const cancel = button(T, "Cancel", function () { overlay.remove(); });
        const apply = button(T, "Apply", function () {
            const codec = window.AESPresetCodec;
            const result = codec ? codec.parse(ta.value) : { ok: false, error: "no codec" };
            if (!result.ok) {
                status.style.color = "var(--aes-crimson)";
                status.textContent = "ERROR: " + result.error;
                return;
            }
            codec.apply(result.bundle).then(function () {
                status.style.color = "var(--aes-moss)";
                status.textContent = "Applied. Closing…";
                setTimeout(function () { overlay.remove(); }, 600);
            });
        });
        actions.append(cancel, apply);
        panel.append(title, ta, status, actions);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        ta.focus();
    }

    window.AESStudioThemeSection = { render };
})();
