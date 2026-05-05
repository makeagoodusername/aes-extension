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

        // B-3 User presets row — user-saved bundles
        host.appendChild(userPresetsRow(T, store));

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

    /* B-3 — User presets: save / apply / rename / delete / export bundles
       of the user's current Studio state (active built-in preset + all
       overrides + ornament + density + numerals). Stored in
       customization.userPresets keyed by id; lifecycle goes through
       store.saveUserPreset / updateUserPreset / deleteUserPreset. */
    function userPresetsRow(T, store) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom:" + T.sp[4];

        const head = document.createElement("div");
        head.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:" + T.sp[2];

        const title = document.createElement("div");
        title.textContent = "USER PRESETS";
        title.style.cssText = [
            "font-family:" + T.font.display,
            "font-weight:" + T.fw.display,
            "font-size:" + T.fs.small,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate
        ].join(";");

        const saveBtn = button(T, "+ Save current", function () {
            promptSavePreset(T, store);
        });

        head.append(title, saveBtn);
        wrap.appendChild(head);

        const dock = document.createElement("div");
        dock.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "gap:" + T.sp[2]
        ].join(";");
        wrap.appendChild(dock);

        const empty = document.createElement("div");
        empty.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.small + ";color:" + T.color.slate + ";font-style:italic";
        empty.textContent = "No saved presets yet.";

        function paint() {
            const list = (store && typeof store.listUserPresets === "function") ? store.listUserPresets() : [];
            dock.textContent = "";
            if (!list.length) {
                dock.appendChild(empty);
                return;
            }
            for (const p of list) dock.appendChild(userPresetChip(T, p, store));
        }
        paint();
        if (store) store.subscribe(paint);

        return wrap;
    }

    function userPresetChip(T, preset, store) {
        const chip = document.createElement("div");
        chip.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[1],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone
        ].join(";");

        const apply = document.createElement("button");
        apply.type = "button";
        apply.textContent = preset.name;
        apply.style.cssText = [
            "background:transparent",
            "border:none",
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-weight:700",
            "font-size:" + T.fs.small,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";");
        apply.title = "Apply this preset";
        apply.addEventListener("click", function (e) {
            e.preventDefault();
            applyUserPreset(preset, store);
        });

        const renameBtn = chipIconButton(T, "✎", "Rename", function () {
            const next = window.prompt("Rename preset:", preset.name);
            if (next != null) store.updateUserPreset(preset.id, { name: next });
        });
        const exportBtn = chipIconButton(T, "↓", "Export", function () {
            const codec = window.AESPresetCodec;
            if (!codec || !codec.exportUserPreset) return;
            const bundle = codec.exportUserPreset(preset);
            if (bundle) codec.downloadJson(bundle, "aes-preset-" + preset.id + ".json");
        });
        const deleteBtn = chipIconButton(T, "✕", "Delete", function () {
            if (!window.confirm("Delete preset \"" + preset.name + "\"? This cannot be undone.")) return;
            store.deleteUserPreset(preset.id);
        });

        chip.append(apply, renameBtn, exportBtn, deleteBtn);
        return chip;
    }

    function chipIconButton(T, glyph, hint, onClick) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = glyph;
        b.title = hint;
        b.style.cssText = [
            "background:transparent",
            "border:none",
            "padding:0 " + T.sp[1],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "color:" + T.color.slate,
            "cursor:pointer"
        ].join(";");
        b.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    function promptSavePreset(T, store) {
        const name = window.prompt("Save current Studio state as preset. Name:", "My preset");
        if (!name) return;
        const snapshot = currentSnapshot(store);
        store.saveUserPreset(name, snapshot);
    }

    function currentSnapshot(store) {
        const cache = store.get();
        return {
            presetId: store.activePresetId(),
            globalOverrides: store.globalOverrides(),
            sectionOverrides: (cache.scopes && cache.scopes.section) || {},
            tileOverrides: (cache.scopes && cache.scopes.tile) || {},
            ornament: { intensity: store.ornamentIntensity() },
            density: { bySurface: (cache.density && cache.density.bySurface) || {} },
            numerals: store.numerals()
        };
    }

    function applyUserPreset(preset, store) {
        const snap = preset && preset.snapshot ? preset.snapshot : null;
        if (!snap) return;
        // Two-step: clear scoped overrides + density + numerals, then re-apply.
        store.patch({
            active: { presetId: String(snap.presetId || "default") },
            scopes: { global: "__CLEAR__", section: "__CLEAR__", tile: "__CLEAR__" },
            ornament: snap.ornament || { intensity: "moderate" },
            density: { bySurface: "__CLEAR__" },
            numerals: "__CLEAR__"
        }).then(function () {
            return store.patch({
                scopes: {
                    global:  snap.globalOverrides  || {},
                    section: snap.sectionOverrides || {},
                    tile:    snap.tileOverrides    || {}
                },
                density: { bySurface: (snap.density && snap.density.bySurface) || {} },
                numerals: snap.numerals || {}
            });
        });
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
