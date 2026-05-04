"use strict";
//MAIN
//Global vars
var settings, pricingData, todayDate, analysis;
var aesmodule = { valid: true, error: [] };
var inventoryObserver = null;
var inventoryRefreshTimer = 0;
var inventoryRenderSignature = "";
const INVENTORY_CLASS_ORDER = ["Y", "C", "F", "Cargo"];
const INVENTORY_DEFAULT_RECOMMENDATION_STEPS = [
    { min:  0, max:  40, name: "Drop High",   step: -8 },
    { min: 40, max:  60, name: "Drop Medium", step: -4 },
    { min: 60, max:  70, name: "Drop Low",    step: -2 },
    { min: 70, max:  80, name: "Keep",        step:  0 },
    { min: 80, max:  90, name: "Raise Low",   step:  1 },
    { min: 90, max:  99, name: "Raise Medium",step:  2 },
    { min: 99, max: 100, name: "Raise High",  step:  5 }
];
const INVENTORY_CLASS_PROFILES = {
    Y: {
        label: "Economy",
        targetLoad: 84,
        elasticity: 1.00,
        maxStep: 7,
        deadband: 4,
        floorCaution: 76,
        ceilingCaution: 158,
        confidenceCap: 1200
    },
    C: {
        label: "Business",
        targetLoad: 76,
        elasticity: 0.82,
        maxStep: 5,
        deadband: 5,
        floorCaution: 82,
        ceilingCaution: 165,
        confidenceCap: 220
    },
    F: {
        label: "First",
        targetLoad: 66,
        elasticity: 0.62,
        maxStep: 4,
        deadband: 6,
        floorCaution: 88,
        ceilingCaution: 175,
        confidenceCap: 80
    },
    Cargo: {
        label: "Cargo",
        targetLoad: 80,
        elasticity: 0.92,
        maxStep: 7,
        deadband: 5,
        floorCaution: 70,
        ceilingCaution: 150,
        confidenceCap: 900
    }
};

function saveInvPricingSettings() {
    return window.AesSettings.saveArea("invPricing", settings.invPricing)
}

function isInventoryExtensionContextInvalidated(error) {
    const message = error && error.message ? error.message : String(error || "")
    return /Extension context invalidated/i.test(message)
}

function inventoryStorageErrorMessage(error) {
    if (isInventoryExtensionContextInvalidated(error)) {
        return "Extension context was reloaded. Refresh Inventory and retry."
    }
    return error && error.message ? error.message : String(error)
}

async function setInventoryStorage(items) {
    if (window.AesWriteThrough && typeof window.AesWriteThrough.set === "function") {
        const result = await window.AesWriteThrough.set(items)
        if (result && result.skipped) {
            throw new Error("Extension context invalidated")
        }
        return result
    }
    try {
        await chrome.storage.local.set(items)
    } catch (error) {
        throw error
    }
    return {keys: Object.keys(items || {})}
}

async function initInventory(ctx) {
    settings = ctx && ctx.settings ? ctx.settings : await getSettings()
    inventoryRenderSignature = ""
    watchInventoryLayout()
    await rerenderInventoryModule(true)
}

AesBoot.register({
    id: "content-inventory",
    matches: "inventory",
    deps: [
        "AesSettings",
        function inventoryValidationReady(){ return typeof Validation !== "undefined" }
    ],
    anchor: function inventoryAnchor() {
        return document.querySelector("#inventory-table")
            || document.querySelector("#inventory-grouped-table")
    },
    init: initInventory
})

/**
 * Track the table layout so the MutationObserver can detect when the user
 * toggles "Group by flight" — the classic and grouped tables have distinct
 * IDs, and the row count signature also changes when filters are applied.
 */
function getInventorySignature() {
    const groupedBodies = document.querySelectorAll("#inventory-grouped-table tbody").length
    const classicRows = document.querySelectorAll("#inventory-table tbody tr").length
    return [groupedBodies, classicRows].join(":")
}

function cleanupInventoryDisplay() {
    $("#aes-h3-analysis, #aes-div-analysis, #aes-h3-history, #aes-div-invPricing-historicalData, #aes-h3-validation, #aes-panel-validation").remove()
}

/**
 * Watch the AS inventory area for layout changes (Group by flight toggle,
 * filter apply, native re-render after a price update) so AES can rerender
 * without forcing a full page refresh. Backport of upstream v0.7.8 behavior.
 */
function watchInventoryLayout() {
    if (inventoryObserver) return
    const target = document.querySelector(".container-fluid .row .col-md-10") || document.body
    inventoryObserver = new MutationObserver(function() {
        clearTimeout(inventoryRefreshTimer)
        inventoryRefreshTimer = window.setTimeout(function() {
            rerenderInventoryModule(false)
        }, 150)
    })
    inventoryObserver.observe(target, { childList: true, subtree: true })
}

async function rerenderInventoryModule(force) {
    const nextSignature = getInventorySignature()
    if (!force && nextSignature === inventoryRenderSignature) return
    inventoryRenderSignature = nextSignature

    cleanupInventoryDisplay()
    settings = await getSettings()
    aesmodule = new Validation()

    if (!aesmodule.valid) {
        displayValidationError()
        return
    }
    try {
        await displayInventory()
    } catch (error) {
        if (error && /Unable to read inventory data/.test(String(error.message || error))) {
            return
        }
        throw error
    }
}

/**
 * Get settings from local storage
 * @returns {object} data.settings
 */
async function getSettings() {
    if (window.AesBoot && typeof window.AesBoot.prepareContext === "function") {
        const ctx = await window.AesBoot.prepareContext()
        if (ctx && ctx.settings) return ctx.settings
    }
    const data = await chrome.storage.local.get(['settings'])
    return AES.normalizeSettings(data.settings)
}

async function displayInventory() {
    todayDate = parseInt(AES.getServerDate().date, 10);
    //Get flights
    let flights = getFlights();
    let prices = getPriceDetails();
    let storageKey = getPricingInventoryKey();
    
    //Check if any snapshots saved
    let defaultPricingData = {
        server: storageKey.server,
        airline: storageKey.airline,
        type: storageKey.type,
        origin: storageKey.origin,
        destination: storageKey.destination,
        key: storageKey.key,
        date: {}
    }
    const storageData = await chrome.storage.local.get({[storageKey.key]: defaultPricingData})
    pricingData = storageData[storageKey.key]
        
    //Do Analysis
    analysis = getAnalysis(flights, prices, pricingData.date);
    //Display analysis
    displayAnalysis(analysis, prices);
    //Display history
    displayHistory(analysis);


    //Automation
    //Check if valid analysis exists
    if (analysis.hasValue('valid')) {
        //CHeck if updated todayDate
        if (pricingData.date[todayDate]) {
            //Today update exists
            //Check if pricing updated today
            if (pricingData.date[todayDate].pricingUpdated) {
                //Pricing updated today
                //Do nothing
            } else {
                //Pricing not updated today
                //Check if new price avaialble
                if (analysis.hasValue('newPrice')) {
                    //Update price
                    if (settings.invPricing.autoPriceUpdate) {
                        $('#aes-btn-invPricing-apply-new-prices').click();
                    }
                }
            }
        } else {
            //Today update does not exists
            //Check if new price avaialble
            if (analysis.hasValue('newPrice')) {
                //Update price
                if (settings.invPricing.autoPriceUpdate) {
                    $('#aes-btn-invPricing-apply-new-prices').click();
                } else if (settings.invPricing.autoAnalysisSave) {
                    $('#aes-btn-invPricing-save-snapshot').click();
                }
            } else {
                //Update data
                if (settings.invPricing.autoAnalysisSave) {
                    $('#aes-btn-invPricing-save-snapshot').click();
                }
            }
        }
    }
}

