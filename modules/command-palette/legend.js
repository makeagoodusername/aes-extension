"use strict";

/**
 * Command palette hotkey legend.
 *
 * Registers a "Show hotkey reference" command (id "palette.legend",
 * keyword "?") that opens a separate modal listing all entries
 * contributed via AESCommandPalette.registerLegend. Grouped by section
 * id, sections sorted alphabetically.
 *
 * Discovery hint: the keyword "?" makes the command findable by typing
 * "?" in the palette input.
 */
(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (!window.AESCommandPalette || !window.AESCommandRegistry) return;
    if (window.__AESPaletteLegendInstalled) return;
    window.__AESPaletteLegendInstalled = true;

    const palette = window.AESCommandPalette;
    const reg = window.AESCommandRegistry;

    const STYLE_ID = "aes-palette-legend-style";
    const HOST_ID = "aes-palette-legend";

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
            "#" + HOST_ID + "-backdrop {" +
                "position:fixed;inset:0;background:rgba(0,0,0,0.55);" +
                "z-index:2147483646;opacity:0;transition:opacity 120ms ease;" +
            "}" +
            "#" + HOST_ID + "-backdrop.open { opacity:1; }" +
            "#" + HOST_ID + " {" +
                "position:fixed;top:12vh;left:50%;transform:translateX(-50%);" +
                "width:min(720px, calc(100vw - 32px));max-height:76vh;" +
                "background:#181a1f;color:#d8dde6;border:1px solid #2c313a;" +
                "border-radius:10px;box-shadow:0 20px 50px -12px rgba(0,0,0,0.55);" +
                "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;" +
                "font-size:13px;line-height:1.4;z-index:2147483647;overflow:hidden;" +
                "display:flex;flex-direction:column;" +
            "}" +
            "#" + HOST_ID + " header {" +
                "padding:14px 18px;border-bottom:1px solid #2c313a;" +
                "font-weight:600;color:#f1f3f7;display:flex;justify-content:space-between;align-items:center;" +
            "}" +
            "#" + HOST_ID + " header button {" +
                "background:transparent;border:none;color:#8a93a3;cursor:pointer;font-size:18px;" +
            "}" +
            "#" + HOST_ID + " .scroll {" +
                "overflow-y:auto;padding:8px 0;" +
            "}" +
            "#" + HOST_ID + " section {" +
                "padding:8px 18px;" +
            "}" +
            "#" + HOST_ID + " section h3 {" +
                "margin:8px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8a93a3;" +
            "}" +
            "#" + HOST_ID + " section .entry {" +
                "display:flex;justify-content:space-between;gap:16px;padding:5px 0;" +
                "border-bottom:1px solid rgba(255,255,255,0.04);" +
            "}" +
            "#" + HOST_ID + " section .entry:last-child { border-bottom:none; }" +
            "#" + HOST_ID + " section .entry .desc { color:#d8dde6;flex:1 1 auto;min-width:0; }" +
            "#" + HOST_ID + " section .entry .keys {" +
                "color:#5fa8ff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;" +
                "background:rgba(95,168,255,0.1);padding:2px 8px;border-radius:6px;flex:0 0 auto;" +
            "}";
        document.head.appendChild(style);
    }

    function open() {
        if (document.getElementById(HOST_ID)) return;
        ensureStyle();

        const backdrop = document.createElement("div");
        backdrop.id = HOST_ID + "-backdrop";
        backdrop.addEventListener("click", close);

        const modal = document.createElement("div");
        modal.id = HOST_ID;
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-label", "AES hotkey reference");

        const header = document.createElement("header");
        const title = document.createElement("span");
        title.textContent = "AES — Hotkey reference";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", close);
        header.append(title, closeBtn);

        const scroll = document.createElement("div");
        scroll.className = "scroll";

        const legendIndex = (typeof palette.getLegend === "function") ? palette.getLegend() : null;
        const sectionIds = legendIndex ? Array.from(legendIndex.keys()).sort() : [];
        if (!sectionIds.length) {
            const empty = document.createElement("section");
            empty.textContent = "No hotkeys registered yet.";
            empty.style.cssText = "padding:24px;color:#6a7280;text-align:center;font-style:italic";
            scroll.appendChild(empty);
        } else {
            for (const sectionId of sectionIds) {
                const entries = legendIndex.get(sectionId);
                if (!entries || !entries.length) continue;
                const sec = document.createElement("section");
                const h = document.createElement("h3");
                h.textContent = sectionId;
                sec.appendChild(h);
                for (const e of entries) {
                    const row = document.createElement("div");
                    row.className = "entry";
                    const desc = document.createElement("span");
                    desc.className = "desc";
                    desc.textContent = e.desc;
                    const keys = document.createElement("span");
                    keys.className = "keys";
                    keys.textContent = e.keys;
                    row.append(desc, keys);
                    sec.appendChild(row);
                }
                scroll.appendChild(sec);
            }
        }

        modal.append(header, scroll);
        document.body.append(backdrop, modal);
        requestAnimationFrame(function () {
            backdrop.classList.add("open");
        });

        document.addEventListener("keydown", onKey, true);
    }

    function close() {
        const backdrop = document.getElementById(HOST_ID + "-backdrop");
        const modal = document.getElementById(HOST_ID);
        if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        document.removeEventListener("keydown", onKey, true);
    }

    function onKey(e) {
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            close();
        }
    }

    reg.register({
        id: "palette.legend",
        scope: "any",
        label: "Show hotkey reference",
        hint: "Open the legend of all registered keybindings.",
        keywords: ["?", "help", "shortcuts", "hotkeys", "keys", "reference"],
        run: open
    });
})();
