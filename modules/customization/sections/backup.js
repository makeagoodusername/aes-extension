"use strict";

/**
 * AES Customization Studio — §10 Backup section.
 *
 * Thin UI on top of AESPresetCodec:
 *   - Export current bundle (downloads JSON)
 *   - Export active user-defined preset only (for sharing one config)
 *   - Import bundle from a .json file (re-applies through the store)
 *
 * The codec already implements all parsing, validation, and store writes.
 * This module only renders three buttons + a status line, then routes
 * file picker / blob results into the codec.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioBackupSection) return;

    function tokens() { return window.AESTokens; }

    function el(tag, style, text) {
        const e = document.createElement(tag);
        if (style) e.style.cssText = style;
        if (text != null) e.textContent = text;
        return e;
    }

    function buttonStyle(T, primary) {
        return [
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + (primary ? T.color.oxide : T.color.bone),
            "color:" + (primary ? T.color.bone : T.color.oxide),
            "padding:" + T.sp[2] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:" + T.fw.bold,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer",
            "min-height:32px"
        ].join(";");
    }

    function paragraph(T, text) {
        return el("p", [
            "margin:0 0 " + T.sp[3] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "line-height:" + T.lh.body,
            "color:" + T.color.oxide2
        ].join(";"), text);
    }

    function sectionHead(T, title, hint) {
        const wrap = el("div", "margin:0 0 " + T.sp[3] + " 0");
        const h = el("h3", [
            "margin:0 0 " + T.sp[1] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.oxide
        ].join(";"), title);
        wrap.appendChild(h);
        if (hint) wrap.appendChild(paragraph(T, hint));
        return wrap;
    }

    function showStatus(statusEl, T, kind, text) {
        const colors = {
            ok:   T.color.moss,
            warn: T.color.amber,
            err:  T.color.crimson,
            info: T.color.oxide2
        };
        statusEl.style.color = colors[kind] || T.color.oxide;
        statusEl.textContent = text || "";
    }

    function activeUserPreset() {
        const store = window.AESCustomizationStore;
        if (!store) return null;
        const id = store.activePresetId();
        if (!id || id === "default") return null;
        const snap = store.get();
        const map = (snap && snap.userPresets) || {};
        return map[id] || null;
    }

    function render(host) {
        if (!host) return;
        const T = tokens();
        host.textContent = "";

        const statusEl = el("p", [
            "margin:0 0 0 0",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide2,
            "min-height:" + T.sp[3]
        ].join(";"), "");

        host.appendChild(sectionHead(T, "Export",
            "Download your current Studio configuration as a portable JSON bundle. " +
            "Includes the active preset, global token overrides, ornament/density/" +
            "numeral settings, and shortcut rebinds. Safe to share — no game data, " +
            "no credentials."));

        const exportRow = el("div", "display:flex;gap:" + T.sp[2] + ";flex-wrap:wrap;margin-bottom:" + T.sp[5]);

        const exportFull = el("button", buttonStyle(T, true), "Export full bundle");
        exportFull.type = "button";
        exportFull.addEventListener("click", function (e) {
            e.preventDefault();
            const codec = window.AESPresetCodec;
            if (!codec) { showStatus(statusEl, T, "err", "Preset codec not available."); return; }
            const bundle = codec.exportBundle();
            if (!bundle) { showStatus(statusEl, T, "err", "Could not build bundle (store not ready)."); return; }
            codec.downloadJson(bundle);
            const n = Object.keys(bundle.globalOverrides || {}).length;
            showStatus(statusEl, T, "ok",
                "Exported · " + (bundle.active && bundle.active.presetId || "default") +
                " · " + n + " global override" + (n === 1 ? "" : "s"));
        });

        const exportPreset = el("button", buttonStyle(T, false), "Export active preset only");
        exportPreset.type = "button";
        exportPreset.addEventListener("click", function (e) {
            e.preventDefault();
            const codec = window.AESPresetCodec;
            if (!codec) { showStatus(statusEl, T, "err", "Preset codec not available."); return; }
            const preset = activeUserPreset();
            if (!preset) {
                showStatus(statusEl, T, "warn",
                    "No user-defined preset is active. Save a preset first, " +
                    "then export it on its own.");
                return;
            }
            const bundle = codec.exportUserPreset(preset);
            if (!bundle) { showStatus(statusEl, T, "err", "Could not serialize preset."); return; }
            codec.downloadJson(bundle, "aes-preset-" + preset.id + ".json");
            showStatus(statusEl, T, "ok", "Exported preset · " + (preset.name || preset.id));
        });

        exportRow.append(exportFull, exportPreset);
        host.appendChild(exportRow);

        host.appendChild(sectionHead(T, "Import",
            "Apply a previously exported bundle. Existing overrides are replaced; " +
            "the file's preset is added alongside the built-ins. Validation is " +
            "lenient — unknown tokens drop silently rather than blocking the import."));

        const importRow = el("div", "display:flex;gap:" + T.sp[2] + ";flex-wrap:wrap;align-items:center");

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "application/json,.json";
        fileInput.style.cssText = "display:none";

        const importBtn = el("button", buttonStyle(T, true), "Choose file…");
        importBtn.type = "button";
        importBtn.addEventListener("click", function (e) {
            e.preventDefault();
            fileInput.click();
        });

        fileInput.addEventListener("change", function () {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            showStatus(statusEl, T, "info", "Reading " + file.name + "…");
            const reader = new FileReader();
            reader.onerror = function () {
                showStatus(statusEl, T, "err", "Could not read file.");
            };
            reader.onload = function () {
                const codec = window.AESPresetCodec;
                if (!codec) { showStatus(statusEl, T, "err", "Preset codec not available."); return; }
                const result = codec.parse(String(reader.result || ""));
                if (!result.ok) {
                    showStatus(statusEl, T, "err", "Import failed: " + result.error);
                    return;
                }
                Promise.resolve(codec.apply(result.bundle)).then(function () {
                    const n = Object.keys((result.bundle && result.bundle.globalOverrides) || {}).length;
                    showStatus(statusEl, T, "ok",
                        "Imported · " + (result.bundle.active.presetId) +
                        " · " + n + " global override" + (n === 1 ? "" : "s"));
                }, function (err) {
                    showStatus(statusEl, T, "err", "Apply failed: " + (err && err.message || err));
                });
                fileInput.value = "";
            };
            reader.readAsText(file);
        });

        importRow.append(importBtn, fileInput);
        host.appendChild(importRow);

        statusEl.style.marginTop = T.sp[4];
        host.appendChild(statusEl);
    }

    window.AESStudioBackupSection = {render};
})();
