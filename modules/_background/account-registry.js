'use strict';

/**
 * L1 — account-registry single-writer.
 *
 * HANDOVER §10 invariant: only this handler ever writes the `aesAccounts`
 * blob. Content scripts compute the canonical accountId
 * (sha1(server:airlineIdentity).slice(0,12)) on every AS page mount and
 * send `aes:account:touch`; this handler upserts the registry in a
 * single chrome.storage.local.get → merge → set, so concurrent pages
 * touching the same blob don't lose updates.
 *
 * Touches are serialised through a single tail Promise. Without it, two
 * pages racing the blob (read empty, both add, last write wins) would
 * lose one of the touches.
 *
 * L2.2 migration helpers share the same tail so writes can't race the
 * touch handler — all writes to `aesAccounts` funnel through one tail
 * per HANDOVER §10 single-writer rule.
 */

let _aesAccountTouchQueue = Promise.resolve();

function _aesAccountTouchCore(req) {
  return _aesAccountTouchQueue = _aesAccountTouchQueue
    .catch(() => null)
    .then(() => _aesAccountTouchApply(req));
}

async function _aesAccountTouchApply(req) {
  const server   = String(req.server || '').toLowerCase().trim();
  const identity = String(req.airlineIdentity || '').trim();
  if (!server || !identity) return { ok: false, error: 'missing server or airlineIdentity' };

  // Compute the same id the content-side AesAccountRegistry.computeId
  // produces. Both sides MUST match — duplicating the digest here lets
  // the background be the single authority that confirms the id.
  const norm = server + ':' + identity;
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
    id:              accountId,
    server,
    airlineIdentity: identity,
    displayName:     String(req.displayName || identity),
    firstSeenAt:     (prior && prior.firstSeenAt) ? prior.firstSeenAt : now,
    lastSeenAt:      now,
    credentials:     (prior && prior.credentials) || null
  };

  // Link captured credentials if they are fresh (e.g. within last 2 minutes)
  if (_aesVaultCredentials && (Date.now() - _aesVaultCredentials.capturedAt) < 120000) {
      accounts[accountId].credentials = {
          username: _aesVaultCredentials.username,
          password: _aesVaultCredentials.password
      };
      _aesVaultCredentials = null; // Clear after linking
  }
  // migrationVersion stays 0 until L2's migration shim copies legacy
  // Class B/C/D keys into their `:acct:<id>:` namespaced form. Stores
  // gate their legacy-fallback reads on (version < 1).
  const next = {
    migrationVersion: Number(blob.migrationVersion) || 0,
    viewingAccountId: accountId,
    accounts
  };
  await chrome.storage.local.set({ aesAccounts: next });
  return { ok: true, accountId };
}

function _aesMigrationSetVersionCore(req) {
  return _aesAccountTouchQueue = _aesAccountTouchQueue
    .catch(() => null)
    .then(() => _aesMigrationSetVersionApply(req));
}

async function _aesMigrationSetVersionApply(req) {
  const v = Number(req.version);
  if (!isFinite(v) || v < 0) return { ok: false, error: 'invalid version' };
  const data = await chrome.storage.local.get(['aesAccounts']);
  const blob = data.aesAccounts || {};
  const next = Object.assign({}, blob, { migrationVersion: v });
  // Clearing pending whenever version moves forward — a successful
  // migration supersedes any stale "pending" flag from an earlier run.
  if (v >= 1 && next.migrationPending) delete next.migrationPending;
  await chrome.storage.local.set({ aesAccounts: next });
  return { ok: true, version: v };
}

function _aesMigrationSetPendingCore(req) {
  return _aesAccountTouchQueue = _aesAccountTouchQueue
    .catch(() => null)
    .then(() => _aesMigrationSetPendingApply(req));
}

async function _aesMigrationSetPendingApply(req) {
  const data = await chrome.storage.local.get(['aesAccounts']);
  const blob = data.aesAccounts || {};
  const next = Object.assign({}, blob, { migrationPending: !!req.pending });
  await chrome.storage.local.set({ aesAccounts: next });
  return { ok: true, pending: !!req.pending };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:account:touch') return false;
  _aesAccountTouchCore(msg)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:migration:set-version') return false;
  _aesMigrationSetVersionCore(msg)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:migration:set-pending') return false;
  _aesMigrationSetPendingCore(msg)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

let _aesVaultCredentials = null;
let _aesPreparedLogin = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'aes:vault:save-credentials') {
    _aesVaultCredentials = {
      username: msg.username,
      password: msg.password,
      capturedAt: Date.now()
    };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'aes:vault:prepare-login') {
    _aesPreparedLogin = {
        username: msg.username,
        password: msg.password,
        preparedAt: Date.now()
    };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'aes:vault:get-prepared-login') {
      if (_aesPreparedLogin && (Date.now() - _aesPreparedLogin.preparedAt) < 60000) {
          sendResponse({
              username: _aesPreparedLogin.username,
              password: _aesPreparedLogin.password
          });
          _aesPreparedLogin = null; // Clear after retrieving
      } else {
          sendResponse({ ok: false });
      }
      return true;
  }

  return false;
});
