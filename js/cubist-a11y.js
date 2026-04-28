/* ===========================================================
   AES "FACET" — js/cubist-a11y.js
   CB6 — polish: keyboard navigation and setting-driven body
   data-attribute toggles for motion + color-blind patterns.

   Keyboard:
     Tab        — cycles between facets (each .aes-facet is tabbable)
     Arrow ←→↑↓ — move focus to spatially-nearest sibling facet
                  within the same .aes-polyhedron
     Enter      — fires click on the focused facet
     Shift+Enter — triggers decompose (cubist-decomposition.js handles)

   Settings reflected to body data attributes:
     cubistMotion: "on"  | "off"  → body[data-aes-motion]
     cubistColorBlind: bool        → body[data-aes-cb-patterns]
   Both read from chrome.storage.local key "centralHub:settings"
   and re-applied on storage change.

   Universal — loaded in the foundation manifest block.
   =========================================================== */

(function () {
    "use strict";

    if (typeof window === "undefined") { return; }
    if (window.AESCubistA11y) { return; }

    const KEY = "centralHub:settings";

    function _facetTabable(el) {
        return el && el.classList && el.classList.contains("aes-facet");
    }

    function _siblings(facet) {
        const poly = facet.parentNode;
        if (!poly) return [];
        return Array.from(poly.querySelectorAll(":scope > .aes-facet"));
    }

    function _rect(el) {
        try { return el.getBoundingClientRect(); }
        catch (_) { return {left:0, top:0, right:0, bottom:0, width:0, height:0}; }
    }

    function _spatialNeighbor(current, direction) {
        const sibs = _siblings(current).filter(s => s !== current);
        if (!sibs.length) return null;
        const c = _rect(current);
        const cx = c.left + c.width / 2;
        const cy = c.top  + c.height / 2;

        let best = null;
        let bestScore = Infinity;
        for (const s of sibs) {
            const r = _rect(s);
            const sx = r.left + r.width / 2;
            const sy = r.top  + r.height / 2;
            const dx = sx - cx;
            const dy = sy - cy;
            let aligned = false;
            switch (direction) {
                case "left":  aligned = dx < -2; break;
                case "right": aligned = dx >  2; break;
                case "up":    aligned = dy < -2; break;
                case "down":  aligned = dy >  2; break;
            }
            if (!aligned) continue;
            // Prefer siblings closest to the perpendicular axis.
            const perp = (direction === "left" || direction === "right")
                ? Math.abs(dy) : Math.abs(dx);
            const along = (direction === "left" || direction === "right")
                ? Math.abs(dx) : Math.abs(dy);
            const score = along + perp * 2;
            if (score < bestScore) { bestScore = score; best = s; }
        }
        return best;
    }

    function _onKeyDown(e) {
        const t = e.target;
        if (!_facetTabable(t)) return;

        if (e.key === "Enter") {
            e.preventDefault();
            try { t.click(); } catch (_) {}
            return;
        }

        let dir = null;
        switch (e.key) {
            case "ArrowLeft":  dir = "left";  break;
            case "ArrowRight": dir = "right"; break;
            case "ArrowUp":    dir = "up";    break;
            case "ArrowDown":  dir = "down";  break;
        }
        if (!dir) return;
        const next = _spatialNeighbor(t, dir);
        if (next) {
            e.preventDefault();
            try { next.focus(); } catch (_) {}
        }
    }

    function _ensureFacetTabIndex(root) {
        if (!root || !root.querySelectorAll) return;
        const facets = root.querySelectorAll(".aes-facet");
        for (const f of facets) {
            if (!f.hasAttribute("tabindex")) f.setAttribute("tabindex", "0");
        }
    }

    function _attach() {
        if (window.__aesCubistA11yAttached) return;
        window.__aesCubistA11yAttached = true;
        document.addEventListener("keydown", _onKeyDown);

        // Walk existing facets and assign tabindex; observe new ones via
        // a coarse MutationObserver to avoid hand-wiring every renderer.
        _ensureFacetTabIndex(document.body);
        try {
            const obs = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType !== 1) continue;
                        if (n.classList && n.classList.contains("aes-facet")
                            && !n.hasAttribute("tabindex")) {
                            n.setAttribute("tabindex", "0");
                        }
                        _ensureFacetTabIndex(n);
                    }
                }
            });
            obs.observe(document.body, {childList: true, subtree: true});
        } catch (_) { /* no MutationObserver — graceful degrade */ }
    }

    // ── Setting-driven body attributes ───────────────────────────────────

    function _applySettings(s) {
        try {
            if (!document.body) return;
            const motion = (s && s.cubistMotion === "off") ? "off" : "on";
            document.body.setAttribute("data-aes-motion", motion);
            const cbOn = !!(s && s.cubistColorBlind);
            if (cbOn) document.body.setAttribute("data-aes-cb-patterns", "on");
            else      document.body.removeAttribute("data-aes-cb-patterns");
        } catch (_) { /* noop */ }
    }

    function _readAndApply() {
        if (typeof chrome === "undefined" || !chrome.storage) return;
        chrome.storage.local.get([KEY], function (blob) {
            _applySettings(blob && blob[KEY]);
        });
    }

    function _bootstrap() {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () {
                _attach();
                _readAndApply();
            }, {once: true});
        } else {
            _attach();
            _readAndApply();
        }

        try {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return;
                if (!changes[KEY]) return;
                _applySettings(changes[KEY].newValue);
            });
        } catch (_) { /* noop */ }
    }

    _bootstrap();

    window.AESCubistA11y = {
        attach:        _attach,
        applySettings: _applySettings,
        spatialNeighbor: _spatialNeighbor
    };
})();
