"use strict";

/**
 * Central Hub Tile Pin Affordance.
 *
 * Renders a small pin-glyph button that toggles tile membership in
 * centralHub.settings.pinnedTiles. Pinned tiles sort to the top of
 * their section, regardless of priority.
 *
 * Critical: the button uses class `aes-central-hub-tile__pin`, which
 * the tile header click handler must bypass (see tile.js:144). The
 * button itself also calls e.stopPropagation() as belt-and-braces so
 * a click never accidentally toggles the tile expansion.
 *
 * Storage: the pinnedTiles array already exists in settings-store.js
 * defaults (line 26). This affordance only writes — the shell reads
 * elsewhere when sorting tiles for display.
 */
class AesTilePin {
    /**
     * Build a pin button for the given tile id.
     * Caller mounts the result wherever it likes (typically in the
     * tile header's actions row, prepended before the toggle button).
     */
    static build(tileId) {
        if (typeof window === "undefined") return null;
        const T = window.AESTokens;
        if (!T) return null;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "aes-central-hub-tile__pin";
        btn.dataset.tileId = tileId;
        btn.title = "Pin this tile";
        btn.style.cssText = [
            "background:transparent",
            "color:" + T.color.slate,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:0 " + T.sp[2],
            "min-width:24px",
            "height:22px",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "cursor:pointer",
            "transition:color 80ms linear, border-color 80ms linear"
        ].join(";");

        async function paint() {
            const state = await AesTilePin.stateFor(tileId);
            // Glyphs: ☆ none / ★ pinned / ⮞ pinned-full-width.
            // The full-width glyph deliberately reads as "expand" so the
            // user understands long-press is *more* than a normal pin.
            if (state === "full") {
                btn.textContent = "⮞";
                btn.title = "Pinned full-width — long-press / shift-click to clear";
                btn.style.color = T.color.cobalt;
                btn.style.borderColor = T.color.cobalt;
            } else if (state === "pinned") {
                btn.textContent = "★";
                btn.title = "Pinned — click to unpin · long-press / shift-click to pin full-width";
                btn.style.color = T.color.rust;
                btn.style.borderColor = T.color.rust;
            } else {
                btn.textContent = "☆";
                btn.title = "Pin tile · long-press / shift-click to cycle to full-width";
                btn.style.color = T.color.slate;
                btn.style.borderColor = T.color.paperRule;
            }
        }

        // CH-W4 — cycle: none → pinned → pinned-full-width → none.
        // Click advances by one step; long-press (>500ms) advances by
        // two steps (jumps to full-width / clears full-width directly).
        // Shift+click also advances by two steps as a keyboard alternative.
        let pressTimer = null;
        let suppressClick = false;
        const advance = (jumpTwo) => {
            AesTilePin.cycle(tileId, jumpTwo).then(paint);
        };
        btn.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return; // only left-click
            pressTimer = setTimeout(function () {
                suppressClick = true;
                advance(true);
            }, 500);
        });
        const cancelLongPress = () => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        };
        btn.addEventListener("mouseup", cancelLongPress);
        btn.addEventListener("mouseleave", cancelLongPress);
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();   // do not let the header click-to-toggle catch this
            if (suppressClick) { suppressClick = false; return; }
            advance(!!e.shiftKey);
        });

        paint();

        if (chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return;
                if (!changes[window.CentralHubSettings.KEY]) return;
                paint();
            });
        }

        return btn;
    }

    /**
     * CH-W4 — return the user's current pin state for the tile:
     *   "full"   → present in pinnedFullWidthTiles
     *   "pinned" → present only in pinnedTiles
     *   "none"   → in neither
     *
     * pinnedFullWidthTiles is layered above pinnedTiles. A tile in the
     * full set is implicitly considered pinned even if pinnedTiles[]
     * doesn't carry it (defensive — cycle() keeps both lists consistent
     * but legacy data may diverge).
     */
    static async stateFor(tileId) {
        if (!window.CentralHubSettings) return "none";
        const settings = await window.CentralHubSettings.load();
        const full = Array.isArray(settings.pinnedFullWidthTiles)
            ? settings.pinnedFullWidthTiles : [];
        if (full.indexOf(tileId) >= 0) return "full";
        const pinned = Array.isArray(settings.pinnedTiles) ? settings.pinnedTiles : [];
        if (pinned.indexOf(tileId) >= 0) return "pinned";
        return "none";
    }

    /**
     * CH-W4 — advance the cycle by 1 (default) or 2 steps. Both
     * pinnedTiles[] and pinnedFullWidthTiles[] are updated in a single
     * patch so observers fire once.
     */
    static async cycle(tileId, jumpTwo) {
        if (!window.CentralHubSettings) return;
        const cur = await AesTilePin.stateFor(tileId);
        const next = AesTilePin._nextState(cur, jumpTwo === true);
        const settings = await window.CentralHubSettings.load();
        const pinned = Array.isArray(settings.pinnedTiles) ? settings.pinnedTiles.slice() : [];
        const full   = Array.isArray(settings.pinnedFullWidthTiles)
            ? settings.pinnedFullWidthTiles.slice() : [];
        const dropFrom = (arr) => {
            const i = arr.indexOf(tileId);
            if (i >= 0) arr.splice(i, 1);
        };
        const ensureIn = (arr) => {
            if (arr.indexOf(tileId) < 0) arr.unshift(tileId);
        };
        if (next === "none") {
            dropFrom(pinned);
            dropFrom(full);
        } else if (next === "pinned") {
            ensureIn(pinned);
            dropFrom(full);
        } else {
            ensureIn(pinned);
            ensureIn(full);
        }
        await window.CentralHubSettings.patch({
            pinnedTiles:          pinned,
            pinnedFullWidthTiles: full
        });
        if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
            window.CentralHubBus.emit("tile-pin-changed", {tileId: tileId, state: next});
        }
    }

    static _nextState(cur, jumpTwo) {
        const order = ["none", "pinned", "full"];
        const i = order.indexOf(cur);
        const step = jumpTwo ? 2 : 1;
        return order[((i < 0 ? 0 : i) + step) % order.length];
    }

    static async isPinned(tileId) {
        if (!window.CentralHubSettings) return false;
        const settings = await window.CentralHubSettings.load();
        return Array.isArray(settings.pinnedTiles) && settings.pinnedTiles.indexOf(tileId) >= 0;
    }

    static async toggle(tileId) {
        if (!window.CentralHubSettings) return;
        const settings = await window.CentralHubSettings.load();
        const cur = Array.isArray(settings.pinnedTiles) ? settings.pinnedTiles.slice() : [];
        const idx = cur.indexOf(tileId);
        if (idx >= 0) cur.splice(idx, 1);
        else cur.unshift(tileId);
        await window.CentralHubSettings.patch({ pinnedTiles: cur });
        if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
            window.CentralHubBus.emit(idx >= 0 ? "tile-unpinned" : "tile-pinned", { tileId: tileId });
        }
    }
}

if (typeof window !== "undefined") {
    window.AesTilePin = AesTilePin;
}
