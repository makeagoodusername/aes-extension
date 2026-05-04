"use strict"

const {test, expect} = require("@playwright/test")

test.use({
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: {width: 1440, height: 1000}
})

function captureErrors(page, base) {
    const errors = []
    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => {
        if (msg.type() === "error") errors.push("console: " + msg.text())
    })
    page.on("response", resp => {
        const url = resp.url()
        if (url.indexOf(base) === 0 && resp.status() >= 400) {
            errors.push("http " + resp.status() + ": " + url)
        }
    })
    page.on("requestfailed", req => {
        const failure = req.failure()
        errors.push("requestfailed: " + req.method() + " " + req.resourceType() + " "
            + req.url() + " :: " + (failure && failure.errorText || "unknown"))
    })
    return errors
}

async function openHarness(page, base, preload) {
    await page.addInitScript(value => {
        window.__t6_preloadStorage = Object.assign({
            "centralHub:settings": {
                activeSection: "tools",
                expandedTiles: ["strategy"],
                cascadePromptDismissed: true
            }
        }, value || {})
    }, (preload && typeof preload === "object") ? preload : {})
    await page.goto(base + "/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() =>
        !!window.__aesCentralHub
        && !!window.__aesCentralHub.tilesById
        && window.__aesCentralHub.tilesById.has("strategy")
        && !!document.querySelector("[data-aes-strategy-menu='connected']"))
}

function strategyFixture() {
    const decisions = [
        {
            id: "schedule-1",
            kind: "schedule",
            domain: "schedule",
            title: "Schedule HL-101 on ICN-NRT",
            subtitle: "Narrowbody rotation",
            applicable: true,
            rationale: ["Adds profitable weekly capacity"],
            payload: {aircraftId: "HL-101", legs: [{origin: "ICN", destination: "NRT"}]},
            _diff: {added: 2, removed: 0, kept: 5, locked: 0},
            _impact: {unit: "$/wk", value: 4200, label: "+$4,200/wk", tone: "ok"}
        },
        {
            id: "service-1",
            kind: "service",
            domain: "service",
            title: "Upgrade ICN-SIN service profile",
            subtitle: "ORS lift for premium route",
            applicable: true,
            rationale: ["Service gap to top competitor"],
            payload: {hub: "ICN", dest: "SIN"},
            _impact: {unit: "ORS", value: 0.06, label: "+0.060 ORS", tone: "ok"}
        },
        {
            id: "price-1",
            kind: "price",
            domain: "price",
            title: "ICN-NRT price to 105%",
            subtitle: "ORS stable with demand tightness",
            applicable: true,
            rationale: ["Competitor band leaves room"],
            payload: {hub: "ICN", dest: "NRT", toPct: 105},
            _impact: {unit: "$/wk", value: 1800, label: "+$1,800/wk", tone: "ok"}
        },
        {
            id: "price-2",
            kind: "price",
            domain: "price",
            title: "ICN-HKG price to 96%",
            subtitle: "ORS recovery move",
            applicable: true,
            rationale: ["Rank gap widened"],
            payload: {hub: "ICN", dest: "HKG", toPct: 96},
            _impact: {unit: "$/wk", value: 900, label: "+$900/wk", tone: "ok"}
        },
        {
            id: "alliance-1",
            kind: "alliance",
            domain: "alliance",
            title: "Request interline with Test Partner",
            subtitle: "Manual review before sending",
            applicable: false,
            applicableNote: "Advisory only in this fixture",
            rationale: ["Partner covers weak onward market"],
            payload: {kind: "il-request", partnerEnterpriseId: 42}
        },
        {
            id: "slot-1",
            kind: "slot-bid",
            domain: "slotBid",
            title: "Bid for HND morning slot",
            subtitle: "Dry-run queue until AS bid form mapping is complete",
            applicable: false,
            applicableNote: "Advisory only in this fixture",
            rationale: ["High ORS feed into Tokyo bank"],
            payload: {iata: "HND", slotId: "HND-AM-01", bidAmount: 1250000}
        }
    ]
    return {
        snapshot: {server: "TEST", airlineCode: "AB", hubs: []},
        plan: {
            server: "TEST",
            airlineCode: "AB",
            planId: "chrome-strategy-menu-fixture",
            summary: {predictedWeeklyProfit: 6900, predictedOrsAvg: 0.82},
            perAircraft: []
        },
        diff: {
            summary: {
                byKind: {schedule: 1, service: 1, price: 2, crew: 0, routeCreation: 0, alliance: 1, "slot-bid": 1},
                applicableTotal: 4,
                advisoryTotal: 2,
                scheduleDiffMode: "real",
                addedLegs: 2,
                removedLegs: 0,
                keptLegs: 5,
                lockedLegs: 0,
                aircraftWithDiff: 1,
                aircraftMissingDiff: 0
            },
            decisions
        }
    }
}

