"use strict";
//MAIN
//Global vars
var settings,server,airline;

function savePersonelManagementSettings(done){
  Promise.resolve(window.AesSettings.saveArea('personelManagement', settings.personelManagement))
    .then(function(){ if(typeof done === 'function') done(); });
}

$(function(){
  chrome.storage.local.get(['settings'], function(result) {
    settings = AES.normalizeSettings(result.settings);
    server = getServerName();
    airline = getAirline();

    displayPersonelManagement();
  });
});
function displayPersonelManagement(){
  //Header rows
  let th = $('<tr></tr>').append('<th>Value</th>','<th>Type</th>');
  let thead = $('<thead></thead>').append(th);
  //body rows
  let td = [];
  //Value
  let input = $('<input type="text" id="aes-input-personelManagement-value" class="form-control number" style="min-width: 50px;">').val(settings.personelManagement.value);

  //Select type
  let option = [];
  option.push('<option value="absolute">AS$</option>');
  option.push('<option value="perc">%</option>');
  let select = $('<select id="aes-select-personelManagement-type" class="form-control"></select>').append(option);
  select.val(settings.personelManagement.type);


  td.push($('<td></td>').html(input));
  td.push($('<td></td>').html(select));

  let bRow = $('<tr></tr>').append(td);
  let tbody = $('<tbody></tbody>').append(bRow);


  let table = $('<table class="table table-bordered"></table>').append(thead,tbody);
  let tableWell = $('<div class="as-table-well"></div>').append(table);
  //Text
  let p = $('<p></p>').text('Select value (either absolute AS$ value or % value) to keep your personels salary in regards to country average. You can enter negative or positive values.');

  //buttons
  let btn = $('<button type="button" class="btn btn-default">apply salary</button>');
  //Span
  let span = $('<span></span>');


  let leftDiv = $('<div class="col-md-3"></div>').append(tableWell);
  let row = $('<div class="row"></div>').append(leftDiv);

  let panel = $('<div class="as-panel"></div>').append(p,row,btn,span);

  //Final
  let mainDiv = $(".container-fluid:eq(2) h1");
  mainDiv.after('<h3>AirlineSim Enhancement Suite Personel Management</h3>',panel);

  //actions
  select.change(function(){
    settings.personelManagement.type = select.val();
    savePersonelManagementSettings();
  });
  input.change(function(){
    settings.personelManagement.value = AES.cleanInteger(input.val());
    savePersonelManagementSettings();
  });


  btn.click( function(){
    span.removeClass().addClass('warning').text(' adjusting...');
    //Set button for auto click
    settings.personelManagement.auto = 1;
    settings.personelManagement.alreadyUpdated = [];
    priceUpdate(span);
  });

  //Automation
  if(settings.personelManagement.auto){
    span.removeClass().addClass('warning').text(' adjusting...');
    priceUpdate(span);
  }

  //Previous data
  let key = server+airline+"personelManagement";
  chrome.storage.local.get([key], function(result) {
    if(result[key]){
      p.after($('<p></p>').text('Last time updated on '+AES.formatDateString(result[key].date)+' '+result[key].time));
    } else {
      p.after($('<p></p>').text('No previous personel management data found.'));
    }
  });
}
// Upstream v0.7.0 backport: iterate every adjustable row in one pass with
// per-row form-submit + 100ms debounce, instead of the legacy "click one,
// require a full page refresh, re-enter via settings.auto" loop. Eliminates
// the recurring "needs another refresh" UX from CHANGELOG 0.7.0.
async function priceUpdate(span){
  await window.AesSettings.mutateArea('personelManagement', function(block){
    block.auto = 1;
    if (!Array.isArray(block.alreadyUpdated)) block.alreadyUpdated = [];
  });
  const value = settings.personelManagement.value;
  const type = settings.personelManagement.type;
  const rows = $('.container-fluid:eq(2) table:eq(1) tbody tr').toArray();
  let updatedRows = 0;
  for (const row of rows) {
    const $row = $(row);
    if ($row.find('th').length) continue;
    const salaryInput = $row.find('form input:eq(2)');
    const salary = AES.cleanInteger(salaryInput.val());
    const averageText = $row.find('td:eq(9)').text().replace(/\(.*?\)/g, '').trim();
    const average = AES.cleanInteger(averageText);
    const salaryBtn = $row.find('td:eq(8) > form .input-group-btn input');
    let newSalary = salary;
    if (type === 'absolute') {
      newSalary = average + value;
    } else if (type === 'perc') {
      newSalary = Math.round(average * (1 + value * 0.01));
    }
    if (newSalary !== salary) {
      salaryInput.val(newSalary).trigger('input');
      const form = salaryBtn.closest('form')[0];
      if (form) form.submit();
      else salaryBtn.click();
      updatedRows++;
      await new Promise(function(resolve){ setTimeout(resolve, 100); });
    }
  }
  await window.AesSettings.mutateArea('personelManagement', function(block){
    block.auto = 0;
    block.alreadyUpdated = [];
  });
  const today = AES.getServerDate();
  const key = server + airline + 'personelManagement';
  const personelManagementData = {
    server:server,
    airline:airline,
    type:'personelManagement',
    date: today.date,
    time: today.time
  };
  chrome.storage.local.set({[key]: personelManagementData}, function(){
    span.removeClass().addClass('good').text(updatedRows ? ' all salaries at set level!' : ' all salaries already at set level.');
  });
}
function getAirline(){
   let airline = $("#as-navbar-main-collapse ul li:eq(0) a:eq(0)").text().trim().replace(/[^A-Za-z0-9]/g, '');
   return airline;
}
function getServerName(){
  let server = window.location.hostname
  server = server.split('.');
  return server[0];
}
