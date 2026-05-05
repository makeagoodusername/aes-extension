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
const startPort = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222);
const cdpUrl = process.env.AES_CDP_URL || "";
const serverHost = process.env.AES_LIVE_SERVER || "free1.airlinesim.aero";
const loginEmail = process.env.AES_LOGIN_EMAIL || "";
const loginPassword = process.env.AES_LOGIN_PASSWORD || "";

async function findAvailablePort(start) {
  for (let port = start; port < start + 100; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available remote debugging port from ${start} to ${start + 99}`);
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(err => {
    if (!/ERR_ABORTED/.test(String(err))) throw err;
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function loginIfNeeded(page) {
  await goto(page, `https://${serverHost}/app/enterprise/dashboard`);
  await page.waitForTimeout(1000);
  const needsLogin = /\/auth\/login/i.test(page.url())
    || await page.locator("input[type='password']").count().catch(() => 0) > 0;
  if (!needsLogin) return false;
  if (!loginEmail || !loginPassword) {
    throw new Error("Live validation needs AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD, or a logged-in AES_TEST_PROFILE.");
  }

  await goto(page, "https://www.airlinesim.aero/auth/login");
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
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return true;
}

async function extensionWorld(ctx, page, navigation) {
  const cdp = await ctx.newCDPSession(page);
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ev => contexts.push(ev.context));
  await cdp.send("Runtime.enable");
  if (navigation) await navigation();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const ext = contexts.slice().reverse().find(c => c.name === "AirlineSim Enhancement Suite");
  if (!ext) throw new Error("AES extension isolated world was not created on " + page.url());
  return { cdp, contextId: ext.id };
}

async function evalExt(cdp, contextId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    contextId,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "extension evaluation failed");
  }
  return result.result.value;
}

