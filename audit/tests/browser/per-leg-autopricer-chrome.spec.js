"use strict"

const {test, expect} = require("@playwright/test")

test.use({
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: {width: 1280, height: 900}
})

function numbersPage() {
    const row = (label, current, name) => [
        "<tr>",
        "<td>", label, "</td>",
        "<td>", current, "</td>",
        "<td><input type='text' name='", name, "' value='", current, "'></td>",
        "</tr>"
    ].join("")

    return [
        "<!doctype html><html><head><meta charset='utf-8'><title>Flight AB 101</title>",
        "<script>",
        "window.__store = {",
        "  'routeAssistantSettings': {pricing: {silentAutoMinDeltaPct: 1, silentAutoMaxStepPct: 30, apply: {classes: {}}}},",
        "  'routeAssistant:demand:NRT': {paxElasticity: -1, cargoElasticity: -0.5, rmTightnessByClass: {Y: 0.86, C: 0.42, F: 0.90, Cargo: 0.92}, demandPoolByClass: {Y: 600, C: 80, F: 24, Cargo: 5000}},",
        "  'routeAssistant:markets:competitors:ICN-NRT': {competitors: [",
        "    {classKey: 'Y', price: 250}, {serviceClass: 'Y', fare: 270},",
        "    {classKey: 'C', price: 170}, {serviceClass: 'C', price: 180},",
        "    {classKey: 'F', price: 760}, {serviceClass: 'F', price: 780},",
        "    {isCargo: true, price: 1.05}, {payloadClass: 'CARGO', fare: 1.15}",
        "  ]},",
        "  'routeAssistant:ors:ICN-NRT': {scrapedAt: Date.now(), byClass: {ECONOMY: {rankAny: 2, ratingGapToTop: 1}}}",
        "};",
        "window.chrome = {runtime: {lastError: null}, storage: {local: {get: function(keys, cb) {",
        "  var out = {};",
        "  if (keys == null) out = Object.assign({}, window.__store);",
        "  else if (typeof keys === 'string') { if (keys in window.__store) out[keys] = window.__store[keys]; }",
        "  else if (Array.isArray(keys)) keys.forEach(function(k){ if (k in window.__store) out[k] = window.__store[k]; });",
        "  else Object.keys(keys || {}).forEach(function(k){ out[k] = k in window.__store ? window.__store[k] : keys[k]; });",
        "  if (cb) setTimeout(function(){ cb(out); }, 0);",
        "  return Promise.resolve(out);",
        "}}}};",
        "</script>",
        "</head><body>",
        "<a href='/app/info/airports/ICN'>Seoul Incheon (ICN)</a>",
        "<a href='/app/info/airports/NRT'>Tokyo Narita (NRT)</a>",
        "<form><fieldset><legend>Pricing</legend><table><tbody>",
        row("Economy", "200", "classes:prices:0:newPrice"),
        row("Business", "220", "classes:prices:1:newPrice"),
        row("First", "700", "classes:prices:2:newPrice"),
        row("Cargo", "0.80", "classes:prices:3:newPrice"),
        "</tbody></table></fieldset></form>",
        "<script src='/modules/route-assistant/per-leg-autopricer.js'></script>",
        "</body></html>"
    ].join("")
}

test("per-leg autopricer renders and edits prices in Chrome", async ({page}) => {
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = []

    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => {
        if (msg.type() === "error") errors.push("console: " + msg.text())
    })
    page.on("response", resp => {
        if (resp.url().indexOf(base) === 0 && resp.status() >= 400) {
            errors.push("http " + resp.status() + ": " + resp.url())
        }
    })

    await page.route("**/app/com/numbers/123/0", async route => {
        await route.fulfill({status: 200, contentType: "text/html", body: numbersPage()})
    })

    await page.goto(base + "/app/com/numbers/123/0", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() => !!window.AesPerLegAutopricer)
    await expect(page.locator(".aes-perleg-banner")).toContainText("AES per-class autopricer")
    await expect(page.locator(".aes-perleg-suggest")).toHaveCount(4)
    await expect(page.locator(".aes-perleg-suggest[data-state='skip']")).toHaveCount(0)

    const before = await page.locator("fieldset input[type='text']").evaluateAll(inputs =>
        inputs.map(i => i.value)
    )
    await page.locator(".aes-perleg-apply-all").click()
    const afterApply = await page.locator("fieldset input[type='text']").evaluateAll(inputs =>
        inputs.map(i => i.value)
    )
    expect(afterApply).not.toEqual(before)
    expect(afterApply[0]).not.toBe("200")
    expect(afterApply[3]).not.toBe("0.80")

    await page.locator(".aes-perleg-restore").click()
    const afterRestore = await page.locator("fieldset input[type='text']").evaluateAll(inputs =>
        inputs.map(i => i.value)
    )
    expect(afterRestore).toEqual(before)
    expect(errors).toEqual([])
})
