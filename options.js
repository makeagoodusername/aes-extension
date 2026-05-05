"use strict";

// ---------------------------------------------------------------------------
// AES Data Manager — options page.
// Inspects every chrome.storage.local entry that looks like a stored
// snapshot and groups them by server / airline / type. Pricing snapshots
// list OD pairs + count of stored dates; schedule snapshots list dates +
// count of routes per date.
//
// Visual styling consumes design-tokens.css + components.css primitives
// (.aes-table, .aes-select, .aes-stamp). Zero Bootstrap dependency.
// ---------------------------------------------------------------------------

var dataPoints = {};
var servers = [];
var airlines = [];
var types = [];
var data;

const SKIN_KEY = "aes_skin_enabled";
const DENSITY_KEY = "aes_skin_density";

function wireSiteSkinSettings() {
    const checkbox = document.getElementById("aes-skin-enabled");
    const radios = document.querySelectorAll('input[name="aes-skin-density"]');
    if (!checkbox || !radios.length) return;

    chrome.storage.sync.get([SKIN_KEY, DENSITY_KEY], function (items) {
        // Default skin = on, density = compact. Match defaults in
        // modules/site-skin/bootstrap.js so users never see mismatched UI.
        const enabled = items[SKIN_KEY] !== false;
        const density = items[DENSITY_KEY] === "comfortable" ? "comfortable" : "compact";
        checkbox.checked = enabled;
        radios.forEach(r => { r.checked = (r.value === density); });
    });

    checkbox.addEventListener("change", function () {
        chrome.storage.sync.set({ [SKIN_KEY]: !!checkbox.checked });
    });
    radios.forEach(r => r.addEventListener("change", function () {
        if (r.checked) chrome.storage.sync.set({ [DENSITY_KEY]: r.value });
    }));

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "sync") return;
        if (changes[SKIN_KEY])    checkbox.checked = changes[SKIN_KEY].newValue !== false;
        if (changes[DENSITY_KEY]) {
            const v = changes[DENSITY_KEY].newValue === "comfortable" ? "comfortable" : "compact";
            radios.forEach(r => { r.checked = (r.value === v); });
        }
    });
}

// L1 — render the Accounts section above the Data Manager. Reads the
// `aesAccounts` blob populated by background.js's `aes:account:touch`
// handler. Refreshes whenever the blob changes (touched on every AS
// page mount, so an open options tab stays current).
function renderAccountsSection() {
    const tableHost = document.getElementById("aes-accounts-table");
    const viewingEl = document.getElementById("aes-accounts-viewing");
    if (!tableHost) return;
    chrome.storage.local.get(["aesAccounts"], function (data) {
        const blob = (data && data.aesAccounts) || {};
        const accounts = blob.accounts && typeof blob.accounts === "object" ? blob.accounts : {};
        const list = Object.values(accounts).sort(function (a, b) {
            return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
        });
        tableHost.innerHTML = "";
        if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "aes-accounts__empty";
            empty.textContent = "No accounts registered yet — visit an AS page to register the active airline.";
            tableHost.appendChild(empty);
            if (viewingEl) viewingEl.textContent = "";
            return;
        }
        const table = $('<table class="aes-table" style="width:100%"></table>');
        const thead = $("<thead></thead>").append(
            $("<tr></tr>").append(
                $("<th></th>").text("Airline"),
                $("<th></th>").text("Server"),
                $("<th></th>").text("Account ID"),
                $('<th class="aes-text-right"></th>').text("First seen"),
                $('<th class="aes-text-right"></th>').text("Last seen")
            )
        );
        const tbody = $("<tbody></tbody>");
        const fmtDate = function (ms) {
            if (!ms) return "—";
            const d = new Date(ms);
            return d.toISOString().slice(0, 10);
        };
        list.forEach(function (acct) {
            tbody.append(
                $("<tr></tr>").append(
                    $("<td></td>").text(acct.displayName || acct.airlineIdentity || "—"),
                    $("<td></td>").text(acct.server || "—"),
                    $("<td></td>").append($('<code></code>').text(acct.id || "")),
                    $('<td class="aes-text-right"></td>').text(fmtDate(acct.firstSeenAt)),
                    $('<td class="aes-text-right"></td>').text(fmtDate(acct.lastSeenAt))
                )
            );
        });
        table.append(thead, tbody);
        $(tableHost).append(table);
        if (viewingEl) {
            const viewing = blob.viewingAccountId || "";
            viewingEl.textContent = viewing
                ? ("Last touched: " + viewing)
                : "";
        }
    });
}

