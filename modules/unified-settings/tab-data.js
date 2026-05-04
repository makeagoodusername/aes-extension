"use strict";

/**
 * Unified Settings — Data tab.
 *
 * Storage-usage display + Export/Import via the customization
 * preset-codec, plus an inline Data Inspector that mirrors the
 * legacy options.html surface (accounts registry + snapshot
 * summary). The legacy options page used to be opened from this
 * tab, which broke the modal context (FIX-A4-2). The inspector
 * is now rendered inline so the unified modal remains the single
 * settings surface.
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

    function fmtDate(ms) {
        if (!ms) return "—";
        try {
            return new Date(ms).toISOString().slice(0, 10);
        } catch (_) {
            return "—";
        }
    }

    function render(host) {
        if (!host) return;
        host.textContent = "";

        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:18px 20px;display:flex;flex-direction:column;gap:14px";

        // Storage usage card
        const usageCard = section("Storage usage");
        const usageTxt = document.createElement("div");
        usageTxt.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--aes-oxide)";
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
        blurb.style.cssText = "font-size:11px;color:var(--aes-oxide-2);line-height:1.5;margin-bottom:8px";
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

        // Inline Data Inspector — accounts registry + snapshot summary.
        // Mirrors options.html (legacy) but stays inside the modal.
        const inspectorCard = section("Data inspector");

        const inspectorBlurb = document.createElement("div");
        inspectorBlurb.style.cssText = "font-size:11px;color:var(--aes-oxide-2);line-height:1.5;margin-bottom:10px";
        inspectorBlurb.textContent = "Registered accounts and stored snapshot counts. Reads chrome.storage.local.";
        inspectorCard.appendChild(inspectorBlurb);

        const accountsHeader = document.createElement("div");
        accountsHeader.textContent = "ACCOUNTS";
        accountsHeader.style.cssText = "font-weight:700;font-size:10px;letter-spacing:0.08em;color:var(--aes-oxide-2);margin-bottom:4px";
        inspectorCard.appendChild(accountsHeader);

        const accountsHost = document.createElement("div");
        accountsHost.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--aes-oxide);margin-bottom:12px";
        accountsHost.textContent = "Loading…";
        inspectorCard.appendChild(accountsHost);

        const snapshotsHeader = document.createElement("div");
        snapshotsHeader.textContent = "SNAPSHOTS";
        snapshotsHeader.style.cssText = "font-weight:700;font-size:10px;letter-spacing:0.08em;color:var(--aes-oxide-2);margin-bottom:4px";
        inspectorCard.appendChild(snapshotsHeader);

        const snapshotsHost = document.createElement("div");
        snapshotsHost.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--aes-oxide);margin-bottom:8px";
        snapshotsHost.textContent = "Loading…";
        inspectorCard.appendChild(snapshotsHost);

        const refreshRow = document.createElement("div");
        refreshRow.style.cssText = "display:flex;gap:8px";
        const refreshBtn = actionBtn("Refresh", function () {
            renderAccounts(accountsHost);
            renderSnapshots(snapshotsHost);
        });
        refreshRow.appendChild(refreshBtn);
        inspectorCard.appendChild(refreshRow);

        renderAccounts(accountsHost);
        renderSnapshots(snapshotsHost);

        wrap.appendChild(inspectorCard);

        host.appendChild(wrap);
    }

    function renderAccounts(target) {
        if (!target) return;
        target.textContent = "Loading…";
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            target.textContent = "(storage API unavailable)";
            return;
        }
        chrome.storage.local.get(["aesAccounts"], function (data) {
            const blob = (data && data.aesAccounts) || {};
            const accounts = blob.accounts && typeof blob.accounts === "object" ? blob.accounts : {};
            const list = Object.values(accounts).sort(function (a, b) {
                return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
            });
            target.textContent = "";
            if (!list.length) {
                target.textContent = "(no accounts registered yet)";
                return;
            }
            const table = document.createElement("table");
            table.style.cssText = "width:100%;border-collapse:collapse;font-family:inherit;font-size:11px";
            const thead = document.createElement("thead");
            const headRow = document.createElement("tr");
            ["Airline", "Server", "First seen", "Last seen"].forEach(function (label) {
                const th = document.createElement("th");
                th.textContent = label;
                th.style.cssText = "text-align:left;padding:4px 6px;border-bottom:1px solid var(--aes-paper-rule);font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--aes-oxide-2)";
                headRow.appendChild(th);
            });
            thead.appendChild(headRow);
            const tbody = document.createElement("tbody");
            list.forEach(function (acct) {
                const tr = document.createElement("tr");
                [
                    acct.displayName || acct.airlineIdentity || "—",
                    acct.server || "—",
                    fmtDate(acct.firstSeenAt),
                    fmtDate(acct.lastSeenAt)
                ].forEach(function (val) {
                    const td = document.createElement("td");
                    td.textContent = val;
                    td.style.cssText = "padding:4px 6px;border-bottom:1px solid var(--aes-paper-rule)";
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.append(thead, tbody);
            target.appendChild(table);

            const viewing = blob.viewingAccountId;
            if (viewing) {
                const note = document.createElement("div");
                note.textContent = "Last touched: " + viewing;
                note.style.cssText = "margin-top:6px;font-size:10px;color:var(--aes-oxide-2);text-transform:uppercase;letter-spacing:0.06em";
                target.appendChild(note);
            }
        });
    }

    function renderSnapshots(target) {
        if (!target) return;
        target.textContent = "Loading…";
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            target.textContent = "(storage API unavailable)";
            return;
        }
        chrome.storage.local.get(null, function (items) {
            // Build server → airline → type → count pivot, mirroring
            // options.js logic but compressed to per-bucket counts.
            const pivot = {};
            let totalEntries = 0;
            for (const key in items) {
                const v = items[key];
                if (!v || typeof v !== "object") continue;
                if (!v.server || !v.airline || !v.type) continue;
                const s = v.server, a = v.airline, t = v.type;
                if (!pivot[s]) pivot[s] = {};
                if (!pivot[s][a]) pivot[s][a] = {};
                if (!pivot[s][a][t]) pivot[s][a][t] = { records: 0, datapoints: 0 };
                pivot[s][a][t].records += 1;
                if (t === "pricing" && v.date && typeof v.date === "object") {
                    pivot[s][a][t].datapoints += Object.keys(v.date).length;
                } else if (t === "schedule" && v.data && typeof v.data === "object") {
                    pivot[s][a][t].datapoints += Object.keys(v.data).length;
                }
                totalEntries += 1;
            }
            target.textContent = "";
            if (!totalEntries) {
                target.textContent = "(no snapshots captured yet — visit AS pages to populate)";
                return;
            }
            const summary = document.createElement("div");
            summary.textContent = totalEntries + " snapshot record" + (totalEntries === 1 ? "" : "s") + " stored.";
            summary.style.cssText = "margin-bottom:6px;color:var(--aes-oxide-2);font-size:11px";
            target.appendChild(summary);

            const table = document.createElement("table");
            table.style.cssText = "width:100%;border-collapse:collapse;font-family:inherit;font-size:11px";
            const thead = document.createElement("thead");
            const headRow = document.createElement("tr");
            ["Server", "Airline", "Type", "Records", "Datapoints"].forEach(function (label, i) {
                const th = document.createElement("th");
                th.textContent = label;
                th.style.cssText = "text-align:" + (i >= 3 ? "right" : "left") +
                    ";padding:4px 6px;border-bottom:1px solid var(--aes-paper-rule);font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--aes-oxide-2)";
                headRow.appendChild(th);
            });
            thead.appendChild(headRow);
            const tbody = document.createElement("tbody");
            const servers = Object.keys(pivot).sort();
            for (const s of servers) {
                const airlines = Object.keys(pivot[s]).sort();
                for (const a of airlines) {
                    const typesMap = pivot[s][a];
                    const types = Object.keys(typesMap).sort();
                    for (const t of types) {
                        const tr = document.createElement("tr");
                        const bucket = typesMap[t];
                        [s, a, t, String(bucket.records), String(bucket.datapoints)].forEach(function (val, i) {
                            const td = document.createElement("td");
                            td.textContent = val;
                            td.style.cssText = "padding:4px 6px;border-bottom:1px solid var(--aes-paper-rule);" +
                                (i >= 3 ? "text-align:right;" : "");
                            tr.appendChild(td);
                        });
                        tbody.appendChild(tr);
                    }
                }
            }
            table.append(thead, tbody);
            target.appendChild(table);
        });
    }

    function section(title) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:14px 16px;border:2px solid var(--aes-oxide);background:var(--aes-bone);box-shadow:4px 4px 0 var(--aes-oxide)";
        const h = document.createElement("div");
        h.textContent = title.toUpperCase();
        h.style.cssText = "font-weight:800;font-size:11px;letter-spacing:0.08em;color:var(--aes-oxide);margin-bottom:8px";
        wrap.appendChild(h);
        return wrap;
    }

    function actionBtn(label, onClick, disabled) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.cssText = [
            "border:1px solid var(--aes-oxide)",
            "background:var(--aes-oxide)",
            "color:var(--aes-bone)",
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
