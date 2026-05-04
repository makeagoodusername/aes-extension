"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))

function schedulingBlock() {
    return manifest.content_scripts.find(block =>
        (block.matches || []).some(match => match.indexOf("/app/com/scheduling") !== -1))
}

console.log("=== Route Assistant scheduling manifest ===")

const block = schedulingBlock()
assert.ok(block, "scheduling content_scripts block exists")

const scripts = block.js || []
const agg = scripts.indexOf("modules/_shared/change-log-aggregator.js")
const modal = scripts.indexOf("modules/_shared/change-log-modal.js")
const panel = scripts.indexOf("modules/route-assistant/panel.js")

assert.ok(agg >= 0, "change-log aggregator loaded on scheduling pages")
assert.ok(modal >= 0, "change-log modal loaded on scheduling pages")
assert.ok(panel >= 0, "RouteAssistantPanel loaded on scheduling pages")
assert.ok(agg < modal, "aggregator loads before modal")
assert.ok(modal < panel, "modal loads before panel")

console.log("  ok  scheduling bundle includes change-log modal before panel")
console.log("\nRoute Assistant scheduling manifest: 1 passed, 0 failed")
