'use strict';

/**
 * Hidden-tab orchestrator for AirlineSim flight-number groups.
 *
 * Public runtime messages:
 *   aes:flight-numbers:ensure-group
 *     {groupName, active?}
 *       Opens /app/com/numbers, snapshots the live AS DOM, creates the
 *       group when missing, waits for the reload, and snapshots again.
 *
 *   aes:flight-numbers:organize
 *     {groupName, flightIds?, flightNumbers?, checkboxValues?, allVisible?,
 *      allowPartial?, active?}
 *       Ensures the group exists, then sorts matching visible rows into it.
 *
 * The content script does every form lookup from the current DOM. This
 * module never synthesizes Wicket action URLs; the browser page remains
 * the source of truth before and after each mutation.
 */

const FNG_INITIAL_LOAD_TIMEOUT_MS = 60000;
const FNG_POST_LOAD_TIMEOUT_MS    = 30000;
const FNG_MESSAGE_TIMEOUT_MS      = 15000;

const _fngQueues = new Map(); // host -> promise tail

function _fngHostFromSender(sender) {
  try {
    if (sender && sender.tab && sender.tab.url) {
      const u = new URL(sender.tab.url);
      return u.protocol + '//' + u.host;
    }
  } catch (_) { /* fall through */ }
  return 'https://free1.airlinesim.aero';
}

function _fngCleanGroupName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 45);
}

function _fngNorm(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().toLowerCase();
}

function _fngWaitForTabComplete(tabId, timeoutMs) {
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

function _fngSendTabMessageWithTimeout(tabId, message, timeoutMs) {
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
        if (lastErr) reject(new Error(lastErr.message || 'sendMessage failed'));
        else resolve(resp);
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

function _fngCreateTab(url, active) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({url, active: !!active}, (tab) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) reject(new Error(lastErr.message || 'tabs.create failed'));
      else resolve(tab);
    });
  });
}

function _fngFindGroup(snapshot, groupName) {
  const name = _fngNorm(groupName);
  const groups = snapshot && Array.isArray(snapshot.groups) ? snapshot.groups : [];
  return groups.find(g => _fngNorm(g && g.name) === name) || null;
}

function _fngVisibleKeySet(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.visibleNumbers) ? snapshot.visibleNumbers : [];
  return {
    ids: rows.map(r => r && r.flightId).filter(v => v != null).map(String),
    numbers: rows.map(r => r && r.flightNumber).filter(v => v != null).map(String),
    checks: rows.map(r => r && r.checkboxValue).filter(v => v != null).map(String)
  };
}

function _fngTargetsFromReq(req) {
  return {
    ids: (req.flightIds || req.flightNumberIds || []).filter(v => v != null).map(String),
    numbers: (req.flightNumbers || req.numbers || []).filter(v => v != null).map(v => String(v).trim()),
    checks: (req.checkboxValues || []).filter(v => v != null).map(String),
    allVisible: !!req.allVisible
  };
}

function _fngPlanVisibleTargets(snapshot, req) {
  const rows = snapshot && Array.isArray(snapshot.visibleNumbers) ? snapshot.visibleNumbers : [];
  const targets = _fngTargetsFromReq(req || {});
  const idSet = new Set(targets.ids);
  const numSet = new Set(targets.numbers);
  const checkSet = new Set(targets.checks);
  const matched = rows.filter((r) => targets.allVisible
    || (r && r.flightId != null && idSet.has(String(r.flightId)))
    || (r && r.flightNumber != null && numSet.has(String(r.flightNumber)))
    || (r && r.checkboxValue != null && checkSet.has(String(r.checkboxValue))));

  const foundIds = new Set(matched.map(r => String(r && r.flightId)).filter(Boolean));
  const foundNums = new Set(matched.map(r => String(r && r.flightNumber)).filter(Boolean));
  const foundChecks = new Set(matched.map(r => String(r && r.checkboxValue)).filter(Boolean));
  const missing = {
    flightIds: targets.ids.filter(v => !foundIds.has(v)),
    flightNumbers: targets.numbers.filter(v => !foundNums.has(v)),
    checkboxValues: targets.checks.filter(v => !foundChecks.has(v))
  };
  const hasMissing = !!(missing.flightIds.length || missing.flightNumbers.length || missing.checkboxValues.length);
  return {matched, missing, hasMissing, allVisible: targets.allVisible};
}

function _fngRemainingTargets(afterSnapshot, req, beforeMatched) {
  if (req.allVisible) {
    const beforeIds = new Set((beforeMatched || []).map(r => r && r.flightId).filter(Boolean).map(String));
    const beforeNumbers = new Set((beforeMatched || []).map(r => r && r.flightNumber).filter(Boolean).map(String));
    const beforeChecks = new Set((beforeMatched || []).map(r => r && r.checkboxValue).filter(Boolean).map(String));
    const afterRows = afterSnapshot && Array.isArray(afterSnapshot.visibleNumbers) ? afterSnapshot.visibleNumbers : [];
    return afterRows.filter(r =>
      (r && r.flightId != null && beforeIds.has(String(r.flightId)))
      || (r && r.flightNumber != null && beforeNumbers.has(String(r.flightNumber)))
      || (r && r.checkboxValue != null && beforeChecks.has(String(r.checkboxValue)))
    ).map(r => ({
      flightId: r.flightId || null,
      flightNumber: r.flightNumber || null,
      checkboxValue: r.checkboxValue || null
    }));
  }

  const visible = _fngVisibleKeySet(afterSnapshot);
  const visIds = new Set(visible.ids);
  const visNums = new Set(visible.numbers);
  const visChecks = new Set(visible.checks);
  const targets = _fngTargetsFromReq(req);
  return {
    flightIds: targets.ids.filter(v => visIds.has(v)),
    flightNumbers: targets.numbers.filter(v => visNums.has(v)),
    checkboxValues: targets.checks.filter(v => visChecks.has(v))
  };
}

