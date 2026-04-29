"use strict"

/**
 * Letter M slice M0 — kin role assignments.
 *
 * Every account in the registry can be tagged with one of six roles that
 * describe how the airline is *meant* to operate inside the family
 * conglomerate. Roles seed default DNA dimensions, scoring weights, and
 * coordination-rule eligibility for downstream M slices (interline-first
 * detector, anti-cannibalization arbiter, capacity arbitrage, …).
 *
 * Storage: `aesCanopy:roles` — single canopy-scope blob, NOT per-account.
 *
 *   {
 *     schemaVersion: 1,
 *     byAccount: {
 *       [accountId]: {
 *         accountId,
 *         role,                    // one of ROLE_IDS or "unclassified"
 *         roleAutoDetected,        // true while no user override stored
 *         autoDetectedRole,        // last detector output (so override toggle
 *                                  // can show "Reset to detected (regional-feeder)")
 *         autoDetectedAt,          // ms epoch
 *         autoDetectedConfidence,  // 0..1 from detector
 *         autoDetectedSignals,     // string[] human-readable
 *         brandFloor: { Y, C, F }, // per-class price floor (advisory)
 *         primaryHubs: [iata],     // detected primary operating hubs
 *         secondaryHubs: [iata],
 *         excludedHubs: [iata],    // user-declared hubs this kin should NOT enter
 *         notes: string,
 *         assignedAt
 *       }
 *     }
 *   }
 *
 * Single-writer rule: writes go through `_save()` which read-modify-writes
 * atomically. Cross-tab consumers subscribe to `chrome.storage.onChanged`
 * for the key; the store also emits `canopy:roles-changed` on the bus.
 *
 * Invariant M-C (HANDOVER §10): role assignment is user-overridable.
 * Auto-detected role fills empty slot. User assignment is absolute.
 * `setRole(accountId, role, {source: "user"})` flips `roleAutoDetected`
 * to false. `resetToDetected(accountId)` clears the override and re-runs
 * the detector at next bootstrap.
 */
