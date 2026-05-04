'use strict';

/**
 * Site-skin live sync bridge.
 *
 * In live verification, content-script worlds on open AirlineSim tabs did not
 * reliably receive `chrome.storage.onChanged` for sync writes initiated from
 * extension pages like options.html. The SW sees the sync write, so fan it out
 * explicitly to every open AS tab and let the page-local bootstrap re-apply.
 */

(function () {
  if (globalThis.__aesSiteSkinSyncInstalled) return;
  globalThis.__aesSiteSkinSyncInstalled = true;

  const SKIN_KEY = 'aes_skin_enabled';
  const DENSITY_KEY = 'aes_skin_density';

  function broadcast(message) {
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') return;
    chrome.tabs.query({
      url: [
        'https://*.airlinesim.aero/app/*',
        'https://*.airlinesim.aero/action/*'
      ]
    }, (tabs) => {
      if (chrome.runtime.lastError) return;
      (tabs || []).forEach((tab) => {
        if (!tab || tab.id == null) return;
        try {
          chrome.tabs.sendMessage(tab.id, message, () => void chrome.runtime.lastError);
        } catch (_) { /* noop */ }
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes) return;
    if (!changes[SKIN_KEY] && !changes[DENSITY_KEY]) return;

    const message = {type: 'aes:site-skin:update'};
    if (changes[SKIN_KEY]) {
      message.enabled = changes[SKIN_KEY].newValue !== false;
    }
    if (changes[DENSITY_KEY]) {
      message.density = changes[DENSITY_KEY].newValue === 'compact'
        ? 'compact'
        : 'comfortable';
    }
    broadcast(message);
  });
})();
