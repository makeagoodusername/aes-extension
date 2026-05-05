"use strict"

// Global variables
let aircraftFlightData,
    aircraftFlightInfoData,
    aircraftFlightsTab,
    statisticsPanel,
    infoPanel
let aircraftFlightsInitStarted = false

// F-9228-801: gate on document.readyState so that an extension reload
// mid-session (which re-injects the content script after `load` has already
// fired) still bootstraps the page. Plain window.addEventListener("load")
// silently no-ops in that case and the table stays un-augmented.
async function init() {
    if (aircraftFlightsInitStarted) return
    aircraftFlightsInitStarted = true
    try {
        await waitForBootstrapReady()
        aircraftFlightsTab = new AircraftFlightsTab()
        buildUI()
        await getData()
        processData()
        displayData()
    } catch (e) {
        aircraftFlightsInitStarted = false
        console.warn("[AES /1 aircraft-flights] bootstrap failed", e)
    }
}
function scheduleInit() {
    // The manifest loads this file before aircraft-data.js, info-panel.js,
    // and the FlightData model. If the content script is injected after the
    // page load event, calling init synchronously would run before those
    // subsequent files execute. Defer one task and poll for dependencies.
    setTimeout(() => { init() }, 0)
}
if (document.readyState === "complete") scheduleInit()
else window.addEventListener("load", scheduleInit, {once: true})

function waitForBootstrapReady(timeoutMs = 6000) {
    const started = Date.now()
    return new Promise((resolve, reject) => {
        const tick = () => {
            const depsReady = typeof Aircraft !== "undefined"
                && typeof FlightData !== "undefined"
                && typeof InfoPanel !== "undefined"
                && typeof AircraftStatisticsPanel !== "undefined"
                && typeof AES !== "undefined"
            const tableReady = !!document.querySelector("#aircraft-flight-instances-table tbody")
            const headingReady = document.querySelectorAll(".as-page-aircraft h1 span").length >= 2
            const clockReady = !!document.querySelector(".as-navbar-bottom span:has(.fa-clock-o)")
            if (depsReady && tableReady && headingReady && clockReady) {
                resolve()
                return
            }
            if (Date.now() - started >= timeoutMs) {
                reject(new Error("timed out waiting for /1 dependencies and AS DOM"))
                return
            }
            setTimeout(tick, 100)
        }
        tick()
    })
}

function buildUI() {
    infoPanel = new InfoPanel()
    statisticsPanel = new AircraftStatisticsPanel()
    updateTable()
    // addButtons()
}

async function getData() {
    aircraftFlightData = getAircraftData()
    aircraftFlightInfoData = await getAircraftFlightInfoData()
}

function processData() {
    addFlightInfoToAircarftData()
    getTotalProfit()
    saveData()
}

function displayData() {
    updateAircraftInfoPanel()
    updateStatisticsPanel()
    display()
}

function updateTable() {
    const table = document.querySelector("#aircraft-flight-instances-table")
    if (!table) return
    // F-9228-805: idempotent mount. With F-9228-801's readyState re-entry,
    // updateTable() can be invoked against an already-augmented table on
    // extension reload; without this guard the headers and per-row cells
    // would duplicate.
    if (table.dataset.aesFlightsAugmented === "1") return

    const thead = table.querySelector("thead")
    const tbody = table.querySelector("tbody")
    const headers = thead ? thead.querySelectorAll("th") : []
    const headerAnchor = headers[9]
    if (!headerAnchor || !tbody) return
    table.dataset.aesFlightsAugmented = "1"

    const profitHeader = document.createElement("th")
    profitHeader.innerText = "Profit/Loss"
    profitHeader.dataset.aesFlightsHeader = "profit"
    const extractedHeader = document.createElement("th")
    extractedHeader.innerText = "Extracted"
    extractedHeader.dataset.aesFlightsHeader = "extracted"
    headerAnchor.after(profitHeader, extractedHeader)

    const rows = tbody.querySelectorAll("tr")
    for (const row of rows) {
        const target = row.querySelector("td:nth-child(12)")
        // AS renders a single-cell "No flights scheduled" placeholder row when
        // the aircraft has no flights yet. Skip it; otherwise target.after()
        // throws and aborts the entire init() chain (info/stats panels blank).
        if (!target) continue
        const profitCell = document.createElement("td")
        profitCell.innerText = "--"
        profitCell.className = "text-center text-nowrap"
        profitCell.dataset.aesFlightsCell = "profit"
        const extractedCell = document.createElement("td")
        extractedCell.innerText = "--"
        extractedCell.className = "text-center text-nowrap"
        extractedCell.dataset.aesFlightsCell = "extracted"
        target.after(profitCell, extractedCell)
    }

    const tfootCell = table.querySelector("tfoot td")
    if (tfootCell) tfootCell.setAttribute("colspan", "15")
}


