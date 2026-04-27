"use strict";

/**
 * AesAfpSettings — settings persistence for the Aircraft Flight Plan
 * auto-scheduler / preview / apply pipeline. Mirrors the storage shape
 * of `RouteAssistantSettings`: the AFP block lives under the shared
 * `settings` blob in chrome.storage.local, namespaced by accountId via
 * `settings.byAccount[<acctId>].aircraftFlightPlan` (Slice L2).
 *
 *   chrome.storage.local.settings = {
 *       byAccount: { "<acctId>": { aircraftFlightPlan: {...}, ... } },
 *       _legacy:   { aircraftFlightPlan: {...} }   // pre-L2 fallback
 *   }
 *
 * API contract — preserved across the L2 refactor because existing
 * callers (apply-batch.js, slot-optimizer.js, preview-panel.js,
 * schedule-diff.js) already reference these names:
 *
 *   AesAfpSettings.load()    → resolves to the aircraftFlightPlan BLOCK
 *                              (with .autoScheduler, .defaultPricePct,
 *                              .defaultService, ...). Async.
 *   AesAfpSettings.save(p)   → partial update of the AFP block.
 *   AesAfpSettings.cached()  → sync; returns the FULL settings ROOT
 *                              (with .aircraftFlightPlan nested) from
 *                              the most recent load(). Used by
 *                              schedule-diff to read tolerance without
 *                              awaiting. Returns null until first load.
 *
 * The block-vs-root asymmetry is load()'s historical contract — every
 * caller that uses load() reads `s.autoScheduler` directly, while the
 * one cached() caller reads `s.aircraftFlightPlan.autoScheduler.diff`.
 * Keep both shapes intact.
 */
(function () {
    if (typeof globalThis !== "undefined" && globalThis.AesAfpSettings) return;

    function _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId;
        if (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function") {
            return globalThis.AesAccountScopedKey.currentAccountIdSync();
        }
        return null;
    }

    function _readBlock(settings, accountId) {
        if (!settings) return {};
        const byAcc = settings.byAccount || {};
        if (accountId && byAcc[accountId] && byAcc[accountId].aircraftFlightPlan) {
            return byAcc[accountId].aircraftFlightPlan;
        }
        if (settings._legacy && settings._legacy.aircraftFlightPlan) {
            return settings._legacy.aircraftFlightPlan;
        }
        return settings.aircraftFlightPlan || {};
    }

    let _cachedRoot = null;

    async function load(opts) {
        const acctId = _resolveAccountId(opts);
        const data = await chrome.storage.local.get(["settings"]);
        const settings = data.settings || {};
        const block = _readBlock(settings, acctId);
        // Cache the synthetic root the way `schedule-diff` expects to
        // see it — `s.aircraftFlightPlan.autoScheduler...`.
        _cachedRoot = {aircraftFlightPlan: block};
        return block;
    }

    async function save(partial, opts) {
        const acctId = _resolveAccountId(opts);
        const data = await chrome.storage.local.get(["settings"]);
        const settings = data.settings || {};
        const current = _readBlock(settings, acctId);
        const next = Object.assign({}, current, partial || {});
        if (acctId) {
            if (!settings.byAccount) settings.byAccount = {};
            if (!settings.byAccount[acctId]) settings.byAccount[acctId] = {};
            settings.byAccount[acctId].aircraftFlightPlan = next;
        } else {
            settings.aircraftFlightPlan = next;
        }
        await chrome.storage.local.set({settings: settings});
        _cachedRoot = {aircraftFlightPlan: next};
        return next;
    }

    function cached() {
        return _cachedRoot;
    }

    const api = {load, save, cached};
    if (typeof window !== "undefined") window.AesAfpSettings = api;
    if (typeof globalThis !== "undefined") globalThis.AesAfpSettings = api;
})();
