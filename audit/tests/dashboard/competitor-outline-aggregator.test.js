"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

console.log("=== competitor-outline-aggregator ===")

let pass = 0
let fail = 0
async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

function summary() {
    console.log("\ncompetitor-outline-aggregator: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
}

function evalModule(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
}

function installChromeStorage(seed) {
    const store = Object.assign({}, seed || {})
    global.chrome = {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) return Object.assign({}, store)
                    if (typeof keys === "string") return {[keys]: store[keys]}
                    if (Array.isArray(keys)) {
                        const out = {}
                        for (const k of keys) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]
                        return out
                    }
                    const out = {}
                    for (const k in keys || {}) out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : keys[k]
                    return out
                },
                async set(obj) { Object.assign(store, obj || {}) },
                async remove(keys) {
                    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
                }
            }
        }
    }
    return store
}

function installModules(seed, ledgerFactory) {
    global.window = {
        RouteAssistantCompetitorIncome: {
            estimate(input) {
                const freq = Number(input && input.frequency) || 0
                return {
                    estRevenuePerWeek: freq * 2000,
                    estProfitPerWeek: freq * 1000,
                    confidence: input && input.observedSharePct != null ? "high" : "med",
                    breakdown: {}
                }
            }
        },
        AccountingAggregator: {
            async loadUnifiedLedger(server, airline) {
                return ledgerFactory ? ledgerFactory(server, airline) : null
            }
        }
    }
    global.RouteAssistantCompetitorIncome = window.RouteAssistantCompetitorIncome
    global.AccountingAggregator = window.AccountingAggregator
    global.AesCanopyAffiliations = window.AesCanopyAffiliations = {
        async load() {
            return seed["aesCanopy:affiliations"] || {schemaVersion: 1, byEnterpriseId: {}}
        },
        kindLabel(kind) {
            return ({
                self: "Kin",
                allied: "Allied",
                interline: "Interline",
                codeshare: "Codeshare",
                neutral: "Neutral",
                adversary: "Adversary"
            })[kind] || "Neutral"
        }
    }
    evalModule("modules/competitor-intel/competitor-store.js")
    global.AesCompetitorStore = window.AesCompetitorStore
    evalModule("modules/competitor-intel/outline-aggregator.js")
    global.AesCompetitorOutlineAggregator = window.AesCompetitorOutlineAggregator
    return window.AesCompetitorOutlineAggregator
}

function enterprise(server, id, name, iata, routes, fleet) {
    return {
        server,
        enterpriseId: id,
        name,
        iata,
        scrapedAt: 1777600000000,
        fleet: fleet || {aircraftCount: 2, paxCarried: 1000, cargoCarried: 100},
        fleetByType: [{typeId: "T1", typeCode: "A320", count: 2, avgAgeMonths: 24}],
        routeFootprint: routes
    }
}

function addRoute(seed, server, pair, code, freq) {
    const flights = []
    for (let i = 0; i < freq; i++) {
        flights.push({
            flightCode: code + " " + (100 + i),
            typeId: "T1",
            typeCode: "A320",
            price: 100,
            availability: {totalSeats: 150}
        })
    }
    seed["routeAssistant:markets:competitors:" + pair] = {
        scrapedAt: 1777600000000,
        competitors: flights
    }
    seed["routeAssistant:markets:marketShare:" + pair] = {
        pax: [{code, sharePct: 40}]
    }
    seed["routeAssistant:distance:" + pair] = {distanceKm: 1000}
    seed["routeAssistant:typeSpecs:T1"] = {seats: 150, range: 5000, speed: 800, cargoCapacity: 0}
    seed["competitorIntel:edge:" + server + ":" + pair] = {scrapedAt: 1777600000000}
}

function buildSeed() {
    const server = "free1"
    const seed = {
        "aesCanopy:affiliations": {
            schemaVersion: 1,
            byEnterpriseId: {
                OWN: {enterpriseId: "OWN", kind: "self", source: "user"},
                ALL: {enterpriseId: "ALL", kind: "allied", source: "auto:contractualPartners"},
                INT: {enterpriseId: "INT", kind: "interline", source: "auto:contractualPartners"},
                COD: {enterpriseId: "COD", kind: "codeshare", source: "auto:contractualPartners"},
                NEU: {enterpriseId: "NEU", kind: "neutral", source: "auto:default"},
                ADV: {enterpriseId: "ADV", kind: "adversary", source: "user"},
                L1:  {enterpriseId: "L1",  kind: "neutral", source: "auto:default"}
            }
        }
    }
    const records = [
        enterprise(server, "OWN", "Own Air", "OA", [{hub: "AAA", dest: "BBB", weeklyFlights: 1}]),
        enterprise(server, "ALL", "Ally Air", "AL", [{hub: "AAA", dest: "BBB", weeklyFlights: 1}]),
        enterprise(server, "INT", "Interline Air", "IN", [{hub: "AAA", dest: "BBB", weeklyFlights: 1}]),
        enterprise(server, "COD", "Codeshare Air", "CO", [{hub: "AAA", dest: "BBB", weeklyFlights: 1}]),
        enterprise(server, "NEU", "Neutral Air", "NE", [
            {hub: "AAA", dest: "BBB", weeklyFlights: 2},
            {hub: "AAA", dest: "CCC", weeklyFlights: 1}
        ]),
        enterprise(server, "ADV", "Adversary Air", "AD", [{hub: "AAA", dest: "DDD", weeklyFlights: 3}]),
        enterprise(server, "UNC", "Unknown Air", "UN", [{hub: "AAA", dest: "EEE", weeklyFlights: 1}]),
        enterprise(server, "L1", "Modern Merge", "LG", [{hub: "AAA", dest: "FFF", weeklyFlights: 2}],
            {aircraftCount: 1})
    ]
    for (const rec of records) {
        seed["competitorIntel:enterprise:" + server + ":" + rec.enterpriseId] = rec
    }
    seed[server + "L1competitorMonitoring"] = {
        type: "competitorMonitoring",
        server,
        id: "L1",
        tracking: true,
        tab0: {"20260501": {
            displayName: "Legacy Merge",
            code: "LG",
            fleet: 9,
            stations: 5,
            employees: 100,
            pax: 2000,
            cargo: 300,
            rating: "A"
        }},
        tab2: {"20260501": {
            operatedFlights: 44,
            seatsOffered: 5000,
            cargoOffered: 600
        }}
    }
    seed[server + "LGschedule"] = {
        date: {"20260501": {
            updateTime: "12:00",
            schedule: [{od: "AAAFFF", flightNumber: {a: {paxFreq: 2, cargoFreq: 0}}}]
        }}
    }
    addRoute(seed, server, "AAA-BBB", "NE", 2)
    addRoute(seed, server, "AAA-CCC", "NE", 1)
    addRoute(seed, server, "AAA-DDD", "AD", 3)
    addRoute(seed, server, "AAA-EEE", "UN", 1)
    addRoute(seed, server, "AAA-FFF", "LG", 2)
    return seed
}

