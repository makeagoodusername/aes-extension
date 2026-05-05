"use strict";
//MAIN
//Global vars
var flightInfoData, saveDataSpan;
$(function() {
    if (privateFlight()) {
        if (correctTabOpen()) {
            flightInfoData = getData();
            saveData();
            display();
        }
    }
});

function saveData() {
    saveDataSpan = $('<span></span>');
    // F-9228-807: airline-scoped key. Without the airline component the
    // same flightId on the same server (cross-airline shared-fleet sims,
    // fleet transfers) collided across airlines and silently overwrote
    // the prior airline's data. content_aircraftFlights.js reads both the
    // airline-scoped key and the legacy un-scoped key for backwards-compat.
    const airline = (typeof AES !== "undefined" && AES.getAirlineIdentity)
        ? (AES.getAirlineIdentity() || "") : "";
    let key = flightInfoData.server + airline + flightInfoData.type + flightInfoData.flightId;
    chrome.storage.local.set({
        [key]: flightInfoData }, function() {
        // F-9228-806 sibling: surface chrome quota / serialization failures
        // instead of silently dropping the write.
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
            console.warn("[AES /action/info/flight] saveData failed", err.message || err);
            saveDataSpan.addClass('bad').text('Save failed: ' + (err.message || err));
            return;
        }
        saveDataSpan.addClass('good').text('Flight info data saved!');
        chrome.storage.local.get(['settings'], function(result) {
            let settings = result.settings;
            if (settings.flightInfo) {
                if (settings.flightInfo.autoClose) {
                    close();
                }
            }
        });
    });
}

function privateFlight() {
    let headers = $('#privInf');
    if (headers.length) {
        return true;
    } else {
        return false;
    }
}

function correctTabOpen() {
    if ($('#flight-page > ul > li:eq(0)').hasClass('active')) {
        return true;
    } else {
        return false;
    }
}

function getData() {
    //Flight ID
    let flightId = getFlightId();
    let date = AES.getServerDate()
    let money = getFinancials();
    let loads = getLoads();
    let prices = getPrices();
    let route = getRoute();
    let server = getServerName();
    return {
        server: server,
        flightId: flightId,
        type: 'flightInfo',
        money: money,
        loads: loads,
        prices: prices,
        route: route,
        date: date.date,
        time: date.time
    }
}

// Costing-page Loads-table column layout: [label, Y, C, F, PAX, Cargo, empty].
// Used by both getLoads (first tbody — Capacity/Bookings/Load) and
// getPrices (second tbody — Price/Unit + Minimum Price).
const FLIGHT_INFO_COL_INDEX = { Y: 1, C: 2, F: 3, Cargo: 5 };

function findLoadsTable() {
    let table = null;
    $('.as-fieldset').each(function() {
        const legend = $(this).find('.legend').first().text().trim();
        if (legend === 'Loads') { table = $(this).find('table').first(); return false; }
    });
    return table;
}

function readClassCell($td) {
    if (!$td || !$td.length) return null;
    if ($td.hasClass('empty')) return null;
    const txt = ($td.text() || '').replace(/ /g, '').trim();
    if (!txt) return null;
    const v = AES.cleanInteger(txt);
    return isFinite(v) ? v : null;
}

function getLoads() {
    const table = findLoadsTable();
    const out = { Y: {}, C: {}, F: {}, Cargo: {} };
    if (!table || !table.length) return out;
    // First tbody carries Capacity / Bookings / Load + connection feeders.
    const rows = table.find('tbody').first().find('tr');
    rows.each(function() {
        const tds = $(this).find('td');
        if (tds.length < 6) return;
        const label = (tds.eq(0).text() || '').trim().toLowerCase();
        let key = null;
        if (label === 'capacity')      key = 'capacity';
        else if (label === 'bookings') key = 'bookings';
        else if (label === 'load')     key = 'loadPct';
        if (!key) return;
        for (const cls in FLIGHT_INFO_COL_INDEX) {
            const v = readClassCell(tds.eq(FLIGHT_INFO_COL_INDEX[cls]));
            if (v != null) out[cls][key] = v;
        }
    });
    return out;
}

function getPrices() {
    const table = findLoadsTable();
    const out = { Y: {}, C: {}, F: {}, Cargo: {} };
    if (!table || !table.length) return out;
    // Second tbody is the "Further Information" block — Price/Unit + Min Price.
    const rows = table.find('tbody').eq(1).find('tr');
    rows.each(function() {
        const tds = $(this).find('td');
        if (tds.length < 6) return;
        const label = (tds.eq(0).text() || '').trim().toLowerCase();
        let key = null;
        if (label === 'price/unit')        key = 'unit';
        else if (label === 'minimum price') key = 'min';
        if (!key) return;
        for (const cls in FLIGHT_INFO_COL_INDEX) {
            const v = readClassCell(tds.eq(FLIGHT_INFO_COL_INDEX[cls]));
            if (v != null) out[cls][key] = v;
        }
    });
    return out;
}

