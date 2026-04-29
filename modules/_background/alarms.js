'use strict';

/**
 * Service-worker alarms registration:
 *   - aes-cleanup     — 6h periodic AesCleanup.runAll() sweep
 *   - aes-auto-drive  — 5min nudge to any open AS dashboard tab
 *
 * The auto-drive content listener lives in
 * modules/scrape-orchestrator/auto-driver.js (loaded as a content
 * script on the dashboard match block). It does the staleness math +
 * min-gap throttle; this alarm just sends `aes:auto-drive:tick` so the
 * tab considers running its most-overdue phase.
 *
 * AesCleanup is provided by modules/_shared/cleanup-registry.js, which
 * the SW imports earlier in boot.
 */

const _AES_CLEANUP_ALARM    = 'aes-cleanup';
const _AES_AUTO_DRIVE_ALARM = 'aes-auto-drive';

if (chrome.alarms) {
  // chrome.alarms.create overwrites by name → idempotent.
  // 6h cleanup matches the ~6h fuel-price freshness window.
  chrome.alarms.create(_AES_CLEANUP_ALARM,    { periodInMinutes: 360 });
  chrome.alarms.create(_AES_AUTO_DRIVE_ALARM, { periodInMinutes: 5 });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === _AES_CLEANUP_ALARM) {
      if (typeof AesCleanup === 'undefined' || !AesCleanup.runAll) return;
      AesCleanup.runAll({ reason: 'alarm' }).catch((err) =>
        console.warn('[AES cleanup] alarm runAll failed', err));
      return;
    }
    if (alarm.name === _AES_AUTO_DRIVE_ALARM) {
      try {
        chrome.tabs.query({ url: 'https://*.airlinesim.aero/*' }, (tabs) => {
          if (chrome.runtime.lastError || !tabs || !tabs.length) return;
          const target = tabs.find((t) => /\/app\/enterprise\/dashboard/.test(t.url || ''))
            || tabs[0];
          if (!target || target.id == null) return;
          try {
            chrome.tabs.sendMessage(target.id, { type: 'aes:auto-drive:tick' }, () => {
              void chrome.runtime.lastError;
            });
          } catch (_) {}
        });
      } catch (_) {}
      return;
    }
  });
}