async function build(ledgerFactory) {
    const seed = buildSeed()
    installChromeStorage(seed)
    const Aggregator = installModules(seed, ledgerFactory)
    return Aggregator.build({server: "free1", airline: "MYAIR"})
}

;(async () => {
    await it("self/allied/interline/codeshare rows are excluded from the default rival set", async () => {
        const outline = await build()
        const rivals = outline.competitors.filter(c => c.relationship.includedAsRival)
        const rivalIds = new Set(rivals.map(c => c.enterpriseId))
        assert.strictEqual(outline.rivalCount, rivals.length)
        for (const id of ["OWN", "ALL", "INT", "COD"]) {
            assert.strictEqual(rivalIds.has(id), false, id + " should not be a default rival")
            assert.strictEqual(outline.competitors.find(c => c.enterpriseId === id).relationship.includedAsRival, false)
        }
    })

    await it("neutral/adversary/unclassified enterprises are included as rivals", async () => {
        const outline = await build()
        for (const id of ["NEU", "ADV", "UNC"]) {
            const row = outline.competitors.find(c => c.enterpriseId === id)
            assert.ok(row, "missing " + id)
            assert.strictEqual(row.relationship.includedAsRival, true)
        }
        assert.strictEqual(outline.competitors.find(c => c.enterpriseId === "UNC").relationship.kind, "unclassified")
    })

    await it("legacy monitoring facts merge into modern competitor records", async () => {
        const outline = await build()
        const row = outline.competitors.find(c => c.enterpriseId === "L1")
        assert.ok(row)
        assert.strictEqual(row.financials.publicFacts.aircraft, 1)
        assert.strictEqual(row.financials.publicFacts.employees, 100)
        assert.strictEqual(row.financials.publicFacts.seatsOffered, 5000)
    })

    await it("estimated rival totals match summed route estimates", async () => {
        const outline = await build()
        const row = outline.competitors.find(c => c.enterpriseId === "NEU")
        const routeSum = row.routes.reduce((s, r) => s + (r.theirs.estProfitPerWeek || 0), 0)
        assert.strictEqual(row.financials.totalEstimatedWeeklyProfit, routeSum)
        assert.strictEqual(row.financials.totalEstimatedWeeklyProfit, 3000)
    })

    await it("own accounting actuals attach when snapshots exist", async () => {
        const outline = await build(() => ({
            scrapedAt: 1777600010000,
            snapshotIndexCount: 1,
            periodActuals: {
                weekId: "2026-05-01",
                totals: {
                    revenue: {current: 90000},
                    ebit: {current: 12000},
                    ebt: {current: 11000}
                },
                scrapedAt: 1777600000000
            },
            bankActuals: {cashBalance: 500000, payload: {cashBalance: 500000}, scrapedAt: 1777600005000},
            routes: [
                {profitPerWeek: 1000, snapshotAt: 1777600000000},
                {profitPerWeek: 2500, snapshotAt: 1777600000000}
            ],
            aircraft: [{profit: 7000, finishedFlights: 12}],
            sisters: {}
        }))
        assert.ok(outline.ourFinancials)
        assert.strictEqual(outline.ourFinancials.label, "Actual")
        assert.strictEqual(outline.ourFinancials.latest.revenue, 90000)
        assert.strictEqual(outline.ourFinancials.cashBalance, 500000)
        assert.strictEqual(outline.ourFinancials.routes.totalProfitPerWeek, 3500)
    })

    await it("own accounting actuals stay absent without accounting snapshots", async () => {
        const outline = await build(() => ({
            scrapedAt: 1777600010000,
            snapshotIndexCount: 0,
            routes: [{profitPerWeek: 1000, snapshotAt: 1777600000000}],
            aircraft: [{profit: 7000}],
            sisters: {}
        }))
        assert.strictEqual(Object.prototype.hasOwnProperty.call(outline, "ourFinancials"), false)
    })

    summary()
})()
