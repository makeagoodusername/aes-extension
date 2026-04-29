// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

/**
 * AES service-worker entry — thin shim that loads focused background
 * modules via importScripts(). The pre-split monolith was 1 272 LOC;
 * each concern now lives in modules/_background/<name>.js with its own
 * docstring. See HANDOVER §"background.js split" for the writeup.
 *
 * Load order matters where a later module references a global declared
 * by an earlier one. Documented per import below. All importScripts
 * calls are wrapped in try/catch so a single missing or broken module
 * can't kill the SW boot — broken modules degrade their feature only.
 *
 * The onInstalled listener at the bottom bootstraps two unrelated
 * concerns (legacy defaults blob + the AS-host declarativeContent page
 * action) — keeping it in the entry rather than splitting across both
 * modules avoids cross-module install-order coupling.
 */

// Provides globalThis.ScrapeTabPool — used by scrape-routing.js below.
try { importScripts('modules/scrape-orchestrator/background-tab-pool.js'); }
catch (e) { console.warn('[bg] failed to import scrape-orchestrator tab pool', e); }

// Provides globalThis.AesCleanup — used by alarms.js below. Tab content
// scripts also load this module (for tab-idle sweeps); the SW gets it
// for the chrome.alarms periodic sweep.
try { importScripts('modules/_shared/cleanup-registry.js'); }
catch (e) { console.warn('[bg] failed to import cleanup-registry', e); }

// Defines setDefaultSettings() — called from the onInstalled listener
// at the bottom of this file.
try { importScripts('modules/_background/legacy-defaults.js'); }
catch (e) { console.warn('[bg] failed to import legacy-defaults', e); }

// Registers chrome.alarms: aes-cleanup (6h sweep via AesCleanup.runAll)
// and aes-auto-drive (5min nudge to dashboard tab). Depends on AesCleanup.
try { importScripts('modules/_background/alarms.js'); }
catch (e) { console.warn('[bg] failed to import alarms', e); }

// AFP background-tab submit pipelines (single submit, apply-batch,
// delete-batch). Independent of other modules.
try { importScripts('modules/_background/afp-submit-queue.js'); }
catch (e) { console.warn('[bg] failed to import afp-submit-queue', e); }

// Q16 long-op notification bridge. Independent.
try { importScripts('modules/_background/notifications.js'); }
catch (e) { console.warn('[bg] failed to import notifications', e); }

// L1 single-writer for aesAccounts blob + L2.2 migration setters.
// Independent.
try { importScripts('modules/_background/account-registry.js'); }
catch (e) { console.warn('[bg] failed to import account-registry', e); }

// Single-writer for the customization blob. Independent.
try { importScripts('modules/_background/customization-store.js'); }
catch (e) { console.warn('[bg] failed to import customization-store', e); }

// Forwards aes:scrape-all:* messages to globalThis.ScrapeTabPool.
// Depends on the scrape-orchestrator import above.
try { importScripts('modules/_background/scrape-routing.js'); }
catch (e) { console.warn('[bg] failed to import scrape-routing', e); }

// Auto-Pricing Tier 3.3b alarm heartbeat. Registers its own onInstalled
// + onStartup + storage.onChanged listeners.
try { importScripts('modules/_background/silent-auto-alarm.js'); }
catch (e) { console.warn('[bg] failed to import silent-auto-alarm', e); }

// Command Bridge open/focus dedup. Independent.
try { importScripts('modules/_background/bridge-tab.js'); }
catch (e) { console.warn('[bg] failed to import bridge-tab', e); }

// chrome.tabs.captureVisibleTab bridge. Independent.
try { importScripts('modules/_background/vision-capture.js'); }
catch (e) { console.warn('[bg] failed to import vision-capture', e); }

// On install: bootstrap the legacy `settings` blob (idempotent — only
// writes if the key is missing) and (re)register the declarativeContent
// page-action rule that lights up the extension icon on AS pages.
chrome.runtime.onInstalled.addListener(() => {
  if (typeof setDefaultSettings === 'function') setDefaultSettings();
  if (chrome.declarativeContent && chrome.declarativeContent.onPageChanged) {
    chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
      chrome.declarativeContent.onPageChanged.addRules([{
        conditions: [new chrome.declarativeContent.PageStateMatcher({
          pageUrl: { hostContains: '.airlinesim.aero' }
        })],
        actions: [new chrome.declarativeContent.ShowAction()]
      }]);
    });
  }
});
