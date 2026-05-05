"use strict"

const {test, expect} = require("@playwright/test")

test.use({
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: {width: 1440, height: 1000}
})

function captureConsoleError(errors, msg) {
    if (msg.type() !== "error") return
    const text = msg.text()
    if (/^Failed to load resource: net::ERR_(?:CONNECTION_)?TIMED_OUT$/i.test(text)) return
    errors.push("console: " + text)
}

function inventoryForm(values) {
    const row = (label, current, field) => [
        "<tr>",
        "<td>", label, "</td>",
        "<td>", current, "</td>",
        "<td><input type='text' name='", field, "' value='", current, "'></td>",
        "<td></td>",
        "<td><span>", current, "</span></td>",
        "</tr>"
    ].join("")

    return [
        "<!doctype html><html><body>",
        "<form method='post' action='https://TEST.airlinesim.aero/app/com/inventory/ICNNRT?1~panel-settings-settings~form'>",
        "<input type='hidden' name='csrf' value='tok'>",
        "<button name='submit-prices' type='submit'></button>",
        "<fieldset><legend>Pricing</legend><table><tbody>",
        row("Economy", values.Y, "classes:prices:0:newPrice"),
        row("Business", values.C, "classes:prices:1:newPrice"),
        row("First", values.F, "classes:prices:2:newPrice"),
        row("Cargo", values.Cargo, "classes:prices:3:newPrice"),
        "</tbody></table></fieldset>",
        "<fieldset><legend>General Settings</legend>",
        "<select name='serviceProfile'><option selected value='svc-42'>svc-42</option></select>",
        "</fieldset>",
        "</form>",
        "</body></html>"
    ].join("")
}

