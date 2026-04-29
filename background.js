// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

// Scrape orchestrator service-worker module (registers globalThis.ScrapeTabPool).
try { importScripts('modules/scrape-orchestrator/background-tab-pool.js'); }
catch (e) { console.warn('[bg] failed to import scrape-orchestrator tab pool', e); }

// Slice-1 Foundation — cache cleanup registry. Tab content_scripts also load
// this file (for tab-idle sweeps); the SW gets it for the chrome.alarms
// periodic sweep registered below.
try { importScripts('modules/_shared/cleanup-registry.js'); }
catch (e) { console.warn('[bg] failed to import cleanup-registry', e); }

const _AES_CLEANUP_ALARM = 'aes-cleanup';
const _AES_AUTO_DRIVE_ALARM = 'aes-auto-drive';
if (chrome.alarms) {
  // Idempotent — chrome.alarms.create overwrites by name. 6h cadence matches
  // the ~6h fuel-price freshness window (the most aggressively-pruned slice).
  // Stores with longer TTLs (30d demand, 90d price-history) tolerate this fine.
  chrome.alarms.create(_AES_CLEANUP_ALARM, {periodInMinutes: 360});
  // Auto-drive ticker — every 5 minutes. The content-side driver does the
  // staleness math + min-gap throttle; this alarm just nudges any open AS
  // tab to consider running its most-overdue phase.
  chrome.alarms.create(_AES_AUTO_DRIVE_ALARM, {periodInMinutes: 5});
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === _AES_CLEANUP_ALARM) {
      if (typeof AesCleanup === 'undefined' || !AesCleanup.runAll) return;
      AesCleanup.runAll({reason: 'alarm'}).catch((err) =>
        console.warn('[AES cleanup] alarm runAll failed', err));
      return;
    }
    if (alarm.name === _AES_AUTO_DRIVE_ALARM) {
      try {
        chrome.tabs.query({url: 'https://*.airlinesim.aero/*'}, (tabs) => {
          if (chrome.runtime.lastError || !tabs || !tabs.length) return;
          const target = tabs.find(t => /\/app\/enterprise\/dashboard/.test(t.url || ''))
            || tabs[0];
          if (!target || target.id == null) return;
          try {
            chrome.tabs.sendMessage(target.id, {type: 'aes:auto-drive:tick'}, () => {
              void chrome.runtime.lastError;
            });
          } catch (_) { /* noop */ }
        });
      } catch (_) { /* noop */ }
      return;
    }
  });
}

//Functions
function setDefaultSettings(){
  //Add default settings

  let aesSettings = {
    invPricing:setDefaultInvPricingSettings(),
    general:setDefaultGeneralSettings(),
    schedule:setDefaultScheduleSettings(),
    stationAutomation:setDefaultStationAutomationSettings(),
    usedAircraftScanner:setDefaultUsedAircraftScannerSettings()
  };
  chrome.storage.local.get(['settings'], function(result) {
    let settings = result.settings;
    if(!settings){
      settings = aesSettings;
      chrome.storage.local.set({settings: aesSettings}, function() {
        
      });
    }
  });
  //
}

function setDefaultScheduleSettings(){
  //auto settings
  let schedule = {
    autoExtract:0
  };
  //Cmp setttings
  return schedule;
}
function setDefaultStationAutomationSettings(){
  // Thresholds offered in the demand dropdowns (0 = ignore)
  let thresholds = [0, 1000, 5000, 10000, 50000, 100000, 500000, 1000000];
  let stationAutomation = {
    defaultPaxThreshold: 0,
    defaultCargoThreshold: 0,
    thresholds: thresholds,
    countriesCache: {}
  };
  return stationAutomation;
}
function setDefaultUsedAircraftScannerSettings(){
  // Used Aircraft Scanner — sub-dashboard that walks the AS used aircraft
  // market across many types in parallel and aggregates the offers.
  return {
    presets: [],
    typeFamilyOverrides: {},
    concurrency: 6,
    staggerMs: 2000,
    lastScanId: null
  };
}
function setDefaultGeneralSettings(){
  //auto settings
  let general = {
    defaultDashboard:'general'
  };
  //Cmp setttings
  return general;
}
function setDefaultInvPricingSettings(){
  //auto settings
  let invPricing = {
    autoAnalysisSave:1,
    autoPriceUpdate:0,
    autoClose:0,
    recommendation:{},
    historyTable:{
      showNow:1,
      showOnlyPricing:0,
      numberOfDates:"5"
    }
  };
  //Cmp setttings
  let steps = [
    {
      min:0,
      max:40,
      name:'Drop High',
      step:-8
    },
    {
      min:40,
      max:60,
      name:'Drop Medium',
      step: -4
    },
    {
      min:60,
      max:70,
      name:'Drop Low',
      step: -2
    },
    {
      min:70,
      max:80,
      name:'Keep',
      step: 0
    },
    {
      min:80,
      max:90,
      name:'Raise Low',
      step: 1
    },
    {
      min:90,
      max:99,
      name:'Raise Medium',
      step: 2
    },
    {
      min:99,
      max:100,
      name:'Raise High',
      step: 5
    }
  ];
  let cmps = ['Y','C','F','Cargo'];
  cmps.forEach(function(cmp){
    invPricing.recommendation[cmp] = {
      maxPrice:200,
      minPrice:60,
      steps:steps
    };
  });
  return invPricing;
}


//MAIN

chrome.runtime.onInstalled.addListener(function() {
  setDefaultSettings();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, function() {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({
        pageUrl: {hostContains: '.airlinesim.aero'},
      })],
      actions: [new chrome.declarativeContent.ShowAction()]
    }]);
  });
});

