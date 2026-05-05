"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))

function dashboardBlock() {
    return manifest.content_scripts.find(block =>
        (block.matches || []).some(match => match.indexOf("/app/enterprise/dashboard") !== -1))
}

function flightNumbersBlock() {
    return manifest.content_scripts.find(block =>
        (block.matches || []).some(match => match.indexOf("/app/com/numbers") !== -1))
}

console.log("=== Route Assistant dashboard pricing manifest ===")

const block = dashboardBlock()
assert.ok(block, "dashboard content_scripts block exists")

const scripts = block.js || []
const derivator = scripts.indexOf("modules/route-assistant/demand-derivator.js")
const orsIntelligence = scripts.indexOf("modules/route-assistant/ors-intelligence.js")
const orsPriceIndex = scripts.indexOf("modules/route-assistant/ors-price-index.js")
const plumbing = scripts.indexOf("modules/route-assistant/pricing-plumbing.js")
const applier = scripts.indexOf("modules/route-assistant/pricing-applier.js")
const competitionAdjuster = scripts.indexOf("modules/route-assistant/ors-competition-adjuster.js")
const perClass = scripts.indexOf("modules/route-assistant/silent-auto-proposer-per-class.js")
const registry = scripts.indexOf("modules/route-assistant/silent-auto-proposers.js")
const competitionWeight = scripts.indexOf("modules/route-assistant/ors-competition-weight.js")
const automator = scripts.indexOf("modules/route-assistant/central-price-automator.js")

assert.ok(derivator >= 0, "demand derivator loaded on dashboard pages")
assert.ok(orsIntelligence >= 0, "ORS intelligence facade loaded on dashboard pages")
assert.ok(orsPriceIndex >= 0, "ORS price index loaded on dashboard pages")
assert.ok(plumbing >= 0, "pricing plumbing loaded on dashboard pages")
assert.ok(applier >= 0, "pricing applier loaded on dashboard pages")
assert.ok(competitionAdjuster >= 0, "ORS competition adjuster loaded on dashboard pages")
assert.ok(perClass >= 0, "per-class proposer loaded on dashboard pages")
assert.ok(registry >= 0, "silent-auto proposer registry loaded on dashboard pages")
assert.ok(competitionWeight >= 0, "ORS competition weight loaded on dashboard pages")
assert.ok(automator >= 0, "central price automator loaded on dashboard pages")
assert.ok(derivator < automator, "demand derivator loads before central price automator")
assert.ok(orsIntelligence < automator, "ORS intelligence loads before central price automator")
assert.ok(orsIntelligence < orsPriceIndex, "ORS intelligence loads before ORS price index")
assert.ok(orsPriceIndex < automator, "ORS price index loads before central price automator")
assert.ok(plumbing < applier, "pricing plumbing loads before pricing applier")
assert.ok(plumbing < automator, "pricing plumbing loads before central price automator")
assert.ok(competitionAdjuster < perClass, "ORS competition adjuster loads before per-class proposer")
assert.ok(perClass < registry, "per-class proposer loads before registry")
assert.ok(registry < automator, "registry loads before central price automator")
assert.ok(competitionWeight < automator, "ORS competition weight loads before central price automator")

console.log("  ok  dashboard bundle loads per-class pricing dependencies before automator")

const fnBlock = flightNumbersBlock()
assert.ok(fnBlock, "flight-number content_scripts block exists")
const fnScripts = fnBlock.js || []
const fnSettings = fnScripts.indexOf("modules/route-assistant/settings-store.js")
const fnPlumbing = fnScripts.indexOf("modules/route-assistant/pricing-plumbing.js")
const fnLog = fnScripts.indexOf("modules/route-assistant/pricing-apply-log.js")
const fnApplier = fnScripts.indexOf("modules/route-assistant/pricing-applier.js")
const fnAutopricer = fnScripts.indexOf("modules/route-assistant/per-leg-autopricer.js")

assert.ok(fnSettings >= 0, "Route Assistant settings store loaded on flight-number pages")
assert.ok(fnPlumbing >= 0, "pricing plumbing loaded on flight-number pages")
assert.ok(fnLog >= 0, "pricing apply log loaded on flight-number pages")
assert.ok(fnApplier >= 0, "pricing applier loaded on flight-number pages")
assert.ok(fnAutopricer >= 0, "per-leg autopricer loaded on flight-number pages")
assert.ok(fnSettings < fnAutopricer, "settings store loads before per-leg autopricer")
assert.ok(fnPlumbing < fnApplier, "pricing plumbing loads before pricing applier on flight-number pages")
assert.ok(fnLog < fnApplier, "pricing apply log loads before pricing applier on flight-number pages")
assert.ok(fnApplier < fnAutopricer, "pricing applier loads before per-leg autopricer")

console.log("  ok  flight-number bundle loads live pricing dependencies before per-leg autopricer")
console.log("\nRoute Assistant dashboard pricing manifest: 2 passed, 0 failed")
