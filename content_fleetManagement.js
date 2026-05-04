"use strict";
//MAIN
//Global vars
var aircraftData = [];
var server,aircraftFleetKey,aircraftFleetStorageData,airlineName;
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
    let aircraftId = fltmng_getAircraftId($('td:eq(6) > div > div:eq(1) > a:eq(0)',this).attr('href'));
    if(!fltmng_isValidAircraftId(aircraftId)) return;
    let data = {
      registration: $('td:eq(1) > span:eq(0)',this).text(),
      nickname: fltmng_getNickname($('td:eq(1) > div:eq(0)',this).text()),
      equipment:$('td:eq(2) > a:eq(0)',this).text(),
      typeId:fltmng_getTypeId($('td:eq(2) > a:eq(0)',this).attr('href')),
      age:fltmng_getAge($('td:eq(4) > span:eq(0)',this).text()),
      maintanance:fltmng_getMaintanance($('td:eq(4) > div > span:eq(1)',this).text()),
      seatsY:fltmng_getInt($('td:eq(5) > span:eq(0)',this).text()),
      seatsC:fltmng_getInt($('td:eq(5) > span:eq(1)',this).text()),
      seatsF:fltmng_getInt($('td:eq(5) > span:eq(2)',this).text()),
      aircraftId:aircraftId,
      note:fltmng_getNickname($('td:eq(7) > span > span',this).text()),
      // Home-base IATA from any /app/info/airports/<IATA> link in the row.
      // Source for ScrapeOrchestratorEnumerators.enumerateHubs — without it
      // the per-hub and per-route phases skip on a fresh install.
      location:fltmng_getLocation($('a[href*="/app/info/airports/"]:eq(0)',this).attr('href')),
      fleet:fleet,
      date:date.date,
      time:date.time
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
function fltmng_isValidAircraftRecord(value){
    return !!(value && fltmng_isValidAircraftId(Number(value.aircraftId)));
}
function fltmng_getLocation(href){
    if (!href) return "";
    const m = /\/app\/info\/airports\/([A-Za-z]{3,4})/.exec(href);
    return m ? m[1].toUpperCase() : "";
}
function fltmng_getStorageData(){
  let keys = [];
  aircraftData.forEach(function(value){
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
      newfleet.push({
        age:newvalue.age,
        aircraftId:newvalue.aircraftId,
        date:newvalue.date,
        equipment:newvalue.equipment,
        typeId:newvalue.typeId,
        fleet:newvalue.fleet,
        location:newvalue.location,
        maintanance:newvalue.maintanance,
        nickname:newvalue.nickname,
        note:newvalue.note,
        registration:newvalue.registration,
        seatsY:newvalue.seatsY,
        seatsC:newvalue.seatsC,
        seatsF:newvalue.seatsF,
        time:newvalue.time
      });
    });

    //push all old aircrafts that dont have new data
    data.fleet.forEach(function(value){
      if(!fltmng_isValidAircraftRecord(value)) return;
      let found = 0;
      newfleet.forEach(function(newValue){
        if(value.aircraftId == newValue.aircraftId){
          //Preserve typeId on aircraft we re-saw — earlier scrapes (pre-Phase 2)
          //didn't capture it, so backfill from the live page when available.
          if(!newValue.typeId && value.typeId) newValue.typeId = value.typeId;
          //Same backfill for the per-tail seats columns when the live page
          //didn't render them (e.g. unconfigured aircraft).
          if(newValue.seatsY == null && value.seatsY != null) newValue.seatsY = value.seatsY;
          if(newValue.seatsC == null && value.seatsC != null) newValue.seatsC = value.seatsC;
          if(newValue.seatsF == null && value.seatsF != null) newValue.seatsF = value.seatsF;
          if(!newValue.location && value.location) newValue.location = value.location;
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

  let panel = $('<div class="as-panel"></div>').append(p);
  //Header
  let h = $('<h3></h3>').text('AES Fleet Management');
  let div = $('<div></div>').append(h,panel);
  $('.as-page-fleet-management > h1:eq(0)').after(div);
}
function fltmng_displayAircraftProfit(){
  let table = $('.as-page-fleet-management > .row > .col-md-9 > .as-panel:eq(0) table');
  //Head
  let th = ['<th rowspan="2" class="aes-text-right">Profit/Loss</th>','<th rowspan="2">Extract date</th>'];
  $('thead tr:eq(0)',table).append(th);
  //Body
  $('tbody tr',table).each(function(){
    let id  = fltmng_getAircraftId($('td:eq(6) > div > div:eq(1) > a:eq(0)',this).attr('href'));
    let profit,date,time;
    aircraftData.forEach(function(value){
      if(value.aircraftId == id){
        if(value.profit){
          if(value.profit.profitFlights){
            profit = value.profit.profit;
            date = value.profit.date;
            time = value.profit.time;
          }
        }
      }
    });
    let td = [];
    if(date){
      td.push(fltmng_formatMoney(profit));
      td.push($('<td></td>').html(AES.formatDateString(date)+'<br>'+time));
    } else {
      td.push('<td></td>','<td></td>');
    }
    $(this).append(td);

  });
}
function fltmng_displaySavedAircrafts(){
  return 'Currently '+aircraftFleetStorageData.fleet.length+' aircrafts stored in memory.';
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
