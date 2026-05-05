"use strict";

/**
 * AES Customization — scope ribbon widget.
 *
 * Three segmented buttons: Global / Section / Tile. The active scope
 * sets `AESCustomizationStore.setCurrentScope()`, which retargets every
 * subsequent override write made from the Studio. Sections see the
 * scope change via `subscribeScope` and repaint themselves so values
 * shown reflect the active scope.
 *
 * Section/Tile buttons expand into popovers listing the 4 hub sections
 * and the registered tiles (grouped by section). Selection commits.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioScopeRibbon) return;

    const SECTIONS = [
        { id: "fleet",   label: "Fleet" },
        { id: "routes",  label: "Routes" },
        { id: "finance", label: "Finance" },
        { id: "tools",   label: "Tools" }
    ];

    function render(host) {
        host.textContent = "";
        const T = window.AESTokens;
        const store = window.AESCustomizationStore;
        if (!store) return;

        const wrap = document.createElement("div");
        wrap.style.cssText = [
            "display:flex",
            "padding:" + T.sp[2] + " " + T.sp[4],
            "background:" + T.color.bone2,
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "gap:" + T.sp[1],
            "align-items:center",
            "flex-wrap:wrap"
        ].join(";");

        const lbl = document.createElement("span");
        lbl.textContent = "SCOPE";
        lbl.style.cssText = [
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide2,
            "margin-right:" + T.sp[2]
        ].join(";");
        wrap.appendChild(lbl);

        const globalBtn = makeBtn(T, "Global", function () {
            store.setCurrentScope({ type: "global" });
        });
        const sectionBtn = makeBtn(T, "Section ▾", function (anchor) {
            openSectionPopover(T, anchor, store);
        });
        const tileBtn = makeBtn(T, "Tile ▾", function (anchor) {
            openTilePopover(T, anchor, store);
        });
        wrap.append(globalBtn, sectionBtn, tileBtn);

        const indicator = document.createElement("span");
        indicator.style.cssText = [
            "margin-left:auto",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "color:" + T.color.oxide2,
            "letter-spacing:" + T.track.mono
        ].join(";");
        wrap.appendChild(indicator);

        function paint() {
            const cur = store.getCurrentScope();
            paintBtn(T, globalBtn, cur.type === "global");
            paintBtn(T, sectionBtn, cur.type === "section");
            paintBtn(T, tileBtn, cur.type === "tile");
            indicator.textContent = describeScope(cur);
        }
        paint();
        store.subscribeScope(paint);

        host.appendChild(wrap);
    }

    function describeScope(scope) {
        if (!scope || scope.type === "global") return "EDITING ALL SURFACES";
        if (scope.type === "section") return "EDITING SECTION · " + scope.id.toUpperCase();
        if (scope.type === "tile")    return "EDITING TILE · " + scope.id.toUpperCase();
        return "";
    }

    function makeBtn(T, label, onClick) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = baseBtnStyle(T, false);
        b.addEventListener("click", function (e) {
            e.preventDefault();
            onClick(b);
        });
        return b;
    }

    function paintBtn(T, btn, active) {
        btn.style.cssText = baseBtnStyle(T, active);
    }

    function baseBtnStyle(T, active) {
        return [
            "padding:" + T.sp[1] + " " + T.sp[3],
            "border:" + T.geom.bw2 + " solid " + (active ? T.color.rust : T.color.oxide),
            "background:" + (active ? T.color.rust : T.color.bone),
            "color:" + (active ? T.color.bone : T.color.oxide),
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "font-weight:700",
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
    }

    let activePopover = null;
    function closePopover() {
        if (activePopover) { activePopover.remove(); activePopover = null; }
    }

    function openSectionPopover(T, anchor, store) {
        closePopover();
        const pop = anchoredPopover(T, anchor);
        for (const s of SECTIONS) {
            pop.appendChild(popoverItem(T, s.label, function () {
                store.setCurrentScope({ type: "section", id: s.id });
                closePopover();
            }));
        }
        document.body.appendChild(pop);
        activePopover = pop;
        installOutside(pop);
    }

    function openTilePopover(T, anchor, store) {
        closePopover();
        const pop = anchoredPopover(T, anchor);
        const reg = window.CentralHubTileRegistry;
        if (!reg) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding:" + T.sp[3] + ";color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.small;
            empty.textContent = "No tiles registered on this page.";
            pop.appendChild(empty);
            document.body.appendChild(pop);
            activePopover = pop;
            installOutside(pop);
            return;
        }
        const all = reg.all();
        // Group by section
        const bySection = {};
        for (const t of all) {
            (bySection[t.section] || (bySection[t.section] = [])).push(t);
        }
        for (const sec of SECTIONS) {
            const tiles = bySection[sec.id];
            if (!tiles || !tiles.length) continue;
            const groupHeader = document.createElement("div");
            groupHeader.textContent = sec.label.toUpperCase();
            groupHeader.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[3],
                "background:" + T.color.bone2,
                "color:" + T.color.oxide2,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.micro,
                "font-weight:700",
                "letter-spacing:" + T.track.caps,
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
            ].join(";");
            pop.appendChild(groupHeader);
            for (const t of tiles) {
                pop.appendChild(popoverItem(T, t.id, function () {
                    store.setCurrentScope({ type: "tile", id: t.id });
                    closePopover();
                }));
            }
        }
        document.body.appendChild(pop);
        activePopover = pop;
        installOutside(pop);
    }

    function anchoredPopover(T, anchor) {
        const rect = anchor.getBoundingClientRect();
        const pop = document.createElement("div");
        pop.setAttribute("data-aes-studio-popover", "1");
        pop.style.cssText = [
            "position:fixed",
            "left:" + Math.round(rect.left) + "px",
            "top:" + Math.round(rect.bottom + 4) + "px",
            "min-width:240px",
            "max-height:60vh",
            "overflow-y:auto",
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "z-index:" + window.AESTokens.z.popover,
            "font-family:" + T.font.display,
            "color:" + T.color.oxide,
            "box-shadow:4px 4px 0 " + T.color.oxide
        ].join(";");
        return pop;
    }

    function popoverItem(T, label, onClick) {
        const it = document.createElement("button");
        it.type = "button";
        it.textContent = label;
        it.style.cssText = [
            "display:block",
            "width:100%",
            "padding:" + T.sp[1] + " " + T.sp[3],
            "border:none",
            "background:transparent",
            "color:" + T.color.oxide,
            "text-align:left",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "cursor:pointer"
        ].join(";");
        it.addEventListener("mouseenter", function () {
            it.style.background = T.color.rust;
            it.style.color = T.color.bone;
        });
        it.addEventListener("mouseleave", function () {
            it.style.background = "transparent";
            it.style.color = T.color.oxide;
        });
        it.addEventListener("click", function (e) {
            e.preventDefault();
            onClick();
        });
        return it;
    }

    function installOutside(pop) {
        function outside(e) {
            if (!pop.contains(e.target)) {
                closePopover();
                document.removeEventListener("mousedown", outside, true);
            }
        }
        setTimeout(function () { document.addEventListener("mousedown", outside, true); }, 0);
    }

    window.AESStudioScopeRibbon = { render, closePopover };
})();
