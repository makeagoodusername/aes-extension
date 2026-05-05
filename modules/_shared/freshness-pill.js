"use strict";

/**
 * AES Shared — FreshnessPill.
 *
 * Canonical staleness indicator. Replaces the ad-hoc dots and "Xs ago"
 * fragments scattered across central-hub tiles, scrape-orchestrator
 * surfaces, and competitor intel. One vocabulary so cache age reads the
 * same in every panel.
 *
 *   const pill = window.AESFreshnessPill.mount(host, {ageMs, ttlMs})
 *   pill.update({ageMs: newAgeMs})
 *   pill.dispose()
 *
 * Coloring bands derive from {ageMs, ttlMs, error}:
 *   - error     → crimson, label uses provided text (e.g. "scrape failed")
 *   - fresh     → moss     (ageMs < 0.5 * ttlMs)
 *   - warm      → amber    (0.5 * ttlMs ≤ ageMs < ttlMs)
 *   - stale     → crimson  (ageMs ≥ ttlMs)
 *   - unknown   → slate    (no ageMs / ttlMs supplied)
 *
 * For diagnostic surfaces (e.g. site-skin coverage tab) where the band
 * is known explicitly (deep / thin / absent / current-page), pass
 * `depthBand` instead of {ageMs, ttlMs}; the pill skips the ageMs math
 * and just paints by the named band.
 *
 * ARIA: role="status" + aria-live="polite" + aria-label so screen readers
 * announce age without chrome dependency. The previous tile.js dot was
 * visual-only.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESFreshnessPill) return;

    function tokens() { return window.AESTokens; }

    function format(ageMs) {
        if (!isFinite(ageMs)) return "—";
        if (ageMs < 0)        return "just now";
        if (ageMs < 60_000)   return Math.max(1, Math.floor(ageMs / 1000)) + "s ago";
        if (ageMs < 3_600_000) return Math.floor(ageMs / 60_000) + "m ago";
        if (ageMs < 86_400_000) return Math.floor(ageMs / 3_600_000) + "h ago";
        return Math.floor(ageMs / 86_400_000) + "d ago";
    }

    function bandFor(opts) {
        const o = opts || {};
        if (o.error) return "error";
        if (typeof o.ageMs !== "number" || !isFinite(o.ageMs)) return "unknown";
        const ttl = (typeof o.ttlMs === "number" && isFinite(o.ttlMs) && o.ttlMs > 0) ? o.ttlMs : 0;
        if (!ttl) {
            // Without a TTL the pill can only show absolute age — assume warm
            // when explicitly marked stale, otherwise unknown.
            return o.stale ? "stale" : "unknown";
        }
        if (o.ageMs < ttl * 0.5) return "fresh";
        if (o.ageMs < ttl)       return "warm";
        return "stale";
    }

    function colorForBand(band) {
        const T = tokens() || {};
        const c = (T.color) || {};
        switch (band) {
            case "fresh":   return c.moss    || "currentColor";
            case "warm":    return c.amber   || "currentColor";
            case "stale":   return c.crimson || "currentColor";
            case "error":   return c.crimson || "currentColor";
            case "deep":    return c.moss    || "currentColor";
            case "thin":    return c.amber   || "currentColor";
            case "absent":  return c.slate   || "currentColor";
            case "current": return c.cobalt  || "currentColor";
            default:        return c.slate   || "currentColor";
        }
    }

    function labelFor(opts) {
        const o = opts || {};
        if (o.label) return String(o.label);
        if (o.error) return "Error";
        if (o.depthBand) {
            const map = {deep: "deep", thin: "thin", absent: "none", current: "current"};
            return map[o.depthBand] || String(o.depthBand);
        }
        if (typeof o.ageMs === "number" && isFinite(o.ageMs)) return format(o.ageMs);
        return "—";
    }

    function ariaLabelFor(opts, band) {
        const o = opts || {};
        if (o.ariaLabel) return String(o.ariaLabel);
        if (o.depthBand) return "Coverage: " + labelFor(o);
        if (band === "error") return "Data error" + (o.label ? " — " + o.label : "");
        const t = labelFor(o);
        if (band === "stale") return "Data is stale (" + t + ")";
        if (band === "warm")  return "Data getting stale (" + t + ")";
        return "Data age — " + t;
    }

    function applyStyle(el, opts, band) {
        const T = tokens() || {};
        const sp = T.sp || {};
        const dense = !!opts.dense;
        const padX = dense ? (sp[1] || "4px") : (sp[2] || "8px");
        const padY = "2px";
        el.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "gap:" + (sp[1] || "4px"),
            "padding:" + padY + " " + padX,
            "font-family:" + (T.font && T.font.mono ? T.font.mono : "monospace"),
            "font-size:" + (T.fs && T.fs.micro ? T.fs.micro : "10px"),
            "letter-spacing:" + (T.track && T.track.mono ? T.track.mono : "0.02em"),
            "color:" + colorForBand(band),
            "border:1px solid " + colorForBand(band),
            "background:transparent",
            "border-radius:" + (T.geom && T.geom.radius ? T.geom.radius : "0"),
            "vertical-align:middle",
            "white-space:nowrap",
            "line-height:1"
        ].join(";");
    }

    function buildDot(color) {
        const dot = document.createElement("span");
        dot.style.cssText = [
            "display:inline-block",
            "width:6px",
            "height:6px",
            "border-radius:50%",
            "background:" + color,
            "flex:0 0 auto"
        ].join(";");
        return dot;
    }

    function mount(host, initial) {
        if (!host) return null;
        let opts = Object.assign({}, initial || {});
        let band = opts.depthBand || bandFor(opts);

        const root = document.createElement("span");
        root.className = "aes-freshness-pill";
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", "polite");
        root.setAttribute("aria-label", ariaLabelFor(opts, band));

        const dot = buildDot(colorForBand(band));
        const text = document.createElement("span");
        text.textContent = labelFor(opts);

        let refreshBtn = null;

        function repaint() {
            band = opts.depthBand || bandFor(opts);
            applyStyle(root, opts, band);
            dot.style.background = colorForBand(band);
            text.textContent = labelFor(opts);
            root.setAttribute("aria-label", ariaLabelFor(opts, band));
            root.title = root.getAttribute("aria-label");
        }

        function ensureRefreshButton() {
            if (refreshBtn || typeof opts.onRefresh !== "function") return;
            refreshBtn = document.createElement("button");
            refreshBtn.type = "button";
            refreshBtn.textContent = "↻";
            refreshBtn.setAttribute("aria-label", "Refresh");
            const T = tokens() || {};
            refreshBtn.style.cssText = [
                "border:none",
                "background:transparent",
                "color:inherit",
                "cursor:pointer",
                "font-family:" + (T.font && T.font.mono ? T.font.mono : "monospace"),
                "font-size:" + (T.fs && T.fs.micro ? T.fs.micro : "10px"),
                "padding:0",
                "margin-left:" + ((T.sp && T.sp[1]) || "4px"),
                "line-height:1"
            ].join(";");
            refreshBtn.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                try { opts.onRefresh(); } catch (_) {}
            });
            root.appendChild(refreshBtn);
        }

        applyStyle(root, opts, band);
        root.appendChild(dot);
        root.appendChild(text);
        ensureRefreshButton();
        root.title = root.getAttribute("aria-label");

        host.appendChild(root);

        return {
            el: root,
            update(next) {
                opts = Object.assign({}, opts, next || {});
                ensureRefreshButton();
                repaint();
            },
            dispose() {
                if (root.parentNode) root.parentNode.removeChild(root);
            }
        };
    }

    window.AESFreshnessPill = {mount, format, bandFor, colorForBand};
})();