test("strategy dashboard menu opens connected surfaces in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    const menu = page.locator("[data-aes-strategy-menu='connected']")
    await expect(menu).toBeVisible()
    await expect(menu.locator("[data-aes-strategy-menu-target]")).toHaveCount(9)

    await menu.locator("[data-aes-strategy-menu-target='preview']").click()
    await expect(page.locator(".aes-strategy-modal")).toBeVisible()
    await expect(page.locator(".aes-strategy-modal [data-aes-strategy-menu='decisions']")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-strategy-modal")).toHaveCount(0)

    await menu.locator("[data-aes-strategy-menu-target='backtest']").click()
    await expect(page.locator("#aes-central-hub-tile-strategy-backtest .aes-central-hub-tile__body")).toBeVisible()

    await menu.locator("[data-aes-strategy-menu-target='weekly-review']").click()
    await expect(page.locator("#aes-central-hub-tile-weekly-review .aes-central-hub-tile__body")).toBeVisible()

    await menu.locator("[data-aes-strategy-menu-target='diagnostics']").click()
    await expect(page.locator("#aes-central-hub-tile-diagnostics .aes-central-hub-tile__body")).toBeVisible()

    await menu.locator("[data-aes-strategy-menu-target='layered']").click()
    await expect(page.locator(".aes-layered-panel [role='dialog']")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-layered-panel")).toHaveCount(0)

    await menu.locator("[data-aes-strategy-menu-target='briefing']").click()
    await expect(page.locator(".aes-briefing-modal [role='dialog']")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-briefing-modal")).toHaveCount(0)

    await menu.locator("[data-aes-strategy-menu-target='hub-designer']").click()
    await expect(page.locator("#aes-central-hub-tile-strategy-hub-designer .aes-central-hub-tile__body")).toBeVisible()

    await menu.locator("[data-aes-strategy-menu-target='portfolio']").click()
    await expect(page.locator("#aes-central-hub-tile-strategy-portfolio .aes-central-hub-tile__body")).toBeVisible()

    await menu.locator("[data-aes-strategy-menu-target='slot-trading']").click()
    await expect(page.locator("#aes-central-hub-tile-strategy-slot-trading .aes-central-hub-tile__body")).toBeVisible()
    await expect(page.locator(".aes-strategy-modal")).toBeVisible()
    await expect(page.locator(".aes-strategy-modal select[data-aes-strategy-domain-filter]")).toHaveValue("slotBid")
    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-strategy-modal")).toHaveCount(0)

    expect(errors).toEqual([])
})

test("strategy modal section and domain menus filter real decisions in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    await page.evaluate(async fixture => {
        await window.AesStrategyPanel.open(Object.assign({section: "decisions"}, fixture))
    }, strategyFixture())

    const modal = page.locator(".aes-strategy-modal")
    await expect(modal).toBeVisible()
    await expect(modal.locator("[data-aes-strategy-menu='decisions']")).toHaveAttribute("data-active", "1")
    await expect(modal).toContainText("ICN-NRT price to 105%")
    await expect(modal).toContainText("Schedule HL-101")

    await modal.locator("button[data-aes-strategy-filter='price']").click()
    await expect(modal.locator("select[data-aes-strategy-domain-filter]")).toHaveValue("price")
    await expect(modal).toContainText("ICN-NRT price to 105%")
    await expect(modal).toContainText("ICN-HKG price to 96%")
    await expect(modal).not.toContainText("Schedule HL-101")
    await expect(modal.locator("button[data-aes-strategy-filter='price']")).toHaveAttribute("data-active", "1")

    await modal.locator("select[data-aes-strategy-domain-filter]").selectOption("service")
    await expect(modal).toContainText("Upgrade ICN-SIN service profile")
    await expect(modal).not.toContainText("ICN-NRT price to 105%")

    await modal.locator("button[data-aes-strategy-clear-filters='1']").click()
    await expect(modal).toContainText("Schedule HL-101")
    await expect(modal).toContainText("Request interline with Test Partner")

    await modal.getByRole("checkbox", {name: "Advisory only", exact: true}).check()
    await expect(modal).toContainText("Request interline with Test Partner")
    await expect(modal).toContainText("Bid for HND morning slot")
    await expect(modal).not.toContainText("ICN-HKG price to 96%")

    await modal.locator("button[data-aes-strategy-filter='slotBid']").click()
    await expect(modal.locator("select[data-aes-strategy-domain-filter]")).toHaveValue("slotBid")
    await expect(modal).toContainText("Bid for HND morning slot")
    await expect(modal).not.toContainText("Request interline with Test Partner")

    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-strategy-modal")).toHaveCount(0)
    expect(errors).toEqual([])
})

test("hub designer modal exposes a stable Chrome dialog contract", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    await page.evaluate(async () => {
        await window.AesStrategyHubDesignerModal.open({
            snapshot: {
                server: "TEST",
                airlineCode: "AB",
                fleet: [{aircraftId: "HL-101", rangeKm: 5200}],
                hubs: [{
                    iata: "ICN",
                    byRoute: [
                        {dest: "NRT", paxScore: 90, weeklyFlights: 14, profitPerWeek: 12000, distanceKm: 1200},
                        {dest: "HKG", paxScore: 60, weeklyFlights: 7, profitPerWeek: 8000, distanceKm: 2100}
                    ]
                }],
                rivals: [{hubIatas: ["NRT"]}]
            }
        })
    })

    await expect(page.locator(".aes-hub-designer-modal [role='dialog']")).toBeVisible()
    await expect(page.locator(".aes-hub-designer-modal")).toContainText("Hub Network Designer")
    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-hub-designer-modal")).toHaveCount(0)
    expect(errors).toEqual([])
})

test("portfolio row opens Strategy panel scoped to selected world in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const now = Date.now()
    const errors = captureErrors(page, base)
    await openHarness(page, base, {
        aesAccounts: {
            migrationVersion: 1,
            viewingAccountId: "acct-free1",
            accounts: {
                "acct-free1": {
                    id: "acct-free1",
                    server: "free1",
                    airlineIdentity: "Alpha Air",
                    displayName: "Alpha Air",
                    firstSeenAt: now - 2000,
                    lastSeenAt: now - 1000
                },
                "acct-free2": {
                    id: "acct-free2",
                    server: "free2",
                    airlineIdentity: "Beta Cargo",
                    displayName: "Beta Cargo",
                    firstSeenAt: now - 3000,
                    lastSeenAt: now - 500
                }
            }
        }
    })

    await page.evaluate(async () => {
        const realSnapshot = window.AesStrategy.snapshot
        window.AesStrategy.snapshot = async opts => {
            if (opts && opts.server === "free2") {
                return {
                    server: "free2",
                    airlineCode: opts.airlineCode,
                    cash: {weeklyResult: 160000, bankBalance: 5000000, runwayWeeks: 18},
                    fleet: [{aircraftId: "B1", seats: 220}, {aircraftId: "B2", seats: 180}],
                    hubs: []
                }
            }
            return {
                server: "free1",
                airlineCode: opts && opts.airlineCode,
                cash: {weeklyResult: 55000, bankBalance: 2500000, runwayWeeks: 10},
                fleet: [{aircraftId: "A1", seats: 160}],
                hubs: []
            }
        }
        window.__aesPortfolioRealSnapshot = realSnapshot
        window.__aesPortfolioOpenOpts = null
        window.AesStrategyPanel.open = opts => {
            window.__aesPortfolioOpenOpts = opts || {}
            return Promise.resolve()
        }
        await chrome.storage.local.remove("aesStrategy:portfolio:multiWorld")
        const tile = window.__aesCentralHub.tilesById.get("strategy-portfolio")
        await tile.refresh()
    })

    await page.locator("[data-aes-strategy-menu-target='portfolio']").click()
    const portfolio = page.locator("#aes-central-hub-tile-strategy-portfolio")
    await expect(portfolio).toContainText("2 WORLDS")
    await expect(portfolio).toContainText("Beta Cargo")
    await page.evaluate(() => {
        document.querySelectorAll(".aes-briefing-modal,.aes-strategy-panel,.aes-hub-designer-modal,.aes-layered-panel")
            .forEach(el => { try { el.remove() } catch (_) {} })
    })
    await portfolio.getByText("Beta Cargo · free2").click()

    const opened = await page.evaluate(() => window.__aesPortfolioOpenOpts)
    expect(opened).toMatchObject({server: "free2", airlineCode: "Beta Cargo"})
    expect(errors).toEqual([])
})

test("hub designer tile header falls back visibly on thin snapshots in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    const tile = page.locator("#aes-central-hub-tile-strategy-hub-designer")
    await expect(tile).toBeVisible()
    await tile.locator(".aes-central-hub-tile__open").click()
    await expect(tile.locator(".aes-central-hub-tile__body")).toBeVisible()
    await expect(tile).toContainText("Open the AS dashboard so the snapshot can populate.")
    expect(errors).toEqual([])
})

test("command palette hub designer action falls back to tile on thin snapshots in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    const result = await page.evaluate(async () => window.AESCommandRegistry.dispatch("open.strategy.hubDesigner"))
    expect(result).toMatchObject({ok: true})

    const tile = page.locator("#aes-central-hub-tile-strategy-hub-designer")
    await expect(tile.locator(".aes-central-hub-tile__body")).toBeVisible()
    await expect(tile).toContainText("Open the AS dashboard so the snapshot can populate.")
    expect(errors).toEqual([])
})

test("command palette strategy portfolio and slot trading commands are wired in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    const ranked = await page.evaluate(() => ({
        slot: window.AESCommandRegistry.list({scope: "dashboard", query: "slot trading"}).map(c => c.id).slice(0, 2),
        portfolio: window.AESCommandRegistry.list({scope: "dashboard", query: "strategy portfolio"}).map(c => c.id).slice(0, 2)
    }))
    expect(ranked.slot[0]).toBe("open.strategy.slotTrading")
    expect(ranked.portfolio[0]).toBe("open.strategy.portfolio")

    await page.evaluate(async () => window.AESCommandRegistry.dispatch("open.strategy.portfolio"))
    await expect(page.locator("#aes-central-hub-tile-strategy-portfolio .aes-central-hub-tile__body")).toBeVisible()

    await page.evaluate(async () => window.AESCommandRegistry.dispatch("open.strategy.slotTrading"))
    await expect(page.locator("#aes-central-hub-tile-strategy-slot-trading .aes-central-hub-tile__body")).toBeVisible()
    await expect(page.locator(".aes-strategy-modal")).toBeVisible()
    await expect(page.locator(".aes-strategy-modal select[data-aes-strategy-domain-filter]")).toHaveValue("slotBid")
    expect(errors).toEqual([])
})

test("generic strategy commands reset stale decision filters in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    await page.evaluate(() => {
        const fixture = {
            snapshot: {
                server: "TEST",
                airlineCode: "AB",
                hubs: [{iata: "ICN", byRoute: [{dest: "NRT"}, {dest: "SIN"}]}]
            },
            plan: {
                server: "TEST",
                airlineCode: "AB",
                planId: "chrome-filter-reset",
                summary: {predictedWeeklyProfit: 3100, predictedOrsAvg: 0.81},
                perAircraft: []
            },
            diff: {
                summary: {
                    byKind: {schedule: 1, service: 1, price: 1, crew: 0, routeCreation: 0, alliance: 0, "slot-bid": 0},
                    applicableTotal: 3,
                    advisoryTotal: 0,
                    scheduleDiffMode: "stub",
                    addedLegs: 0,
                    removedLegs: 0,
                    keptLegs: 0,
                    lockedLegs: 0,
                    aircraftWithDiff: 0,
                    aircraftMissingDiff: 0
                },
                decisions: [
                    {id: "price-1", kind: "price", domain: "price", title: "ICN-NRT price lift", applicable: true, payload: {hub: "ICN", dest: "NRT", toPct: 105}},
                    {id: "service-1", kind: "service", domain: "service", title: "ICN-SIN service upgrade", applicable: true, payload: {hub: "ICN", dest: "SIN"}},
                    {id: "schedule-1", kind: "schedule", domain: "schedule", title: "Schedule ICN-NRT", applicable: true, payload: {aircraftId: "A1", legs: []}}
                ]
            }
        }
        window.AesStrategy.snapshot = async () => fixture.snapshot
        window.AesStrategy.scoreRoutes = () => []
        window.AesStrategy.allocateFleet = async () => fixture.plan
        window.AesStrategy.diffPlan = () => fixture.diff
    })

    await page.evaluate(async () => window.AESCommandRegistry.dispatch("open.strategy.pricing"))
    await expect(page.locator(".aes-strategy-modal select[data-aes-strategy-domain-filter]")).toHaveValue("price")

    await page.evaluate(async () => window.AESCommandRegistry.dispatch("open.strategy.decisions"))
    const modal = page.locator(".aes-strategy-modal")
    await expect(modal.locator("select[data-aes-strategy-domain-filter]")).toHaveValue("all")
    await expect(modal).toContainText("ICN-NRT price lift")
    await expect(modal).toContainText("ICN-SIN service upgrade")
    await expect(modal).toContainText("Schedule ICN-NRT")

    await page.evaluate(async () => window.AESCommandRegistry.dispatch("open.strategy"))
    await expect(modal.locator("[data-aes-strategy-menu='overview']")).toHaveAttribute("data-active", "1")
    await expect(modal.locator("select[data-aes-strategy-domain-filter]")).toHaveValue("all")

    for (const [domainCommand, genericCommand, activeMenu] of [
        ["open.strategy.service", "open.strategy.settings", "settings"],
        ["open.strategy.pricing", "open.strategy.schedules", "aircraft"],
        ["open.strategy.service", "open.strategy.learning", "learning"],
        ["open.strategy.pricing", "open.strategy.journal", "journal"]
    ]) {
        await page.evaluate(async id => window.AESCommandRegistry.dispatch(id), domainCommand)
        await expect(modal.locator("select[data-aes-strategy-domain-filter]")).not.toHaveValue("all")
        await page.evaluate(async id => window.AESCommandRegistry.dispatch(id), genericCommand)
        await expect(modal.locator("[data-aes-strategy-menu='" + activeMenu + "']")).toHaveAttribute("data-active", "1")
        await expect(modal.locator("select[data-aes-strategy-domain-filter]")).toHaveValue("all")
    }
    expect(errors).toEqual([])
})