// ── AFP background-tab submit pipeline ─────────────────────────────────
//
// The Fleet Hub overlay (modules/fleet-hub/schedule-overlay.js) on the
// fleet list page can't fill or POST AS's New Flight Number form — that
// form only lives on /app/fleets/aircraft/<id>/0. When the user clicks
// Apply on a leg in the overlay, this handler:
//   1. Opens that aircraft's flight plan page in a hidden tab.
//   2. Waits for status === "complete" (initial load done).
//   3. Sends `aes:afp:fill-and-submit` with the leg payload — the AFP
//      content script calls AesAfpFormDriver.fillAndSubmit(leg).
//   4. fillAndSubmit replies {ok:true, posting:true} synchronously, then
//      clicks Submit on a microtask. AS POSTs and reloads the page.
//   5. We wait for ANOTHER status === "complete" on that same tab to
//      confirm the post landed, then close the tab.
//   6. Reply success/error to the original overlay caller.
//
// Per-aircraft serialisation: rapid-fire Apply clicks queue up so we
// never have two background tabs racing the same Wicket session for
// one aircraft.
//
// This is the SOLE entry point in the codebase that triggers AS form
// submission programmatically. Documented in form-driver.js header.

const AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS = 60000;
const AFP_SUBMIT_POST_LOAD_TIMEOUT_MS    = 30000;
const AFP_SUBMIT_FILL_TIMEOUT_MS         = 15000;

// ── AFP Apply-all batch pipeline (Track 5 slice 5c) ────────────────────
//
// Reuses the per-aircraft submit queue so a batch can't race a single-leg
// Apply on the same aircraft. The batch opens ONE hidden tab, iterates
// through req.legs, sends 'aes:afp:fill-and-submit' per leg, waits for
// the AS reload between legs, broadcasts progress, and closes the tab on
// completion / abort.
//
// Per-leg timeouts mirror the single-leg path (30s fill, 30s reload).
// Total batch wall-clock is capped at 20 minutes; aborted batches close
// the hidden tab cleanly so the next queued submit can run.
const AFP_BATCH_FILL_TIMEOUT_MS      = 30000;     // per-leg fill (was 15s for single — bumped to give wave-applier time)
const AFP_BATCH_RELOAD_TIMEOUT_MS    = 30000;     // per-leg reload after submit
const AFP_BATCH_INTER_LEG_DELAY_MS   = 500;       // AS rate-limits Wicket form posts
const AFP_BATCH_TOTAL_TIMEOUT_MS     = 20 * 60 * 1000;   // 20 minutes hard cap

const _afpSubmitQueues = new Map();   // aircraftId → Promise (tail of the queue)
const _afpBatchState   = new Map();   // batchId    → {tabId, abort, senderTabId, aircraftId}

function _afpAircraftPath(aircraftId) {
  return '/app/fleets/aircraft/' + String(aircraftId) + '/0';
}

function _afpHostFromSender(sender) {
  try {
    if (sender && sender.tab && sender.tab.url) {
      const u = new URL(sender.tab.url);
      return u.protocol + '//' + u.host;
    }
  } catch (_) { /* fall through */ }
  return 'https://free1.airlinesim.aero';   // pragmatic default
}

function _waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) { /* noop */ }
      try { chrome.tabs.onRemoved.removeListener(removed); } catch (_) { /* noop */ }
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const listener = (updatedId, changeInfo) => {
      if (updatedId !== tabId) return;
      if (changeInfo && changeInfo.status === 'complete') finish(null);
    };
    const removed = (closedId) => {
      if (closedId === tabId) finish(new Error('tab closed before load completed'));
    };
    const timer = setTimeout(() => finish(new Error('tab load timeout')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
  });
}

function _sendTabMessageWithTimeout(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('content-script reply timeout'));
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        if (settled) return;
        const lastErr = chrome.runtime.lastError;
        clearTimeout(timer);
        settled = true;
        if (lastErr) {
          reject(new Error(lastErr.message || 'sendMessage failed'));
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

async function _afpRunSubmit(req, sender) {
  const host = _afpHostFromSender(sender);
  const url = host + _afpAircraftPath(req.aircraftId);
  let tab = null;
  try {
    tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({url, active: false}, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
        else resolve(t);
      });
    });
    await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);

    const fillResp = await _sendTabMessageWithTimeout(
      tab.id,
      {type: 'aes:afp:fill-and-submit', leg: req.leg},
      AFP_SUBMIT_FILL_TIMEOUT_MS
    );

    if (!fillResp || !fillResp.ok) {
      const err = (fillResp && fillResp.error) || 'fill-and-submit returned no/non-ok response';
      return {ok: false, error: err};
    }

    if (fillResp.posting) {
      // Form submission triggers a Wicket POST + reload. Wait for the
      // tab to finish reloading before we close it — closing too early
      // could abort the POST.
      try {
        await _waitForTabComplete(tab.id, AFP_SUBMIT_POST_LOAD_TIMEOUT_MS);
      } catch (e) {
        return {ok: false, error: 'post-submit reload did not complete: ' + e.message};
      }
    }

    return {ok: true};
  } catch (e) {
    return {ok: false, error: (e && e.message) || String(e)};
  } finally {
    if (tab && tab.id != null) {
      try { chrome.tabs.remove(tab.id); } catch (_) { /* noop */ }
    }
  }
}