function _fngHasRemainingTargets(remaining) {
  if (Array.isArray(remaining)) return remaining.length > 0;
  return !!(remaining && (
    (remaining.flightIds && remaining.flightIds.length)
    || (remaining.flightNumbers && remaining.flightNumbers.length)
    || (remaining.checkboxValues && remaining.checkboxValues.length)
  ));
}

async function _fngSnapshot(tabId) {
  const snap = await _fngSendTabMessageWithTimeout(
    tabId,
    {type: 'aes:flight-numbers:snapshot'},
    FNG_MESSAGE_TIMEOUT_MS
  );
  if (!snap || !snap.ok) throw new Error((snap && snap.error) || 'snapshot failed');
  if (!snap.isListPage) throw new Error('not on flight-number list page');
  return snap;
}

async function _fngEnsureGroupInTab(tabId, groupName) {
  const before = await _fngSnapshot(tabId);
  const existing = _fngFindGroup(before, groupName);
  if (existing) {
    return {ok: true, existed: true, group: existing, before, after: before};
  }

  const createResp = await _fngSendTabMessageWithTimeout(
    tabId,
    {type: 'aes:flight-numbers:create-group', groupName, confirm: true},
    FNG_MESSAGE_TIMEOUT_MS
  );
  if (!createResp || !createResp.ok) {
    return {ok: false, error: (createResp && createResp.error) || 'create-group failed', before};
  }
  if (createResp.exists) {
    return {ok: true, existed: true, group: createResp.group || null, before, after: createResp.snapshot || before};
  }
  if (createResp.posting) await _fngWaitForTabComplete(tabId, FNG_POST_LOAD_TIMEOUT_MS);

  const after = await _fngSnapshot(tabId);
  const created = _fngFindGroup(after, groupName);
  if (!created) return {ok: false, error: 'group create posted but group not found after reload', before, after};
  return {ok: true, existed: false, group: created, before, after};
}

async function _fngRunEnsure(req, sender) {
  const groupName = _fngCleanGroupName(req.groupName || req.name);
  if (!groupName) return {ok: false, error: 'ensure-group: missing groupName'};

  const host = _fngHostFromSender(sender);
  const tab = await _fngCreateTab(host + '/app/com/numbers', !!req.active);
  try {
    await _fngWaitForTabComplete(tab.id, FNG_INITIAL_LOAD_TIMEOUT_MS);
    const result = await _fngEnsureGroupInTab(tab.id, groupName);
    return Object.assign({groupName}, result);
  } catch (e) {
    return {ok: false, error: (e && e.message) || String(e), groupName};
  } finally {
    if (tab && tab.id != null && !req.keepTabOpen) {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

async function _fngRunOrganize(req, sender) {
  const groupName = _fngCleanGroupName(req.groupName || req.name);
  if (!groupName) return {ok: false, error: 'organize: missing groupName'};

  const targets = _fngTargetsFromReq(req);
  const hasTargets = targets.allVisible || targets.ids.length || targets.numbers.length || targets.checks.length;
  if (!hasTargets) return {ok: false, error: 'organize: no flight-number targets provided'};

  const host = _fngHostFromSender(sender);
  const tab = await _fngCreateTab(host + '/app/com/numbers', !!req.active);
  try {
    await _fngWaitForTabComplete(tab.id, FNG_INITIAL_LOAD_TIMEOUT_MS);

    const ensure = await _fngEnsureGroupInTab(tab.id, groupName);
    if (!ensure.ok) return Object.assign({groupName}, ensure);

    const sortResp = await _fngSendTabMessageWithTimeout(
      tab.id,
      Object.assign({}, req, {
        type: 'aes:flight-numbers:sort-visible-into-group',
        groupName,
        confirm: true
      }),
      FNG_MESSAGE_TIMEOUT_MS
    );
    if (!sortResp || !sortResp.ok) {
      return {
        ok: false,
        error: (sortResp && sortResp.error) || 'sort-visible-into-group failed',
        groupName,
        ensure,
        sort: sortResp || null
      };
    }
    if (sortResp.posting) await _fngWaitForTabComplete(tab.id, FNG_POST_LOAD_TIMEOUT_MS);

    const afterSort = await _fngSnapshot(tab.id);
    const remaining = _fngRemainingTargets(afterSort, req, sortResp.matched || []);
    const verified = !_fngHasRemainingTargets(remaining);
    return {
      ok: verified,
      verified,
      error: verified ? null : 'sort posted but one or more targets are still visible',
      groupName,
      group: ensure.group,
      ensure,
      sort: sortResp,
      afterSort,
      remainingVisibleTargets: remaining
    };
  } catch (e) {
    return {ok: false, error: (e && e.message) || String(e), groupName};
  } finally {
    if (tab && tab.id != null && !req.keepTabOpen) {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

function _fngEnqueue(req, sender, runner) {
  const key = _fngHostFromSender(sender);
  const tail = _fngQueues.get(key) || Promise.resolve();
  const next = tail.catch(() => null).then(() => runner(req, sender));
  _fngQueues.set(key, next);
  next.finally(() => {
    if (_fngQueues.get(key) === next) _fngQueues.delete(key);
  });
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:flight-numbers:ensure-group') return false;
  _fngEnqueue(msg, sender, _fngRunEnsure)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ok: false, error: (err && err.message) || String(err)}); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:flight-numbers:organize') return false;
  _fngEnqueue(msg, sender, _fngRunOrganize)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ok: false, error: (err && err.message) || String(err)}); } catch (_) {} });
  return true;
});
