"use strict";
//MAIN
//Global vars
var aircraftData = [];
var server,aircraftFleetKey,aircraftFleetStorageData,airlineName;
;(function fltmng_bootWhenReady(attempt){
  attempt = attempt || 0;

  const hasHelpers = typeof AES !== "undefined" || (typeof window !== "undefined" && window.AES);
  if (!hasHelpers) {
    if (attempt < 120) {
      setTimeout(function(){ fltmng_bootWhenReady(attempt + 1); }, 50);
    } else {
      console.warn("[AES fleetManagement] AES dependencies not ready; skipping mount");
    }
    return;
  }

  // Remove the tight bootloop waiting for jQuery. Use vanilla JS instead.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fltmng_init);
  } else {
    fltmng_init();
  }
})();

function fltmng_init() {
  if(fltmng_fleetManagementPageOpen()){
    fltmng_getData();
    //Async start
    fltmng_getStorageData();
  }
}

function fltmng_fleetManagementPageOpen(){
  return document.querySelector('.as-page-fleet-management') !== null;
}
function fltmng_getData(){
  //Global
  server = fltmng_getServerName();
  let date = (typeof window !== "undefined" && window.AES) ? window.AES.getServerDate() : AES.getServerDate();
  //Aircraft
  let table = document.querySelector('.as-page-fleet-management > .row > .col-md-9 > .as-panel table');
  let h2 = document.querySelector('.as-page-fleet-management > .row > .col-md-9 > h2');
  let fleet = h2 ? h2.textContent.trim() : "";

  if (!table) return;

  let tbody = table.querySelector('tbody');
  if (!tbody) return;

  let rows = tbody.querySelectorAll('tr');
  rows.forEach(function(row){
    let cells = row.querySelectorAll('td');
    if (cells.length < 8) return;

    let divs = cells[6].querySelectorAll('div > div');
    if (divs.length < 2) return;
    let hrefEl = divs[1].querySelector('a');
    if (!hrefEl) return;
    let aircraftId = fltmng_getAircraftId(hrefEl.getAttribute('href'));
    if(!fltmng_isValidAircraftId(aircraftId)) return;

    let registrationEl = cells[1].querySelector('span');
    let nicknameEl = cells[1].querySelector('div');
    let equipmentEl = cells[2].querySelector('a');
    let ageEl = cells[4].querySelector('span');
    let maintEl = cells[4].querySelectorAll('div > span')[1];
    let seatsYEl = cells[5].querySelectorAll('span')[0];
    let seatsCEl = cells[5].querySelectorAll('span')[1];
    let seatsFEl = cells[5].querySelectorAll('span')[2];
    let noteEl = cells[7].querySelector('span > span');
    let locationHrefEl = row.querySelector('a[href*="/app/info/airports/"]');

    let data = {
      registration: registrationEl ? registrationEl.textContent.trim() : "",
      nickname: nicknameEl ? fltmng_getNickname(nicknameEl.textContent.trim()) : "",
      equipment: equipmentEl ? equipmentEl.textContent.trim() : "",
      typeId: equipmentEl ? fltmng_getTypeId(equipmentEl.getAttribute('href')) : null,
      age: ageEl ? fltmng_getAge(ageEl.textContent.trim()) : 0,
      maintanance: maintEl ? fltmng_getMaintanance(maintEl.textContent.trim()) : 0,
      seatsY: seatsYEl ? fltmng_getInt(seatsYEl.textContent.trim()) : 0,
      seatsC: seatsCEl ? fltmng_getInt(seatsCEl.textContent.trim()) : 0,
      seatsF: seatsFEl ? fltmng_getInt(seatsFEl.textContent.trim()) : 0,
      aircraftId: aircraftId,
      note: noteEl ? fltmng_getNickname(noteEl.textContent.trim()) : "",
      location: locationHrefEl ? fltmng_getLocation(locationHrefEl.getAttribute('href')) : "",
      fleet: fleet,
      date: date.date,
      time: date.time
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
function fltmng_getAircraftId(value){
    if (value) {
        value = value.split('/');
        const id = parseInt(value[value.length-2],10);
        return fltmng_isValidAircraftId(id) ? id : null;
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
      for (let i=0; i < aircraftData.length; i++) {
        if(aircraftData[i].aircraftId == result[aircraftFlightData].aircraftId){
          aircraftData[i].profit = {
            date:result[aircraftFlightData].date,
            finishedFlights:result[aircraftFlightData].finishedFlights,
            profit:result[aircraftFlightData].profit,
            profitFlights:result[aircraftFlightData].profitFlights,
            time:result[aircraftFlightData].time,
            totalFlights:result[aircraftFlightData].totalFlights,
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
  if(data){
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
    fltmng_display();
  });
}

function fltmng_display(){
  fltmng_displayAircraftProfit();

  let p1 = document.createElement("p");
  p1.innerHTML = fltmng_displaySavedAircrafts();

  let p2 = document.createElement("p");
  p2.appendChild(fltmng_displayNewUpdates());

  let panel = document.createElement("div");
  panel.className = "as-panel";
  panel.appendChild(p1);
  panel.appendChild(p2);

  //Header
  let h = document.createElement("h3");
  h.textContent = 'AES Fleet Management';
  let div = document.createElement("div");
  div.appendChild(h);
  div.appendChild(panel);

  let h1 = document.querySelector('.as-page-fleet-management > h1');
  if (h1 && h1.nextSibling) {
    h1.parentNode.insertBefore(div, h1.nextSibling);
  } else if (h1) {
    h1.parentNode.appendChild(div);
  }
}
function fltmng_displayAircraftProfit(){
  let table = document.querySelector('.as-page-fleet-management > .row > .col-md-9 > .as-panel table');
  if (!table) return;
  //Head
  let theadRow = table.querySelector('thead tr');
  if (theadRow) {
    let th1 = document.createElement("th");
    th1.rowSpan = 2;
    th1.className = "aes-text-right";
    th1.textContent = "Profit/Loss";
    let th2 = document.createElement("th");
    th2.rowSpan = 2;
    th2.textContent = "Extract date";
    theadRow.appendChild(th1);
    theadRow.appendChild(th2);
  }
  //Body
  let tbodyRows = table.querySelectorAll('tbody tr');
  tbodyRows.forEach(function(row){
    let cells = row.querySelectorAll('td');
    if (cells.length < 8) return;
    let divs = cells[6].querySelectorAll('div > div');
    if (divs.length < 2) return;
    let hrefEl = divs[1].querySelector('a');
    if (!hrefEl) return;
    let id = fltmng_getAircraftId(hrefEl.getAttribute('href'));

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

    if(date){
      row.appendChild(fltmng_formatMoney(profit));
      let td2 = document.createElement("td");
      td2.innerHTML = ((typeof window !== "undefined" && window.AES) ? window.AES.formatDateString(date) : AES.formatDateString(date)) + '<br>' + time;
      row.appendChild(td2);
    } else {
      let td1 = document.createElement("td");
      let td2 = document.createElement("td");
      row.appendChild(td1);
      row.appendChild(td2);
    }
  });
}
function fltmng_displaySavedAircrafts(){
  return 'Currently '+aircraftFleetStorageData.fleet.length+' aircrafts stored in memory.';
}
function fltmng_displayNewUpdates(){
  let span = document.createElement("span");
  if(!aircraftData.length){
    span.className = "warning";
    span.textContent = 'No aircraft rows found on this fleet page.';
    return span;
  }
  span.className = "good";
  span.textContent = 'Updated aircraft data for '+aircraftData.length+ ' from '+aircraftData[0].fleet;
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
