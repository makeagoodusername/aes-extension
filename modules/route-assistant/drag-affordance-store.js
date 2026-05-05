"use strict"

/**
 * Per-account knobs the drag-arbiter consults: snap granularity, ghost
 * detail level, and the dragSubmitMode that gates UI-triggered submits
 * for drag-to-schedule (gestures G9/G10/G11).
 *
 * Storage:
 *   dragschedule:settings                  → (legacy)
 *   dragschedule:settings:acct:<id>        → (L2+)
 *
 * Defaults are conservative: 5-min snap (matches wave-strip.js SNAP_MIN),
 * "compact" ghost detail (less screen noise), dragSubmitMode "manual"
 * (preserves form-driver no-submit invariant — orchestrator pre-fills only,
 * user clicks AS submit). Only by explicit opt-in does dragSubmitMode flip
 * to "confirmed" or "auto".
 */
class RouteAssistantDragAffordanceStore {
    static LEGACY_KEY   = "dragschedule:settings"
    static SCOPE_PREFIX = "dragschedule:settings"

    static DEFAULTS = {
        snapMinutes:       5,
        ghostDetail:       "compact",   // "compact" | "verbose"
        dragSubmitMode:    "manual",    // "manual" | "confirmed" | "auto"
        showCancelHint:    true,
        showAuditToasts:   true,
        allowedGestures:   null         // null = all; or array of gesture ids to allow
    }

    static _key()       { return acctKey(RouteAssistantDragAffordanceStore.SCOPE_PREFIX, "") }
    static _legacyKey() { return RouteAssistantDragAffordanceStore.LEGACY_KEY }

    static async load() {
        const ns = RouteAssistantDragAffordanceStore._key()
        const lg = RouteAssistantDragAffordanceStore._legacyKey()
        const keys = (ns === lg) ? [ns] : [ns, lg]
        const out  = await chrome.storage.local.get(keys)
        const raw  = (out[ns] !== undefined) ? out[ns] : (out[lg] || null)
        return RouteAssistantDragAffordanceStore._normalise(raw)
    }

    static _normalise(raw) {
        const r = raw || {}
        const d = RouteAssistantDragAffordanceStore.DEFAULTS
        const snap = Number(r.snapMinutes)
        const mode = String(r.dragSubmitMode || "")
        return {
            snapMinutes:    (isFinite(snap) && snap > 0 && snap <= 60) ? snap : d.snapMinutes,
            ghostDetail:    (r.ghostDetail === "verbose" ? "verbose" : "compact"),
            dragSubmitMode: (mode === "confirmed" || mode === "auto") ? mode : "manual",
            showCancelHint: r.showCancelHint !== false,
            showAuditToasts: r.showAuditToasts !== false,
            allowedGestures: Array.isArray(r.allowedGestures) ? r.allowedGestures.slice() : null,
            updatedAt:      Number(r.updatedAt) || null
        }
    }

    static async save(partial) {
        const current = await RouteAssistantDragAffordanceStore.load()
        const next    = Object.assign({}, current, partial || {}, {updatedAt: Date.now()})
        const ns = RouteAssistantDragAffordanceStore._key()
        await chrome.storage.local.set({[ns]: next})
        return next
    }

    static async reset() {
        const ns = RouteAssistantDragAffordanceStore._key()
        await chrome.storage.local.remove([ns])
        return RouteAssistantDragAffordanceStore.DEFAULTS
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantDragAffordanceStore = RouteAssistantDragAffordanceStore
}
