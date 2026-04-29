"use strict"

/**
 * AES Strategy — layered overrides migrations (Slice 1).
 *
 * Each layered record (family / division / fleet / route-extras) is stored
 * with `schemaVersion: 1`. This module owns lazy on-read migration so a
 * blob written by an older build is upgraded the first time the resolver
 * touches it. Slice 1 ships only v1, so `migrateOnce` is a pass-through
 * with shape validation. Future versions add named migrations keyed by
 * `[layerKind][fromVersion]`.
 *
 * Public API (window.AesStrategyLayeredMigrations):
 *   CURRENT_VERSION                    → 1
 *   migrateOnce(blob, layerKind)       → {patch, pinned, schemaVersion, ...meta}
 *   normalisePinned(pinned)            → {<dottedPath>: true}
 *   isLayerKind(kind)                  → boolean
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredMigrations) return

    const CURRENT_VERSION = 1
    const LAYER_KINDS = ["family", "division", "fleet", "route-extras"]

    function isLayerKind(kind) { return LAYER_KINDS.indexOf(kind) >= 0 }

    function normalisePinned(pinned) {
        const out = {}
        if (!pinned || typeof pinned !== "object") return out
        for (const k of Object.keys(pinned)) {
            if (typeof k !== "string" || !k.length) continue
            if (pinned[k]) out[k] = true
        }
        return out
    }

    function _baseShape(blob, layerKind) {
        const meta = (blob && typeof blob === "object") ? blob : {}
        return {
            schemaVersion: CURRENT_VERSION,
            layerKind:     layerKind,
            patch:         (meta.patch && typeof meta.patch === "object") ? meta.patch : {},
            pinned:        normalisePinned(meta.pinned),
            label:         (typeof meta.label === "string") ? meta.label : "",
            updatedAt:     (typeof meta.updatedAt === "number") ? meta.updatedAt : 0,
            updatedByAccountId: (typeof meta.updatedByAccountId === "string") ? meta.updatedByAccountId : ""
        }
    }

    function migrateOnce(blob, layerKind) {
        if (!isLayerKind(layerKind)) {
            return _baseShape(null, layerKind || "family")
        }
        // v1 — pass-through with shape validation. Future versions branch on
        // blob.schemaVersion < CURRENT_VERSION here.
        return _baseShape(blob, layerKind)
    }

    window.AesStrategyLayeredMigrations = {
        CURRENT_VERSION: CURRENT_VERSION,
        LAYER_KINDS:     LAYER_KINDS.slice(),
        migrateOnce:     migrateOnce,
        normalisePinned: normalisePinned,
        isLayerKind:     isLayerKind
    }
})()
