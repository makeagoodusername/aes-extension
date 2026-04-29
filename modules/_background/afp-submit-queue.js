'use strict';

/**
 * AFP background-tab submit pipeline.
 *
 * The Fleet Hub overlay (modules/fleet-hub/schedule-overlay.js) on the
 * fleet list page can't fill or POST AS's New Flight Number form — that
 * form only lives on /app/fleets/aircraft/<id>/0. When the user clicks
 * Apply on a leg in the overlay, this handler:
 *   1. Opens that aircraft's flight plan page in a hidden tab.
 *   2. Waits for status === "complete" (initial load done).
 *   3. Sends `aes:afp:fill-and-submit` with the leg payload — the AFP
 *      content script calls AesAfpFormDriver.fillAndSubmit(leg).
 *   4. fillAndSubmit replies {ok:true, posting:true} synchronously, then
 *      clicks Submit on a microtask. AS POSTs and reloads the page.
 *   5. We wait for ANOTHER status === "complete" on that same tab to
 *      confirm the post landed, then close the tab.
 *   6. Reply success/error to the original overlay caller.
 *
 * Per-aircraft serialisation: rapid-fire Apply clicks queue up so we
 * never have two background tabs racing the same Wicket session for one
 * aircraft.
 *
 * This is the SOLE entry point in the codebase that triggers AS form
 * submission programmatically. Documented in form-driver.js header.
 *
 * Three pipelines share the same per-aircraft queue (`_afpSubmitQueues`)
 * and abort table (`_afpBatchState`) so they cannot race each other:
 *   - single-leg submit              (Track 1)
 *   - apply-batch (multi-leg insert) (Track 5 slice 5c)
 *   - delete-batch (multi-flight remove) (Track 6 slice 6c)
 *
 * Registers four onMessage listeners:
 *   aes:afp:submit-leg
 *   aes:afp:apply-batch
 *   aes:afp:delete-batch
 *   aes:afp:apply-batch:abort  /  aes:afp:delete-batch:abort
 */

const AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS = 60000;
const AFP_SUBMIT_POST_LOAD_TIMEOUT_MS    = 30000;
const AFP_SUBMIT_FILL_TIMEOUT_MS         = 15000;

const AFP_BATCH_FILL_TIMEOUT_MS    = 30000;
const AFP_BATCH_RELOAD_TIMEOUT_MS  = 30000;
const AFP_BATCH_INTER_LEG_DELAY_MS = 500;
const AFP_BATCH_TOTAL_TIMEOUT_MS   = 20 * 60 * 1000;

const _afpSubmitQueues = new Map();   // aircraftId → Promise tail
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
  return 'https://free1.airlinesim.aero';
}