/**
 * Get Flights — supports both the classic flat inventory table and the
 * "Group by flight" layout introduced in upstream AES v0.7.8.
 * @returns {array} flights - array of flight objects
 */
function getFlights() {
    const groupedTableBodies = document.querySelectorAll("#inventory-grouped-table tbody")
    if (groupedTableBodies.length) {
        return getGroupedFlights(groupedTableBodies)
    }

    const flights = []
    const flightTable = document.querySelector("#inventory-table")

    if (!flightTable) {
        throw new Error("Unable to read inventory data. The inventory page layout might have changed.")
    }

    const flightRows = flightTable.querySelectorAll("tbody tr")

    for (const row of flightRows) {
        const flight = getFlight(row)
        if (flight) {
            flights.push(flight)
        }
    }

    return flights
}

/**
 * Get flights from the "Group by flight" layout. Each `<tbody>` represents
 * one flight (one date for one numbered flight): the first row carries the
 * flight number, date, and status alongside the first compartment's data;
 * subsequent rows carry only per-compartment data starting at cell[0].
 *
 * Backport of upstream AES v0.7.8 `getGroupedFlights`. Adapted to current
 * fork's parsers (`getCompCode`, `parseInventoryPrice`) for cmp-aware Cargo
 * decimals and null-safe row filtering.
 * @param {NodeListOf<HTMLTableSectionElement>} groupedTableBodies
 * @returns {array} flights
 */
function getGroupedFlights(groupedTableBodies) {
    const flights = []

    for (const tbody of groupedTableBodies) {
        const rows = tbody.querySelectorAll("tr")
        if (!rows.length) continue

        const sharedCells = rows[0].querySelectorAll("td")
        if (sharedCells.length < 11) continue

        const flightLink = sharedCells[1].querySelector("a[href*='numbers']")
        if (!flightLink) continue
        const flightNumber = flightLink.innerText
        const date = sharedCells[2].innerText
        const status = sharedCells[10].innerText.replace(/\s+/g, "")

        for (const row of rows) {
            const cells = row.querySelectorAll("td")
            if (cells.length < 5) continue

            const groupedCells = row === rows[0] ? {
                compCell: cells[5],
                capCell: cells[6],
                bkdCell: cells[7],
                priceCell: cells[9]
            } : {
                compCell: cells[0],
                capCell: cells[1],
                bkdCell: cells[2],
                priceCell: cells[4]
            }

            const compCode = getCompCode(groupedCells.compCell.innerText)
            if (!compCode) continue

            flights.push({
                fltNr: flightNumber,
                date: date,
                cmp: compCode,
                cap: AES.cleanInteger(groupedCells.capCell.innerText),
                bkd: AES.cleanInteger(groupedCells.bkdCell.innerText),
                price: parseInventoryPrice(groupedCells.priceCell.innerText, compCode),
                status: status
            })
        }
    }

    return flights
}

/**
 * Get flight information and return as an object
 * @param {HTMLElement} row - the <tr> with flight information
 * @returns {object|null} flight - object with the parsed flight information
 */
function getFlight(row) {
    const cells = row.querySelectorAll("td")
    if (cells.length < 11) {
        return null
    }

    const flightLink = cells[1].querySelector("a[href*='numbers']")
    if (!flightLink) {
        return null
    }

    const flightNumber = flightLink.innerText
    const date = cells[2].innerText
    const compCode = getCompCode(cells[5].innerText)
    if (!compCode) {
        return null
    }
    const capacity = cells[6].innerText
    const booked = cells[7].innerText
    const price = cells[9].innerText
    const status = cells[10].innerText.replace(/\s+/g, "")

    const flight = {
        fltNr: flightNumber,
        date: date,
        cmp: compCode,
        cap: AES.cleanInteger(capacity),
        bkd: AES.cleanInteger(booked),
        price: parseInventoryPrice(price, compCode),
        status: status
    }
    
    return flight
}

function getCompCode(text) {
    const raw = String(text || "").trim()
    if (!raw) {
        return null
    }

    const normalized = raw.replace(/\s+/g, " ").toLowerCase()
    if (/^cargo$/i.test(raw) || /cargo|freight|mail|fracht/.test(normalized)) {
        return "Cargo"
    }
    if (/^y$/i.test(raw) || /\b(y|economy|eco|tourist)\b/i.test(raw)) {
        return "Y"
    }
    if (/^c$/i.test(raw) || /\b(c|business|biz)\b/i.test(raw)) {
        return "C"
    }
    if (/^f$/i.test(raw) || /\b(f|first)\b/i.test(raw)) {
        return "F"
    }

    return raw.length > 1 ? "Cargo" : raw.toUpperCase()
}

/**
 * Get Prices
 * @returns {object} prices
 */
function getPriceDetails() {
    const pricingRows = document.querySelectorAll(".pricing table tbody tr")
    const prices = {}
    
    for (const row of pricingRows) {
        const cells = row.querySelectorAll("td")
        if (!cells || cells.length < 5) {
            continue
        }
        const cmp = getCompCode(cells[0].innerText)
        if (!cmp) {
            continue
        }
        const price = getPrice(cells, cmp)
        
        prices[cmp] = price
    }

    return prices
}

/**
 * Get price
 * @param {array} cells
 * @returns {object} price
 */
function getPrice(cells, cmp) {
    const currentPrice = parseInventoryPrice(cells[1].innerText, cmp)
    const defaultPrice = parseInventoryPrice(cells[4].innerText.replace(/\s+/g, ''), cmp)
    const currentPricePoint = getCurrentPricePoint(currentPrice, defaultPrice)
    const newPriceInput = cells[2].querySelector("input")
    
    const price = {
        currentPrice: currentPrice,
        defaultPrice: defaultPrice,
        currentPricePoint: currentPricePoint,
        newPriceInput: newPriceInput
    }
    
    return price
}

/**
 * @param {string} currentPrice
 * @param {string} defaultPrice
 * @returns {integer}
 */
function getCurrentPricePoint(currentPrice, defaultPrice) {
    if (!defaultPrice) {
        return 0
    }
    return Math.round((currentPrice / defaultPrice) * 100)
}

function cleanInventoryInteger(value) {
    if (typeof AES !== "undefined" && AES.cleanInteger) {
        const n = AES.cleanInteger(String(value || ""))
        return isFinite(n) ? n : null
    }
    const n = parseInt(String(value || "").replace(/[^\d-]/g, ""), 10)
    return isFinite(n) ? n : null
}

function parseInventoryPrice(value, cmp) {
    if (cmp !== "Cargo") {
        return cleanInventoryInteger(value)
    }
    const raw = String(value || "").trim().replace(/[^\d,.\-]/g, "")
    if (!raw || raw === "-") return 0
    const sign = raw.charAt(0) === "-" ? -1 : 1
    const body = sign < 0 ? raw.slice(1) : raw
    const sep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","))
    if (sep >= 0) {
        const whole = body.slice(0, sep).replace(/\D/g, "")
        const frac = body.slice(sep + 1).replace(/\D/g, "")
        if (frac.length > 0 && frac.length <= 2) {
            const n = Number((whole || "0") + "." + frac)
            return isFinite(n) ? Math.round(sign * n * 100) / 100 : 0
        }
    }
    const n = Number(body.replace(/\D/g, ""))
    return isFinite(n) ? sign * n : 0
}

function roundInventoryPrice(cmp, value) {
    const n = Number(value)
    if (!isFinite(n)) return 0
    if (cmp === "Cargo") {
        return Math.round(n * 100) / 100
    }
    return Math.round(n)
}

function getInventoryClassProfile(cmp) {
    return INVENTORY_CLASS_PROFILES[cmp] || INVENTORY_CLASS_PROFILES.Y
}

