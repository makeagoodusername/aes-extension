"use strict";

/**
 * Unified Settings — Data tab.
 *
 * Storage-usage display + Export/Import via the customization
 * preset-codec. Inspector deep dive lives at chrome-extension://options.html;
 * this tab is the at-a-glance status + quick-action surface.
 */
(function () {
    if (typeof window === "undefined") return;
    window.AesUnifiedSettingsTabs = window.AesUnifiedSettingsTabs || {};
    if (window.AesUnifiedSettingsTabs.data) return;

    function fmtBytes(n) {
        if (!n || n < 1024) return (n || 0) + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / 1048576).toFixed(2) + " MB";
    }

    function render(host) {
        if (!host) return;
        host.textContent = "";

        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:18px 20px;display:flex;flex-direction:column;gap:14px";

        // Storage usage card
        const usageCard = section("Storage usage");
        const usageTxt = document.createElement("div");
        usageTxt.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:12px;color:#2B2520";
        usageTxt.textContent = "Loading…";
        usageCard.appendChild(usageTxt);

        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
                && typeof chrome.storage.local.getBytesInUse === "function") {
            chrome.storage.local.getBytesInUse(null, function (bytes) {
                const pct = Math.round((bytes / (10 * 1024 * 1024)) * 1000) / 10;
                usageTxt.textContent = "local: " + fmtBytes(bytes) + " of 10 MB  ·  " + pct + "%";
            });
        } else {
            usageTxt.textContent = "(storage API unavailable in this context)";
        }
        wrap.appendChild(usageCard);

        // Export / Import card
        const ioCard = section("Export / Import");
        const blurb = document.createElement("div");
        blurb.style.cssText = "font-size:11px;color:#5A4F45;line-height:1.5;margin-bottom:8px";
        blurb.textContent = "Customization presets and overrides round-trip through JSON bundles.";
        ioCard.appendChild(blurb);

        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px";
        row.appendChild(actionBtn("Export bundle", function () {
            const codec = window.AESPresetCodec;
            if (codec && typeof codec.exportBundle === "function") {
                try { codec.exportBundle(); }
                catch (e) { console && console.warn && console.warn("[unified-settings export]", e); }
            }
        }, !window.AESPresetCodec));
        row.appendChild(actionBtn("Import bundle", function () {
            const codec = window.AESPresetCodec;
            if (codec && typeof codec.importBundlePrompt === "function") {
                try { codec.importBundlePrompt(); }
                catch (e) { console && console.warn && console.warn("[unified-settings import]", e); }
            }
        }, !(window.AESPresetCodec
            && typeof window.AESPresetCodec.importBundlePrompt === "function")));
        ioCard.appendChild(row);
        wrap.appendChild(ioCard);

        // Options page link
        const optsCard = section("Data inspector");
        const link = actionBtn("Open options page →", function () {
            if (typeof chrome !== "undefined" && chrome.runtime) {
                try { chrome.runtime.openOptionsPage(); }
                catch (_) { window.open(chrome.runtime.getURL("options.html"), "_blank"); }
            }
        });
        optsCard.appendChild(link);
        wrap.appendChild(optsCard);

        host.appendChild(wrap);
    }

    function section(title) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:14px 16px;border:2px solid #2B2520;background:#F4F1EA;box-shadow:4px 4px 0 #2B2520";
        const h = document.createElement("div");
        h.textContent = title.toUpperCase();
        h.style.cssText = "font-weight:800;font-size:11px;letter-spacing:0.08em;color:#2B2520;margin-bottom:8px";
        wrap.appendChild(h);
        return wrap;
    }

    function actionBtn(label, onClick, disabled) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.cssText = [
            "border:1px solid #2B2520",
            "background:#2B2520",
            "color:#F4F1EA",
            "padding:6px 12px",
            "font-family:inherit",
            "font-size:11px",
            "font-weight:700",
            "letter-spacing:0.06em",
            "cursor:pointer"
        ].join(";");
        if (disabled) {
            btn.disabled = true;
            btn.style.opacity = "0.4";
        } else {
            btn.addEventListener("click", onClick);
        }
        return btn;
    }

    window.AesUnifiedSettingsTabs.data = { render: render };
})();
