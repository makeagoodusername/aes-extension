'use strict';

/**
 * Q16 long-op notification bridge. Content scripts can't always reach
 * chrome.notifications directly in MV3, so the panel forwards long-op
 * completion pings here. The background SW has the `notifications`
 * permission and creates the system notification on the panel's behalf.
 * Click on the notification focuses the originating tab when available.
 */

// notifId → senderTabId. Populated per-create, drained on click.
// Listener registered once per SW lifetime; closure-captured senderTabId
// from the first message would otherwise route every later click to the
// first sender's tab (F-7-009).
const _aesLongOpTabs = new Map();

if (chrome.notifications && chrome.notifications.onClicked && !chrome.notifications._aesLongOpClickWired) {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id || !id.startsWith('aes-long-op-')) return;
    const tabId = _aesLongOpTabs.get(id);
    _aesLongOpTabs.delete(id);
    chrome.notifications.clear(id);
    if (tabId != null) {
      try {
        chrome.tabs.update(tabId, { active: true }, () => void chrome.runtime.lastError);
      } catch (_) {}
    }
  });
  chrome.notifications._aesLongOpClickWired = true;
}

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
  const notifId = 'aes-long-op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    if (senderTabId != null) _aesLongOpTabs.set(notifId, senderTabId);
    chrome.notifications.create(notifId, opts, () => void chrome.runtime.lastError);
    // Bound the map: drop unread notifications after 10 min so a SW that
    // accumulates many never-clicked notifs doesn't grow unbounded.
    setTimeout(() => _aesLongOpTabs.delete(notifId), 10 * 60 * 1000);
    sendResponse({ ok: true, id: notifId });
  } catch (e) {
    sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
  return false;
});