function getInventoryRecommendationConfig(cmp) {
    const recommendation = settings && settings.invPricing && settings.invPricing.recommendation
        ? settings.invPricing.recommendation
        : {}
    const config = recommendation[cmp] || recommendation.Y || {}
    return {
        minPrice: Number.isFinite(Number(config.minPrice)) ? Number(config.minPrice) : 60,
        maxPrice: Number.isFinite(Number(config.maxPrice)) ? Number(config.maxPrice) : 200,
        steps: Array.isArray(config.steps) && config.steps.length
            ? config.steps
            : INVENTORY_DEFAULT_RECOMMENDATION_STEPS
    }
}

function createEmptyClassAnalysis(cmp, price) {
    return {
        classKey: cmp,
        totalCap: 0,
        totalBkd: 0,
        flightCount: 0,
        valid: 0,
        served: !!price,
        analysisPrice: price ? price.currentPrice : 0,
        analysisPricePoint: price ? price.currentPricePoint : 0,
        useCurrentPrice: 0,
        demandFallback: 0,
        demandSource: "",
        currentPrice: price ? price.currentPrice : 0,
        currentPricePoint: price ? price.currentPricePoint : 0,
        defaultPrice: price ? price.defaultPrice : 0,
        confidence: 0,
        breakdown: null,
        referenceRecommendation: 0,
        referenceRecType: "neutral",
        referenceNewPrice: 0,
        referenceNewPricePoint: 0
    }
}

function normalizeInventoryStatus(status) {
    return String(status || "").toLowerCase().replace(/\s+/g, "")
}

function isInventoryDemandFlight(flight) {
    const status = normalizeInventoryStatus(flight && flight.status)
    return status === "finished"
        || status === "inflight"
        || status === "booked"
        || status === "booking"
        || status === "scheduled"
        || status === "planned"
}

function isSettledInventoryFlight(flight) {
    const status = normalizeInventoryStatus(flight && flight.status)
    return status === "finished" || status === "inflight"
}

function averageInventoryFlightPrice(flights, cmp) {
    let total = 0
    let weight = 0
    for (let i = 0; i < flights.length; i++) {
        const flight = flights[i]
        const cap = Number(flight && flight.cap) || 0
        const price = Number(flight && flight.price) || 0
        if (cap > 0 && price > 0) {
            total += price * cap
            weight += cap
        }
    }
    return weight ? roundInventoryPrice(cmp, total / weight) : 0
}

function addInventoryFlightsToClass(data, flights) {
    for (let i = 0; i < flights.length; i++) {
        data.totalCap += Number(flights[i].cap) || 0
        data.totalBkd += Number(flights[i].bkd) || 0
    }
    data.flightCount = flights.length
    data.valid = data.totalCap > 0
}

async function getInventoryQuickPriceGate(scopeName) {
    let stored = null
    try {
        if (window.AesSettings && typeof window.AesSettings.loadAll === "function") {
            stored = await window.AesSettings.loadAll()
        } else {
            const data = await chrome.storage.local.get(["settings"])
            stored = data && data.settings || null
        }
    } catch (_) {
        stored = null
    }
    const ra = stored && stored.routeAssistant || {}
    const apply = ra.pricing && ra.pricing.apply || {}
    const scope = scopeName || "manual"
    const gate = window.RouteAssistantPricingPlumbing
        && typeof window.RouteAssistantPricingPlumbing.resolveApplyGate === "function"
        ? window.RouteAssistantPricingPlumbing.resolveApplyGate(apply, scope)
        : (function() {
            const liveScopes = apply.liveScopes || {}
            const scopeLiveAllowed = liveScopes[scope] !== false
            const applyEnabled = apply.enabled !== false
            const dryRunOnly = apply.dryRunOnly !== false
            return {
                applyEnabled,
                dryRunOnly,
                liveScopeAllowed: scopeLiveAllowed,
                dryRun: dryRunOnly || !applyEnabled || !scopeLiveAllowed
            }
        })()
    return {
        applyEnabled: gate.applyEnabled && gate.scopeLiveAllowed,
        dryRunOnly: gate.dryRun,
        liveScope: scope,
        liveScopeAllowed: gate.scopeLiveAllowed
    }
}

function emptyInventoryHistoryClass(cmp) {
    return createEmptyClassAnalysis(cmp, null)
}

function inventoryHistoryClassData(snapshot, cmp) {
    if (!snapshot || !snapshot.data || !snapshot.data[cmp]) {
        return emptyInventoryHistoryClass(cmp)
    }
    return snapshot.data[cmp]
}

