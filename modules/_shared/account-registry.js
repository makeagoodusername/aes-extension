"use strict";

// ---------------------------------------------------------------------------
// AES — Account Registry (Slice L1).
//
// Tracks every (server, airline) tuple the user has visited as a registered
// "account". This is the foundation slice for the multi-account canopy plan
// (see HANDOVER.md §9 "Letter L (canopy) — multi-account federation plan").
// L1 ships read-only registry plumbing; later slices refactor per-store
// scoping, add the canopy dashboard, and coordinate cross-account waves.
//
// Storage key:  aesAccounts
//
// Single-writer rule (HANDOVER §10 invariant introduced this slice):
//   Only background.js writes the aesAccounts blob, via chrome.runtime
//   messages. Content scripts and option pages call AesAccountRegistry.touch
//   / setLabel / archive / remove etc., which forward as messages. This
//   prevents tab-tab races on the registry blob.
//
// Reads are direct chrome.storage.local.get(...) — they never write so the
// single-writer rule isn't violated, and direct reads avoid round-tripping
// through the service worker for hot-path lookups.
// ---------------------------------------------------------------------------

(function () {
    if (typeof globalThis !== "undefined" && globalThis.AesAccountRegistry) return;

    const STORAGE_KEY = "aesAccounts";
    const SCHEMA_VERSION = 1;

    // ── id derivation ──────────────────────────────────────────────────

    function _normalize(server, airline) {
        const s = String(server || "").toLowerCase().trim();
        const a = String(airline || "").toLowerCase().trim();
        return s && a ? s + ":" + a : null;
    }

    /**
     * Synchronous, deterministic 12-hex-char ID derived from
     * `<server>:<airline>`. Not cryptographic — collision odds at sane
     * federation sizes are negligible (12 hex = 48 bits ≈ 2.8e14 space).
     * Sync because helpers.js identity bootstrap calls it before storing
     * window.__aesAccountId, and downstream stores read that synchronously.
     *
     * Algorithm: FNV-1a 32-bit doubled (compute against the string and
     * against its reverse) → concatenate → 12 hex chars. Keeps things
     * stable across reloads + browsers.
     */
    function accountIdOf(server, airline) {
        const norm = _normalize(server, airline);
        if (!norm) return null;
        return _fnv1a32(norm) + _fnv1a32(_reverse(norm)).slice(0, 4);
    }

    function _fnv1a32(str) {
        let h = 0x811c9dc5 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, "0");
    }

    function _reverse(str) {
        let out = "";
        for (let i = str.length - 1; i >= 0; i--) out += str.charAt(i);
        return out;
    }

    // ── shape helpers ──────────────────────────────────────────────────

    function _emptyRegistry() {
        return {
            schemaVersion: SCHEMA_VERSION,
            accounts: {},
            activeAccountId: null,
            viewingAccountId: null,
            updatedAt: 0
        };
    }

    function _normalizeRecord(rec) {
        if (!rec || typeof rec !== "object") return null;
        if (!rec.accountId || !rec.server || !rec.airlineCode) return null;
        return Object.assign({
            accountId: rec.accountId,
            server: rec.server,
            airlineCode: rec.airlineCode,
            airlineName: rec.airlineName || rec.airlineCode || "",
            enterpriseId: rec.enterpriseId || null,
            label: rec.label || null,
            firstSeenAt: rec.firstSeenAt || 0,
            lastSeenAt: rec.lastSeenAt || 0,
            lastSyncedAt: rec.lastSyncedAt || {},
            active: rec.active !== false,
            archived: !!rec.archived
        });
    }

    function _displayLabel(rec) {
        if (!rec) return "";
        return rec.label || rec.airlineCode || "";
    }

    // ── reads (no message round-trip) ──────────────────────────────────

    async function _load() {
        const got = await new Promise((resolve) => {
            try {
                chrome.storage.local.get(STORAGE_KEY, (items) => {
                    void chrome.runtime.lastError;   // swallow if any
                    resolve(items || {});
                });
            } catch (_) {
                resolve({});
            }
        });
        const raw = got[STORAGE_KEY];
        if (!raw || typeof raw !== "object") return _emptyRegistry();
        return Object.assign(_emptyRegistry(), raw, {
            accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {}
        });
    }

    async function list(opts) {
        const reg = await _load();
        const arr = Object.values(reg.accounts).map(_normalizeRecord).filter(Boolean);
        const includeArchived = !!(opts && opts.includeArchived);
        return includeArchived ? arr : arr.filter((a) => !a.archived);
    }

    async function get(accountId) {
        if (!accountId) return null;
        const reg = await _load();
        return _normalizeRecord(reg.accounts[accountId]) || null;
    }

    async function getByPair(server, airline) {
        const id = accountIdOf(server, airline);
        return id ? get(id) : null;
    }

    async function getViewing() {
        const reg = await _load();
        return reg.viewingAccountId || reg.activeAccountId || null;
    }

    function currentAccountId() {
        if (typeof window !== "undefined" && window.__aesAccountId) {
            return window.__aesAccountId;
        }
        return null;
    }

    // ── writes (forwarded to background.js) ────────────────────────────

    function _sendToBackground(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        reject(new Error(err.message || "sendMessage failed"));
                        return;
                    }
                    resolve(response);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    async function touch(server, airline, meta) {
        const accountId = accountIdOf(server, airline);
        if (!accountId) return null;
        try {
            return await _sendToBackground({
                type: "aes:account:touch",
                accountId,
                server,
                airline,
                meta: meta || {}
            });
        } catch (_) {
            // Background unreachable — bootstrap is best-effort. Caller can
            // retry. Don't throw; identity may still be set in window cache.
            return null;
        }
    }

    function register(server, airline, meta) {
        return touch(server, airline, meta);
    }

    async function setLabel(accountId, label) {
        if (!accountId) return null;
        return _sendToBackground({type: "aes:account:setLabel", accountId, label: label || null});
    }

    async function archive(accountId) {
        if (!accountId) return null;
        return _sendToBackground({type: "aes:account:archive", accountId});
    }

    async function unarchive(accountId) {
        if (!accountId) return null;
        return _sendToBackground({type: "aes:account:unarchive", accountId});
    }

    async function remove(accountId, opts) {
        if (!accountId) return null;
        return _sendToBackground({
            type: "aes:account:remove",
            accountId,
            deleteData: !!(opts && opts.deleteData)
        });
    }

    async function setViewing(accountId) {
        return _sendToBackground({type: "aes:account:setViewing", accountId: accountId || null});
    }

    // ── public API ─────────────────────────────────────────────────────

    const AesAccountRegistry = {
        STORAGE_KEY,
        SCHEMA_VERSION,
        accountIdOf,
        list,
        get,
        getByPair,
        getViewing,
        currentAccountId,
        touch,
        register,
        setLabel,
        archive,
        unarchive,
        remove,
        setViewing,
        _displayLabel,
        _normalizeRecord,
        _load
    };

    if (typeof window !== "undefined") {
        window.AesAccountRegistry = AesAccountRegistry;
    }
    if (typeof globalThis !== "undefined") {
        globalThis.AesAccountRegistry = AesAccountRegistry;
    }
})();
