"use strict";

/**
 * Unified Settings — Backup & Restore section.
 *
 * Ported from AirlineSim-Enhancement-Suite-main v0.7.8 options.js
 * (`createBackup` / `restoreData` / `clearOldData` / `clearAllData`)
 * and conformed to the host's tab-data.js cubist styling. Distinct
 * from the existing Export/Import card in tab-data.js, which serializes
 * customization presets via AESPresetCodec — this section serializes
 * the entire chrome.storage.local blob, optionally filtered by type
 * bucket, for full disaster-recovery backup.
 *
 * Public surface:
 *   window.AesUnifiedSettingsBackupRestore.renderSection(host)
 *      Appends a section element to `host` (a parent flex container
 *      such as the wrap built by tab-data.js).
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AesUnifiedSettingsBackupRestore) return;

    const BACKUP_TYPES = [
        { value: "all",                  label: "All Data" },
        { value: "settings",             label: "Settings Only" },
        { value: "schedule",             label: "Schedule Data" },
        { value: "pricing",              label: "Pricing Data" },
        { value: "competitorMonitoring", label: "Competitor Monitoring" },
        { value: "flightInfo",           label: "Flight Info" },
        { value: "aircraftData",         label: "Aircraft Data" }
    ];

    function section(title) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "padding:14px 16px;border:2px solid var(--aes-oxide);background:var(--aes-bone);box-shadow:4px 4px 0 var(--aes-oxide)";
        const h = document.createElement("div");
        h.textContent = title.toUpperCase();
        h.style.cssText = "font-weight:800;font-size:11px;letter-spacing:0.08em;color:var(--aes-oxide);margin-bottom:8px";
        wrap.appendChild(h);
        return wrap;
    }

    function actionBtn(label, onClick, opts) {
        const o = opts || {};
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        const bg = o.danger ? "var(--aes-rust, #b03)" : "var(--aes-oxide)";
        btn.style.cssText = [
            "border:1px solid var(--aes-oxide)",
            "background:" + bg,
            "color:var(--aes-bone)",
            "padding:6px 12px",
            "font-family:inherit",
            "font-size:11px",
            "font-weight:700",
            "letter-spacing:0.06em",
            "cursor:pointer"
        ].join(";");
        if (o.disabled) {
            btn.disabled = true;
            btn.style.opacity = "0.4";
        } else {
            btn.addEventListener("click", onClick);
        }
        return btn;
    }

    function statusEl() {
        const el = document.createElement("div");
        el.style.cssText = "min-height:18px;font-size:11px;color:var(--aes-oxide-2);font-family:'JetBrains Mono',monospace;margin-top:8px";
        return el;
    }

    function setStatus(el, msg, kind) {
        if (!el) return;
        el.textContent = msg;
        const colors = {
            success: "var(--aes-good, #2a7)",
            error:   "var(--aes-bad, #b22)",
            warning: "var(--aes-rust, #c63)"
        };
        el.style.color = colors[kind] || "var(--aes-oxide-2)";
        if (el._aesHideTimer) {
            window.clearTimeout(el._aesHideTimer);
            el._aesHideTimer = null;
        }
        if (kind === "success" || kind === "info" || !kind) {
            el._aesHideTimer = window.setTimeout(function () {
                el.textContent = "";
                el._aesHideTimer = null;
            }, 5000);
        }
    }

    function downloadBlob(filename, contents) {
        const blob = new Blob([contents], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    function buildBackup(items, backupType) {
        const data = {};
        if (backupType === "all") {
            Object.assign(data, items);
        } else {
            for (const key in items) {
                const item = items[key];
                switch (backupType) {
                    case "settings":
                        if (key === "settings") data[key] = item;
                        break;
                    case "schedule":
                        if (item && item.type === "schedule") data[key] = item;
                        break;
                    case "pricing":
                        if (item && item.type === "pricing") data[key] = item;
                        break;
                    case "competitorMonitoring":
                        if (item && item.type === "competitorMonitoring") data[key] = item;
                        break;
                    case "flightInfo":
                        if (key.includes("flightInfo")) data[key] = item;
                        break;
                    case "aircraftData":
                        if (key.includes("aircraftProfitability") || key.includes("aircraft")) {
                            data[key] = item;
                        }
                        break;
                }
            }
        }
        const manifest = chrome.runtime.getManifest();
        return {
            metadata: {
                version: manifest.version_name || manifest.version,
                created: new Date().toISOString(),
                type: backupType,
                itemCount: Object.keys(data).length
            },
            data: data
        };
    }

    function createBackup(typeSelect, status) {
        const backupType = typeSelect.value;
        setStatus(status, "Creating backup…", "info");
        chrome.storage.local.get(null, function (items) {
            const backup = buildBackup(items, backupType);
            const filename = "aes-backup-" + backupType + "-" + new Date().toISOString().split("T")[0] + ".json";
            downloadBlob(filename, JSON.stringify(backup, null, 2));
            setStatus(status, "Backup created. " + backup.metadata.itemCount + " item(s) exported.", "success");
        });
    }

    function restoreData(fileInput, modeSelect, status) {
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
            setStatus(status, "Please select a backup file first.", "error");
            return;
        }
        const restoreMode = modeSelect.value;
        setStatus(status, "Reading backup file…", "info");
        const reader = new FileReader();
        reader.onload = function (e) {
            let backup;
            try {
                backup = JSON.parse(e.target.result);
            } catch (err) {
                setStatus(status, "Error reading backup file: " + err.message, "error");
                return;
            }
            if (!backup || !backup.metadata || !backup.data) {
                setStatus(status, "Invalid backup file format.", "error");
                return;
            }
            setStatus(status, "Restoring " + backup.metadata.itemCount + " item(s)…", "info");
            const onWrite = function () {
                if (chrome.runtime.lastError) {
                    setStatus(status, "Error restoring data: " + chrome.runtime.lastError.message, "error");
                    return;
                }
                setStatus(status, "Data restored. Reloading…", "success");
                setTimeout(function () { location.reload(); }, 2000);
            };
            if (restoreMode === "replace") {
                chrome.storage.local.clear(function () {
                    chrome.storage.local.set(backup.data, onWrite);
                });
            } else {
                chrome.storage.local.set(backup.data, onWrite);
            }
        };
        reader.readAsText(file);
    }

    function parseStorageDateKey(value) {
        const v = String(value);
        if (/^\d{8}$/.test(v)) {
            const year  = parseInt(v.substring(0, 4), 10);
            const month = parseInt(v.substring(4, 6), 10);
            const day   = parseInt(v.substring(6, 8), 10);
            const d = new Date(year, month - 1, day);
            if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
                return d;
            }
        }
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }

    function clearOldData(status) {
        setStatus(status, "Clearing data older than 30 days…", "info");
        chrome.storage.local.get(null, function (items) {
            const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const keysToRemove = [];
            for (const key in items) {
                if (key === "settings") continue;
                const item = items[key];
                if (item && item.date && typeof item.date === "object") {
                    let recent = false;
                    for (const dateKey in item.date) {
                        const d = parseStorageDateKey(dateKey);
                        if (!d || d.getTime() > cutoff) { recent = true; break; }
                    }
                    if (!recent) keysToRemove.push(key);
                } else if (item && item.updateTime) {
                    if (new Date(item.updateTime).getTime() < cutoff) keysToRemove.push(key);
                }
            }
            if (!keysToRemove.length) {
                setStatus(status, "No old data found to clear.", "info");
                return;
            }
            chrome.storage.local.remove(keysToRemove, function () {
                setStatus(status, "Cleared " + keysToRemove.length + " old item(s). Reloading…", "success");
                setTimeout(function () { location.reload(); }, 1500);
            });
        });
    }

    function clearAllData(status) {
        if (!window.confirm("This will permanently delete all AES data. Are you absolutely sure?")) {
            return;
        }
        setStatus(status, "Clearing all data…", "warning");
        chrome.storage.local.clear(function () {
            if (chrome.runtime.lastError) {
                setStatus(status, "Error: " + chrome.runtime.lastError.message, "error");
                return;
            }
            setStatus(status, "All data cleared. Reloading…", "success");
            setTimeout(function () { location.reload(); }, 1500);
        });
    }

    function renderSection(host) {
        if (!host) return;

        const card = section("Backup & Restore");

        const blurb = document.createElement("div");
        blurb.style.cssText = "font-size:11px;color:var(--aes-oxide-2);line-height:1.5;margin-bottom:10px";
        blurb.textContent = "Disaster-recovery backup of the full chrome.storage.local blob. Filterable by type bucket. Restore can merge or replace.";
        card.appendChild(blurb);

        // Backup row
        const backupRow = document.createElement("div");
        backupRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px";

        const typeLabel = document.createElement("label");
        typeLabel.textContent = "Type";
        typeLabel.style.cssText = "font-size:10px;font-weight:700;letter-spacing:0.06em;color:var(--aes-oxide-2);text-transform:uppercase";
        const typeSelect = document.createElement("select");
        typeSelect.style.cssText = "border:1px solid var(--aes-oxide);background:var(--aes-bone);color:var(--aes-oxide);padding:4px 8px;font-family:inherit;font-size:11px";
        BACKUP_TYPES.forEach(function (opt) {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = opt.label;
            typeSelect.appendChild(o);
        });
        backupRow.append(typeLabel, typeSelect);

        const status = statusEl();

        backupRow.appendChild(actionBtn("Create backup", function () {
            createBackup(typeSelect, status);
        }));
        card.appendChild(backupRow);

        // Restore row
        const restoreRow = document.createElement("div");
        restoreRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = ".json";
        fileInput.style.cssText = "font-family:inherit;font-size:11px;color:var(--aes-oxide)";

        const modeLabel = document.createElement("label");
        modeLabel.textContent = "Mode";
        modeLabel.style.cssText = "font-size:10px;font-weight:700;letter-spacing:0.06em;color:var(--aes-oxide-2);text-transform:uppercase";
        const modeSelect = document.createElement("select");
        modeSelect.style.cssText = typeSelect.style.cssText;
        ["merge", "replace"].forEach(function (m) {
            const o = document.createElement("option");
            o.value = m;
            o.textContent = m === "merge" ? "Merge with existing" : "Replace existing";
            modeSelect.appendChild(o);
        });

        const restoreBtn = actionBtn("Restore backup", function () {
            restoreData(fileInput, modeSelect, status);
        });

        restoreRow.append(fileInput, modeLabel, modeSelect, restoreBtn);
        card.appendChild(restoreRow);

        // Cleanup row
        const cleanupRow = document.createElement("div");
        cleanupRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px";

        cleanupRow.appendChild(actionBtn("Clear data > 30 days", function () {
            if (window.confirm("Clear data older than 30 days? This action cannot be undone.")) {
                clearOldData(status);
            }
        }));
        cleanupRow.appendChild(actionBtn("Clear ALL data", function () {
            if (window.confirm("This will clear ALL AES data. Consider creating a backup first. Continue?")) {
                clearAllData(status);
            }
        }, { danger: true }));
        card.appendChild(cleanupRow);

        card.appendChild(status);

        host.appendChild(card);
    }

    window.AesUnifiedSettingsBackupRestore = { renderSection: renderSection };
})();
