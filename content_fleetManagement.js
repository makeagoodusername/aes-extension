"use strict";
//MAIN
//Global vars
var aircraftData = [];
var server,aircraftFleetKey,aircraftFleetStorageData,airlineName;
// Set by fltmng_buildFilterPanel.applyFilters whenever any filter select has
// a non-empty value. Read by fltmng_bindNativeSelectionLinks to decide
// whether to intercept AS's "select all/none/inverse" anchors.
var fltmngFilterActive = false;
var fltmngFleetTableObserver = null;
;(function fltmng_bootWhenReady(attempt){
  attempt = attempt || 0;
  const hasJquery = typeof window !== "undefined" && typeof window.$ === "function";
  const hasHelpers = typeof AES !== "undefined" || (typeof window !== "undefined" && window.AES);
  if(!hasJquery || !hasHelpers){
    if(attempt < 120){
      setTimeout(function(){ fltmng_bootWhenReady(attempt + 1); }, 50);
    } else {
      console.warn("[AES fleetManagement] dependencies not ready; skipping mount");
    }
    return;
  }
  $(function(){
    const boot = function(){
      if(fltmng_fleetManagementPageOpen()){
      aircraftData = [];
      fltmng_getData();
      //Async start
      fltmng_getStorageData();
      }
    };
    if(window.AesInit && typeof window.AesInit.safe === "function"){
      window.AesInit.safe("fleet-management.boot", boot);
    } else {
      try { boot(); }
      catch(err) { console.warn("[AES fleetManagement] boot failed", err); }
    }
  });
})();
function fltmng_fleetManagementPageOpen(){
  let a = $('.as-page-fleet-management');
  if(a.length){
    return true;
  } else {
    return false;
  }
}
function fltmng_getData(){
  //Global
  server = fltmng_getServerName();
  let date = AES.getServerDate()
  //Aircraft
  let table = $('.as-page-fleet-management > .row > .col-md-9 > .as-panel:eq(0) table');
  let fleet = $('.as-page-fleet-management > .row > .col-md-9 > h2:eq(0)').text();
  $('tbody tr',table).each(function(){
    // Use the row-level fallback so undelivered tails (no Flights/FlightPlanning
    // links yet) still produce an id where one exists. Tails without any id are
    // kept and persisted by registration via fltmng_isSameAircraft (item 19).
    let aircraftId = fltmng_getAircraftIdFromRow(this);
    if (aircraftId !== null && !fltmng_isValidAircraftId(aircraftId)) return;
    let seatsY = fltmng_getInt($('td:eq(5) > span:eq(0)',this).text());
    let seatsC = fltmng_getInt($('td:eq(5) > span:eq(1)',this).text());
    let seatsF = fltmng_getInt($('td:eq(5) > span:eq(2)',this).text());
    let pilotAssigned = fltmng_hasPilots(this);
    let data = {
      registration: $('td:eq(1) > span:eq(0)',this).text(),
      nickname: fltmng_getNickname($('td:eq(1) > div:eq(0)',this).text()),
      equipment:$('td:eq(2) > a:eq(0)',this).text(),
      typeId:fltmng_getTypeId($('td:eq(2) > a:eq(0)',this).attr('href')),
      age:fltmng_getAge($('td:eq(4) > span:eq(0)',this).text()),
      maintanance:fltmng_getMaintanance($('td:eq(4) > div > span:eq(1)',this).text()),
      seatsY:seatsY,
      seatsC:seatsC,
      seatsF:seatsF,
      // Upstream v0.7.6 alias names (alongside fork's seatsY/C/F). Both shapes
      // coexist so dashboards consuming either schema keep working.
      seatY:seatsY,
      seatC:seatsC,
      seatF:seatsF,
      aircraftId:aircraftId,
      note:fltmng_getNickname($('td:eq(7) > span > span',this).text()),
      // Home-base IATA from any /app/info/airports/<IATA> link in the row.
      // Source for ScrapeOrchestratorEnumerators.enumerateHubs — without it
      // the per-hub and per-route phases skip on a fresh install.
      location:fltmng_getLocation($('a[href*="/app/info/airports/"]:eq(0)',this).attr('href')),
      // Upstream v0.7.6 richer-extraction additions (CHANGELOG 0.7.6 / 0.7.7):
      delivered:fltmng_isDelivered(this),
      owned:fltmng_isOwned(this),
      pilotAssigned:pilotAssigned,
      pilotAssignedLabel: pilotAssigned ? 'Yes' : 'No',
      seatConfig:fltmng_getSeatConfig(this),
      totalSeats:fltmng_getTotalSeats(this),
      pureCargo:fltmng_isPureCargo(this),
      scheduleState:fltmng_getScheduleState(this),
      scheduleStateLabel:fltmng_getScheduleStateLabel(this),
      // Upstream alias for `maintanance` — keep both spellings so consumers of
      // either field (existing fork code uses `maintanance`; upstream uses
      // `maintenance`) work. Don't drop the legacy spelling.
      maintenance:fltmng_getMaintanance($('td:eq(4) > div > span:eq(1)',this).text()),
      fleet:fleet,
      date:date.date,
      time:date.time,
      // In-memory only — the storage envelope's Object.assign in
      // fltmng_updateAircraftFleetStorageData enumerates fields explicitly
      // and excludes `row`, so this stays out of chrome.storage.
      row: this
    }
    aircraftData.push(data);
  });
}
// Equipment column links to /action/enterprise/aircraftsType?id=<typeId>.
// Returns the integer typeId for use against the aircraft type detail page,
// or null if the page renders without that anchor (older AS versions).
function fltmng_getTypeId(href){
  if(!href) return null;
  const m = /aircraftsType\?id=(\d+)/.exec(href);
  return m ? parseInt(m[1],10) : null;
}
function fltmng_getNickname(value){
  if(value == '...'){
    return ''
  } else {
    return value;
  }
}
function fltmng_getAge(value){
  value = value.replace(/[a-z]/gi, '');
  value = value.replace(',','.');
  value = parseFloat(value);
  return value;
}
function fltmng_getMaintanance(value){
  value = value.replace('%','');
  value = value.replace(',','.');
  value = parseFloat(value);
  return value;
}
// Y/C/F seat-count column: each class has its own <span> separated by literal
// "/" text. Strip non-digits and parse — empty/missing classes return 0.
function fltmng_getInt(text){
  if(!text) return 0;
  const n = parseInt(String(text).replace(/[^\d]/g,''),10);
  return isFinite(n) ? n : 0;
}
// Tolerates absolute (`/app/fleets/aircraft/123/0`), relative (`../aircraft/123/`),
// query-suffixed (`aircraft/123?tab=...`), and bare (`aircraft/123`) forms.
// Falls back to the legacy `value.split('/')` slot scan if the regex misses,
// which is what the original fork-side helper did. Backport of upstream v0.7.6
// fltmng_getAircraftId hardening (CHANGELOG 0.7.6 — relative-path links).
function fltmng_getAircraftId(value){
    if (!value) return null;
    let match = String(value).match(/(?:\/app\/fleets\/|\.\.\/)*aircraft\/(\d+)(?:\/|[?#]|$)/);
    if (match) {
        const id = parseInt(match[1], 10);
        return fltmng_isValidAircraftId(id) ? id : null;
    }
    const parts = String(value).split('/');
    const fallback = parseInt(parts[parts.length-2], 10);
    return fltmng_isValidAircraftId(fallback) ? fallback : null;
}

// Last-resort row-level scrape: try every `aircraft/...` link and finally the
// row HTML itself. Used by callers that have a `<tr>` but no canonical link
// element. Backport of upstream v0.7.6 fltmng_getAircraftIdFromRow.
function fltmng_getAircraftIdFromRow(row){
    if (!row) return null;
    const $row = (row && row.jquery) ? row : $(row);
    let primary = $row.find('a[href*="aircraft/"][title="Flights"]').attr('href') ||
        $row.find('a[href*="aircraft/"][title="Flight Planning"]').attr('href') ||
        $row.find('a[href*="aircraft/"][href*="/1"]').attr('href') ||
        $row.find('a[href*="aircraft/"][href*="/0"]').attr('href') ||
        $row.find('a[href*="aircraft/"]').first().attr('href');
    let id = fltmng_getAircraftId(primary);
    if (id) return id;
    const hrefs = $row.find('a[href*="aircraft/"]').map(function(){ return $(this).attr('href'); }).get();
    for (let i = 0; i < hrefs.length; i++){
        id = fltmng_getAircraftId(hrefs[i]);
        if (id) return id;
    }
    const htmlMatch = ($row.html() || '').match(/(?:\/app\/fleets\/|\.\.\/)*aircraft\/(\d+)(?:\/|[?#]|$)/);
    if (htmlMatch) {
        const parsed = parseInt(htmlMatch[1], 10);
        return fltmng_isValidAircraftId(parsed) ? parsed : null;
    }
    return null;
}
function fltmng_isValidAircraftId(value){
    return Number.isFinite(value) && value > 0;
}
// Relaxed in upstream v0.7.6: undelivered tails carry no aircraftId yet but
// must still survive in storage so the merge against later scrapes (when AS
// assigns the id) finds them by registration. A record is valid if it has a
// usable aircraftId OR a non-empty registration.
function fltmng_isValidAircraftRecord(value){
    if (!value) return false;
    if (fltmng_isValidAircraftId(Number(value.aircraftId))) return true;
    return typeof value.registration === 'string' && value.registration.trim().length > 0;
}
function fltmng_getLocation(href){
    if (!href) return "";
    const m = /\/app\/info\/airports\/([A-Za-z]{3,4})/.exec(href);
    return m ? m[1].toUpperCase() : "";
}
// Backport of upstream v0.7.6 richer-extraction helpers (CHANGELOG 0.7.6).
// `delivered/owned/pilotAssigned/seatConfig/totalSeats/pureCargo/scheduleState`
// expose per-tail facets the fork's table lacked. Pure DOM reads, no I/O.
function fltmng_isDelivered(row){
    return $('td:eq(4)', row).text().indexOf('Delivery:') == -1;
}
function fltmng_getSeatConfig(row){
    return [
        fltmng_getInt($('td:eq(5) > span:eq(0)', row).text()),
        fltmng_getInt($('td:eq(5) > span:eq(1)', row).text()),
        fltmng_getInt($('td:eq(5) > span:eq(2)', row).text())
    ].join('/');
}
function fltmng_getTotalSeats(row){
    return fltmng_getInt($('td:eq(5) > span:eq(0)', row).text()) +
        fltmng_getInt($('td:eq(5) > span:eq(1)', row).text()) +
        fltmng_getInt($('td:eq(5) > span:eq(2)', row).text());
}
function fltmng_isPureCargo(row){
    return fltmng_getTotalSeats(row) === 0;
}
function fltmng_hasPilots(row){
    return $('td:eq(5) .subrow', row).text().trim().toLowerCase() == 'yes';
}
function fltmng_isOwned(row){
    let owned = '';
    $('.btn-group-contract .dropdown-menu li div', row).each(function(){
        let text = $(this).text().replace(/\s+/g, ' ').trim();
        if (text.indexOf('Owned:') == 0) {
            owned = $('span:last', this).text().trim();
            return false;
        }
    });
    return owned == 'yes';
}
function fltmng_getScheduleState(row){
    let flightPlanningBtn = $('a[title="Flight Planning"]', row);
    if (!flightPlanningBtn.length) {
        return fltmng_isDelivered(row) ? 'empty' : 'undelivered';
    }
    if (flightPlanningBtn.hasClass('btn-danger'))  return 'conflict';
    if (flightPlanningBtn.hasClass('btn-warning')) return 'pending';
    if (flightPlanningBtn.hasClass('btn-success')) return 'active';
    return 'empty';
}
// Human-readable label paired with `scheduleState`. Consumers (e.g. the
// Aircraft Profitability dashboard tile) map the label to a CSS color
// class via existing fork conventions: Active=good, Locked=warning,
// Conflict=bad, Empty/Undelivered=neutral.
function fltmng_getScheduleStateLabel(row){
    switch (fltmng_getScheduleState(row)) {
        case 'active':      return 'Active';
        case 'pending':     return 'Locked';
        case 'conflict':    return 'Conflict';
        case 'undelivered': return 'Undelivered';
        default:            return 'Empty';
    }
}
// Match by aircraftId OR registration so undelivered tails (no aircraftId
// yet) survive across scrapes keyed by their tail registration.
// Backport of upstream v0.7.6 `fltmng_isSameAircraft` (CHANGELOG 0.7.6).
function fltmng_isSameAircraft(storedAircraft, aircraft){
    if (!storedAircraft || !aircraft) return false;
    let storedId = storedAircraft.aircraftId || null;
    let aircraftId = typeof aircraft === 'object' ? (aircraft.aircraftId || null) : aircraft;
    if (storedId && aircraftId && String(storedId) === String(aircraftId)) {
        return true;
    }
    let storedRegistration = (storedAircraft.registration || '').trim();
    let aircraftRegistration = typeof aircraft === 'object' ? ((aircraft.registration || '').trim()) : '';
    if (storedRegistration && aircraftRegistration && storedRegistration === aircraftRegistration) {
        return true;
    }
    return false;
}
function fltmng_getStoredAircraft(data, aircraft){
    if (!data || !Array.isArray(data.fleet)) return null;
    for (let i = 0; i < data.fleet.length; i++) {
        if (fltmng_isSameAircraft(data.fleet[i], aircraft)) {
            return data.fleet[i];
        }
    }
    return null;
}
function fltmng_getStorageData(){
  let keys = [];
  aircraftData.forEach(function(value){
    // Skip undelivered tails — they have no aircraftId yet so there's no
    // `<server>aircraftFlights<id>` blob to look up. Avoids a bogus
    // `aircraftFlightsnull` key (which would otherwise fingerprint Chrome
    // storage and produce a phantom hit).
    if (!value.aircraftId) return;
    let key = server + 'aircraftFlights' + value.aircraftId;
    keys.push(key);
  });
  chrome.storage.local.get(keys, function(result) {
    for(let aircraftFlightData in result) {
      const rec = result[aircraftFlightData];
      if(!rec || typeof rec !== "object") continue;
      for (let i=0; i < aircraftData.length; i++) {
        if(aircraftData[i].aircraftId == rec.aircraftId){
          aircraftData[i].profit = {
            date:rec.date,
            finishedFlights:rec.finishedFlights,
            profit:rec.profit,
            profitFlights:rec.profitFlights,
            time:rec.time,
            totalFlights:rec.totalFlights,
          };
        }
      }
    }
    //Async
    fltmng_getAircraftStorageFleetData();
  });
}
function fltmng_getAircraftStorageFleetData(){
  airlineName = fltmng_getAirlineName();
  aircraftFleetKey = server + airlineName + 'aircraftFleet';
  chrome.storage.local.get(aircraftFleetKey, function(result) {
    fltmng_updateAircraftFleetStorageData(result[aircraftFleetKey]);
    fltmng_saveData();
  });
}
function fltmng_getAirlineName(){
  let el = document.querySelector("#as-navbar-main-collapse > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1) > span")
    || document.querySelector(".as-navbar-main a.name span:not(.caret)")
    || document.querySelector("a.name span:not(.caret)");
  let name = el ? (el.textContent || "") : "";
  if(!name && typeof AES !== "undefined" && AES.getAirlineIdentity){
    try { name = AES.getAirlineIdentity() || ""; } catch (_) {}
  }
  name = name.trim().replace(/[^A-Za-z0-9]/g, '');
  return name;
}
function fltmng_updateAircraftFleetStorageData(data){
  aircraftFleetStorageData = {
    server:server,
    type:'aircraftFleet',
    airline:airlineName,
    fleet:aircraftData
  }
  if(data && Array.isArray(data.fleet)){
    let newfleet = [];
    //Push all new aircrafts
    aircraftData.forEach(function(newvalue){
      if(!fltmng_isValidAircraftRecord(newvalue)) return;
      // Look up any existing stored record by aircraftId OR registration so
      // an undelivered tail (id null) carrying prior nickname/note/HUB
      // metadata is preserved across the rewrite. Backport of upstream v0.7.6
      // fltmng_getStoredAircraft (CHANGELOG 0.7.6 / 0.7.7).
      let storedAircraft = fltmng_getStoredAircraft(data, newvalue);
      newfleet.push(Object.assign({}, storedAircraft || {}, {
        age:newvalue.age,
        aircraftId:newvalue.aircraftId || (storedAircraft && storedAircraft.aircraftId ? storedAircraft.aircraftId : null),
        date:newvalue.date,
        delivered:newvalue.delivered,
        equipment:newvalue.equipment,
        typeId:newvalue.typeId || (storedAircraft && storedAircraft.typeId ? storedAircraft.typeId : null),
        fleet:newvalue.fleet,
        location:newvalue.location || (storedAircraft && storedAircraft.location ? storedAircraft.location : ''),
        maintanance:newvalue.maintanance,
        // Upstream alias kept alongside fork's `maintanance` spelling.
        maintenance:newvalue.maintenance,
        nickname:newvalue.nickname,
        note:newvalue.note,
        owned:newvalue.owned,
        pilotAssigned:newvalue.pilotAssigned,
        pilotAssignedLabel:newvalue.pilotAssignedLabel,
        pureCargo:newvalue.pureCargo,
        registration:newvalue.registration,
        scheduleState:newvalue.scheduleState,
        scheduleStateLabel:newvalue.scheduleStateLabel,
        // Persist both shapes (legacy fork seatsY/C/F + upstream seatY/C/F).
        seatsY:(newvalue.seatsY != null ? newvalue.seatsY : (storedAircraft ? storedAircraft.seatsY : undefined)),
        seatsC:(newvalue.seatsC != null ? newvalue.seatsC : (storedAircraft ? storedAircraft.seatsC : undefined)),
        seatsF:(newvalue.seatsF != null ? newvalue.seatsF : (storedAircraft ? storedAircraft.seatsF : undefined)),
        seatY:newvalue.seatY,
        seatC:newvalue.seatC,
        seatF:newvalue.seatF,
        seatConfig:newvalue.seatConfig,
        totalSeats:newvalue.totalSeats,
        time:newvalue.time
      }));
    });

    //push all old aircrafts that dont have new data
    data.fleet.forEach(function(value){
      if(!fltmng_isValidAircraftRecord(value)) return;
      let found = 0;
      newfleet.forEach(function(newValue){
        // Match by aircraftId OR registration so undelivered tails (no id yet)
        // remain merged across scrapes.
        if(fltmng_isSameAircraft(value, newValue)){
          found = 1;
        }
      });
      if(!found){
        newfleet.push(value);
      }
    });
    //Attach new fleet
    aircraftFleetStorageData.fleet = newfleet;
  }
}
function fltmng_saveData(){
  //Remove profit

  chrome.storage.local.set({[aircraftFleetKey]: aircraftFleetStorageData}, function() {
    if(window.AesInit && typeof window.AesInit.safe === "function"){
      window.AesInit.safe("fleet-management.display", fltmng_display);
    } else {
      try { fltmng_display(); }
      catch(err) { console.warn("[AES fleetManagement] display failed", err); }
    }
  });
}

function fltmng_display(){
  fltmng_displayAircraftProfit();

  let p = [];
  p.push($('<p></p>').html(fltmng_displaySavedAircrafts()));
  p.push($('<p></p>').html(fltmng_displayNewUpdates()));
  // Item 12 wire-up: filter panel from upstream v0.7.7 (content_fleetManagement
  // .js lines 567-650). Native selection-link interception runs separately
  // since the link targets live outside the panel.
  p.push(fltmng_buildFilterPanel());

  let panel = $('<div class="as-panel"></div>').append(p);
  //Header
  let h = $('<h3></h3>').text('AES Fleet Management');
  let div = $('<div></div>').append(h,panel);
  $('.as-page-fleet-management > h1:eq(0)').after(div);

  fltmng_bindNativeSelectionLinks();
  fltmng_watchFleetTable();
}
function fltmng_displayAircraftProfit(){
  let table = $('.as-page-fleet-management > .row > .col-md-9 > .as-panel:eq(0) table');
  if (!table.length) return;
  // Idempotency: when the MutationObserver re-fires displayAircraftProfit
  // after AS rerenders the fleet table, strip any prior AES-added headers /
  // cells before re-adding. Otherwise each rerender would duplicate the HUB
  // column and trailing Profit/Extract-date columns.
  $('.aes-fleet-extra-header', table).remove();
  $('.aes-fleet-extra-cell', table).remove();
  //Head — upstream v0.7.6 rename "Aircraft model" -> "Model" + HUB column
  //insert (CHANGELOG 0.7.6). Previously rendered headers stay; we only edit
  //the equipment-column text and add the new HUB/Profit/Extract-date <th>s.
  let modelHeader = $('thead tr:eq(0) th:eq(2)', table);
  if (modelHeader.length && modelHeader.html()) {
    modelHeader.html(modelHeader.html().replace('Aircraft model', 'Model'));
  }
  modelHeader.after('<th rowspan="2" class="aes-fleet-extra-header text-center">HUB</th>');
  //Profit / Extract-date headers — centered per upstream pattern.
  let th = [
    '<th rowspan="2" class="aes-fleet-extra-header text-center aes-text-right">Profit/Loss</th>',
    '<th rowspan="2" class="aes-fleet-extra-header text-center">Extract date</th>'
  ];
  $('thead tr:eq(0)',table).append(th);
  //Body
  $('tbody tr',table).each(function(){
    let id = fltmng_getAircraftIdFromRow(this);
    let registration = $('td:eq(1) > span:eq(0)', this).text().trim();
    let hub = '';
    let profit,date,time;
    aircraftData.forEach(function(value){
      let matches = (id && value.aircraftId == id) ||
        (!id && registration && value.registration === registration);
      if (matches) {
        hub = value.location || '';
        if (value.profit && value.profit.profitFlights) {
          profit = value.profit.profit;
          date = value.profit.date;
          time = value.profit.time;
        }
      }
    });
    //HUB column inserted after the equipment column (matches new <th> order).
    $('td:eq(2)', this).after(
      $('<td class="aes-fleet-extra-cell text-center"></td>').text(hub || '--')
    );
    let td = [];
    if(date){
      td.push(fltmng_formatMoney(profit));
      td.push($('<td class="aes-fleet-extra-cell"></td>').html(AES.formatDateString(date)+'<br>'+time));
    } else {
      //Upstream v0.7.6 table-presentation polish: centered "--" placeholder
      //instead of empty <td></td> (CHANGELOG 0.7.6).
      td.push('<td class="aes-fleet-extra-cell text-center">--</td>',
              '<td class="aes-fleet-extra-cell text-center">--</td>');
    }
    $(this).append(td);

  });
}
function fltmng_displaySavedAircrafts(){
  let text = 'Currently '+aircraftFleetStorageData.fleet.length+' aircrafts stored in memory.';
  // Surface the new behaviour from item 19: undelivered tails (no aircraftId
  // yet) are kept by registration and merged once AS assigns the id.
  if (aircraftData.some(function(value){ return !value.aircraftId; })) {
    text += ' Undelivered aircraft are stored by registration and will be merged once AirlineSim assigns an aircraft ID.';
  }
  return text;
}
function fltmng_displayNewUpdates(){
  if(!aircraftData.length){
    return $('<span class="warning"></span>').text('No aircraft rows found on this fleet page.');
  }
  let span = $('<span class="good"></span>').text('Updated aircraft data for '+aircraftData.length+ ' from '+aircraftData[0].fleet);
  return span;
}
function fltmng_getServerName(){
  let server = window.location.hostname
  server = server.split('.');
  return server[0];
}
function fltmng_formatMoney(value){
  let container = document.createElement("td")
  let formattedValue = Intl.NumberFormat().format(value)
  let indicatorEl = document.createElement("span")
  let valueEl = document.createElement("span")
  let currencyEl = document.createElement("span")
  
  if (value >= 0) {
    valueEl.classList.add("good")
    indicatorEl.innerText = "+"
  }
  
  if (value < 0) {
    valueEl.classList.add("bad")
    indicatorEl.innerText = "-"
    formattedValue = formattedValue.replace("-", "")
  }
  
  valueEl.innerText = formattedValue
  currencyEl.innerText = " AS$"
  
  container.classList.add("aes-text-right", "aes-no-text-wrap")
  container.append(indicatorEl, valueEl, currencyEl)
  
  return container
}

// ---------------------------------------------------------------------------
// Item 12 (upstream v0.7.7) — Fleet filter panel + native-selection-link
// integration + MutationObserver scaffold. Backports
// `/AirlineSim-Enhancement-Suite-main/extension/content_fleetManagement.js`
// lines 567-725 + 748-774 with one fork-friendly tweak: `fltmng_getResolvedHub`
// also falls back to fork's `value.location` (the per-row IATA scrape from
// `/app/info/airports/...`) so the HUB filter has values before the per-tail
// content_aircraftFlights HUB-detect/override pass populates the
// hubDetected/hubEffective/hubOverride fields.

function fltmng_buildFilterPanel(){
  let equipmentSelect = fltmng_buildFilterSelect('All models', fltmng_getUniqueAircraftValues('equipment'));
  let hubSelect = fltmng_buildFilterSelect('All HUBs', fltmng_getUniqueAircraftHubValues());
  let seatConfigSelect = fltmng_buildFilterSelect('All seat configs', fltmng_getUniqueAircraftValues('seatConfig'));
  let deliverySelect = fltmng_buildFilterSelect('All delivery states', [
    { value: 'delivered', label: 'Delivered' },
    { value: 'undelivered', label: 'Undelivered' }
  ]);
  let ownershipSelect = fltmng_buildFilterSelect('All ownership', [
    { value: 'owned', label: 'Owned' },
    { value: 'leased', label: 'Leased' }
  ]);
  let scheduleSelect = fltmng_buildFilterSelect('All schedules', [
    { value: 'active', label: 'Active' },
    { value: 'empty', label: 'Empty' },
    { value: 'pending', label: 'Locked' },
    { value: 'conflict', label: 'Conflict' },
    { value: 'undelivered', label: 'Undelivered' }
  ]);
  let resetBtn = $('<button type="button" class="btn btn-default"></button>').text('Reset filters');
  let status = $('<span class="text-muted"></span>');

  let form = $('<div class="row"></div>').append(
    fltmng_wrapFilterControl('Model', equipmentSelect),
    fltmng_wrapFilterControl('HUB', hubSelect),
    fltmng_wrapFilterControl('Seats (Y/C/F)', seatConfigSelect),
    fltmng_wrapFilterControl('Delivery', deliverySelect),
    fltmng_wrapFilterControl('Ownership', ownershipSelect),
    fltmng_wrapFilterControl('Schedule', scheduleSelect),
    $('<div class="col-md-12" style="margin-top: 8px;"></div>').append(resetBtn, ' ', status)
  );

  [equipmentSelect, hubSelect, seatConfigSelect, deliverySelect, ownershipSelect, scheduleSelect].forEach(function(select){
    select.change(applyFilters);
  });
  resetBtn.click(function(){
    equipmentSelect.val('');
    hubSelect.val('');
    seatConfigSelect.val('');
    deliverySelect.val('');
    ownershipSelect.val('');
    scheduleSelect.val('');
    applyFilters();
  });

  applyFilters();
  return $('<div></div>').append(
    $('<p><strong>AES filters</strong></p>'),
    form
  );

  function applyFilters(){
    let visibleCount = 0;
    let selectionStateChanged = false;
    let refreshCheckbox = null;
    aircraftData.forEach(function(value){
      let visible =
        (!equipmentSelect.val() || value.equipment == equipmentSelect.val()) &&
        (!hubSelect.val() || fltmng_getResolvedHub(value) == hubSelect.val()) &&
        (!seatConfigSelect.val() || value.seatConfig == seatConfigSelect.val()) &&
        (!deliverySelect.val() || (deliverySelect.val() == 'delivered' ? value.delivered : !value.delivered)) &&
        (!ownershipSelect.val() || (ownershipSelect.val() == 'owned' ? value.owned : !value.owned)) &&
        (!scheduleSelect.val() || value.scheduleState == scheduleSelect.val());
      if (value.row) {
        $(value.row).toggle(visible);
        if (!visible) {
          let rowCheckbox = $('input[type="checkbox"][name="aircraftsContainer"]', value.row).get(0);
          if (rowCheckbox && rowCheckbox.checked) {
            rowCheckbox.checked = false;
            selectionStateChanged = true;
            refreshCheckbox = refreshCheckbox || rowCheckbox;
          }
        }
      }
      if (visible) visibleCount++;
    });
    fltmngFilterActive = !!(equipmentSelect.val() || hubSelect.val() || seatConfigSelect.val() || deliverySelect.val() || ownershipSelect.val() || scheduleSelect.val());
    status.text('Showing ' + visibleCount + ' of ' + aircraftData.length + ' aircraft' + (fltmngFilterActive ? '. Selection links apply to visible aircraft only.' : ''));
    if (selectionStateChanged) fltmng_refreshNativeSelectionState(refreshCheckbox);
  }
}

function fltmng_wrapFilterControl(label, control){
  return $('<div class="col-md-2 col-sm-4" style="margin-top: 8px;"></div>').append(
    $('<label class="control-label"></label>').text(label),
    control
  );
}

function fltmng_buildFilterSelect(placeholder, values){
  let select = $('<select class="form-control"></select>').append(
    $('<option value=""></option>').text(placeholder)
  );
  values.forEach(function(value){
    if (typeof value == 'string') {
      select.append($('<option></option>').val(value).text(value));
    } else {
      select.append($('<option></option>').val(value.value).text(value.label));
    }
  });
  return select;
}

function fltmng_getUniqueAircraftValues(key){
  let values = aircraftData.map(function(value){ return value[key]; }).filter(function(value){
    return value !== undefined && value !== null && value !== '';
  });
  values = values.filter(function(value, index){ return values.indexOf(value) == index; });
  values.sort();
  return values;
}

function fltmng_getUniqueAircraftHubValues(){
  let values = aircraftData.map(function(value){ return fltmng_getResolvedHub(value); }).filter(function(value){
    return value !== undefined && value !== null && value !== '';
  });
  values = values.filter(function(value, index){ return values.indexOf(value) == index; });
  values.sort();
  return values;
}

// Resolution priority: explicit override > flights-page-detected effective hub
// > flights-page-detected raw hub > profit envelope's stored hubs > per-row
// IATA scrape (fork-only). The trailing `location` fallback is a fork
// extension of upstream's chain so the HUB filter has data before the
// per-tail aircraftFlights pass populates hubDetected.
function fltmng_getResolvedHub(value){
  if (!value) return '';
  if (value.hubOverride) return value.hubOverride;
  if (value.hubEffective) return value.hubEffective;
  if (value.hubDetected) return value.hubDetected;
  if (value.profit) {
    let p = value.profit.hubOverride || value.profit.hubEffective || value.profit.hubDetected;
    if (p) return p;
  }
  if (value.location) return value.location;
  return '';
}

function fltmng_refreshNativeSelectionState(checkbox){
  let target = checkbox || document.querySelector('.as-page-fleet-management input[type="checkbox"][name="aircraftsContainer"]');
  if (!target) return;
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function fltmng_bindNativeSelectionLinks(){
  let selectionLinks = document.querySelectorAll(
    '.as-page-fleet-management a[href*="select~all"], ' +
    '.as-page-fleet-management a[href*="select~none"], ' +
    '.as-page-fleet-management a[href*="select~inverse"]'
  );
  selectionLinks.forEach(function(link){
    if (link.dataset.aesFleetSelectionBound === '1') return;
    link.dataset.aesFleetSelectionBound = '1';
    link.addEventListener('click', function(event){
      if (!fltmngFilterActive) return;
      let fleetTable = $('.as-page-fleet-management > .row > .col-md-9 > .as-panel:eq(0) table');
      if (!fleetTable.length) return;
      let href = String(link.getAttribute('href') || '');
      let action = '';
      if (href.indexOf('select~all') != -1) action = 'all';
      else if (href.indexOf('select~none') != -1) action = 'none';
      else if (href.indexOf('select~inverse') != -1) action = 'invert';
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      let visibleCheckboxes = $('tbody tr:visible input[type="checkbox"][name="aircraftsContainer"]', fleetTable);
      let refreshCheckbox = visibleCheckboxes.get(0) || document.querySelector('.as-page-fleet-management input[type="checkbox"][name="aircraftsContainer"]');
      switch (action) {
        case 'all':    visibleCheckboxes.prop('checked', true);  break;
        case 'none':   visibleCheckboxes.prop('checked', false); break;
        case 'invert': visibleCheckboxes.each(function(){ $(this).prop('checked', !$(this).prop('checked')); }); break;
      }
      fltmng_refreshNativeSelectionState(refreshCheckbox);
    }, true);
  });
}

// MutationObserver scaffold: AS occasionally rerenders the fleet table (sort,
// pagination, refresh button). Re-apply AES filter + extra columns + selection
// link bindings after each rerender. Loop-guard via observer disconnect-
// reconnect (upstream pattern) so AES's own DOM mutations don't retrigger.
function fltmng_watchFleetTable(){
  if (fltmngFleetTableObserver) {
    try { fltmngFleetTableObserver.disconnect(); } catch (_) {}
    fltmngFleetTableObserver = null;
  }
  let target = document.querySelector('.as-page-fleet-management') || document.body;
  if (!target) return;
  fltmngFleetTableObserver = new MutationObserver(function(mutations){
    let needsRefresh = mutations.some(function(m){
      for (let i = 0; i < m.addedNodes.length; i++) {
        let node = m.addedNodes[i];
        if (fltmng_isFleetTableNode(node)) return true;
      }
      return false;
    });
    if (!needsRefresh) return;
    fltmngFleetTableObserver.disconnect();
    try {
      // Re-extract row→aircraftData refs (rows may be new objects), then
      // refresh the AES presentation overlay and selection bindings.
      aircraftData = [];
      fltmng_getData();
      fltmng_displayAircraftProfit();
      fltmng_bindNativeSelectionLinks();
    } catch (err) {
      console.warn('[AES fleetManagement] table-refresh re-apply failed', err);
    }
    // Reattach observer after AES mutations settle.
    setTimeout(function(){
      if (fltmngFleetTableObserver) fltmngFleetTableObserver.observe(target, { childList: true, subtree: true });
    }, 0);
  });
  fltmngFleetTableObserver.observe(target, { childList: true, subtree: true });
}

function fltmng_isFleetTableNode(node){
  if (!node || node.nodeType !== 1) return false;
  if (node.matches && node.matches('table, tbody, tr')) return true;
  if (node.querySelector && node.querySelector('input[name="aircraftsContainer"]')) return true;
  return false;
}
