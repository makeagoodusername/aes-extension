/**
 * Coordinates a single in-flight scan across multiple surfaces (the dashboard
 * tile and the in-page market panel).
 *
 * Both surfaces load the full scanner stack and may try to attach a
 * ScanController to the same scanId. The lease is a `<server>marketScan:lease`
 * record in chrome.storage.local that names the owner tab; the non-owner
 * surface goes into read-only mirror mode (no Start/Cancel) and just observes
 * progress through the same chrome.storage.onChanged channel everyone else
 * uses.
 *
 * The lease is intentionally cooperative — there is no global lock. Stale
 * leases (no refresh in TTL_MS) are treated as released so a crashed tab
 * never deadlocks the next start.
 */
class MarketScanLease {
    static KEY_SUFFIX = "marketScan:lease"
    static TTL_MS = 60 * 1000

    static _key(server) {
        return server + MarketScanLease.KEY_SUFFIX
    }

    /**
     * Mints a stable per-tab id and caches it on window so every controller
     * in the same tab gets the same value. Used to tell my own lease apart
     * from another tab's.
     */
    static tabId() {
        if (typeof window === "undefined") return "node"
        if (!window.__aesMarketScanTabId) {
            window.__aesMarketScanTabId = "t-" + Date.now().toString(36)
                + "-" + Math.random().toString(36).slice(2, 8)
        }
        return window.__aesMarketScanTabId
    }

    /**
     * Tries to acquire the lease for `scanId`. Wins when:
     *   - no lease exists, or
     *   - the existing lease is stale (expiresAt < now), or
     *   - the existing lease's scanId differs (a new scan replaces an old one
     *     even if the prior owner tab is still alive — the new scan is what
     *     the user just asked for).
     *
     * Returns true on win, false if another tab still owns an active lease
     * for the same scanId.
     */
    static async acquire(server, scanId) {
        const key = MarketScanLease._key(server)
        const data = await chrome.storage.local.get([key])
        const existing = data[key]
        const now = Date.now()
        const myTab = MarketScanLease.tabId()
        if (existing
            && existing.scanId === scanId
            && existing.ownerTabId !== myTab
            && existing.expiresAt > now) {
            return false
        }
        await chrome.storage.local.set({[key]: {
            scanId:     scanId,
            ownerTabId: myTab,
            acquiredAt: now,
            expiresAt:  now + MarketScanLease.TTL_MS
        }})
        return true
    }

    /**
     * Extends the lease's expiry. Called from heartbeats. No-op if the lease
     * was lost (e.g. another tab took over after a stall).
     *
     * Skips the storage write when more than half the TTL is still left —
     * a long scan with hundreds of page heartbeats would otherwise rewrite
     * the lease on every page, fanning out spurious onChanged notifications.
     */
    static async refresh(server, scanId) {
        const key = MarketScanLease._key(server)
        const data = await chrome.storage.local.get([key])
        const existing = data[key]
        if (!existing || existing.scanId !== scanId) return false
        if (existing.ownerTabId !== MarketScanLease.tabId()) return false
        const remaining = existing.expiresAt - Date.now()
        if (remaining > MarketScanLease.TTL_MS / 2) return true
        existing.expiresAt = Date.now() + MarketScanLease.TTL_MS
        await chrome.storage.local.set({[key]: existing})
        return true
    }

    /**
     * Releases the lease only if I'm the current owner. Lets a different tab
     * start the next scan immediately rather than waiting out the TTL.
     */
    static async release(server, scanId) {
        const key = MarketScanLease._key(server)
        const data = await chrome.storage.local.get([key])
        const existing = data[key]
        if (!existing) return
        if (existing.scanId !== scanId) return
        if (existing.ownerTabId !== MarketScanLease.tabId()) return
        await chrome.storage.local.remove([key])
    }

    /**
     * Returns the current lease record (or null if absent / stale). Surfaces
     * use this to decide whether to render in mirror mode.
     */
    static async inspect(server) {
        const key = MarketScanLease._key(server)
        const data = await chrome.storage.local.get([key])
        const lease = data[key]
        if (!lease) return null
        if (lease.expiresAt < Date.now()) return null
        return lease
    }

    /**
     * Convenience: am I the current owner of the lease for `scanId`? False
     * when the lease is missing, stale, or owned by another tab.
     */
    static async isOwner(server, scanId) {
        const lease = await MarketScanLease.inspect(server)
        if (!lease) return false
        if (lease.scanId !== scanId) return false
        return lease.ownerTabId === MarketScanLease.tabId()
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketScanLease
