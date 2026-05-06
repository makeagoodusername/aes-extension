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
const AFP_SUBMIT_FILL_TIMEOUT_MS         = 45000;
const AFP_SUBMIT_ASSIGN_TIMEOUT_MS       = 30000;
const AFP_SUBMIT_VERIFY_TIMEOUT_MS       = 15000;
const AFP_CONTENT_READY_TIMEOUT_MS       = 10000;

const AFP_BATCH_FILL_TIMEOUT_MS    = 30000;
const AFP_BATCH_RELOAD_TIMEOUT_MS  = 30000;
const AFP_BATCH_INTER_LEG_DELAY_MS = 500;
const AFP_BATCH_TOTAL_TIMEOUT_MS   = 20 * 60 * 1000;
const AFP_BATCH_SNAPSHOT_TIMEOUT_MS = 15000;
const AFP_BATCH_SCHEDULE_TIMEOUT_MS = 20000;
const AFP_BATCH_VERIFY_TIMEOUT_MS   = 20000;
const AFP_BATCH_RESULT_STORE_KEY    = 'aircraftFlightPlan:autoApplyBatchResults';

const _afpSubmitQueues = new Map();   // aircraftId → Promise tail
const _afpBatchState   = new Map();   // batchId    → {tabId, abort, senderTabId, aircraftId}

async function _afpPersistBatchResult(kind, req, resp) {
  const batchId = (resp && resp.batchId) || (req && req.batchId);
  if (!batchId || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resp;
  const now = Date.now();
  const payload = {
    kind,
    batchId: String(batchId),
    aircraftId: req && req.aircraftId ? String(req.aircraftId) : null,
    updatedAt: now,
    response: resp || { ok: false, batchId, error: 'empty batch response' }
  };
  try {
    const got = await chrome.storage.local.get([AFP_BATCH_RESULT_STORE_KEY]);
    const rec = got[AFP_BATCH_RESULT_STORE_KEY] || { ids: [], entries: {}, updatedAt: 0 };
    const entries = (rec.entries && typeof rec.entries === 'object') ? Object.assign({}, rec.entries) : {};
    const ids = Array.isArray(rec.ids) ? rec.ids.map(String) : [];
    const nextIds = [String(batchId)].concat(ids.filter((id) => id !== String(batchId))).slice(0, 30);
    entries[String(batchId)] = payload;
    for (const id of Object.keys(entries)) {
      if (!nextIds.includes(id)) delete entries[id];
    }
    await chrome.storage.local.set({
      [AFP_BATCH_RESULT_STORE_KEY]: { ids: nextIds, entries, updatedAt: now }
    });
  } catch (_) {
    /* Result recovery is best-effort; sendResponse remains authoritative. */
  }
  return resp;
}

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
      clearInterval(poll);
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
    const poll = setInterval(() => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (done) return;
          const lastErr = chrome.runtime.lastError;
          if (lastErr) return;
          if (tab && tab.status === 'complete') finish(null);
        });
      } catch (_) {}
    }, 750);
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

function _afpDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _sendTabMessageWhenReady(tabId, message, timeoutMs, readyTimeoutMs) {
  const deadline = Date.now() + (readyTimeoutMs || AFP_CONTENT_READY_TIMEOUT_MS);
  let lastErr = null;
  while (Date.now() <= deadline) {
    try {
      return await _sendTabMessageWithTimeout(tabId, message, timeoutMs);
    } catch (e) {
      lastErr = e;
      const text = (e && e.message) || String(e);
      if (!/Receiving end does not exist|Could not establish connection|Extension context invalidated|content-script reply timeout/i.test(text)) {
        throw e;
      }
      await _afpDelay(250);
    }
  }
  throw lastErr || new Error('content script did not become ready');
}

async function _afpAssignCreatedFlight(tabId, leg, reloadTimeoutMs) {
  const assignResp = await _sendTabMessageWhenReady(
    tabId,
    { type: 'aes:afp:assign-existing-flight', leg },
    AFP_SUBMIT_ASSIGN_TIMEOUT_MS,
    AFP_CONTENT_READY_TIMEOUT_MS
  );
  if (!assignResp || !assignResp.ok) {
    return {
      ok: false,
      error: (assignResp && assignResp.error) || 'assign-existing-flight returned no/non-ok response'
    };
  }
  if (assignResp.posting) {
    try {
      await _waitForTabComplete(tabId, reloadTimeoutMs || AFP_SUBMIT_POST_LOAD_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, error: 'schedule assignment reload did not complete: ' + ((e && e.message) || e) };
    }
  }
  const scheduledLeg = Object.assign({}, leg, {
    flightNumberText: assignResp.flightNumberText || leg.flightNumberText || ''
  });
  const verifyResp = await _afpVerifyScheduledFlightInTab(tabId, scheduledLeg);
  if (!verifyResp || !verifyResp.ok) {
    return {
      ok: false,
      error: (verifyResp && verifyResp.error) || 'scheduled flight verification failed',
      flightNumberText: scheduledLeg.flightNumberText || null
    };
  }
  return { ok: true, flightNumberText: scheduledLeg.flightNumberText || verifyResp.flightNumberText || null };
}

async function _afpVerifyScheduledFlightInTab(tabId, leg) {
  return _sendTabMessageWhenReady(
    tabId,
    { type: 'aes:afp:verify-scheduled-flight', leg },
    AFP_SUBMIT_VERIFY_TIMEOUT_MS,
    AFP_CONTENT_READY_TIMEOUT_MS
  );
}

function _tabGet(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.get failed'));
        else resolve(tab);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function _tabUpdateUrl(tabId, url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, { url }, (tab) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'tabs.update failed'));
        else resolve(tab);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function _stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch (_) {
    return String(url || '').replace(/#.*$/, '');
  }
}

async function _navigateTabIfNeeded(tabId, url, timeoutMs) {
  const target = _stripHash(url);
  let cur = null;
  try { cur = await _tabGet(tabId); } catch (_) {}
  if (cur && _stripHash(cur.url || '') === target) return cur;
  const wait = _waitForTabComplete(tabId, timeoutMs);
  await _tabUpdateUrl(tabId, url);
  await wait;
  return _tabGet(tabId).catch(() => null);
}

function _afpNormIata(value) {
  const m = String(value || '').toUpperCase().match(/\b([A-Z0-9]{3})\b/);
  return m ? m[1] : '';
}

function _afpCleanFlightNumber(value) {
  return String(value == null ? '' : value).replace(/[^0-9]/g, '').slice(0, 8);
}

function _afpNormaliseTime(value) {
  const m = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return '';
  return String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
}

function _afpNormaliseDayMask(mask) {
  if (Array.isArray(mask) && mask.length >= 7) return mask.slice(0, 7).map(Boolean);
  return [true, true, true, true, true, true, true];
}

function _afpFlightNumberRowScore(row, leg) {
  if (!row) return -1;
  const wantedNumber = _afpCleanFlightNumber(leg && leg.flightNumberText);
  const rowNumber = _afpCleanFlightNumber(row.flightNumber);
  if (wantedNumber && rowNumber !== wantedNumber) return -1;

  const origin = _afpNormIata(leg && leg.origin);
  const dest = _afpNormIata(leg && leg.destination);
  const rowOrigin = _afpNormIata(row.originIata);
  const rowDest = _afpNormIata(row.destinationIata);
  if (origin && rowOrigin && rowOrigin !== origin) return -1;
  if (dest && rowDest && rowDest !== dest) return -1;

  let score = 0;
  if (wantedNumber && rowNumber === wantedNumber) score += 100;
  if (origin && rowOrigin === origin) score += 20;
  if (dest && rowDest === dest) score += 20;

  const dep = _afpNormaliseTime((leg && (leg.depTime || leg.depTimeLocal)) || '');
  const rowDep = _afpNormaliseTime(row.departure || '');
  if (dep && rowDep && dep === rowDep) score += 10;
  if (String(row.days || '').indexOf('_') !== -1) score += 2;
  return score;
}

function _afpPickFlightNumberRow(rows, leg) {
  const ranked = (rows || [])
    .map((row) => {
      const score = _afpFlightNumberRowScore(row, leg);
      const idNum = parseInt(row && row.flightId, 10);
      return { row, score, idNum: isFinite(idNum) ? idNum : 0 };
    })
    .filter((r) => r.score >= 0 && r.row && r.row.flightId);
  ranked.sort((a, b) => (b.score - a.score) || (b.idNum - a.idNum));
  return ranked.length ? ranked[0].row : null;
}

