/* ===========================================================
   AES "FACET" — js/cubist-primitives.js
   DOM builder functions for the Cubist visual vocabulary.

   Five primitives: Facet, Polyhedron, GhostLayer, Stencil,
   Composition. Each is a pure DOM constructor — no I/O, no
   storage reads, no event listeners except those passed in by
   the caller. Safe to call from a render loop (§4.7 invariant).

   Foundation slice CB0: these primitives ship but no AES surface
   uses them yet. CB1+ wire them into hero-strip, route-cards,
   flight-studio sidebar, etc. Devtools-callable for early
   exploration: AESCubistPrimitives.Facet({shape:"wedge-tl"}).
   =========================================================== */

(function () {
    "use strict";

    if (typeof window === "undefined") { return; }
    if (window.AESCubistPrimitives) { return; }

    const SHAPES = [
        "wedge-tl", "wedge-tr", "wedge-bl", "wedge-br",
        "pentagon-r", "pentagon-l", "pentagon-t", "pentagon-b",
        "lozenge-c", "trapezoid-t", "trapezoid-b", "rect"
    ];

    function _isShape(s) { return SHAPES.indexOf(s) >= 0; }

    function _safeAppend(parent, child) {
        if (!parent || !child) return;
        if (typeof child === "string") {
            parent.appendChild(document.createTextNode(child));
        } else if (child.nodeType) {
            parent.appendChild(child);
        }
    }

    function _applyClassNames(el, className) {
        if (!className) return;
        if (Array.isArray(className)) {
            for (const c of className) { if (c) el.classList.add(c); }
        } else {
            for (const c of String(className).split(/\s+/)) {
                if (c) el.classList.add(c);
            }
        }
    }

    /**
     * Facet — a flat-tinted polygonal region.
     *
     * @param {object} opts
     * @param {string} opts.shape       One of SHAPES; defaults to "rect".
     * @param {string} opts.fill        CSS color (token ref or literal). Optional.
     * @param {string} opts.perspective Semantic label (demand, profit, ors…).
     *                                  Used as data-perspective + ARIA.
     * @param {string|Node} opts.content Child content.
     * @param {string} opts.label       Optional aria-label override.
     * @param {string|string[]} opts.className Additional classes.
     * @returns {HTMLElement} a <div class="aes-facet" data-shape=…>
     */
    function Facet(opts) {
        const o = opts || {};
        const shape = _isShape(o.shape) ? o.shape : "rect";

        const el = document.createElement("div");
        el.className = "aes-facet";
        el.dataset.shape = shape;
        if (o.perspective) el.dataset.perspective = String(o.perspective);

        const aria = o.label || o.perspective;
        if (aria) el.setAttribute("aria-label", String(aria));
        el.setAttribute("role", "group");
        // CB6 — facets are keyboard-focusable; cubist-a11y.js wires
        // arrow-key spatial navigation between siblings.
        el.setAttribute("tabindex", "0");

        if (o.fill) el.style.background = o.fill;
        _applyClassNames(el, o.className);
        _safeAppend(el, o.content);
        return el;
    }

    /**
     * Polyhedron — composition of 3–7 facets joined at angles to render
     * one entity from multiple perspectives.
     *
     * @param {object} opts
     * @param {string} opts.entity   Semantic id of the entity ("route:JFK-EZE").
     * @param {Node[]} opts.facets   Pre-built facet nodes (use Facet()).
     * @param {boolean} opts.pivot   Enable rotateY hover. Defaults true.
     * @param {string} opts.density  "compact" | "standard" | "expanded".
     * @param {string} opts.layout   CSS grid-template shorthand. Optional;
     *                               default lets cubist.css decide.
     * @param {string|string[]} opts.className Additional classes.
     * @returns {HTMLElement} a <div class="aes-polyhedron">
     */
    function Polyhedron(opts) {
        const o = opts || {};
        const facets = Array.isArray(o.facets) ? o.facets : [];

        const el = document.createElement("div");
        el.className = "aes-polyhedron";
        if (o.entity)  el.dataset.entity  = String(o.entity);
        if (o.density) el.dataset.density = String(o.density);
        el.dataset.pivot = (o.pivot === false) ? "off" : "on";

        if (o.layout) el.style.gridTemplate = o.layout;

        _applyClassNames(el, o.className);
        for (const f of facets) _safeAppend(el, f);
        return el;
    }

    /**
     * GhostLayer — wraps a body node with past + present + forecast layers
     * offset so each peeks out from behind the others. Past is a sepia
     * ghost; forecast is a wireframe stroke; present is opaque.
     *
     * Past/forecast nodes are clones of `present` by default; pass
     * explicit `past` / `forecast` to render different content per layer.
     *
     * @param {object} opts
     * @param {Node} opts.present   Required — the opaque "today" node.
     * @param {Node} opts.past      Optional — yesterday's node. Cloned from present if omitted.
     * @param {Node} opts.forecast  Optional — tomorrow's node. Cloned from present if omitted.
     * @param {string|string[]} opts.className Additional classes.
     * @returns {HTMLElement} a <div class="aes-ghost-layer">
     */
    function GhostLayer(opts) {
        const o = opts || {};
        if (!o.present || !o.present.nodeType) {
            throw new Error("GhostLayer: opts.present is required");
        }

        const el = document.createElement("div");
        el.className = "aes-ghost-layer";
        _applyClassNames(el, o.className);

        const past = (o.past && o.past.nodeType) ? o.past : o.present.cloneNode(true);
        past.classList.add("aes-ghost-past");
        past.setAttribute("aria-hidden", "true");
        el.appendChild(past);

        const forecast = (o.forecast && o.forecast.nodeType) ? o.forecast : o.present.cloneNode(true);
        forecast.classList.add("aes-ghost-forecast");
        forecast.setAttribute("aria-hidden", "true");
        el.appendChild(forecast);

        const present = o.present;
        present.classList.add("aes-ghost-present");
        el.appendChild(present);

        return el;
    }

    /**
     * Stencil — typographic label using a stroke + filled wedge background,
     * mimicking synthetic-cubism pasted-paper. Optional second word renders
     * in light weight for collage juxtaposition.
     *
     * @param {object} opts
     * @param {string} opts.text     Primary text (rendered black-weight).
     * @param {string} opts.subtext  Optional secondary text (rendered light).
     * @param {string|string[]} opts.className
     * @returns {HTMLElement} a <span class="aes-stencil">
     */
    function Stencil(opts) {
        const o = opts || {};
        const el = document.createElement("span");
        el.className = "aes-stencil";
        _applyClassNames(el, o.className);

        if (o.text) {
            const heavy = document.createElement("span");
            heavy.textContent = String(o.text);
            el.appendChild(heavy);
        }
        if (o.subtext) {
            const light = document.createElement("span");
            light.className = "aes-stencil-light";
            light.textContent = " " + String(o.subtext);
            el.appendChild(light);
        }
        return el;
    }

    /**
     * Composition — page-level layout primitive. Wraps children in an
     * asymmetric grid using one of three presets. Reverts to orthogonal
     * single-column layout below 1200px (cubist.css media query).
     *
     * @param {object} opts
     * @param {string} opts.preset   "totem" | "landscape" | "still-life".
     * @param {Node[]} opts.children
     * @param {string|string[]} opts.className
     * @returns {HTMLElement} a <section class="aes-composition">
     */
    function Composition(opts) {
        const o = opts || {};
        const presets = ["totem", "landscape", "still-life"];
        const preset = presets.indexOf(o.preset) >= 0 ? o.preset : "totem";

        const el = document.createElement("section");
        el.className = "aes-composition";
        el.dataset.preset = preset;
        _applyClassNames(el, o.className);

        const children = Array.isArray(o.children) ? o.children : [];
        for (const c of children) _safeAppend(el, c);
        return el;
    }

    window.AESCubistPrimitives = {
        Facet:       Facet,
        Polyhedron:  Polyhedron,
        GhostLayer:  GhostLayer,
        Stencil:     Stencil,
        Composition: Composition,
        SHAPES:      SHAPES.slice()
    };
})();
