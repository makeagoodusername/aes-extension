"use strict";

// ---------------------------------------------------------------------------
// AES — account-scoped storage key helpers (Slice L1).
//
// Tiny utility every refactored store will eventually import to namespace its
// chrome.storage.local keys per registered AirlineSim account. L1 ships the
// helpers; L2/L3 thread accountId through individual stores.
//
// Naming convention:
//   legacy:  routeAssistant:override:JFK-LAX
//   scoped:  routeAssistant:override:acct:abc123:JFK-LAX
//
// Pass null/empty accountId → returns the legacy key unchanged (back-compat
// path so a single-account session works without changes during migration).
//
// `currentAccountIdSync` reads window.__aesAccountId, populated once by
// helpers.js identity bootstrap on AS pages. Off-AS-page callers (options,
// dashboard) should resolve via AesAccountRegistry.getViewing() instead.
// ---------------------------------------------------------------------------

(function () {
    if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) return;

    function acctKey(legacyKey, accountId) {
        if (!accountId) return legacyKey;
        if (typeof legacyKey !== "string" || !legacyKey) return legacyKey;
        const idx = legacyKey.indexOf(":");
        if (idx < 0) {
            // No colons — prepend the namespace.
            return "acct:" + accountId + ":" + legacyKey;
        }
        const idx2 = legacyKey.indexOf(":", idx + 1);
        if (idx2 < 0) {
            // One colon — insert after it (treats the prefix-and-bucket as one).
            return legacyKey.slice(0, idx + 1) + "acct:" + accountId + ":" + legacyKey.slice(idx + 1);
        }
        // Two-or-more-colon keys — insert after the second colon, so the
        // prefix:bucket: header stays at the front for grep-ability.
        return legacyKey.slice(0, idx2 + 1) + "acct:" + accountId + ":" + legacyKey.slice(idx2 + 1);
    }

    function currentAccountIdSync() {
        if (typeof window !== "undefined" && window.__aesAccountId) {
            return window.__aesAccountId;
        }
        return null;
    }

    const api = {acctKey, currentAccountIdSync};

    if (typeof window !== "undefined") {
        window.AesAccountScopedKey = api;
        window.aesAcctKey = acctKey;
        window.aesCurrentAccountIdSync = currentAccountIdSync;
    }
    if (typeof globalThis !== "undefined") {
        globalThis.AesAccountScopedKey = api;
    }
})();
