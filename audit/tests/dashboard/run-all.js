"use strict"

/**
 * Run all dashboard smoke tests in sequence.
 * Exit code 1 if any test fails.
 */
const {spawnSync} = require("child_process")
const fs = require("fs")
const path = require("path")

const here = __dirname
const files = fs.readdirSync(here)
    .filter(f => f.endsWith(".test.js"))
    .sort()

let totalPass = 0
let totalFail = 0
const failedFiles = []

for (const f of files) {
    const r = spawnSync(process.execPath, [path.join(here, f)], {stdio: "inherit"})
    if (r.status !== 0) failedFiles.push(f)
}

console.log("\n=== summary ===")
if (failedFiles.length) {
    console.log("FAILED files:")
    for (const f of failedFiles) console.log("  - " + f)
    process.exitCode = 1
} else {
    console.log("All " + files.length + " test files passed.")
}
