"use strict"

/**
 * AES Slots — slot bidder applier (Slice 20, v1 stub).
 *
 * Mirrors the Slice 19 marketing-budget-applier shape: ships a stub
 * surface so the tuner / panel can route decisions through the right
 * function name, but the actual POST path is unavailable until the AS
 * bid form shape is mapped against a live sample. Permanent-live builds
 * do not mark these as successful dry-runs; they fail closed until the
 * form mapping exists.
 *
 * Public API (window.AesSlotBidder):
 *   apply({server, iata, bidAmount, slotId}) → Promise<ApplyReport>
 *
 * ApplyReport: {ok, dryRun, reason?, recordId?}
 *
 * The applier always logs the attempted live bid to
 * `aesStrategy:slots:bids` via `AesSlotStore.recordBid`, so the
 * change-log can surface every blocked bid while the POST path is mapped.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesSlotBidder) return

    async function apply(req) {
        req = req || {}
        const server     = req.server
        const iata       = req.iata
        const slotId     = req.slotId
        const bidAmount  = Number(req.bidAmount)

        if (!server || !iata)             return _fail("missing-server-or-iata")
        if (!isFinite(bidAmount) || bidAmount <= 0) return _fail("invalid-bid-amount")

        const settings = await _loadSettings()
        const allowed  = _canApply(settings)

        await _logBid({server, iata, slotId, bidAmount, dryRun: false, allowed})

        if (!allowed) return _fail("apply-disabled")

        // Live POST path is deliberately not implemented in v1 — the AS
        // bid form shape needs to be mapped against a real sample first.
        // Surface a stub-not-mapped report so callers can degrade
        // cleanly without thinking the bid succeeded.
        return _fail("form-shape-not-yet-mapped")
    }

    async function _loadSettings() {
        try {
            if (window.AesStrategySettings && typeof window.AesStrategySettings.load === "function") {
                return await window.AesStrategySettings.load()
            }
        } catch (_) {}
        return null
    }

    function _canApply(settings) {
        if (!settings) return false
        if (window.AesStrategySettings && typeof window.AesStrategySettings.canApply === "function") {
            try { return window.AesStrategySettings.canApply(settings, "slotBid") }
            catch (_) {}
        }
        // Fallback: master tier + per-domain flag
        if (settings.tier === "preview-only") return false
        return !!settings.slotBidApplyEnabled
    }

    async function _logBid(bid) {
        if (!window.AesSlotStore) return null
        try { return await window.AesSlotStore.recordBid(bid) }
        catch (_) { return null }
    }

    function _fail(reason) { return {ok: false, dryRun: false, reason: reason} }

    window.AesSlotBidder = {apply}
})()