function _afpEnqueueSubmit(req, sender) {
  const key = String(req.aircraftId);
  const tail = _afpSubmitQueues.get(key) || Promise.resolve();
  const next = tail.catch(() => null).then(() => _afpRunSubmit(req, sender));
  _afpSubmitQueues.set(key, next);
  // Garbage-collect the queue entry once it settles, so we don't hold
  // references forever.
  next.finally(() => {
    if (_afpSubmitQueues.get(key) === next) _afpSubmitQueues.delete(key);
  });
  return next;
}

// ── Apply-all batch pipeline (Track 5 slice 5c) ────────────────────────

function _afpNewBatchId() {
  return 'batch-' + Date.now().toString(36)
    + '-' + Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0');
}

/**
 * Broadcast a progress message back to the originating tab so a content-side
 * orchestrator (apply-batch.js, flight-deleter.js, ...) can update the live
 * progress UI. Falls back to runtime.sendMessage when sender.tab.id isn't
 * known (e.g., the request came from the popup or a service worker call).
 *
 * `type` is the chrome.runtime message type (e.g.
 * 'aes:afp:apply-batch:progress' or 'aes:afp:delete-batch:progress'); the
 * receiving content script filters on it.
 */
function _afpBroadcastProgress(senderTabId, type, payload) {
  const msg = Object.assign({type}, payload);
  if (senderTabId != null) {
    try {
      chrome.tabs.sendMessage(senderTabId, msg, () => {
        // Swallow lastError — a closed/navigated origin tab is OK; the
        // batch still completes in its own hidden tab.
        void chrome.runtime.lastError;
      });
    } catch (_) { /* noop */ }
    return;
  }
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); }
  catch (_) { /* noop */ }
}

async function _afpRunBatchSubmit(req, sender) {
  const batchId = req.batchId || _afpNewBatchId();
  const senderTabId = (sender && sender.tab && sender.tab.id != null)
    ? sender.tab.id : null;
  const legs  = Array.isArray(req.legs) ? req.legs : [];
  const total = legs.length;
  const host = _afpHostFromSender(sender);
  const url = host + _afpAircraftPath(req.aircraftId);
  const totalDeadline = Date.now() + AFP_BATCH_TOTAL_TIMEOUT_MS;
  const results = [];

  const progress = (extra) => _afpBroadcastProgress(
    senderTabId,
    'aes:afp:apply-batch:progress',
    Object.assign({batchId, aircraftId: req.aircraftId, total}, extra)
  );

  if (!total) {
    progress({phase: 'done', ok: true, results: [], emptyBatch: true});
    return {ok: true, batchId, results: [], total: 0};
  }

  const stateEntry = {tabId: null, abort: false, senderTabId, aircraftId: req.aircraftId};
  _afpBatchState.set(batchId, stateEntry);
  progress({phase: 'queued'});

  let tab = null;
  try {
    tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({url, active: false}, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
        else resolve(t);
      });
    });
    stateEntry.tabId = tab.id;
    progress({phase: 'tab-opened', tabId: tab.id});

    await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);
    progress({phase: 'tab-loaded'});

    for (let i = 0; i < total; i++) {
      const cur = _afpBatchState.get(batchId);
      if (!cur || cur.abort) {
        progress({phase: 'aborted', legIdx: i, completed: i, results});
        return {ok: false, batchId, error: 'aborted', results, aborted: true, total};
      }
      if (Date.now() > totalDeadline) {
        progress({phase: 'timeout', legIdx: i, completed: i, results});
        return {ok: false, batchId, error: 'batch total wall-clock timeout', results, timedOut: true, total};
      }

      const leg = legs[i] || {};
      const seq = leg.seq != null ? leg.seq : i;
      progress({phase: 'leg-start', legIdx: i, seq});

      const taggedLeg = Object.assign({}, leg, {
        _batch: {idx: i, total, batchId, aircraftId: req.aircraftId}
      });

      try {
        const fillResp = await _sendTabMessageWithTimeout(
          tab.id,
          {type: 'aes:afp:fill-and-submit', leg: taggedLeg},
          AFP_BATCH_FILL_TIMEOUT_MS
        );
        if (!fillResp || !fillResp.ok) {
          const err = (fillResp && fillResp.error) || 'fill returned no/non-ok';
          results.push({legIdx: i, seq, ok: false, error: err});
          progress({phase: 'leg-done', legIdx: i, seq, ok: false, error: err});
        } else if (fillResp.posting) {
          try {
            await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
            results.push({legIdx: i, seq, ok: true});
            progress({phase: 'leg-done', legIdx: i, seq, ok: true});
          } catch (e) {
            const err = 'reload timeout: ' + (e && e.message ? e.message : String(e));
            results.push({legIdx: i, seq, ok: false, error: err});
            progress({phase: 'leg-done', legIdx: i, seq, ok: false, error: err});
            // Tab may be in an indeterminate state. Recreate it before
            // the next leg so we don't pile errors on a wedged tab.
            try { chrome.tabs.remove(tab.id); } catch (_) { /* noop */ }
            try {
              tab = await new Promise((resolve, reject) => {
                chrome.tabs.create({url, active: false}, (t) => {
                  const lastErr = chrome.runtime.lastError;
                  if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
                  else resolve(t);
                });
              });
              stateEntry.tabId = tab.id;
              await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);
            } catch (re) {
              progress({phase: 'error', error: 'tab recreate failed: ' + ((re && re.message) || re), results});
              return {ok: false, batchId, error: 'tab recreate failed', results, total};
            }
          }
        } else {
          // Unexpected: fill ok but posting false — treat as success.
          results.push({legIdx: i, seq, ok: true, posting: false});
          progress({phase: 'leg-done', legIdx: i, seq, ok: true, posting: false});
        }
      } catch (e) {
        const err = (e && e.message) || String(e);
        results.push({legIdx: i, seq, ok: false, error: err});
        progress({phase: 'leg-done', legIdx: i, seq, ok: false, error: err});
      }

      // Inter-leg delay — AS rate-limits Wicket form posts. Skip the
      // wait after the last leg to make completion feel snappy.
      if (i < total - 1) {
        await new Promise(r => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
      }
    }

    const okCount = results.filter(r => r && r.ok).length;
    progress({phase: 'done', ok: okCount === total, completed: total, results});
    return {ok: okCount > 0, batchId, results, total, succeeded: okCount, failed: total - okCount};
  } catch (e) {
    const err = (e && e.message) || String(e);
    progress({phase: 'error', error: err, results});
    return {ok: false, batchId, error: err, results, total};
  } finally {
    _afpBatchState.delete(batchId);
    if (tab && tab.id != null) {
      try { chrome.tabs.remove(tab.id); } catch (_) { /* noop */ }
    }
  }
}

