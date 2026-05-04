"use strict";
//MAIN
//Global vars
var settings, airline, server, todayDate;

function normaliseDashboardSettings(raw) {
    let next = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
    if (!next.general || typeof next.general !== "object" || Array.isArray(next.general)) {
        next.general = {};
    }
    if (typeof next.general.defaultDashboard !== "string" || !next.general.defaultDashboard) {
        next.general.defaultDashboard = "general";
    }
    return next;
}

function saveDashboardArea(area, done) {
    settings = normaliseDashboardSettings(settings);
    let block = (settings[area] && typeof settings[area] === "object" && !Array.isArray(settings[area]))
        ? settings[area]
        : {};
    settings[area] = block;
    let savePromise;
    if (window.AesSettings && typeof window.AesSettings.saveArea === "function") {
        savePromise = window.AesSettings.saveArea(area, block);
    } else {
        let local = getChromeLocalStorage();
        if (local && typeof local.set === "function") {
            savePromise = new Promise(function(resolve, reject) {
                local.set({settings: settings}, function() {
                    let err = chrome.runtime && chrome.runtime.lastError;
                    if (err) reject(err);
                    else resolve(block);
                });
            });
        } else {
            savePromise = Promise.resolve(block);
        }
    }
    return Promise.resolve(savePromise)
        .then(function(result) {
            if (typeof done === "function") done(result);
            return result;
        })
        .catch(function(err) {
            console.warn("[AES dashboard] settings save failed for " + area, err);
            if (typeof done === "function") done(null);
            return null;
        });
}

function getChromeLocalStorage() {
    return (typeof chrome !== "undefined"
        && chrome.storage
        && chrome.storage.local
        && typeof chrome.storage.local.get === "function")
        ? chrome.storage.local
        : null;
}

function loadDashboardSettings(done) {
    let local = getChromeLocalStorage();
    let settled = false;
    let finish = function(result) {
        if (settled) return;
        settled = true;
        done(result || {});
    };
    if (!local) {
        finish({});
        return;
    }
    try {
        let maybePromise = local.get(["settings"], function(result) {
            finish(result);
        });
        if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(function(result) {
                finish(result);
            }).catch(function(err) {
                console.warn("[AES dashboard] settings load failed; using defaults", err);
                finish({});
            });
        }
    } catch (err) {
        console.warn("[AES dashboard] settings load failed; using defaults", err);
        finish({});
    }
}

function fallbackDashboardDate() {
    let iso = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return {date: iso, time: ""};
}

function resolveDashboardIdentity() {
    let resolvedAirline = {name: "", code: ""};
    let resolvedServer = "";
    try {
        resolvedAirline = AES.getAirlineCode() || resolvedAirline;
    } catch (err) {
        console.warn("[AES dashboard] getAirlineCode failed; using fallback identity", err);
    }
    if (!resolvedAirline.code && !resolvedAirline.name) {
        try {
            let identity = AES.getAirlineIdentity && AES.getAirlineIdentity();
            if (identity) resolvedAirline = {name: identity, code: identity};
        } catch (_) { /* noop */ }
    }
    try {
        resolvedServer = AES.getServerName() || "";
    } catch (err) {
        console.warn("[AES dashboard] getServerName failed; using empty server", err);
    }
    return {airline: resolvedAirline, server: resolvedServer};
}

$(function() {
    if (!document.querySelector("#enterprise-dashboard")) {
        console.warn("[AES dashboard] #enterprise-dashboard missing; skipping legacy dashboard mount");
        return;
    }
    try {
        todayDate = AES.getServerDate();
    } catch (err) {
        todayDate = fallbackDashboardDate();
        console.warn("[AES dashboard] getServerDate failed; using current-date fallback", err);
    }
    if (!todayDate || !todayDate.date) {
        todayDate = fallbackDashboardDate();
    }
    let identity = resolveDashboardIdentity();
    airline = identity.airline;
    server = identity.server;
    saveCompanyReputationFromDashboard();
    loadDashboardSettings(function(result) {
        settings = normaliseDashboardSettings(result && result.settings);

        displayDashboard();
        dashboardHandle();
        $("#aes-select-dashboard-main").change(function() {
            dashboardHandle();
        });
    });
});

function saveCompanyReputationFromDashboard() {
    if (!window.AesCompanyReputationStore) return;
    window.AesCompanyReputationStore.saveFromDocument(document, {
        source:      "enterprise-dashboard",
        server:      server,
        displayName: airline && airline.name,
        airlineCode: airline && airline.code
    }).catch(function(err) {
        console.warn("[AES dashboard] company reputation save failed", err);
    });
}