//Get Analysis
function getAnalysis(flights, prices, storedData) {
    //Setup object
    let mostRecentDate
    let mostRecentData
    let data = {}
    INVENTORY_CLASS_ORDER.forEach(function(cmp) {
        data[cmp] = 0
    })
    let analysis = {
        data: data,
        previousData: null,
        getLoad: function(cmp) {
            if (this.data[cmp] && this.data[cmp].valid) {
                return this.data[cmp].totalBkd / this.data[cmp].totalCap;
            } else {
                return 0;
            }
        },
        note: function(cmp) {
            if (this.data[cmp] && this.data[cmp].valid) {
                if (this.data[cmp].demandFallback) {
                    return "Observed demand fallback"
                } else if (this.data[cmp].useCurrentPrice) {
                    return "Current price demand"
                } else {
                    return "No current price flights, using old price"
                }
            } else {
                return "No data for analysis";
            }
        },
        displayLoad: function(cmp) {
            if (this.data[cmp] && this.data[cmp].valid) {
                return this.data[cmp].totalBkd + " / " + this.data[cmp].totalCap + " (" + displayPerc(Math.round(this.getLoad(cmp) * 100), 'load') + ")";
            } else {
                return '-';
            }
        },
        displayRec: function(cmp) {
            if (this.data[cmp] && this.data[cmp].recommendation) {
                switch (this.data[cmp].recType) {
                    case 'good':
                        return '<span class="good">' + this.data[cmp].recommendation + '</span>';
                    case 'bad':
                        return '<span class="bad">' + this.data[cmp].recommendation + '</span>';
                    case 'neutral':
                        return '<span class="warning">' + this.data[cmp].recommendation + '</span>';
                    default:
                        return '<span class="warning">ERROR:2501 Wrong recType set:' + this.data[cmp].recType + '</span>';
                }
            } else {
                return '-'
            }
        },
        displayReferenceRec: function(cmp) {
            const row = this.data[cmp]
            if (!row || !row.referenceRecommendation) return '-'

            let span = $('<span></span>').text(row.referenceRecommendation)
            switch (row.referenceRecType) {
                case 'good': span.addClass('good'); break
                case 'bad': span.addClass('bad'); break
                default: span.addClass('warning')
            }

            if (row.referenceNewPrice) {
                span.append(
                    $('<span></span>').html(' → ' + formatCurrency(row.referenceNewPrice, cmp) + ' AS$ (' + displayPerc(row.referenceNewPricePoint, 'price') + ')')
                )
            }

            return span
        },
        displayPrice: function(cmp, type) {
            const row = this.data[cmp] || {}
            switch (type) {
                case 'current':
                    if (!row.currentPrice) {
                        return '-';
                    }
                    return formatCurrency(row.currentPrice, cmp) + ' AS$ (' + displayPerc(row.currentPricePoint, 'price') + ')';
                case 'new':
                    if (row.newPrice) {
                        return formatCurrency(row.newPrice, cmp) + ' AS$ (' + displayPerc(row.newPricePoint, 'price') + ')';
                    } else {
                        return '-';
                    }
                case 'analysis':
                    if (row.valid && row.analysisPrice) {
                        return formatCurrency(row.analysisPrice, cmp) + ' AS$ (' + displayPerc(row.analysisPricePoint, 'price') + ')';
                    } else {
                        return '-';
                    }
                default:
                    return '<span class="warning">ERROR:2502 Wrong type set:' + type + '</span>';
            }
        },
        displayIndex: function(cmp) {
            if (this.data[cmp] && this.data[cmp].valid) {
                let span = $('<span></span>');
                if (this.data[cmp].index >= 90) {
                    return span.addClass('good').text(this.data[cmp].index);
                }
                if (this.data[cmp].index <= 50) {
                    return span.addClass('bad').text(this.data[cmp].index);
                }
                return span.addClass('warning').text(this.data[cmp].index);

            } else {
                return '-';
            }
        },
        displayTotalLoad: function(type) {
            let cmp = [];
            switch (type) {
                case 'all':
                    cmp = ['Y', 'C', 'F', 'Cargo'];
                    break;
                case 'pax':
                    cmp = ['Y', 'C', 'F'];
                    break;
                default:
                    // code block
            }
            let load, cap, bkd;
            load = cap = bkd = 0;
            for (let i = 0; i < cmp.length; i++) {
                if (this.data[cmp[i]] && this.data[cmp[i]].valid) {
                    cap += this.data[cmp[i]].totalCap;
                    bkd += this.data[cmp[i]].totalBkd;
                }
            }

            if (cap) {
                load = Math.round(bkd / cap * 100);
                return bkd + ' / ' + cap + ' (' + displayPerc(load, 'load') + ')';
            } else {
                return '-';
            }
        },
        displayTotalIndex: function(type) {
            let cmp = [];
            switch (type) {
                case 'all':
                    cmp = ['Y', 'C', 'F', 'Cargo'];
                    break;
                case 'pax':
                    cmp = ['Y', 'C', 'F'];
                    break;
                default:
                    // code block
            }
            let count, totalIndex;
            count = totalIndex = 0;
            for (let i = 0; i < cmp.length; i++) {
                if (this.data[cmp[i]] && this.data[cmp[i]].valid) {
                    count++;
                    totalIndex += this.data[cmp[i]].index;
                }
            }
            if (count) {
                totalIndex = Math.round(totalIndex / count);
                let span = $('<span></span>');
                if (totalIndex >= 90) {
                    return span.addClass('good').text(totalIndex);
                }
                if (totalIndex <= 50) {
                    return span.addClass('bad').text(totalIndex);
                }
                return span.addClass('warning').text(totalIndex);
            } else {
                return '-';
            }
        },
        hasValue: function(value) {
            for (let cmp in this.data) {
                if (this.data[cmp] && this.data[cmp][value]) {
                    return 1;
                }
            }
            return 0;
        }
    };

    const observedFlights = flights.filter(isInventoryDemandFlight)
    const settledFlights = observedFlights.filter(isSettledInventoryFlight)

    //Check historical data
    if (storedData) {
        //Shouldbe function inside storage object
        let dates = []
        for (let date in storedData) {
            if (Number.isInteger(parseInt(date))) {
                dates.push(date)
            }
        }
        dates.reverse();
        mostRecentDate = dates[0]
        mostRecentData = storedData[mostRecentDate]
        analysis.previousData = mostRecentData
    }

    //extract each cmp analysis
    for (let cmp in analysis.data) {
        const priceDetails = prices[cmp] || null
        analysis.data[cmp] = createEmptyClassAnalysis(cmp, priceDetails)
        let price = priceDetails ? priceDetails.currentPrice : 0
        //Only cmp flights
        let cmpFlights = observedFlights.filter(function(flight) {
            return flight.cmp == cmp;
        });
        //if no cmp flights
        if (cmpFlights.length) {
            //Check if current price flights avaialble
            let flightsArray = price
                ? cmpFlights.filter(function(flight) {
                    return (flight.price == price);
                })
                : [];
            if (flightsArray.length && priceDetails) {
                analysis.data[cmp].useCurrentPrice = 1;
                analysis.data[cmp].analysisPrice = price;
                analysis.data[cmp].analysisPricePoint = priceDetails.currentPricePoint;
                analysis.data[cmp].demandSource = "current price rows";
            } else {
                flightsArray = settledFlights.filter(function(flight) {
                    return flight.cmp == cmp;
                });
                if (!flightsArray.length) {
                    flightsArray = cmpFlights
                }
                if (flightsArray.length) {
                    analysis.data[cmp].useCurrentPrice = priceDetails ? 1 : 0;
                    analysis.data[cmp].demandFallback = 1;
                    analysis.data[cmp].demandSource = "observed rows";
                    if (priceDetails) {
                        analysis.data[cmp].analysisPrice = priceDetails.currentPrice;
                        analysis.data[cmp].analysisPricePoint = priceDetails.currentPricePoint;
                    } else {
                        const avgPrice = averageInventoryFlightPrice(flightsArray, cmp)
                        analysis.data[cmp].analysisPrice = avgPrice
                        analysis.data[cmp].analysisPricePoint = avgPrice
                            ? getCurrentPricePoint(avgPrice, analysis.data[cmp].defaultPrice)
                            : 0
                    }
                }
            }
            if (flightsArray.length) {
                addInventoryFlightsToClass(analysis.data[cmp], flightsArray)
            }
        }
    }

    //END extract each cmp analysis
    analysis = generateRecommendation(analysis, prices);
    analysis = generateReferenceRecommendation(analysis, prices);

    //Make route index
    analysis = generateRouteIndex(analysis);
    return analysis;
}

function generateRecommendation(analysis, prices) {
    for (let cmp in analysis.data) {
        analysis.data[cmp].recommendation = 0;
        const priceDetails = prices[cmp] || null
        if (!analysis.data[cmp].valid || !priceDetails || !priceDetails.defaultPrice) {
            continue
        }
        const result = suggestInventoryPriceMove(cmp, analysis.data[cmp], analysis.previousData)
        analysis.data[cmp].confidence = result.confidence
        analysis.data[cmp].breakdown = result.breakdown
        analysis.data[cmp].rationale = result.rationale
        analysis.data[cmp].recType = result.recType
        analysis.data[cmp].recommendation = result.recommendation
        analysis.data[cmp].newPriceChange = result.step

        if (result.step) {
            analysis.data[cmp].newPricePoint = result.newPricePoint
            analysis.data[cmp].newPrice = roundInventoryPrice(cmp, result.newPricePoint / 100 * priceDetails.defaultPrice)
        }
    }
    return analysis;
}

/**
 * Compute a step-table-based "reference" recommendation anchored on the
 * analysis price (not the current price). Useful when the current route
 * price has no finished or inflight results yet — the executable
 * recommendation in generateRecommendation() may be conservative or
 * unavailable, but the simpler step-table read against the analysis price
 * still gives the user a baseline to compare against.
 *
 * Backport of upstream AES v0.7.8 `generateReferenceRecommendation`. Only
 * populates referenceRecommendation/referenceNewPrice when demandFallback
 * is set (i.e., the current price didn't yield enough data for direct
 * grounding); for confidently-grounded compartments the executable
 * recommendation already reflects current-price data, so the reference
 * column is left blank.
 */
function generateReferenceRecommendation(analysis, prices) {
    for (let cmp in analysis.data) {
        const item = analysis.data[cmp]
        if (!item.valid || !item.demandFallback) continue

        const priceDetails = prices[cmp] || null
        if (!priceDetails || !priceDetails.defaultPrice) continue

        const config = getInventoryRecommendationConfig(cmp)
        const load = Math.round(analysis.getLoad(cmp) * 100)
        const step = getInventoryLoadStep(load, config)
        if (!step) {
            item.referenceRecommendation = "No matching step"
            item.referenceRecType = "neutral"
            continue
        }

        const targetPricePoint = Math.min(
            config.maxPrice,
            Math.max(config.minPrice, item.analysisPricePoint + step.step)
        )

        if (step.step < 0) item.referenceRecType = "bad"
        else if (step.step > 0) item.referenceRecType = "good"
        else item.referenceRecType = "neutral"

        if (targetPricePoint === item.analysisPricePoint && step.step !== 0) {
            if (targetPricePoint === config.minPrice) item.referenceRecommendation = "At lowest"
            else if (targetPricePoint === config.maxPrice) item.referenceRecommendation = "At highest"
        }

        if (!item.referenceRecommendation) {
            item.referenceRecommendation = step.name
            item.referenceNewPricePoint = targetPricePoint
            item.referenceNewPrice = roundInventoryPrice(cmp, (targetPricePoint / 100) * priceDetails.defaultPrice)
        }
    }
    return analysis
}

