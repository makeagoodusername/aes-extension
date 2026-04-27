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
        // Default skin = on, density = comfortable. Match defaults in
        // modules/site-skin/bootstrap.js so users never see mismatched UI.
        const enabled = items[SKIN_KEY] !== false;
        const density = items[DENSITY_KEY] === "compact" ? "compact" : "comfortable";
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
            const v = changes[DENSITY_KEY].newValue === "compact" ? "compact" : "comfortable";
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
        const blob = data[type + server + airline];
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
