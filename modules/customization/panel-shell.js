"use strict";

/**
 * AES Customization Studio — panel shell.
 *
 * The slide-out 720px panel from the right edge of the viewport.
 * Layout:
 *   [masthead]                 — wordmark, preset dock, dirty stamp, actions
 *   [scope ribbon]             — Global only in Phase 1
 *   [split: left rail | canvas]
 *
 * Mounting is lazy — host.js boots first, the shell only constructs DOM
 * when toggle()/open() is called. Hotkey is `g c` (registered in
 * shortcut-registry.js); the dispatch calls AESCustomizationHost.toggle.
 *
 * Editorial brutalism in chrome: only bone / oxide / rust used; status
 * colours appear only in conflict warnings inside §07. Hard offset
 * shadows (4px 4px 0 oxide) on interactive controls. No blur.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESCustomizationStudio) return;

    const PANEL_ID = "aes-studio-panel";
    const SAFETY_ID = "aes-studio-safety";

    let panelEl = null;
    let canvasEl = null;
    let activeSectionId = "theme";
    let storeUnsub = null;
    let scopeUnsub = null;

    const SECTIONS = [
        { id: "theme",       num: "01", label: "Theme",        active: true },
        { id: "color",       num: "02", label: "Colour",       active: true },
        { id: "typography",  num: "03", label: "Typography",   active: true },
        { id: "spacing",     num: "04", label: "Spacing",      active: true },
        { id: "components",  num: "05", label: "Components",   active: false },
        { id: "motion",      num: "06", label: "Motion",       active: true },
        { id: "keybindings", num: "07", label: "Keybindings",  active: true },
        { id: "layout",      num: "08", label: "Layout",       active: false },
        { id: "scopes",      num: "09", label: "Scopes",       active: false },
        { id: "backup",      num: "10", label: "Backup",       active: false }
    ];

    function tokens() { return window.AESTokens; }

    function ensureSafetyStyle() {
        if (document.getElementById(SAFETY_ID)) return;
        const s = document.createElement("style");
        s.id = SAFETY_ID;
        s.textContent = "#" + PANEL_ID + " { font-size: 12px; line-height: 1.4; }\n" +
                        "#" + PANEL_ID + " * { box-sizing: border-box; }\n" +
                        "#" + PANEL_ID + " button:focus-visible { outline: 3px solid var(--aes-rust); outline-offset: 2px; }";
        document.head.appendChild(s);
    }

    function build() {
        ensureSafetyStyle();
        const T = tokens();

        const root = document.createElement("aside");
        root.id = PANEL_ID;
        root.setAttribute("role", "complementary");
        root.setAttribute("aria-label", "AES Customization Studio");
        root.style.cssText = [
            "position:fixed",
            "top:0",
            "right:0",
            "bottom:0",
            "width:720px",
            "max-width:100vw",
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border-left:" + T.geom.bw3 + " solid " + T.color.oxide,
            "z-index:" + T.z.modal,
            "display:flex",
            "flex-direction:column",
            "font-family:" + T.font.display,
            "transform:translateX(100%)",
            "transition:transform 220ms cubic-bezier(.2,.8,.2,1)",
            "box-shadow:-8px 0 0 rgba(26,22,18,0.12)"
        ].join(";");

        root.appendChild(buildMasthead(T));
        root.appendChild(buildScopeRibbon(T));
        root.appendChild(buildSplit(T));

        document.body.appendChild(root);
        // Animate in next tick so the initial transform applies.
        requestAnimationFrame(function () {
            root.style.transform = "translateX(0)";
        });

        document.addEventListener("keydown", onEscape, true);

        // When scope changes, re-render the active section so values
        // reflect the new scope's overrides.
        const store = window.AESCustomizationStore;
        if (store && typeof store.subscribeScope === "function") {
            scopeUnsub = store.subscribeScope(function () { renderActiveSection(); });
        }

        return root;
    }

    function buildMasthead(T) {
        const bar = document.createElement("div");
        bar.style.cssText = [
            "padding:" + T.sp[3] + " " + T.sp[4],
            "border-bottom:" + T.geom.bw3 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[2]
        ].join(";");

        const top = document.createElement("div");
        top.style.cssText = "display:flex;align-items:center;justify-content:space-between";
        const wordmark = document.createElement("div");
        wordmark.textContent = "AES // STUDIO";
        wordmark.style.cssText = [
            "font-family:" + T.font.display,
            "font-weight:" + T.fw.display,
            "font-size:" + T.fs.h2,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "text-transform:uppercase"
        ].join(";");
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close studio");
        close.style.cssText = [
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "padding:0 " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.h3,
            "font-weight:700",
            "line-height:1",
            "cursor:pointer",
            "min-width:32px",
            "min-height:32px"
        ].join(";");
        close.addEventListener("click", function (e) { e.preventDefault(); close_(); });
        top.append(wordmark, close);
        bar.appendChild(top);

        // Status / dirty stamp
        const status = document.createElement("div");
        status.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "color:" + T.color.oxide2,
            "letter-spacing:" + T.track.mono,
            "text-transform:uppercase"
        ].join(";");
        function refreshStatus() {
            const store = window.AESCustomizationStore;
            const id = store ? store.activePresetId() : "default";
            const overrides = store ? store.globalOverrides() : {};
            const n = Object.keys(overrides).length;
            status.textContent = "ACTIVE · " + id.toUpperCase() + (n ? "  ·  " + n + " override" + (n > 1 ? "s" : "") : "  ·  no overrides");
        }
        refreshStatus();
        if (window.AESCustomizationStore) {
            const sub = window.AESCustomizationStore.subscribe(refreshStatus);
            if (typeof sub === "function") storeUnsub = sub;
        }
        bar.appendChild(status);

        return bar;
    }

    function buildScopeRibbon(T) {
        const wrap = document.createElement("div");
        if (window.AESStudioScopeRibbon) {
            window.AESStudioScopeRibbon.render(wrap);
        }
        return wrap;
    }

    function buildSplit(T) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "flex:1 1 auto;display:flex;min-height:0";
        wrap.appendChild(buildRail(T));
        wrap.appendChild(buildCanvas(T));
        return wrap;
    }

    function buildRail(T) {
        const rail = document.createElement("nav");
        rail.style.cssText = [
            "flex:0 0 200px",
            "border-right:" + T.geom.bw2 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "overflow-y:auto",
            "padding:" + T.sp[3] + " 0"
        ].join(";");

        for (const sec of SECTIONS) {
            const item = document.createElement("button");
            item.type = "button";
            item.dataset.sectionId = sec.id;
            item.disabled = !sec.active;
            const isActive = sec.id === activeSectionId;
            item.style.cssText = railItemStyle(T, isActive, sec.active);
            const num = document.createElement("span");
            num.textContent = sec.num;
            num.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + (isActive ? T.color.bone : T.color.slate) + ";letter-spacing:" + T.track.mono + ";margin-right:" + T.sp[2];
            const lbl = document.createElement("span");
            lbl.textContent = sec.label.toUpperCase();
            lbl.style.cssText = "font-weight:700;letter-spacing:" + T.track.caps;
            item.append(num, lbl);
            if (!sec.active) {
                const tag = document.createElement("span");
                tag.textContent = "  P2";
                tag.style.cssText = "margin-left:auto;font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";color:" + T.color.slate;
                item.appendChild(tag);
            }
            item.addEventListener("click", function (e) {
                e.preventDefault();
                if (!sec.active) return;
                setActiveSection(sec.id);
            });
            rail.appendChild(item);
        }
        return rail;
    }

    function railItemStyle(T, active, available) {
        return [
            "display:flex",
            "align-items:center",
            "width:100%",
            "padding:" + T.sp[2] + " " + T.sp[3],
            "border:none",
            "background:" + (active ? T.color.oxide : "transparent"),
            "color:" + (active ? T.color.bone : (available ? T.color.oxide : T.color.slate)),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:" + (available ? "pointer" : "not-allowed"),
            "text-align:left"
        ].join(";");
    }

    function buildCanvas(T) {
        const canvas = document.createElement("section");
        canvas.style.cssText = [
            "flex:1 1 auto",
            "padding:" + T.sp[5],
            "overflow-y:auto",
            "background:" + T.color.bone
        ].join(";");
        canvasEl = canvas;
        renderActiveSection();
        return canvas;
    }

    function renderActiveSection() {
        if (!canvasEl) return;
        const T = tokens();
        canvasEl.textContent = "";
        const sec = SECTIONS.find(function (s) { return s.id === activeSectionId; });
        if (!sec) return;

        const head = document.createElement("div");
        head.style.cssText = [
            "display:flex",
            "align-items:baseline",
            "gap:" + T.sp[3],
            "padding-bottom:" + T.sp[3],
            "margin-bottom:" + T.sp[3],
            "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide
        ].join(";");
        const num = document.createElement("span");
        num.textContent = sec.num;
        num.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.h2,
            "color:" + T.color.rust,
            "letter-spacing:" + T.track.mono
        ].join(";");
        const lbl = document.createElement("h2");
        lbl.textContent = sec.label.toUpperCase();
        lbl.style.cssText = [
            "margin:0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.h2,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";");
        head.append(num, lbl);
        canvasEl.appendChild(head);

        const body = document.createElement("div");
        canvasEl.appendChild(body);

        const renderers = {
            theme:       window.AESStudioThemeSection,
            color:       window.AESStudioColorSection,
            typography:  window.AESStudioTypographySection,
            spacing:     window.AESStudioSpacingSection,
            motion:      window.AESStudioMotionSection,
            keybindings: window.AESStudioKeybindingsSection
        };
        const r = renderers[activeSectionId];
        if (r && typeof r.render === "function") {
            r.render(body);
        } else {
            body.textContent = "Section unavailable.";
        }
    }

    function setActiveSection(id) {
        activeSectionId = id;
        // Repaint rail items (active highlight)
        const rail = panelEl ? panelEl.querySelector("nav") : null;
        if (rail) {
            const T = tokens();
            Array.from(rail.children).forEach(function (b) {
                const sec = SECTIONS.find(function (s) { return s.id === b.dataset.sectionId; });
                if (!sec) return;
                b.style.cssText = railItemStyle(T, sec.id === activeSectionId, sec.active);
                const span = b.querySelector("span");
                if (span) span.style.color = (sec.id === activeSectionId) ? T.color.bone : T.color.slate;
            });
        }
        renderActiveSection();
    }

    function open() {
        if (panelEl) return;
        panelEl = build();
    }

    function close_() {
        if (!panelEl) return;
        const root = panelEl;
        document.removeEventListener("keydown", onEscape, true);
        if (storeUnsub) { try { storeUnsub(); } catch (_) {} storeUnsub = null; }
        if (scopeUnsub) { try { scopeUnsub(); } catch (_) {} scopeUnsub = null; }
        root.style.transform = "translateX(100%)";
        setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 240);
        panelEl = null;
        canvasEl = null;
    }

    function toggle() {
        if (panelEl) close_(); else open();
    }

    function onEscape(e) {
        if (e.key === "Escape" && panelEl) {
            // Don't swallow Esc for inputs — let them clear first.
            const tgt = e.target;
            if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
            // Don't swallow when a popover is open (swatch picker, import dialog)
            const popover = document.querySelector('[data-aes-studio-popover="1"]');
            if (popover) return;
            e.preventDefault();
            close_();
        }
    }

    window.AESCustomizationStudio = { open, close: close_, toggle };
})();