function suggestInventoryPriceMove(cmp, classData, previousData) {
    const profile = getInventoryClassProfile(cmp)
    const config = getInventoryRecommendationConfig(cmp)
    const load = Math.round(classData.totalBkd / classData.totalCap * 100)
    const legacy = getInventoryLoadStep(load, config)
    const pressure = load - profile.targetLoad
    const demandStep = Math.round((pressure / 10) * profile.elasticity)
    const previousClass = previousData && previousData.data ? previousData.data[cmp] : null
    const trend = getInventoryTrendStep(classData, previousClass)
    const magnitude = getInventoryMagnitudeStep(cmp, classData, load)
    const routeIndex = getInventoryRoutePressureIndex(classData, load)
    const routePressure = routeIndex - profile.targetLoad
    const routeStep = getInventoryRoutePressureStep(routePressure)
    let step = Math.round((demandStep * 0.60) + (legacy.step * 0.22)
        + (routeStep * 0.18) + trend + magnitude)

    if (Math.abs(pressure) <= profile.deadband && Math.abs(step) <= 1) {
        step = 0
    }
    if (classData.demandFallback && Math.abs(step) > 1) {
        step += step > 0 ? -1 : 1
    }
    if (classData.currentPricePoint <= profile.floorCaution && step < 0) {
        step += 1
    }
    if (classData.currentPricePoint >= profile.ceilingCaution && step > 0) {
        step -= 1
    }

    step = clampInventoryNumber(step, -profile.maxStep, profile.maxStep)
    let newPricePoint = clampInventoryNumber(
        classData.currentPricePoint + step,
        config.minPrice,
        config.maxPrice
    )
    if (newPricePoint === classData.currentPricePoint) {
        step = 0
    }

    const confidence = getInventoryConfidence(classData, previousClass, profile)
    const recType = step > 0 ? "good" : (step < 0 ? "bad" : "neutral")
    const recommendation = formatInventoryRecommendation(cmp, step, load, profile, newPricePoint, confidence)
    return {
        step: step,
        newPricePoint: newPricePoint,
        recType: recType,
        confidence: confidence,
        recommendation: recommendation,
        rationale: recommendation,
        breakdown: {
            loadPct: load,
            targetLoadPct: profile.targetLoad,
            demandPressurePct: pressure,
            demandStep: demandStep,
            settingsStep: legacy.step,
            routeIndex: routeIndex,
            routePressurePct: routePressure,
            routeStep: routeStep,
            trendStep: trend,
            magnitudeStep: magnitude,
            finalStep: step,
            currentPricePoint: classData.currentPricePoint,
            suggestedPricePoint: newPricePoint,
            source: classData.demandSource || "inventory"
        }
    }
}

function getInventoryRoutePressureIndex(classData, load) {
    const pricePoint = Number(classData && classData.analysisPricePoint)
    const safePricePoint = isFinite(pricePoint) ? pricePoint : 0
    const safeLoad = isFinite(load) ? load : 0
    return Math.round((safePricePoint + (safeLoad * 3)) / 4)
}

function getInventoryRoutePressureStep(routePressure) {
    const gap = Number(routePressure)
    if (!isFinite(gap) || Math.abs(gap) < 10) {
        return 0
    }
    if (gap >= 22) {
        return 2
    }
    if (gap <= -22) {
        return -2
    }
    return gap > 0 ? 1 : -1
}

function getInventoryLoadStep(load, config) {
    const steps = config.steps || INVENTORY_DEFAULT_RECOMMENDATION_STEPS
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        if (load >= step.min && load <= step.max) {
            return step
        }
    }
    return { min: 0, max: 100, name: "Keep", step: 0 }
}

function getInventoryTrendStep(classData, previousClass) {
    if (!previousClass || !previousClass.valid || !previousClass.totalCap) {
        return 0
    }
    const nowLoad = Math.round(classData.totalBkd / classData.totalCap * 100)
    const previousLoad = Math.round(previousClass.totalBkd / previousClass.totalCap * 100)
    const delta = nowLoad - previousLoad
    if (delta >= 8) {
        return 1
    }
    if (delta <= -8) {
        return -1
    }
    return 0
}

function getInventoryMagnitudeStep(cmp, classData, load) {
    if (!classData.flightCount) {
        return 0
    }
    if (cmp === "Cargo") {
        if (load >= 92 && classData.totalBkd >= 0.8 * classData.totalCap) {
            return 1
        }
        if (load <= 38 && classData.totalBkd <= 0.4 * classData.totalCap) {
            return -1
        }
        return 0
    }
    if (load >= 96 && classData.flightCount >= 4) {
        return 1
    }
    if (load <= 35 && classData.flightCount >= 4) {
        return -1
    }
    return 0
}

function getInventoryConfidence(classData, previousClass, profile) {
    const sourceScore = classData.demandFallback ? 0.14 : 0.24
    const flightScore = Math.min(0.30, classData.flightCount * 0.04)
    const capScore = Math.min(0.24, (classData.totalCap / profile.confidenceCap) * 0.24)
    const historyScore = previousClass && previousClass.valid ? 0.10 : 0
    return Math.round(clampInventoryNumber(0.18 + sourceScore + flightScore + capScore + historyScore, 0.20, 0.96) * 100) / 100
}

function formatInventoryRecommendation(cmp, step, load, profile, newPricePoint, confidence) {
    const action = step > 0 ? "Raise" : (step < 0 ? "Drop" : "Hold")
    const move = step ? " " + Math.abs(step) + "pp to " + newPricePoint + "%" : ""
    return action + move + " - " + profile.label + " demand "
        + load + "% vs " + profile.targetLoad + "% target"
        + " (conf " + Math.round(confidence * 100) + "%)"
}

function clampInventoryNumber(value, min, max) {
    return Math.max(min, Math.min(max, value))
}

function generateRouteIndex(analysis) {
    //Each CMP index
    for (let cmp in analysis.data) {
        if (analysis.data[cmp].valid) {
            let index = (analysis.data[cmp].analysisPricePoint + (analysis.getLoad(cmp) * 100 * 3)) / 4;
            analysis.data[cmp].index = Math.round(index);
        }
    }
    return analysis;
}

