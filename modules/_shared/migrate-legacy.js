"use strict"

/**
 * L2.2 — legacy → namespaced migration shim.
 *
 * Runs once per user lifetime, gated on `aesAccounts.migrationVersion === 0`.
 * Copies pre-L2 Class C/D legacy keys into their `:acct:<id>:` namespaced
 * form so post-bootstrap reads land in the namespaced slot directly
 * (eliminating the per-read legacy-fallback round trip).
 *
 * Idempotency: re-running is a no-op — the version bump on success
 * means subsequent invocations skip immediately. The migration is
 * additive: legacy keys stay live (per HANDOVER §10 "Legacy keys NEVER
 * deleted by Slice L1–L5") so any unrefactored reader keeps working.
 *
 * Single vs multi-account:
 *   - Single account in the registry → auto-migrate, assign all legacy
 *     to that account.
 *   - Multi-account → flag `aesAccounts.migrationPending = true` and
 *     bail without copying. The "Confirm legacy data ownership" modal
 *     (L2.2.c, deferred) consumes that flag and runs the migration via
 *     `runForAccount()` once the user picks an owner.
 *
 * Trigger: helpers.js calls `AesMigrateLegacy.runIfNeeded()` after the
 * registry bootstrap touch resolves. Failures are logged + swallowed —
 * the user keeps reading via the legacy fallback path until the next
 * page load retries.
 *
 * Class scope handled by this shim:
 *   - C · per-route stores
 *       routeAssistant:override:<HUB>-<DEST>
 *       routeAssistant:routeNote:<HUB>-<DEST>
 *       routeAssistant:ratingAlpha:<HUB>-<DEST>
 *       routeAssistant:statusHistory:<HUB>-<DEST>
 *   - C · single-blob stores
 *       routeAssistant:watchlist
 *       routeAssistant:alertRules
 *   - D · settings areas (sub-blocks of `settings`)
 *       settings.routeAssistant
 *       settings.aircraftFlightPlan
 *
 * Class B (ORS, markets, ticketPrice, carriers, inventory, yieldHistory,
 * sandboxBacktest, ratingObservations, pricingApplyLog, …) is L3 and
 * deliberately not migrated here.
 */
class AesMigrateLegacy {
    /**
     * Per-route-key prefixes (Class C). Each prefix has trailing colon;
     * the suffix after the colon is the per-route key (e.g. "JFK-LAX").
     */
    static PER_ROUTE_PREFIXES = [
        "routeAssistant:override:",
        "routeAssistant:routeNote:",
        "routeAssistant:ratingAlpha:",
        "routeAssistant:statusHistory:"
    ]

    /**
     * Single-blob keys (Class C). One full record per key — copy
     * verbatim into the namespaced slot.
     */
    static SINGLE_BLOB_KEYS = [
        "routeAssistant:watchlist",
        "routeAssistant:alertRules"
    ]

    /**
     * `settings` sub-areas (Class D). Each is a top-level sub-block
     * inside `chrome.storage.local["settings"]`; they migrate to
     * `settings.acct.<id>.<area>`.
     */
    static SETTINGS_AREAS = [
        "routeAssistant",
        "aircraftFlightPlan"
    ]

    /**
     * Public entry — call from helpers.js bootstrap. Resolves to one of:
     *   "noop"     · already migrated (version >= 1) or no accounts
     *   "single"   · ran single-account migration; version bumped to 1
     *   "pending"  · multi-account; flagged migrationPending; no copy
     *   "error"    · caught failure (already logged); legacy fallback
     *                 continues to work
     */
    static async runIfNeeded() {
        try {
            const blob = await AesAccountRegistry.load()
            if (Number(blob.migrationVersion) >= 1) return "noop"
            const accounts = Object.values(blob.accounts || {})
            if (accounts.length === 0) return "noop"
            if (accounts.length > 1) {
                await AesMigrateLegacy._setPending(true)
                return "pending"
            }
            const owner = accounts[0]
            await AesMigrateLegacy.runForAccount(owner.id)
            return "single"
        } catch (e) {
            console.warn("[AES] migrateLegacy failed:", (e && e.message) || e)
            return "error"
        }
    }