async function _afpResolveCreatedFlight(tabId, host, leg, req) {
  // Instead of querying the /app/com/numbers page which may hide flights across
  // pagination boundaries, verify creation using the aircraft's Visual Flight Plan.
  // We navigate to the aircraft page and use aes:afp:verify-created-leg.

  await _navigateTabIfNeeded(
    tabId,
    host + _afpAircraftPath(req.aircraftId),
    AFP_BATCH_RELOAD_TIMEOUT_MS
  );

  const resp = await _sendTabMessageWhenReady(
    tabId,
    { type: 'aes:afp:verify-created-leg', leg },
    AFP_BATCH_VERIFY_TIMEOUT_MS,
    AFP_CONTENT_READY_TIMEOUT_MS
  );

  if (!resp || !resp.ok || !resp.match) {
    return {
      ok: false,
      error: (resp && resp.error) || 'created leg not found in visual flight plan after submit',
      visibleCount: resp && resp.scheduleCount ? resp.scheduleCount : 0
    };
  }

  // The match returns the flightId parsed from the Visual Flight Plan
  const flightId = resp.match.flightId;
  if (!flightId) {
    return {
      ok: false,
      error: 'created leg was found in VFP but flightId could not be parsed',
      match: resp.match
    };
  }

  return { ok: true, flightId: String(flightId), row: resp.match };
}