function displayDashboard() {
    let mainDiv = $("#enterprise-dashboard");
    mainDiv.before(
        `
    <h3>AirlineSim Enhancement Suite Dashboard</h3>
    <div class="as-panel">
      <div class="form-group">
        <label class="control-label">
          <span for="aes-select-dashboard-main">Show Dashboard</span>
        </label>
        <select class="form-control" id="aes-select-dashboard-main">
          <option value="general" selected="selected">General</option>
          <option value="routeManagement">Route Management (current schedule)</option>
          <option value="competitorMonitoring">Competitor Monitoring</option>
          <option value="aircraftProfitability">Aircraft Profitability</option>
          <option value="stationAutomation">Station Automation</option>
          <option value="usedAircraftScanner">Used Aircraft Scanner</option>
          <option value="scheduleManagement">Schedule Builder</option>
          <option value="flightsFrom">Flights From (demand reference)</option>
          <option value="other">None</option>
        </select>
      </div>
    </div>
    <div id="aes-div-dashboard">
    </div>
    `
    );
    $("#aes-select-dashboard-main").val(settings.general.defaultDashboard);
    if (!$("#aes-select-dashboard-main").val()) {
        $("#aes-select-dashboard-main").val("general");
        settings.general.defaultDashboard = "general";
    }

    // F-9228-100: external affordances (e.g. station-automation status-strip
    // mounted in another panel, or a hub Open button) can request a specific
    // pane via `#aes-section=<value>` on the URL. Override the user's
    // `defaultDashboard` setting in that case so the click lands on the
    // promised pane instead of whatever they last picked.
    var hash = (window.location.hash || "").replace(/^#/, "");
    var match = /(?:^|&)aes-section=([^&]+)/.exec(hash);
    if (match && match[1]) {
        var requested = decodeURIComponent(match[1]);
        if ($("#aes-select-dashboard-main option[value='" + requested + "']").length) {
            $("#aes-select-dashboard-main").val(requested);
        }
    }
}

function dashboardHandle() {
    settings = normaliseDashboardSettings(settings);
    let value = $("#aes-select-dashboard-main").val() || "general";
    if (!$("#aes-select-dashboard-main option[value='" + value + "']").length) {
        value = "general";
        $("#aes-select-dashboard-main").val(value);
    }
    settings.general.defaultDashboard = value;
    saveDashboardArea('general');
    let handler;
    switch (value) {
        case 'general':
            handler = displayGeneral;
            break;
        case 'routeManagement':
            handler = displayRouteManagement;
            break;
        case 'competitorMonitoring':
            handler = displayCompetitorMonitoring;
            break;
        case 'hr':
            handler = (typeof displayHr === "function") ? displayHr : displayDefault;
            break;
        case 'aircraftProfitability':
            handler = displayAircraftProfitability;
            break;
        case 'stationAutomation':
            handler = displayStationAutomation;
            break;
        case 'usedAircraftScanner':
            handler = displayUsedAircraftScanner;
            break;
        case 'scheduleManagement':
            handler = displayScheduleManagement;
            break;
        case 'flightsFrom':
            handler = displayFlightsFrom;
            break;
        default:
            handler = displayDefault;
    }
    runDashboardSection(value, handler);
}

function runDashboardSection(value, handler) {
    try {
        let result = typeof handler === "function" ? handler() : null;
        if (result && typeof result.catch === "function") {
            result.catch(function(err) {
                displayDashboardError(value, err);
            });
        }
    } catch (err) {
        displayDashboardError(value, err);
    }
}

function displayDashboardError(value, err) {
    console.warn("[AES dashboard] section failed:", value, err);
    let mainDiv = $("#aes-div-dashboard");
    if (!mainDiv.length) return;
    mainDiv.empty();
    let title = $('<h3></h3>').text('Dashboard section unavailable');
    let panel = $('<div class="as-panel"></div>');
    panel.append($('<p></p>').text('AES could not load the "' + (value || 'selected') + '" dashboard section.'));
    if (err) {
        panel.append($('<pre style="white-space:pre-wrap;"></pre>').text((err && err.message) || String(err)));
    }
    panel.append($('<button type="button" class="btn btn-default"></button>')
        .text('Show General')
        .click(function() {
            $("#aes-select-dashboard-main").val("general");
            dashboardHandle();
        }));
    mainDiv.append(title, panel);
}
//Route Management Dashbord
function displayRouteManagement() {
    //Check ROute Managemetn seetings
    ensureRouteManagementSettings();

    let mainDiv = $("#aes-div-dashboard");
    //Build layout
    mainDiv.empty();
    let title = $('<h3></h3>').text('Route Management - current schedule');
    let div = $('<div id="aes-div-dashboard-routeManagement" class="as-panel"></div>');
    mainDiv.append(title, div);
    //Get schedule
    let scheduleKey = server + airline.code + 'schedule';
    chrome.storage.local.get([scheduleKey], function(result) {
        try {
            let scheduleData = result[scheduleKey];
            let scheduleRows = getRouteManagementScheduleRows(scheduleData);
            if (scheduleRows.length) {
                try {
                    div.append(buildRoutePlannerPanel(scheduleData));
                } catch (err) {
                    console.warn("[AES dashboard] route planner panel failed", err);
                    div.append(routePlannerFallbackPanel(err));
                }

                // Table
                generateRouteManagementTable(scheduleData);

                // Option buttons
                let fieldsetEl = document.createElement("fieldset")
                let legendEl = document.createElement("legend")
                let buttonGroupEl = document.createElement("div")

                let buttonElements = {
                    "selectFirstTen": {
                        "label": "select first 10"
                    },
                    "hideChecked": {
                        "label": "hide checked"
                    },
                    "openInventory": {
                        "label": "open inventory (max 10)"
                    },
                    "reloadTable": {
                        "label": "reload table"
                    }
                }

                for (let key in buttonElements) {
                    let buttonObj = buttonElements[key]
                    let buttonEl = document.createElement("button")
                    let buttonClassNames = buttonObj?.classNames
                    let buttonType = buttonObj?.type
                    let buttonDefaultClassNames = "btn btn-default"
                    buttonEl.innerText = buttonObj.label

                    if (buttonType) {
                        buttonEl.setAttribute("type", buttonType)
                    } else {
                        buttonEl.setAttribute("type", "button")
                    }

                    if (buttonClassNames) {
                        buttonEl.className = buttonClassNames
                    } else {
                        buttonEl.className = buttonDefaultClassNames
                    }

                    buttonObj.element = buttonEl
                    buttonGroupEl.append(buttonEl)
                }

                legendEl.innerText = "Options"
                buttonGroupEl.classList.add("btn-group")

                fieldsetEl.append(legendEl, buttonGroupEl)

                let optionsDiv = $('<div class="col-md-4"></div>').append(fieldsetEl);

                // Button actions

                // Select first ten
                buttonElements["selectFirstTen"].element.addEventListener("click", function() {
                    let count = 0
                    $('#aes-table-routeManagement tbody tr').each(function() {
                        if (count >= 10) return false;
                        $(this).find("input").prop('checked', true);
                        count++;
                    })
                });

                // Remove checked
                buttonElements["hideChecked"].element.addEventListener("click", function() {
                    $('#aes-table-routeManagement tbody tr').has('input:checked').remove();
                });

                // Open Inventory
                buttonElements["openInventory"].element.addEventListener("click", function() {
                    //Get checked collumns
                    let pages = $('#aes-table-routeManagement tbody tr').has('input:checked').map(function() {
                        let orgdest = $(this).attr('id');
                        orgdest = orgdest.split("-");
                        orgdest = orgdest[2];
                        //let orgdest = $(this).find("td:eq(1)").text() + $(this).find("td:eq(2)").text();
                        let url = 'https://' + server + '.airlinesim.aero/app/com/inventory/' + orgdest;
                        return url;
                    }).toArray();

                    //Open new tabs
                    for (let i = 0; i < pages.length; i++) {
                        window.open(pages[i], '_blank');
                        if (i == 10) {
                            break;
                        }
                    }
                });

                // Reload table reloadTable
                buttonElements["reloadTable"].element.addEventListener("click", function() {
                    generateRouteManagementTable(scheduleData);
                });
                let divRow = $('<div class="row"></div>').append(optionsDiv, displayRouteManagementFilters(), displayRouteManagementCollumns())
                div.prepend(divRow);
                //Collumns selector Checkbox listener
                $('#aes-table-routeManagement-collumns input').change(function() {
                    let show;
                    if (this.checked) {
                        show = 1;
                    } else {
                        show = 0;
                    }
                    let value = $(this).val();
                    settings.routeManagement.tableCollumns.forEach(function(col) {
                        if (col.class == value) {
                            col.show = show;
                        }
                    });
                    saveDashboardArea('routeManagement');
                });

            } else {
                displayRouteManagementMissingSchedule(div);
            }
        } catch (err) {
            displayDashboardError("routeManagement", err);
        }
    });
}

function displayRouteManagementMissingSchedule(div) {
    let scheduleHref = $('#enterprise-dashboard table:eq(0) tfoot td a:eq(2)').attr('href')
        || '/app/info/enterprises/me?tab=3';
    let msg = $('<span></span>').text('Need current schedule info to show this section. Open Flight schedule and run Extract Schedule.');
    let link = $('<a class="btn btn-xs btn-default"></a>').attr('href', scheduleHref).text('Open Flight schedule');
    div.append(msg, ' ', link);
}

function ensureRouteManagementSettings() {
    if (!settings.routeManagement) {
        setDefaultRouteManagementSettings();
        return settings.routeManagement;
    }

    let existingFilter = Array.isArray(settings.routeManagement.filter)
        ? settings.routeManagement.filter : [];
    if (!Array.isArray(settings.routeManagement.tableCollumns) || !settings.routeManagement.tableCollumns.length) {
        setDefaultRouteManagementSettings();
        settings.routeManagement.filter = existingFilter;
    } else {
        settings.routeManagement.filter = existingFilter;
    }
    return settings.routeManagement;
}

function routePlannerFallbackPanel(err) {
    let panel = $('<div class="aes-route-planner__empty as-panel"></div>');
    panel.append($('<strong></strong>').text('Route Planner unavailable'));
    if (err) panel.append(' ', $('<span></span>').text((err && err.message) || String(err)));
    return panel;
}

function buildRoutePlannerPanel(scheduleData) {
    let panel = $('<div id="aes-route-planner" class="aes-route-planner"></div>');
    let planner = window.AesRoutePlanner;
    let status = $('<span class="aes-route-planner__status"></span>').text('Ready');
    let summary = $('<div class="aes-route-planner__summary"></div>').text('No live schedule plan generated.');
    let previewBody = $('<tbody></tbody>');
    let currentPlan = null;
    let fleetAircraft = [];
    let storageKey = getRoutePlannerStorageKey();

    panel.append(
        $('<div class="aes-route-planner__header"></div>').append(
            $('<h4></h4>').text('Route Planner'),
            status
        )
    );

    if (!planner) {
        panel.append($('<div class="aes-route-planner__empty"></div>').text('Route planner module is not loaded.'));
        return panel;
    }

    let airports = getRoutePlannerAirportOptions(scheduleData);
    let hubSelect = $('<select class="form-control aes-rp-hub"></select>');
    airports.forEach(function(iata) {
        hubSelect.append($('<option></option>').val(iata).text(iata));
    });
    if (!airports.length) {
        hubSelect.append($('<option></option>').val('').text(''));
    }

    let airportSelect = $('<select class="form-control aes-rp-airports" multiple size="8"></select>');
    airports.forEach(function(iata) {
        airportSelect.append($('<option></option>').val(iata).text(iata));
    });
    airportSelect.val(airports.slice(0, Math.min(airports.length, 8)));

    let customAirports = $('<textarea class="form-control aes-rp-custom-airports" rows="2" placeholder="Custom IATA list"></textarea>');
    let aircraftSelect = $('<select class="form-control aes-rp-aircraft" multiple size="8"></select>');
    let aircraftText = $('<textarea class="form-control aes-rp-aircraft-text" rows="2" placeholder="Aircraft IDs if not in fleet cache"></textarea>');

    let patternSelect = $('<select class="form-control aes-rp-pattern"></select>').append(
        $('<option></option>').val('out-and-back').text('Out and back'),
        $('<option></option>').val('chain').text('Chain'),
        $('<option></option>').val('hub-spokes').text('Hub spokes')
    );
    let startFlightNumber = $('<input class="form-control aes-rp-start-flight-number" type="number" min="1" max="9999">')
        .val(planner.suggestNextFlightNumber(scheduleData) || '');
    let flightCount = $('<input class="form-control aes-rp-flight-count" type="number" min="1" max="200">').val('6');
    let startTime = $('<input class="form-control aes-rp-start-time" type="time">').val('09:00');
    let turnMin = $('<input class="form-control aes-rp-turn-min" type="number" min="0" max="240">').val('45');
    let waveSpacing = $('<input class="form-control aes-rp-wave-spacing" type="number" min="0" max="720">').val('30');
    let defaultBlock = $('<input class="form-control aes-rp-default-block" type="number" min="45" max="1440">').val('120');
    let longFlightMin = $('<input class="form-control aes-rp-long-flight-min" type="number" min="120" max="1440">').val('300');
    let pricePct = $('<input class="form-control aes-rp-price-pct" type="number" min="50" max="200">').val('100');
    let service = $('<input class="form-control aes-rp-service" type="text" placeholder="Service code">');
    let applyDelay = $('<input class="form-control aes-rp-apply-delay" type="number" min="0" max="60000">').val('2500');

    let generateBtn = $('<button class="btn btn-default" type="button"></button>').text('Generate live schedule plan');
    let saveBtn = $('<button class="btn btn-default" type="button" disabled></button>').text('Save live plan');
    let applyBtn = $('<button class="btn btn-primary" type="button" disabled></button>').text('Apply selected in AirlineSim');

    let controls = $('<div class="aes-route-planner__controls"></div>').append(
        routePlannerField('Hub', hubSelect),
        routePlannerField('Airports', airportSelect),
        routePlannerField('Custom airports', customAirports),
        routePlannerField('Aircraft', aircraftSelect),
        routePlannerField('Aircraft IDs', aircraftText),
        routePlannerField('Flights', flightCount),
        routePlannerField('Pattern', patternSelect),
        routePlannerField('Start flight #', startFlightNumber),
        routePlannerField('First departure', startTime),
        routePlannerField('Turn minutes', turnMin),
        routePlannerField('Wave spacing', waveSpacing),
        routePlannerField('Fallback block', defaultBlock),
        routePlannerField('Long flight min', longFlightMin),
        routePlannerField('Price %', pricePct),
        routePlannerField('Service', service),
        routePlannerField('Apply delay ms', applyDelay)
    );

    let actions = $('<div class="aes-route-planner__actions"></div>').append(generateBtn, saveBtn, applyBtn);
    let preview = $('<div class="aes-route-planner__preview as-table-well"></div>').append(
        $('<table class="table table-bordered table-striped table-hover aes-route-planner__table"></table>').append(
            $('<thead><tr>'
                + '<th>Use</th><th>#</th><th>Flight #</th><th>Aircraft</th>'
                + '<th>Route</th><th>Day</th><th>Dep</th><th>Arr</th>'
                + '<th>Block</th><th>Note</th><th>Status</th>'
                + '</tr></thead>'),
            previewBody
        )
    );

    panel.append(controls, actions, summary, preview);
    routePlannerRenderPreview(previewBody, currentPlan);

    hubSelect.change(function() {
        let hub = $(this).val();
        let selected = airportSelect.val() || [];
        if (hub && selected.indexOf(hub) === -1) {
            selected.unshift(hub);
            airportSelect.val(selected);
        }
    });

    routePlannerLoadFleet(aircraftSelect, status).then(function(list) {
        fleetAircraft = list;
        if (list.length && !(aircraftSelect.val() || []).length) {
            aircraftSelect.val([String(list[0].aircraftId)]);
        }
        routePlannerSetStatus(status, list.length ? 'Fleet loaded: ' + list.length + ' aircraft' : 'Fleet cache empty', list.length ? 'ok' : 'warn');
    }).catch(function(err) {
        routePlannerSetStatus(status, 'Fleet load failed: ' + ((err && err.message) || err), 'error');
    });

    chrome.storage.local.get([storageKey], function(result) {
        let saved = result && result[storageKey];
        let plan = saved && saved.plan ? saved.plan : saved;
        if (!plan || !Array.isArray(plan.flights) || !plan.flights.length) return;
        currentPlan = plan;
        routePlannerHydrateInputs(panel, plan);
        routePlannerRenderPreview(previewBody, currentPlan);
        routePlannerRenderSummary(summary, currentPlan);
        saveBtn.prop('disabled', false);
        applyBtn.prop('disabled', false);
        routePlannerSetStatus(status, 'Loaded saved live schedule plan', 'ok');
    });

    generateBtn.click(async function() {
        routePlannerSetStatus(status, 'Building route metadata...', 'warn');
        generateBtn.prop('disabled', true);
        try {
            let seedAirports = planner.normalizeIataList((airportSelect.val() || []).concat([
                hubSelect.val(),
                customAirports.val()
            ]).join(' '));
            let routeMeta = await routePlannerLoadRouteMeta(seedAirports);
            let options = routePlannerReadOptions(panel, fleetAircraft, scheduleData, routeMeta);
            currentPlan = planner.generatePlan(options);
            routePlannerRenderPreview(previewBody, currentPlan);
            routePlannerRenderSummary(summary, currentPlan);
            saveBtn.prop('disabled', !currentPlan.ok);
            applyBtn.prop('disabled', !currentPlan.ok);
            if (!currentPlan.ok) {
                routePlannerSetStatus(status, 'Cannot generate: ' + (currentPlan.errors || []).join(', '), 'error');
            } else {
                let metaCount = Object.keys(routeMeta || {}).length;
                routePlannerSetStatus(status, 'Generated ' + currentPlan.flights.length + ' flights' + (metaCount ? ' with demand cache' : ' with fallback blocks'), metaCount ? 'ok' : 'warn');
            }
        } catch (err) {
            routePlannerSetStatus(status, 'Generate failed: ' + ((err && err.message) || err), 'error');
        } finally {
            generateBtn.prop('disabled', false);
        }
    });

    saveBtn.click(function() {
        if (!currentPlan) {
            routePlannerSetStatus(status, 'Nothing to save', 'warn');
            return;
        }
        currentPlan = routePlannerReadPreviewPlan(currentPlan, previewBody);
        routePlannerRenderSummary(summary, currentPlan);
        let rec = {savedAt: Date.now(), plan: currentPlan};
        chrome.storage.local.set({[storageKey]: rec}, function() {
            routePlannerSetStatus(status, 'Saved live schedule plan', 'ok');
        });
    });

    applyBtn.click(async function() {
        if (!currentPlan) {
            routePlannerSetStatus(status, 'Nothing to apply', 'warn');
            return;
        }
        currentPlan = routePlannerReadPreviewPlan(currentPlan, previewBody);
        routePlannerRenderPreview(previewBody, currentPlan);
        routePlannerRenderSummary(summary, currentPlan);
        let selected = (currentPlan.flights || []).filter(function(f) { return f && f.selected !== false; });
        if (!selected.length) {
            routePlannerSetStatus(status, 'No preview rows selected', 'warn');
            return;
        }
        if (!confirm('Apply ' + selected.length + ' selected route planner flights in AirlineSim?')) return;

        applyBtn.prop('disabled', true);
        generateBtn.prop('disabled', true);
        saveBtn.prop('disabled', true);
        routePlannerSetStatus(status, 'Applying ' + selected.length + ' selected flights...', 'warn');
        try {
            let delay = parseInt(panel.find('.aes-rp-apply-delay').val(), 10);
            let result = await planner.applyPlan(currentPlan, {
                server:       server,
                applyDelayMs: Number.isFinite(delay) ? delay : planner.DEFAULTS.applyDelayMs,
                stopOnError:  true,
                onProgress:   function(evt) {
                    let seq = evt && evt.flight && evt.flight.seq;
                    if (!seq) return;
                    if (evt.phase === 'submitting') {
                        routePlannerSetRowStatus(previewBody, seq, 'Submitting', 'warn');
                    } else if (evt.phase === 'submitted') {
                        let response = evt.response || {};
                        routePlannerSetRowStatus(previewBody, seq, response.ok ? 'Applied' : (response.error || 'Failed'), response.ok ? 'ok' : 'error');
                    }
                }
            });
            routePlannerSetStatus(status, result.ok ? 'Applied all selected flights' : 'Apply stopped before completion', result.ok ? 'ok' : 'error');
        } catch (err) {
            routePlannerSetStatus(status, 'Apply failed: ' + ((err && err.message) || err), 'error');
        } finally {
            applyBtn.prop('disabled', !currentPlan.ok);
            generateBtn.prop('disabled', false);
            saveBtn.prop('disabled', !currentPlan.ok);
        }
    });

    return panel;
}

function getRoutePlannerStorageKey() {
    let airlineKey = airline && (airline.code || airline.name) ? (airline.code || airline.name) : 'current';
    return 'routePlanner:live:' + server + ':' + airlineKey;
}

function getRoutePlannerAirportOptions(scheduleData) {
    let planner = window.AesRoutePlanner;
    if (!planner) return [];
    return planner.airportsFromSchedule(scheduleData);
}

function routePlannerField(label, control) {
    return $('<label class="aes-route-planner__field"></label>').append(
        $('<span></span>').text(label),
        control
    );
}

function routePlannerReadOptions(panel, fleetAircraft, scheduleData, routeMeta) {
    let planner = window.AesRoutePlanner;
    let hub = String(panel.find('.aes-rp-hub').val() || '').trim().toUpperCase();
    let selectedAirports = panel.find('.aes-rp-airports').val() || [];
    let airports = planner.normalizeIataList(selectedAirports.concat([
        hub,
        panel.find('.aes-rp-custom-airports').val()
    ]).join(' '));
    if (hub && airports.indexOf(hub) === -1) airports.unshift(hub);

    let selectedAircraftIds = panel.find('.aes-rp-aircraft').val() || [];
    let byId = {};
    (fleetAircraft || []).forEach(function(a) {
        if (a && a.aircraftId != null) byId[String(a.aircraftId)] = a;
    });
    let aircraft = selectedAircraftIds.map(function(id) {
        let a = byId[String(id)] || {};
        return {
            aircraftId:   String(id),
            registration: a.registration || '',
            hub:          a.location || a.hubIata || a.hub || ''
        };
    });
    planner.normalizeAircraftList(panel.find('.aes-rp-aircraft-text').val()).forEach(function(a) {
        if (!aircraft.some(function(existing) { return existing.aircraftId === a.aircraftId; })) aircraft.push(a);
    });

    return {
        hub:                hub,
        airports:           airports,
        aircraft:           aircraft,
        flightCount:        panel.find('.aes-rp-flight-count').val(),
        pattern:            panel.find('.aes-rp-pattern').val(),
        startFlightNumber:  panel.find('.aes-rp-start-flight-number').val(),
        startTime:          panel.find('.aes-rp-start-time').val(),
        turnMin:            panel.find('.aes-rp-turn-min').val(),
        waveSpacingMin:     panel.find('.aes-rp-wave-spacing').val(),
        defaultBlockMin:    panel.find('.aes-rp-default-block').val(),
        longFlightMin:      panel.find('.aes-rp-long-flight-min').val(),
        pricePct:           panel.find('.aes-rp-price-pct').val(),
        service:            panel.find('.aes-rp-service').val(),
        routeMeta:          routeMeta || {},
        scheduleData:       scheduleData
    };
}

function routePlannerHydrateInputs(panel, plan) {
    if (!plan || !plan.options) return;
    let opts = plan.options;
    if (opts.hub) panel.find('.aes-rp-hub').val(opts.hub);
    if (Array.isArray(opts.airports)) panel.find('.aes-rp-airports').val(opts.airports);
    if (opts.pattern) panel.find('.aes-rp-pattern').val(opts.pattern);
    if (opts.flightCount) panel.find('.aes-rp-flight-count').val(opts.flightCount);
    if (opts.startFlightNumber) panel.find('.aes-rp-start-flight-number').val(opts.startFlightNumber);
    if (opts.startTime) panel.find('.aes-rp-start-time').val(opts.startTime);
    if (opts.turnMin != null) panel.find('.aes-rp-turn-min').val(opts.turnMin);
    if (opts.waveSpacingMin != null) panel.find('.aes-rp-wave-spacing').val(opts.waveSpacingMin);
    if (opts.defaultBlockMin != null) panel.find('.aes-rp-default-block').val(opts.defaultBlockMin);
    if (opts.longFlightMin != null) panel.find('.aes-rp-long-flight-min').val(opts.longFlightMin);
    if (opts.pricePct != null) panel.find('.aes-rp-price-pct').val(opts.pricePct);
    if (opts.service != null) panel.find('.aes-rp-service').val(opts.service);
}

function routePlannerRenderPreview(tbody, plan) {
    tbody.empty();
    if (!plan || !Array.isArray(plan.flights) || !plan.flights.length) {
        tbody.append($('<tr></tr>').append($('<td colspan="11" class="aes-route-planner__empty"></td>').text('No live schedule plan generated.')));
        return;
    }
    plan.flights.forEach(function(flight) {
        let row = $('<tr></tr>').attr('data-seq', flight.seq);
        let selected = $('<input type="checkbox" class="aes-rp-row-selected">').prop('checked', flight.selected !== false);
        let flightNumber = $('<input type="text" class="form-control input-sm aes-rp-row-flight-number" maxlength="4">').val(flight.flightNumberText || '');
        let aircraftId = $('<input type="text" class="form-control input-sm aes-rp-row-aircraft" required>').val(flight.aircraftId || '');
        let day = $('<select class="form-control input-sm aes-rp-row-day"></select>');
        window.AesRoutePlanner.DAY_NAMES.forEach(function(name, idx) {
            day.append($('<option></option>').val(idx).text(name));
        });
        day.val(String(flight.dayIdx || 0));
        let dep = $('<input type="time" class="form-control input-sm aes-rp-row-dep">').val(flight.depTimeLocal || '');

        row.append(
            $('<td></td>').append(selected),
            $('<td></td>').text(flight.seq),
            $('<td></td>').append(flightNumber),
            $('<td></td>').append(aircraftId),
            $('<td class="aes-route-planner__route"></td>').text((flight.origin || '') + ' -> ' + (flight.destination || '')),
            $('<td></td>').append(day),
            $('<td></td>').append(dep),
            $('<td></td>').text(flight.arrTimeLocal || ''),
            $('<td class="aes-text-right"></td>').text(flight.blockMin ? flight.blockMin + 'm' : ''),
            $('<td></td>').text(flight.note || ''),
            $('<td class="aes-rp-row-status"></td>').text('')
        );
        tbody.append(row);
    });
}

function routePlannerReadPreviewPlan(plan, tbody) {
    if (!plan) return plan;
    let edits = [];
    tbody.find('tr[data-seq]').each(function() {
        let row = $(this);
        edits.push({
            seq:              parseInt(row.attr('data-seq'), 10),
            selected:         row.find('.aes-rp-row-selected').prop('checked'),
            flightNumberText: row.find('.aes-rp-row-flight-number').val(),
            aircraftId:       row.find('.aes-rp-row-aircraft').val(),
            dayIdx:           row.find('.aes-rp-row-day').val(),
            depTimeLocal:     row.find('.aes-rp-row-dep').val()
        });
    });
    return window.AesRoutePlanner.applyEdits(plan, edits);
}

function routePlannerRenderSummary(el, plan) {
    if (!plan || !plan.summary) {
        el.text('No live schedule plan generated.');
        return;
    }
    let s = plan.summary;
    let warnings = Array.isArray(plan.warnings) && plan.warnings.length ? ' - ' + plan.warnings.join(' ') : '';
    el.text(s.flightCount + ' flights, ' + s.aircraftCount + ' aircraft, ' + s.airportCount + ' airports, ' + s.longFlights + ' long legs' + warnings);
}

async function routePlannerLoadFleet(select, status) {
    select.empty().append($('<option disabled></option>').text('Loading fleet cache...'));
    if (!window.AesFleetRoster || typeof window.AesFleetRoster.loadCurrent !== 'function') {
        select.empty();
        routePlannerSetStatus(status, 'Fleet roster module unavailable', 'warn');
        return [];
    }
    let fleet = await window.AesFleetRoster.loadCurrent();
    let list = (fleet && Array.isArray(fleet.aircraft)) ? fleet.aircraft : [];
    select.empty();
    list.forEach(function(a) {
        if (!a || a.aircraftId == null) return;
        let text = [
            a.registration || a.aircraftId,
            a.equipment || '',
            a.location || a.hubIata || ''
        ].filter(Boolean).join(' - ');
        select.append(
            $('<option></option>')
                .val(String(a.aircraftId))
                .text(text)
                .attr('data-registration', a.registration || '')
                .attr('data-location', a.location || a.hubIata || '')
        );
    });
    return list;
}

async function routePlannerLoadRouteMeta(airports) {
    let planner = window.AesRoutePlanner;
    let list = planner ? planner.normalizeIataList(airports) : [];
    let wanted = new Set(list);
    let meta = {};
    if (!window.FlightsFromStore || typeof window.FlightsFromStore.loadAirport !== 'function') return meta;

    for (let i = 0; i < list.length; i++) {
        let origin = list[i];
        let rec = null;
        try { rec = await window.FlightsFromStore.loadAirport(origin); }
        catch (_) { rec = null; }
        let routes = rec && Array.isArray(rec.routes) ? rec.routes : [];
        let ctx = (window.FlightsFromStore.buildDemandContext && routes.length)
            ? window.FlightsFromStore.buildDemandContext(routes) : null;
        for (let j = 0; j < routes.length; j++) {
            let route = routes[j] || {};
            let dest = String(route.destIata || '').toUpperCase();
            if (!wanted.has(dest) || dest === origin) continue;
            let weekly = Number(route.weeklyFlights) || 0;
            let seats = Number(route.seatsPerWeek) || 0;
            let demand = null;
            if (window.FlightsFromStore.demandForRoute) {
                try { demand = window.FlightsFromStore.demandForRoute(route, ctx); }
                catch (_) { demand = null; }
            }
            let demandScore = demand && demand.paxScore != null ? Number(demand.paxScore) * 10 : 0;
            meta[origin + '-' + dest] = {
                distanceKm:    Number(route.distanceKm) || null,
                weeklyFlights: weekly || null,
                seatsPerWeek:  seats || null,
                score:         demandScore + weekly + Math.sqrt(seats || 0)
            };
        }
    }
    return meta;
}

function routePlannerSetStatus(el, text, tone) {
    el.removeClass('is-ok is-warn is-error')
        .addClass(tone === 'ok' ? 'is-ok' : tone === 'error' ? 'is-error' : tone === 'warn' ? 'is-warn' : '')
        .text(text || '');
}

function routePlannerSetRowStatus(tbody, seq, text, tone) {
    tbody.find('tr[data-seq="' + seq + '"] .aes-rp-row-status')
        .removeClass('is-ok is-warn is-error')
        .addClass(tone === 'ok' ? 'is-ok' : tone === 'error' ? 'is-error' : tone === 'warn' ? 'is-warn' : '')
        .text(text || '');
}

function getRouteManagementScheduleRows(scheduleData) {
    if (!scheduleData || !scheduleData.date || typeof scheduleData.date !== "object") return [];
    let dates = Object.keys(scheduleData.date)
        .filter(function(date) { return Number.isInteger(parseInt(date, 10)); })
        .sort(function(a, b) { return parseInt(b, 10) - parseInt(a, 10); });
    for (let i = 0; i < dates.length; i++) {
        let day = scheduleData.date[dates[i]];
        if (day && Array.isArray(day.schedule)) return day.schedule;
    }
    return [];
}

function setDefaultRouteManagementSettings() {
    let collumns = [
        {
            name: 'Origin',
            class: 'aes-origin',
            number: 0,
            show: 1,
            value: 'origin'
    },
        {
            name: 'Destination',
            class: 'aes-destination',
            number: 0,
            show: 1,
            value: 'destination'
    },
        {
            name: 'Hub',
            class: 'aes-hub',
            number: 0,
            show: 1,
            value: 'hub'
    },
        {
            name: 'OD',
            class: 'aes-od',
            number: 0,
            show: 1,
            value: 'odName'
    },
        {
            name: 'Direction',
            class: 'aes-direction',
            number: 0,
            show: 1,
            value: 'direction'
    },
        {
            name: '# of flight numbers',
            class: 'aes-fltNr',
            number: 1,
            show: 1,
            value: 'fltNr'
    },
        {
            name: 'PAX frequency',
            class: 'aes-paxFreq',
            number: 1,
            show: 1,
            value: 'paxFreq'
    },
        {
            name: 'Cargo frequency',
            class: 'aes-cargoFreq',
            number: 1,
            show: 1,
            value: 'cargoFreq'
    },
        {
            name: 'Total Frequency',
            class: 'aes-totalFreq',
            number: 1,
            show: 1,
            value: 'totalFreq'
    },
        {
            name: 'Analysis date',
            class: 'aes-analysisDate',
            number: 0,
            show: 1
    },
        {
            name: 'Previous Analysis date',
            class: 'aes-analysisPreDate',
            number: 0,
            show: 1
    },
        {
            name: 'Pricing date',
            class: 'aes-pricingDate',
            number: 0,
            show: 1
    },
        {
            name: 'PAX load',
            class: 'aes-paxLoad',
            number: 1,
            show: 1
    },
        {
            name: 'PAX load &Delta;',
            class: 'aes-paxLoadDelta',
            number: 1,
            show: 1
    },
        {
            name: 'Cargo load',
            class: 'aes-cargoLoad',
            number: 1,
            show: 1
    },
        {
            name: 'Cargo load &Delta;',
            class: 'aes-cargoLoadDelta',
            number: 1,
            show: 1
    },
        {
            name: 'Total load',
            class: 'aes-load',
            number: 1,
            show: 1
    },
        {
            name: 'Total load &Delta;',
            class: 'aes-loadDelta',
            number: 1,
            show: 1
    },
        {
            name: 'PAX index',
            class: 'aes-paxIndex',
            number: 1,
            show: 1
    },
        {
            name: 'PAX index &Delta;',
            class: 'aes-paxIndexDelta',
            number: 1,
            show: 1
    },
        {
            name: 'Cargo index',
            class: 'aes-cargoIndex',
            number: 1,
            show: 1
    },
        {
            name: 'Cargo index &Delta;',
            class: 'aes-cargoIndexDelta',
            number: 1,
            show: 1
    },
        {
            name: 'Index',
            class: 'aes-index',
            number: 1,
            show: 1
    },
        {
            name: 'Index &Delta;',
            class: 'aes-indexDelta',
            number: 1,
            show: 1
    },
        {
            name: 'Route PAX index',
            class: 'aes-routeIndexPax',
            number: 1,
            show: 1
    },
        {
            name: 'Route Cargo index',
            class: 'aes-routeIndexCargo',
            number: 1,
            show: 1
    },
        {
            name: 'Route index',
            class: 'aes-routeIndex',
            number: 1,
            show: 1
    }
  ];
    settings.routeManagement = {
        tableCollumns: collumns,
        filter: []
    };
}

function routeManagementApplyFilter() {
    let routeSettings = ensureRouteManagementSettings();
    $('#aes-table-routeManagement tbody tr').each(function() {
        let row = this;
        routeSettings.filter.forEach(function(filter) {
            let cell = $(row).find("." + filter.collumnCode).text();
            //if(cell){
            //Get collumn info if number or not
            let number;
            for (let i = 0; i < routeSettings.tableCollumns.length; i++) {
                let collumn = routeSettings.tableCollumns[i];
                if (filter.collumnCode == collumn.class) {
                    number = collumn.number;
                    break;
                }
            }
            let value = filter.value;
            if (number) {
                if (cell) {
                    cell = parseInt(cell, 10);
                }
                if (value) {
                    value = parseInt(value, 10);
                }
            }
            switch (filter.operation) {
                case '=':
                    if (cell != value) {
                        $(row).remove();
                    }
                    break;
                case '!=':
                    if (cell == value) {
                        $(row).remove();
                    }
                    break;
                case '>':
                    if (cell < value) {
                        $(row).remove();
                    }
                    break;
                case '<':
                    if (cell > value) {
                        $(row).remove();
                    }
            }
        });
    });
}

function displayRouteManagementFilters() {
    let routeSettings = ensureRouteManagementSettings();
    //Table head
    let th = [];
    th.push('<th>Column</th>');
    th.push('<th>Operation</th>');
    th.push('<th>Value</th>');
    th.push('<th></th>');
    let thead = $('<thead></thead>').append($('<tr></tr>').append(th));

    //Table body
    let tbody = $('<tbody></tbody>');
    routeSettings.filter.forEach(function(fil) {
        let td = [];
        td.push('<td><input type="hidden" value="' + fil.collumnCode + '">' + fil.collumn + '</td>');
        td.push('<td>' + fil.operation + '</td>');
        td.push('<td>' + fil.value + '</td>');
        td.push('<td><a class="aes-a-routeManagement-filter-delete-row" ><span class="fa fa-trash" title="Delete row"></span></a></td>');
        tbody.append($('<tr></tr>').append(td));
    });

    //Table foot
    //select collumn
    let option1 = [];
    routeSettings.tableCollumns.forEach(function(col) {
        option1.push('<option value="' + col.class + '">' + col.name + '</option>');
    });
    let select1 = $('<select id="aes-select-routeManagement-filter-collumn" class="form-control"></select>').append(option1);



    //Select value
    let option = [];
    option.push('<option>=</option>');
    option.push('<option>!=</option>');
    option.push('<option>></option>');
    option.push('<option><</option>');
    let select = $('<select id="aes-select-routeManagement-filter-operation" class="form-control"></select>').append(option);
    //Add button
    let btn = $('<button class="btn btn-default"></button>').text('Add Row');
    btn.click(function() {
        let td = [];
        let collumn = $(this).closest("tr").find('#aes-select-routeManagement-filter-collumn option:selected').text();
        let collumnVal = $(this).closest("tr").find('#aes-select-routeManagement-filter-collumn').val();
        let operation = $(this).closest("tr").find('#aes-select-routeManagement-filter-operation option:selected').text();
        let value = $(this).closest("tr").find('#aes-select-routeManagement-filter-value').val()
        td.push('<td><input type="hidden" value="' + collumnVal + '">' + collumn + '</td>');
        td.push('<td>' + operation + '</td>');
        td.push('<td>' + value + '</td>');
        td.push('<td><a class="aes-a-routeManagement-filter-delete-row" ><span class="fa fa-trash" title="Delete row"></span></a></td>');

        tbody.append($('<tr></tr>').append(td));
    });

    //Footer rows
    let tf = [];
    tf.push($('<td></td>').html(select1));
    tf.push($('<td></td>').html(select));
    tf.push('<td><input id="aes-select-routeManagement-filter-value" type="text" class="form-control" style="min-width: 50px;"></td>');
    tf.push($('<td></td>').append(btn));
    let tfoot = $('<tfoot></tfoot>').append($('<tr></tr>').append(tf));
    let table = $('<table class="table table-bordered table-striped table-hover" id="aes-table-routeManagement-filter"></table>').append(thead, tbody, tfoot);
    let divTable = $('<div id="aes-div-routeManagement-filter" class="as-table-well"></div>').append(table);


    //
    let saveBtn = $('<button class="btn btn-default">apply filter</button>');
    let saveSpan = $('<span></span>');

    //Closable legend
    let link = $('<a style="cursor: pointer;"></a>').text('Filters');
    let legend = $('<legend></legend>').html(link);
    link.click(function() {
        divForAll.toggle();
    });

    let divForAll = $('<div style="display: none;"></div>').append(divTable, saveBtn, saveSpan);
    let fieldset = $('<fieldset></fieldset>').append(legend, divForAll);
    let div = $('<div class="col-md-4"></div>').append(fieldset);

    //Delete row for filter row
    table.on("click", ".aes-a-routeManagement-filter-delete-row", function() {
        $(this).closest("tr").remove();
    });

    //Save Button
    saveBtn.click(function() {
        saveSpan.removeClass().addClass('warning').text(' saving...');
        let filter = [];
        $('#aes-table-routeManagement-filter tbody tr').each(function() {
            filter.push({
                collumnCode: $(this).find('input').val(),
                collumn: $(this).find('td:eq(0)').text(),
                operation: $(this).find('td:eq(1)').text(),
                value: $(this).find('td:eq(2)').text(),
            });
        });
        settings.routeManagement.filter = filter;
        saveDashboardArea('routeManagement', function() {
            saveSpan.removeClass().addClass('warning').text(' filtering...');
            routeManagementApplyFilter()
            saveSpan.removeClass().addClass('good').text(' done!');
        });
    });

    return div;
}

function displayRouteManagementCollumns() {
    let routeSettings = ensureRouteManagementSettings();
    //Table Head
    let th = [];
    th.push('<th>Show</th>');
    th.push('<th>Column</th>');
    let thead = $('<thead></thead>').append($('<tr></tr>').append(th));
    //Table body
    let tbody = $('<tbody></tbody>');

    routeSettings.tableCollumns.forEach(function(col) {
        let td = [];
        //Checkbox
        if (col.show) {
            td.push('<td><input value="' + col.class + '" type="checkbox" checked></td>');
        } else {
            td.push('<td><input value="' + col.class + '" type="checkbox"></td>');
        }
        //Name
        td.push('<td>' + col.name + '</td>');
        tbody.append($('<tr></tr>').append(td));
    });

    let table = $('<table class="table table-bordered table-striped table-hover" id="aes-table-routeManagement-collumns"></table>').append(thead, tbody);
    let divTable = $('<div id="aes-div-routeManagement-collumns" class="as-table-well" style="display: none;"></div>').append(table);

    //Closable legend
    let link = $('<a style="cursor: pointer;"></a>').text('Columns');
    let legend = $('<legend></legend>').html(link);
    link.click(function() {
        $('#aes-div-routeManagement-collumns').toggle();
    });

    let fieldset = $('<fieldset></fieldset>').append(legend, divTable);
    let div = $('<div class="col-md-4"></div>').append(fieldset);
    return div;
}

function generateRouteManagementTable(scheduleData) {
    let routeSettings = ensureRouteManagementSettings();
    //Remove table
    $('#aes-div-routeManagement').remove();
    let schedule = getRouteManagementScheduleRows(scheduleData);
    if (!schedule.length) {
        $('#aes-div-dashboard-routeManagement').append(
            $('<div id="aes-div-routeManagement" class="as-table-well"></div>')
                .append($('<p></p>').text('No valid schedule rows are cached. Re-run Extract Schedule from Flight schedule.'))
        );
        return;
    }
    //Generate top
    //Table headers
    let collumns = routeSettings.tableCollumns;

    //Generate table head
    let thead = $('<thead></thead>');
    let th = [];
    //Check box
    let checkbox = $('<input type="checkbox">');
    checkbox.change(function() {
        if (this.checked) {
            $('#aes-table-routeManagement tbody tr').each(function() {
                $(this).find("input").prop('checked', true);
            });
        } else {
            $('#aes-table-routeManagement tbody tr').each(function() {
                $(this).find("input").prop('checked', false);
            });
        }
    });
    th.push($('<th></th>').html(checkbox));
    collumns.forEach(function(col) {
        if (col.show) {
            let sort = $('<a></a>').html(col.name);
            sort.click(function() {
                routeManagementSortTable(col.class, col.number);
            });
            th.push($('<th style="cursor: pointer;"></th>').html(sort));
        }
    });
    //Add open inventory column
    th.push($('<th>Action</th>'));

    thead.append($('<tr></tr>').append(th));
    //Generate table rows
    let tbody = $('<tbody></tbody>');
    let uniqueOD = [];
    schedule.forEach(function(od) {
        if (!od || typeof od !== "object") return;
        let origin = String(od.origin || (od.od && od.od.slice ? od.od.slice(0, 3) : '')).toUpperCase();
        let destination = String(od.destination || (od.od && od.od.slice ? od.od.slice(3, 6) : '')).toUpperCase();
        if (!origin || !destination) return;
        let odName = String(od.od || (origin + destination)).toUpperCase();
        //ODs for analysis
        uniqueOD.push(odName);
        //Get values flight numbers and total frequency
        let fltNr = 0;
        let paxFreq = 0;
        let cargoFreq = 0;
        let flightNumbers = (od.flightNumber && typeof od.flightNumber === "object") ? od.flightNumber : {};
        for (let flight in flightNumbers) {
            cargoFreq += Number(flightNumbers[flight].cargoFreq) || 0,
                paxFreq += Number(flightNumbers[flight].paxFreq) || 0,
                fltNr++;
        }
        let totalFreq = cargoFreq + paxFreq;
        //hub
        let hub = odName.slice(0, 3);
        let cellValue = {
            origin: origin,
            destination: destination,
            odName: odName,
            direction: od.direction,
            fltNr: fltNr,
            paxFreq: paxFreq,
            cargoFreq: cargoFreq,
            totalFreq: totalFreq,
            hub: hub
        }
        //Table cells
        let cell = [];
        //Checkbox
        cell.push('<td><input type="checkbox"></td>');
        //Schedule
        collumns.forEach(function(col) {
            if (col.show) {
                if (col.value) {
                    cell.push($('<td></td>').addClass(col.class).text(cellValue[col.value]));
                } else {
                    cell.push($('<td></td>').addClass(col.class));
                }
            }
        });
        let rowId = origin + destination;

        //Add inventory button
        let invBtn = '<a class="btn btn-xs btn-default" href="https://' + server + '.airlinesim.aero/app/com/inventory/' + rowId + '">Inventory</a>'
        cell.push($('<td></td>').html(invBtn));

        let row = $('<tr id="aes-row-' + rowId + '"></tr>').append(cell);
        tbody.append(row);
    });
    let table = $('<table class="table table-bordered table-striped table-hover" id="aes-table-routeManagement"></table>').append(thead, tbody);
    let divTable = $('<div id="aes-div-routeManagement" class="as-table-well"></div>').append(table);
    $('#aes-div-dashboard-routeManagement').append(divTable)
    //Analysis collumns
    //Get unique ODs
    uniqueOD = [...new Set(uniqueOD)];
    for (let i = 0; i < uniqueOD.length; i++) {
        let origin = uniqueOD[i].substring(0, 3);
        let dest = uniqueOD[i].substring(3, 6);
        let keyOutbound = server + airline.code + origin + dest + 'routeAnalysis';
        let keyInbound = server + airline.code + dest + origin + 'routeAnalysis';
        chrome.storage.local.get([keyOutbound], function(outboundData) {
            chrome.storage.local.get([keyInbound], function(inboundData) {
                let outAnalysis = outboundData[keyOutbound];
                let inAnalysis = inboundData[keyInbound];
                let outDates, inDates;
                if (outAnalysis) {
                    outDates = getRouteAnalysisImportantDates(outAnalysis.date);
                }
                if (inAnalysis) {
                    inDates = getRouteAnalysisImportantDates(inAnalysis.date);
                }
                //Route index
                let routeIndex = {};
                let routeIndexPax, routeIndexCargo;
                if (outAnalysis && inAnalysis) {
                    if (outDates.analysis && inDates.analysis) {
                        let indexType = ['all', 'pax', 'cargo'];
                        indexType.forEach(function(type) {
                            let outIndex = getRouteAnalysisIndex(outAnalysis.date[outDates.analysis].data, type);
                            let inIndex = getRouteAnalysisIndex(inAnalysis.date[inDates.analysis].data, type);
                            if (outIndex && inIndex) {
                                routeIndex[type] = Math.round((outIndex + inIndex) / 2);
                            }
                        });
                    }
                }
                //For Outbound
                updateRouteAnalysisCollumns(outAnalysis, outDates, routeIndex);
                updateRouteAnalysisCollumns(inAnalysis, inDates, routeIndex);
            });
        });
    }
}

function routeManagementSortTable(collumn, number) {
    let tableRows = $('#aes-table-routeManagement tbody tr');
    let tableBody = $('#aes-table-routeManagement tbody');
    tableBody.empty();
    let indexes = [];
    tableRows.each(function() {
        if (number) {
            let value = parseInt($(this).find("." + collumn).text(), 10);
            if (value) {
                indexes.push(value);
            } else {
                indexes.push(0);
            }
        } else {
            indexes.push($(this).find("." + collumn).text());
        }
    });
    indexes = [...new Set(indexes)];
    let sorted = [...indexes];
    if (number) {
        sorted.sort(function(a, b) {
            if (a > b) return -1;
            if (a < b) return 1;
            if (a = b) return 0;
        });
    } else {
        sorted.sort();
    }
    let same = 1;
    for (let i = 0; i < indexes.length; i++) {
        if (indexes[i] !== sorted[i]) {
            same = 0;
        }
    }
    if (same) {
        if (number) {
            sorted.sort(function(a, b) {
                if (a < b) return -1;
                if (a > b) return 1;
                if (a = b) return 0;
            });
        } else {
            sorted.reverse();
        }
    }
    for (let i = 0; i < sorted.length; i++) {
        for (let j = tableRows.length - 1; j >= 0; j--) {
            if (number) {
                let value = parseInt($(tableRows[j]).find("." + collumn).text(), 10);
                if (!value) {
                    value = 0;
                }
                if (value == sorted[i]) {
                    tableBody.append($(tableRows[j]));
                    tableRows.splice(j, 1);
                }
            } else {
                if ($(tableRows[j]).find("." + collumn).text() == sorted[i]) {
                    tableBody.append($(tableRows[j]));
                    tableRows.splice(j, 1);
                }
            }
        }
    }
}

function updateRouteAnalysisCollumns(data, dates, routeIndex) {

    if (data) {
        let rowId = '#aes-row-' + data.origin + data.destination;

        if (dates.analysis) {
            //Analysis date
            $(rowId + ' .aes-analysisDate').text(AES.formatDateString(dates.analysis));

            //Pricing date
            if (dates.pricing) {
                $(rowId + ' .aes-pricingDate').text(AES.formatDateString(dates.pricing));
            }

            //Pax Load
            $(rowId + ' .aes-paxLoad').html(displayLoad(getRouteAnalysisLoad(data.date[dates.analysis].data, 'pax')));

            //Cargo Load
            $(rowId + ' .aes-cargoLoad').html(displayLoad(getRouteAnalysisLoad(data.date[dates.analysis].data, 'cargo')));

            //All Load
            $(rowId + ' .aes-load').html(displayLoad(getRouteAnalysisLoad(data.date[dates.analysis].data, 'all')));

            //PAX Index
            $(rowId + ' .aes-paxIndex').html(displayIndex(getRouteAnalysisIndex(data.date[dates.analysis].data, 'pax')));

            //Cargo Index
            $(rowId + ' .aes-cargoIndex').html(displayIndex(getRouteAnalysisIndex(data.date[dates.analysis].data, 'cargo')));

            //PAX Index
            $(rowId + ' .aes-index').html(displayIndex(getRouteAnalysisIndex(data.date[dates.analysis].data, 'all')));

            if (dates.analysisOneBefore) {
                //Previous analysis date
                $(rowId + ' .aes-analysisPreDate').text(AES.formatDateString(dates.analysisOneBefore));

                //Pax Load Delta
                $(rowId + ' .aes-paxLoadDelta').html(displayRouteAnalysisLoadDelta(data.date[dates.analysis].data, data.date[dates.analysisOneBefore].data, 'pax'));
                //Cargo Load Delta
                $(rowId + ' .aes-cargoLoadDelta').html(displayRouteAnalysisLoadDelta(data.date[dates.analysis].data, data.date[dates.analysisOneBefore].data, 'cargo'));
                //All Load Delta
                $(rowId + ' .aes-loadDelta').html(displayRouteAnalysisLoadDelta(data.date[dates.analysis].data, data.date[dates.analysisOneBefore].data, 'all'));

                //PAX Index Delta
                $(rowId + ' .aes-paxIndexDelta').html(displayRouteAnalysisIndexDelta(data.date[dates.analysis].data, data.date[dates.analysisOneBefore].data, 'pax'));
                //Cargo Index Delta
                $(rowId + ' .aes-cargoIndexDelta').html(displayRouteAnalysisIndexDelta(data.date[dates.analysis].data, data.date[dates.analysisOneBefore].data, 'cargo'));
                //PAX Index Delta
                $(rowId + ' .aes-indexDelta').html(displayRouteAnalysisIndexDelta(data.date[dates.analysis].data, data.date[dates.analysisOneBefore].data, 'all'));
            }

            //Route Index
            if (routeIndex.pax) {
                $(rowId + ' .aes-routeIndexPax').html(displayIndex(routeIndex.pax));
            }
            if (routeIndex.cargo) {
                $(rowId + ' .aes-routeIndexCargo').html(displayIndex(routeIndex.cargo));
            }
            if (routeIndex.all) {
                $(rowId + ' .aes-routeIndex').html(displayIndex(routeIndex.all));
            }
        }
    }

    return;
    let analysisDate = dates.analysis;
    let pricingDate = dates.pricing;
    let paxLoad;
    let paxLoadDelta;
    let cargoLoad;
    let cargoLoadDelta;
    let totalLoad;
    let totalLoadDelta;

    outDates = getInvPricingAnalaysisPricingDate(dataOut.date);
    if (outDates.analysis) {
        $('#aes-row-invPricing-' + origin + dest + '-analysis', tbody).text(AES.formatDateString(outDates.analysis));
        outIndex = dataOut.date[outDates.analysis].routeIndex;
        let td = $('#aes-row-invPricing-' + origin + dest + '-OWindex', tbody);
        td.html(displayIndex(outIndex));
        if (outDates.analysisOneBefore) {
            outIndexChange = dataOut.date[outDates.analysis].routeIndex - dataOut.date[outDates.analysisOneBefore].routeIndex
            td.append(displayIndexChange(outIndexChange));
        }
    }
    if (outDates.pricing) {
        $('#aes-row-invPricing-' + origin + dest + '-pricing', tbody).text(AES.formatDateString(outDates.pricing));
    }
}

function displayRouteAnalysisLoadDelta(dataCurrent, dataPrevious, type) {
    let load = getRouteAnalysisLoad(dataCurrent, type);
    let preLoad = getRouteAnalysisLoad(dataPrevious, type);
    if (load && preLoad) {
        let diff = load - preLoad;
        let span = $('<span></span>');
        if (diff > 0) {
            span.addClass('good').text('+' + diff + "%");
            return span;
        }
        if (diff < 0) {
            span.addClass('bad').text(diff + "%");
            return span;
        }
        span.addClass('warning').text(diff + "%");
        return span;
    }
}

function displayRouteAnalysisIndexDelta(dataCurrent, dataPrevious, type) {
    let index = getRouteAnalysisIndex(dataCurrent, type);
    let preIndex = getRouteAnalysisIndex(dataPrevious, type);
    if (index && preIndex) {
        let diff = index - preIndex;
        let span = $('<span></span>');
        if (diff > 0) {
            span.addClass('good').text('+' + diff);
            return span;
        }
        if (diff < 0) {
            span.addClass('bad').text(diff);
            return span;
        }
        span.addClass('warning').text(diff);
        return span;
    }
}

function getRouteAnalysisLoad(data, type) {
    let cmp = [];
    switch (type) {
        case 'all':
            cmp = ['Y', 'C', 'F', 'Cargo'];
            break;
        case 'pax':
            cmp = ['Y', 'C', 'F'];
            break;
        case 'cargo':
            cmp = ['Cargo'];
            break;
        default:
            // code block
    }
    let cap, bkd;
    cap = bkd = 0;
    cmp.forEach(function(comp) {
        if (data[comp].valid) {
            cap += data[comp].totalCap;
            bkd += data[comp].totalBkd;
        }
    });
    if (cap) {
        return Math.round(bkd / cap * 100);
    } else {
        return 0;
    }
}

function displayLoad(load) {
    if (load) {
        let span = $('<span></span>');
        if (load >= 70) {
            span.addClass('good').text(load + "%");
            return span;
        }
        if (load < 40) {
            span.addClass('bad').text(load + "%");
            return span;
        }
        span.addClass('warning').text(load + "%");
        return span;
    }
}

function getRouteAnalysisIndex(data, type) {
    let cmp = [];
    let index = 0;
    switch (type) {
        case 'all':
            cmp = ['Y', 'C', 'F', 'Cargo'];
            break;
        case 'pax':
            cmp = ['Y', 'C', 'F'];
            break;
        case 'cargo':
            cmp = ['Cargo'];
            break;
        default:
            cmp = 0;
            break;
    }
    if (cmp) {
        //Multi index
        let count = 0;
        cmp.forEach(function(comp) {
            if (data[comp].valid) {
                index += data[comp].index;
                count++;
            }
        });
        if (index) {
            return Math.round(index / count);
        }
    }
}

function getRouteAnalysisImportantDates(dates) {
    //Get latest analysis and pricing date
    let latest = {
        analysis: 0,
        pricing: 0,
        analysisOneBefore: 0,
        pricingOneBefore: 0
    }
    let analysisDates = [];
    let pricingDates = []
    for (let date in dates) {
        if (Number.isInteger(parseInt(date))) {
            if (dates[date].pricingUpdated) {
                pricingDates.push(date);
            }
            analysisDates.push(date);
        }
    }
    analysisDates.reverse();
    pricingDates.reverse();
    if (analysisDates.length) {
        latest.analysis = analysisDates[0];
        if (analysisDates[1]) {
            latest.analysisOneBefore = analysisDates[1];
        }
    }
    if (pricingDates.length) {
        latest.pricing = pricingDates[0];
        if (pricingDates[1]) {
            latest.pricingOneBefore = pricingDates[1];
        }
    }
    return latest;
}

function displayIndex(index) {
    let span = $('<span></span>');
    if (index >= 90) {
        return span.addClass('good').text(index);
    }
    if (index <= 50) {
        return span.addClass('bad').text(index);
    }
    return span.addClass('warning').text(index);
}

function displayIndexChange(index) {
    if (index > 0) {
        return ' (<span class="good">+' + index + '</span>)';
    }
    if (index < 0) {
        return ' (<span class="bad">' + index + '</span>)';
    }
    return ' (<span class="warning">' + index + '</span>)';
}
//Display General
function displayGeneral() {
    let mainDiv = $("#aes-div-dashboard");
    mainDiv.empty();

    //Table
    //Head cells
    let th1 = $('<th>Area</th>');
    let th2 = $('<th>Status</th>');
    let th3 = $('<th>Action</th>');
    let headRow = $('<tr></tr>').append(th1, th2, th3);
    let thead = $('<thead></thead>').append(headRow);
    //Body cells
    let tbody = $('<tbody></tbody>');
    generalAddScheduleRow(tbody);
    generalAddPersonelManagementRow(tbody);


    let table = $('<table class="table table-bordered table-striped table-hover"></table>').append(thead, tbody);
    //Build layout
    let divTable = $('<div class="as-table-well"></div>').append(table);
    let title = $('<h3></h3>').text('General');
    let div = $('<div id="aes-div-dashboard-general" class="as-panel"></div>').append(divTable);
    mainDiv.append(title, div);
}

//Display COmpetitor Monitoring
function displayCompetitorMonitoring() {
    //Div
    let div = $('<div id="aes-div-dashboard-competitorMonitoring" class="as-panel"></div>');

    //Check ROute Managemetn seetings
    //
    if (!settings.competitorMonitoring) {
        setDefaultCompetitorMonitoringSettings();
    }

    //Display airlines table
    displayCompetitorMonitoringAirlinesTable(div);

    let mainDiv = $("#aes-div-dashboard");
    //Build layout
    mainDiv.empty();
    let title = $('<h3></h3>').text('Competitor Monitoring');
    mainDiv.append(title, div);

}

function displayCompetitorMonitoringAirlinesTable(div) {
    let compAirlines = [];
    let compAirlinesSchedule = [];
    chrome.storage.local.get(null, function(items) {
        //Get data
        for (let key in items) {
            if (items[key].type) {
                if (items[key].type == 'competitorMonitoring') {
                    if (items[key].server == server) {
                        if (items[key].tracking) {
                            compAirlines.push(items[key]);
                        }
                    }
                }
                if (items[key].type == 'schedule') {
                    if (items[key].server == server) {
                        let airline = items[key].airline
                        compAirlinesSchedule[airline] = items[key];
                    }
                }
            }
        }

        //Check if any airlines exist
        let rows = [];
        let hrows = [];
        if (compAirlines.length) {
            //head
            //second head collumns
            let firstHead = {};
            let th = [];
            settings.competitorMonitoring.tableColumns.forEach(function(col) {
                if (col.visible) {
                    //Sort
                    let sort = $('<a></a>').html(col.text);
                    sort.click(function() {
                        CompetitorMonitoringSortTable(col.field, col.number);
                    });
                    th.push($('<th style="cursor: pointer;"></th>').html(sort));
                    if (firstHead[col.headGroup]) {
                        firstHead[col.headGroup]++;
                    } else {
                        firstHead[col.headGroup] = 1;
                    }
                }
            });
            //first head
            let th1 = [];
            for (let titles in firstHead) {
                th1.push($('<th colspan="' + firstHead[titles] + '"></th>').text(titles));
            }
            hrows.push($('<tr></tr>').append(th1));
            hrows.push($('<tr></tr>').append(th));

            //Data collumns

            compAirlines.forEach(function myFunction(value) {
                let data = {};
                //Airline
                data.airlineId = value.id;
                //All Tab0 Collumns
                let dates = [];
                for (let date in value.tab0) {
                    dates.push(date);
                }
                dates.sort(function(a, b) { return b - a });
                if (dates.length) {
                    data.airlineCode = value.tab0[dates[0]].code;
                    data.airlineName = value.tab0[dates[0]].displayName;
                    data.overviewDate = AES.formatDateString(dates[0]);
                    data.overviewRating = value.tab0[dates[0]].rating;
                    data.overviewTotalPax = value.tab0[dates[0]].pax;
                    data.overviewTotalCargo = value.tab0[dates[0]].cargo;
                    data.overviewStations = value.tab0[dates[0]].stations;
                    data.overviewFleet = value.tab0[dates[0]].fleet;
                    data.overviewStaff = value.tab0[dates[0]].employees;
                    //If previous date exists
                    if (dates[1]) {
                        data.overviewPreDate = AES.formatDateString(dates[1]);
                        data.overviewRatingDelta = getDelta(getRatingNr(data.overviewRating), getRatingNr(value.tab0[dates[1]].rating));
                        data.overviewTotalPaxDelta = getDelta(data.overviewTotalPax, value.tab0[dates[1]].pax);
                        data.overviewTotalCargoDelta = getDelta(data.overviewTotalCargo, value.tab0[dates[1]].cargo);
                        data.overviewStationsDelta = getDelta(data.overviewStations, value.tab0[dates[1]].stations);
                        data.overviewFleetDelta = getDelta(data.overviewFleet, value.tab0[dates[1]].fleet);
                        data.overviewStaffDelta = getDelta(data.overviewStaff, value.tab0[dates[1]].employees);
                    }
                }
                //All Tab2 Collumns
                dates = [];
                for (let date in value.tab2) {
                    dates.push(date);
                }
                dates.sort(function(a, b) { return b - a });
                if (dates.length) {
                    data.fafWeek = AES.formatDateStringWeek(value.tab2[dates[0]].week);
                    data.fafAirportsServed = value.tab2[dates[0]].airportsServed;
                    data.fafOperatedFlights = value.tab2[dates[0]].operatedFlights;
                    data.fafSeatsOffered = value.tab2[dates[0]].seatsOffered;
                    data.fafsko = value.tab2[dates[0]].sko;
                    data.fafCargoOffered = value.tab2[dates[0]].cargoOffered;
                    data.faffko = value.tab2[dates[0]].fko;
                    //If previous date exists
                    if (dates[1]) {
                        data.fafWeekPre = AES.formatDateStringWeek(value.tab2[dates[1]].week);
                        data.fafAirportsServedDelta = getDelta(data.fafAirportsServed, value.tab2[dates[1]].airportsServed);
                        data.fafOperatedFlightsDelta = getDelta(data.fafOperatedFlights, value.tab2[dates[1]].operatedFlights);
                        data.fafSeatsOfferedDelta = getDelta(data.fafSeatsOffered, value.tab2[dates[1]].seatsOffered);
                        data.fafskoDelta = getDelta(data.fafsko, value.tab2[dates[1]].sko);
                        data.fafCargoOfferedDelta = getDelta(data.fafCargoOffered, value.tab2[dates[1]].cargoOffered);
                        data.faffkoDela = getDelta(data.faffko, value.tab2[dates[1]].fko);
                    }
                }
                //Schedule Collumns
                if (compAirlinesSchedule[data.airlineCode]) {
                    dates = [];
                    for (let date in compAirlinesSchedule[data.airlineCode].date) {
                        dates.push(date);
                    }
                    dates.sort(function(a, b) { return b - a });
                    if (dates.length) {
                        let hubs = {};
                        //For display
                        data.scheduleDate = AES.formatDateString(dates[0]);
                        //For table
                        data.scheduleDateUse = dates[0];
                        data.scheduleCargoFreq = 0;
                        data.schedulePAXFreq = 0;
                        data.scheduleFltNr = 0;
                        compAirlinesSchedule[data.airlineCode].date[dates[0]].schedule.forEach(function(schedule) {
                            //Hubs
                            let hub = schedule.od.slice(0, 3);
                            if (hubs[hub]) {
                                hubs[hub]++;
                            } else {
                                hubs[hub] = 1;
                            }
                            for (let flight in schedule.flightNumber) {
                                //Cargo Freq
                                data.scheduleCargoFreq += schedule.flightNumber[flight].cargoFreq;
                                //Pax Freq
                                data.schedulePAXFreq += schedule.flightNumber[flight].paxFreq;
                                //Flight nr
                                data.scheduleFltNr++;
                            }
                        });
                        //Total Frequency
                        data.scheduleTotalFreq = data.schedulePAXFreq + data.scheduleCargoFreq;
                        //Hubs
                        let hubArray = [];
                        for (let hub in hubs) {
                            hubArray.push([hub, hubs[hub]]);
                        }
                        hubArray.sort(function(a, b) {
                            return b[1] - a[1];
                        });
                        data.scheduleHubs = '';
                        hubArray.forEach(function(hubA, index) {
                            if (index) {
                                data.scheduleHubs += ', ';
                            }
                            data.scheduleHubs += hubA[0] + ' (' + hubA[1] + ')';
                        });

                        //Previous schedule data
                        if (dates[1]) {
                            data.scheduleDatePre = AES.formatDateString(dates[1]);
                            data.scheduleCargoFreqPre = 0;
                            data.schedulePAXFreqPre = 0;
                            data.scheduleFltNrPre = 0;
                            compAirlinesSchedule[data.airlineCode].date[dates[1]].schedule.forEach(function(schedule) {
                                //Hubs
                                let hub = schedule.od.slice(0, 3);
                                if (hubs[hub]) {
                                    hubs[hub]++;
                                } else {
                                    hubs[hub] = 1;
                                }
                                for (let flight in schedule.flightNumber) {
                                    //Cargo Freq
                                    data.scheduleCargoFreqPre += schedule.flightNumber[flight].cargoFreq;
                                    //Pax Freq
                                    data.schedulePAXFreqPre += schedule.flightNumber[flight].paxFreq;
                                    //Flight nr
                                    data.scheduleFltNrPre++;
                                }
                            });
                            //Total Frequency
                            data.scheduleTotalFreqPre = data.schedulePAXFreq + data.scheduleCargoFreq;
                            //Delta Collumns
                            data.scheduleFltNrDelta = getDelta(data.scheduleFltNr, data.scheduleFltNrPre);
                            data.schedulePAXFreqDelta = getDelta(data.schedulePAXFreq, data.schedulePAXFreqPre);
                            data.scheduleCargoFreqDelta = getDelta(data.scheduleCargoFreq, data.scheduleCargoFreqPre);
                            data.scheduleTotalFreqDelta = getDelta(data.scheduleTotalFreq, data.scheduleTotalFreqPre);
                        }
                    }
                }
                //Action collumns
                //Open airline
                data.actionOpenAirline = '<a class="btn btn-xs btn-default" href="/app/info/enterprises/' + data.airlineId + '">Airline</a>';
                //Open schedule
                if (compAirlinesSchedule[data.airlineCode]) {
                    data.actionOpenSchedule = $('<button type="button" id="aes-compMon-btn-schedule-' + data.airlineCode + '" class="btn btn-xs btn-default">Schedule</button>');
                    //Create schedule table
                    $('#aes-div-dashboard').on('click', 'button#aes-compMon-btn-schedule-' + data.airlineCode, function() {
                        displayCompetitorMonitoringAirlineScheduleTable(div, compAirlinesSchedule[data.airlineCode], data);
                    });
                }
                //Remove airline '
                data.actionRemoveAirline = $('<button type="button" id="aes-compMon-btn-remove-' + data.airlineCode + '" class="btn btn-xs btn-default">Remove</button>');
                //Remove airline action
                $('#aes-div-dashboard').on('click', 'button#aes-compMon-btn-remove-' + data.airlineCode, function() {
                    let key = server + data.airlineId + 'competitorMonitoring';
                    let remove = $(this);
                    chrome.storage.local.get([key], function(compMonitoringData) {
                        let compData = compMonitoringData[key];
                        compData.tracking = 0;
                        chrome.storage.local.set({
                            [compData.key]: compData }, function() {
                            $(remove).closest("tr").remove();
                        });
                    });
                });

                //Populate collumns
                let td = [];
                settings.competitorMonitoring.tableColumns.forEach(function(col) {
                    if (col.visible) {
                        td.push($('<td class="aes-' + col.field + '"></td>').html(data[col.field]));
                    }
                });
                rows.push($('<tr></tr>').append(td));

            });
        } else {
            rows.push('<tr><td><span class="warning">No airlines marked for competitor monitoring. Open airline info page to mark airline for tracking.</span></td></tr>');
        }

        let thead = $('<thead></thead>').append(hrows);
        let tbody = $('<tbody></tbody>').append(rows);

        let table = $('<table id="aes-table-competitorMonitoring" class="table table-bordered table-striped table-hover"></table>').append(thead, tbody);
        let tableWell = $('<div style="overflow-x:auto;" class="as-table-well"></div>').append(table);

        //Options
        let divRow = $('<div class="row"></div>').append(displayCompetitorMonitoringAirlinesTableOptions(), displayCompetitorMonitoringAirlinesTableCollumns());
        div.append(divRow, tableWell);
    });
}

function displayCompetitorMonitoringAirlineScheduleTable(mainDiv, scheduleData, data) {
    mainDiv.hide();
    //Build schedule rows
    let rows = [];
    let hrow = [];
    if (data.scheduleDateUse) {
        let collumns = [
            {
                field: 'schedOrigin',
                text: 'Origin',
                headGroup: 'Schedule',
                visible: 1,
                number: 0,
      },
            {
                field: 'schedDestination',
                text: 'Destination',
                headGroup: 'Schedule',
                visible: 1,
                number: 0,
      },
            {
                field: 'schedHub',
                text: 'Hub',
                headGroup: 'Schedule',
                visible: 1,
                number: 0,
      },
            {
                field: 'schedOd',
                text: 'OD',
                headGroup: 'Schedule',
                visible: 1,
                number: 0,
      },
            {
                field: 'schedDir',
                text: 'Direction',
                headGroup: 'Schedule',
                visible: 1,
                number: 0,
      },
            {
                field: 'schedFltNr',
                text: '# of flight numbers',
                headGroup: 'Schedule',
                visible: 1,
                number: 1,
      },
            {
                field: 'schedPaxFreq',
                text: 'PAX frequency',
                headGroup: 'Schedule',
                visible: 1,
                number: 1,
      },
            {
                field: 'schedCargoFreq',
                text: 'Cargo frequency',
                headGroup: 'Schedule',
                visible: 1,
                number: 1,
      },
            {
                field: 'schedTotalFreq',
                text: 'Total Frequency',
                headGroup: 'Schedule',
                visible: 1,
                number: 1,
      }
    ];
        //Table Head
        let th = [];
        collumns.forEach(function(col) {
            if (col.visible) {
                //Sort
                let sort = $('<a></a>').html(col.text);
                sort.click(function() {
                    SortTable(col.field, col.number, 'aes-table-competitorMonitoring-airline-schedule', 'aes-comp-sched-');
                });
                th.push($('<th style="cursor: pointer;"></th>').html(sort));
            }
        });
        hrow.push($('<tr></tr>').append(th));
        //Table Body
        scheduleData.date[data.scheduleDateUse].schedule.forEach(function(od) {
            let td = [];
            let fltNr = 0;
            let paxFreq = 0;
            let cargoFreq = 0;
            for (let flight in od.flightNumber) {
                cargoFreq += od.flightNumber[flight].cargoFreq,
                    paxFreq += od.flightNumber[flight].paxFreq,
                    fltNr++;
            }
            let totalFreq = cargoFreq + paxFreq;
            //hub
            let hub = od.od.slice(0, 3);
            let cellValue = {
                schedOrigin: od.origin,
                schedDestination: od.destination,
                schedOd: od.od,
                schedDir: od.direction,
                schedFltNr: fltNr,
                schedPaxFreq: paxFreq,
                schedCargoFreq: cargoFreq,
                schedTotalFreq: totalFreq,
                schedHub: hub
            }
            collumns.forEach(function(cell) {
                if (cell.visible) {
                    td.push($('<td class="aes-comp-sched-' + cell.field + '" ></td>').html(cellValue[cell.field]));
                }
            });
            rows.push($('<tr></tr>').append(td));
        });
    } else {
        rows.push('<tr><td><span class="warning">No schedule found</span></td></tr>');
    }

    //Build layout
    let thead = $('<thead></thead>').append(hrow);
    let tbody = $('<tbody></tbody>').append(rows);
    let table = $('<table id="aes-table-competitorMonitoring-airline-schedule" class="table table-bordered table-striped table-hover"></table>').append(thead, tbody);
    let tableWell = $('<div style="overflow-x:auto;" class="as-table-well"></div>').append(table);
    let button = $('<button type="button" class="btn btn-default">Back to overview</button>');
    let panelDiv = $('<div class="as-panel"></div>').append(button, tableWell);
    let heading = $('<h4>' + data.airlineName + ' ' + data.airlineCode + ' schedule</h4>');
    let div = $('<div id="aes-compMonitor-schedule"></div>').append(heading, panelDiv);
    mainDiv.after(div);
    //Button clicks
    button.click(function() {
        div.remove();
        mainDiv.show();
    });
}

function displayCompetitorMonitoringAirlinesTableCollumns() {
    //Table Head
    let th = [];
    th.push('<th>Show</th>');
    th.push('<th>Column</th>');
    let thead = $('<thead></thead>').append($('<tr></tr>').append(th));
    //Table body
    let tbody = $('<tbody></tbody>');

    settings.competitorMonitoring.tableColumns.forEach(function(col) {
        let td = [];
        //Checkbox
        if (col.visible) {
            td.push('<td><input value="' + col.field + '" type="checkbox" checked></td>');
        } else {
            td.push('<td><input value="' + col.field + '" type="checkbox"></td>');
        }
        //Name
        td.push('<td>' + col.text + '</td>');
        tbody.append($('<tr></tr>').append(td));
    });

    let table = $('<table class="table table-bordered table-striped table-hover"></table>').append(thead, tbody);
    let divTable = $('<div id="aes-div-competitorMonitoring-collumns" class="as-table-well" style="display: none;"></div>').append(table);
    //Collumns selector Checkbox listener
    $('input', table).change(function() {
        let show;
        if (this.checked) {
            show = 1;
        } else {
            show = 0;
        }
        let value = $(this).val();
        settings.competitorMonitoring.tableColumns.forEach(function(col) {
            if (col.field == value) {
                col.visible = show;
            }
        });
        saveDashboardArea('competitorMonitoring');
    });
    //Closable legend
    let link = $('<a style="cursor: pointer;"></a>').text('Columns');
    let legend = $('<legend></legend>').html(link);
    link.click(function() {
        $('#aes-div-competitorMonitoring-collumns').toggle();
    });
    let fieldset = $('<fieldset></fieldset>').append(legend, divTable);
    let div = $('<div class="col-md-4"></div>').append(fieldset);
    return div;
}

function displayCompetitorMonitoringAirlinesTableOptions() {
    let divFieldset = $('<fieldset></fieldset>').html('<legend>Options</legend>');
    let btn = $('<button type="button" class="btn btn-default">reload table</button>');
    divFieldset.append(btn);
    let optionsDiv = $('<div class="col-md-4"></div>').append(divFieldset);
    //Reload table
    btn.click(function() {
        displayCompetitorMonitoring();
    });

    return optionsDiv;
}

function CompetitorMonitoringSortTable(collumn, number) {
    let tableRows = $('#aes-table-competitorMonitoring tbody tr');
    let tableBody = $('#aes-table-competitorMonitoring tbody');
    tableBody.empty();
    let indexes = [];
    tableRows.each(function() {
        if (number) {
            let value = parseInt($(this).find(".aes-" + collumn).text(), 10);
            if (value) {
                indexes.push(value);
            } else {
                indexes.push(0);
            }
        } else {
            indexes.push($(this).find(".aes-" + collumn).text());
        }
    });
    indexes = [...new Set(indexes)];
    let sorted = [...indexes];
    if (number) {
        sorted.sort(function(a, b) {
            if (a > b) return -1;
            if (a < b) return 1;
            if (a = b) return 0;
        });
    } else {
        sorted.sort();
    }
    let same = 1;
    for (let i = 0; i < indexes.length; i++) {
        if (indexes[i] !== sorted[i]) {
            same = 0;
        }
    }
    if (same) {
        if (number) {
            sorted.sort(function(a, b) {
                if (a < b) return -1;
                if (a > b) return 1;
                if (a = b) return 0;
            });
        } else {
            sorted.reverse();
        }
    }
    for (let i = 0; i < sorted.length; i++) {
        for (let j = tableRows.length - 1; j >= 0; j--) {
            if (number) {
                let value = parseInt($(tableRows[j]).find(".aes-" + collumn).text(), 10);
                if (!value) {
                    value = 0;
                }
                if (value == sorted[i]) {
                    tableBody.append($(tableRows[j]));
                    tableRows.splice(j, 1);
                }
            } else {
                if ($(tableRows[j]).find(".aes-" + collumn).text() == sorted[i]) {
                    tableBody.append($(tableRows[j]));
                    tableRows.splice(j, 1);
                }
            }
        }
    }
}

function setDefaultCompetitorMonitoringSettings() {
    let columns = [
        {
            field: 'airlineId',
            text: 'ID',
            headGroup: 'Airline',
            visible: 1,
            number: 1
    },
        {
            field: 'airlineCode',
            text: 'Code',
            headGroup: 'Airline',
            visible: 1,
            number: 0
    },
        {
            field: 'airlineName',
            text: 'Name',
            headGroup: 'Airline',
            visible: 1,
            number: 0
    },
        {
            field: 'overviewDate',
            text: 'Overview date',
            headGroup: 'Overview',
            visible: 0,
            number: 0
    },
        {
            field: 'overviewPreDate',
            text: 'Overview previous date',
            headGroup: 'Overview',
            visible: 0,
            number: 0
    },
        {
            field: 'overviewRating',
            text: 'Rating',
            headGroup: 'Overview',
            visible: 1,
            number: 0
    },
        {
            field: 'overviewRatingDelta',
            text: 'Rating &Delta;',
            headGroup: 'Overview',
            visible: 0,
            number: 0
    },
        {
            field: 'overviewTotalPax',
            text: 'Total pax',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewTotalPaxDelta',
            text: 'Total pax &Delta;',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewTotalCargo',
            text: 'Total cargo',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewTotalCargoDelta',
            text: 'Total cargo &Delta;',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewStations',
            text: 'Stations',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewStationsDelta',
            text: 'Stations &Delta;',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewFleet',
            text: 'Fleet',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewFleetDelta',
            text: 'Fleet &Delta;',
            headGroup: 'Overview',
            visible: 1,
            number: 1
    },
        {
            field: 'overviewStaff',
            text: 'Staff',
            headGroup: 'Overview',
            visible: 0,
            number: 1
    },
        {
            field: 'overviewStaffDelta',
            text: 'Staff &Delta;',
            headGroup: 'Overview',
            visible: 0,
            number: 1
    },
        {
            field: 'fafWeek',
            text: 'Week',
            headGroup: 'Figures',
            visible: 0,
            number: 0
    },
        {
            field: 'fafWeekPre',
            text: 'Previous week',
            headGroup: 'Figures',
            visible: 0,
            number: 0
    },
        {
            field: 'fafAirportsServed',
            text: 'Airports served',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'fafAirportsServedDelta',
            text: 'Airports served &Delta;',
            headGroup: 'Figures',
            visible: 0,
            number: 1
    },
        {
            field: 'fafOperatedFlights',
            text: 'Operated flights',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'fafOperatedFlightsDelta',
            text: 'Operated flights &Delta;',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'fafSeatsOffered',
            text: 'Seats offered',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'fafSeatsOfferedDelta',
            text: 'Seats offered &Delta;',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'fafsko',
            text: 'SKO',
            headGroup: 'Figures',
            visible: 0,
            number: 1
    },
        {
            field: 'fafskoDelta',
            text: 'SKO &Delta;',
            headGroup: 'Figures',
            visible: 0,
            number: 1
    },
        {
            field: 'fafCargoOffered',
            text: 'Cargo offered',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'fafCargoOfferedDelta',
            text: 'Cargo offered &Delta;',
            headGroup: 'Figures',
            visible: 1,
            number: 1
    },
        {
            field: 'faffko',
            text: 'FKO',
            headGroup: 'Figures',
            visible: 0,
            number: 1
    },
        {
            field: 'faffkoDela',
            text: 'FKO &Delta;',
            headGroup: 'Figures',
            visible: 0,
            number: 1
    },
        {
            field: 'scheduleDate',
            text: 'Schedule Date',
            headGroup: 'Schedule',
            visible: 0,
            number: 0
    },
        {
            field: 'scheduleDatePre',
            text: 'Previous Schedule Date',
            headGroup: 'Schedule',
            visible: 0,
            number: 0
    },
        {
            field: 'scheduleHubs',
            text: 'Hubs (routes)',
            headGroup: 'Schedule',
            visible: 1,
            number: 0
    },
        {
            field: 'scheduleFltNr',
            text: '# of flight numbers',
            headGroup: 'Schedule',
            visible: 0,
            number: 1
    },
        {
            field: 'scheduleFltNrDelta',
            text: '# of flight numbers &Delta;',
            headGroup: 'Schedule',
            visible: 0,
            number: 1
    },
        {
            field: 'schedulePAXFreq',
            text: 'PAX frequency',
            headGroup: 'Schedule',
            visible: 0,
            number: 1
    },
        {
            field: 'schedulePAXFreqDelta',
            text: 'PAX frequency &Delta;',
            headGroup: 'Schedule',
            visible: 0,
            number: 1
    },
        {
            field: 'scheduleCargoFreq',
            text: 'Cargo frequency',
            headGroup: 'Schedule',
            visible: 0,
            number: 1
    },
        {
            field: 'scheduleCargoFreqDelta',
            text: 'Cargo frequency &Delta;',
            headGroup: 'Schedule',
            visible: 0,
            number: 1
    },
        {
            field: 'scheduleTotalFreq',
            text: 'Total frequency',
            headGroup: 'Schedule',
            visible: 1,
            number: 1
    },
        {
            field: 'scheduleTotalFreqDelta',
            text: 'Total frequency &Delta;',
            headGroup: 'Schedule',
            visible: 1,
            number: 1
    },
        {
            field: 'actionOpenAirline',
            text: 'Open airline page',
            headGroup: 'Actions',
            visible: 1,
            number: 0
    },
        {
            field: 'actionOpenSchedule',
            text: 'Show airline schedule',
            headGroup: 'Actions',
            visible: 1,
            number: 0
    },
        {
            field: 'actionRemoveAirline',
            text: 'Remove airline',
            headGroup: 'Actions',
            visible: 0,
            number: 0
    }
  ];
    settings.competitorMonitoring = {
        tableColumns: columns
    };
}

function getRatingNr(rating) {
    switch (rating) {
        case 'AAA':
            return 10;
            break;
        case 'AA':
            return 9;
            break;
        case 'A':
            return 8;
            break;
        case 'BBB':
            return 7;
            break;
        case 'BB':
            return 6;
            break;
        case 'B':
            return 5;
            break;
        case 'CCC':
            return 4;
            break;
        case 'CC':
            return 3;
            break;
        case 'C':
            return 2;
            break;
        case 'D':
            return 1;
            break;
        default:
            return 0;
    }
}

function getDelta(newNr, oldNr) {
    return newNr - oldNr;
};
//Display Aircraft aircraftProfitability
function displayAircraftProfitability() {
    if (!settings.aircraftProfitability) {
        settings.aircraftProfitability = {};
    }
    if (!settings.aircraftProfitability.hideColumn) {
        settings.aircraftProfitability.hideColumn = [];
    }
    //columns
    let columns = [
        {
            category: 'Aircraft',
            title: 'Aircraft ID',
            data: 'aircraftId',
            sortable: 1,
            visible: 1,
            number: 1,
            id: 1
    },
        {
            category: 'Aircraft',
            title: 'Registration',
            data: 'registration',
            sortable: 1,
            visible: 1
    },
        {
            category: 'Aircraft',
            title: 'Equipment',
            data: 'equipment',
            sortable: 1,
            visible: 1
    },
        {
            category: 'Aircraft',
            title: 'Fleet',
            data: 'fleet',
            sortable: 1,
            visible: 1
    },
        {
            category: 'Aircraft',
            title: 'Nickname',
            data: 'nickname',
            sortable: 1,
            visible: 1
    },
        {
            category: 'Aircraft',
            title: 'Note',
            data: 'note',
            sortable: 1,
            visible: 1
    },
        {
            category: 'Aircraft',
            title: 'Age',
            data: 'age',
            sortable: 1,
            visible: 1,
            number: 1
    },
        {
            category: 'Aircraft',
            title: 'Maintenance',
            data: 'maintenance',
            sortable: 1,
            visible: 1,
            number: 1
    },
        {
            category: 'Aircraft',
            title: 'Date',
            data: 'dateAircraft',
            sortable: 1,
            visible: 1
    },
        {
            category: 'Profit',
            title: 'Total flights',
            data: 'totalFlights',
            sortable: 1,
            visible: 1,
            number: 1
    },
        {
            category: 'Profit',
            title: 'Finished flights',
            data: 'finishedFlights',
            sortable: 1,
            visible: 1,
            number: 1
    },
        {
            category: 'Profit',
            title: 'Profit/loss flights',
            data: 'profitFlights',
            sortable: 1,
            visible: 1,
            number: 1
    },
        {
            category: 'Profit',
            title: 'Profit',
            data: 'profit',
            sortable: 1,
            visible: 1,
            number: 1,
            format: 'money'
    },
        {
            category: 'Profit',
            title: 'Profit extract date',
            data: 'dateProfit',
            sortable: 1,
            visible: 1
    }
  ];
    if (settings.aircraftProfitability.hideColumn.length) {
        columns.forEach(function(column) {
            settings.aircraftProfitability.hideColumn.forEach(function(hideColumn) {
                if (column.data == hideColumn) {
                    column.visible = 0;
                }
            });
        });
    }

    let key = server + airline.name.trim().replace(/[^A-Za-z0-9]/g, '') + 'aircraftFleet';
    //Get storage fleet data
    chrome.storage.local.get(key, function(result) {
        //get aircraft flight data
        let aircraftFleetData = result[key];
        if (aircraftFleetData) {
            let keys = [];
            aircraftFleetData.fleet.forEach(function(value) {
                keys.push(server + 'aircraftFlights' + value.aircraftId);
            });
            chrome.storage.local.get(keys, function(result) {
                for (let aircraftFlightData in result) {
                    for (let i = 0; i < aircraftFleetData.fleet.length; i++) {
                        if (aircraftFleetData.fleet[i].aircraftId == result[aircraftFlightData].aircraftId) {
                            aircraftFleetData.fleet[i].profit = {
                                date: result[aircraftFlightData].date,
                                finishedFlights: result[aircraftFlightData].finishedFlights,
                                profit: result[aircraftFlightData].profit,
                                profitFlights: result[aircraftFlightData].profitFlights,
                                time: result[aircraftFlightData].time,
                                totalFlights: result[aircraftFlightData].totalFlights,
                            };
                        }
                    }
                }
                let data = prepareAircraftProfitabilityData(aircraftFleetData);
                let tableDiv;
                if (data.length) {
                    tableDiv = generateTable({
                        column: columns,
                        data: data,
                        columnPrefix: 'aes-aircraftProfit-',
                        tableSettings: 1,
                        options: ['openAircraft', 'removeAircraft', 'reloadTableAircraftProfit', 'applyFilter', 'removeSelected'],
                        filter: settings.aircraftProfitability.filter,
                        hideColumn: settings.aircraftProfitability.hideColumn,
                        tableSettingStorage: 'aircraftProfitability'
                    });
                } else {
                    //Never happens or only when fleet = 0 because of updated script this output is copied bellow
                    tableDiv = $('<p class="warning"></p>').text('No aircraft data in memory. Open fleet management to extract aircraft data.')
                }
                //Div
                let div = $('<div class="as-panel"></div>').append(tableDiv);
                let mainDiv = $("#aes-div-dashboard");
                //Build layout
                mainDiv.empty();
                let title = $('<h3></h3>').text('Aircraft Profitability');
                mainDiv.append(title, div);

            });
        } else {
            //No data
            //Div
            let tableDiv = $('<p class="warning"></p>').text('No aircraft data in memory. Open fleet management to extract aircraft data.')
            let div = $('<div class="as-panel"></div>').append(tableDiv);
            let mainDiv = $("#aes-div-dashboard");
            //Build layout
            mainDiv.empty();
            let title = $('<h3></h3>').text('Aircraft Profitability');
            mainDiv.append(title, div);
        }
    });

    function prepareAircraftProfitabilityData(storage) {
        let data = [];
        storage.fleet.forEach(function(value) {
            let profit = {};
            if (value.profit) {
                profit.totalFlights = value.profit.totalFlights;
                profit.finishedFlights = value.profit.finishedFlights;
                profit.profitFlights = value.profit.profitFlights;
                profit.profit = value.profit.profit;
                profit.dateProfit = AES.formatDateString(value.profit.date) + ' ' + value.profit.time;
            }
            data.push({
                aircraftId: value.aircraftId,
                registration: value.registration,
                equipment: value.equipment,
                fleet: value.fleet,
                nickname: value.nickname,
                note: value.note,
                age: value.age,
                maintenance: value.maintanance,
                dateAircraft: AES.formatDateString(value.date) + ' ' + value.time,
                totalFlights: profit.totalFlights,
                finishedFlights: profit.finishedFlights,
                profitFlights: profit.profitFlights,
                profit: profit.profit,
                dateProfit: profit.dateProfit
            });
        });
        return data;
    }
}

//Auto table generator
function generateTable(tableOptionsRule) {
    let tableHtml = $('<table class="table table-bordered table-striped table-hover"></table>');
    let table = { cell: {}, row: {}, tableHtml: tableHtml };
    //Table Categories
    let tableCategory = {};
    tableOptionsRule.column.forEach(function(value) {
        if (value.visible) {
            if (!tableCategory[value.category]) {
                tableCategory[value.category] = 1;
            } else {
                tableCategory[value.category]++;
            }
        }
    });
    table.cell.category = [];
    //Add checkbox
    if (tableOptionsRule.tableSettings) {
        table.cell.category.push('<th rowspan="2"></th>')
    }
    for (let category in tableCategory) {
        table.cell.category.push('<th colspan="' + tableCategory[category] + '">' + category + '</th>');
    }

    //Table Headers
    table.cell.header = [];
    tableOptionsRule.column.forEach(function(value) {
        if (value.visible) {
            if (value.sortable) {
                //Sort
                let sort = $('<a></a>').text(value.title);
                sort.click(function() {
                    masterSortTable(value.data, value.number, table.tableHtml, tableOptionsRule.columnPrefix);
                });
                table.cell.header.push($('<th style="cursor: pointer;"></th>').html(sort));
            } else {
                table.cell.header.push('<th>' + value.title + '</th>');
            }
        }
    });
    //Head
    table.row.head = [];
    table.row.head.push($('<tr></tr>').append(table.cell.category));
    table.row.head.push($('<tr></tr>').append(table.cell.header));
    //Table Body
    table.row.body = [];
    tableOptionsRule.data.forEach(function(dataValue) {
        let cell = [];
        //Add checkbox
        if (tableOptionsRule.tableSettings) {
            cell.push('<td><input type="checkbox"></td>');
        }
        let id;
        tableOptionsRule.column.forEach(function(colValue) {
            if (colValue.id) {
                id = dataValue[colValue.data]
            }
            if (colValue.visible) {
                let td = $('<td></td>').addClass(tableOptionsRule.columnPrefix + colValue.data);
                if (colValue.format) {
                    td.html(masterCellFormat(colValue.format, dataValue[colValue.data]))
                } else {
                    td.html(dataValue[colValue.data])
                }
                cell.push(td);
            }
        });
        table.row.body.push($('<tr></tr>').attr('id', id).append(cell));
    });
    let thead = $('<thead></thead>').append(table.row.head);
    let tbody = $('<tbody></tbody>').append(table.row.body);
    table.tableHtml.append(thead, tbody);
    let tableWell = $('<div style="overflow-x:auto;" class="as-table-well"></div>').append(table.tableHtml);

    //Table Settings
    let settingsDiv = '';
    if (tableOptionsRule.tableSettings) {
        let divCol = [];
        //Options
        divCol.push($('<div class="col-md-4"></div>').html(masterTableOptions(table.tableHtml, tableOptionsRule.options)));
        divCol.push($('<div class="col-md-4"></div>').html(masterTableFilter(tableOptionsRule.filter, tableOptionsRule.column)));
        divCol.push($('<div class="col-md-4"></div>').html(masterTableColumns()));
        settingsDiv = $('<div class="row"></div>').append(divCol)
    }

    let div = $('<div></div>').append(settingsDiv, tableWell);
    return div;
    //Table functions
    function masterSortTable(collumn, number, table, collumnPrefix) {
        let tableRows = $('tbody tr', table);
        let tableBody = $('tbody', table);
        tableBody.empty();
        let indexes = [];
        tableRows.each(function() {
            if (number) {
                let value = parseInt($(this).find("." + collumnPrefix + collumn).text(), 10);
                if (value) {
                    indexes.push(value);
                } else {
                    indexes.push(0);
                }
            } else {
                indexes.push($(this).find("." + collumnPrefix + collumn).text());
            }
        });
        indexes = [...new Set(indexes)];
        let sorted = [...indexes];
        if (number) {
            sorted.sort(function(a, b) {
                if (a > b) return -1;
                if (a < b) return 1;
                if (a = b) return 0;
            });
        } else {
            sorted.sort();
        }
        let same = 1;
        for (let i = 0; i < indexes.length; i++) {
            if (indexes[i] !== sorted[i]) {
                same = 0;
            }
        }
        if (same) {
            if (number) {
                sorted.sort(function(a, b) {
                    if (a < b) return -1;
                    if (a > b) return 1;
                    if (a = b) return 0;
                });
            } else {
                sorted.reverse();
            }
        }
        for (let i = 0; i < sorted.length; i++) {
            for (let j = tableRows.length - 1; j >= 0; j--) {
                if (number) {
                    let value = parseInt($(tableRows[j]).find("." + collumnPrefix + collumn).text(), 10);
                    if (!value) {
                        value = 0;
                    }
                    if (value == sorted[i]) {
                        tableBody.append($(tableRows[j]));
                        tableRows.splice(j, 1);
                    }
                } else {
                    if ($(tableRows[j]).find("." + collumnPrefix + collumn).text() == sorted[i]) {
                        tableBody.append($(tableRows[j]));
                        tableRows.splice(j, 1);
                    }
                }
            }
        }
    }

    function masterCellFormat(type, value) {
        if (!value) {
            return '';
        }
        switch (type) {
            case 'money':
                let span = $('<span></span>');
                let text = '';
                if (value > 0) {
                    span.addClass('good');
                    text = '+'
                }
                if (value < 0) {
                    span.addClass('bad');
                }
                text = text + new Intl.NumberFormat().format(value) + ' AS$';
                span.text(text);
                return span;
                break;
            default:
                return value;
        }
    }

    function masterTableOptions(table, options) {
        let div = $('<div></div>');
        options.forEach(function(value, index) {
            if (index) {
                let span = $('<span> </span>');
                div.append(span);
            }
            div.append(masterTableOptionsHandle(value));
        });
        //Closable legend
        let link = $('<a style="cursor: pointer;"></a>').text('Options');
        let legend = $('<legend></legend>').html(link);
        link.click(function() {
            div.toggle();
        });
        let fieldset = $('<fieldset></fieldset>').append(legend, div);
        return fieldset;

        //Functions
        function masterTableOptionsHandle(value) {
            switch (value) {
                case 'openAircraft':
                    return masterTableOptionsOpenAircraft();
                    break;
                case 'reloadTableAircraftProfit':
                    return masterTableOptionsReloadTableAP();
                    break;
                case 'removeAircraft':
                    return masterTableOptionsRemoveAircraft();
                    break;
                case 'applyFilter':
                    return masterTableOptionsApplyFilter();
                    break;
                case 'removeSelected':
                    return masterTableOptionsRemoveSelected();
                    break;
                default:
                    // code block
            }
            //Option Functions
            function masterTableOptionsOpenAircraft() {
                let btn = $('<button type="button" class="btn btn-default">open aircraft (max 10)</button>');
                btn.click(function() {
                    let urls = $('tbody tr', table).has('input:checked').map(function() {
                        let id = $(this).attr('id');
                        let url = 'https://' + server + '.airlinesim.aero/app/fleets/aircraft/' + id + '/1';
                        return url;
                    }).toArray();
                    //Open new tabs
                    for (let i = 0; i < urls.length; i++) {
                        window.open(urls[i], '_blank');
                        if (i == 10) {
                            break;
                        }
                    }
                });
                return btn;
            }

            function masterTableOptionsReloadTableAP() {
                let btn = $('<button type="button" class="btn btn-default">reload table</button>');
                btn.click(function() {
                    displayAircraftProfitability();
                });
                return btn;
            }

            function masterTableOptionsRemoveAircraft() {
                let btn = $('<button type="button" class="btn btn-default">remove aircraft (permanent)</button>');
                btn.click(function() {
                    let id = [];
                    let aircraftKey = [];
                    $('tbody tr', table).has('input:checked').each(function() {
                        let localId = $(this).attr('id');
                        id.push(localId);
                        aircraftKey.push(server + 'aircraftFlights' + localId);
                        $(this).remove();
                    });
                    if (id.length) {
                        let fleetKey = server + airline.name + 'aircraftFleet';
                        chrome.storage.local.get(fleetKey, function(result) {
                            let storedFleetData = result[fleetKey];
                            let newFleet = storedFleetData.fleet.filter(function(value) {
                                let keep = 1;
                                id.forEach(function(idVal) {
                                    if (idVal == value.aircraftId) {
                                        keep = 0;
                                    }
                                });
                                return keep;
                            });
                            storedFleetData.fleet = newFleet;
                            chrome.storage.local.set({
                                [fleetKey]: storedFleetData }, function() {
                                chrome.storage.local.remove(aircraftKey, function() {});
                            });
                        });
                    }
                });
                return btn;
            }

            function masterTableOptionsApplyFilter() {
                let btn = $('<button type="button" class="btn btn-default">apply filter</button>');
                btn.click(function() {
                    let filter = [];
                    table.closest(".as-panel").find('fieldset:eq(1) table tbody tr').each(function() {
                        filter.push({
                            titlecode: $(this).find('input').val(),
                            title: $(this).find('td:eq(0)').text(),
                            operation: $(this).find('td:eq(1)').text(),
                            value: $(this).find('td:eq(2)').text()
                        })
                    });
                    settings[tableOptionsRule.tableSettingStorage].filter = filter;
                    saveDashboardArea(tableOptionsRule.tableSettingStorage, function() {
                        $('tbody tr', table).each(function() {
                            let row = this;
                            filter.forEach(function(filter) {
                                let cell = $(row).find("." + tableOptionsRule.columnPrefix + filter.titlecode).text();
                                //if(cell){
                                //Get collumn info if number or not
                                let number;
                                for (let i = 0; i < tableOptionsRule.column.length; i++) {
                                    let column = tableOptionsRule.column[i];
                                    if (filter.titlecode == column.data) {
                                        number = column.number;
                                        break;
                                    }
                                }
                                let value = filter.value;
                                if (number) {
                                    if (cell) {
                                        cell = parseInt(cell, 10);
                                    }
                                    if (value) {
                                        value = parseInt(value, 10);
                                    }
                                }
                                switch (filter.operation) {
                                    case '=':
                                        if (cell != value) {
                                            $(row).remove();
                                        }
                                        break;
                                    case '!=':
                                        if (cell == value) {
                                            $(row).remove();
                                        }
                                        break;
                                    case '>':
                                        if (cell < value) {
                                            $(row).remove();
                                        }
                                        break;
                                    case '<':
                                        if (cell > value) {
                                            $(row).remove();
                                        }
                                }
                            });
                        });
                    });
                });
                return btn;
            }

            function masterTableOptionsRemoveSelected() {
                let btn = $('<button type="button" class="btn btn-default">hide selected</button>');
                btn.click(function() {
                    $('tbody tr', table).has('input:checked').remove();
                });
                return btn;
            }
        }
    }

    function masterTableFilter(filter, column) {
        //Table head
        let th = [];
        th.push('<th>Column</th>');
        th.push('<th>Operation</th>');
        th.push('<th>Value</th>');
        th.push('<th></th>');
        let thead = $('<thead></thead>').append($('<tr></tr>').append(th));
        //Table body
        let row = [];
        if (filter) {
            filter.forEach(function(fil) {
                row.push($('<tr></tr>').append(masterTableFilterAddBodyRow(fil.titlecode, fil.title, fil.operation, fil.value)));
            });
        }

        let tbody = $('<tbody></tbody>').append(row);
        //Table foot
        //select collumn
        let option1 = [];
        column.forEach(function(col) {
            option1.push('<option value="' + col.data + '">' + col.title + '</option>');
        });
        let select1 = $('<select class="form-control"></select>').append(option1);
        //Select value
        let option = [];
        option.push('<option>=</option>');
        option.push('<option>!=</option>');
        option.push('<option>></option>');
        option.push('<option><</option>');
        let select = $('<select class="form-control"></select>').append(option);
        //Value
        let input = $('<input type="text" class="form-control" style="min-width: 50px;">');
        //Add button
        let btn = $('<button class="btn btn-default"></button>').text('Add Row');
        btn.click(function() {
            let column = $('option:selected', select1).text();
            let columnVal = $('option:selected', select1).val();
            let operation = $('option:selected', select).text();
            let value = input.val();
            tbody.append($('<tr></tr>').append(masterTableFilterAddBodyRow(columnVal, column, operation, value)));
        });
        //Footer rows
        let tf = [];
        tf.push($('<td></td>').html(select1));
        tf.push($('<td></td>').html(select));
        tf.push($('<td></td>').html(input));
        tf.push($('<td></td>').append(btn));
        let tfoot = $('<tfoot></tfoot>').append($('<tr></tr>').append(tf));
        let tableFilter = $('<table class="table table-bordered table-striped table-hover"></table>').append(thead, tbody, tfoot);
        let divTable = $('<div class="as-table-well"></div>').append(tableFilter);
        //Closable legend
        let link = $('<a style="cursor: pointer;"></a>').text('Filter');
        let legend = $('<legend></legend>').html(link);
        link.click(function() {
            divTable.toggle();
        });
        let fieldset = $('<fieldset></fieldset>').append(legend, divTable);
        return fieldset;
        //Functions
        function masterTableFilterAddBodyRow(titleCode, title, operation, value) {
            let td = [];
            td.push('<td><input type="hidden" value="' + titleCode + '">' + title + '</td>');
            td.push('<td>' + operation + '</td>');
            td.push('<td>' + value + '</td>');
            let deleteBtn = $('<a></a>').html('<span class="fa fa-trash" title="Delete row"></span>');
            deleteBtn.click(function() {
                $(this).closest("tr").remove();
            });
            td.push($('<td></td>').append(deleteBtn));
            return td;
        }
    }

    function masterTableColumns() {
        //Table head
        let th = [];
        th.push('<th>Show</th>');
        th.push('<th>Column</th>');
        let thead = $('<thead></thead>').append($('<tr></tr>').append(th));
        //Table body
        let row = [];
        tableOptionsRule.column.forEach(function(col) {
            let td = []
            let input = $('<input value="' + col.data + '" type="checkbox">');
            input.change(function() {
                if (!tableOptionsRule.hideColumn) {
                    tableOptionsRule.hideColumn = [];
                }
                let newHideColumns = [];
                let currentColumn = $(this).val();
                newHideColumns = tableOptionsRule.hideColumn.filter(function(value) {
                    return value != currentColumn;
                });
                if (!this.checked) {
                    newHideColumns.push(currentColumn);
                }

                tableOptionsRule.hideColumn = newHideColumns;
                settings[tableOptionsRule.tableSettingStorage].hideColumn = tableOptionsRule.hideColumn;
                saveDashboardArea(tableOptionsRule.tableSettingStorage);
            })
            if (col.visible) {
                input.prop('checked', true);
            }
            td.push($('<td></td>').append(input));
            td.push($('<td></td>').text(col.title));
            row.push($('<tr></tr>').append(td));
        });
        let tbody = $('<tbody></tbody>').append(row);
        let tableColumns = $('<table class="table table-bordered table-striped table-hover"></table>').append(thead, tbody);
        let divTable = $('<div class="as-table-well"></div>').append(tableColumns).hide();
        //Closable legend
        let link = $('<a style="cursor: pointer;"></a>').text('Columns');
        let legend = $('<legend></legend>').html(link);
        link.click(function() {
            divTable.toggle();
        });
        let fieldset = $('<fieldset></fieldset>').append(legend, divTable);
        return fieldset;
    }
}
//Display general helper functions
function generalAddScheduleRow(tbody) {
    let td1 = $('<td></td>').text("Schedule");
    let td2 = $('<td></td>');
    let td3 = $('<td></td>');
    let row = $('<tr></tr>').append(td1, td2, td3);
    tbody.append(row);
    //Get schedule
    let scheduleKey = server + airline.code + 'schedule';
    chrome.storage.local.get([scheduleKey], function(result) {
        let scheduleData = result[scheduleKey];
        if (scheduleData) {
            let lastUpdate = getDate('schedule', scheduleData.date);
            let diff = AES.getDateDiff([todayDate.date, lastUpdate]);
            let span = $('<span></span>').text('Last schedule extract ' + AES.formatDateString(lastUpdate) + ' (' + diff + ' days ago). Extract new schedule if there are new routes.');
            if (diff >= 0 && diff < 7) {
                span.addClass('good');
            } else {
                span.addClass('warning');
            }
            td2.append(span);
            generalUpdateScheduleAction(td3);



        } else {
            //no schedule
            td2.html('<span class="bad">No Schedule data found. Extract schedule or some AES parts will not work</span>');
            generalUpdateScheduleAction(td3);
        }
    });
}

function generalUpdateScheduleAction(td3) {
    let btn = $('<button type="button" class="btn btn-xs btn-default">extract schedule data</button>');
    btn.click(function() {
        settings.schedule.autoExtract = 1;
        //get schedule link
        let link = $('#enterprise-dashboard table:eq(0) tfoot td a:eq(2)');
        saveDashboardArea('schedule', function() {
            link[0].click();
        });
    });
    td3.append(btn);
}

function generalAddPersonelManagementRow(tbody) {
    let td = [];
    td.push($('<td></td>').text("Personnel Management"));
    td.push($('<td></td>'));
    td.push($('<td></td>'));
    let row = $('<tr></tr>').append(td);
    tbody.append(row);
    //Get Status
    let key = server + airline.name + 'personelManagement';
    chrome.storage.local.get([key], function(result) {
        let personelManagementData = result[key];
        if (personelManagementData) {
            let lastUpdate = personelManagementData.date;
            let diff = AES.getDateDiff([todayDate.date, lastUpdate]);
            let span = $('<span></span>').text('Last personnel salary update: ' + AES.formatDateString(lastUpdate) + ' (' + diff + ' days ago).');
            if (diff >= 0 && diff < 7) {
                span.addClass('good');
            } else {
                span.addClass('warning');
            }
            td[1].append(span);
        } else {
            //no schedule
            td[1].html('<span class="bad">No personnel salary update date found.</span>');
        }
    });

    //Action
    let btn = $('<button type="button" class="btn btn-xs btn-default">open personel management</button>');
    btn.click(function() {
        //get schedule link
        let link = $('#as-navbar-main-collapse > ul > li:eq(4) > ul > li:eq(5) > a');
        link[0].click();
    });
    td[2].append(btn);
}
//Display Station Automation
async function displayStationAutomation() {
    const mainDiv = $("#aes-div-dashboard");
    mainDiv.empty();
    mainDiv.append('<h3>Station Automation</h3>');

    const panel = $('<div class="as-panel"></div>');
    const row = $('<div class="row"></div>');
    const formCol = $('<div class="col-md-6"></div>');
    const queueCol = $('<div class="col-md-6"></div>');
    row.append(formCol, queueCol);
    panel.append(row);
    mainDiv.append(panel);

    const barThresholds = [
        {value: 0, label: '≥ 0 bars (any)'},
        {value: 1, label: '≥ 1 bar'},
        {value: 3, label: '≥ 3 bars'},
        {value: 5, label: '≥ 5 bars'},
        {value: 7, label: '≥ 7 bars'},
        {value: 10, label: '≥ 10 bars (full)'}
    ];
    const scoreValues = [0,1,2,3,4,5,6,7,8,9,10];
    const stationSettings = settings.stationAutomation || {};
    // Station-automation storage key must match what the worker reads on
    // /app/info/airports/* and /app/ops/stations* — those pages don't have the
    // .facts table, so use the navbar-based identity instead of airline.code.
    const airlineCode = AES.getAirlineIdentity() || airline.code;

    //Form
    const countrySelect = $('<select id="aes-stationAutomation-country" class="form-control"><option value="">Loading countries…</option></select>');
    const refreshCountriesLink = $('<a href="#" style="margin-left: 8px; font-size: 0.85em;">refresh list</a>');
    const countryLabel = $('<label for="aes-stationAutomation-country">Country</label>').append(refreshCountriesLink);
    const countryGroup = $('<div class="form-group"></div>').append(countryLabel, countrySelect);

    const filterModeSelect = $('<select id="aes-stationAutomation-filterMode" class="form-control"></select>');
    filterModeSelect.append($('<option></option>').val('minimum').text('Hub growth — minimum scores'));
    filterModeSelect.append($('<option></option>').val('range').text('Budget regional — score ranges'));
    filterModeSelect.val(stationSettings.defaultFilterMode === 'range' ? 'range' : 'minimum');
    const modeGroup = $('<div class="form-group"></div>').append(
        $('<label for="aes-stationAutomation-filterMode">Filter mode</label>'), filterModeSelect,
        $('<p class="warning" style="font-size:90%; margin-top:4px;">Budget regional mode lets you set lower and upper score bounds, so 10-bar mega hubs can be excluded.</p>')
    );

    const paxSelect = $('<select id="aes-stationAutomation-pax" class="form-control"></select>');
    const cargoSelect = $('<select id="aes-stationAutomation-cargo" class="form-control"></select>');
    barThresholds.forEach(function(t) {
        paxSelect.append($('<option></option>').val(t.value).text(t.label));
        cargoSelect.append($('<option></option>').val(t.value).text(t.label));
    });
    paxSelect.val(stationSettings.defaultPaxThreshold ?? 0);
    cargoSelect.val(stationSettings.defaultCargoThreshold ?? 0);

    const paxGroup = $('<div class="form-group"></div>').append(
        $('<label for="aes-stationAutomation-pax">Passenger demand</label>'), paxSelect
    );
    const cargoGroup = $('<div class="form-group"></div>').append(
        $('<label for="aes-stationAutomation-cargo">Cargo demand</label>'), cargoSelect
    );

    function scoreSelect(id, value) {
        const sel = $('<select id="' + id + '" class="form-control input-sm" style="width:80px;"></select>');
        scoreValues.forEach(function(v) {
            sel.append($('<option></option>').val(v).text(v + ' bars'));
        });
        sel.val(value);
        return sel;
    }

    const paxMinSelect = scoreSelect('aes-stationAutomation-paxMin', stationSettings.defaultPaxMin ?? 1);
    const paxMaxSelect = scoreSelect('aes-stationAutomation-paxMax', stationSettings.defaultPaxMax ?? 9);
    const cargoMinSelect = scoreSelect('aes-stationAutomation-cargoMin', stationSettings.defaultCargoMin ?? 2);
    const cargoMaxSelect = scoreSelect('aes-stationAutomation-cargoMax', stationSettings.defaultCargoMax ?? 10);
    const sizeMinSelect = scoreSelect('aes-stationAutomation-sizeMin', stationSettings.defaultSizeMin ?? 1);
    const sizeMaxSelect = scoreSelect('aes-stationAutomation-sizeMax', stationSettings.defaultSizeMax ?? 8);

    function rangeRow(label, minSel, maxSel) {
        return $('<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"></div>')
            .append(
                $('<label style="width:150px;margin:0;"></label>').text(label),
                minSel,
                $('<span></span>').text('to'),
                maxSel
            );
    }

    const rangeGroup = $('<div class="form-group" id="aes-stationAutomation-rangeGroup"></div>').append(
        $('<label>Budget regional ranges</label>'),
        rangeRow('Passenger demand', paxMinSelect, paxMaxSelect),
        rangeRow('Cargo demand', cargoMinSelect, cargoMaxSelect),
        rangeRow('Airport size / capacity', sizeMinSelect, sizeMaxSelect)
    );

    const exceptionsInput = $('<input type="text" id="aes-stationAutomation-exceptions" class="form-control" placeholder="CDG, LYS, NCE">');
    const exceptionsGroup = $('<div class="form-group"></div>').append(
        $('<label for="aes-stationAutomation-exceptions">Exceptions (comma or space separated IATA codes)</label>'),
        exceptionsInput
    );

    const concSelect = $('<select id="aes-stationAutomation-conc" class="form-control"></select>');
    [1, 2, 3, 6].forEach(c => concSelect.append($('<option></option>').val(c).text(c + (c > 1 ? ' parallel tabs' : ' tab'))));
    concSelect.val(settings.stationAutomation?.defaultConcurrency ?? 6);
    const concGroup = $('<div class="form-group"></div>').append(
        $('<label for="aes-stationAutomation-conc">Parallel tabs</label>'), concSelect,
        $('<p class="warning" style="font-size:90%; margin-top: 4px;">Pop-ups must be allowed for *.airlinesim.aero (chrome://settings/content/popups), otherwise only the first tab will open.</p>')
    );

    const confirmBtn = $('<button type="button" class="btn btn-primary">Confirm</button>');
    const addAllBtn = $('<button type="button" class="btn btn-default" disabled>Add all stations</button>');
    const formFeedback = $('<span style="margin-left: 8px;"></span>');
    const actionBar = $('<div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;"></div>')
        .append(confirmBtn, addAllBtn, formFeedback);

    formCol.append(countryGroup, modeGroup, paxGroup, cargoGroup, rangeGroup, exceptionsGroup, concGroup, actionBar);

    //Queue side-list
    const queueTitle = $('<h4>Queue</h4>');
    const queueTable = $('<table class="table table-bordered table-striped table-hover"></table>');
    const queueHead = $('<thead><tr><th>#</th><th>Country</th><th>Filter</th><th>Exceptions</th><th></th></tr></thead>');
    const queueBody = $('<tbody></tbody>');
    queueTable.append(queueHead, queueBody);
    const queueWell = $('<div class="as-table-well"></div>').append(queueTable);
    const clearQueueBtn = $('<button type="button" class="btn btn-default btn-xs">Clear queue</button>');
    const queueFooter = $('<div style="margin-top: 8px;"></div>').append(clearQueueBtn);
    queueCol.append(queueTitle, queueWell, queueFooter);

    //State
    let record = await StationAutomationStorage.load(server, airlineCode);
    // Best-effort GC — drop run sessions and orphan result blobs older than a day.
    StationAutomationStorage.cleanupOldRuns(server, airlineCode, record.activeRunId).catch(() => {});
    let cachedCountries = settings.stationAutomation && settings.stationAutomation.countriesCache;
    let countries = Array.isArray(cachedCountries) ? cachedCountries : [];

    async function ensureCountries() {
        if (countries.length) {
            populateCountrySelect();
            return;
        }
        formFeedback.removeClass().addClass('warning').text('Loading countries…');
        try {
            countries = await CountryScraper.loadCountriesList(server);
        } catch (error) {
            formFeedback.removeClass().addClass('bad').text('Failed to load countries: ' + error.message);
            return;
        }
        if (!countries.length) {
            formFeedback.removeClass().addClass('bad').text('Could not parse the countries page.');
            return;
        }
        settings.stationAutomation = settings.stationAutomation || {};
        settings.stationAutomation.countriesCache = countries;
        saveDashboardArea('stationAutomation');
        populateCountrySelect();
        formFeedback.removeClass().text('');
    }

    function populateCountrySelect() {
        countrySelect.empty();
        countrySelect.append('<option value="">— Select country —</option>');
        countries.forEach(function(c) {
            countrySelect.append($('<option></option>').val(c.id).text(c.name + (c.code ? ' (' + c.code + ')' : '')));
        });
    }

    function clampBarValue(value, fallback) {
        const n = parseInt(value, 10);
        if (isNaN(n)) return fallback;
        return Math.max(0, Math.min(10, n));
    }

    function selectedBar(sel, fallback) {
        return clampBarValue(sel.val(), fallback);
    }

    function scoreRangeText(min, max) {
        const lo = Math.min(clampBarValue(min, 0), clampBarValue(max, 10));
        const hi = Math.max(clampBarValue(min, 0), clampBarValue(max, 10));
        return lo + '–' + hi;
    }

    function entryIsRange(entry) {
        return entry && (entry.filterMode === 'range'
            || entry.paxMax !== undefined
            || entry.cargoMax !== undefined
            || entry.sizeMax !== undefined);
    }

    function formatStationFilter(entry) {
        if (entry.airportWhitelist && entry.airportWhitelist.length) {
            return 'Selected airports (' + entry.airportWhitelist.length + ')';
        }
        if (entryIsRange(entry)) {
            return 'Pax ' + scoreRangeText(entry.paxMin ?? entry.paxThreshold ?? 0, entry.paxMax ?? 10)
                + ', Cargo ' + scoreRangeText(entry.cargoMin ?? entry.cargoThreshold ?? 0, entry.cargoMax ?? 10)
                + ', Size ' + scoreRangeText(entry.sizeMin ?? 0, entry.sizeMax ?? 10)
                + ' bars';
        }
        return 'Pax ≥ ' + entry.paxThreshold + ', Cargo ≥ ' + entry.cargoThreshold + ' bars';
    }

    function syncFilterModeUi() {
        const rangeMode = filterModeSelect.val() === 'range';
        paxGroup.toggle(!rangeMode);
        cargoGroup.toggle(!rangeMode);
        rangeGroup.toggle(rangeMode);
    }

    function renderQueue() {
        queueBody.empty();
        if (!record.queue.length) {
            queueBody.append('<tr><td colspan="5"><span class="warning">No countries queued yet. Fill in the form and press Confirm.</span></td></tr>');
            addAllBtn.prop('disabled', true);
            return;
        }
        addAllBtn.prop('disabled', false);
        record.queue.forEach(function(entry, idx) {
            const filterText = formatStationFilter(entry);
            const exceptionsText = entry.exceptions && entry.exceptions.length ? entry.exceptions.join(', ') : '—';
            const removeBtn = $('<button type="button" class="btn btn-default btn-xs">remove</button>');
            removeBtn.click(async function() {
                record = await StationAutomationStorage.removeEntry(server, airlineCode, idx);
                renderQueue();
            });
            const tr = $('<tr></tr>').append(
                $('<td></td>').text(idx + 1),
                $('<td></td>').text(entry.countryName || entry.countryId),
                $('<td></td>').text(filterText),
                $('<td></td>').text(exceptionsText),
                $('<td></td>').append(removeBtn)
            );
            queueBody.append(tr);
        });
    }

    function parseExceptions(raw) {
        return (raw || '').split(/[\s,]+/)
            .map(s => s.trim().toUpperCase())
            .filter(s => s.length === 3);
    }

    filterModeSelect.change(function() {
        syncFilterModeUi();
    });

    confirmBtn.click(async function() {
        const countryId = countrySelect.val();
        if (!countryId) {
            formFeedback.removeClass().addClass('bad').text('Please select a country.');
            return;
        }
        const selected = countries.find(c => c.id === countryId);
        const filterMode = filterModeSelect.val() === 'range' ? 'range' : 'minimum';
        const entry = {
            countryId: countryId,
            countryCode: selected?.code || '',
            countryName: selected ? selected.name + (selected.code ? ' (' + selected.code + ')' : '') : countryId,
            filterMode: filterMode,
            paxThreshold: filterMode === 'range' ? selectedBar(paxMinSelect, 1) : selectedBar(paxSelect, 0),
            cargoThreshold: filterMode === 'range' ? selectedBar(cargoMinSelect, 2) : selectedBar(cargoSelect, 0),
            exceptions: parseExceptions(exceptionsInput.val())
        };
        if (filterMode === 'range') {
            entry.paxMin = selectedBar(paxMinSelect, 1);
            entry.paxMax = selectedBar(paxMaxSelect, 9);
            entry.cargoMin = selectedBar(cargoMinSelect, 2);
            entry.cargoMax = selectedBar(cargoMaxSelect, 10);
            entry.sizeMin = selectedBar(sizeMinSelect, 1);
            entry.sizeMax = selectedBar(sizeMaxSelect, 8);
        }
        settings.stationAutomation = settings.stationAutomation || {};
        settings.stationAutomation.defaultFilterMode = filterMode;
        settings.stationAutomation.defaultPaxThreshold = selectedBar(paxSelect, 0);
        settings.stationAutomation.defaultCargoThreshold = selectedBar(cargoSelect, 0);
        settings.stationAutomation.defaultPaxMin = selectedBar(paxMinSelect, 1);
        settings.stationAutomation.defaultPaxMax = selectedBar(paxMaxSelect, 9);
        settings.stationAutomation.defaultCargoMin = selectedBar(cargoMinSelect, 2);
        settings.stationAutomation.defaultCargoMax = selectedBar(cargoMaxSelect, 10);
        settings.stationAutomation.defaultSizeMin = selectedBar(sizeMinSelect, 1);
        settings.stationAutomation.defaultSizeMax = selectedBar(sizeMaxSelect, 8);
        await saveDashboardArea('stationAutomation');
        record = await StationAutomationStorage.enqueue(server, airlineCode, entry);
        formFeedback.removeClass().addClass('good').text('Added ' + entry.countryName + ' to queue.');
        countrySelect.val('');
        exceptionsInput.val('');
        renderQueue();
    });

    addAllBtn.click(async function() {
        if (!record.queue.length) {
            formFeedback.removeClass().addClass('bad').text('Queue is empty.');
            return;
        }
        addAllBtn.prop('disabled', true);
        formFeedback.removeClass().addClass('warning').text('Reading existing stations + resolving queued airports…');

        const concurrency = parseInt(concSelect.val(), 10) || 6;
        settings.stationAutomation = settings.stationAutomation || {};
        settings.stationAutomation.defaultConcurrency = concurrency;
        saveDashboardArea('stationAutomation');

        // AS's live stations list is the source of truth for "what's already
        // open" — fetch it in parallel with the country resolutions so we
        // don't waste tabs re-opening stations from a prior partial run.
        const [existingIatas, ...resolvedPerCountry] = await Promise.all([
            CountryScraper.loadExistingStationIatas(server).catch(err => {
                console.warn('[AES stationAutomation] existing-stations fetch failed', err);
                return new Set();
            }),
            ...record.queue.map(entry =>
                CountryScraper.resolveStations(entry, server)
                    .then(airports => airports.map(a => ({
                        iata: a.iata,
                        airportId: a.airportId,
                        countryName: entry.countryName,
                        exceptions: entry.exceptions || [],
                    })))
                    .catch(error => {
                        console.warn('[AES stationAutomation] resolve failed for', entry.countryName, error);
                        return [];
                    })
            ),
        ]);
        const resolvedAll = resolvedPerCountry.flat().filter(a => a.airportId);
        const allAirports = resolvedAll.filter(a => !existingIatas.has((a.iata || '').toUpperCase()));
        const alreadyOpenCount = resolvedAll.length - allAirports.length;
        if (!resolvedAll.length) {
            formFeedback.removeClass().addClass('bad').text('No stations match your filters across any queued country.');
            addAllBtn.prop('disabled', false);
            return;
        }
        if (!allAirports.length) {
            formFeedback.removeClass().addClass('good').text(
                `Nothing to open — all ${resolvedAll.length} filtered airport${resolvedAll.length > 1 ? 's are' : ' is'} already in your network.`
            );
            addAllBtn.prop('disabled', false);
            return;
        }

        // Round-robin split so each tab finishes in roughly the same wall time
        // even if some airports are fast (already-operating) and some slow.
        const tabCount = Math.min(concurrency, allAirports.length);
        const chunks = Array.from({length: tabCount}, () => []);
        allAirports.forEach((a, i) => chunks[i % tabCount].push(a));

        const run = StationAutomationStorage.createRun({
            server: server,
            airlineId: airlineCode,
            chunks: chunks,
            concurrency: tabCount,
        });
        await StationAutomationStorage.saveRun(run);
        record.activeRunId = run.runId;
        await StationAutomationStorage.save(record);

        const blockedChunkIdxs = [];
        for (let i = 0; i < run.chunks.length; i++) {
            const first = run.chunks[i][0];
            const url = 'https://' + server + '.airlinesim.aero/app/info/airports/' + first.airportId
                + '#aesStationChunk=' + run.runId + ':' + i;
            const win = window.open(url, '_blank');
            if (!win) blockedChunkIdxs.push(i);
        }
        // If pop-ups blocked any tabs, synthesise failed results for their
        // airports so the run still completes and the progress table doesn't
        // hang on "X/Y processed" forever.
        for (const chunkIdx of blockedChunkIdxs) {
            for (const entry of run.chunks[chunkIdx]) {
                await StationAutomationStorage.writeResult(server, airlineCode, run.runId, entry.flatIdx, {
                    iata: entry.iata,
                    status: 'failed',
                    detail: 'Tab blocked by pop-up blocker.',
                    finishedAt: Date.now(),
                });
            }
        }
        const existingNote = alreadyOpenCount ? ` (skipped ${alreadyOpenCount} already in your network)` : '';
        if (blockedChunkIdxs.length > 0) {
            formFeedback.removeClass().addClass('bad').text(
                `${blockedChunkIdxs.length}/${run.chunks.length} tabs blocked by pop-up blocker. Allow pop-ups for *.airlinesim.aero and retry.${existingNote}`
            );
        } else {
            formFeedback.removeClass().addClass('good').text(
                `Opened ${run.chunks.length} tab${run.chunks.length > 1 ? 's' : ''} processing ${allAirports.length} new airport${allAirports.length > 1 ? 's' : ''}${existingNote}.`
            );
        }
        addAllBtn.prop('disabled', false);
        renderRunDisplay();
    });

    clearQueueBtn.click(async function() {
        // Only clear the queue array — keep activeRunId so an in-flight run
        // remains visible in the progress table while the user prepares a new queue.
        record.queue = [];
        await StationAutomationStorage.save(record);
        formFeedback.removeClass();
        renderQueue();
    });

    refreshCountriesLink.click(async function(e) {
        e.preventDefault();
        countries = [];
        settings.stationAutomation = settings.stationAutomation || {};
        settings.stationAutomation.countriesCache = [];
        await saveDashboardArea('stationAutomation');
        await ensureCountries();
    });

    syncFilterModeUi();
    renderQueue();
    await ensureCountries();

    // Live run display: a single block we re-render whenever tab workers write
    // per-airport results to chrome.storage.
    const runBlock = $('<div></div>');
    panel.append(runBlock);

    async function renderRunDisplay() {
        runBlock.empty();
        const runId = record.activeRunId;
        if (!runId) return;
        const run = await StationAutomationStorage.loadRun(server, airlineCode, runId);
        if (!run) return;
        const results = await StationAutomationStorage.loadResults(server, airlineCode, runId);

        const statusClass = {ok: 'good', skipped: 'warning', 'skipped-existing': 'warning'};
        const counts = {ok: 0, 'skipped-existing': 0, skipped: 0, failed: 0};
        Object.values(results).forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
        const done = Object.keys(results).length;
        const total = run.total;
        const title = done === total ? 'Last run' : 'Run in progress';

        const summary = $('<p style="margin-bottom: 8px;"></p>').text(
            `${done}/${total} processed — Opened ${counts.ok}, already existing ${counts['skipped-existing']}, skipped ${counts.skipped}, failed ${counts.failed}.`
        );

        // Order rows by chunk then position so the log reads naturally.
        const rows = [];
        run.chunks.forEach((chunk, chunkIdx) => {
            chunk.forEach((entry, pos) => {
                const r = results[entry.flatIdx];
                rows.push({
                    iata: entry.iata,
                    country: entry.countryName || '',
                    chunkIdx,
                    pos,
                    status: r?.status || 'pending',
                    detail: r?.detail || '',
                });
            });
        });

        const logTable = $('<table class="table table-bordered table-striped"></table>');
        const logHead = $('<thead><tr><th>Station</th><th>Country</th><th>Tab</th><th>Result</th><th>Detail</th></tr></thead>');
        const logBody = $('<tbody></tbody>');
        rows.forEach(row => {
            const klass = statusClass[row.status] || 'bad';
            logBody.append($('<tr></tr>').append(
                $('<td></td>').text(row.iata),
                $('<td></td>').text(row.country),
                $('<td></td>').text(row.chunkIdx + 1),
                $('<td></td>').html('<span class="' + klass + '">' + row.status + '</span>'),
                $('<td></td>').text(row.detail)
            ));
        });
        logTable.append(logHead, logBody);
        runBlock.append($('<h4></h4>').text(title), summary, $('<div class="as-table-well"></div>').append(logTable));
    }

    // Single storage listener per panel mount. Replace any previous one so
    // repeated re-renders don't stack duplicate listeners.
    if (window._aesStationAutomationListener) {
        chrome.storage.onChanged.removeListener(window._aesStationAutomationListener);
    }
    const prefix = server + airlineCode + 'stationAutomationRun:';
    window._aesStationAutomationListener = (changes, area) => {
        if (area !== 'local' || !record.activeRunId) return;
        for (const key in changes) {
            if (key.indexOf(prefix + record.activeRunId) === 0) {
                renderRunDisplay();
                return;
            }
        }
    };
    chrome.storage.onChanged.addListener(window._aesStationAutomationListener);

    await renderRunDisplay();
}

//Display  default
// Used Aircraft Scanner — singleton controller persists across re-renders so
// an in-flight scan survives navigating away from the panel and back.
var aesUsedAircraftScannerCtrl = null;
async function displayUsedAircraftScanner() {
    const mainDiv = $("#aes-div-dashboard");
    mainDiv.empty();
    mainDiv.append('<h3>Used Aircraft Scanner</h3>');

    const block = await UsedAircraftPresets.load();
    settings.usedAircraftScanner = block;
    let editingId = block.presets[0]?.id || null;

    if (!aesUsedAircraftScannerCtrl) {
        aesUsedAircraftScannerCtrl = new ScanController(server);
    }
    const ctrl = aesUsedAircraftScannerCtrl;

    // Resume any running session from a previous panel visit
    if (block.lastScanId && (!ctrl.session || ctrl.session.scanId !== block.lastScanId)) {
        await ctrl.resume(block.lastScanId);
    }

    // ====== Layout shell ======
    const panel = $('<div class="as-panel"></div>');

    // ----- Preset bar (one-line: dropdown + name + actions) -----
    const presetBar = $('<div></div>').css({
        display:      "flex",
        flexWrap:     "wrap",
        alignItems:   "center",
        gap:          "8px",
        marginBottom: "12px"
    });
    const presetSelect = $('<select id="aes-uas-preset" class="form-control input-sm" style="width:auto; min-width:200px;"></select>');
    const nameInput    = $('<input type="text" id="aes-uas-name" class="form-control input-sm" placeholder="Preset name" style="width:auto; min-width:180px; flex:1; max-width:280px;">');
    const saveBtn      = $('<button type="button" class="btn btn-default btn-sm">Save</button>');
    const newBtn       = $('<button type="button" class="btn btn-default btn-sm">New</button>');
    const dupBtn       = $('<button type="button" class="btn btn-default btn-sm">Duplicate</button>');
    const deleteBtn    = $('<button type="button" class="btn btn-default btn-sm">Delete</button>');
    presetBar.append(
        $('<label for="aes-uas-preset" style="margin:0; font-weight:600;">Preset</label>'),
        presetSelect, nameInput, saveBtn, newBtn, dupBtn, deleteBtn
    );

    // ----- Aircraft types section (fieldset wrapping the picker) -----
    const typesFieldset = $('<fieldset></fieldset>').css({
        marginBottom: "12px",
        padding:      "8px 12px 12px 12px",
        border:       "1px solid #ddd",
        borderRadius: "4px"
    });
    const typesLegend = $('<legend>Aircraft types</legend>').css({
        fontSize: "14px", padding: "0 6px", width: "auto", margin: "0", border: "0"
    });
    const gridContainer = $('<div></div>');
    const validationMsg = $('<div style="margin-top:8px; font-size:90%;"></div>');
    typesFieldset.append(typesLegend, gridContainer, validationMsg);

    // ----- Advanced settings disclosure (default closed) -----
    const advancedSection = makeDisclosureSection({
        title:       "Advanced settings",
        uiKey:       "advancedOpen",
        displayMode: "flex"
    });
    advancedSection.body.css({gap: "16px", flexWrap: "wrap", alignItems: "flex-end"});

    const concInput = $('<input type="number" id="aes-uas-conc" class="form-control input-sm" min="1" max="20" style="width:90px;">').val(block.concurrency);
    const concGroup = $('<div class="form-group" style="margin:0;"></div>').append(
        $('<label for="aes-uas-conc" style="display:block; margin-bottom:4px;">Concurrent tabs (max)</label>'),
        concInput
    );
    const stagInput = $('<input type="number" id="aes-uas-stagger" class="form-control input-sm" min="0" step="100" style="width:120px;">').val(block.staggerMs);
    const stagGroup = $('<div class="form-group" style="margin:0;"></div>').append(
        $('<label for="aes-uas-stagger" style="display:block; margin-bottom:4px;">Stagger between tab opens (ms)</label>'),
        stagInput
    );
    const popupNote = $('<p class="warning" style="font-size:90%; margin:0; flex-basis:100%;">'
        + 'Pop-ups must be allowed for *.airlinesim.aero (chrome://settings/content/popups). '
        + 'Otherwise the 2nd–6th tabs won\'t open.</p>');
    advancedSection.body.append(concGroup, stagGroup, popupNote);

    // ----- Filters & scoring disclosure (default open) -----
    const filtersSection = makeDisclosureSection({title: "Filters & scoring", uiKey: "filtersOpen"});
    const routeBlock   = $('<div style="margin-bottom:12px;"></div>');
    const scoringBlock = $('<div></div>');
    filtersSection.body.append(routeBlock, scoringBlock);

    // ----- Action bar -----
    const actionBar         = $('<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px;"></div>');
    const startBtn          = $('<button type="button" class="btn btn-primary">Start scan</button>');
    const cancelBtn         = $('<button type="button" class="btn btn-default">Cancel</button>');
    const scanStatusInline  = $('<span style="color:#555;"></span>');
    actionBar.append(startBtn, cancelBtn, scanStatusInline);

    // ----- Queue disclosure (auto-toggles on scan transitions) -----
    const queueSection = makeDisclosureSection({title: "Queue", uiKey: "queueOpen"});

    // ----- Results header + body -----
    const resultsHeaderEl = $('<div style="display:flex; justify-content:space-between; align-items:center; margin: 12px 0 8px 0;"></div>');
    const resultsTitle    = $('<h4 style="margin:0;">Results</h4>');
    const csvBtn          = $('<button type="button" class="btn btn-default btn-sm">Download CSV</button>').prop("disabled", true);
    resultsHeaderEl.append(resultsTitle, csvBtn);
    const resultsBlock = $('<div></div>');

    panel.append(
        presetBar,
        typesFieldset,
        advancedSection.root,
        filtersSection.root,
        actionBar,
        queueSection.root,
        resultsHeaderEl,
        resultsBlock
    );
    mainDiv.append(panel);

    // ====== Family grid component ======
    // Singleton across preset switches — only setSelectedTypes is called when
    // editingId changes so in-memory category/search/expansion state survives.
    const familyGrid = new MarketScanFamilyGrid(gridContainer.get(0), {
        onChange:    function() { runValidation(); },
        concurrency: block.concurrency,
        staggerMs:   block.staggerMs,
        typeFamilyOverrides: block.typeFamilyOverrides
    });

    // ====== Disclosure helpers ======
    // Each section persists its open/closed state to block.uiState[uiKey]; the
    // setOpen() returned by makeDisclosureSection skips the chrome.storage
    // write when the value didn't change, so calling setOpen at init or
    // re-running it from a status-transition guard is a safe no-op.
    function makeDisclosureSection(opts) {
        const displayMode = opts.displayMode || "block";
        const root = $('<div></div>').css({
            marginBottom: "12px",
            border:       "1px solid #ddd",
            borderRadius: "4px",
            background:   "#fafafa"
        });
        const header = $('<div></div>').css({
            padding:    "8px 12px",
            cursor:     "pointer",
            userSelect: "none",
            display:    "flex",
            alignItems: "center",
            gap:        "8px"
        });
        const caret   = $('<span style="font-weight:bold; width:1em; text-align:center;"></span>');
        const title   = $('<span style="font-weight:600;"></span>').text(opts.title || "");
        const summary = $('<span style="color:#666; font-size:90%; margin-left:auto;"></span>');
        header.append(caret, title, summary);
        const body = $('<div style="padding: 0 12px 12px 12px;"></div>');
        root.append(header, body);

        function setOpen(open) {
            open = !!open;
            const wasOpen = !!block.uiState[opts.uiKey];
            block.uiState[opts.uiKey] = open;
            caret.text(open ? "▾" : "▸");
            body.css("display", open ? displayMode : "none");
            if (wasOpen !== open) UsedAircraftPresets.save({uiState: block.uiState});
        }
        header.click(() => setOpen(!block.uiState[opts.uiKey]));

        return {root: root, header: header, body: body, summary: summary, setOpen: setOpen};
    }

    // Pop-ups callout stays visible even when Advanced is collapsed — it's the
    // only gotcha that silently breaks the scan if the user forgets it.
    function updateAdvancedSummary() {
        advancedSection.summary.text(
            block.concurrency + " tabs · "
            + block.staggerMs + "ms stagger · pop-ups required"
        );
    }
    updateAdvancedSummary();

    // Apply persisted disclosure state — same value as on disk, so setOpen's
    // change guard skips the redundant storage write.
    advancedSection.setOpen(block.uiState.advancedOpen);
    filtersSection.setOpen(block.uiState.filtersOpen);
    queueSection.setOpen(block.uiState.queueOpen);

    // ====== Helpers ======
    function refreshPresetSelect() {
        presetSelect.empty();
        if (!block.presets.length) {
            presetSelect.append('<option value="">— No presets yet —</option>');
        } else {
            block.presets.forEach(function(p) {
                presetSelect.append($('<option></option>').val(p.id).text(p.name));
            });
        }
        if (editingId) presetSelect.val(editingId);
    }

    function loadEditing() {
        const p = block.presets.find(x => x.id === editingId);
        nameInput.val(p ? p.name : "");
        familyGrid.setSelectedTypes(p ? p.types : []);
        runValidation();
    }

    function runValidation() {
        const types = familyGrid.getSelectedTypes();
        const overrides = block.typeFamilyOverrides || {};
        const unmapped = types.filter(t => !TypeFamilyMap.resolve(t, overrides));
        validationMsg.empty();
        if (!types.length) {
            validationMsg.text("Add at least one aircraft type.");
            startBtn.prop("disabled", true);
            return;
        }
        if (unmapped.length) {
            // Custom (unmapped) types still scan — the controller falls
            // through to "any aircraft family" in resolve(). Surface as a
            // warning, not an error, and keep the start button enabled.
            const ul = $('<ul style="margin:0; padding-left:18px;"></ul>');
            unmapped.forEach(t => ul.append($('<li class="warning"></li>').text(t)));
            validationMsg.append(
                $('<div class="warning">Custom types — will scan under "any aircraft family":</div>'),
                ul
            );
        }
        startBtn.prop("disabled", types.length === 0);
    }

    // ====== Event wiring ======
    presetSelect.change(function() {
        editingId = presetSelect.val() || null;
        loadEditing();
    });

    newBtn.click(async function() {
        const created = await UsedAircraftPresets.create("New preset", []);
        block.presets.push(created);
        editingId = created.id;
        refreshPresetSelect();
        loadEditing();
        nameInput.focus();
    });

    saveBtn.click(async function() {
        const name = nameInput.val().trim();
        const types = familyGrid.getSelectedTypes();
        if (!editingId) {
            const created = await UsedAircraftPresets.create(name || "New preset", types);
            block.presets.push(created);
            editingId = created.id;
        } else {
            await UsedAircraftPresets.update(editingId, {name: name, types: types});
            const p = block.presets.find(x => x.id === editingId);
            if (p) { p.name = name || p.name; p.types = types; }
        }
        refreshPresetSelect();
        runValidation();
    });

    dupBtn.click(async function() {
        if (!editingId) return;
        // Save current edits before cloning so the duplicate matches what the
        // user sees on screen, not the last on-disk version.
        const name = nameInput.val().trim();
        const types = familyGrid.getSelectedTypes();
        await UsedAircraftPresets.update(editingId, {name: name, types: types});
        const p = block.presets.find(x => x.id === editingId);
        if (p) { p.name = name || p.name; p.types = types; }
        const copy = await UsedAircraftPresets.duplicate(editingId);
        if (!copy) return;
        block.presets.push(copy);
        editingId = copy.id;
        refreshPresetSelect();
        loadEditing();
    });

    deleteBtn.click(async function() {
        if (!editingId) return;
        if (!confirm("Delete this preset?")) return;
        await UsedAircraftPresets.remove(editingId);
        block.presets = block.presets.filter(p => p.id !== editingId);
        editingId = block.presets[0]?.id || null;
        refreshPresetSelect();
        loadEditing();
    });

    concInput.change(async function() {
        const v = Math.max(1, Math.min(20, parseInt(concInput.val(), 10) || 6));
        concInput.val(v);
        await UsedAircraftPresets.save({concurrency: v});
        block.concurrency = v;
        familyGrid.setScanParams(block.concurrency, block.staggerMs);
        updateAdvancedSummary();
    });

    stagInput.change(async function() {
        const v = Math.max(0, parseInt(stagInput.val(), 10) || 2000);
        stagInput.val(v);
        await UsedAircraftPresets.save({staggerMs: v});
        block.staggerMs = v;
        familyGrid.setScanParams(block.concurrency, block.staggerMs);
        updateAdvancedSummary();
    });

    startBtn.click(async function() {
        // Save before starting so the running scan reflects the current types
        const name = nameInput.val().trim();
        const types = familyGrid.getSelectedTypes();
        if (editingId) {
            await UsedAircraftPresets.update(editingId, {name: name, types: types});
            const p = block.presets.find(x => x.id === editingId);
            if (p) { p.name = name || p.name; p.types = types; }
        }
        const preset = block.presets.find(x => x.id === editingId)
            || {id: null, name: name || "(unsaved)", types: types};
        await ctrl.start(preset, {
            concurrency: block.concurrency,
            staggerMs: block.staggerMs,
            typeFamilyOverrides: block.typeFamilyOverrides || {}
        });
    });

    cancelBtn.click(async function() {
        await ctrl.cancel();
    });

    // ====== Route requirements (inside filters disclosure) ======
    // Hard-filter the results by route specs (currently: minimum range
    // needed). Anything stricter would belong here too — runway length,
    // takeoff distance, etc. — once those specs are extracted from the
    // type detail page.
    block.routeFilter = Object.assign({minRangeKm: null}, block.routeFilter || {});
    const routeHeader = $('<h5 style="margin:0 0 4px 0;">Route requirements</h5>');
    const routeHelp = $('<p style="font-size:90%; margin:0 0 6px 0; color:#555;">'
        + 'Hide offers whose aircraft can\'t reach this distance. Aircraft with unknown range stay visible. Leave blank to disable.'
        + '</p>');
    const minRangeInput = $('<input type="number" class="form-control input-sm" min="0" step="100" placeholder="e.g. 5500" style="max-width:160px;">');
    if (block.routeFilter.minRangeKm !== null && block.routeFilter.minRangeKm !== undefined) {
        minRangeInput.val(block.routeFilter.minRangeKm);
    }
    const routeRow = $('<div style="display:flex; align-items:center; gap:8px;"></div>')
        .append($('<label style="margin:0; white-space:nowrap;">Min range needed (km):</label>'), minRangeInput);
    routeBlock.append(routeHeader, routeHelp, routeRow);

    minRangeInput.on("input change", async function() {
        const raw = minRangeInput.val();
        const num = raw === "" ? null : Number(raw);
        block.routeFilter = {
            minRangeKm: (num !== null && isFinite(num) && num > 0) ? num : null
        };
        await UsedAircraftPresets.save({routeFilter: block.routeFilter});
        resultsRenderer.setRouteFilter(block.routeFilter);
    });

    // ====== Scoring & filters table (inside filters disclosure) ======
    // Rendered upfront — toggling the filtersOpen disclosure only changes
    // body visibility. Lazy-rendering would break the closure-bound `sync`
    // handlers each row carries.
    block.scoring = block.scoring || {};
    const scoringHeader = $('<h5 style="margin:8px 0 4px 0;">Scoring &amp; filters</h5>');
    const scoringHelp = $('<p style="font-size:90%; margin:0 0 6px 0; color:#555;">'
        + 'Score is a 0–100 ranking blended from every enabled variable, normalised across the offers currently showing. '
        + 'Weight controls how strongly a variable pulls the overall score (default 1; set to 2 to count it double, 0 to ignore even when checked). '
        + 'Filters (min / max) hide offers outside the range — blank = no limit and apply even when scoring is off. Changes re-rank instantly.'
        + '</p>');
    const scoringTable = $('<table class="table table-bordered" style="font-size:90%; margin-bottom:0; background:#fff;"></table>');
    scoringTable.append('<thead><tr>'
        + '<th style="width:60px;">Score</th>'
        + '<th>Variable</th>'
        + '<th>Direction</th>'
        + '<th style="width:90px;">Weight</th>'
        + '<th style="width:140px;">Min</th>'
        + '<th style="width:140px;">Max</th>'
        + '</tr></thead>');
    const scoringBody = $('<tbody></tbody>');
    scoringTable.append(scoringBody);
    scoringBlock.append(scoringHeader, scoringHelp, scoringTable);

    for (const f of MarketScanResultsTable.scoringFields()) {
        const cfg = block.scoring[f.field] = Object.assign(
            {enabled: false, weight: 1, min: null, max: null},
            block.scoring[f.field] || {}
        );
        const cb = $('<input type="checkbox">').prop("checked", !!cfg.enabled);
        const weightInput = $('<input type="number" class="form-control input-sm" min="0" step="0.5">');
        weightInput.val(cfg.weight !== null && cfg.weight !== undefined ? cfg.weight : 1);
        const minInput = $('<input type="number" class="form-control input-sm">');
        const maxInput = $('<input type="number" class="form-control input-sm">');
        if (cfg.min !== null && cfg.min !== undefined) minInput.val(cfg.min);
        if (cfg.max !== null && cfg.max !== undefined) maxInput.val(cfg.max);

        const tr = $('<tr></tr>');
        tr.append($('<td style="text-align:center;"></td>').append(cb));
        tr.append($('<td></td>').text(f.label));
        tr.append($('<td></td>').text(f.direction === "lower" ? "lower = better" : "higher = better"));
        tr.append($('<td></td>').append(weightInput));
        tr.append($('<td></td>').append(minInput));
        tr.append($('<td></td>').append(maxInput));
        scoringBody.append(tr);

        const sync = async function() {
            const wRaw = weightInput.val();
            const wNum = wRaw === "" ? 1 : Number(wRaw);
            block.scoring[f.field] = {
                enabled: cb.prop("checked"),
                weight:  isFinite(wNum) && wNum >= 0 ? wNum : 1,
                min: minInput.val() === "" ? null : Number(minInput.val()),
                max: maxInput.val() === "" ? null : Number(maxInput.val())
            };
            await UsedAircraftPresets.save({scoring: block.scoring});
            resultsRenderer.setScoring(block.scoring);
        };
        cb.change(sync);
        weightInput.on("input change", sync);
        minInput.on("input change", sync);
        maxInput.on("input change", sync);
    }

    // ====== Cross-feature context for deal-scoring (slice 2 of J) ======
    // Fleet + RA economics + RA top-routes feed the new $/seat, break-even,
    // fleet-synergy, and route-fit metrics. All loads fail open — missing
    // data falls back to em-dashes, never blocks the scanner.
    const dealContext = await loadDealContext(server);

    // ====== Results renderer ======
    let resultsRenderer = new MarketScanResultsTable(resultsBlock[0]);
    resultsRenderer.setScoring(block.scoring);
    resultsRenderer.setRouteFilter(block.routeFilter);
    resultsRenderer.setOverrides(block.typeFamilyOverrides);
    resultsRenderer.setContext(dealContext);

    csvBtn.click(function() {
        const session = ctrl.session;
        const scanId  = session ? session.scanId : Date.now().toString(36);
        resultsRenderer.downloadCsv("aes-market-scan-" + scanId + ".csv");
    });

    // ====== Status / queue / results render loop ======
    // Track previous status so we only auto-toggle the queue disclosure on
    // running ↔ terminal transitions — never override the user mid-scan.
    let prevStatus = ctrl.session ? ctrl.session.status : null;

    async function renderState(session) {
        const running = session && session.status === "running";
        startBtn.prop("disabled", running);
        cancelBtn.prop("disabled", !running);

        if (!session) {
            scanStatusInline.text("");
            queueSection.summary.text("");
            queueSection.body.empty();
            resultsBlock.empty();
            resultsTitle.text("Results");
            csvBtn.prop("disabled", true);
            runValidation();
            return;
        }

        const counts = {pending: 0, inflight: 0, ok: 0, error: 0, timeout: 0};
        for (const e of session.queue) counts[e.status] = (counts[e.status] || 0) + 1;
        const total = session.queue.length;
        const done = counts.ok + counts.error + counts.timeout;

        scanStatusInline.html(
            "<strong>" + session.status.toUpperCase() + "</strong> "
            + "— preset: " + escapeHtml(session.presetName || "(unsaved)") + " "
            + "— " + done + "/" + total + " complete "
            + "(" + counts.inflight + " in flight, " + counts.error + " errors, " + counts.timeout + " timeouts)"
        );

        const summaryParts = [done + "/" + total + " complete"];
        if (counts.inflight) summaryParts.push(counts.inflight + " in flight");
        if (counts.error)    summaryParts.push(counts.error + " error" + (counts.error === 1 ? "" : "s"));
        if (counts.timeout)  summaryParts.push(counts.timeout + " timeout" + (counts.timeout === 1 ? "" : "s"));
        queueSection.summary.text(summaryParts.join(" · "));

        // Auto-toggle queue disclosure on status transitions only — outside
        // of transitions the user's manual toggle is respected. Errors/timeouts
        // on a finished scan: leave the queue at the user's preference so the
        // failures stay visible.
        if (prevStatus !== session.status) {
            if (session.status === "running") {
                queueSection.setOpen(true);
            } else if (counts.error === 0 && counts.timeout === 0) {
                queueSection.setOpen(false);
            }
            prevStatus = session.status;
        }

        const qTable = $('<table class="table table-bordered table-striped" style="font-size:90%; margin-bottom:0;"></table>');
        const qHead = $('<thead><tr><th>#</th><th>Type</th><th>Family</th><th>Status</th><th>Note</th></tr></thead>');
        const qBody = $('<tbody></tbody>');
        session.queue.forEach(function(e, i) {
            const tr = $('<tr></tr>');
            tr.append($('<td></td>').text(i + 1));
            tr.append($('<td></td>').text(e.type));
            tr.append($('<td></td>').text(e.family || "—"));
            tr.append($('<td></td>').html(statusBadge(e.status)));
            tr.append($('<td></td>').text(e.error || ""));
            qBody.append(tr);
        });
        qTable.append(qHead, qBody);
        queueSection.body.empty().append($('<div class="as-table-well"></div>').append(qTable));

        const rows = await ctrl.aggregatedRows();
        resultsTitle.text("Results (" + rows.length + " offers)");
        csvBtn.prop("disabled", !rows.length);
        resultsRenderer.render(rows);
    }

    function statusBadge(status) {
        const colors = {
            pending:  "#888",
            inflight: "#3b82f6",
            ok:       "#16a34a",
            error:    "#dc2626",
            timeout:  "#ea580c"
        };
        const color = colors[status] || "#666";
        return '<span style="display:inline-block; padding:2px 8px; border-radius:4px; '
            + 'background:' + color + '; color:white; font-size:85%;">' + status + '</span>';
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // Subscribe to controller updates
    ctrl.listeners = []; // reset listeners attached in a previous render
    ctrl.onUpdate(function(session) { renderState(session); });

    // Refresh deal-context (route-fit, fleet, economics) when the RA panel
    // republishes topRoutes. RA writes BOTH the global key and a per-hub key
    // on every render → debounce so a single panel render = one refresh.
    if (window._aesTopRoutesListener) {
        chrome.storage.onChanged.removeListener(window._aesTopRoutesListener);
        window._aesTopRoutesListener = null;
    }
    let topRoutesDebounce = null;
    const topRoutesListener = (changes, area) => {
        if (area !== "local") return;
        if (!changes["routeAssistant:topRoutes"]) return;
        if (topRoutesDebounce) clearTimeout(topRoutesDebounce);
        topRoutesDebounce = setTimeout(async () => {
            try {
                const fresh = await loadDealContext(server);
                resultsRenderer.setContext(fresh);
                renderState(ctrl.session);
            } catch (e) {
                console.warn("[AES UsedAircraftScanner] topRoutes refresh failed:", e);
            }
        }, 250);
    };
    chrome.storage.onChanged.addListener(topRoutesListener);
    window._aesTopRoutesListener = topRoutesListener;

    // Initial paint
    refreshPresetSelect();
    loadEditing();
    renderState(ctrl.session);
}

/**
 * Loads cross-feature context for the Used Aircraft Scanner deal-scoring
 * metrics: the user's fleet (for synergy lookup), the Route Assistant
 * economics block (for break-even math), and the latest top-routes
 * snapshot the RA panel publishes (for route-fit count).
 *
 * Every load is best-effort. Missing pieces leave the corresponding
 * metric as null — the table renders an em-dash and the score blend
 * skips the row for that variable instead of zeroing it.
 */
async function loadDealContext(server) {
    const ctx = {fleetByType: null, economics: null, topRoutes: null, topRoutesHub: null,
                 routeFitConfig: null};
    try {
        const fleet = await RouteAssistantFleetStore.loadFleet(server, null);
        if (fleet && fleet.byType) ctx.fleetByType = fleet.byType;
    } catch (e) {
        console.warn("[AES UsedAircraftScanner] fleet load failed:", e);
    }
    try {
        const ra = await RouteAssistantSettings.load();
        if (ra && ra.economics) ctx.economics = ra.economics;
    } catch (e) {
        console.warn("[AES UsedAircraftScanner] RA settings load failed:", e);
    }
    try {
        const data = await chrome.storage.local.get(["routeAssistant:topRoutes"]);
        const blob = data && data["routeAssistant:topRoutes"];
        if (blob && Array.isArray(blob.rows)) {
            ctx.topRoutes    = blob.rows;
            ctx.topRoutesHub = blob.hub || null;
        }
    } catch (e) {
        console.warn("[AES UsedAircraftScanner] topRoutes load failed:", e);
    }
    try {
        const presets = await UsedAircraftPresets.load();
        if (presets && presets.routeFit) ctx.routeFitConfig = presets.routeFit;
    } catch (e) {
        console.warn("[AES UsedAircraftScanner] routeFit config load failed:", e);
    }
    return ctx;
}

function displayDefault() {
    let mainDiv = $("#aes-div-dashboard");
    mainDiv.empty();
}

//Table sort and other functions
function SortTable(collumn, number, tableId, collumnPrefix) {
    let tableRows = $('#' + tableId + ' tbody tr');
    let tableBody = $('#' + tableId + ' tbody');
    tableBody.empty();
    let indexes = [];
    tableRows.each(function() {
        if (number) {
            let value = parseInt($(this).find("." + collumnPrefix + collumn).text(), 10);
            if (value) {
                indexes.push(value);
            } else {
                indexes.push(0);
            }
        } else {
            indexes.push($(this).find("." + collumnPrefix + collumn).text());
        }
    });
    indexes = [...new Set(indexes)];
    let sorted = [...indexes];
    if (number) {
        sorted.sort(function(a, b) {
            if (a > b) return -1;
            if (a < b) return 1;
            if (a = b) return 0;
        });
    } else {
        sorted.sort();
    }
    let same = 1;
    for (let i = 0; i < indexes.length; i++) {
        if (indexes[i] !== sorted[i]) {
            same = 0;
        }
    }
    if (same) {
        if (number) {
            sorted.sort(function(a, b) {
                if (a < b) return -1;
                if (a > b) return 1;
                if (a = b) return 0;
            });
        } else {
            sorted.reverse();
        }
    }
    for (let i = 0; i < sorted.length; i++) {
        for (let j = tableRows.length - 1; j >= 0; j--) {
            if (number) {
                let value = parseInt($(tableRows[j]).find("." + collumnPrefix + collumn).text(), 10);
                if (!value) {
                    value = 0;
                }
                if (value == sorted[i]) {
                    tableBody.append($(tableRows[j]));
                    tableRows.splice(j, 1);
                }
            } else {
                if ($(tableRows[j]).find("." + collumnPrefix + collumn).text() == sorted[i]) {
                    tableBody.append($(tableRows[j]));
                    tableRows.splice(j, 1);
                }
            }
        }
    }
}

//Helper
function getDate(type, scheduleData) {
    switch (type) {
        case 'schedule':
            //scheduleData must be schedule object with dates as properties
            let dates = [];
            for (let date in scheduleData) {
                if (Number.isInteger(parseInt(date))) {
                    dates.push(date);
                }
            }
            dates.reverse();
            return dates[0];
        default:
            return 0;
    }
}

// Schedule Management — preset-driven, wave-aware schedule designer.
// Singleton panel persists across re-renders so editor state survives a tab swap.
var aesSchedulePanel = null;
function getScheduleManagementAirlineKey() {
    try {
        if (typeof AES !== "undefined" && AES.getAirlineIdentity) {
            const identity = AES.getAirlineIdentity();
            if (identity) return identity;
        }
    } catch (_) { /* fall through */ }
    return airline && airline.code || "";
}

async function displayScheduleManagement() {
    const mainDiv = document.getElementById("aes-div-dashboard");
    mainDiv.innerHTML = "";
    const root = document.createElement("div");
    mainDiv.append(root);
    aesSchedulePanel = new SchedulePanel(root, {
        server: server,
        airlineCode: getScheduleManagementAirlineKey()
    });
    await aesSchedulePanel.render();
}

// Flights From — scrapes flightsfrom.com airport pages for real-world routes
// and exposes the cached data for the scheduling-page side-by-side overlay.
var aesFlightsFromCtrl = null;
async function displayFlightsFrom() {
    const mainDiv = $("#aes-div-dashboard");
    mainDiv.empty();
    mainDiv.append('<h3>Flights From (real-world demand)</h3>');

    if (!aesFlightsFromCtrl) aesFlightsFromCtrl = new FlightsFromController();
    const ctrl = aesFlightsFromCtrl;

    const panel = $('<div class="as-panel"></div>');
    const scanForm = $('<div class="form-inline" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-bottom:12px;"></div>');
    const iataGroup = $('<div class="form-group"></div>');
    iataGroup.append('<label for="aes-ff-iata">Airport IATA</label>');
    const iataInput = $('<input type="text" id="aes-ff-iata" class="form-control" maxlength="3" style="text-transform:uppercase;width:96px;" placeholder="LHR">');
    iataGroup.append(iataInput);
    const scanBtn   = $('<button type="button" class="btn btn-primary">Scan airport</button>');
    const cancelBtn = $('<button type="button" class="btn btn-default">Cancel</button>');
    scanForm.append(iataGroup, scanBtn, cancelBtn);

    const popupNote = $('<p class="warning" style="font-size:90%;margin-top:4px;">'
        + 'Pop-ups must be allowed for www.flightsfrom.com, otherwise the scrape tab will not open.</p>');

    const statusBlock = $('<div style="margin:12px 0;"></div>');
    const airportsBlock = $('<div style="margin-bottom:12px;"></div>');
    const routesBlock = $('<div></div>');
    panel.append(scanForm, popupNote, statusBlock, airportsBlock, routesBlock);
    mainDiv.append(panel);

    function renderStatus(scan) {
        statusBlock.empty();
        scanBtn.prop("disabled", !!(scan && scan.status === "running"));
        cancelBtn.prop("disabled", !(scan && scan.status === "running"));
        if (!scan) return;
        const phase = scan.progress && scan.progress.phase ? scan.progress.phase : "";
        const parts = [
            "<strong>" + scan.iata + "</strong>",
            scan.status.toUpperCase(),
            phase ? "(" + phase + ")" : ""
        ].filter(Boolean);
        statusBlock.html('<div>' + parts.join(" — ") + (scan.error ? ' <span style="color:#dc2626;">' + escapeHtml(scan.error) + '</span>' : '') + '</div>');
    }

    ctrl.onUpdate(scan => {
        renderStatus(scan);
        // Refresh the cached list whenever a scan ends.
        if (scan && scan.status !== "running") refreshAirports();
    });

    scanBtn.click(async function() {
        const iata = (iataInput.val() || "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(iata)) {
            statusBlock.html('<div style="color:#dc2626;">Enter a 3-letter IATA code.</div>');
            return;
        }
        try {
            await ctrl.start(iata);
        } catch (e) {
            statusBlock.html('<div style="color:#dc2626;">' + escapeHtml(e.message || String(e)) + '</div>');
        }
    });
    cancelBtn.click(async function() { await ctrl.cancel(); });

    let selectedIata = null;
    async function refreshAirports() {
        const list = await FlightsFromStore.listAirports();
        airportsBlock.empty();
        if (!list.length) {
            airportsBlock.html('<p style="color:#666;">No airports scanned yet.</p>');
            routesBlock.empty();
            return;
        }
        airportsBlock.append('<h4 style="margin:0 0 6px 0;">Cached airports</h4>');
        const table = $('<table class="table table-striped table-hover" style="width:auto;font-size:90%;"></table>');
        table.append('<thead><tr><th>IATA</th><th>Airport</th><th>Routes</th><th>Scraped</th><th></th></tr></thead>');
        const tbody = $('<tbody></tbody>');
        for (const a of list) {
            const tr = $('<tr style="cursor:pointer;"></tr>');
            if (a.iata === selectedIata) tr.css("background", "rgba(59,130,246,.15)");
            const age = a.scrapedAt ? Math.round((Date.now() - a.scrapedAt) / 3600e3) + "h ago" : "—";
            tr.append($('<td></td>').text(a.iata));
            tr.append($('<td></td>').text(a.airportName || "—"));
            tr.append($('<td style="text-align:right;"></td>').text(a.routeCount));
            tr.append($('<td></td>').text(age));
            const delBtn = $('<button class="btn btn-xs btn-default" title="Delete">✕</button>');
            delBtn.click(async function(ev) {
                ev.stopPropagation();
                if (!confirm("Delete cached data for " + a.iata + "?")) return;
                await FlightsFromStore.deleteAirport(a.iata);
                if (selectedIata === a.iata) { selectedIata = null; routesBlock.empty(); }
                await refreshAirports();
            });
            tr.append($('<td></td>').append(delBtn));
            tr.click(function() { selectedIata = a.iata; refreshAirports(); renderRoutes(a.iata); });
            tbody.append(tr);
        }
        table.append(tbody);
        airportsBlock.append(table);
    }

    async function renderRoutes(iata) {
        routesBlock.empty();
        const rec = await FlightsFromStore.loadAirport(iata);
        if (!rec || !rec.routes || !rec.routes.length) {
            routesBlock.html('<p style="color:#666;">No routes stored for ' + iata + '.</p>');
            return;
        }
        routesBlock.append('<h4 style="margin:0 0 6px 0;">' + iata + (rec.airportName ? ' — ' + escapeHtml(rec.airportName) : '') + ' · ' + rec.routes.length + ' routes</h4>');
        const table = $('<table class="table table-bordered table-striped" style="font-size:90%;"></table>');
        table.append('<thead><tr>'
            + '<th>Dest</th><th>Name</th>'
            + '<th style="text-align:right;">Weekly</th>'
            + '<th style="text-align:right;">Seats/Wk</th>'
            + '<th style="text-align:right;">km</th>'
            + '<th>Airlines</th>'
            + '</tr></thead>');
        const tbody = $('<tbody></tbody>');
        const sorted = rec.routes.slice().sort((a, b) =>
            (b.seatsPerWeek || b.weeklyFlights || 0) - (a.seatsPerWeek || a.weeklyFlights || 0));
        for (const r of sorted) {
            const tr = $('<tr></tr>');
            tr.append($('<td></td>').text(r.destIata || "—"));
            tr.append($('<td></td>').text(r.destName || "—"));
            tr.append($('<td style="text-align:right;"></td>').text(r.weeklyFlights || "—"));
            tr.append($('<td style="text-align:right;"></td>').text(r.seatsPerWeek ? r.seatsPerWeek.toLocaleString() : "—"));
            tr.append($('<td style="text-align:right;"></td>').text(r.distanceKm || "—"));
            tr.append($('<td></td>').text(r.airlines || "—"));
            tbody.append(tr);
        }
        table.append(tbody);
        routesBlock.append($('<div class="as-table-well"></div>').append(table));
    }

    await refreshAirports();
}
