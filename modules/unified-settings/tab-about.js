"use strict";

/**
 * Unified Settings — About tab.
 *
 * Version pulled from chrome.runtime.getManifest(). Plain text — links
 * are mounted only if chrome.runtime is available so the same code path
 * works inside content scripts and ad-hoc browser pages.
 */
(function () {
    if (typeof window === "undefined") return;
    window.AesUnifiedSettingsTabs = window.AesUnifiedSettingsTabs || {};
    if (window.AesUnifiedSettingsTabs.about) return;

    function render(host) {
        if (!host) return;
        host.textContent = "";

        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:24px 22px;display:flex;flex-direction:column;gap:14px;max-width:520px";

        const title = document.createElement("div");
        title.textContent = "AIRLINESIM ENHANCEMENT SUITE";
        title.style.cssText = "font-weight:800;font-size:14px;letter-spacing:0.08em;color:#2B2520";
        wrap.appendChild(title);

        let version = "";
        try {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) {
                const m = chrome.runtime.getManifest();
                version = (m && m.version) ? String(m.version) : "";
            }
        } catch (_) {}
        const ver = document.createElement("div");
        ver.textContent = version ? ("Version " + version) : "Version unavailable";
        ver.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:12px;color:#5A4F45";
        wrap.appendChild(ver);

        const blurb = document.createElement("p");
        blurb.style.cssText = "font-size:12px;line-height:1.6;color:#2B2520;margin:0";
        blurb.textContent = "Vanilla-JS Chrome extension for the AirlineSim browser game. Customisation, hub navigation, route assistance, fleet planning, and strategic tooling.";
        wrap.appendChild(blurb);

        const note = document.createElement("div");
        note.style.cssText = "font-size:11px;color:#7A6F66;line-height:1.5;border-top:1px solid #C9C0B0;padding-top:10px;margin-top:6px";
        note.textContent = "All settings persist to chrome.storage.local. No telemetry, no remote calls, no dependencies.";
        wrap.appendChild(note);

        host.appendChild(wrap);
    }

    window.AesUnifiedSettingsTabs.about = { render: render };
})();
