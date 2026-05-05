"use strict"

const fs = require("fs")
const path = require("path")
const {loadModule, it, summary, assert, ROOT} = require("./_helpers")

function evalIntoWindow(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
    return global.window
}

;(async function main() {
    await it("fork commands are discoverable from fleet-scoped command palette", async () => {
        const win = loadModule("modules/command-palette/registry.js", {})
        Object.assign(win, {
            AesStrategy: {snapshot: async () => ({rev: "r1"})},
            AesStrategyForkStore: {list: async () => []},
            AesStrategySnapshotFork: {forkSnapshot: () => ({forkId: "f1"})},
            AesStrategyForwardSimulator: {simulateForward: async () => ({ok: true})}
        })

        evalIntoWindow("modules/command-palette/derivers/fork-deriver.js")

        const ids = win.AESCommandRegistry
            .list({scope: "fleets", query: "fork"})
            .map(cmd => cmd.id)

        assert.ok(ids.includes("strategy.fork.create"))
        assert.ok(ids.includes("strategy.fork.simulate4"))
        assert.ok(ids.includes("strategy.fork.simulate12"))
    })

    summary("fork-command-deriver")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
