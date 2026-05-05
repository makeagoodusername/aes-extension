'use strict';

/**
 * Small tab lifecycle bridge for content-script scrape helpers.
 *
 * Some browser contexts refuse `window.close()` even after a scrape finishes
 * successfully. The service worker has `tabs` permission, so content scripts
 * can request closure of their own sender tab without broad tab lookups.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:tab:close-self') return false;

  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') {
    sendResponse({ ok: false, reason: 'no-sender-tab' });
    return false;
  }

  // Acknowledge before closing the sender tab; otherwise closing the tab can
  // tear down the response port and surface a false-negative lastError.
  sendResponse({ ok: true, closing: true });
  setTimeout(() => {
    try {
      chrome.tabs.remove(tabId, () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn('[bg] tab close failed', err.message);
      });
    } catch (e) {
      console.warn('[bg] tab close threw', e);
    }
  }, 0);
  return false;
});