async function seedDashboard(page) {
    const now = Date.now()
    await page.evaluate(async (ts) => {
        await chrome.storage.local.set({
            "centralHub:settings": {
                activeSection: "routes",
                expandedTiles: ["route-assistant", "inventory"],
                cascadePromptDismissed: true
            },
            settings: {
                routeAssistant: {
                    pricing: {
                        silentAutoEnabled: true,
                        silentAutoFollowMode: "all",
                        silentAutoStrategy: "per-class-elasticity",
                        silentAutoMinDeltaPct: 1,
                        silentAutoMaxStepPct: 10,
                        silentAutoMaxPerDay: 20,
                        silentAutoMaxPerHour: 5,
                        apply: {
                            enabled: true,
                            dryRunOnly: false,
                            liveScopes: {manual: true, silentAuto: true},
                            cooldownMinPerRoute: 0,
                            cooldownMinGlobal: 0,
                            defaultScope: {
                                airportPair: true,
                                flightNumbers: true,
                                returnAirportPair: false,
                                returnFlightNumbers: false
                            }
                        }
                    }
                }
            },
            "routeAssistant:topRoutes:ICN": {
                server: "TEST",
                hub: "ICN",
                scrapedAt: ts,
                snapshotAt: ts,
                rows: [{
                    destIata: "NRT",
                    destName: "Tokyo Narita",
                    score: 91,
                    weeklyFlights: 21,
                    flights: 21,
                    paxDemandPool: 600,
                    cargoDemandPool: 4000,
                    paxElasticity: -1.4,
                    cargoElasticity: -0.9,
                    rmTightness: 0.82
                }]
            },
            "routeAssistant:inventory:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                classes: {
                    Y: {totalSeats: 200, soldSeats: 180},
                    C: {totalSeats: 40, soldSeats: 20},
                    F: {totalSeats: 12, soldSeats: 8},
                    Cargo: {totalSeats: 2500, soldSeats: 2100}
                },
                departures: [{
                    flight: "AB 101",
                    flightNumberId: 101,
                    totalSeats: 252,
                    sold: 208,
                    classBreakdown: {
                        Y: {totalSeats: 200, soldSeats: 180},
                        C: {totalSeats: 40, soldSeats: 20},
                        F: {totalSeats: 12, soldSeats: 8}
                    }
                }],
                flightNumbers: [{code: "AB 101", flightNumberId: 101}]
            },
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                prices: {Y: 100, C: 220, F: 500, Cargo: 0.7}
            },
            "routeAssistant:markets:competitors:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                competitors: [
                    {classKey: "Y", fare: 125},
                    {bookingClass: "Economy", price: 135},
                    {cabinClass: "Business", avgPrice: 180},
                    {serviceClass: "C", price: 190},
                    {payload: "FIRST", price: 620},
                    {class: "F", price: 640},
                    {isCargo: true, price: 0.88},
                    {payloadClass: "CARGO", fare: 0.96}
                ]
            },
            "routeAssistant:markets:historic:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                byPayload: {
                    ECONOMY:  {periods: [1, 2, 3, 4], capacities: [160, 170, 175, 180], prices: [96, 98, 100, 102]},
                    BUSINESS: {periods: [1, 2, 3, 4], capacities: [26, 24, 22, 20], prices: [220, 216, 212, 210]},
                    FIRST:    {periods: [1, 2, 3, 4], capacities: [10, 11, 12, 13], prices: [500, 510, 520, 530]},
                    CARGO:    {periods: [1, 2, 3, 4], capacities: [2000, 2200, 2300, 2400], prices: [0.68, 0.7, 0.72, 0.74]}
                }
            },
            "routeAssistant:yieldHistory:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                lastSnapshotAt: ts,
                snapshots: [
                    {timestamp: ts - 86400000, profitPerFlight: 900, profitPerWeek: 6300, frequency: 7},
                    {timestamp: ts, profitPerFlight: -2500, profitPerWeek: -17500, frequency: 7,
                     attributionMode: "per-flight"}
                ]
            },
            "routeAssistant:ors:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                byClass: {
                    ECONOMY: {
                        totalConnections: 4,
                        connections: [
                            {idx: 1, rating: 88, totalPrice: 100, bookable: true, legs: [{flightCode: "AB 101", isOurs: true}]},
                            {idx: 2, rating: 90, totalPrice: 128, bookable: true, legs: [{flightCode: "NH 10", isOurs: false}]},
                            {idx: 3, rating: 87, totalPrice: 132, bookable: true, legs: [{flightCode: "JL 10", isOurs: false}]},
                            {idx: 4, rating: 82, totalPrice: 145, bookable: true, legs: [{flightCode: "NH 11", isOurs: false}, {flightCode: "JL 11", isOurs: false}]}
                        ],
                        rankAny: 4,
                        rankNonstop: 4,
                        ourTopRating: 86,
                        topCompetitorRating: 90,
                        ratingGapToTop: 4
                    },
                    BUSINESS: {
                        totalConnections: 3,
                        connections: [
                            {idx: 1, rating: 88, totalPrice: 220, bookable: true, legs: [{flightCode: "AB 101", isOurs: true}]},
                            {idx: 2, rating: 91, totalPrice: 190, bookable: true, legs: [{flightCode: "NH 10", isOurs: false}]},
                            {idx: 3, rating: 89, totalPrice: 210, bookable: true, legs: [{flightCode: "JL 10", isOurs: false}]}
                        ],
                        rankAny: 3,
                        rankNonstop: 3,
                        ourTopRating: 88,
                        topCompetitorRating: 91,
                        ratingGapToTop: 3
                    }
                }
            }
        })
    }, now)
}