function _afpEnqueueOnAircraft(req, sender, runner) {
  const key = String(req.aircraftId);
  const tail = _afpSubmitQueues.get(key) || Promise.resolve();
  const next = tail.catch(() => null).then(() => runner(req, sender));
  _afpSubmitQueues.set(key, next);
  next.finally(() => {
    if (_afpSubmitQueues.get(key) === next) _afpSubmitQueues.delete(key);
  });
  return next;
}

const _afpEnqueueBatch       = (req, sender) => _afpEnqueueOnAircraft(req, sender, _afpRunBatchSubmit);
const _afpEnqueueDeleteBatch = (req, sender) => _afpEnqueueOnAircraft(req, sender, _afpRunDeleteBatch);

// ── AFP delete-batch pipeline (Track 6 slice 6c) ───────────────────────
//
// Mirror of the apply-batch pipeline above but for deleting AS flight
// numbers via /app/com/numbers/<flightId>. AS's delete UI is a one-step
// Wicket POST — the form's `action` ends with `-delete~form`. Verified
// against captures of flights 9441 and 9437; the Wicket session id and
// component path drift but the suffix is stable. The bulk-delete on the
// list page only handles "unused" flights, so per-flight detail-page
// POSTs are the right choice for the wipe-and-rebuild use case.
//
// Reuses the per-aircraft submit queue (_afpSubmitQueues) so a delete
// batch can't race a single-leg Apply or Apply-all batch on the same
// aircraft. Reuses _afpBatchState so abort routing is identical.
//
// Per-flight sequence (one hidden tab, navigated in place):
//   1. tabs.update(tabId, {url: '/app/com/numbers/<id>'}) → wait complete
//   2. send 'aes:afp:delete-flight-form' to the content script — that
//      script verifies the URL matches the flightId and submits the
//      `form[action$="-delete~form"]` form. Replies {ok:true, posting:true}.
//   3. wait for AS's post-submit redirect (status === 'complete').
//   4. inter-flight 500ms delay (AS rate-limits Wicket POSTs).

