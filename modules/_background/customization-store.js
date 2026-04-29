'use strict';

/**
 * Customization store — single-writer queue for the dedicated
 * chrome.storage.local["customization"] blob. Mirrors the aesAccounts
 * pattern so concurrent tabs (color-picker drags from the Studio in one
 * tab, theme switch in another) cannot lose writes.
 *
 * Patches are shallow-merged. Special sentinels:
 *   - `null` at any leaf  → delete that key
 *   - `"__CLEAR__"` for an object branch  → replace with {}
 */

let _aesCustomizationQueue = Promise.resolve();

function _aesCustomizationPatchCore(req) {
  return _aesCustomizationQueue = _aesCustomizationQueue
    .catch(() => null)
    .then(() => _aesCustomizationPatchApply(req));
}

function _aesCustomizationMerge(base, patch) {
  if (patch === '__CLEAR__') return {};
  if (patch === null) return null;
  if (typeof patch !== 'object') return patch;
  const out = (base && typeof base === 'object') ? Object.assign({}, base) : {};
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
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'missing patch' };
  }
  const data = await chrome.storage.local.get(['customization']);
  const blob = data.customization && typeof data.customization === 'object'
    ? data.customization
    : { schemaVersion: 1, active: { presetId: 'default' }, presets: {}, scopes: { global: {} }, shortcuts: {} };
  const next = _aesCustomizationMerge(blob, patch) || {};
  if (!next.schemaVersion) next.schemaVersion = 1;
  await chrome.storage.local.set({ customization: next });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:customization:patch') return false;
  _aesCustomizationPatchCore(msg)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});