$(function () {
    // Stamp the version number.
    const m = chrome.runtime.getManifest();
    const stamp = document.getElementById("aes-version-stamp");
    if (stamp) stamp.textContent = "v" + (m.version_name || m.version);

    wireSiteSkinSettings();
    renderAccountsSection();
    // Re-render on registry changes so an open options tab tracks
    // touches that arrive while the user is viewing.
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "local" && changes && changes.aesAccounts) renderAccountsSection();
    });

    chrome.storage.local.get(null, function (items) {
        data = items;
        for (let key in items) {
            if (items[key].server) {
                let server = items[key].server;
                let airline = items[key].airline;
                let type = items[key].type;

                if (!servers.includes(server))   { servers.push(server); }
                if (!airlines.includes(airline)) { airlines.push(airline); }
                if (!types.includes(type))       { types.push(type); }

                if (!dataPoints[server])                      { dataPoints[server] = {}; }
                if (!dataPoints[server][airline])             { dataPoints[server][airline] = {}; }
                if (!dataPoints[server][airline][type]) {
                    if (items[key].type === "pricing")  { dataPoints[server][airline][type] = {}; }
                    if (items[key].type === "schedule") { dataPoints[server][airline][type] = []; }
                }
                if (items[key].type === "pricing") {
                    let od = items[key].origin + items[key].destination;
                    if (!dataPoints[server][airline][type][od]) { dataPoints[server][airline][type][od] = []; }
                    for (let date in items[key].date) {
                        dataPoints[server][airline][type][od].push(date);
                    }
                }
                if (items[key].type === "schedule") {
                    for (let date in items[key].data) {
                        dataPoints[server][airline][type].push(date);
                    }
                }
            }
        }

        if (Object.keys(dataPoints).length) {
            displayTopSelector();
        } else {
            $("#aes-div-dataDisplay").append(
                $('<div class="aes-empty">No data stored yet — visit your AirlineSim pages to capture snapshots.</div>')
            );
        }
    });
});

function displayTopSelector() {
    appendFilterCell(servers,  "server");
    appendFilterCell(airlines, "airline");
    appendFilterCell(types,    "type");
    topSelectHandle();
    $("#aes-select-top-server").change(topSelectHandle);
    $("#aes-select-top-airline").change(topSelectHandle);
    $("#aes-select-top-type").change(topSelectHandle);
}

function appendFilterCell(arr, name) {
    const cell = $('<div class="aes-filter-cell"></div>');
    const label = $('<label></label>')
        .attr("for", "aes-select-top-" + name)
        .text(name);
    const select = $('<select class="aes-select"></select>')
        .attr("id", "aes-select-top-" + name);
    for (let i in arr) {
        select.append($("<option></option>").attr("value", arr[i]).text(arr[i]));
    }
    cell.append(label, select);
    $("#aes-div-topSelect").append(cell);
}

function topSelectHandle() {
    const server  = $("#aes-select-top-server").val();
    const airline = $("#aes-select-top-airline").val();
    const type    = $("#aes-select-top-type").val();
    const div = $("#aes-div-dataDisplay");
    div.empty();
    switch (type) {
        case "pricing":  displayPricingData(server, airline, type, div);  break;
        case "schedule": displayScheduleData(server, airline, type, div); break;
        default: break;
    }
}

function displayPricingData(server, airline, type, div) {
    const tbody = $("<tbody></tbody>");
    const bucket = (dataPoints[server] || {})[airline] || {};
    const od = bucket[type] || {};
    for (let key in od) {
        tbody.append(
            $("<tr></tr>").append(
                $("<td></td>").text(key),
                $('<td class="aes-text-right"></td>').text(od[key].length)
            )
        );
    }
    const thead = $("<thead></thead>").append(
        $("<tr></tr>").append(
            $("<th></th>").text("OD"),
            $('<th class="aes-text-right"></th>').text("# of Data Points")
        )
    );
    div.append($('<table class="aes-table" style="width:100%"></table>').append(thead, tbody));
}

function displayScheduleData(server, airline, type, div) {
    const tbody = $("<tbody></tbody>");
    const dates = ((dataPoints[server] || {})[airline] || {})[type] || [];
    dates.forEach(function (date) {
        const blob = data[server + airline + type] || data[type + server + airline];
        const count = blob && blob.data && blob.data[date] && blob.data[date].schedule
            ? blob.data[date].schedule.length
            : 0;
        tbody.append(
            $("<tr></tr>").append(
                $("<td></td>").text(date),
                $('<td class="aes-text-right"></td>').text(count)
            )
        );
    });
    const thead = $("<thead></thead>").append(
        $("<tr></tr>").append(
            $("<th></th>").text("Date"),
            $('<th class="aes-text-right"></th>').text("# of Routes")
        )
    );
    div.append($('<table class="aes-table" style="width:100%"></table>').append(thead, tbody));
}