function updateAircraftInfoPanel() {
    infoPanel.aircraftId = aircraftFlightData.aircraftId
    infoPanel.registration = aircraftFlightData.registration
}

function updateStatisticsPanel() {
    // statisticsPanel.profit =
    statisticsPanel.finishedFlights = aircraftFlightData.finishedFlights
    statisticsPanel.totalFlights = aircraftFlightData.totalFlights
    const savedDaysAgo = AES.getDateDiff(aircraftFlightData.date)
    statisticsPanel.savedDaysAgo = savedDaysAgo
}

function createButtons() {
    const buttons = [
        new ExtractionButton("Extract finished flight profit", () => extractAllFlightProfit("finished")),
        new ExtractionButton("Extract all flight profit", () => extractAllFlightProfit("all"))
    ]

    return buttons
}

function addButtons() {
    const buttons = createButtons()
    const listItem = document.createElement("li")
    listItem.className = "btn-group"
    for (const button of buttons) {
        listItem.append(button.element)
    }
    const target = document.querySelector(".as-page-aircraft .as-action-bar li:first-child")
    target.after(listItem)
}

function getAircraftData() {
    const aircraftInfo = aircraftFlightsTab.getAircraftInfo()
    const flights = aircraftFlightsTab.getFlights()
    const flightsStats = aircraftFlightsTab.data.currentSchedule
    const serverDate = AES.getServerDate()

    const aircraftData = {
        date: serverDate.date,
        time: serverDate.time,
        server: AES.getServerName(),
        // F-9228-807: airline name is part of the storage-key namespace so
        // two airlines on the same server can't clobber each other's
        // aircraft-flights records when they share an aircraftId.
        airline: AES.getAirlineIdentity ? (AES.getAirlineIdentity() || "") : "",
        aircraftId: aircraftInfo.id,
        registration: aircraftInfo.registration,
        equipment: aircraftInfo.equipment,
        type: 'aircraftFlights',
        flights: flights,
        finishedFlights: flightsStats.finishedFlights,
        totalFlights: flightsStats.totalFlights
    }

    return aircraftData
}

async function getAircraftFlightInfoData() {
    const keys = getKeys()
    const data = await chrome.storage.local.get(keys)

    return data
}

function addFlightInfoToAircarftData() {
    const storedFlights = aircraftFlightInfoData
    for (const flightKey in storedFlights) {
        const storedFlight = storedFlights[flightKey]
        for (const flight of aircraftFlightData.flights) {
            if (flight.id === storedFlight.flightId) {
                flight.data = storedFlight
            }
        }
    }
}

function getKeys() {
    // F-9228-807: read both the airline-scoped key (preferred — written
    // by the post-fix content_flightInfo.js) and the legacy un-scoped key
    // (still on disk for tails the user extracted before the fix landed).
    // chrome.storage.local.get(keys) ignores absent keys, so requesting
    // both is safe and addFlightInfoToAircarftData merges by storedFlight.flightId.
    const keys = []
    const server = aircraftFlightData.server
    const airline = aircraftFlightData.airline || ""
    for (const flight of aircraftFlightData.flights) {
        const id = flight.id
        if (airline) keys.push(`${server}${airline}flightInfo${id}`)
        keys.push(`${server}flightInfo${id}`)
    }

    return keys
}

