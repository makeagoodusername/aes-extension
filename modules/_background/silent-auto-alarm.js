'use strict';

/**
 * Auto-Pricing Tier 3.3b — silent-auto chrome.alarms heartbeat.
 *
 * The panel runs `setInterval` in-page for in-tab cadence; the alarm
 * here is the persistent + cross-tab driver. Benefits over setInterval
 * alone:
 *   - Survives MV3 service-worker restarts (alarms persist)
 *   - Anchors cadence to wall-clock instead of panel mount time, so
 *     reopening a scheduling tab mid-cycle doesn't reset the clock
 *   - Cross-tab dedup: multiple scheduling tabs each receive the
 *     broadcast, but the panel's `_silentAutoTickIfDue` re-reads the
 *     persisted `silentAutoLastTickAt` and skips if another tab already
 *     ticked within ~0.9× tickMin.
 *
 * The alarm is created when `settings.routeAssistant.pricing
 * .silentAutoEnabled === true` and cleared when it flips off. Period
 * follows `silentAutoTickMin` (clamped 5–240 min, matching the panel).
 */

const _AES_SILENT_AUTO_ALARM = 'aes:silent-auto:tick';

async function _aesReadSilentAutoConfig() {
  try {
    const got = await chrome.storage.local.get('settings');
    const ra  = (got && got.settings && got.settings.routeAssistant) || {};
    const pr  = ra.pricing || {};
    const tickMin = (typeof pr.silentAutoTickMin === 'number' && isFinite(pr.silentAutoTickMin))
      ? Math.max(5, Math.min(240, pr.silentAutoTickMin))
      : 30;
    return { enabled: !!pr.silentAutoEnabled, tickMin };
  } catch (_) {
    return { enabled: false, tickMin: 30 };
  }
}

async function _aesSyncSilentAutoAlarm() {
  if (!chrome.alarms) return;
  try {
    const cfg = await _aesReadSilentAutoConfig();
    const existing = await chrome.alarms.get(_AES_SILENT_AUTO_ALARM);
    if (cfg.enabled) {
      if (!existing || existing.periodInMinutes !== cfg.tickMin) {
        await chrome.alarms.clear(_AES_SILENT_AUTO_ALARM);
        chrome.alarms.create(_AES_SILENT_AUTO_ALARM, {
          periodInMinutes: cfg.tickMin,
          delayInMinutes:  cfg.tickMin
        });
      }
    } else if (existing) {
      await chrome.alarms.clear(_AES_SILENT_AUTO_ALARM);
    }
  } catch (e) {
    console.warn('[AES silent-auto] alarm sync threw', e);
  }
}

chrome.runtime.onInstalled.addListener(() => { _aesSyncSilentAutoAlarm(); });
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { _aesSyncSilentAutoAlarm(); });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.settings) return;
  const oldS = changes.settings.oldValue, newS = changes.settings.newValue;
  const oldP = (oldS && oldS.routeAssistant && oldS.routeAssistant.pricing) || {};
  const newP = (newS && newS.routeAssistant && newS.routeAssistant.pricing) || {};
  if (oldP.silentAutoEnabled === newP.silentAutoEnabled
      && oldP.silentAutoTickMin === newP.silentAutoTickMin) return;
  _aesSyncSilentAutoAlarm();
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== _AES_SILENT_AUTO_ALARM) return;
    // Broadcast to ONE scheduling tab only — sending to every tab races
    // on the per-tick dedup read (each panel reads `silentAutoLastTickAt`
    // before the others' write has landed). Picking the most-recently-
    // active tab matches the user's attention; falls back to the first
    // match. The chosen panel's own setInterval covers the rare case
    // where the picked tab is unresponsive.
    chrome.tabs.query(
      { url: 'https://*.airlinesim.aero/app/com/scheduling/*' },
      (tabs) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) { void lastErr; return; }
        if (!tabs || !tabs.length) return;
        const sorted = tabs.slice().sort(
          (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
        );
        const target = sorted[0];
        if (!target || !target.id) return;
        chrome.tabs.sendMessage(
          target.id,
          { type: 'aes:silent-auto:tick', firedAt: Date.now() },
          () => void chrome.runtime.lastError
        );
      }
    );
  });
}