async function _afpRunDeleteBatch(req, sender) {
  const batchId = req.batchId || _afpNewBatchId();
  const senderTabId = (sender && sender.tab && sender.tab.id != null)
    ? sender.tab.id : null;
  const flights = Array.isArray(req.flights) ? req.flights : [];
  const total = flights.length;
  const host = _afpHostFromSender(sender);
  const totalDeadline = Date.now() + AFP_BATCH_TOTAL_TIMEOUT_MS;
  const results = [];

  const progress = (extra) => _afpBroadcastProgress(
    senderTabId,
    'aes:afp:delete-batch:progress',
    Object.assign({batchId, aircraftId: req.aircraftId, total}, extra)
  );

  if (!total) {
    progress({phase: 'done', ok: true, results: [], emptyBatch: true});
    return {ok: true, batchId, results: [], total: 0};
  }

  const stateEntry = {tabId: null, abort: false, senderTabId, aircraftId: req.aircraftId};
  _afpBatchState.set(batchId, stateEntry);
  progress({phase: 'queued'});

  const numbersUrl = (flightId) => host + '/app/com/numbers/' + String(flightId);

  let tab = null;
  try {
    // Open at the first flight's detail URL so the initial load lands
    // already on the page we're going to delete from.
    tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({url: numbersUrl(flights[0].flightId), active: false}, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
        else resolve(t);
      });
    });
    stateEntry.tabId = tab.id;
    progress({phase: 'tab-opened', tabId: tab.id});

    await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);
    progress({phase: 'tab-loaded'});

    for (let i = 0; i < total; i++) {
      const cur = _afpBatchState.get(batchId);
      if (!cur || cur.abort) {
        progress({phase: 'aborted', flightIdx: i, completed: i, results});
        return {ok: false, batchId, error: 'aborted', results, aborted: true, total};
      }
      if (Date.now() > totalDeadline) {
        progress({phase: 'timeout', flightIdx: i, completed: i, results});
        return {ok: false, batchId, error: 'batch total wall-clock timeout', results, timedOut: true, total};
      }

      const flight = flights[i] || {};
      const flightId = flight.flightId != null ? String(flight.flightId) : '';
      progress({phase: 'flight-start', flightIdx: i, flightId});

      // For i > 0, navigate the existing tab to the next flight's URL.
      // First iteration's URL was set in tabs.create above.
      if (i > 0) {
        try {
          await new Promise((resolve, reject) => {
            chrome.tabs.update(tab.id, {url: numbersUrl(flightId)}, (t) => {
              const lastErr = chrome.runtime.lastError;
              if (lastErr) reject(new Error(lastErr.message || 'tabs.update failed'));
              else resolve(t);
            });
          });
          await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
        } catch (e) {
          const err = 'navigate failed: ' + ((e && e.message) || String(e));
          results.push({flightIdx: i, flightId, ok: false, error: err});
          progress({phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err});
          if (i < total - 1) {
            await new Promise(r => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
          }
          continue;
        }
      }

      try {
        const resp = await _sendTabMessageWithTimeout(
          tab.id,
          {type: 'aes:afp:delete-flight-form', flightId},
          AFP_BATCH_FILL_TIMEOUT_MS
        );
        if (!resp || !resp.ok) {
          const err = (resp && resp.error) || 'delete-flight-form returned no/non-ok response';
          results.push({flightIdx: i, flightId, ok: false, error: err});
          progress({phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err});
        } else if (resp.posting) {
          // Form submission triggers a Wicket POST + redirect. Wait for
          // the tab to finish before moving on or closing.
          try {
            await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
            results.push({flightIdx: i, flightId, ok: true});
            progress({phase: 'flight-done', flightIdx: i, flightId, ok: true});
          } catch (e) {
            const err = 'post-delete reload did not complete: ' + ((e && e.message) || String(e));
            results.push({flightIdx: i, flightId, ok: false, error: err});
            progress({phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err});
          }
        } else {
          // Unexpected: ok but posting false — record success but flag.
          results.push({flightIdx: i, flightId, ok: true, posting: false});
          progress({phase: 'flight-done', flightIdx: i, flightId, ok: true, posting: false});
        }
      } catch (e) {
        const err = (e && e.message) || String(e);
        results.push({flightIdx: i, flightId, ok: false, error: err});
        progress({phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err});
      }

      // Inter-flight delay — AS rate-limits Wicket form posts. Skip the
      // wait after the last flight so completion feels snappy.
      if (i < total - 1) {
        await new Promise(r => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
      }
    }

    const okCount = results.filter(r => r && r.ok).length;
    progress({phase: 'done', ok: okCount === total, completed: total, results});
    return {ok: okCount > 0, batchId, results, total, succeeded: okCount, failed: total - okCount};
  } catch (e) {
    const err = (e && e.message) || String(e);
    progress({phase: 'error', error: err, results});
    return {ok: false, batchId, error: err, results, total};
  } finally {
    _afpBatchState.delete(batchId);
    if (tab && tab.id != null) {
      try { chrome.tabs.remove(tab.id); } catch (_) { /* noop */ }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:afp:submit-leg') return false;
  if (!msg.aircraftId || !msg.leg) {
    sendResponse({ok: false, error: 'submit-leg: missing aircraftId or leg'});
    return false;
  }
  _afpEnqueueSubmit(msg, sender).then(resp => {
    try { sendResponse(resp); } catch (_) { /* caller may have gone */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;   // keep the message channel open for async response
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:afp:apply-batch') return false;
  if (!msg.aircraftId || !Array.isArray(msg.legs)) {
    sendResponse({ok: false, error: 'apply-batch: missing aircraftId or legs[]'});
    return false;
  }
  _afpEnqueueBatch(msg, sender).then(resp => {
    try { sendResponse(resp); } catch (_) { /* caller may have gone */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;   // keep the message channel open for async response
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:afp:delete-batch') return false;
  if (!msg.aircraftId || !Array.isArray(msg.flights)) {
    sendResponse({ok: false, error: 'delete-batch: missing aircraftId or flights[]'});
    return false;
  }
  _afpEnqueueDeleteBatch(msg, sender).then(resp => {
    try { sendResponse(resp); } catch (_) { /* caller may have gone */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;   // keep the message channel open for async response
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type !== 'aes:afp:apply-batch:abort'
   && msg.type !== 'aes:afp:delete-batch:abort') return false;
  const tag = msg.type === 'aes:afp:apply-batch:abort' ? 'apply-batch:abort' : 'delete-batch:abort';
  if (!msg.batchId) {
    sendResponse({ok: false, error: tag + ': missing batchId'});
    return false;
  }
  const state = _afpBatchState.get(msg.batchId);
  if (!state) {
    sendResponse({ok: false, error: 'no batch in flight with id ' + msg.batchId});
    return false;
  }
  state.abort = true;
  // Closing the tab triggers the in-flight _waitForTabComplete or
  // _sendTabMessageWithTimeout to reject promptly, so the batch loop
  // exits within ~one tick instead of waiting on the per-leg timeout.
  if (state.tabId != null) {
    try { chrome.tabs.remove(state.tabId); } catch (_) { /* noop */ }
  }
  sendResponse({ok: true, batchId: msg.batchId});
  return false;
});

// Q16 — content scripts can't always reach chrome.notifications directly
// in MV3, so the panel forwards long-op completion pings here. The
// background SW has the `notifications` permission and creates the
// system notification on the panel's behalf. Click on the notification
// focuses the originating tab when still available.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:notify:long-op') return false;
  if (!chrome.notifications || typeof chrome.notifications.create !== 'function') {
    sendResponse({ok: false, error: 'notifications API unavailable'});
    return false;
  }
  const senderTabId = sender && sender.tab && sender.tab.id;
  const opts = {
    type:    'basic',
    iconUrl: chrome.runtime.getURL('images/AES-logo-128.png'),
    title:   String(msg.title || 'AES — long op complete'),
    message: String(msg.message || ''),
    priority: 1
  };
  const notifId = 'aes-long-op-' + Date.now();
  try {
    chrome.notifications.create(notifId, opts, () => void chrome.runtime.lastError);
    if (chrome.notifications.onClicked && !chrome.notifications._aesLongOpClickWired) {
      chrome.notifications.onClicked.addListener((id) => {
        if (!id || !id.startsWith('aes-long-op-')) return;
        chrome.notifications.clear(id);
        // Only refocus the originating tab when it still exists; do
        // not crash a clean close if the user has since navigated.
        if (senderTabId != null) {
          try {
            chrome.tabs.update(senderTabId, {active: true}, () => void chrome.runtime.lastError);
          } catch (_) { /* noop */ }
        }
      });
      chrome.notifications._aesLongOpClickWired = true;
    }
    sendResponse({ok: true, id: notifId});
  } catch (e) {
    sendResponse({ok: false, error: (e && e.message) ? e.message : String(e)});
  }
  return false;
});

// ── L1 — account-registry single-writer ────────────────────────────────
//
// HANDOVER §10 invariant: only this handler ever writes the
// `aesAccounts` blob. Content scripts compute the canonical accountId
// (sha1(server:airlineIdentity).slice(0,12)) on every AS page mount
// and send `aes:account:touch`; this handler upserts the registry in
// a single chrome.storage.local.get → merge → set, so concurrent pages
// touching the same blob don't lose updates.
//
// Touches are serialised through _aesAccountTouchQueue. Without the
// queue, two pages racing the same blob (read empty, both add, last
// write wins) would lose one of the touches.

let _aesAccountTouchQueue = Promise.resolve();

function _aesAccountTouchCore(req) {
  return _aesAccountTouchQueue = _aesAccountTouchQueue
    .catch(() => null)
    .then(() => _aesAccountTouchApply(req));
}

async function _aesAccountTouchApply(req) {
  const server   = String(req.server || "").toLowerCase().trim();
  const identity = String(req.airlineIdentity || "").trim();
  if (!server || !identity) return {ok: false, error: 'missing server or airlineIdentity'};

  // Compute the same id the content-side AesAccountRegistry.computeId
  // produces. Both sides MUST match — duplicating the digest here lets
  // the background be the single authority that confirms the id.
  const norm = server + ":" + identity;
  const buf  = new TextEncoder().encode(norm);
  const dig  = await crypto.subtle.digest('SHA-1', buf);
  const arr  = new Uint8Array(dig);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  const accountId = hex.slice(0, 12);

  const data = await chrome.storage.local.get(['aesAccounts']);
  const blob = data.aesAccounts || {};
  const accounts = (blob.accounts && typeof blob.accounts === 'object') ? blob.accounts : {};
  const now = Date.now();
  const prior = accounts[accountId] || null;
  accounts[accountId] = {
    id:               accountId,
    server,
    airlineIdentity:  identity,
    displayName:      String(req.displayName || identity),
    firstSeenAt:      (prior && prior.firstSeenAt) ? prior.firstSeenAt : now,
    lastSeenAt:       now
  };
  // migrationVersion stays 0 until L2's migration shim copies legacy
  // Class B/C/D keys into their `:acct:<id>:` namespaced form. Stores
  // gate their legacy-fallback reads on (version < 1) so behaviour is
  // safe across the rollout: pre-migration the legacy is canonical;
  // post-migration the namespaced is canonical and legacy is dead-state.
  const next = {
    migrationVersion: Number(blob.migrationVersion) || 0,
    viewingAccountId: accountId,
    accounts
  };
  await chrome.storage.local.set({aesAccounts: next});
  return {ok: true, accountId};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:account:touch') return false;
  _aesAccountTouchCore(msg).then(resp => {
    try { sendResponse(resp); } catch (_) { /* caller may have gone */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;   // async response
});

// ── L2.2 — migration state setters ─────────────────────────────────────
//
// `migrate-legacy.js` runs the copy migration from content side and
// reports completion / pending-multi-account state via these messages.
// Both writes share the same `_aesAccountTouchQueue` serializer so they
// can't race the touch handler — all writes to `aesAccounts` funnel
// through one tail per HANDOVER §10 single-writer rule.

function _aesMigrationSetVersionCore(req) {
  return _aesAccountTouchQueue = _aesAccountTouchQueue
    .catch(() => null)
    .then(() => _aesMigrationSetVersionApply(req));
}

async function _aesMigrationSetVersionApply(req) {
  const v = Number(req.version);
  if (!isFinite(v) || v < 0) return {ok: false, error: 'invalid version'};
  const data = await chrome.storage.local.get(['aesAccounts']);
  const blob = data.aesAccounts || {};
  const next = Object.assign({}, blob, {migrationVersion: v});
  // Clearing pending whenever version moves forward — a successful
  // migration supersedes any stale "pending" flag from an earlier run.
  if (v >= 1 && next.migrationPending) delete next.migrationPending;
  await chrome.storage.local.set({aesAccounts: next});
  return {ok: true, version: v};
}

function _aesMigrationSetPendingCore(req) {
  return _aesAccountTouchQueue = _aesAccountTouchQueue
    .catch(() => null)
    .then(() => _aesMigrationSetPendingApply(req));
}

async function _aesMigrationSetPendingApply(req) {
  const data = await chrome.storage.local.get(['aesAccounts']);
  const blob = data.aesAccounts || {};
  const next = Object.assign({}, blob, {migrationPending: !!req.pending});
  await chrome.storage.local.set({aesAccounts: next});
  return {ok: true, pending: !!req.pending};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:migration:set-version') return false;
  _aesMigrationSetVersionCore(msg).then(resp => {
    try { sendResponse(resp); } catch (_) { /* noop */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:migration:set-pending') return false;
  _aesMigrationSetPendingCore(msg).then(resp => {
    try { sendResponse(resp); } catch (_) { /* noop */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;
});

// ─────────────────────────────────────────────────────────────────────
// Customization store — single-writer queue for the dedicated
// chrome.storage.local["customization"] blob. Mirrors the
// aesAccounts pattern so concurrent tabs (color-picker drags from
// the Studio in one tab, theme switch in another) cannot lose writes.
//
// Patches are shallow-merged. Special sentinels:
//   - `null` at any leaf  → delete that key
//   - `"__CLEAR__"` for an object branch  → replace with {}
// ─────────────────────────────────────────────────────────────────────

let _aesCustomizationQueue = Promise.resolve();

function _aesCustomizationPatchCore(req) {
  return _aesCustomizationQueue = _aesCustomizationQueue
    .catch(() => null)
    .then(() => _aesCustomizationPatchApply(req));
}

function _aesCustomizationMerge(base, patch) {
  if (patch === "__CLEAR__") return {};
  if (patch === null) return null;
  if (typeof patch !== "object") return patch;
  const out = (base && typeof base === "object") ? Object.assign({}, base) : {};
  for (const k of Object.keys(patch)) {
    const next = _aesCustomizationMerge(out[k], patch[k]);
    if (next === null) {
      delete out[k];
    } else {
      out[k] = next;
    }
  }
  return out;
}

async function _aesCustomizationPatchApply(req) {
  const patch = req && req.patch;
  if (!patch || typeof patch !== "object") {
    return {ok: false, error: 'missing patch'};
  }
  const data = await chrome.storage.local.get(['customization']);
  const blob = data.customization && typeof data.customization === "object"
    ? data.customization
    : {schemaVersion: 1, active: {presetId: 'default'}, presets: {}, scopes: {global: {}}, shortcuts: {}};
  const next = _aesCustomizationMerge(blob, patch) || {};
  if (!next.schemaVersion) next.schemaVersion = 1;
  await chrome.storage.local.set({customization: next});
  return {ok: true};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:customization:patch') return false;
  _aesCustomizationPatchCore(msg).then(resp => {
    try { sendResponse(resp); } catch (_) { /* noop */ }
  }).catch(err => {
    try { sendResponse({ok: false, error: (err && err.message) || String(err)}); }
    catch (_) { /* noop */ }
  });
  return true;
});

// ─────────────────────────────────────────────────────────────────────
// Scrape-everything orchestrator — message routing
// ─────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:start') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ok: false, reason: 'tab-pool-not-loaded'});
    return false;
  }
  const senderTabId = sender && sender.tab && sender.tab.id;
  const opts = {
    senderTabId: senderTabId,
    concurrency: msg.concurrency,
    staggerMs:   msg.staggerMs
  };
  ScrapeTabPool.startRun(msg.plan || [], opts)
    .then(resp => { try { sendResponse(resp); } catch (_) {} })
    .catch(err => { try { sendResponse({ok: false, error: (err && err.message) || String(err)}); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:abort') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ok: false, reason: 'tab-pool-not-loaded'});
    return false;
  }
  try { sendResponse(ScrapeTabPool.abortRun()); } catch (_) {}
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:status') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ok: false, reason: 'tab-pool-not-loaded'});
    return false;
  }
  try { sendResponse({ok: true, status: ScrapeTabPool.getStatus()}); } catch (_) {}
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:reset-breaker') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ok: false, reason: 'tab-pool-not-loaded'});
    return false;
  }
  try { sendResponse(ScrapeTabPool.resetBreaker()); } catch (_) {}
  return false;
});

// ─────────────────────────────────────────────────────────────────────
// Auto-Pricing Tier 3.3b — silent-auto chrome.alarms heartbeat
//
// The panel runs `setInterval` in-page for in-tab cadence; the alarm
// here is the persistent + cross-tab driver. Benefits over setInterval
// alone:
//   - Survives MV3 service-worker restarts (alarms persist)
//   - Anchors cadence to wall-clock instead of panel mount time, so
//     reopening a scheduling tab mid-cycle doesn't reset the clock
//   - Cross-tab dedup: multiple scheduling tabs each receive the
//     broadcast, but the panel's `_silentAutoTickIfDue` re-reads
//     the persisted `silentAutoLastTickAt` and skips if another tab
//     already ticked within ~0.9× tickMin
//
// The alarm is created when `settings.routeAssistant.pricing
// .silentAutoEnabled === true` and cleared when it flips off. Period
// follows `silentAutoTickMin` (clamped 5–240 min, matching the panel).
// ─────────────────────────────────────────────────────────────────────

const _AES_SILENT_AUTO_ALARM = 'aes:silent-auto:tick';

async function _aesReadSilentAutoConfig() {
  try {
    const got = await chrome.storage.local.get('settings');
    const ra  = (got && got.settings && got.settings.routeAssistant) || {};
    const pr  = ra.pricing || {};
    const tickMin = (typeof pr.silentAutoTickMin === 'number' && isFinite(pr.silentAutoTickMin))
      ? Math.max(5, Math.min(240, pr.silentAutoTickMin))
      : 30;
    return {enabled: !!pr.silentAutoEnabled, tickMin: tickMin};
  } catch (_) {
    return {enabled: false, tickMin: 30};
  }
}

async function _aesSyncSilentAutoAlarm() {
  if (!chrome.alarms) return;
  try {
    const cfg = await _aesReadSilentAutoConfig();
    const existing = await chrome.alarms.get(_AES_SILENT_AUTO_ALARM);
    if (cfg.enabled) {
      if (!existing || existing.periodInMinutes !== cfg.tickMin) {
        await chrome.alarms.clear(_AES_SILENT_AUTO_ALARM);
        chrome.alarms.create(_AES_SILENT_AUTO_ALARM, {
          periodInMinutes: cfg.tickMin,
          delayInMinutes:  cfg.tickMin
        });
      }
    } else if (existing) {
      await chrome.alarms.clear(_AES_SILENT_AUTO_ALARM);
    }
  } catch (e) {
    console.warn('[AES silent-auto] alarm sync threw', e);
  }
}

chrome.runtime.onInstalled.addListener(() => { _aesSyncSilentAutoAlarm(); });
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { _aesSyncSilentAutoAlarm(); });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.settings) return;
  const oldS = changes.settings.oldValue, newS = changes.settings.newValue;
  const oldP = (oldS && oldS.routeAssistant && oldS.routeAssistant.pricing) || {};
  const newP = (newS && newS.routeAssistant && newS.routeAssistant.pricing) || {};
  if (oldP.silentAutoEnabled === newP.silentAutoEnabled
      && oldP.silentAutoTickMin === newP.silentAutoTickMin) return;
  _aesSyncSilentAutoAlarm();
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== _AES_SILENT_AUTO_ALARM) return;
    // Broadcast to ONE scheduling tab only — sending to every tab
    // races on the per-tick dedup read (each panel reads
    // `silentAutoLastTickAt` before the others' write has landed).
    // Picking the most-recently-active tab matches the user's
    // attention; falls back to the first match. The chosen panel's
    // own setInterval covers the rare case where the picked tab is
    // unresponsive.
    chrome.tabs.query(
      {url: 'https://*.airlinesim.aero/app/com/scheduling/*'},
      (tabs) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) { void lastErr; return; }
        if (!tabs || !tabs.length) return;
        const sorted = tabs.slice().sort(
          (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
        );
        const target = sorted[0];
        if (!target || !target.id) return;
        chrome.tabs.sendMessage(
          target.id,
          {type: 'aes:silent-auto:tick', firedAt: Date.now()},
          () => void chrome.runtime.lastError
        );
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// Command Bridge — open / focus extension page (slice CB-3).
//
// The Bridge page lives at chrome-extension://<id>/bridge.html. From a
// content script, plain window.open(...) creates a duplicate tab on
// every menu click; chrome.tabs.query is gated to background-context
// scripts. This handler dedupes across all tabs: if any tab is already
// pointing at the Bridge URL it gets focused (window-and-tab), otherwise
// a fresh tab is created.
// ─────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:bridge:open') return false;
  const url = chrome.runtime.getURL('bridge.html');
  chrome.tabs.query({url}, (tabs) => {
    const lastErr = chrome.runtime.lastError;
    if (lastErr) {
      try { sendResponse({ok: false, error: lastErr.message || 'tabs.query failed'}); } catch (_) {}
      return;
    }
    const found = (tabs || []).find(t => t && t.id != null);
    if (found) {
      const finish = () => {
        try { sendResponse({ok: true, tabId: found.id, focused: true}); } catch (_) {}
      };
      try {
        chrome.tabs.update(found.id, {active: true}, () => {
          if (chrome.runtime.lastError) { finish(); return; }
          if (found.windowId != null && chrome.windows && chrome.windows.update) {
            chrome.windows.update(found.windowId, {focused: true}, () => { finish(); });
          } else { finish(); }
        });
      } catch (_) { finish(); }
      return;
    }
    try {
      chrome.tabs.create({url, active: true}, (t) => {
        if (chrome.runtime.lastError) {
          try { sendResponse({ok: false, error: chrome.runtime.lastError.message}); } catch (_) {}
          return;
        }
        try { sendResponse({ok: true, tabId: t && t.id, focused: false}); } catch (_) {}
      });
    } catch (e) {
      try { sendResponse({ok: false, error: (e && e.message) || String(e)}); } catch (_) {}
    }
  });
  return true;   // async response
});

// ─────────────────────────────────────────────────────────────────────
// Vision API — page-screenshot bridge for the future LLM co-pilot,
// visual scrape fallback paths, and any module that wants to capture
// the current AS view as a PNG.
//
// Runs in the SW because chrome.tabs.captureVisibleTab is only
// available to background contexts. The content script asks via
// `aes:vision:capture-tab`; we return a base64 data URL.
//
// Permissions already cover this: `tabs` + the AS host_permissions
// give captureVisibleTab access to AS pages without prompting. No
// permission bump needed.
//
// Format defaults to PNG; quality is jpeg-only and ignored for png.
// Single in-flight per window — Chrome's API will serialise calls
// inside captureVisibleTab itself, so we don't queue here.
// ─────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:vision:capture-tab') return false;
  const opts = (msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
  const captureOpts = {format};
  if (format === 'jpeg' && Number.isFinite(opts.quality)) {
    captureOpts.quality = Math.max(1, Math.min(100, Math.round(opts.quality)));
  }
  const windowId = sender && sender.tab && sender.tab.windowId;
  const cb = (dataUrl) => {
    const lastErr = chrome.runtime.lastError;
    if (lastErr || !dataUrl) {
      try { sendResponse({ok: false, error: (lastErr && lastErr.message) || 'captureVisibleTab returned empty'}); } catch (_) {}
      return;
    }
    try { sendResponse({ok: true, dataUrl, format, capturedAt: Date.now()}); } catch (_) {}
  };
  try {
    if (windowId != null && chrome.tabs.captureVisibleTab.length >= 3) {
      chrome.tabs.captureVisibleTab(windowId, captureOpts, cb);
    } else {
      chrome.tabs.captureVisibleTab(captureOpts, cb);
    }
  } catch (e) {
    try { sendResponse({ok: false, error: (e && e.message) || String(e)}); } catch (_) {}
  }
  return true;   // async response
});
