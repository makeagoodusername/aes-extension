"use strict"

/**
 * L1 — synchronous helpers for building per-account storage keys.
 *
 * Keys take the form `<prefix>:acct:<accountId>:<suffix>`, where prefix
 * and suffix mirror the existing legacy key shape minus the account
 * scoping. Example:
 *
 *   legacy:   routeAssistant:override:JFK-LAX
 *   scoped:   routeAssistant:override:acct:abc123ef:JFK-LAX
 *
 * Race-condition contract (HANDOVER §10): callers MUST NOT await the
 * registry before their first read in a page lifecycle. If
 * `currentAccountIdSync()` returns null (because the page bootstrap in
 * `AesAccountRegistry.bootstrapFromPage()` hasn't resolved yet),
 * `acctKey()` returns the legacy key shape so existing data still
 * surfaces. Once bootstrap resolves and sets `window.__aesAccountId`,
 * subsequent calls return the scoped shape. L2/L3 refactors will
 * migrate writers; legacy keys persist as fallback during rollout.
 */

function currentAccountIdSync() {
    if (typeof window !== "undefined" && window.__aesAccountId) return window.__aesAccountId
    return null
}

function acctKey(prefix, suffix) {
    const id = currentAccountIdSync()
    const tail = (suffix == null || suffix === "") ? "" : (":" + suffix)
    if (!id) return prefix + tail
    return prefix + ":acct:" + id + tail
}

function isAccountScopedKey(key) {
    return typeof key === "string" && key.indexOf(":acct:") !== -1
}

if (typeof window !== "undefined") {
    window.AesAccountKey = {acctKey, currentAccountIdSync, isAccountScopedKey}
}
