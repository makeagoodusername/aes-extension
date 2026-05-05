"use strict"

/**
 * Route Builder manifest wiring regression.
 *
 * The dashboard tile is an actual user entry point only if the standalone
 * modal, planner, apply bridge, and tile are all loaded on
 * /app/enterprise/dashboard*. Loading the tile manually in a unit test is not
 * enough: MV3 content scripts only expose files listed in manifest.json.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))

function blockFor(match) {
    return (manifest.content_scripts || []).find(block =>
        Array.isArray(block.matches) && block.matches.includes(match))
}

const dashboard = blockFor("https://*.airlinesim.aero/app/enterprise/dashboard*")
assert.ok(dashboard, "dashboard content-script block is missing")

const js = dashboard.js || []
const required = [
    "modules/aircraft-flight-plan/settings-extension.js",
    "modules/aircraft-flight-plan/auto-scheduler/route-builder-planner.js",
    "modules/aircraft-flight-plan/auto-scheduler/apply-batch.js",
    "modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js",
    "modules/central-hub/tiles/route-builder-tile.js"
]

for (const file of required) {
    assert.ok(js.includes(file), "dashboard block does not load " + file)
}

assert.ok(
    js.indexOf("modules/aircraft-flight-plan/auto-scheduler/route-builder-planner.js")
        < js.indexOf("modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js"),
    "planner must load before route-builder-modal"
)
assert.ok(
    js.indexOf("modules/aircraft-flight-plan/settings-extension.js")
        < js.indexOf("modules/aircraft-flight-plan/auto-scheduler/apply-batch.js"),
    "AesAfpSettings must load before apply-batch so the Route Builder apply gate is enforced"
)
assert.ok(
    js.indexOf("modules/aircraft-flight-plan/auto-scheduler/apply-batch.js")
        < js.indexOf("modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js"),
    "apply-batch must load before route-builder-modal so Apply schedule is enabled when gated"
)
assert.ok(
    js.indexOf("modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js")
        < js.indexOf("modules/central-hub/tiles/route-builder-tile.js"),
    "route-builder-modal must load before route-builder-tile"
)
assert.ok(
    js.indexOf("modules/central-hub/tiles/route-builder-tile.js")
        < js.indexOf("modules/central-hub/shell.js"),
    "route-builder-tile must register before central-hub shell renders tiles"
)

console.log("route-builder-manifest: passed")