function getRoute() {
    // The General Flight Information block has the Departure/Arrival airport
    // codes as `<a href="airport?id=NNN">JFK</a>` inside the first td of those
    // rows. Pull them by row label so we don't depend on table column order.
    let hub = null, dest = null;
    $('h3').each(function() {
        const t = ($(this).text() || '').trim();
        if (t !== 'General Flight Information') return;
        const $rows = $(this).next('.as-panel').find('table tr');
        $rows.each(function() {
            const label = ($(this).find('th').first().text() || '').trim().toLowerCase();
            const code = ($(this).find('td a[href^="airport"]').first().text() || '').trim().toUpperCase();
            if (label === 'departure' && code) hub = code;
            else if (label === 'arrival' && code) dest = code;
        });
    });
    return (hub && dest) ? { hub: hub, dest: dest } : null;
}

function display() {
    let tableWell = $('<div class="as-table-well"></div>').append(buildTable());
    let p = $('<p></p>').html(saveDataSpan);
    let panel = $('<div class="as-panel"></div>').append(tableWell, p);
    let h = $('<h3></h3>').text('AES Flight Information');
    let div = $('<div></div>').append(h, panel);
    $('body > .container-fluid:eq(0) > h1:eq(0)').after(div);
}

function buildTable() {
    //head
    let th = [];
    th.push('<th></th>');
    th.push('<th class="aes-text-right">Y</th>');
    th.push('<th class="aes-text-right">C</th>');
    th.push('<th class="aes-text-right">F</th>');
    th.push('<th class="aes-text-right">PAX</th>');
    th.push('<th class="aes-text-right">Cargo</th>');
    th.push('<th class="aes-text-right">Total</th>');
    let hrow = $('<tr></tr>').append(th);
    let thead = $('<thead></thead>').append(hrow);
    //body
    let row = [];
    for (let cm in flightInfoData.money) {
        let td = [];
        td.push('<th>' + cm + '</th>');
        for (let cmp in flightInfoData.money[cm]) {
            td.push($('<td class="aes-text-right"></td>').html(AES.formatCurrency(flightInfoData.money[cm][cmp])));
        }
        row.push($('<tr></tr>').append(td));
    }
    let tbody = $('<tbody></tbody>').append(row);
    //foot
    let tf = [];
    tf.push('<th>Flight Id:</th>');
    tf.push('<th>' + flightInfoData.flightId + '</th>');
    tf.push('<th>Date:</th>');
    tf.push('<th>' + AES.formatDateString(flightInfoData.date) + ' ' + flightInfoData.time + '</th>');
    tf.push('<th></th>');
    tf.push('<th></th>');
    tf.push('<th></th>');
    let frow = $('<tr></tr>').append(tf);
    let fblankRow = $('<tr></tr>').append('<td colspan="7"></td>');
    let tfoot = $('<tfoot></tfoot>').append(fblankRow, frow);
    return $('<table class="aes-table table table-bordered table-striped table-hover"></table>').append(thead, tbody, tfoot);
}

function formatMoney(value) {
    let span = $('<span></span>');
    let text = '';
    if (value > 0) {
        span.addClass('good');
        text = '+'
    }
    if (value < 0) {
        span.addClass('bad');
    }
    text = text + value + ' AS$';
    span.text(text);
    return span;
}

function getFinancials() {
    let data = {};
    let cm = $('.cm');
    cm.each(function(index) {
        let contMargin = 'CM' + (index + 1);
        $('td', this).each(function(i) {
            let cmp;
            switch (i) {
                case 0:
                    cmp = 'Y'
                    break;
                case 1:
                    cmp = 'C'
                    break;
                case 2:
                    cmp = 'F'
                    break;
                case 3:
                    cmp = 'PAX'
                    break;
                case 4:
                    cmp = 'Cargo'
                    break;
                case 5:
                    cmp = 'Total'
                    break;
            }
            let value = AES.cleanInteger($(this).text());
            if (!data[contMargin]) {
                data[contMargin] = {}
            }
            data[contMargin][cmp] = value;
        });
    });
    return data;
}

function getFlightId() {
    let url = window.location.href;
    let a = url.split('id=');
    let b = a[1].split('&');
    return parseInt(b[0], 10);
}

function getServerName() {
    let server = window.location.hostname
    server = server.split('.');
    return server[0];
}
