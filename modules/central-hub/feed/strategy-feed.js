"use strict"

/**
 * HubFeed slices for the strategy tile:
 *   hub:strategy:applied   — most recent applied plan envelope
 *   hub:strategy:settings  — current strategy settings (tier, gates, learning)
 *
 * Both feed off the same storage prefixes the legacy `watchedStorageKeys()`
 * path uses, but the read happens once and is shared across any consumer
 * that subscribes (strategy-tile, alert-digest, future hero-strip).
 *
 * Account-scope: prefer `AesStrategy.getApplied(accountId)` because it
 * resolves the per-account scoped key when present and falls back to the
 * legacy global key otherwise. When the registry hasn't bootstrapped yet,
 * `__aesAccountId` is null and getApplied falls through to the legacy shape.
 */
;(function () {
    if (typeof window === "undefined") return
    if (typeof window.HubFeed === "undefined") {
        console.warn("[AES strategy-feed] HubFeed missing — slices not declared")
        return
    }
    if (window.__aesStrategyFeedDeclared) return
    window.__aesStrategyFeedDeclared = true

    HubFeed.declare({
        name:       "hub:strategy:applied",
        deps:       [
            "data:strategy:applied:saved",   // bridged in feed/index.js
            "data:account:bootstrapped"      // bridged in feed/index.js
        ],
        ttlMs:      24 * 3600 * 1000,
        debounceMs: 80,
        getScrapedAt: (v) => v && Number.isFinite(v.appliedAt) ? v.appliedAt : null,
        compute:    async () => {
            try {
                if (window.AesStrategy && typeof window.AesStrategy.getApplied === "function") {
                    const id = window.__aesAccountId || null
                    const rec = await window.AesStrategy.getApplied(id)
                    if (rec) return rec
                }
                const data = await chrome.storage.local.get(["aesStrategy:plan:applied"])
                return data["aesStrategy:plan:applied"] || null
            } catch (_) {
                return null
            }
        }
    })

    HubFeed.declare({
        name:       "hub:strategy:settings",
        deps:       [
            "data:strategy:settings:saved",   // bridged in feed/index.js
            "data:account:bootstrapped"
        ],
        ttlMs:      0,                         // settings have no natural expiry
        debounceMs: 50,
        compute:    async () => {
            if (!window.AesStrategySettings || typeof window.AesStrategySettings.load !== "function") {
                return null
            }
            try { return await window.AesStrategySettings.load() }
            catch (_) { return null }
        }
    })
})()