;(function () {
    if (window.AesCanopyRoleStore) return

    const KEY = "aesCanopy:roles"

    const ROLE_IDS = [
        "flag-carrier",
        "regional-feeder",
        "low-cost",
        "cargo",
        "charter-leisure",
        "holding-lease"
    ]

    const ROLE_LABELS = {
        "flag-carrier":    "Flag carrier",
        "regional-feeder": "Regional feeder",
        "low-cost":        "Low-cost",
        "cargo":           "Cargo",
        "charter-leisure": "Charter / leisure",
        "holding-lease":   "Holding / lease",
        "unclassified":    "Unclassified"
    }

    const ROLE_COLORS = {
        "flag-carrier":    "#3b82f6",
        "regional-feeder": "#10b981",
        "low-cost":        "#f59e0b",
        "cargo":           "#8b5cf6",
        "charter-leisure": "#ec4899",
        "holding-lease":   "#6b7280",
        "unclassified":    "#94a3b8"
    }

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesAfp && window.AesAfp.bus) window.AesAfp.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
    }

    function _defaults() {
        return {schemaVersion: 1, byAccount: {}}
    }

    function _normRecord(rec, accountId) {
        rec = rec || {}
        const role = (typeof rec.role === "string" && (ROLE_IDS.indexOf(rec.role) >= 0 || rec.role === "unclassified"))
            ? rec.role : "unclassified"
        const brandFloor = rec.brandFloor && typeof rec.brandFloor === "object" ? rec.brandFloor : {}
        return {
            accountId:                accountId,
            role:                     role,
            roleAutoDetected:         rec.roleAutoDetected !== false,
            autoDetectedRole:         rec.autoDetectedRole || null,
            autoDetectedAt:           Number(rec.autoDetectedAt) || 0,
            autoDetectedConfidence:   Number(rec.autoDetectedConfidence) || 0,
            autoDetectedSignals:      Array.isArray(rec.autoDetectedSignals) ? rec.autoDetectedSignals.slice(0, 12) : [],
            brandFloor: {
                Y: Number(brandFloor.Y) || null,
                C: Number(brandFloor.C) || null,
                F: Number(brandFloor.F) || null
            },
            primaryHubs:              Array.isArray(rec.primaryHubs) ? rec.primaryHubs.slice(0, 8) : [],
            secondaryHubs:            Array.isArray(rec.secondaryHubs) ? rec.secondaryHubs.slice(0, 16) : [],
            excludedHubs:             Array.isArray(rec.excludedHubs) ? rec.excludedHubs.slice(0, 32) : [],
            notes:                    typeof rec.notes === "string" ? rec.notes.slice(0, 500) : "",
            assignedAt:               Number(rec.assignedAt) || 0
        }
    }

    async function load() {
        const out = await chrome.storage.local.get([KEY])
        const raw = out[KEY] || _defaults()
        if (!raw.byAccount || typeof raw.byAccount !== "object") raw.byAccount = {}
        const merged = Object.assign(_defaults(), raw)
        for (const id in merged.byAccount) {
            merged.byAccount[id] = _normRecord(merged.byAccount[id], id)
        }
        return merged
    }

    async function _save(block) {
        await chrome.storage.local.set({[KEY]: block})
    }

    /**
     * Read one kin's role record. Returns the normalised default
     * ("unclassified", auto=true, no overrides) when no record exists.
     */
    async function get(accountId) {
        if (!accountId) return null
        const block = await load()
        return block.byAccount[accountId] || _normRecord({}, accountId)
    }

    /** Map of all known role records keyed by accountId. */
    async function getAll() {
        const block = await load()
        return block.byAccount
    }

    /**
     * Apply detector output. Only writes when no user override is in
     * effect (`roleAutoDetected !== false`). Always records detector
     * metadata (autoDetectedRole, autoDetectedAt, autoDetectedSignals)
     * even when override is set, so the UI can offer "Reset to detected".
     */
    async function applyDetection(accountId, detection) {
        if (!accountId || !detection) return null
        const block = await load()
        const cur = block.byAccount[accountId] || _normRecord({}, accountId)
        const detectedRole = detection.role || "unclassified"
        const next = Object.assign({}, cur, {
            autoDetectedRole:       detectedRole,
            autoDetectedAt:         Date.now(),
            autoDetectedConfidence: Number(detection.confidence) || 0,
            autoDetectedSignals:    Array.isArray(detection.signals) ? detection.signals.slice(0, 12) : []
        })
        if (cur.roleAutoDetected !== false) {
            // No user override — adopt the detected role.
            next.role = detectedRole
            if (Array.isArray(detection.primaryHubs))   next.primaryHubs   = detection.primaryHubs.slice(0, 8)
            if (Array.isArray(detection.secondaryHubs)) next.secondaryHubs = detection.secondaryHubs.slice(0, 16)
            next.assignedAt = Date.now()
        }
        block.byAccount[accountId] = _normRecord(next, accountId)
        await _save(block)
        _emit("canopy:roles-changed", {accountId, action: "auto-detected", role: block.byAccount[accountId].role})
        return block.byAccount[accountId]
    }

    /**
     * Set role explicitly. `source: "user"` flips `roleAutoDetected`
     * to false — the user override is absolute (invariant M-C).
     * `source: "detector"` only writes when no user override exists.
     */
    async function setRole(accountId, role, opts) {
        if (!accountId) return null
        const source = (opts && opts.source) || "user"
        const block = await load()
        const cur = block.byAccount[accountId] || _normRecord({}, accountId)
        if (source === "detector" && cur.roleAutoDetected === false) {
            return cur
        }
        const next = Object.assign({}, cur, {
            role:             role || "unclassified",
            roleAutoDetected: source === "detector",
            assignedAt:       Date.now()
        })
        block.byAccount[accountId] = _normRecord(next, accountId)
        await _save(block)
        _emit("canopy:roles-changed", {accountId, action: "set", role: next.role, source})
        return block.byAccount[accountId]
    }

    /**
     * Drop the user override and revert to the detector's last result.
     * The detector re-runs on the next bootstrap and the `applyDetection`
     * path will own the role from then on.
     */
    async function resetToDetected(accountId) {
        if (!accountId) return null
        const block = await load()
        const cur = block.byAccount[accountId]
        if (!cur) return null
        const next = Object.assign({}, cur, {
            role:             cur.autoDetectedRole || "unclassified",
            roleAutoDetected: true,
            assignedAt:       Date.now()
        })
        block.byAccount[accountId] = _normRecord(next, accountId)
        await _save(block)
        _emit("canopy:roles-changed", {accountId, action: "reset", role: next.role})
        return block.byAccount[accountId]
    }

    /** Patch arbitrary fields (brandFloor, hubs, notes, …) without touching role. */
    async function update(accountId, fields) {
        if (!accountId) return null
        const block = await load()
        const cur = block.byAccount[accountId] || _normRecord({}, accountId)
        const next = Object.assign({}, cur, fields || {})
        block.byAccount[accountId] = _normRecord(next, accountId)
        await _save(block)
        _emit("canopy:roles-changed", {accountId, action: "updated"})
        return block.byAccount[accountId]
    }

    /** Drop a role record entirely (e.g. when an account is deregistered). */
    async function remove(accountId) {
        if (!accountId) return false
        const block = await load()
        if (!block.byAccount[accountId]) return false
        delete block.byAccount[accountId]
        await _save(block)
        _emit("canopy:roles-changed", {accountId, action: "deleted"})
        return true
    }

    function roleLabel(role) {
        return ROLE_LABELS[role] || ROLE_LABELS.unclassified
    }

    function roleColor(role) {
        return ROLE_COLORS[role] || ROLE_COLORS.unclassified
    }

    window.AesCanopyRoleStore = {
        load,
        get,
        getAll,
        applyDetection,
        setRole,
        resetToDetected,
        update,
        remove,
        roleLabel,
        roleColor,
        ROLE_IDS,
        ROLE_LABELS,
        ROLE_COLORS,
        KEY
    }
})()
