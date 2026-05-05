"use strict"

const {defineConfig} = require("@playwright/test")

module.exports = defineConfig({
    testMatch: [
        "**/*.spec.js",
        "**/*.spec.ts"
    ],
    webServer: {
        command: "node audit/scripts/static-harness-server.cjs 8765",
        url: "http://127.0.0.1:8765/tools/dashboard-harness-t6.html",
        reuseExistingServer: true,
        timeout: 10000
    }
})
