'use strict';

/**
 * Scrape-everything orchestrator — message routing.
 *
 * Forwards `aes:scrape-all:*` content-script messages to the
 * `globalThis.ScrapeTabPool` singleton imported earlier in the SW boot
 * (modules/scrape-orchestrator/background-tab-pool.js). When the pool
 * isn't loaded we fail closed with `tab-pool-not-loaded`.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:start') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ ok: false, reason: 'tab-pool-not-loaded' });
    return false;
  }
  const senderTabId = sender && sender.tab && sender.tab.id;
  const opts = {
    senderTabId,
    concurrency: msg.concurrency,
    staggerMs: msg.staggerMs
  };
  ScrapeTabPool.startRun(msg.plan || [], opts)
    .then((resp) => { try { sendResponse(resp); } catch (_) {} })
    .catch((err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (_) {} });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:abort') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ ok: false, reason: 'tab-pool-not-loaded' });
    return false;
  }
  try { sendResponse(ScrapeTabPool.abortRun()); } catch (_) {}
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:status') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ ok: false, reason: 'tab-pool-not-loaded' });
    return false;
  }
  try { sendResponse({ ok: true, status: ScrapeTabPool.getStatus() }); } catch (_) {}
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'aes:scrape-all:reset-breaker') return false;
  if (typeof globalThis.ScrapeTabPool !== 'object') {
    sendResponse({ ok: false, reason: 'tab-pool-not-loaded' });
    return false;
  }
  try { sendResponse(ScrapeTabPool.resetBreaker()); } catch (_) {}
  return false;
});
