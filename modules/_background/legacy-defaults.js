'use strict';

/**
 * Legacy `settings` blob bootstrap. Runs on `chrome.runtime.onInstalled`
 * once and sets `chrome.storage.local.settings` to a default shape if the
 * user has no existing settings record. The blob is consumed by the legacy
 * content_dashboard.js dropdown, station-automation, used-aircraft-scanner,
 * inv-pricing dropdowns, and a handful of other tabs that haven't migrated
 * to per-module settings stores.
 *
 * Defaults are preserved verbatim from the pre-split background.js so
 * existing installs see no behavioural change. New installs get the same
 * blob shape they did before.
 *
 * Single export: setDefaultSettings(). Caller is expected to be the
 * service worker's onInstalled listener.
 */

function setDefaultScheduleSettings() {
  return { autoExtract: 0 };
}

function setDefaultStationAutomationSettings() {
  const thresholds = [0, 1000, 5000, 10000, 50000, 100000, 500000, 1000000];
  return {
    defaultPaxThreshold: 0,
    defaultCargoThreshold: 0,
    thresholds,
    countriesCache: {}
  };
}

function setDefaultUsedAircraftScannerSettings() {
  return {
    presets: [],
    typeFamilyOverrides: {},
    concurrency: 6,
    staggerMs: 2000,
    lastScanId: null
  };
}

function setDefaultGeneralSettings() {
  return { defaultDashboard: 'general' };
}

function setDefaultInvPricingSettings() {
  const invPricing = {
    autoAnalysisSave: 1,
    autoPriceUpdate: 0,
    autoClose: 0,
    showReferenceRecommendation: 0,
    recommendation: {},
    historyTable: {
      showNow: 1,
      showOnlyPricing: 0,
      numberOfDates: '5'
    }
  };
  const steps = [
    { min:  0, max:  40, name: 'Drop High',   step: -8 },
    { min: 40, max:  60, name: 'Drop Medium', step: -4 },
    { min: 60, max:  70, name: 'Drop Low',    step: -2 },
    { min: 70, max:  80, name: 'Keep',        step:  0 },
    { min: 80, max:  90, name: 'Raise Low',   step:  1 },
    { min: 90, max:  99, name: 'Raise Medium',step:  2 },
    { min: 99, max: 100, name: 'Raise High',  step:  5 }
  ];
  for (const cmp of ['Y', 'C', 'F', 'Cargo']) {
    invPricing.recommendation[cmp] = {
      maxPrice: 200,
      minPrice: 60,
      steps
    };
  }
  return invPricing;
}

function setDefaultSettings() {
  const aesSettings = {
    invPricing:          setDefaultInvPricingSettings(),
    general:             setDefaultGeneralSettings(),
    schedule:            setDefaultScheduleSettings(),
    stationAutomation:   setDefaultStationAutomationSettings(),
    usedAircraftScanner: setDefaultUsedAircraftScannerSettings()
  };
  chrome.storage.local.get(['settings'], function(result) {
    if (!result.settings) {
      chrome.storage.local.set({ settings: aesSettings }, function() {});
    }
  });
}
