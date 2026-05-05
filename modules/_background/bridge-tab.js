'use strict';

/**
 * Command Bridge — open / focus extension page (slice CB-3).
 *
 * The Bridge page lives at chrome-extension://<id>/bridge.html. From a
 * content script, plain window.open(...) creates a duplicate tab on
 * every menu click; chrome.tabs.query is gated to background-context
 * scripts. This handler dedupes across all tabs: if any tab is already
 * pointing at the Bridge URL it gets focused (window-and-tab); otherwise
 * a fresh tab is created.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:bridge:open') return false;
  const url = chrome.runtime.getURL('bridge.html');
  chrome.tabs.query({ url }, (tabs) => {
    const lastErr = chrome.runtime.lastError;
    if (lastErr) {
      try { sendResponse({ ok: false, error: lastErr.message || 'tabs.query failed' }); } catch (_) {}
      return;
    }
    const found = (tabs || []).find((t) => t && t.id != null);
    if (found) {
      const finish = () => {
        try { sendResponse({ ok: true, tabId: found.id, focused: true }); } catch (_) {}
      };
      try {
        chrome.tabs.update(found.id, { active: true }, () => {
          if (chrome.runtime.lastError) { finish(); return; }
          if (found.windowId != null && chrome.windows && chrome.windows.update) {
            chrome.windows.update(found.windowId, { focused: true }, () => { finish(); });
          } else { finish(); }
        });
      } catch (_) { finish(); }
      return;
    }
    try {
      chrome.tabs.create({ url, active: true }, (t) => {
        if (chrome.runtime.lastError) {
          try { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); } catch (_) {}
          return;
        }
        try { sendResponse({ ok: true, tabId: t && t.id, focused: false }); } catch (_) {}
      });
    } catch (e) {
      try { sendResponse({ ok: false, error: (e && e.message) || String(e) }); } catch (_) {}
    }
  });
  return true;
});
