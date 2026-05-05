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
 *     ticked within ~0.9× the saved foreground cadence.
 *
 * The alarm is created when any legacy or account-scoped
 * `routeAssistant.pricing.silentAutoEnabled === true` and cleared when
 * they are all off. Period follows the shortest enabled
 * `silentAutoTickSec` (falling back to legacy `silentAutoTickMin`).
 * Foreground AS tabs can run as fast as 5 seconds; chrome.alarms remains
 * the coarse persistent safety net and is floored to 30 seconds by Chrome.
 * The receiving page still re-reads its own account-scoped settings before
 * running, so a global alarm cannot write for an account whose local gate
 * is off.
 */

const _AES_SILENT_AUTO_ALARM = 'aes:silent-auto:tick';

function _aesPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _aesRouteAssistantBlocks(settings) {
  const out = [];
  if (!_aesPlainObject(settings)) return out;
  if (_aesPlainObject(settings.routeAssistant)) out.push(settings.routeAssistant);
  if (_aesPlainObject(settings.acct)) {
    for (const id of Object.keys(settings.acct)) {
      const slot = settings.acct[id];
      if (_aesPlainObject(slot) && _aesPlainObject(slot.routeAssistant)) {
        out.push(slot.routeAssistant);
      }
    }
  }
  return out;
}

function _aesSilentAutoTickMin(pr) {
  const p = _aesPlainObject(pr) ? pr : {};
  const rawSec = (typeof p.silentAutoTickSec === 'number' && isFinite(p.silentAutoTickSec))
    ? p.silentAutoTickSec
    : (typeof p.silentAutoTickSeconds === 'number' && isFinite(p.silentAutoTickSeconds))
      ? p.silentAutoTickSeconds
      : null;
  if (rawSec && rawSec > 0) return Math.max(1 / 12, Math.min(240, rawSec / 60));
  const rawTick = (typeof p.silentAutoTickMin === 'number' && isFinite(p.silentAutoTickMin))
    ? p.silentAutoTickMin
    : 1 / 12;
  return Math.max(1 / 12, Math.min(240, rawTick));
}

function _aesSilentAutoConfigFromSettings(settings) {
  const blocks = _aesRouteAssistantBlocks(settings);
  let enabled = false;
  let tickMin = 1 / 12;
  let sawEnabled = false;
  for (const ra of blocks) {
    const pr = _aesPlainObject(ra.pricing) ? ra.pricing : {};
    const clampedTick = _aesSilentAutoTickMin(pr);
    if (pr.silentAutoEnabled) {
      enabled = true;
      tickMin = sawEnabled ? Math.min(tickMin, clampedTick) : clampedTick;
      sawEnabled = true;
    }
  }
  return { enabled, tickMin };
}

async function _aesReadSilentAutoConfig() {
  try {
    const got = await chrome.storage.local.get('settings');
    return _aesSilentAutoConfigFromSettings(got && got.settings);
  } catch (_) {
    return { enabled: false, tickMin: 1 / 12 };
  }
}

async function _aesSyncSilentAutoAlarm() {
  if (!chrome.alarms) return;
  try {
    const cfg = await _aesReadSilentAutoConfig();
    const existing = await chrome.alarms.get(_AES_SILENT_AUTO_ALARM);
    const alarmTickMin = Math.max(0.5, cfg.tickMin);
    if (cfg.enabled) {
      if (!existing || existing.periodInMinutes !== alarmTickMin) {
        await chrome.alarms.clear(_AES_SILENT_AUTO_ALARM);
        chrome.alarms.create(_AES_SILENT_AUTO_ALARM, {
          periodInMinutes: alarmTickMin,
          delayInMinutes:  alarmTickMin
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
  const oldCfg = _aesSilentAutoConfigFromSettings(changes.settings.oldValue);
  const newCfg = _aesSilentAutoConfigFromSettings(changes.settings.newValue);
  if (oldCfg.enabled === newCfg.enabled && oldCfg.tickMin === newCfg.tickMin) return;
  _aesSyncSilentAutoAlarm();
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== _AES_SILENT_AUTO_ALARM) return;
    // Broadcast to ONE capable AS tab only — sending to every tab races
    // on the per-tick dedup read (each surface reads `silentAutoLastTickAt`
    // before the others' write has landed). Scheduling tabs run the Route
    // Assistant panel path; dashboard, market-analysis, and fleet tabs run
    // the cached-route automator. Picking the most-recently-active capable
    // tab matches the user's attention; falls back to the first match.
    chrome.tabs.query(
      { url: 'https://*.airlinesim.aero/*' },
      (tabs) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) { void lastErr; return; }
        if (!tabs || !tabs.length) return;
        const capable = tabs.filter((t) =>
          /\/app\/com\/scheduling(?:\/|$)/.test(t.url || '')
          || /\/app\/enterprise\/dashboard/.test(t.url || '')
          || /\/app\/com\/markets\//.test(t.url || '')
          || /\/app\/fleets(?:\/|$)/.test(t.url || '')
        );
        if (!capable.length) return;
        const sorted = capable.slice().sort(
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