test("dashboard autopricer and inventory quick price work in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = []
    const postedBodies = []
    const requests = {get: 0, post: 0}
    const currentPrices = {Y: "100", C: "220", F: "500", Cargo: "0.70"}

    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => captureConsoleError(errors, msg))
    page.on("response", resp => {
        const url = resp.url()
        if (url.indexOf(base) === 0 && resp.status() >= 400) {
            errors.push("http " + resp.status() + ": " + url)
        }
    })

    await page.addInitScript(() => {
        window.__aesOpenedUrls = []
        window.__t6_preloadStorage = {
            "centralHub:settings": {
                activeSection: "routes",
                expandedTiles: ["route-assistant", "inventory"],
                cascadePromptDismissed: true
            }
        }
        window.open = function (url) {
            window.__aesOpenedUrls.push(String(url || ""))
            return {closed: false, focus() {}, close() { this.closed = true }}
        }
    })

    await page.route("**/app/com/inventory/ICNNRT**", async route => {
        const req = route.request()
        if (req.method() === "POST") {
            requests.post += 1
            const params = new URLSearchParams(req.postData() || "")
            postedBodies.push(req.postData() || "")
            currentPrices.Y = params.get("classes:prices:0:newPrice") || currentPrices.Y
            currentPrices.C = params.get("classes:prices:1:newPrice") || currentPrices.C
            currentPrices.F = params.get("classes:prices:2:newPrice") || currentPrices.F
            currentPrices.Cargo = params.get("classes:prices:3:newPrice") || currentPrices.Cargo
        } else {
            requests.get += 1
        }
        await route.fulfill({
            status: 200,
            contentType: "text/html",
            headers: {
                "access-control-allow-origin": base,
                "access-control-allow-credentials": "true"
            },
            body: inventoryForm(currentPrices)
        })
    })

    await page.goto(base + "/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() => !!window.__aesCentralHub && !!document.getElementById("aes-central-hub"))
    await seedDashboard(page)
    await page.evaluate(async () => {
        const shell = window.__aesCentralHub
        for (const id of ["route-assistant", "inventory"]) {
            const tile = shell && shell.tilesById && shell.tilesById.get(id)
            if (!tile) continue
            if (!tile.expanded) tile.toggle()
            await tile.refresh()
        }
    })

    await expect(page.locator("#aes-central-hub-tile-route-assistant")).toContainText("NRT")
    await page.locator("#aes-central-hub-tile-route-assistant li", {hasText: "NRT"}).first().click()
    await expect(page.locator("#aes-central-hub-tile-inventory")).toContainText("Focused on ICN")

    await page.locator("#aes-central-hub-tile-inventory button", {hasText: "clear filter"}).click()
    await page.locator("#aes-central-hub-tile-inventory th", {hasText: "Cargo%"}).click()
    await page.locator("#aes-central-hub-tile-inventory button", {hasText: "Set price"}).first().click()

    const select = page.locator("#aes-central-hub-tile-inventory select").first()
    const input = page.locator("#aes-central-hub-tile-inventory input[type='number']").first()
    await select.selectOption("Y")
    await expect(input).toHaveAttribute("step", "1")
    await select.selectOption("C")
    await expect(input).toHaveAttribute("step", "1")
    await select.selectOption("F")
    await expect(input).toHaveAttribute("step", "1")
    await select.selectOption("Cargo")
    await expect(input).toHaveAttribute("step", "0.01")
    await input.fill("0.875")
    const gate = await page.evaluate(async () => {
        const tile = window.__aesCentralHub.tilesById.get("inventory")
        return await tile._quickPriceGate()
    })
    expect(gate).toMatchObject({applyEnabled: true, dryRunOnly: false, manualLiveAllowed: true})
    await page.locator("#aes-central-hub-tile-inventory button", {hasText: "Apply"}).click()

    await expect.poll(() => requests.get, {timeout: 5000}).toBeGreaterThan(0)
    await expect.poll(() => postedBodies.length, {timeout: 5000}).toBe(1)
    expect(postedBodies[0]).toContain("classes%3Aprices%3A0%3AnewPrice=100")
    expect(postedBodies[0]).toContain("classes%3Aprices%3A1%3AnewPrice=220")
    expect(postedBodies[0]).toContain("classes%3Aprices%3A2%3AnewPrice=500")
    expect(postedBodies[0]).toContain("classes%3Aprices%3A3%3AnewPrice=0.88")

    const cache = await page.evaluate(async () => {
        const got = await chrome.storage.local.get(["routeAssistant:markets:ownPricing:ICN-NRT"])
        return got["routeAssistant:markets:ownPricing:ICN-NRT"]
    })
    expect(cache.prices).toMatchObject({Y: 100, C: 220, F: 500, Cargo: 0.88})

    const preview = await page.evaluate(async () => {
        return await window.AesRoutePriceAutomator.preview(
            {server: "TEST", airline: "AB"},
            {limit: 5, followMode: "all"}
        )
    })
    const row = preview.rows.find(r => r.pair === "ICN-NRT")
    expect(row).toBeTruthy()
    expect(row.competitorCountsByClass).toEqual({Y: 3, C: 2, F: 2, Cargo: 2})
    expect(row.marketCompetitorCountsByClass.Y).toBe(2)
    expect(row.competitorPricesByClass.Cargo).toBeCloseTo(0.92, 5)
    expect(row.demandControls.demandPoolByClass.Cargo).toBeGreaterThan(0)
    expect(row.yieldControls.latestProfitPerFlight).toBe(-2500)
    expect(row.orsControls).toMatchObject({rankAny: 4, ratingGapToTop: 4})
    expect(row.pricingSignals.labels).toContain("history")
    expect(row.pricingSignals.labels).toContain("ORS")
    expect(row.pricingSignals.labels).toContain("ORS-price")
    expect(row.pricingSignals.byClass.Y.ors).toBe(true)
    expect(row.pricingSignals.byClass.Cargo.ors).toBe(false)
    expect(preview.counts.withYieldHistory).toBe(1)
    expect(preview.counts.withOrs).toBe(1)
    expect(preview.counts.withOrsIndex).toBe(1)
    expect(preview.counts.withOrsPriceIndex).toBe(1)
    expect(row.orsCompetitorPricesByClass.Y).toBe(132)
    expect(row.orsCompetitorCountsByClass.Y).toBe(3)
    expect(row.proposal.prices).toHaveProperty("Cargo")

    const orsComposite = await page.evaluate(async () => {
        const cache = await window.RouteAssistantOrsIntelligence.bulkLoadRecords([
            {hub: "ICN", dest: "NRT"}
        ], {maxAgeDays: null})
        const rec = cache.get("ICN-NRT")
        const svc = new window.RouteAssistantOrsIntelligence("TEST")
        return svc.getComposite({orsByClass: rec.byClass, competitorYsCount: 2}, {})
    })
    expect(orsComposite.competitorCount).toBe(2)
    expect(orsComposite.competitionWeight).toBeCloseTo(0.9, 5)
    expect(orsComposite.effectiveRatingGapToTop)
        .toBeCloseTo(orsComposite.ratingGapToTop * orsComposite.competitionWeight, 5)

    expect(errors).toEqual([])
})

