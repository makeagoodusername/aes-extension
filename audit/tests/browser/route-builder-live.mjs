import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import path from "node:path"

const require = createRequire("/tmp/aes-pw/package.json")
const { chromium } = require("@playwright/test")

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const profileDir = process.env.AES_ROUTE_BUILDER_PROFILE || "/tmp/aes-routebuilder-playwright"
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const server = creds.server || "free1.airlinesim.aero"
const targetAircraft = process.env.AES_TEST_AIRCRAFT_ID || "22092"
const targetEnterprise = process.env.AES_TEST_ENTERPRISE_ID || "775"
const applyBatchSource = await readFile(
    path.join(repoRoot, "modules", "aircraft-flight-plan", "auto-scheduler", "apply-batch.js"),
    "utf8",
)

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1440, height: 1000 },
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
    ],
})

try {
    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(45000)
    await loginIfNeeded(page)
    await page.goto(`https://${server}/app/enterprise/dashboard?select=${encodeURIComponent(targetEnterprise)}`, {
        waitUntil: "domcontentloaded",
    })
    await page.waitForLoadState("networkidle").catch(() => {})

    await page.goto(`https://${server}/app/fleets/aircraft/${targetAircraft}/0`, {
        waitUntil: "domcontentloaded",
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector("h3:text('AES Route Builder')", { timeout: 30000 })
    await page.waitForSelector("[data-aes-afp-slot='studio']", { timeout: 30000 })

    const snapshot = await page.evaluate(() => {
        const routeBuilder = document.querySelector("[data-aes-afp-wide-host]")
        const studio = document.querySelector("[data-aes-afp-slot='studio']")
        const buttonRows = Array.from(document.querySelectorAll("button")).map((button, index) => ({
            index,
            text: (button.innerText || button.textContent || "").trim(),
            disabled: button.disabled,
            title: button.title || "",
        }))
        const studioInputs = Array.from(studio ? studio.querySelectorAll("input, select, textarea") : [])
            .map((field, index) => ({
                index,
                tag: field.tagName.toLowerCase(),
                type: field.type || "",
                value: field.value || "",
                placeholder: field.getAttribute("placeholder") || "",
                title: field.getAttribute("title") || "",
            }))
        return {
            url: location.href,
            title: document.title,
            wideText: routeBuilder ? routeBuilder.innerText.slice(0, 3000) : "",
            studioText: studio ? studio.innerText.slice(0, 2000) : "",
            studioInputs,
            routeButtons: buttonRows.filter((button) =>
                /auto|apply|build|route|flight|schedule|preview/i.test(button.text + " " + button.title)),
        }
    })
    snapshot.hasFlightStudioGateBypass = applyBatchSource.includes("_isFlightStudioSource")
        && applyBatchSource.includes("isFlightStudio")

    console.log(JSON.stringify({ kind: "route-builder-snapshot", snapshot }, null, 2))

    const routeBuilderText = snapshot.wideText || ""
    if (!/Flight Studio/.test(routeBuilderText)) {
        throw new Error("Flight Studio did not render in AES Route Builder")
    }
    if (!snapshot.routeButtons.some((button) => /Create flights/i.test(button.text))) {
        throw new Error("Flight Studio Create flights button did not render")
    }
    if (/\[object HTML/i.test(routeBuilderText + "\n" + (snapshot.studioText || ""))) {
        throw new Error("Route Builder rendered a DOM node as text")
    }
    if (!snapshot.hasFlightStudioGateBypass) {
        throw new Error("apply-batch source lacks Flight Studio gate bypass")
    }
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}

async function loginIfNeeded(page) {
    await page.goto(`https://${server}/app/enterprise/dashboard`, { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    if (!/\/auth\/login/.test(page.url()) && !/airlinesim\.aero\/auth\/login/.test(page.url())) {
        return
    }
    await page.goto("https://www.airlinesim.aero/auth/login", { waitUntil: "domcontentloaded" })
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']",
    ].join(", ")).first()
    await loginInput.fill(creds.email)
    await page.locator("input[type='password']").first().fill(creds.password)
    await Promise.all([
        page.waitForURL((url) => !/\/auth\/login/.test(url.pathname), { timeout: 60000 }),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click(),
    ])
}