    /**
     * Apply the copy migration for one explicit owner. Called from
     * `runIfNeeded` for the single-account case, and (future) from the
     * L2.2.c multi-account ownership-confirm modal.
     *
     * Reads the entire chrome.storage.local in a single get(null), maps
     * each legacy key to its namespaced form, and writes the bundle
     * back in a single set() so the migration is one storage round-trip
     * worth of activity. Settings are migrated in the same pass —
     * `settings.acct[id].<area> = settings.<area>`.
     */
    static async runForAccount(accountId) {
        if (!accountId) throw new Error("runForAccount: accountId required")

        const all = await chrome.storage.local.get(null)
        const writes = {}

        // Per-route stores. Walk every key once, route the matching ones
        // through their prefix transformer.
        for (const key in all) {
            if (key.indexOf(":acct:") >= 0) continue   // already namespaced — skip
            for (const prefix of AesMigrateLegacy.PER_ROUTE_PREFIXES) {
                if (!key.startsWith(prefix)) continue
                const suffix = key.substring(prefix.length)
                const scopePrefix = prefix.replace(/:$/, "")   // strip trailing colon
                const newKey = scopePrefix + ":acct:" + accountId + ":" + suffix
                if (all[newKey] === undefined) writes[newKey] = all[key]
                break
            }
        }

        // Single-blob keys.
        for (const k of AesMigrateLegacy.SINGLE_BLOB_KEYS) {
            if (all[k] === undefined) continue
            const newKey = k + ":acct:" + accountId
            if (all[newKey] === undefined) writes[newKey] = all[k]
        }

        // Settings sub-areas. Read the existing settings blob, copy
        // each area into settings.acct[id], write back the merged blob.
        const settings = (all.settings && typeof all.settings === "object") ? all.settings : null
        if (settings) {
            const acct = (settings.acct && typeof settings.acct === "object") ? Object.assign({}, settings.acct) : {}
            const slot = (acct[accountId] && typeof acct[accountId] === "object") ? Object.assign({}, acct[accountId]) : {}
            let mutated = false
            for (const area of AesMigrateLegacy.SETTINGS_AREAS) {
                const legacy = settings[area]
                if (!legacy || typeof legacy !== "object") continue
                if (slot[area] && typeof slot[area] === "object") continue   // already migrated
                slot[area] = legacy
                mutated = true
            }
            if (mutated) {
                acct[accountId] = slot
                writes.settings = Object.assign({}, settings, {acct})
            }
        }

        if (Object.keys(writes).length) {
            await chrome.storage.local.set(writes)
        }

        // Bump the registry's migrationVersion via the background
        // single-writer. Without this the shim would re-run on every
        // page load.
        await AesMigrateLegacy._setVersion(1)
    }

    /** Send `aes:migration:set-version` to background. */
    static _setVersion(v) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(
                    {type: "aes:migration:set-version", version: Number(v) || 0},
                    (resp) => {
                        const lastErr = chrome.runtime.lastError
                        if (lastErr) return reject(new Error(lastErr.message))
                        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "set-version failed"))
                        resolve()
                    }
                )
            } catch (e) { reject(e) }
        })
    }

    /** Send `aes:migration:set-pending` to background. */
    static _setPending(pending) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(
                    {type: "aes:migration:set-pending", pending: !!pending},
                    (resp) => {
                        const lastErr = chrome.runtime.lastError
                        if (lastErr) return reject(new Error(lastErr.message))
                        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "set-pending failed"))
                        resolve()
                    }
                )
            } catch (e) { reject(e) }
        })
    }
}

if (typeof window !== "undefined") {
    window.AesMigrateLegacy = AesMigrateLegacy
}