//Display analysis
function displayAnalysis(analysis, prices) {

    //Build table
    let mainDiv = $(".container-fluid .row .col-md-10 div .as-panel:eq(0)");
    mainDiv.after(
        `
    <h3 id="aes-h3-analysis">Analysis (today's snapshot)</h3>
    <div id="aes-div-analysis" >
      <div class="as-panel">
        <div class="as-table-well">
          <table id="aes-table-analysis" class="table table-bordered table-striped table-hover">
          </table>
        </div>
      </div>
    </div>
    `
    );

    const showReference = !!(settings && settings.invPricing && settings.invPricing.showReferenceRecommendation)

    //Table head
    let th = [];
    th.push('<th>SC</th>');
    th.push('<th>Note</th>');
    th.push('<th class="aes-text-right">Analysis Price</th>');
    th.push('<th>Load</th>');
    th.push('<th class="aes-text-right">Index</th>');
    th.push('<th class="aes-text-right">Current Price</th>');
    th.push('<th>Recommendation</th>');
    th.push('<th class="aes-text-right">New Price</th>');
    if (showReference) {
        th.push('<th>Reference</th>');
    }
    let headRow = $('<tr></tr>').append(th);
    let thead = $('<thead></thead>').append(headRow);

    //Table body
    let tbody = $('<tbody></tbody>');
    for (let cmp in analysis.data) {
        let td = [];
        td.push('<td>' + cmp + '</td>');
        td.push('<td>' + analysis.note(cmp) + '</td>');
        td.push('<td class="aes-text-right">' + analysis.displayPrice(cmp, 'analysis') + '</td>');
        td.push('<td>' + analysis.displayLoad(cmp) + '</td>');
        td.push($('<td class="aes-text-right"></td>').html(analysis.displayIndex(cmp)));
        td.push('<td class="aes-text-right">' + analysis.displayPrice(cmp, 'current') + '</td>');
        td.push('<td>' + analysis.displayRec(cmp) + '</td>');
        td.push('<td class="aes-text-right">' + analysis.displayPrice(cmp, 'new') + '</td>');
        if (showReference) {
            td.push($('<td></td>').append(analysis.displayReferenceRec(cmp)));
        }
        let row = $('<tr></tr>').append(td);
        tbody.append(row);
    }

    //Table footer
    const totalCols = showReference ? 9 : 8;
    const trailingCols = showReference ? 4 : 3;
    let footRow = []
    footRow.push('<tr><td colspan="' + totalCols + '"></td></tr>');
    //Total PAX
    let tf = [];
    tf.push('<th>Total PAX</th>');
    tf.push('<td colspan="2"></td>');
    tf.push($('<td></td>').html(analysis.displayTotalLoad('pax')));
    tf.push($('<td class="aes-text-right"></td>').html(analysis.displayTotalIndex('pax')));
    tf.push('<td colspan="' + trailingCols + '"></td>');
    footRow.push($('<tr></tr>').append(tf));
    //Total
    tf = [];
    tf.push('<th>Total PAX+Cargo</th>');
    tf.push('<td colspan="2"></td>');
    tf.push($('<td></td>').html(analysis.displayTotalLoad('all')));
    tf.push($('<td class="aes-text-right"></td>').html(analysis.displayTotalIndex('all')));
    tf.push('<td colspan="' + trailingCols + '"></td>');
    footRow.push($('<tr></tr>').append(tf));
    let tfoot = $('<tfoot></tfoot>').append(footRow);

    $("#aes-table-analysis").append(thead, tbody, tfoot);

    //Display pricing and data save buttons
    if (analysis.hasValue('valid')) {
        let invPricingAnalysisBar = $('<ul class="as-action-bar as-panel"></ul>');
        let invPricingAnalysisBarSpan = $('<span class="warning"></span>');
        invPricingAnalysisBar.append($('<li></li>').html(invPricingAnalysisBarSpan));
        $("#aes-div-analysis").prepend(invPricingAnalysisBar);
        //create buttons
        //Save Data
        let saveInvPricingBtn = $('<button type="button" class="btn btn-default" id="aes-btn-invPricing-save-snapshot"></button>');
        $(saveInvPricingBtn).click(async function(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            $(this).closest("li").remove();
            invPricingAnalysisBarSpan.text('Saving analysis data...');
            try {
                //Get updated time
                let updateTime = AES.getServerDate().time;
                pricingData.date[todayDate] = analysis;
                pricingData.date[todayDate].updateTime = updateTime;
                pricingData.date[todayDate].date = todayDate;
                pricingData.date[todayDate].pricingUpdated = 0;
                await setInventoryStorage({[pricingData.key]: pricingData});
                invPricingAnalysisBarSpan.removeClass().addClass("good").text("Data Saved!");
                //Automation
                if (settings.invPricing.autoClose) {
                    close();
                }
            } catch (error) {
                invPricingAnalysisBarSpan.removeClass().addClass("bad").text("Save failed: " + inventoryStorageErrorMessage(error));
            }
        });

        //Update prices
        let applyNewPriceInvPricingBtn = $('<button type="button" class="btn btn-default" id="aes-btn-invPricing-apply-new-prices">apply new prices (and save data)</button>');
        $(applyNewPriceInvPricingBtn).click(async function(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            $(this).closest("ul").find("li button").closest("li").remove();
            invPricingAnalysisBarSpan.text('Updating prices...');
            //Get updated time
            let updateTime = AES.getServerDate().time;
            try {
                if (!window.CentralInventoryQuickPriceApplier) {
                    throw new Error("verified inventory price applier is unavailable");
                }
                const storageKey = getPricingInventoryKey();
                const entries = [];
                for (let cmp in analysis.data) {
                    if (analysis.data[cmp].newPrice) {
                        entries.push({
                            hub: storageKey.origin,
                            dest: storageKey.destination,
                            classKey: cmp,
                            newPrice: analysis.data[cmp].newPrice,
                            server: storageKey.server
                        });
                    }
                }
                if (!entries.length) {
                    throw new Error("no new prices to apply");
                }
                const gate = await getInventoryQuickPriceGate("manual");
                const applier = new window.CentralInventoryQuickPriceApplier({
                    applyEnabled: gate.applyEnabled,
                    dryRunOnly: gate.dryRunOnly
                });
                const batch = await applier.applyBatch(entries, {interMs: 350, stopOnError: true});
                const failed = batch.results.filter(function(result) {
                    return !result
                        || (result.status !== "verified"
                            && result.status !== "posted");
                });
                if (failed.length) {
                    const first = failed[0];
                    const message = first && first.error && first.error.message
                        ? first.error.message
                        : (first && first.status ? first.status : "unknown failure");
                    invPricingAnalysisBarSpan.removeClass().addClass("bad").text("Price update failed: " + message);
                    return;
                }
                pricingData.date[todayDate] = analysis;
                pricingData.date[todayDate].updateTime = updateTime;
                pricingData.date[todayDate].date = todayDate;
                pricingData.date[todayDate].pricingUpdated = 1;
                await setInventoryStorage({[pricingData.key]: pricingData});
                invPricingAnalysisBarSpan.removeClass().addClass("good").text("Prices updated and verified at: " + updateTime);
                if (settings.invPricing.autoClose) {
                    close();
                } else {
                    window.location.reload();
                }
            } catch (error) {
                invPricingAnalysisBarSpan.removeClass().addClass("bad").text("Price update failed: " + (error && error.message || String(error)));
            }
        });
        //Update new pricing input
        if (analysis.hasValue('newPrice')) {
            //Modify new price input
            for (let cmp in analysis.data) {
                if (analysis.data[cmp].newPrice && prices[cmp] && prices[cmp].newPriceInput) {
                    prices[cmp].newPriceInput.value = analysis.data[cmp].newPrice;
                }
            }
        }
        //For snapshot button
        if (pricingData.date[todayDate]) {
            //Today data does exist
            if (pricingData.date[todayDate].pricingUpdated) {
                //Today pricing updated
                invPricingAnalysisBarSpan.text("Today prices have been updated at: " + pricingData.date[todayDate].updateTime);

                //Automation
                if (settings.invPricing.autoClose) {
                    close();
                }
            } else {
                //Today pricing not updated
                invPricingAnalysisBarSpan.text("Today's snapshot data saved at: " + pricingData.date[todayDate].updateTime);
                $(invPricingAnalysisBar).append($('<li></li>').html(saveInvPricingBtn.text("save snapshot data again")));
                if (analysis.hasValue('newPrice')) {
                    $(invPricingAnalysisBar).append($('<li></li>').html(applyNewPriceInvPricingBtn));
                }
            }
        } else {
            //Today data does not exist
            $(invPricingAnalysisBar).append($('<li></li>').html(saveInvPricingBtn.text("save snapshot data")));
            if (analysis.hasValue('newPrice')) {
                $(invPricingAnalysisBar).append($('<li></li>').html(applyNewPriceInvPricingBtn));
            }
        }
    }
}