test("dashboard autopricer blocks one-competitor active-flight hikes on poor ORS in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = []

    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => captureConsoleError(errors, msg))
    page.on("response", resp => {
        const url = resp.url()
        if (url.indexOf(base) === 0 && resp.status() >= 400) {
            errors.push("http " + resp.status() + ": " + url)
        }
    })

    await page.goto(base + "/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() =>
        !!window.AesRoutePriceAutomator && !!window.AesOrsCompetitionWeight)

    const now = Date.now()
    await page.evaluate(async (ts) => {
        await chrome.storage.local.clear()
        await chrome.storage.local.set({
            settings: {
                routeAssistant: {
                    pricing: {
                        silentAutoEnabled: true,
                        silentAutoFollowMode: "all",
                        silentAutoStrategy: "per-class-elasticity",
                        silentAutoMinDeltaPct: 1,
                        silentAutoMaxStepPct: 10,
                        apply: {enabled: true, dryRunOnly: true}
                    }
                }
            },
            "routeAssistant:topRoutes:ICN": {
                server: "TEST",
                hub: "ICN",
                scrapedAt: ts,
                rows: [{
                    destIata: "NRT",
                    destName: "Tokyo Narita",
                    paxScore: 2,
                    paxDemandPool: 600,
                    paxElasticity: -1.2,
                    rmTightness: 0.90
                }]
            },
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                prices: {Y: 100}
            },
            "routeAssistant:markets:competitors:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                competitors: [{classKey: "Y", price: 130}]
            },
            "routeAssistant:ors:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                byClass: {
                    ECONOMY: {
                        rankAny: 18,
                        ourTopRating: 45,
                        topCompetitorRating: 70,
                        ratingGapToTop: 25
                    }
                }
            },
            "TESTABaircraftFlights1": {
                type: "aircraftFlights",
                server: "TEST",
                airline: "AB",
                registration: "HL-101",
                flights: [{
                    flightId: 77,
                    flightNumber: "AB 77",
                    flightNumberId: 770,
                    status: "inflight",
                    originIata: "ICN",
                    destinationIata: "NRT",
                    depUtc: "2026-05-03 06:00"
                }]
            },
            "TESTABflightInfo77": {money: {CM5: {Total: -5000}}}
        })
    }, now)

    const probe = await page.evaluate(async () => {
        const preview = await window.AesRoutePriceAutomator.preview(
            {server: "TEST", airline: "AB"},
            {limit: 5, followMode: "all"}
        )
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        return {
            weight: window.AesOrsCompetitionWeight.weightFromCompetitorCount(1),
            stage: row && row.stage,
            reason: row && row.reason,
            proposal: row && row.proposal,
            controlVariables: row && row.controlVariables,
            competitorCountsByClass: row && row.competitorCountsByClass,
            orsControls: row && row.orsControls
        }
    })

    expect(probe.weight).toBeGreaterThanOrEqual(0.8)
    expect(probe.competitorCountsByClass).toMatchObject({Y: 1})
    expect(probe.orsControls).toMatchObject({rankAny: 18, ratingGapToTop: 25})
    expect(probe.controlVariables).toMatchObject({
        airborne: true,
        demandWeak: true,
        orsSevere: true
    })
    expect(probe.stage).toBe("skipped")
    expect(probe.reason).toMatch(/blocked upward move/)
    expect(probe.proposal).toBeFalsy()
    expect(errors).toEqual([])
})

