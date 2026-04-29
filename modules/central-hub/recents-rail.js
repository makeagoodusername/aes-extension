"use strict";

/**
 * Central Hub Recents Rail.
 *
 * Renders a horizontal "Recent" strip at the top of the dashboard
 * main pane, showing the last 5 expanded/interacted tiles. Clicking
 * a recent chip emits open-tile via CentralHubBus, which the shell's
 * existing handler picks up to activate the section, scroll, and
 * expand.
 *
 * Storage: reads centralHub.settings.recentTiles (additive ring buffer
 * cap 5; settings-store seeds default []). The shell pushes to this
 * ring inside _onTileToggle when isExpanded is true.
 *
 * Mount: shell.js calls CentralHubRecentsRail.mount(mainEl) once after
 * building section containers and before scrolling to active section.
 */
class CentralHubRecentsRail {
    static MAX = 5;

    static async mount(parent) {
        if (!parent || typeof parent.appendChild !== "function") return null;
        if (typeof window === "undefined") return null;
        if (!window.CentralHubSettings || !window.CentralHubBus) return null;

        const T = window.AESTokens;
        const settings = await window.CentralHubSettings.load();
        const recents = Array.isArray(settings.recentTiles) ? settings.recentTiles.slice(0, this.MAX) : [];

        const wrap = document.createElement("section");
        wrap.id = "aes-central-hub-recents";
        wrap.style.cssText = [
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "margin-bottom:" + T.sp[3],
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[3]
        ].join(";");

        const label = document.createElement("div");
        label.textContent = "RECENT";
        label.style.cssText = [
            "font-family:" + T.font.display,
            "font-weight:" + T.fw.display,
            "font-size:" + T.fs.small,
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate,
            "flex:0 0 auto"
        ].join(";");
        wrap.appendChild(label);

        const chips = document.createElement("div");
        chips.style.cssText = "display:flex;gap:" + T.sp[1] + ";flex:1 1 auto;flex-wrap:wrap";
        wrap.appendChild(chips);

        function paint(ids) {
            chips.textContent = "";
            if (!ids.length) {
                const empty = document.createElement("span");
                empty.textContent = "No tiles touched yet — open one to start.";
                empty.style.cssText = [
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.small,
                    "color:" + T.color.slate,
                    "font-style:italic"
                ].join(";");
                chips.appendChild(empty);
                return;
            }
            for (const id of ids) chips.appendChild(chip(T, id));
        }

        function chip(T, tileId) {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.tileId = tileId;
            b.textContent = formatLabel(tileId);
            b.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "background:" + T.color.bone,
                "color:" + T.color.oxide,
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "letter-spacing:" + T.track.caps,
                "text-transform:uppercase",
                "cursor:pointer"
            ].join(";");
            b.addEventListener("click", function (e) {
                e.preventDefault();
                window.CentralHubBus.emit("open-tile", {
                    tileId: tileId,
                    expand: true,
                    scrollIntoView: true,
                    source: "recents-rail"
                });
            });
            return b;
        }

        function formatLabel(id) {
            const stripped = String(id || "").replace(/-tile$/, "");
            const words = stripped.split("-").filter(Boolean);
            return words.map(function (w) {
                return w.charAt(0).toUpperCase() + w.slice(1);
            }).join(" ");
        }

        paint(recents);

        if (chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return;
                if (!changes[window.CentralHubSettings.KEY]) return;
                const next = changes[window.CentralHubSettings.KEY].newValue || {};
                const ids = Array.isArray(next.recentTiles) ? next.recentTiles.slice(0, CentralHubRecentsRail.MAX) : [];
                paint(ids);
            });
        }

        parent.appendChild(wrap);
        return wrap;
    }

    /**
     * Helper called by shell.js to push a tile id onto the recents ring
     * buffer. Idempotent — moves existing entries to the front.
     */
    static pushRecent(settings, tileId) {
        if (!settings || !tileId) return;
        const cur = Array.isArray(settings.recentTiles) ? settings.recentTiles : [];
        const filtered = cur.filter(function (id) { return id !== tileId; });
        filtered.unshift(tileId);
        if (filtered.length > this.MAX) filtered.length = this.MAX;
        settings.recentTiles = filtered;
    }
}

if (typeof window !== "undefined") {
    window.CentralHubRecentsRail = CentralHubRecentsRail;
}