//Display History
function displayHistory(analysis) {
    //Prepare data
    let dates = [];
    //Get valid dates can add function here
    for (let date in pricingData.date) {
        if (Number.isInteger(parseInt(date))) {
            dates.push(date)
        }
    }
    dates.sort();
    //If historical data exist then build
    if (dates.length) {
        //Build Div
        let mainDiv = $("#aes-div-analysis");
        mainDiv.after('<h3 id="aes-h3-history">Historical Data</h3><div id="aes-div-invPricing-historicalData" class="as-panel"></div>');

        //History Options
        let fieldset = $('<fieldset></fieldset>').html('<legend>History Options</legend>');
        //Hide Now
        let option1 = $('<div class="checkbox"></div>').html('<label><input id="aes-check-inventory-history-showNow" type="checkbox"> Show "Now" column</label>');
        //Show only Priced
        let option2 = $('<div class="checkbox"></div>').html('<label><input id="aes-check-inventory-history-showOnlyPricing" type="checkbox"> Show only dates when pricing changed</label>');

        //Number of records
        let option3 = $('<select id="aes-select-inventory-history-numberPastDates" class="form-control input-sm"></select>').html('<option value="5">5 past dates</option><option value="10">10 past dates</option><option value="all">All past dates</option>')
        let wrapper = $('<div class="form-group"></div>').append('<label class="control-label"><span>Number of past dates</span></label>', option3);

        fieldset.append(option1, option2, wrapper);
        $("#aes-div-invPricing-historicalData").append(fieldset);
        //Default values
        if (settings.invPricing.historyTable.showNow) {
            $("#aes-check-inventory-history-showNow").prop("checked", true);
        }
        if (settings.invPricing.historyTable.showOnlyPricing) {
            $("#aes-check-inventory-history-showOnlyPricing").prop("checked", true);
        }
        $("#aes-select-inventory-history-numberPastDates").val(settings.invPricing.historyTable.numberOfDates);

        //Change events
        $("#aes-check-inventory-history-showNow").change(function() {
            const value = this.checked ? 1 : 0;
            settings.invPricing.historyTable.showNow = value;
            window.AesSettings.mutateArea("invPricing", function(block) {
                if (!block.historyTable) block.historyTable = {};
                block.historyTable.showNow = value;
            });
            buildHistoryTable();
        });
        $("#aes-check-inventory-history-showOnlyPricing").change(function() {
            buildHistoryTable();
            const value = this.checked ? 1 : 0;
            settings.invPricing.historyTable.showOnlyPricing = value;
            window.AesSettings.mutateArea("invPricing", function(block) {
                if (!block.historyTable) block.historyTable = {};
                block.historyTable.showOnlyPricing = value;
            });
        });
        $("#aes-select-inventory-history-numberPastDates").change(function() {
            const value = $('#aes-select-inventory-history-numberPastDates').val();
            settings.invPricing.historyTable.numberOfDates = value;
            window.AesSettings.mutateArea("invPricing", function(block) {
                if (!block.historyTable) block.historyTable = {};
                block.historyTable.numberOfDates = value;
            });
            buildHistoryTable();
        });

        buildHistoryTable();
    }
}

function buildHistoryTable() {
    //Clean previous table
    $('#aes-table-inventory-history').remove();

    let showNow = 0;
    let showOnlyPricing = 0;
    if ($('#aes-check-inventory-history-showNow:checked').length > 0) {
        showNow = 1;
    }
    if ($('#aes-check-inventory-history-showOnlyPricing:checked').length > 0) {
        showOnlyPricing = 1;
    }

    let numberOfDates = $('#aes-select-inventory-history-numberPastDates').val();
    switch (numberOfDates) {
        case '5':
            numberOfDates = 5;
            break;
        case '10':
            numberOfDates = 10;
            break;
        case 'all':
            numberOfDates = 0;
            break;
        default:
            numberOfDates = 10;
    }

    let dates = [];
    //Get valid dates can add function here
    for (let date in pricingData.date) {
        if (showOnlyPricing) {
            if (pricingData.date[date].pricingUpdated) {
                if (Number.isInteger(parseInt(date))) {
                    dates.push(date)
                }
            }
        } else {
            if (Number.isInteger(parseInt(date))) {
                dates.push(date)
            }
        }
    }
    dates.sort();
    dates.reverse();
    if (numberOfDates) {
        dates = dates.slice(0, numberOfDates);
    }
    if (dates.length) {

        //Headrows
        let th = ['<th></th>'];
        let th1 = ['<th>SC</th>'];
        if (showNow) {
            //Now
            th.push($('<th colspan="4"></th>').text('Now'));
            th1.push('<th class="text-nowrap aes-text-right">Price</th>');
            th1.push('<th class="text-nowrap">&Delta; %</th>');
            th1.push('<th class="text-nowrap">Load</th>');
            th1.push('<th class="text-nowrap">&Delta; %</th>');
            //index
            th1.push('<th class="text-nowrap aes-text-right">Index</th>');
        }
        for (let i = 0; i < dates.length; i++) {
            let date = dates[i];
            if (i) {
                th.push($('<th colspan="5"></th>').text(AES.formatDateString(date)));
                th1.push('<th class="text-nowrap aes-text-right">Price</th>');
                th1.push('<th class="text-nowrap text-right">&Delta; %</th>');
                th1.push('<th class="text-nowrap text-right">Load</th>');
                th1.push('<th class="text-nowrap text-right">&Delta; %</th>');
                //Index
                th1.push('<th class="text-nowrap text-right">Index</th>');
            } else {
                th.push($('<th colspan="3"></th>').text(AES.formatDateString(date)));
                th1.push('<th class="text-nowrap text-right">Price</th>');
                th1.push('<th class="text-nowrap text-right">Load</th>');
                //Index
                th1.push('<th class="text-nowrap text-right">Index</th>');
            }
        }

        let headRow = $('<tr></tr>').append(th);
        let headRow2 = $('<tr></tr>').append(th1);
        let thead = $('<thead></thead>').append(headRow, headRow2);

        //Build table
        let compartments = ['Y', 'C', 'F', 'Cargo'];

        //Tbody rows
        let tbody = $('<tbody></tbody>');
        compartments.forEach(function(cmp) {
            let td = [];
            td.push($('<td></td>').text(cmp));
            if (showNow) {
                //Now TDs
                let data = inventoryHistoryClassData(analysis, cmp);
                let prevData = inventoryHistoryClassData(pricingData.date[dates[dates.length - 1]], cmp);
                td.push($('<td class="text-nowrap text-right"></td>').html(displayHistoryPrice(data)));
                td.push($('<td class="text-nowrap text-right"></td>').html(displayDifference(data, prevData).price));
                td.push($('<td class="text-nowrap text-right"></td>').html(displayHistoryLoad(data)));
                td.push($('<td class="text-nowrap text-right"></td>').html(displayDifference(data, prevData).load));
                //Index
                td.push($('<td class="text-nowrap text-right"></td>').html(historyDisplayIndex(data, 0)));
            }
            //Historical tds
            for (let i = 0; i < dates.length; i++) {
                let date = dates[i];
                let data = inventoryHistoryClassData(pricingData.date[date], cmp);
                if (i) {
                    let prevData = inventoryHistoryClassData(pricingData.date[dates[i - 1]], cmp);
                    //Not first data point
                    td.push($('<td class="text-nowrap text-right"></td>').html(displayHistoryPrice(data)));
                    td.push($('<td class="text-nowrap text-right"></td>').html(displayDifference(data, prevData).price));
                    td.push($('<td class="text-nowrap text-right"></td>').html(displayHistoryLoad(data)));
                    td.push($('<td class="text-nowrap text-right"></td>').html(displayDifference(data, prevData).load));
                    //index
                    td.push($('<td class="text-nowrap text-right"></td>').html(historyDisplayIndex(data, 0)));
                } else {
                    //First data point
                    td.push($('<td class="text-nowrap text-right"></td>').html(displayHistoryPrice(data)));
                    td.push($('<td class="text-nowrap text-right"></td>').html(displayHistoryLoad(data)));
                    //index
                    td.push($('<td class="text-nowrap text-right"></td>').html(historyDisplayIndex(data, 0)));
                }
            }

            //Finish row
            let row = $('<tr></tr>').append(td);
            tbody.append(row);
        });

        //Table footer Total Rows
        let totalCollumns = th1.length;
        let footRow = [];
        let footerRows = ['pax', 'all']
        footRow.push('<tr><td colspan="' + totalCollumns + '"></td></tr>');
        //Total PAX
        footerRows.forEach(function(type) {
            let tf = [];
            tf.push($('<th></th>').text(historyDisplayTotalText(type)));
            if (showNow) {
                //Now
                let data = analysis.data;
                tf.push('<td colspan="2"></td>');
                tf.push($('<td></td>').html(historyDisplayTotal(data, type)));
                tf.push('<td></td>');
                //index
                tf.push($('<td class="aes-text-right"></td>').html(historyDisplayIndex(data, type)));
            }
            for (let i = 0; i < dates.length; i++) {
                let date = dates[i];
                let data = (pricingData.date[date] && pricingData.date[date].data) || {};
                if (i) {
                    tf.push('<td colspan="2"></td>');
                    tf.push($('<td></td>').html(historyDisplayTotal(data, type)));
                    tf.push('<td></td>');
                    //index
                    tf.push($('<td class="aes-text-right"></td>').html(historyDisplayIndex(data, type)));
                } else {
                    tf.push('<td></td>');
                    tf.push($('<td></td>').html(historyDisplayTotal(data, type)));
                    //index
                    tf.push($('<td class="aes-text-right"></td>').html(historyDisplayIndex(data, type)));
                }
            }

            footRow.push($('<tr></tr>').append(tf));
        });

        let tfoot = $('<tfoot></tfoot>').append(footRow);
        let table = $('<table class="table table-bordered table-striped table-hover"></table>').append(thead, tbody, tfoot);
        let tableDiv = $('<div style="overflow-x:auto;" id="aes-table-inventory-history" class="as-table-well"></div>').append(table);

        $("#aes-div-invPricing-historicalData").append(tableDiv);
    }
}

