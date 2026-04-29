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
            const pinned = await AesTilePin.isPinned(tileId);
            btn.textContent = pinned ? "★" : "☆";
            btn.title = pinned ? "Unpin tile" : "Pin tile";
            btn.style.color = pinned ? T.color.rust : T.color.slate;
            btn.style.borderColor = pinned ? T.color.rust : T.color.paperRule;
        }

        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();   // do not let the header click-to-toggle catch this
            AesTilePin.toggle(tileId).then(paint);
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