test("dashboard autopricer uses class-specific ORS controls in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = []
    const now = Date.now()

    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => captureConsoleError(errors, msg))

    await page.goto(base + "/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() => !!window.AesRoutePriceAutomator)

    await page.evaluate(async (ts) => {
        await chrome.storage.local.set({
            settings: {
                routeAssistant: {
                    pricing: {
                        silentAutoEnabled: true,
                        silentAutoFollowMode: "all",
                        silentAutoStrategy: "per-class-elasticity",
                        silentAutoMinDeltaPct: 1,
                        silentAutoMaxStepPct: 10,
                        silentAutoPerClassEnabled: {Y: false, C: true, F: false, Cargo: false},
                        silentAutoPerClassMinDemandPool: {Y: 0, C: 0, F: 0, Cargo: 0},
                        apply: {enabled: true, dryRunOnly: true, liveScopes: {silentAuto: false}}
                    }
                }
            },
            "routeAssistant:topRoutes:ICN": {
                server: "TEST",
                hub: "ICN",
                scrapedAt: ts,
                rows: [{
                    destIata: "NRT",
                    destName: "Tokyo Narita",
                    score: 88,
                    weeklyFlights: 14,
                    demandPoolByClass: {C: 80},
                    priceElasticityByClass: {C: -1},
                    rmTightnessByClass: {C: 0.95}
                }]
            },
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                prices: {Y: 100, C: 200, F: 500, Cargo: 0.75}
            },
            "routeAssistant:markets:competitors:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                competitors: [
                    {serviceClass: "C", price: 320},
                    {serviceClass: "C", price: 330},
                    {serviceClass: "C", price: 340},
                    {serviceClass: "C", price: 350},
                    {serviceClass: "C", price: 360}
                ]
            },
            "routeAssistant:ors:ICN-NRT": {
                server: "TEST",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: ts,
                byClass: {
                    ECONOMY: {
                        rankAny: 1,
                        ratingGapToTop: 1,
                        ourTopRating: 98,
                        topCompetitorRating: 99,
                        totalConnections: 4
                    },
                    BUSINESS: {
                        rankAny: 18,
                        ratingGapToTop: 15,
                        ourTopRating: 80,
                        topCompetitorRating: 95,
                        totalConnections: 20
                    }
                }
            }
        })
    }, now)

    const preview = await page.evaluate(async () => {
        return await window.AesRoutePriceAutomator.preview(
            {server: "TEST", airline: "AB"},
            {limit: 5, followMode: "all"}
        )
    })
    const row = preview.rows.find(r => r.pair === "ICN-NRT")
    expect(row).toBeTruthy()
    expect(row.stage).toBe("proposed")
    expect(row.orsControls.primaryClass).toBe("ECONOMY")
    expect(row.orsControlsByClass.C.primaryClass).toBe("BUSINESS")
    expect(row.controlVariables.classKey).toBe("C")
    expect(row.controlVariables.rankAny).toBe(18)
    expect(row.controlVariables.orsSevere).toBe(true)
    expect(row.proposal.prices.C).toBeLessThan(220)
    expect(row.proposal.prices.C).toBeGreaterThan(200)
    expect(row.proposal.rationale.join(" ")).toContain("[C] [control:ORS]")
    expect(errors).toEqual([])
})

