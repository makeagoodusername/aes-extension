"use strict"

const {defineConfig} = require("@playwright/test")

const harnessPort = process.env.AES_HARNESS_PORT || "8765"
const harnessBase = process.env.AES_HARNESS_BASE || `http://127.0.0.1:${harnessPort}`

module.exports = defineConfig({
    testMatch: [
        "**/*.spec.js",
        "**/*.spec.ts"
    ],
    webServer: {
        command: `node audit/scripts/static-harness-server.cjs ${harnessPort}`,
        url: `${harnessBase}/tools/dashboard-harness-t6.html`,
        reuseExistingServer: true,
        timeout: 10000
    }
})