function displayValidationError() {
    let p = [];
    p.push($('<p></p>').text('AES Inventory Pricing Module could not be loaded because of errors:'));
    aesmodule.errors.forEach(function(error) {
        p.push($('<p class="bad"></p>').html('<b>' + error + '</b>'));
    });
    p.push($('<p class="warning"></p>').html('Refresh the page after making adjustments.'));
    let panel = $('<div id="aes-panel-validation" class="as-panel"></div>').append(p);
    let h3 = $('<h3 id="aes-h3-validation"></h3>').text('AES Inventory Pricing Module');
    $('h1:eq(0)').after(h3, panel)
}

//History Table functions
function historyDisplayIndex(data, type) {
    data = data || {}
    let cmp = [];
    let index = 0;
    switch (type) {
        case 'all':
            cmp = ['Y', 'C', 'F', 'Cargo'];
            break;
        case 'pax':
            cmp = ['Y', 'C', 'F'];
            break;
        case 0:
            cmp = 0;
            break;
    }
    if (cmp) {
        //Multi index
        let count = 0;
        cmp.forEach(function(comp) {
            if (data[comp] && data[comp].valid) {
                index += data[comp].index;
                count++;
            }
        });
        index = count ? Math.round(index / count) : 0;
    } else {
        //one cmp index
        if (data && data.valid) {
            index = data.index;
        }
    }
    if (index) {
        let span = $('<span></span>');
        if (index >= 90) {
            return span.addClass('good').text(index);
        }
        if (index <= 50) {
            return span.addClass('bad').text(index);
        }
        return span.addClass('warning').text(index);
    } else {
        return '-';
    }
}

function historyDisplayTotalText(type) {
    switch (type) {
        case 'all':
            return "Total PAX+Cargo";
        case 'pax':
            return "Total PAX";
    }
}

function historyDisplayTotal(data, type) {
    data = data || {}
    let cmp = [];
    switch (type) {
        case 'all':
            cmp = ['Y', 'C', 'F', 'Cargo'];
            break;
        case 'pax':
            cmp = ['Y', 'C', 'F'];
            break;
        default:
            // code block
    }
    let load, cap, bkd;
    load = cap = bkd = 0;
    cmp.forEach(function(comp) {
        if (data[comp] && data[comp].valid) {
            cap += data[comp].totalCap;
            bkd += data[comp].totalBkd;
        }
    });
    if (cap) {
        load = Math.round(bkd / cap * 100);
        return bkd + ' / ' + cap + ' (' + displayPerc(load, 'load') + ')';
    } else {
        return '-';
    }
}

function displayHistoryLoad(data) {
    data = data || {}
    if (data.valid) {
        let booked = data.totalBkd;
        let capacity = data.totalCap;
        let load = Math.round(booked / capacity * 100);
        return booked + ' / ' + capacity + ' (' + displayPerc(load, 'load') + ')';
    } else {
        return '-';
    }
}

function displayHistoryPrice(data) {
    data = data || {}
    if (data.valid) {
        let price = data.analysisPrice;
        let pricePoint = data.analysisPricePoint;
        return formatCurrency(price, data.classKey) + ' AS$ (' + displayPerc(pricePoint, 'price') + ')';
    } else {
        return '-';
    }
}

function displayDifference(current, old) {
    current = current || {}
    old = old || {}
    if (current.valid && old.valid) {
        let currentLoad = Math.round(current.totalBkd / current.totalCap * 100);
        let oldLoad = Math.round(old.totalBkd / old.totalCap * 100);
        let load = currentLoad - oldLoad;
        let price = current.analysisPricePoint - old.analysisPricePoint;
        return { load: load, price: price };
    } else {
        return { load: '-', price: '-' };
    }
}

function displayPerc(perc, type) {
    let span = $('<span></span>');
    switch (type) {
        case 'price':
            if (perc >= 100) {
                span.addClass('good').text(perc + "%");
                return span.prop('outerHTML');
            }
            if (perc < 75) {
                span.addClass('bad').text(perc + "%");
                return span.prop('outerHTML');
            }
            span.addClass('warning').text(perc + "%");
            return span.prop('outerHTML');
        case 'load':
            if (perc >= 70) {
                span.addClass('good').text(perc + "%");
                return span.prop('outerHTML');
            }
            if (perc < 40) {
                span.addClass('bad').text(perc + "%");
                return span.prop('outerHTML');
            }
            span.addClass('warning').text(perc + "%");
            return span.prop('outerHTML');
        default:
            return '<span class="warning">ERROR:2502 Wrong type set:' + type + '</span>';
    }
}
//Helper functions
function formatCurrency(value, cmp) {
    const n = Number(value)
    if (!isFinite(n)) return "-"
    if (cmp === "Cargo" && Math.abs(n) < 10) {
        return n.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })
    }
    return Intl.NumberFormat().format(n)
}

function getPricingInventoryKey() {
    //Get Origin and Destination
    let x = $("h2:first a");
    let org = $(x[0]).text();
    let dest = $(x[1]).text();
    //get server
    let server = AES.getServerName();
    //get airline code
    let airline = getAirlineCode();
    //create key
    let key = server + airline + org + dest + 'routeAnalysis';
    return { key: key, server: server, airline: airline, type: "routeAnalysis", origin: org, destination: dest }
}

function getAirlineCode() {
    let airline = $("#inventory-grouped-table tbody a:first").text().split(" ");
    if (!airline[0]) {
        airline = $("#inventory-table tbody a:first").text().split(" ");
    }
    return airline[0];
}
