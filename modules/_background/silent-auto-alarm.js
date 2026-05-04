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
 * The alarm is created when any legacy or account-scoped
 * `routeAssistant.pricing.silentAutoEnabled === true` and cleared when
 * they are all off. Period follows the shortest enabled
 * `silentAutoTickMin` (clamped 5–240 min, matching the panel). The
 * receiving page still re-reads its own account-scoped settings before
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

function _aesSilentAutoConfigFromSettings(settings) {
  const blocks = _aesRouteAssistantBlocks(settings);
  let enabled = false;
  let tickMin = 30;
  let sawEnabled = false;
  for (const ra of blocks) {
    const pr = _aesPlainObject(ra.pricing) ? ra.pricing : {};
    const rawTick = (typeof pr.silentAutoTickMin === 'number' && isFinite(pr.silentAutoTickMin))
      ? pr.silentAutoTickMin
      : 30;
    const clampedTick = Math.max(5, Math.min(240, rawTick));
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
    // Assistant panel path; dashboard tabs run the Central Hub cached-route
    // automator. Picking the most-recently-active capable tab matches the
    // user's attention; falls back to the first match.
    chrome.tabs.query(
      { url: 'https://*.airlinesim.aero/*' },
      (tabs) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) { void lastErr; return; }
        if (!tabs || !tabs.length) return;
        const capable = tabs.filter((t) =>
          /\/app\/com\/scheduling(?:\/|$)/.test(t.url || '')
          || /\/app\/enterprise\/dashboard/.test(t.url || '')
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