async function main() {
  console.log(`[aes-price-e2e] server: ${serverHost}`);

  let browser = null;
  let ctx = null;
  let tmpProfile = "";
  if (cdpUrl) {
    console.log(`[aes-price-e2e] attaching to CDP: ${cdpUrl}`);
    browser = await chromium.connectOverCDP(cdpUrl);
    ctx = browser.contexts()[0];
    if (!ctx) throw new Error("Connected browser has no default context.");
  } else {
    const debugPort = await findAvailablePort(startPort);
    tmpProfile = process.env.AES_TEST_PROFILE
      ? ""
      : fs.mkdtempSync(path.join(os.tmpdir(), "aes-price-auto-profile-"));
    const profileDir = process.env.AES_TEST_PROFILE || tmpProfile;

    console.log(`[aes-price-e2e] remote debugging port: ${debugPort}`);
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        `--remote-debugging-port=${debugPort}`,
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  }
  const priceWritePosts = [];
  const ownedPages = [];
  const watchPricePosts = page => {
    page.on("request", request => {
      const method = String(request.method() || "").toUpperCase();
      if (method !== "POST") return;
      const url = request.url();
      if (!/airlinesim\.aero/i.test(url)) return;
      if (!/\/app\/com\/(?:markets|numbers|flightsPrices)|\/action\/enterprise\/flightsPrices/i.test(url)) return;
      priceWritePosts.push({ method, url });
    });
  };
  ctx.pages().forEach(watchPricePosts);
  ctx.on("page", watchPricePosts);

  try {
    const page = cdpUrl ? await ctx.newPage() : (ctx.pages()[0] || await ctx.newPage());
    if (cdpUrl) ownedPages.push(page);
    const loggedIn = await loginIfNeeded(page);

    const dashboardWorld = await extensionWorld(ctx, page, async () => {
      await goto(page, `https://${serverHost}/app/enterprise/dashboard`);
    });

    await page.locator(".aes-menu__trigger").first().waitFor({ state: "visible", timeout: 15000 });

    const dashboard = await evalExt(dashboardWorld.cdp, dashboardWorld.contextId, `(() => (async () => {
      const preview = await AesRoutePriceAutomator.preview({}, {forceDryRun: true, limit: 50, followMode: "all"});
      const tick = await AesRoutePriceAutomator.runTick({}, {forceDryRun: true, force: true, maxRoutes: 1, source: "qa-price-e2e"});
      return {
        href: location.href,
        hasAutomator: typeof AesRoutePriceAutomator,
        state: preview.state,
        counts: preview.counts,
        notices: preview.notices,
        tick
      };
    })())()`);

    const pricesPage = await ctx.newPage();
    ownedPages.push(pricesPage);
    const pricesWorld = await extensionWorld(ctx, pricesPage, async () => {
      await goto(pricesPage, `https://${serverHost}/action/enterprise/flightsPrices?adjust=true`);
    });
    const flightsPrices = await evalExt(pricesWorld.cdp, pricesWorld.contextId, `(() => ({
      href: location.href,
      hasScope: typeof RouteAssistantFlightsPricesScope,
      hasBridge: typeof RouteAssistantFlightsPricesBridge,
      hasPanel: typeof RouteAssistantFlightsPricesPanel,
      hostCount: document.querySelectorAll(".aes-fp-host").length,
      panelText: (document.querySelector(".aes-fp-host") || {}).innerText || ""
    }))()`);

    const listPage = await ctx.newPage();
    ownedPages.push(listPage);
    await goto(listPage, `https://${serverHost}/app/com/numbers`);
    await listPage.waitForFunction(() => {
      return Array.from(document.links || []).some(a => /\/app\/com\/numbers\/\d+/.test(a.href || ""));
    }, null, { timeout: 15000 }).catch(() => {});
    const detailHref = await listPage.evaluate(() => {
      const hrefs = Array.from(document.links || [])
        .map(a => {
          try { return new URL(a.getAttribute("href") || "", location.href).href; }
          catch (_) { return ""; }
        })
        .filter(h => /\/app\/com\/numbers\/\d+(?:$|[/?#])/.test(h));
      return hrefs[0] || "";
    });
    if (!detailHref) {
      const diag = await listPage.evaluate(() => ({
        href: location.href,
        title: document.title,
        numberHrefs: Array.from(document.links || [])
          .map(a => a.href || "")
          .filter(h => /\/app\/com\/numbers/.test(h))
          .slice(0, 20),
        body: (document.body && document.body.innerText || "").slice(0, 500),
      })).catch(() => ({}));
      throw new Error("No flight-number detail link found for per-leg autopricer validation: " + JSON.stringify(diag));
    }

    const detailWorld = await extensionWorld(ctx, listPage, async () => {
      await goto(listPage, detailHref);
    });
    const perLeg = await evalExt(detailWorld.cdp, detailWorld.contextId, `(() => (async () => {
      const run = await AesPerLegAutopricer.run({source: "qa-price-e2e", dryRun: true});
      return {
        href: location.href,
        hasPerLeg: typeof AesPerLegAutopricer,
        route: run.route,
        prices: run.prices,
        movedClasses: run.movedClasses,
        skipped: run.skipped,
        signalLabels: run.routeSignals && run.routeSignals.labels || [],
        bannerText: (document.querySelector(".aes-perleg-banner") || {}).innerText || ""
      };
    })())()`);

    const ok = dashboard.hasAutomator === "object"
      && dashboard.tick
      && dashboard.tick.dryRun === true
      && flightsPrices.hasScope === "object"
      && flightsPrices.hasBridge === "function"
      && flightsPrices.hasPanel === "function"
      && flightsPrices.hostCount > 0
      && perLeg.hasPerLeg === "object"
      && perLeg.route
      && perLeg.prices
      && Object.keys(perLeg.prices).length > 0
      && priceWritePosts.length === 0;

    console.log(JSON.stringify({ ok, loggedIn, priceWritePosts, dashboard, flightsPrices, perLeg }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    if (cdpUrl) {
      await Promise.all(ownedPages.map(page => page.close().catch(() => {})));
      if (browser && browser._connection && typeof browser._connection.close === "function") {
        browser._connection.close();
      }
    }
    if (!cdpUrl && ctx) await ctx.close().catch(() => {});
    if (tmpProfile) {
      fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

main().then(() => {
  if (cdpUrl) process.exit(process.exitCode || 0);
}).catch(err => {
  console.error("[aes-price-e2e] FAIL", err && err.stack || err);
  process.exit(1);
});
