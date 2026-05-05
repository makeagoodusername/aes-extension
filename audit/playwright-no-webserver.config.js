"use strict"

const {defineConfig} = require("@playwright/test")

module.exports = defineConfig({
    testDir: "..",
    testMatch: [
        "**/*.spec.js",
        "**/*.spec.ts"
    ],
    reporter: "line"
})