test("strategy action tiles execute backtest and slot CTA paths in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)
    await openHarness(page, base)

    await page.evaluate(async () => {
        window.__aesBacktestCalls = []
        window.AesStrategyBacktest.run = async opts => {
            window.__aesBacktestCalls.push(opts || {})
            return {
                perWeek: [{weekId: "wk-2"}, {weekId: "wk-1"}],
                actualCum: [1000, 2100],
                hypotheticalCum: [1250, 2850],
                cumulativeDelta: 750,
                summary: {
                    weeksWithData: 2,
                    actualTotal: 2100,
                    hypotheticalTotal: 2850,
                    weightSimilarity: 0.72,
                    notes: []
                }
            }
        }
        window.AesStrategy.snapshot = async () => ({
            server: "TEST",
            airlineCode: "AB",
            fleet: [{aircraftId: "A1", rangeKm: 5200}],
            hubs: [{
                iata: "ICN",
                byRoute: [
                    {dest: "HND", distanceKm: 1180, paxScore: 9, weeklyFlights: 21},
                    {dest: "NRT", distanceKm: 1210, paxScore: 8, weeklyFlights: 14}
                ]
            }],
            rivals: []
        })
        await window.AesSlotStore.saveAvailable("TEST", [{
            iata: "HND",
            slotId: "HND-AM-01",
            runwayClass: "A",
            weeklyOps: 14,
            minBid: 1250000,
            currentBid: 1400000,
            observedAt: Date.now()
        }])
    })

    await page.locator("[data-aes-strategy-menu-target='backtest']").click()
    const backtest = page.locator("#aes-central-hub-tile-strategy-backtest")
    await expect(backtest.locator(".aes-central-hub-tile__body")).toBeVisible()
    await backtest.getByRole("button", {name: /Run backtest/i}).click()
    await expect(backtest).toContainText("cumulative")
    await expect(backtest).toContainText("+$750")
    const backtestCalls = await page.evaluate(() => window.__aesBacktestCalls)
    expect(backtestCalls).toHaveLength(1)
    expect(backtestCalls[0]).toMatchObject({server: "TEST", airlineCode: "AB", weeks: 12})

    await page.locator("[data-aes-strategy-menu-target='slot-trading']").click()
    await page.keyboard.press("Escape")
    await expect(page.locator(".aes-strategy-modal")).toHaveCount(0)
    const slotTile = page.locator("#aes-central-hub-tile-strategy-slot-trading")
    await expect(slotTile.locator(".aes-central-hub-tile__body")).toBeVisible()
    await expect(slotTile).toContainText("HND")
    await slotTile.getByRole("button", {name: /Open strategy/i}).click()
    await expect(page.locator(".aes-strategy-modal")).toBeVisible()
    await expect(page.locator(".aes-strategy-modal select[data-aes-strategy-domain-filter]")).toHaveValue("slotBid")

    expect(errors).toEqual([])
})