function getTotalProfit() {
    let profit = 0
    let profitFlights = 0

//     let profit2 = 0
//     let profitFlights2 = 0
//
//     for (const flight of aircraftFlightsTab.data.flights) {
//         if (!flight.isCancellable && flight.data) {
//             profit2 += flight.data.money.CM5.Total
//             profitFlights2++
//         }
//     }

    // console.log({profit2, profitFlights2})

    aircraftFlightData.flights.forEach(function(value) {
        if (value.status == 'finished' || value.status == 'inflight') {
            // F-9228-809: harden the chain. Older flightInfo blobs and
            // partial schemas may be missing `money` or `money.CM5`,
            // which used to throw mid-loop and abort processData().
            const total = value.data && value.data.money
                && value.data.money.CM5 && value.data.money.CM5.Total
            if (typeof total === "number") {
                profit += total;
                profitFlights++;
            }
        }
    });
    aircraftFlightData.profit = profit;
    aircraftFlightData.profitFlights = profitFlights;

    statisticsPanel.profit = AES.formatCurrency(profit)
    if (!profitFlights) {
        return
    }
    statisticsPanel.allExtracted = Boolean(aircraftFlightData.finishedFlights === aircraftFlightData.profitFlights)
}

function saveData() {
    // F-9228-807: airline-scoped key. Without the airline component the
    // same aircraftId on the same server (rare but possible after fleet
    // transfers / shared-fleet sims) collided across airlines, silently
    // overwriting the prior airline's persisted data.
    const airline = aircraftFlightData.airline || ""
    let key = aircraftFlightData.server + airline + aircraftFlightData.type + aircraftFlightData.aircraftId;
    let saveData = {
        aircraftId: aircraftFlightData.aircraftId,
        // F-9228-807: include airline in the saved blob (in addition to the
        // scoping in the storage key) so cross-account aggregators can join
        // records by airline without re-parsing the key shape.
        airline: airline,
        date: aircraftFlightData.date,
        equipment: aircraftFlightData.equipment,
        finishedFlights: aircraftFlightData.finishedFlights,
        profit: aircraftFlightData.profit,
        profitFlights: aircraftFlightData.profitFlights,
        registration: aircraftFlightData.registration,
        server: aircraftFlightData.server,
        time: aircraftFlightData.time,
        totalFlights: aircraftFlightData.totalFlights,
        type: aircraftFlightData.type,
        // Per-FN linkage envelope (G slice 4). Strips the live DOM `row` and
        // the merged `data` (which lives independently in <server>flightInfo<id>),
        // keeps just the fields yield-snapshot will need to attribute profit
        // by FN/route. ~50-100 entries × ~7 fields = single-digit KB per tail.
        flights: (aircraftFlightData.flights || []).map(f => ({
            flightId:        f.id,
            flightNumber:    f.flightNumber       || null,
            flightNumberId:  typeof f.flightNumberId === "number" ? f.flightNumberId : null,
            status:          f.status             || null,
            originIata:      f.originIata         || null,
            destinationIata: f.destinationIata    || null,
            depUtc:          f.depUtc             || null
        }))
    }

    chrome.storage.local.set({
        [key]: saveData }, function() {
        // F-9228-806: surface quota / serialization failures instead of
        // silently dropping the write. The panel would otherwise show
        // stale data on the next visit with no indication the save failed.
        const err = chrome.runtime && chrome.runtime.lastError
        if (err) console.warn("[AES /1 aircraft-flights] saveData failed", err.message || err)
    });
}

function display() {
    displayFlightProfit()
    displayRoutePricingContext().catch(e => console.warn("[AES /1 aircraft-flights] price context failed", e))
    createButtonOld()
}

function formatAesPrice(value, cls) {
    const n = Number(value)
    if (!isFinite(n)) return null
    if (cls === "Cargo") {
        const rounded = Math.round(n * 100) / 100
        return n < 10 ? rounded.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(rounded))
    }
    return String(Math.round(n))
}

function formatPriceMap(map) {
    if (!map) return "--"
    const parts = []
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        const v = formatAesPrice(map[cls], cls)
        if (v != null) parts.push(cls + " " + v)
    }
    return parts.length ? parts.join(" · ") : "--"
}

function flightRouteKey(flight) {
    const origin = flight && flight.originIata
    const dest = flight && flight.destinationIata
    if (!origin || !dest) return null
    return origin + "-" + dest
}

