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
                "position:fixed;inset:0;background:var(--aes-shadow-backdrop);" +
                "z-index:calc(var(--aes-z-modal) - 1);opacity:0;transition:opacity var(--aes-tr-medium);" +
            "}" +
            "#" + HOST_ID + "-backdrop.open { opacity:1; }" +
            "#" + HOST_ID + " {" +
                "position:fixed;top:12vh;left:50%;transform:translateX(-50%);" +
                "width:min(720px, calc(100vw - 32px));max-height:76vh;" +
                "background:var(--aes-bone);color:var(--aes-oxide);" +
                "border:var(--aes-bw-2) solid var(--aes-oxide);" +
                "border-radius:var(--aes-radius);box-shadow:var(--aes-shadow-modal);" +
                "font-family:var(--aes-font-display);" +
                "font-size:var(--aes-fs-body);line-height:var(--aes-lh-body);" +
                "z-index:var(--aes-z-modal);overflow:hidden;" +
                "display:flex;flex-direction:column;" +
            "}" +
            "#" + HOST_ID + " header {" +
                "padding:var(--aes-sp-3) var(--aes-sp-4);" +
                "border-bottom:var(--aes-bw-1) solid var(--aes-paper-rule);" +
                "font-family:var(--aes-font-display);font-weight:var(--aes-fw-display);" +
                "font-size:var(--aes-fs-lead);text-transform:uppercase;" +
                "letter-spacing:var(--aes-tracking-caps);" +
                "color:var(--aes-oxide);display:flex;justify-content:space-between;align-items:center;" +
            "}" +
            "#" + HOST_ID + " header button {" +
                "background:transparent;border:none;color:var(--aes-oxide);" +
                "cursor:pointer;font-size:var(--aes-fs-h3);font-family:inherit;" +
            "}" +
            "#" + HOST_ID + " .scroll {" +
                "overflow-y:auto;padding:var(--aes-sp-2) 0;" +
            "}" +
            "#" + HOST_ID + " section {" +
                "padding:var(--aes-sp-2) var(--aes-sp-4);" +
            "}" +
            "#" + HOST_ID + " section h3 {" +
                "margin:var(--aes-sp-2) 0 var(--aes-sp-1);font-family:var(--aes-font-display);" +
                "font-size:var(--aes-fs-micro);font-weight:var(--aes-fw-display);" +
                "text-transform:uppercase;letter-spacing:var(--aes-tracking-caps);" +
                "color:var(--aes-slate);" +
            "}" +
            "#" + HOST_ID + " section .entry {" +
                "display:flex;justify-content:space-between;gap:var(--aes-sp-4);padding:var(--aes-sp-1) 0;" +
                "border-bottom:var(--aes-bw-1) solid var(--aes-paper-rule);" +
            "}" +
            "#" + HOST_ID + " section .entry:last-child { border-bottom:none; }" +
            "#" + HOST_ID + " section .entry .desc { color:var(--aes-oxide);flex:1 1 auto;min-width:0; }" +
            "#" + HOST_ID + " section .entry .keys {" +
                "color:var(--aes-rust);font-family:var(--aes-font-mono);" +
                "font-size:var(--aes-fs-small);" +
                "background:var(--aes-rust-soft);padding:2px var(--aes-sp-2);" +
                "border-radius:var(--aes-radius);flex:0 0 auto;" +
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
            empty.style.cssText = "padding:var(--aes-sp-5);color:var(--aes-slate);text-align:center;font-style:italic";
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