function _waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      try { chrome.tabs.onRemoved.removeListener(removed); } catch (_) {}
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
      chrome.tabs.create({ url, active: false }, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
        else resolve(t);
      });
    });
    await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);

    const fillResp = await _sendTabMessageWithTimeout(
      tab.id,
      { type: 'aes:afp:fill-and-submit', leg: req.leg },
      AFP_SUBMIT_FILL_TIMEOUT_MS
    );

    if (!fillResp || !fillResp.ok) {
      const err = (fillResp && fillResp.error) || 'fill-and-submit returned no/non-ok response';
      return { ok: false, error: err };
    }

    if (fillResp.posting) {
      try {
        await _waitForTabComplete(tab.id, AFP_SUBMIT_POST_LOAD_TIMEOUT_MS);
      } catch (e) {
        return { ok: false, error: 'post-submit reload did not complete: ' + e.message };
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (tab && tab.id != null) {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

function _afpEnqueueSubmit(req, sender) {
  const key = String(req.aircraftId);
  const tail = _afpSubmitQueues.get(key) || Promise.resolve();
  const next = tail.catch(() => null).then(() => _afpRunSubmit(req, sender));
  _afpSubmitQueues.set(key, next);
  next.finally(() => {
    if (_afpSubmitQueues.get(key) === next) _afpSubmitQueues.delete(key);
  });
  return next;
}

function _afpNewBatchId() {
  return 'batch-' + Date.now().toString(36)
    + '-' + Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0');
}

/**
 * Broadcast a progress message back to the originating tab so a content-side
 * orchestrator (apply-batch.js, flight-deleter.js) can update the live
 * progress UI. Falls back to runtime.sendMessage when sender.tab.id isn't
 * known. `type` is the chrome.runtime message type the receiving content
 * script filters on.
 */
function _afpBroadcastProgress(senderTabId, type, payload) {
  const msg = Object.assign({ type }, payload);
  if (senderTabId != null) {
    try {
      chrome.tabs.sendMessage(senderTabId, msg, () => { void chrome.runtime.lastError; });
    } catch (_) {}
    return;
  }
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); }
  catch (_) {}
}

async function _afpRunBatchSubmit(req, sender) {
  const batchId     = req.batchId || _afpNewBatchId();
  const senderTabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;
  const legs        = Array.isArray(req.legs) ? req.legs : [];
  const total       = legs.length;
  const host        = _afpHostFromSender(sender);
  const url         = host + _afpAircraftPath(req.aircraftId);
  const totalDeadline = Date.now() + AFP_BATCH_TOTAL_TIMEOUT_MS;
  const results     = [];

  const progress = (extra) => _afpBroadcastProgress(
    senderTabId,
    'aes:afp:apply-batch:progress',
    Object.assign({ batchId, aircraftId: req.aircraftId, total }, extra)
  );

  if (!total) {
    progress({ phase: 'done', ok: true, results: [], emptyBatch: true });
    return { ok: true, batchId, results: [], total: 0 };
  }

  const stateEntry = { tabId: null, abort: false, senderTabId, aircraftId: req.aircraftId };
  _afpBatchState.set(batchId, stateEntry);
  progress({ phase: 'queued' });

  let tab = null;
  try {
    tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: false }, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
        else resolve(t);
      });
    });
    stateEntry.tabId = tab.id;
    progress({ phase: 'tab-opened', tabId: tab.id });

    await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);
    progress({ phase: 'tab-loaded' });

    for (let i = 0; i < total; i++) {
      const cur = _afpBatchState.get(batchId);
      if (!cur || cur.abort) {
        progress({ phase: 'aborted', legIdx: i, completed: i, results });
        return { ok: false, batchId, error: 'aborted', results, aborted: true, total };
      }
      if (Date.now() > totalDeadline) {
        progress({ phase: 'timeout', legIdx: i, completed: i, results });
        return { ok: false, batchId, error: 'batch total wall-clock timeout', results, timedOut: true, total };
      }

      const leg = legs[i] || {};
      const seq = leg.seq != null ? leg.seq : i;
      progress({ phase: 'leg-start', legIdx: i, seq });

      const taggedLeg = Object.assign({}, leg, {
        _batch: { idx: i, total, batchId, aircraftId: req.aircraftId }
      });

      try {
        const fillResp = await _sendTabMessageWithTimeout(
          tab.id,
          { type: 'aes:afp:fill-and-submit', leg: taggedLeg },
          AFP_BATCH_FILL_TIMEOUT_MS
        );
        if (!fillResp || !fillResp.ok) {
          const err = (fillResp && fillResp.error) || 'fill returned no/non-ok';
          results.push({ legIdx: i, seq, ok: false, error: err });
          progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: err });
        } else if (fillResp.posting) {
          try {
            await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
            results.push({ legIdx: i, seq, ok: true });
            progress({ phase: 'leg-done', legIdx: i, seq, ok: true });
          } catch (e) {
            const err = 'reload timeout: ' + (e && e.message ? e.message : String(e));
            results.push({ legIdx: i, seq, ok: false, error: err });
            progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: err });
            // Tab may be in an indeterminate state. Recreate before next leg.
            try { chrome.tabs.remove(tab.id); } catch (_) {}
            try {
              tab = await new Promise((resolve, reject) => {
                chrome.tabs.create({ url, active: false }, (t) => {
                  const lastErr = chrome.runtime.lastError;
                  if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
                  else resolve(t);
                });
              });
              stateEntry.tabId = tab.id;
              await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);
            } catch (re) {
              progress({ phase: 'error', error: 'tab recreate failed: ' + ((re && re.message) || re), results });
              return { ok: false, batchId, error: 'tab recreate failed', results, total };
            }
          }
        } else {
          results.push({ legIdx: i, seq, ok: true, posting: false });
          progress({ phase: 'leg-done', legIdx: i, seq, ok: true, posting: false });
        }
      } catch (e) {
        const err = (e && e.message) || String(e);
        results.push({ legIdx: i, seq, ok: false, error: err });
        progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: err });
      }

      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
      }
    }

    const okCount = results.filter((r) => r && r.ok).length;
    progress({ phase: 'done', ok: okCount === total, completed: total, results });
    return { ok: okCount > 0, batchId, results, total, succeeded: okCount, failed: total - okCount };
  } catch (e) {
    const err = (e && e.message) || String(e);
    progress({ phase: 'error', error: err, results });
    return { ok: false, batchId, error: err, results, total };
  } finally {
    _afpBatchState.delete(batchId);
    if (tab && tab.id != null) {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
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

/**
 * Mirror of the apply-batch pipeline but for deleting AS flight numbers
 * via /app/com/numbers/<flightId>. AS's delete UI is a one-step Wicket
 * POST — the form's `action` ends with `-delete~form`. Reuses the
 * per-aircraft submit queue + batch state so a delete batch can't race a
 * single-leg Apply or Apply-all batch on the same aircraft.
 */
async function _afpRunDeleteBatch(req, sender) {
  const batchId     = req.batchId || _afpNewBatchId();
  const senderTabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;
  const flights     = Array.isArray(req.flights) ? req.flights : [];
  const total       = flights.length;
  const host        = _afpHostFromSender(sender);
  const totalDeadline = Date.now() + AFP_BATCH_TOTAL_TIMEOUT_MS;
  const results     = [];

  const progress = (extra) => _afpBroadcastProgress(
    senderTabId,
    'aes:afp:delete-batch:progress',
    Object.assign({ batchId, aircraftId: req.aircraftId, total }, extra)
  );

  if (!total) {
    progress({ phase: 'done', ok: true, results: [], emptyBatch: true });
    return { ok: true, batchId, results: [], total: 0 };
  }

  const stateEntry = { tabId: null, abort: false, senderTabId, aircraftId: req.aircraftId };
  _afpBatchState.set(batchId, stateEntry);
  progress({ phase: 'queued' });

  const numbersUrl = (flightId) => host + '/app/com/numbers/' + String(flightId);

  let tab = null;
  try {
    tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url: numbersUrl(flights[0].flightId), active: false }, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
        else resolve(t);
      });
    });
    stateEntry.tabId = tab.id;
    progress({ phase: 'tab-opened', tabId: tab.id });

    await _waitForTabComplete(tab.id, AFP_SUBMIT_INITIAL_LOAD_TIMEOUT_MS);
    progress({ phase: 'tab-loaded' });

    for (let i = 0; i < total; i++) {
      const cur = _afpBatchState.get(batchId);
      if (!cur || cur.abort) {
        progress({ phase: 'aborted', flightIdx: i, completed: i, results });
        return { ok: false, batchId, error: 'aborted', results, aborted: true, total };
      }
      if (Date.now() > totalDeadline) {
        progress({ phase: 'timeout', flightIdx: i, completed: i, results });
        return { ok: false, batchId, error: 'batch total wall-clock timeout', results, timedOut: true, total };
      }

      const flight = flights[i] || {};
      const flightId = flight.flightId != null ? String(flight.flightId) : '';
      progress({ phase: 'flight-start', flightIdx: i, flightId });

      if (i > 0) {
        try {
          await new Promise((resolve, reject) => {
            chrome.tabs.update(tab.id, { url: numbersUrl(flightId) }, (t) => {
              const lastErr = chrome.runtime.lastError;
              if (lastErr) reject(new Error(lastErr.message || 'tabs.update failed'));
              else resolve(t);
            });
          });
          await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
        } catch (e) {
          const err = 'navigate failed: ' + ((e && e.message) || String(e));
          results.push({ flightIdx: i, flightId, ok: false, error: err });
          progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err });
          if (i < total - 1) {
            await new Promise((r) => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
          }
          continue;
        }
      }

      try {
        const resp = await _sendTabMessageWithTimeout(
          tab.id,
          { type: 'aes:afp:delete-flight-form', flightId },
          AFP_BATCH_FILL_TIMEOUT_MS
        );
        if (!resp || !resp.ok) {
          const err = (resp && resp.error) || 'delete-flight-form returned no/non-ok response';
          results.push({ flightIdx: i, flightId, ok: false, error: err });
          progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err });
        } else if (resp.posting) {
          try {
            await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
            results.push({ flightIdx: i, flightId, ok: true });
            progress({ phase: 'flight-done', flightIdx: i, flightId, ok: true });
          } catch (e) {
            const err = 'post-delete reload did not complete: ' + ((e && e.message) || String(e));
            results.push({ flightIdx: i, flightId, ok: false, error: err });
            progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err });
          }
        } else {
          results.push({ flightIdx: i, flightId, ok: true, posting: false });
          progress({ phase: 'flight-done', flightIdx: i, flightId, ok: true, posting: false });
        }
      } catch (e) {
        const err = (e && e.message) || String(e);
        results.push({ flightIdx: i, flightId, ok: false, error: err });
        progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err });
      }

      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
      }
    }

    const okCount = results.filter((r) => r && r.ok).length;
    progress({ phase: 'done', ok: okCount === total, completed: total, results });
    return { ok: okCount > 0, batchId, results, total, succeeded: okCount, failed: total - okCount };
  } catch (e) {
    const err = (e && e.message) || String(e);
    progress({ phase: 'error', error: err, results });
    return { ok: false, batchId, error: err, results, total };
  } finally {
    _afpBatchState.delete(batchId);
    if (tab && tab.id != null) {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

// ── Message routers ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:afp:submit-leg') return false;
  if (!msg.aircraftId || !msg.leg) {
    sendResponse({ ok: false, error: 'submit-leg: missing aircraftId or leg' });
    return false;
  }
  _afpEnqueueSubmit(msg, sender)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:afp:apply-batch') return false;
  if (!msg.aircraftId || !Array.isArray(msg.legs)) {
    sendResponse({ ok: false, error: 'apply-batch: missing aircraftId or legs[]' });
    return false;
  }
  _afpEnqueueBatch(msg, sender)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:afp:delete-batch') return false;
  if (!msg.aircraftId || !Array.isArray(msg.flights)) {
    sendResponse({ ok: false, error: 'delete-batch: missing aircraftId or flights[]' });
    return false;
  }
  _afpEnqueueDeleteBatch(msg, sender)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type !== 'aes:afp:apply-batch:abort'
   && msg.type !== 'aes:afp:delete-batch:abort') return false;
  const tag = msg.type === 'aes:afp:apply-batch:abort' ? 'apply-batch:abort' : 'delete-batch:abort';
  if (!msg.batchId) {
    sendResponse({ ok: false, error: tag + ': missing batchId' });
    return false;
  }
  const state = _afpBatchState.get(msg.batchId);
  if (!state) {
    sendResponse({ ok: false, error: 'no batch in flight with id ' + msg.batchId });
    return false;
  }
  state.abort = true;
  // Closing the tab triggers in-flight _waitForTabComplete /
  // _sendTabMessageWithTimeout to reject promptly, so the batch loop
  // exits within ~one tick instead of waiting on per-leg timeout.
  if (state.tabId != null) {
    try { chrome.tabs.remove(state.tabId); } catch (_) {}
  }
  sendResponse({ ok: true, batchId: msg.batchId });
  return false;
});