function compactRouteContextCell(ctx, kind) {
    if (!ctx) return "--"
    if (kind === "competition") {
        return formatPriceMap(ctx.competitors && ctx.competitors.medians)
    }
    if (kind === "history") {
        if (ctx.yieldHistory && ctx.yieldHistory.latestProfitPerFlight != null) {
            return "AS$ " + ctx.yieldHistory.latestProfitPerFlight + "/flt"
        }
        const y = ctx.historyByClass && ctx.historyByClass.Y
        return y && y.avgPrice != null ? "Y hist " + y.avgPrice : "--"
    }
    if (kind === "ors") {
        return ctx.ors && ctx.ors.rankAny != null ? "#" + ctx.ors.rankAny : "--"
    }
    if (kind === "schedule") {
        return ctx.schedule && ctx.schedule.weeklyFlights != null
            ? ctx.schedule.weeklyFlights + "/wk"
            : "--"
    }
    return "--"
}

async function displayRoutePricingContext() {
    if (!aircraftFlightData || !Array.isArray(aircraftFlightData.flights)) return
    if (!window.AesPriceDiagnostics || typeof window.AesPriceDiagnostics.buildRouteContext !== "function") return
    const table = document.querySelector("#aircraft-flight-instances-table")
    if (!table) return

    const routes = []
    const seen = new Set()
    for (const flight of aircraftFlightData.flights) {
        const key = flightRouteKey(flight)
        if (!key || seen.has(key)) continue
        seen.add(key)
        const parts = key.split("-")
        routes.push({key, hub: parts[0], dest: parts[1]})
    }
    if (!routes.length) return

    let panel = document.getElementById("aes-aircraft-flights-price-context")
    if (!panel) {
        panel = document.createElement("div")
        panel.id = "aes-aircraft-flights-price-context"
        panel.className = "as-panel"
        panel.style.cssText = "margin:10px 0;padding:8px 10px;"
        const anchor = table.closest(".as-table-well") || table
        anchor.parentNode.insertBefore(panel, anchor)
    }
    panel.textContent = ""

    const title = document.createElement("h3")
    title.style.cssText = "margin:0 0 6px;font-size:14px;"
    title.textContent = "AES route pricing context"
    panel.append(title)

    const visibleRoutes = routes.slice(0, 16)
    let contexts = []
    if (typeof window.AesPriceDiagnostics.buildManyRouteContexts === "function") {
        contexts = await window.AesPriceDiagnostics.buildManyRouteContexts(visibleRoutes).catch(() => [])
    }
    if (!Array.isArray(contexts) || contexts.length !== visibleRoutes.length) {
        contexts = await Promise.all(visibleRoutes.map(route =>
            window.AesPriceDiagnostics.buildRouteContext(route.hub, route.dest)
                .catch(() => null)
        ))
    }

    const wrap = document.createElement("div")
    wrap.style.cssText = "overflow-x:auto;"
    const tableEl = document.createElement("table")
    tableEl.className = "table table-condensed table-striped"
    tableEl.style.cssText = "margin-bottom:0;font-size:12px;"
    const thead = document.createElement("thead")
    thead.innerHTML = "<tr><th>Route</th><th>Current</th><th>Competition</th><th>History</th><th>ORS</th><th>Schedule</th></tr>"
    const tbody = document.createElement("tbody")
    visibleRoutes.forEach((route, idx) => {
        const ctx = contexts[idx]
        const tr = document.createElement("tr")
        const cells = [
            route.key,
            formatPriceMap(ctx && ctx.currentPrices),
            compactRouteContextCell(ctx, "competition"),
            compactRouteContextCell(ctx, "history"),
            compactRouteContextCell(ctx, "ors"),
            compactRouteContextCell(ctx, "schedule")
        ]
        for (const cell of cells) {
            const td = document.createElement("td")
            td.className = "text-nowrap"
            td.textContent = cell
            tr.append(td)
        }
        tbody.append(tr)
    })
    tableEl.append(thead, tbody)
    wrap.append(tableEl)
    panel.append(wrap)

    if (routes.length > 16) {
        const foot = document.createElement("div")
        foot.style.cssText = "font-size:11px;color:#777;margin-top:4px;"
        foot.textContent = "Showing 16 of " + routes.length + " routes on this aircraft."
        panel.append(foot)
    }
}

