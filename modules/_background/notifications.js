'use strict';

/**
 * Q16 long-op notification bridge. Content scripts can't always reach
 * chrome.notifications directly in MV3, so the panel forwards long-op
 * completion pings here. The background SW has the `notifications`
 * permission and creates the system notification on the panel's behalf.
 * Click on the notification focuses the originating tab when available.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:notify:long-op') return false;
  if (!chrome.notifications || typeof chrome.notifications.create !== 'function') {
    sendResponse({ ok: false, error: 'notifications API unavailable' });
    return false;
  }
  const senderTabId = sender && sender.tab && sender.tab.id;
  const opts = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('images/AES-logo-128.png'),
    title: String(msg.title || 'AES — long op complete'),
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
        if (senderTabId != null) {
          try {
            chrome.tabs.update(senderTabId, { active: true }, () => void chrome.runtime.lastError);
          } catch (_) {}
        }
      });
      chrome.notifications._aesLongOpClickWired = true;
    }
    sendResponse({ ok: true, id: notifId });
  } catch (e) {
    sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
  return false;
});
