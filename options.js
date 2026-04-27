"use strict";

// ---------------------------------------------------------------------------
// AES options page — two sections:
//
//   1. Accounts (Slice L1) — list every registered (server, airline) account
//      with rename / archive / unarchive / remove (with optional data delete).
//      All writes round-trip through background.js via AesAccountRegistry to
//      preserve the single-writer invariant.
//
//   2. Data Manager — inspects every chrome.storage.local entry that looks
//      like a stored snapshot and groups them by server / airline / type.
//      Pricing snapshots list OD pairs; schedule snapshots list dates.
//
// Visual styling consumes design-tokens.css + components.css primitives
// (.aes-table, .aes-select, .aes-stamp). Zero Bootstrap dependency.
// ---------------------------------------------------------------------------

var dataPoints = {};
var servers = [];
var airlines = [];
var types = [];
var data;

// Accounts state (re-rendered on storage.onChanged).
var aesAcctShowArchived = false;

function aesAcctSendMessage(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    reject(new Error(err.message || "sendMessage failed"));
                    return;
                }
                resolve(response);
            });
        } catch (e) { reject(e); }
    });
}

function aesAcctLoadRegistry() {
    return new Promise((resolve) => {
        chrome.storage.local.get("aesAccounts", (items) => {
            void chrome.runtime.lastError;
            const raw = items && items.aesAccounts;
            if (!raw || typeof raw !== "object") {
                resolve({accounts: {}, activeAccountId: null, viewingAccountId: null});
                return;
            }
            resolve({
                accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {},
                activeAccountId: raw.activeAccountId || null,
                viewingAccountId: raw.viewingAccountId || null
            });
        });
    });
}

function aesAcctFmtRel(ts) {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
    return Math.floor(diff / 86_400_000) + "d ago";
}

function aesAcctFmtAbs(ts) {
    if (!ts) return "";
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

async function aesAcctRender() {
    const host = document.getElementById("aes-acct-list");
    if (!host) return;
    const reg = await aesAcctLoadRegistry();
    const all = Object.values(reg.accounts);
    const filtered = aesAcctShowArchived ? all : all.filter(a => !a.archived);
    filtered.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));

    host.innerHTML = "";

    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "aes-empty";
        empty.textContent = aesAcctShowArchived
            ? "No accounts registered yet."
            : "No active accounts. Visit an AirlineSim page to register one, or show archived.";
        host.appendChild(empty);
        return;
    }

    const table = document.createElement("table");
    table.className = "aes-table";
    table.style.width = "100%";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Label", "Server", "Airline", "Last seen", "Status", "Actions"].forEach((t) => {
        const th = document.createElement("th");
        th.textContent = t;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    filtered.forEach((rec) => {
        const tr = document.createElement("tr");

        // Label cell — editable.
        const labelTd = document.createElement("td");
        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.className = "aes-acct-label-input";
        labelInput.value = rec.label || "";
        labelInput.placeholder = rec.airlineCode || rec.airlineName || "";
        labelInput.addEventListener("change", async () => {
            const next = labelInput.value.trim();
            try {
                await aesAcctSendMessage({type: "aes:account:setLabel", accountId: rec.accountId, label: next || null});
            } catch (e) { console.warn("[AES] setLabel failed", e); }
        });
        labelTd.appendChild(labelInput);
        tr.appendChild(labelTd);

        // Server / airline cells.
        [rec.server, rec.airlineCode].forEach((v) => {
            const td = document.createElement("td");
            td.textContent = v || "—";
            tr.appendChild(td);
        });

        // Last seen.
        const seenTd = document.createElement("td");
        seenTd.textContent = aesAcctFmtRel(rec.lastSeenAt);
        seenTd.title = aesAcctFmtAbs(rec.lastSeenAt);
        tr.appendChild(seenTd);

        // Status pill.
        const statusTd = document.createElement("td");
        const pill = document.createElement("span");
        pill.className = "aes-acct-pill";
        if (rec.archived) {
            pill.classList.add("aes-acct-pill--archived");
            pill.textContent = "archived";
        } else if (reg.activeAccountId === rec.accountId) {
            pill.classList.add("aes-acct-pill--active");
            pill.textContent = "active";
        } else {
            pill.textContent = "registered";
        }
        statusTd.appendChild(pill);
        tr.appendChild(statusTd);

        // Action buttons.
        const actTd = document.createElement("td");
        const acts = document.createElement("div");
        acts.className = "aes-acct-actions";

        if (rec.archived) {
            const unarch = document.createElement("button");
            unarch.textContent = "Unarchive";
            unarch.addEventListener("click", async () => {
                try {
                    await aesAcctSendMessage({type: "aes:account:unarchive", accountId: rec.accountId});
                } catch (e) { console.warn("[AES] unarchive failed", e); }
            });
            acts.appendChild(unarch);
        } else {
            const arch = document.createElement("button");
            arch.textContent = "Archive";
            arch.addEventListener("click", async () => {
                try {
                    await aesAcctSendMessage({type: "aes:account:archive", accountId: rec.accountId});
                } catch (e) { console.warn("[AES] archive failed", e); }
            });
            acts.appendChild(arch);
        }

        const remove = document.createElement("button");
        remove.textContent = "Remove";
        remove.className = "danger";
        remove.title = "Hold Shift while clicking to also delete this account's stored data (legacy snapshot keys + per-account namespaced keys).";
        remove.addEventListener("click", async (ev) => {
            const deleteData = !!ev.shiftKey;
            const label = rec.label || rec.airlineCode || rec.accountId;
            const prompt = deleteData
                ? `Remove "${label}" AND delete all its stored data? This cannot be undone.`
                : `Remove "${label}" from the registry? Stored data will remain.`;
            if (!confirm(prompt)) return;
            try {
                const resp = await aesAcctSendMessage({
                    type: "aes:account:remove",
                    accountId: rec.accountId,
                    deleteData
                });
                if (resp && resp.summary && resp.summary.keysDeleted != null) {
                    console.info(`[AES] removed ${label}; ${resp.summary.keysDeleted} stored keys deleted`);
                }
            } catch (e) { console.warn("[AES] remove failed", e); }
        });
        acts.appendChild(remove);

        actTd.appendChild(acts);
        tr.appendChild(actTd);

        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
}

function aesAcctWireEvents() {
    const cb = document.getElementById("aes-acct-show-archived");
    if (cb) {
        cb.addEventListener("change", () => {
            aesAcctShowArchived = !!cb.checked;
            aesAcctRender();
        });
    }
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.aesAccounts) aesAcctRender();
    });
}

$(function () {
    // Stamp the version number.
    const m = chrome.runtime.getManifest();
    const stamp = document.getElementById("aes-version-stamp");
    if (stamp) stamp.textContent = "v" + (m.version_name || m.version);

    aesAcctRender();
    aesAcctWireEvents();

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