function createButtonOld() {
    // F-9228-810: only suppress when EVERY row is an XFER. The legacy
    // selector "#aircraft-flight-instances-table td a" hit the first
    // anchor in the table, so a single XFER row at the top hid the
    // extract buttons even when other valid flights were present.
    const rows = document.querySelectorAll("#aircraft-flight-instances-table tbody tr")
    if (!rows.length) return
    let allXfer = true
    for (const r of rows) {
        const fn = r.querySelector("td:nth-child(2)")?.innerText.trim()
        if (fn && fn !== "XFER") { allXfer = false; break }
    }
    if (allXfer) return
    let btn = $('<button class="btn btn-default"></button>').text('Extract all flight profit/loss');
    let btn1 = $('<button class="btn btn-default"></button>').text('Extract finished flight profit/loss');

    let span = $('<span></span>');
    let li = $('<li class="btn-group"></li>').append(btn1, btn, span)
    $('.as-page-aircraft .as-panel.as-action-bar li:first-child').after(li)
    //btn click
    btn.click(function() {
        btn.hide();
        btn1.hide();
        span.addClass('warning').text('Please reload page after all flight info pages open');
        extractAllFlightProfit('all');
    });
    btn1.click(function() {
        btn.hide();
        btn1.hide();
        span.addClass('warning').text('Please reload page after all flight info pages open');
        extractAllFlightProfit('finished');
    })
}

function extractAllFlightProfit(type) {
    // F-9228-803: open the first window synchronously inside the click
    // gesture, then let the user re-confirm if the browser blocked any of
    // the rest. A tight `forEach(window.open)` was previously triggering
    // popup-blockers on Chrome+Firefox after the first 1-2 windows, with
    // no user feedback — extracts silently dropped to a partial set.
    const queue = []
    for (const value of aircraftFlightData.flights) {
        if (type == 'finished'
                && value.status != 'finished'
                && value.status != 'inflight') continue
        queue.push('https://' + aircraftFlightData.server
            + '.airlinesim.aero/action/info/flight?id=' + value.id)
    }
    if (!queue.length) return
    const first = window.open(queue.shift(), '_blank')
    if (!first) {
        alert("Popups blocked. Allow popups for airlinesim.aero, then click Extract again.")
        return
    }
    // Stagger the rest so the browser registers them as part of the same
    // user-gesture chain instead of a flood. 60ms is tight enough that
    // 50 flights still finish in ~3s; loose enough to dodge the blocker.
    let i = 0
    const tick = () => {
        if (i >= queue.length) return
        const w = window.open(queue[i++], '_blank')
        if (!w) console.warn("[AES /1 aircraft-flights] popup blocked at flight", i)
        setTimeout(tick, 60)
    }
    setTimeout(tick, 60)
}

function displayFlightProfit() {
    const table = document.querySelector("#aircraft-flight-instances-table")
    aircraftFlightData.flights.forEach(function(flight) {
        if (!flight.data) {
            return
        }

        const daysAgo = AES.getDateDiff(flight.data.date)
        const total = flight.data && flight.data.money
            && flight.data.money.CM5 && flight.data.money.CM5.Total
        if (typeof total !== "number") return
        const profitCell = flight.row.querySelector("td:nth-child(13)")
        profitCell.innerHTML = null
        profitCell.classList.remove("text-center")
        profitCell.classList.add("text-right")
        profitCell.append(AES.formatCurrency(total))
        const extractedCell = flight.row.querySelector("td:nth-child(14)")
        extractedCell.innerHTML = null
        extractedCell.classList.remove("text-center")
        extractedCell.append(AES.formatDaysAgo(daysAgo))
    })
}

/** Class representing the Aircraft Flights tab */
class AircraftFlightsTab {
    #data
    #info
    #infoPanel
    #statisticsPanel
    #currentFlights

    constructor() {
        this.#info = this.getAircraftInfo()
        this.#data = new Aircraft()
        this.#setAircraftData()
    }