async function _afpSnapshotFlightNumberIds(tabId, host) {
  await _navigateTabIfNeeded(tabId, host + '/app/com/numbers', AFP_BATCH_RELOAD_TIMEOUT_MS);
  try {
    const snap = await _sendTabMessageWhenReady(
      tabId,
      { type: 'aes:flight-numbers:snapshot' },
      AFP_BATCH_SNAPSHOT_TIMEOUT_MS,
      AFP_CONTENT_READY_TIMEOUT_MS
    );
    if (!snap || !snap.ok) return new Set();
    return new Set((snap.visibleNumbers || [])
      .map((row) => row && row.flightId != null ? String(row.flightId) : '')
      .filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

async function _afpVerifyScheduledLeg(tabId, host, req, leg) {
  await _navigateTabIfNeeded(
    tabId,
    host + _afpAircraftPath(req.aircraftId),
    AFP_BATCH_RELOAD_TIMEOUT_MS
  );
  const resp = await _sendTabMessageWhenReady(
    tabId,
    { type: 'aes:afp:verify-created-leg', leg },
    AFP_BATCH_VERIFY_TIMEOUT_MS,
    AFP_CONTENT_READY_TIMEOUT_MS
  );
  if (!resp || !resp.ok) {
    return {
      ok: false,
      error: (resp && resp.error) || 'scheduled leg was not found on the aircraft flight plan',
      verify: resp || null
    };
  }
  return { ok: true, verify: resp };
}

async function _afpRemoveScheduledDaysForLeg(tabId, host, leg, flightId) {
  const origin = _afpNormIata(leg && leg.origin);
  const dest = _afpNormIata(leg && leg.destination);
  const mask = Array.isArray(leg && leg.dayMask) && leg.dayMask.length >= 7
    ? leg.dayMask.slice(0, 7).map(Boolean)
    : null;
  if (!origin || !dest) return { ok: false, error: 'schedule rollback: missing origin or destination' };
  if (!mask || !mask.some(Boolean)) return { ok: false, error: 'schedule rollback: explicit selected dayMask required' };

  const scheduleUrl = host + '/app/com/scheduling/'
    + encodeURIComponent(origin + dest)
    + '?fnid=' + encodeURIComponent(String(flightId || ''))
    + '&segment=0';
  await _navigateTabIfNeeded(tabId, scheduleUrl, AFP_BATCH_RELOAD_TIMEOUT_MS);
  const resp = await _sendTabMessageWhenReady(
    tabId,
    {
      type:        'aes:scheduling:remove-flight-plan-days',
      flightId:    String(flightId || ''),
      origin,
      destination: dest,
      dayMask:     mask
    },
    AFP_BATCH_SCHEDULE_TIMEOUT_MS,
    AFP_CONTENT_READY_TIMEOUT_MS
  );
  if (!resp || !resp.ok) {
    return {
      ok: false,
      error: (resp && resp.error) || 'schedule rollback returned no/non-ok response',
      response: resp || null
    };
  }
  if (resp.posting) {
    try {
      await _waitForTabComplete(tabId, AFP_BATCH_RELOAD_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, error: 'schedule rollback reload did not complete: ' + ((e && e.message) || String(e)) };
    }
  }
  return { ok: true, response: resp };
}

async function _afpVerifyFlightNumberDeleted(tabId, host, flightId) {
  const ids = await _afpSnapshotFlightNumberIds(tabId, host);
  if (ids && typeof ids.has === 'function' && ids.has(String(flightId))) {
    return { ok: false, error: 'flight number ' + String(flightId) + ' is still visible after delete' };
  }
  return { ok: true };
}

async function _afpDeleteCreatedFlightNumber(tabId, host, flightId) {
  if (!flightId) return { ok: false, error: 'delete rollback: missing flightId' };
  await _navigateTabIfNeeded(
    tabId,
    host + '/app/com/numbers/' + encodeURIComponent(String(flightId)),
    AFP_BATCH_RELOAD_TIMEOUT_MS
  );
  const resp = await _sendTabMessageWhenReady(
    tabId,
    { type: 'aes:afp:delete-flight-form', flightId: String(flightId) },
    AFP_BATCH_FILL_TIMEOUT_MS,
    AFP_CONTENT_READY_TIMEOUT_MS
  );
  if (!resp || !resp.ok) {
    return {
      ok: false,
      error: (resp && resp.error) || 'delete rollback returned no/non-ok response'
    };
  }
  if (resp.posting) {
    try {
      await _waitForTabComplete(tabId, AFP_BATCH_RELOAD_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, error: 'delete rollback reload did not complete: ' + ((e && e.message) || String(e)) };
    }
  }
  return _afpVerifyFlightNumberDeleted(tabId, host, flightId);
}

async function _afpApplySchedulingForLeg(tabId, host, req, leg, knownFlightIds) {
  const origin = _afpNormIata(leg && leg.origin);
  const dest = _afpNormIata(leg && leg.destination);
  if (!origin || !dest) return { ok: false, error: 'schedule apply: missing origin or destination' };

  const resolved = await _afpResolveCreatedFlight(tabId, host, leg, req);
  if (!resolved.ok) return resolved;
  if (knownFlightIds && typeof knownFlightIds.add === 'function') {
    knownFlightIds.add(String(resolved.flightId));
  }

  const scheduleUrl = host + '/app/com/scheduling/'
    + encodeURIComponent(origin + dest)
    + '?fnid=' + encodeURIComponent(resolved.flightId)
    + '&segment=0';
  await _navigateTabIfNeeded(tabId, scheduleUrl, AFP_BATCH_RELOAD_TIMEOUT_MS);

  let resp = null;
  const scheduleDeadline = Date.now() + AFP_BATCH_SCHEDULE_TIMEOUT_MS;
  while (Date.now() <= scheduleDeadline) {
    resp = await _sendTabMessageWhenReady(
      tabId,
      {
        type:         'aes:scheduling:apply-flight-plan',
        confirm:      true,
        flightId:     resolved.flightId,
        aircraftId:   req.aircraftId,
        registration: req.registration || req.aircraftRegistration || '',
        origin,
        destination:  dest,
        depTime:      (leg && (leg.depTime || leg.depTimeLocal)) || '09:00',
        dayMask:      _afpNormaliseDayMask(leg && leg.dayMask)
      },
      5000,
      AFP_CONTENT_READY_TIMEOUT_MS
    );
    if (resp && resp.ok) break;
    const err = String(resp && resp.error || '');
    if (!/flight planning form not found|aircraft select not found/i.test(err)) break;
    await _afpDelay(500);
  }

  if (!resp || !resp.ok) {
    return {
      ok: false,
      error: (resp && resp.error) || 'schedule apply returned no/non-ok response',
      flightId: resolved.flightId,
      row: resolved.row
    };
  }

  if (resp.posting) {
    try {
      await _waitForTabComplete(tabId, AFP_BATCH_RELOAD_TIMEOUT_MS);
    } catch (e) {
      return {
        ok: false,
        error: 'schedule apply reload did not complete: ' + ((e && e.message) || String(e)),
        flightId: resolved.flightId,
        row: resolved.row
      };
    }
  }

  const verified = await _afpVerifyScheduledLeg(tabId, host, req, leg);
  if (!verified.ok) {
    let unschedule = null;
    let deletion = null;
    try {
      unschedule = await _afpRemoveScheduledDaysForLeg(tabId, host, leg, resolved.flightId);
    } catch (e) {
      unschedule = { ok: false, error: (e && e.message) || String(e) };
    }
    try {
      deletion = await _afpDeleteCreatedFlightNumber(tabId, host, resolved.flightId);
      if (deletion && deletion.ok && knownFlightIds && typeof knownFlightIds.delete === 'function') {
        knownFlightIds.delete(String(resolved.flightId));
      }
    } catch (e) {
      deletion = { ok: false, error: (e && e.message) || String(e) };
    }
    const rollback = { ok: !!(deletion && deletion.ok), unschedule, delete: deletion };
    return {
      ok: false,
      flightId: resolved.flightId,
      row: resolved.row,
      schedule: resp.set || null,
      error: 'scheduled leg verification failed: '
        + (verified.error || 'scheduled leg was not visible in the VFP immediately after POST')
        + (rollback.ok ? ' (created flight number rolled back)' : ' (rollback failed)'),
      verify: verified.verify || verified || null,
      rollback
    };
  }

  return {
    ok: true,
    flightId: resolved.flightId,
    row: resolved.row,
    schedule: resp.set || null,
    verify: verified.verify
  };
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
    const knownFlightIds = await _afpSnapshotFlightNumberIds(tab.id, host);
    await _navigateTabIfNeeded(tab.id, url, AFP_BATCH_RELOAD_TIMEOUT_MS);

    if (!req.registration && !req.aircraftRegistration) {
      try {
        const ctxResp = await _sendTabMessageWithTimeout(
          tab.id,
          { type: 'aes:afp:page-context' },
          AFP_BATCH_SNAPSHOT_TIMEOUT_MS
        );
        const ctx = ctxResp && ctxResp.ctx;
        if (ctx && ctx.registration) req.registration = ctx.registration;
      } catch (_) { /* registration is best-effort; scheduling step will report if missing */ }
    }

    const fillResp = await _sendTabMessageWhenReady(
      tab.id,
      { type: 'aes:afp:fill-and-submit', leg: req.leg },
      AFP_SUBMIT_FILL_TIMEOUT_MS,
      AFP_CONTENT_READY_TIMEOUT_MS
    );

    if (!fillResp || !fillResp.ok) {
      const err = (fillResp && fillResp.error) || 'fill-and-submit returned no/non-ok response';
      return { ok: false, error: err };
    }

    if (fillResp.posting) {
      try {
        if (fillResp.fetch) {
          // If the form-driver used the headless fetch POST bypass, the Wicket form
          // won't automatically reload the page. We must trigger a reload explicitly
          // so the DOM reflects the newly created flight for _afpApplySchedulingForLeg.
          await new Promise((resolve, reject) => {
            chrome.tabs.reload(tab.id, {}, () => {
              const err = chrome.runtime.lastError;
              if (err) reject(new Error(err.message));
              else resolve();
            });
          });
        }
        await _waitForTabComplete(tab.id, AFP_SUBMIT_POST_LOAD_TIMEOUT_MS);
      } catch (e) {
        return { ok: false, error: 'post-submit reload did not complete: ' + e.message };
      }
      const scheduled = await _afpApplySchedulingForLeg(tab.id, host, req, req.leg || {}, knownFlightIds);
      if (!scheduled || !scheduled.ok) {
        return { ok: false, error: (scheduled && scheduled.error) || 'schedule assignment failed' };
      }
      return {
        ok: true,
        flightNumberText: (req.leg && req.leg.flightNumberText) || null,
        flightId: scheduled.flightId || null
      };
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

function _afpLikelyPostNavigationMessageClose(error) {
  const msg = (error && error.message) ? error.message : String(error || '');
  return /message channel closed before a response was received/i.test(msg);
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
    const knownFlightIds = await _afpSnapshotFlightNumberIds(tab.id, host);
    await _navigateTabIfNeeded(tab.id, url, AFP_BATCH_RELOAD_TIMEOUT_MS);

    if (!req.registration && !req.aircraftRegistration) {
      try {
        const ctxResp = await _sendTabMessageWithTimeout(
          tab.id,
          { type: 'aes:afp:page-context' },
          AFP_BATCH_SNAPSHOT_TIMEOUT_MS
        );
        const ctx = ctxResp && ctxResp.ctx;
        if (ctx && ctx.registration) req.registration = ctx.registration;
      } catch (_) { /* registration is best-effort; scheduling step will report if missing */ }
    }

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

      try {
        await _navigateTabIfNeeded(tab.id, url, AFP_BATCH_RELOAD_TIMEOUT_MS);
      } catch (e) {
        const err = 'navigate aircraft page failed: ' + ((e && e.message) || String(e));
        results.push({ legIdx: i, seq, ok: false, error: err });
        progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: err });
        if (i < total - 1) {
          await new Promise((r) => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
        }
        continue;
      }

      const taggedLeg = Object.assign({}, leg, {
        _batch: { idx: i, total, batchId, aircraftId: req.aircraftId }
      });

      try {
        const fillResp = await _sendTabMessageWhenReady(
          tab.id,
          { type: 'aes:afp:fill-and-submit', leg: taggedLeg },
          AFP_BATCH_FILL_TIMEOUT_MS,
          AFP_CONTENT_READY_TIMEOUT_MS
        );
        if (!fillResp || !fillResp.ok) {
          const err = (fillResp && fillResp.error) || 'fill returned no/non-ok';
          results.push({ legIdx: i, seq, ok: false, error: err });
          progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: err });
        } else if (fillResp.posting) {
          try {
            if (fillResp.fetch) {
              await new Promise((resolve, reject) => {
                chrome.tabs.reload(tab.id, {}, () => {
                  const err = chrome.runtime.lastError;
                  if (err) reject(new Error(err.message));
                  else resolve();
                });
              });
            }
            await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
            progress({ phase: 'flight-created', legIdx: i, seq });
            const scheduled = await _afpApplySchedulingForLeg(tab.id, host, req, taggedLeg, knownFlightIds);
            if (scheduled && scheduled.ok) {
              results.push({
                legIdx: i,
                seq,
                ok: true,
                flightNumberText: taggedLeg.flightNumberText || null,
                flightId: scheduled.flightId || null,
                verifyWarning: scheduled.verifyWarning || null
              });
              progress({
                phase: 'schedule-applied',
                legIdx: i,
                seq,
                flightNumberText: taggedLeg.flightNumberText || null,
                flightId: scheduled.flightId || null,
                verifyWarning: scheduled.verifyWarning || null
              });
              progress({
                phase: 'leg-done',
                legIdx: i,
                seq,
                ok: true,
                flightNumberText: taggedLeg.flightNumberText || null,
                flightId: scheduled.flightId || null,
                verifyWarning: scheduled.verifyWarning || null
              });
            } else {
              const err = (scheduled && scheduled.error) || 'schedule apply failed';
              results.push({
                legIdx: i,
                seq,
                ok: false,
                error: err,
                flightNumberText: taggedLeg.flightNumberText || null,
                flightId: scheduled && scheduled.flightId
              });
              progress({
                phase: 'leg-done',
                legIdx: i,
                seq,
                ok: false,
                error: err,
                flightNumberText: taggedLeg.flightNumberText || null,
                flightId: scheduled && scheduled.flightId
              });
            }
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
          try {
            const scheduled = await _afpAssignCreatedFlight(tab.id, taggedLeg, AFP_BATCH_RELOAD_TIMEOUT_MS);
            if (scheduled && scheduled.ok) {
              results.push({ legIdx: i, seq, ok: true, posting: false, flightNumberText: scheduled.flightNumberText || null });
              progress({ phase: 'leg-done', legIdx: i, seq, ok: true, posting: false, flightNumberText: scheduled.flightNumberText || null });
            } else {
              const err = (scheduled && scheduled.error) || 'schedule apply failed';
              results.push({ legIdx: i, seq, ok: false, posting: false, error: err, flightNumberText: scheduled && scheduled.flightNumberText });
              progress({ phase: 'leg-done', legIdx: i, seq, ok: false, posting: false, error: err, flightNumberText: scheduled && scheduled.flightNumberText });
            }
          } catch (e) {
            const err = (e && e.message) || String(e);
            results.push({ legIdx: i, seq, ok: false, posting: false, error: err });
            progress({ phase: 'leg-done', legIdx: i, seq, ok: false, posting: false, error: err });
          }
        }
      } catch (e) {
        const err = (e && e.message) || String(e);
        if (_afpLikelyPostNavigationMessageClose(e)) {
          try {
            await _waitForTabComplete(tab.id, AFP_BATCH_RELOAD_TIMEOUT_MS);
            progress({ phase: 'flight-created', legIdx: i, seq, inferredFromNavigation: true });
            let scheduled = null;
            try {
              const verified = await _afpVerifyScheduledFlightInTab(tab.id, taggedLeg);
              if (verified && verified.ok) {
                scheduled = {
                  ok: true,
                  verifiedAfterNavigation: true,
                  flightNumberText: verified.flightNumberText || taggedLeg.flightNumberText || null
                };
              }
            } catch (_) {
              scheduled = null;
            }
            if (!scheduled) {
              scheduled = await _afpApplySchedulingForLeg(tab.id, host, req, taggedLeg, knownFlightIds);
            }
            if (scheduled && scheduled.ok) {
              results.push({
                legIdx: i,
                seq,
                ok: true,
                inferredFromNavigation: true,
                verifiedAfterNavigation: !!scheduled.verifiedAfterNavigation,
                flightNumberText: scheduled.flightNumberText || taggedLeg.flightNumberText || null,
                flightId: scheduled.flightId || null,
                verifyWarning: scheduled.verifyWarning || null
              });
              progress({
                phase: 'leg-done',
                legIdx: i,
                seq,
                ok: true,
                inferredFromNavigation: true,
                verifiedAfterNavigation: !!scheduled.verifiedAfterNavigation,
                flightNumberText: scheduled.flightNumberText || taggedLeg.flightNumberText || null,
                flightId: scheduled.flightId || null,
                verifyWarning: scheduled.verifyWarning || null
              });
            } else {
              const assignErr = (scheduled && scheduled.error) || err;
              results.push({ legIdx: i, seq, ok: false, error: assignErr, inferredFromNavigation: true });
              progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: assignErr, inferredFromNavigation: true });
            }
            if (i < total - 1) {
              await new Promise((r) => setTimeout(r, AFP_BATCH_INTER_LEG_DELAY_MS));
            }
            continue;
          } catch (re) {
            const reloadErr = 'message channel closed and reload did not complete: '
              + ((re && re.message) || re);
            results.push({ legIdx: i, seq, ok: false, error: reloadErr });
            progress({ phase: 'leg-done', legIdx: i, seq, ok: false, error: reloadErr });
            continue;
          }
        }
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
            const deleted = await _afpVerifyFlightNumberDeleted(tab.id, host, flightId);
            if (deleted && deleted.ok) {
              results.push({ flightIdx: i, flightId, ok: true });
              progress({ phase: 'flight-done', flightIdx: i, flightId, ok: true });
            } else {
              const err = (deleted && deleted.error) || 'delete verification failed';
              results.push({ flightIdx: i, flightId, ok: false, error: err });
              progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err });
            }
          } catch (e) {
            const err = 'post-delete reload did not complete: ' + ((e && e.message) || String(e));
            results.push({ flightIdx: i, flightId, ok: false, error: err });
            progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, error: err });
          }
        } else {
          const deleted = await _afpVerifyFlightNumberDeleted(tab.id, host, flightId);
          if (deleted && deleted.ok) {
            results.push({ flightIdx: i, flightId, ok: true, posting: false });
            progress({ phase: 'flight-done', flightIdx: i, flightId, ok: true, posting: false });
          } else {
            const err = (deleted && deleted.error) || 'delete verification failed';
            results.push({ flightIdx: i, flightId, ok: false, posting: false, error: err });
            progress({ phase: 'flight-done', flightIdx: i, flightId, ok: false, posting: false, error: err });
          }
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
    .then((resp) => _afpPersistBatchResult('apply', msg, resp))
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => {
      const resp = { ok: false, batchId: msg.batchId, error: (err && err.message) || String(err) };
      _afpPersistBatchResult('apply', msg, resp)
        .then((stored) => { try { sendResponse(stored); } catch (_) {} })
        .catch(() => { try { sendResponse(resp); } catch (_) {} });
    });
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
