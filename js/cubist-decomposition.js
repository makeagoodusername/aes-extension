/* ===========================================================
   AES "FACET" — js/cubist-decomposition.js
   CB5 — fractal drill-down behavior.

   Shift+click any .aes-facet inside an .aes-polyhedron to
   "shatter": each facet clones into a draggable panel inside a
   modal <dialog>. "× Compose" or Escape reassembles. Animation
   uses 140ms easing per phase; under prefers-reduced-motion the
   transition is replaced with an instant scatter.

   Universal — loaded in the foundation manifest block so every AS
   page with cubist polyhedra inherits the gesture. Plain modal
   fallback when <dialog> is unsupported (rare in MV3 Chromium).

   Public API (window.AESCubistDecomposition):
     attach()    — idempotent global listener install
     decompose(polyhedronEl) — programmatic open
     compose()   — programmatic close
   =========================================================== */

(function () {
    "use strict";

    if (typeof window === "undefined") { return; }
    if (window.AESCubistDecomposition) { return; }

    const DIALOG_ID = "aes-cubist-decomposition-dialog";
    const PHASE_MS  = 140;

    let _activeDialog = null;

    function _reducedMotion() {
        try {
            return window.matchMedia
                && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (_) { return false; }
    }

    function _findPolyhedron(target) {
        let el = target;
        while (el && el !== document.body && el !== document) {
            if (el.classList && el.classList.contains("aes-polyhedron")) return el;
            el = el.parentNode;
        }
        return null;
    }

    function _cubistActive() {
        try {
            return document.body && document.body.classList
                && document.body.classList.contains("aes-cubist");
        } catch (_) { return false; }
    }

    function attach() {
        if (window.__aesCubistDecompositionAttached) return;
        window.__aesCubistDecompositionAttached = true;

        document.addEventListener("click", function (e) {
            if (!e.shiftKey) return;
            if (!_cubistActive()) return;
            const poly = _findPolyhedron(e.target);
            if (!poly) return;
            e.preventDefault();
            e.stopPropagation();
            decompose(poly);
        }, true);

        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && _activeDialog) {
                e.preventDefault();
                compose();
            }
        });
    }

    function decompose(polyhedron) {
        if (_activeDialog) compose();
        if (!polyhedron || !polyhedron.querySelectorAll) return;

        const T = window.AESTokens;
        if (!T) return;

        const dialog = document.createElement("dialog");
        dialog.id = DIALOG_ID;
        dialog.className = "aes-cubist-dialog";
        dialog.style.cssText = [
            "border:" + T.geom.bw3 + " solid " + T.color.oxide,
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "padding:" + T.sp[4],
            "max-width:92vw",
            "max-height:92vh",
            "width:820px",
            "height:600px",
            "box-sizing:border-box",
            "font-family:" + T.font.display
        ].join(";");

        const header = document.createElement("div");
        header.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:center",
            "margin-bottom:" + T.sp[3],
            "padding-bottom:" + T.sp[2],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
        ].join(";");

        const title = document.createElement("h2");
        title.style.cssText = [
            "margin:0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide
        ].join(";");
        const entityLabel = polyhedron.dataset.entity || "polyhedron";
        title.textContent = "Decomposition · " + entityLabel;

        const composeBtn = document.createElement("button");
        composeBtn.type = "button";
        composeBtn.textContent = "× Compose";
        composeBtn.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-weight:" + T.fw.display,
            "font-size:" + T.fs.body,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";");
        composeBtn.addEventListener("click", compose);
        header.append(title, composeBtn);
        dialog.appendChild(header);

        const arena = document.createElement("div");
        arena.style.cssText = [
            "position:relative",
            "width:100%",
            "height:calc(100% - 56px)",
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "overflow:hidden",
            "box-sizing:border-box"
        ].join(";");
        dialog.appendChild(arena);

        const facets = Array.from(polyhedron.querySelectorAll(".aes-facet"));
        const reduced = _reducedMotion();
        const arenaW = 760, arenaH = 480;

        facets.forEach(function (src, i) {
            const clone = src.cloneNode(true);
            clone.classList.add("aes-decomposed-facet");
            clone.removeAttribute("aria-hidden");
            clone.style.cssText += [
                ";position:absolute",
                "width:220px",
                "min-height:130px",
                "padding:" + T.sp[3],
                "background:" + T.color.bone,
                "border:" + T.geom.bw2 + " solid " + T.color.oxide,
                "box-sizing:border-box",
                "cursor:grab",
                "user-select:none",
                "clip-path:none"
            ].join(";");

            // Spiral scatter — golden-angle so adjacent facets don't overlap.
            const angle = i * 137.508 * Math.PI / 180;
            const radius = 70 + i * 28;
            const cx = Math.max(8, Math.min(arenaW - 230, arenaW / 2 - 110 + Math.cos(angle) * radius));
            const cy = Math.max(8, Math.min(arenaH - 140, arenaH / 2 - 75  + Math.sin(angle) * radius));

            if (reduced) {
                clone.style.left = cx + "px";
                clone.style.top  = cy + "px";
            } else {
                clone.style.left = "0";
                clone.style.top  = "0";
                clone.style.transform = "translate(0, 0) scale(0.4)";
                clone.style.opacity = "0";
                clone.style.transition = "transform " + PHASE_MS + "ms ease-out, opacity "
                    + PHASE_MS + "ms ease-out";
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        clone.style.transform = "translate(" + cx + "px, " + cy + "px) scale(1)";
                        clone.style.opacity = "1";
                    });
                });
            }

            _attachDrag(clone);
            arena.appendChild(clone);
        });

        document.body.appendChild(dialog);
        try { dialog.showModal(); }
        catch (_) {
            // Fallback for environments without <dialog>.showModal.
            dialog.setAttribute("open", "");
            dialog.style.position = "fixed";
            dialog.style.left = "50%";
            dialog.style.top = "50%";
            dialog.style.transform = "translate(-50%, -50%)";
            dialog.style.zIndex = T.z.modal;
        }
        _activeDialog = dialog;

        dialog.addEventListener("click", function (e) {
            if (e.target === dialog) compose();
        });
    }

    function _attachDrag(panel) {
        let dragging = false;
        let startX = 0, startY = 0, originX = 0, originY = 0;

        function readTranslate() {
            const m = panel.style.transform && panel.style.transform.match(
                /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
            if (m) return {x: parseFloat(m[1]), y: parseFloat(m[2])};
            return {
                x: parseFloat(panel.style.left)  || 0,
                y: parseFloat(panel.style.top)   || 0
            };
        }

        panel.addEventListener("pointerdown", function (e) {
            const tag = e.target && e.target.tagName;
            if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT") return;
            dragging = true;
            panel.style.cursor = "grabbing";
            panel.style.transition = "none";
            startX = e.clientX;
            startY = e.clientY;
            const cur = readTranslate();
            originX = cur.x;
            originY = cur.y;
            panel.setPointerCapture && panel.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        panel.addEventListener("pointermove", function (e) {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.transform = "translate("
                + (originX + dx) + "px, " + (originY + dy) + "px) scale(1)";
        });
        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            panel.style.cursor = "grab";
            try { panel.releasePointerCapture && panel.releasePointerCapture(e.pointerId); }
            catch (_) {}
        }
        panel.addEventListener("pointerup",     endDrag);
        panel.addEventListener("pointercancel", endDrag);
    }

    function compose() {
        if (!_activeDialog) return;
        try { _activeDialog.close(); } catch (_) {}
        if (_activeDialog.parentNode) {
            _activeDialog.parentNode.removeChild(_activeDialog);
        }
        _activeDialog = null;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", attach, {once: true});
    } else {
        attach();
    }

    window.AESCubistDecomposition = {
        attach: attach,
        decompose: decompose,
        compose: compose
    };
})();