test("per-leg autopricer uses class-specific ORS controls in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const now = Date.now()
    const errors = []

    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => captureConsoleError(errors, msg))

    await page.route("**/app/com/numbers/123/0", async route => {
        await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: [
                "<!doctype html><html><head><title>AB 123</title></head><body>",
                "<script>",
                "const store = ",
                JSON.stringify({
                    routeAssistantSettings: {
                        pricing: {silentAutoMinDeltaPct: 1, silentAutoMaxStepPct: 30}
                    },
                    "routeAssistant:demand:NRT": {
                        priceElasticityByClass: {C: -1},
                        demandPoolByClass: {C: 80},
                        rmTightnessByClass: {C: 0.95}
                    },
                    "routeAssistant:markets:competitors:ICN-NRT": {
                        competitors: [
                            {serviceClass: "C", price: 320},
                            {serviceClass: "C", price: 340}
                        ]
                    },
                    "routeAssistant:ors:ICN-NRT": {
                        scrapedAt: now,
                        byClass: {
                            ECONOMY: {rankAny: 1, ratingGapToTop: 1, ourTopRating: 98, topCompetitorRating: 99},
                            BUSINESS: {rankAny: 18, ratingGapToTop: 15, ourTopRating: 80, topCompetitorRating: 95}
                        }
                    }
                }),
                ";",
                "window.chrome = {runtime: {}, storage: {local: {get(keys, cb) {",
                "const out = {};",
                "if (keys == null) Object.assign(out, store);",
                "else if (typeof keys === 'string') { if (keys in store) out[keys] = store[keys]; }",
                "else if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = store[k]; }",
                "else { for (const k of Object.keys(keys || {})) out[k] = k in store ? store[k] : keys[k]; }",
                "setTimeout(() => cb(out), 0);",
                "}}}};",
                "</script>",
                "<h1><a href='/app/info/airports/ICN'>Seoul (ICN)</a> to ",
                "<a href='/app/info/airports/NRT'>Tokyo (NRT)</a></h1>",
                "<form><fieldset><legend>Pricing</legend><table><tbody>",
                "<tr><td>Economy</td><td>100</td><td><input type='text' value='100'></td></tr>",
                "<tr><td>Business</td><td>200</td><td><input type='text' value='200'></td></tr>",
                "<tr><td>First</td><td>500</td><td><input type='text' value='500'></td></tr>",
                "<tr><td>Cargo</td><td>0.75</td><td><input type='text' value='0.75'></td></tr>",
                "</tbody></table></fieldset></form>",
                "<script src='/modules/route-assistant/per-leg-autopricer.js'></script>",
                "</body></html>"
            ].join("")
        })
    })

    await page.goto(base + "/app/com/numbers/123/0", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() => !!window.AesPerLegAutopricer)

    const result = await page.evaluate(async () => {
        return await window.AesPerLegAutopricer.run()
    })
    expect(result.route).toMatchObject({hub: "ICN", dest: "NRT"})
    expect(result.routeSignals.ors.rankAny).toBe(1)
    expect(result.routeSignals.orsByClass.C.rankAny).toBe(18)
    expect(result.suggestions.C.skipReason || "").toBe("")
    expect(result.suggestions.C.routeSignalNotes).toContain("poor ORS")
    expect(result.suggestions.C.newPrice).toBeLessThan(260)
    expect(result.suggestions.C.newPrice).toBeGreaterThan(200)
    expect(errors).toEqual([])
})