    /**
     * Sets all the aircraft data
     */
    #setAircraftData() {
        this.#data.server = AES.getServerName()
        this.#data.equipment = this.#info.equipment
        this.#data.registration = this.#info.registration
        this.#data.nickname = this.#info.nickname
        this.#data.id = this.getAircraftId()
        this.#data.flights = this.getFlights()
        this.#data.currentSchedule.finishedFlights = this.#data.flights.filter((flight) => !flight.isCancellable).length
        this.#data.currentSchedule.totalFlights = this.#data.flights.length
    }

    /**
     * Get aircraft information from the heading
     */
    getAircraftInfo() {
        const spans = document.querySelectorAll(".as-page-aircraft h1 span")
        const info = {
            id: this.getAircraftId(),
            registration: spans[0]?.innerText,
            equipment: spans[1]?.innerText,
            nickname: spans[2]?.innerText
        }

        return info
    }

    /**
     * Get aircraft ID from the window location
     */
    getAircraftId() {
        const pathname = window.location.pathname
        const id = pathname.match(/(?<=\/)(?:\d+)/)[0]

        return id
    }

    /**
     * Get the data from “flights” table
     * @returns {array} flights
     */
    getFlights() {
        const table = document.querySelector("#aircraft-flight-instances-table")
        const rows = table.querySelectorAll("tbody tr")
        const flights = []

        for (const row of rows) {
            const flight = new FlightData()
            const flightNumber = row.querySelector("td:nth-child(2)")?.innerText.trim()
            if (flightNumber === "XFER" || flightNumber === undefined) {
                continue
            }
            const url = row.querySelector(`[href*="action/info/flight"]`)?.href
            if (!url) {
                // F-9228-804: skip rather than throw. A single row missing
                // its info-link (e.g. a partially-rendered Wicket fragment
                // or a cancelled-but-not-yet-removed flight) used to halt
                // the entire bootstrap, leaving the panel blank for the
                // whole table.
                console.warn("[AES /1 aircraft-flights] skipping row with no info link", row)
                continue
            }

            // Pull the flightId out of the query string (`?id=12345`) — the
            // legacy `url.match(/\d+/)[0]` picked up the "1" in `free1` from
            // the hostname instead. Affects every consumer that joins
            // <server>flightInfo<flightId>; pre-existing bug, fixed here as
            // a prereq for the per-FN attribution slice.
            const idMatch = url.match(/[?&]id=(\d+)/)
            flight.id = idMatch ? parseInt(idMatch[1]) : null
            flight.flightNumber = flightNumber

            // Per-FN linkage (G slice 4) — preserve the FN→numeric-id map and
            // the row's origin/destination/dep so yield-snapshot can attribute
            // profit per route exactly, instead of frequency-weighting a tail's
            // lifetime average across every route it flies.
            const fnLink   = row.querySelector("td:nth-child(2) a[href*='/com/numbers/']")
            const fnIdHit  = fnLink && fnLink.href.match(/\/numbers\/(\d+)/)
            flight.flightNumberId = fnIdHit ? parseInt(fnIdHit[1]) : null
            const orig = row.querySelector("td:nth-child(3) span")?.innerText.trim()
            const dest = row.querySelector("td:nth-child(5) span")?.innerText.trim()
            flight.originIata      = (orig && /^[A-Z]{3}$/.test(orig)) ? orig : null
            flight.destinationIata = (dest && /^[A-Z]{3}$/.test(dest)) ? dest : null
            // Dep-time cell carries a `title` like "27.04. 17:25 UTC / 27.04.
            // 12:25 HT / 27.04. 09:25 LT" — the first segment is the only one
            // in UTC, which is what we want for cross-server comparison.
            const depTitle = row.querySelector("td:nth-child(4) span")?.title || ""
            const depHit   = depTitle.match(/(\d{2}\.\d{2}\.\s*\d{2}:\d{2})\s*UTC/)
            flight.depUtc  = depHit ? depHit[1].replace(/\s+/g, " ").trim() : null

            flight.status = row.querySelector(".flightStatusPanel")?.innerText.trim()
            flight.isCancellable = Boolean(row.querySelector("td:first-child input"))
            flight.row = row

            flights.push(flight)
        }

        return flights
    }

    get data() {
        return this.#data
    }
}
