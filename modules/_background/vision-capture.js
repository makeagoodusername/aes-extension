'use strict';

/**
 * Vision API — page-screenshot bridge for the future LLM co-pilot,
 * visual scrape fallback paths, and any module that wants to capture
 * the current AS view as a PNG.
 *
 * Runs in the SW because chrome.tabs.captureVisibleTab is only
 * available to background contexts. The content script asks via
 * `aes:vision:capture-tab`; we return a base64 data URL.
 *
 * Permissions already cover this: `tabs` + the AS host_permissions
 * give captureVisibleTab access to AS pages without prompting. Format
 * defaults to PNG; quality is jpeg-only and ignored for png. Single
 * in-flight per window — Chrome's API serialises calls inside
 * captureVisibleTab itself, so we don't queue here.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:vision:capture-tab') return false;
  const opts = (msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
  const captureOpts = { format };
  if (format === 'jpeg' && Number.isFinite(opts.quality)) {
    captureOpts.quality = Math.max(1, Math.min(100, Math.round(opts.quality)));
  }
  const windowId = sender && sender.tab && sender.tab.windowId;
  const cb = (dataUrl) => {
    const lastErr = chrome.runtime.lastError;
    if (lastErr || !dataUrl) {
      try { sendResponse({ ok: false, error: (lastErr && lastErr.message) || 'captureVisibleTab returned empty' }); } catch (_) {}
      return;
    }
    try { sendResponse({ ok: true, dataUrl, format, capturedAt: Date.now() }); } catch (_) {}
  };
  try {
    if (windowId != null && chrome.tabs.captureVisibleTab.length >= 3) {
      chrome.tabs.captureVisibleTab(windowId, captureOpts, cb);
    } else {
      chrome.tabs.captureVisibleTab(captureOpts, cb);
    }
  } catch (e) {
    try { sendResponse({ ok: false, error: (e && e.message) || String(e) }); } catch (_) {}
  }
  return true;
});
