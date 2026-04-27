// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';
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
      actions: [new chrome.declarativeContent.ShowPageAction()]
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
 * Broadcast a progress message back to the originating tab so the AFP
 * page's apply-batch.js content script can update the live progress UI.
 * Falls back to runtime.sendMessage when sender.tab.id isn't known
 * (e.g., the request came from the popup or a service worker call).
 */
function _afpBroadcastBatchProgress(senderTabId, payload) {
  const msg = Object.assign({type: 'aes:afp:apply-batch:progress'}, payload);
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

  const progress = (extra) => _afpBroadcastBatchProgress(
    senderTabId,
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

function _afpEnqueueBatch(req, sender) {
  const key = String(req.aircraftId);
  const tail = _afpSubmitQueues.get(key) || Promise.resolve();
  const next = tail.catch(() => null).then(() => _afpRunBatchSubmit(req, sender));
  _afpSubmitQueues.set(key, next);
  next.finally(() => {
    if (_afpSubmitQueues.get(key) === next) _afpSubmitQueues.delete(key);
  });
  return next;
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
  if (!msg || msg.type !== 'aes:afp:apply-batch:abort') return false;
  if (!msg.batchId) {
    sendResponse({ok: false, error: 'apply-batch:abort: missing batchId'});
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