// ── Backup / Restore / Cleanup tools ───────────────────────────────────
//
// Self-contained IIFE ported from AirlineSim-Enhancement-Suite-main v0.7.8
// options.js. Wraps its own state and bindings so it doesn't collide with
// the fork's existing `data`, `dataPoints`, etc. globals. Mounted via
// $(function(){…}) so it picks up the new <section>s in options.html.
;(function aesDataTools() {
    "use strict"

    function init() {
        if (!document.getElementById("aes-backup-btn")) return
        $("#aes-backup-btn").click(function () { createBackup() })
        $("#aes-choose-file-btn").click(function () { $("#aes-restore-file").click() })
        $("#aes-restore-file").change(function (event) {
            const file = event.target.files[0]
            if (file) {
                $("#aes-restore-btn").prop("disabled", false)
                $("#aes-selected-file-name").text(file.name)
                showStatusMessage("File selected: " + file.name, "info")
            } else {
                $("#aes-restore-btn").prop("disabled", true)
                $("#aes-selected-file-name").text("")
            }
        })
        $("#aes-restore-btn").click(function () { restoreData() })
        $("#aes-clear-old-data-btn").click(function () {
            if (confirm("Clear data older than 30 days? This cannot be undone.")) {
                clearOldData()
            }
        })
        $("#aes-clear-all-data-btn").click(function () {
            if (!confirm("Clear ALL AES data? This cannot be undone.\n\nConsider creating a backup first.")) return
            if (!confirm("This will permanently delete every AES key. Are you absolutely sure?")) return
            clearAllData()
        })

        chrome.storage.local.get(null, function (items) {
            displayDataStatistics(items)
        })
    }

    function displayDataStatistics(allStorageData) {
        const stats = analyzeStorageData(allStorageData)
        if (stats.totalItems === 0) {
            $("#aes-stats-content").text("No data found. Start using AES to see statistics here.")
            return
        }
        const summary = [
            "Items: " + stats.totalItems,
            "Settings: " + stats.settings,
            "Schedule: " + stats.schedule,
            "Pricing: " + stats.pricing,
            "Flight Info: " + stats.flightInfo,
            "Aircraft: " + stats.aircraftData,
            "Other: " + stats.other,
            "Size: " + formatBytes(stats.estimatedSize)
        ].join("  ·  ")
        $("#aes-stats-content").text(summary)
    }

    function analyzeStorageData(items) {
        const stats = {
            totalItems: 0, settings: 0, schedule: 0, pricing: 0,
            flightInfo: 0, competitorMonitoring: 0, aircraftData: 0,
            other: 0, estimatedSize: 0
        }
        for (const key in items) {
            stats.totalItems++
            const item = items[key]
            try { stats.estimatedSize += JSON.stringify(item).length } catch (_) { /* circular */ }
            if (key === "settings") { stats.settings++; continue }
            if (item && item.type) {
                switch (item.type) {
                    case "schedule": stats.schedule++; break
                    case "pricing": stats.pricing++; break
                    case "competitorMonitoring": stats.competitorMonitoring++; break
                    default: stats.other++
                }
                continue
            }
            if (key.includes("flightInfo")) { stats.flightInfo++; continue }
            if (key.includes("aircraftProfitability") || key.includes("aircraft")) { stats.aircraftData++; continue }
            stats.other++
        }
        return stats
    }

    function createBackup() {
        const backupType = $("#aes-backup-type").val()
        showStatusMessage("Creating backup…", "info")
        chrome.storage.local.get(null, function (items) {
            let backupData = {}
            if (backupType === "all") {
                backupData = items
            } else {
                for (const key in items) {
                    const item = items[key]
                    switch (backupType) {
                        case "settings":
                            if (key === "settings") backupData[key] = item
                            break
                        case "schedule":
                            if (item && item.type === "schedule") backupData[key] = item
                            break
                        case "pricing":
                            if (item && item.type === "pricing") backupData[key] = item
                            break
                        case "competitorMonitoring":
                            if (item && item.type === "competitorMonitoring") backupData[key] = item
                            break
                        case "flightInfo":
                            if (key.includes("flightInfo")) backupData[key] = item
                            break
                        case "aircraftData":
                            if (key.includes("aircraftProfitability") || key.includes("aircraft")) {
                                backupData[key] = item
                            }
                            break
                    }
                }
            }
            const manifest = chrome.runtime.getManifest()
            const backup = {
                metadata: {
                    version: manifest.version_name || manifest.version,
                    created: new Date().toISOString(),
                    type: backupType,
                    itemCount: Object.keys(backupData).length
                },
                data: backupData
            }
            downloadBackup(backup, backupType)
            showStatusMessage("Backup created. " + backup.metadata.itemCount + " items exported.", "success")
        })
    }

    function downloadBackup(backup, type) {
        const filename = "aes-backup-" + type + "-" + new Date().toISOString().split("T")[0] + ".json"
        const blob = new Blob([JSON.stringify(backup, null, 2)], {type: "application/json"})
        const link = document.createElement("a")
        link.href = URL.createObjectURL(blob)
        link.download = filename
        link.click()
        URL.revokeObjectURL(link.href)
    }

    function restoreData() {
        const file = $("#aes-restore-file")[0].files[0]
        const restoreMode = $("#aes-restore-mode").val()
        if (!file) {
            showStatusMessage("Please select a backup file first.", "error")
            return
        }
        showStatusMessage("Reading backup file…", "info")
        const reader = new FileReader()
        reader.onload = function (e) {
            try {
                const backup = JSON.parse(e.target.result)
                if (!backup.metadata || !backup.data) {
                    throw new Error("Invalid backup file format")
                }
                showStatusMessage("Restoring " + backup.metadata.itemCount + " items…", "info")
                const writeAndReload = function () {
                    chrome.storage.local.set(backup.data, function () {
                        if (chrome.runtime.lastError) {
                            showStatusMessage("Restore error: " + chrome.runtime.lastError.message, "error")
                        } else {
                            showStatusMessage("Restored. Reloading…", "success")
                            setTimeout(function () { location.reload() }, 1500)
                        }
                    })
                }
                if (restoreMode === "replace") {
                    chrome.storage.local.clear(writeAndReload)
                } else {
                    writeAndReload()
                }
            } catch (err) {
                showStatusMessage("Backup file error: " + err.message, "error")
            }
        }
        reader.readAsText(file)
    }

    function clearOldData() {
        showStatusMessage("Clearing old data…", "info")
        chrome.storage.local.get(null, function (items) {
            const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
            const keysToRemove = []
            for (const key in items) {
                if (key === "settings") continue
                const item = items[key]
                if (item && item.date && typeof item.date === "object") {
                    let hasRecent = false
                    for (const dateKey in item.date) {
                        const parsed = parseStorageDateKey(dateKey)
                        if (!parsed || parsed.getTime() > cutoff) { hasRecent = true; break }
                    }
                    if (!hasRecent) keysToRemove.push(key)
                } else if (item && item.updateTime) {
                    if (new Date(item.updateTime).getTime() < cutoff) keysToRemove.push(key)
                }
            }
            if (keysToRemove.length === 0) {
                showStatusMessage("No old data found to clear.", "info")
                return
            }
            chrome.storage.local.remove(keysToRemove, function () {
                showStatusMessage("Cleared " + keysToRemove.length + " old items.", "success")
                setTimeout(function () { location.reload() }, 1200)
            })
        })
    }

    function parseStorageDateKey(dateKey) {
        const value = String(dateKey)
        if (/^\d{8}$/.test(value)) {
            const year = parseInt(value.substring(0, 4), 10)
            const month = parseInt(value.substring(4, 6), 10)
            const day = parseInt(value.substring(6, 8), 10)
            const d = new Date(year, month - 1, day)
            if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
                return d
            }
        }
        const fallback = new Date(value)
        return isNaN(fallback.getTime()) ? null : fallback
    }

    function clearAllData() {
        showStatusMessage("Clearing all AES data…", "warning")
        chrome.storage.local.clear(function () {
            if (chrome.runtime.lastError) {
                showStatusMessage("Clear error: " + chrome.runtime.lastError.message, "error")
            } else {
                showStatusMessage("All data cleared.", "success")
                setTimeout(function () { location.reload() }, 1200)
            }
        })
    }

    function showStatusMessage(message, type) {
        const $status = $("#aes-status-message")
        const el = $status.get(0)
        if (!el) return
        if (el.aesHideTimer) {
            window.clearTimeout(el.aesHideTimer)
            el.aesHideTimer = null
        }
        $status.removeClass("status-success status-error status-warning")
        switch (type) {
            case "success": $status.addClass("status-success"); break
            case "error":   $status.addClass("status-error"); break
            case "warning":
            case "info":
            default:        $status.addClass("status-warning"); break
        }
        $status.text(message).show()
        if (type === "success" || type === "info") {
            el.aesHideTimer = window.setTimeout(function () {
                $status.hide()
                el.aesHideTimer = null
            }, 5000)
        }
    }

    function formatBytes(bytes) {
        if (!bytes) return "0 B"
        const k = 1024
        const sizes = ["B", "KB", "MB", "GB"]
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
    }

    if (typeof $ === "function") {
        $(function () { init() })
    } else if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, {once: true})
    } else {
        init()
    }
})()
