"use strict"

/**
 * L1 — AES Account Registry.
 *
 * Singleton over `chrome.storage.local["aesAccounts"]`. The authoritative
 * source for the canopy: every observed (server, airline) tuple gets a
 * stable id and a metadata record here, and downstream stores will scope
 * per-account data by that id (L2/L3 refactors).
 *
 * Storage shape:
 *
 *   chrome.storage.local["aesAccounts"] = {
 *     migrationVersion: 1,            // bumped once L1 enumeration runs
 *     viewingAccountId: "abc123ef…",  // last-touched id (off-AS-page fallback)
 *     accounts: {
 *       "abc123ef…": {
 *         id, server, airlineIdentity, displayName,
 *         firstSeenAt, lastSeenAt
 *       },
 *       …
 *     }
 *   }
 *
 * Single-writer rule (HANDOVER §10): only `background.js`'s
 * `aes:account:touch` handler ever writes this key. Content scripts must
 * never `chrome.storage.local.set` it directly — concurrent pages writing
 * the same blob would lose touches.
 *
 * accountId derivation: spec calls for `sha1(server + ":" + airlineCode)`;
 * we hash on the airline's display identity instead because the AS
 * top-nav exposes the name on every page whereas the IATA code is only
 * present on the dashboard. Identity is stable per airline and unique
 * within a server, so collision risk is the same as the spec form.
 *
 * Letter L+ (auto-login) hooks: the schema has slots reserved for
 * `credentials` and `sessionState` per account, intentionally unused
 * here. L1 ships passive observation only.
 */
class AesAccountRegistry {
    static STORAGE_KEY = "aesAccounts"

    /**
     * Compute the canonical account id from (server, airlineIdentity).
     * Returns the first 12 hex chars of SHA-1(`<server>:<identity>`).
     */
    static async computeId(server, airlineIdentity) {
        const norm = String(server || "").toLowerCase().trim()
            + ":" + String(airlineIdentity || "").trim()
        const buf = new TextEncoder().encode(norm)
        const digest = await crypto.subtle.digest("SHA-1", buf)
        const bytes = new Uint8Array(digest)
        let hex = ""
        for (const b of bytes) hex += b.toString(16).padStart(2, "0")
        return hex.slice(0, 12)
    }

    /** Read the whole registry blob. Returns the empty shape on first call. */
    static async load() {
        const data = await chrome.storage.local.get([AesAccountRegistry.STORAGE_KEY])
        const blob = data[AesAccountRegistry.STORAGE_KEY] || {}
        return {
            migrationVersion: Number(blob.migrationVersion) || 0,
            viewingAccountId: blob.viewingAccountId || null,
            accounts:         (blob.accounts && typeof blob.accounts === "object") ? blob.accounts : {}
        }
    }

    /** Get the metadata for one account, or null if not registered. */
    static async get(accountId) {
        const blob = await AesAccountRegistry.load()
        return (blob.accounts && blob.accounts[accountId]) || null
    }

    /** Returns array of account records, ordered by lastSeenAt desc. */
    static async list() {
        const blob = await AesAccountRegistry.load()
        return Object.values(blob.accounts || {})
            .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    }

    /**
     * Send `aes:account:touch` to the background single-writer to upsert
     * a (server, airlineIdentity) tuple into the registry. Resolves with
     * the canonical accountId once background confirms.
     */
    static touchCurrent({server, airlineIdentity, displayName}) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(
                    {type: "aes:account:touch", server, airlineIdentity, displayName},
                    (resp) => {
                        const lastErr = chrome.runtime.lastError
                        if (lastErr) return reject(new Error(lastErr.message))
                        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "account:touch failed"))
                        resolve(resp.accountId)
                    }
                )
            } catch (e) {
                reject(e)
            }
        })
    }

    /**
     * Page bootstrap — run from helpers.js after AS class is defined and
     * the manifest content-script chain has loaded. Reads identity from
     * the page DOM, computes id, writes `window.__aesAccountId`, and
     * fires the touch. Best-effort; failures are silent (login pages,
     * uninitialised top-nav, etc) and leave `__aesAccountId` undefined
     * so `acctKey()` falls back to the legacy key shape.
     */
    static async bootstrapFromPage() {
        if (typeof AES === "undefined") return null
        let server, airline
        try {
            server  = AES.getServerName()
            airline = AES.getAirlineIdentity()
        } catch (_) { return null }
        if (!server || !airline) return null
        let id = null
        try {
            id = await AesAccountRegistry.computeId(server, airline)
            if (typeof window !== "undefined") window.__aesAccountId = id
        } catch (_) { return null }
        try {
            await AesAccountRegistry.touchCurrent({
                server,
                airlineIdentity: airline,
                displayName:     airline
            })
        } catch (_) {
            // Touch is best-effort. The registry will rebuild on the
            // next page mount; meanwhile per-account reads still work
            // because window.__aesAccountId is already set.
        }
        return id
    }
}

if (typeof window !== "undefined") {
    window.AesAccountRegistry = AesAccountRegistry
}
