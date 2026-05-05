#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionPath = repoRoot;
const mockMode = process.env.AES_TEST_LIVE !== "1";
const startPort = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222);
const targetUrl = process.env.AES_TEST_URL
  || "https://free1.airlinesim.aero/app/finance/accounting?aes-fixture=1";
const dashboardUrl = "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1";
const loginEmail = process.env.AES_LOGIN_EMAIL || "";
const loginPassword = process.env.AES_LOGIN_PASSWORD || "";

async function findAvailablePort(start) {
  for (let port = start; port < start + 50; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available remote debugging port from ${start} to ${start + 49}`);
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function installMockAirlineSimRoutes(ctx) {
  await ctx.route("https://free1.airlinesim.aero/app/finance/accounting**", route => {
    route.fulfill({ status: 200, contentType: "text/html", body: pageShell(`
      <main id="main-content">
        <section class="as-panel">
          <h1>Accounting</h1>
          <table><tbody><tr><td>Cash</td><td>1234567</td></tr></tbody></table>
        </section>
      </main>`) });
  });
  await ctx.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
    route.fulfill({ status: 200, contentType: "text/html", body: pageShell(`
      <main id="main-content">
        <section class="facts">
          <table>
            <tr><td>Airline</td><td>Casper Flight Logistics</td></tr>
            <tr><td>Code</td><td>CFL</td></tr>
            <tr><td>Company reputation</td><td>92</td></tr>
          </table>
        </section>
        <section id="enterprise-dashboard" class="as-page-dashboard">
          <h1>Enterprise Dashboard</h1>
        </section>
      </main>`) });
  });
}

function pageShell(body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AirlineSim Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    .as-navbar-main { background: #233044; color: #fff; padding: 8px 12px; }
    .as-navbar-main a { color: inherit; text-decoration: none; }
    #as-navbar-main-collapse .navbar-nav { display: flex; gap: 12px; list-style: none; margin: 0; padding: 8px 12px; background: #f5f5f5; }
    #as-navbar-main-collapse a { color: #1b2733; text-decoration: none; }
    .as-navbar-bottom { padding: 6px 12px; border-bottom: 1px solid #ddd; }
    main { padding: 16px; }
    .facts table { border-collapse: collapse; }
    .facts td { border: 1px solid #ddd; padding: 4px 8px; }
  </style>
</head>
<body>
  <div class="as-navbar-main">
    <a class="name" href="/app/enterprise/dashboard"><span>Casper Flight Logistics</span><span class="caret"></span></a>
  </div>
  <nav id="as-navbar-main-collapse">
    <ul class="navbar-nav">
      <li><a href="/app/enterprise/dashboard">Dashboard</a></li>
      <li><a href="/app/fleets">Fleets</a></li>
      <li><a href="/app/com/scheduling/ICN">Scheduling</a></li>
      <li><a href="/app/com/numbers">Flight numbers</a></li>
      <li><a href="/app/enterprise/settings">Settings</a></li>
    </ul>
  </nav>
  <div class="as-navbar-bottom"><span>2026-05-05 12:34 UTC</span></div>
  ${body}
</body>
</html>`;
}

async function assertVisible(page, selector, label, timeout = 10000) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout });
  return loc;
}

async function closeExtensionObstructions(page) {
  await page.evaluate(() => {
    if (window.AESCommandPalette && typeof window.AESCommandPalette.close === "function") {
      window.AESCommandPalette.close();
    }
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  const closeButtons = [
    "#aes-release-notes-dialog .aes-modal__close",
    "#aes-release-notes-dialog button:has-text('Got it')",
    ".modal.in .aes-modal__close",
    ".modal.show .aes-modal__close",
  ];
  for (const selector of closeButtons) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ force: true }).catch(() => {});
    }
  }

  await page.waitForSelector("#aes-command-palette.open", { state: "hidden", timeout: 3000 }).catch(() => {});
  await page.waitForSelector("#aes-release-notes-dialog", { state: "hidden", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
}

async function loginIfNeeded(page) {
  if (mockMode) return false;

  await settleNavigation(page);

  const needsLogin = /\/auth\/login/i.test(page.url())
    || await page.locator("input[type='password']").count().catch(() => 0) > 0;
  if (!needsLogin) return false;

  if (!loginEmail || !loginPassword) {
    throw new Error("Live mode reached AirlineSim login. Provide AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD, or use a logged-in AES_TEST_PROFILE.");
  }

  await page.goto("https://www.airlinesim.aero/auth/login", { waitUntil: "domcontentloaded" });
  const loginInput = page.locator([
    "input[name='login']",
    "input[type='email']",
    "input[name*='email']",
    "input[name*='username']",
    "input[type='text']",
  ].join(", ")).first();
  await loginInput.fill(loginEmail);
  await page.locator("input[type='password']").first().fill(loginPassword);

  await Promise.all([
    page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), { timeout: 60000 }),
    page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click(),
  ]);

  return true;
}

async function settleNavigation(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function main() {
  const debugPort = await findAvailablePort(startPort);
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "aes-cross-page-profile-"));
  const profileDir = process.env.AES_TEST_PROFILE || tmpProfile;

  console.log(`[aes-e2e] remote debugging port: ${debugPort}`);
  console.log(`[aes-e2e] mode: ${mockMode ? "mock AirlineSim fixture" : "live AirlineSim page"}`);
  console.log(`[aes-e2e] url: ${targetUrl}`);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--remote-debugging-port=${debugPort}`,
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ],
  });

  try {
    if (mockMode) await installMockAirlineSimRoutes(ctx);

    const page = await ctx.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    const loggedIn = await loginIfNeeded(page);
    if (loggedIn) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await settleNavigation(page);
    }

    if (!/airlinesim\.aero\/app\//.test(page.url())) {
      throw new Error(`Not on an AirlineSim app page after navigation: ${page.url()}. For live mode, use a logged-in AES_TEST_PROFILE.`);
    }

    await assertVisible(page, ".aes-menu__trigger", "AES menu trigger");
    await closeExtensionObstructions(page);

    const modKey = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modKey}+K`);
    await assertVisible(page, "#aes-command-palette.open", "palette from keyboard");
    await assertVisible(page, "#aes-command-palette-input", "palette input");
    await closeExtensionObstructions(page);

    await page.locator(".aes-menu__trigger").first().click();
    await assertVisible(page, ".aes-menu__panel", "AES menu panel");
    await page.locator(".aes-menu__panel a", { hasText: "Open command palette" }).first().click();
    await assertVisible(page, "#aes-command-palette.open", "palette from AES menu");

    await page.locator("#aes-command-palette-input").fill("go to dashboard");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/app\/enterprise\/dashboard(?:[?#].*)?$/, { timeout: 10000 });

    if (mockMode) {
      await assertVisible(page, "#aes-central-hub", "Central Hub after dispatch");
    }

    console.log("[aes-e2e] PASS cross-page command palette opened and dispatched");
  } finally {
    await ctx.close().catch(() => {});
    if (!process.env.AES_TEST_PROFILE) {
      fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

main().catch(err => {
  console.error("[aes-e2e] FAIL", err && err.stack || err);
  process.exit(1);
});
