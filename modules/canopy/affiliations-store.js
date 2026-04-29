"use strict"

/**
 * Letter L slice L4-lite — affiliation graph store.
 *
 * The single source of "kin / partner / competitor" classification across
 * the canopy. Every observed enterprise (whether one of the user's own
 * airlines or a competitor) is tagged with one of six kinds:
 *
 *   self        — one of the user's own airlines (kinId groups it into a
 *                 family conglomerate; same kinId = same kin family)
 *   allied      — alliance partner (member of a formal AS alliance)
 *   interline   — interlining agreement (passenger / cargo handoff)
 *   codeshare   — codeshare agreement (more integrated than interline)
 *   neutral     — observed but no relationship (default for new enterprises)
 *   adversary   — explicit competitor (user-declared; rarely used today)
 *
 * Storage: `aesCanopy:affiliations` — single canopy-scope blob.
 *
 *   {
 *     schemaVersion: 1,
 *     byEnterpriseId: {
 *       [enterpriseId]: {
 *         enterpriseId,
 *         kind,                    // one of KINDS
 *         kinId?,                  // present when kind === "self"; groups
 *                                  // multiple self-enterprises into one
 *                                  // family. Defaults to enterpriseId.
 *         accountId?,              // optional cross-link to AesAccountRegistry
 *         userOverride,            // true = user assignment is absolute
 *         autoClassifiedKind?,     // detector's last result (for "Reset to detected")
 *         classifiedAt,
 *         source                   // "user" | "auto:contractualPartners" | "auto:myEnterpriseIds"
 *       }
 *     },
 *     lastAutoClassifiedAt
 *   }
 *
 * Single-writer rule: writes go through `_save()` which read-modify-writes
 * atomically. Cross-tab consumers subscribe to `chrome.storage.onChanged`;
 * the store also emits `canopy:affiliations-changed` on the bus.
 *
 * Invariant L4-A (HANDOVER §10): user-override absolute. Auto-classify
 * only writes when `userOverride !== true`. `setKind(..., {source: "user"})`
 * flips the override to true. `resetToDetected()` clears it.
 *
 * Invariant L4-B (HANDOVER §10): kinId is the grouping primitive. M-series
 * proposers iterate over distinct kinIds and treat self-enterprises with
 * matching kinId as one family unit. Default kinId = enterpriseId; user
 * can re-group via `setKinId(enterpriseId, kinId)` to merge two
 * self-enterprises into one kin (typically when the same person owns
 * multiple AS airlines that should be planned as one conglomerate).
 */
;(function () {
    if (window.AesCanopyAffiliations) return

    const KEY = "aesCanopy:affiliations"

    const KINDS = ["self", "allied", "interline", "codeshare", "neutral", "adversary"]

    const KIND_LABELS = {
        "self":      "Kin",
        "allied":    "Allied",
        "interline": "Interline",
        "codeshare": "Codeshare",
        "neutral":   "Neutral",
        "adversary": "Adversary"
    }

    const KIND_COLORS = {
        "self":      "#10b981",
        "allied":    "#a855f7",
        "interline": "#3b82f6",
        "codeshare": "#06b6d4",
        "neutral":   "#94a3b8",
        "adversary": "#ef4444"
    }

    // AS contractual-partner relation tokens → affiliation kind. Tokens
    // captured verbatim from `<span class="type X">` per
    // contractual-partners-scraper.js. Unknown tokens map to "neutral"
    // so storage always lands in a known state.
    const RELATION_TO_KIND = {
        "ALLIANCE":    "allied",
        "INTERLINING": "interline",
        "CODESHARE":   "codeshare",
        "BLOCK_SPACE": "codeshare",
        "WET_LEASE":   "neutral",     // commercial — not strategic kinship
        "LESSOR":      "neutral",
        "LESSEE":      "neutral"
    }

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesAfp && window.AesAfp.bus) window.AesAfp.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
    }

    function _defaults() {
        return {schemaVersion: 1, byEnterpriseId: {}, lastAutoClassifiedAt: 0}
    }

    function _normRecord(rec, enterpriseId) {
        rec = rec || {}
        const kind = (typeof rec.kind === "string" && KINDS.indexOf(rec.kind) >= 0) ? rec.kind : "neutral"
        return {
            enterpriseId:        String(enterpriseId),
            kind:                kind,
            kinId:               kind === "self" ? (rec.kinId || String(enterpriseId)) : null,
            accountId:           rec.accountId || null,
            userOverride:        rec.userOverride === true,
            autoClassifiedKind:  typeof rec.autoClassifiedKind === "string" ? rec.autoClassifiedKind : null,
            classifiedAt:        Number(rec.classifiedAt) || 0,
            source:              typeof rec.source === "string" ? rec.source : "auto:default"
        }
    }

    async function load() {
        const out = await chrome.storage.local.get([KEY])
        const raw = out[KEY] || _defaults()
        if (!raw.byEnterpriseId || typeof raw.byEnterpriseId !== "object") raw.byEnterpriseId = {}
        const merged = Object.assign(_defaults(), raw)
        for (const id in merged.byEnterpriseId) {
            merged.byEnterpriseId[id] = _normRecord(merged.byEnterpriseId[id], id)
        }
        return merged
    }

    async function _save(block) {
        await chrome.storage.local.set({[KEY]: block})
    }

    /**
     * Resolve the affiliation for one enterprise. Returns the neutral
     * default record when no entry exists — caller never has to null-check.
     */
    async function classify(enterpriseId) {
        if (enterpriseId == null) return _normRecord({}, "")
        const block = await load()
        return block.byEnterpriseId[String(enterpriseId)] || _normRecord({}, enterpriseId)
    }

    async function classifyMany(enterpriseIds) {
        const out = new Map()
        if (!enterpriseIds || !enterpriseIds.length) return out
        const block = await load()
        for (const id of enterpriseIds) {
            const key = String(id)
            out.set(key, block.byEnterpriseId[key] || _normRecord({}, key))
        }
        return out
    }

    /** All known affiliation records keyed by enterpriseId. */
    async function getAll() {
        const block = await load()
        return block.byEnterpriseId
    }

    /** Enumerate distinct kinIds for kind === "self" entries. */
    async function listKinIds() {
        const block = await load()
        const set = new Set()
        for (const id in block.byEnterpriseId) {
            const r = block.byEnterpriseId[id]
            if (r.kind === "self" && r.kinId) set.add(r.kinId)
        }
        return Array.from(set)
    }

    /** Map kinId → enterpriseId[] (so callers can group self-enterprises). */
    async function membersByKinId() {
        const block = await load()
        const map = new Map()
        for (const id in block.byEnterpriseId) {
            const r = block.byEnterpriseId[id]
            if (r.kind !== "self" || !r.kinId) continue
            const list = map.get(r.kinId) || []
            list.push(r.enterpriseId)
            map.set(r.kinId, list)
        }
        return map
    }

    /**
     * Set the kind explicitly. `source: "user"` flips userOverride to true
     * (absolute, mirrors §4.15 + invariant L4-A).
     */
    async function setKind(enterpriseId, kind, opts) {
        if (enterpriseId == null) return null
        if (KINDS.indexOf(kind) < 0) return null
        const source = (opts && opts.source) || "user"
        const block = await load()
        const id = String(enterpriseId)
        const cur = block.byEnterpriseId[id] || _normRecord({}, id)
        if (source !== "user" && cur.userOverride === true) {
            return cur
        }
        const next = Object.assign({}, cur, {
            kind:         kind,
            kinId:        kind === "self" ? (cur.kinId || id) : null,
            userOverride: source === "user" ? true : cur.userOverride,
            classifiedAt: Date.now(),
            source:       source
        })
        block.byEnterpriseId[id] = _normRecord(next, id)
        await _save(block)
        _emit("canopy:affiliations-changed", {enterpriseId: id, action: "set", kind, source})
        return block.byEnterpriseId[id]
    }

    /**
     * Re-group a self-enterprise into a different kin family. Used to
     * merge two of the user's airlines into one conglomerate (matching
     * kinIds = same kin). Pass kinId === null to reset back to the
     * enterprise's own ID.
     */
    async function setKinId(enterpriseId, kinId) {
        if (enterpriseId == null) return null
        const block = await load()
        const id = String(enterpriseId)
        const cur = block.byEnterpriseId[id]
        if (!cur || cur.kind !== "self") return null
        const next = Object.assign({}, cur, {
            kinId:        kinId || id,
            userOverride: true,
            classifiedAt: Date.now(),
            source:       "user"
        })
        block.byEnterpriseId[id] = _normRecord(next, id)
        await _save(block)
        _emit("canopy:affiliations-changed", {enterpriseId: id, action: "kinId", kinId: next.kinId})
        return block.byEnterpriseId[id]
    }

    /** Clear the user override and let the auto-classifier own the kind. */
    async function resetToDetected(enterpriseId) {
        if (enterpriseId == null) return null
        const block = await load()
        const id = String(enterpriseId)
        const cur = block.byEnterpriseId[id]
        if (!cur) return null
        const next = Object.assign({}, cur, {
            kind:         cur.autoClassifiedKind || "neutral",
            kinId:        cur.autoClassifiedKind === "self" ? id : null,
            userOverride: false,
            classifiedAt: Date.now(),
            source:       "auto:reset"
        })
        block.byEnterpriseId[id] = _normRecord(next, id)
        await _save(block)
        _emit("canopy:affiliations-changed", {enterpriseId: id, action: "reset"})
        return block.byEnterpriseId[id]
    }

    /** Drop a record entirely. */
    async function remove(enterpriseId) {
        if (enterpriseId == null) return false
        const block = await load()
        const id = String(enterpriseId)
        if (!block.byEnterpriseId[id]) return false
        delete block.byEnterpriseId[id]
        await _save(block)
        _emit("canopy:affiliations-changed", {enterpriseId: id, action: "deleted"})
        return true
    }

    /**
     * Auto-classify pass:
     *   1. settings.routeAssistant.carriers.myEnterpriseIds → mark each as
     *      "self" (skipped for entries with userOverride === true).
     *   2. For each self enterprise, walk the cached
     *      routeAssistant:contractualPartners:<enterpriseId> record and
     *      classify each partner via RELATION_TO_KIND. Multiple relations
     *      → strongest wins (codeshare > allied > interline > neutral).
     *
     * Returns a summary `{processedSelfIds, processedPartnerIds, classifiedSelf,
     * classifiedAllied, classifiedInterline, classifiedCodeshare, classifiedNeutral}`
     * for the caller (e.g. a settings-page button) to surface to the user.
     *
     * Pure-on-input + idempotent: rerunning without storage changes is a
     * no-op (writes are skipped when the new record matches the existing).
     */
    async function autoClassifyFromContractualPartners() {
        const summary = {
            processedSelfIds:      0,
            processedPartnerIds:   0,
            classifiedSelf:        0,
            classifiedAllied:      0,
            classifiedInterline:   0,
            classifiedCodeshare:   0,
            classifiedNeutral:     0,
            updated:               0
        }

        const myIds = await _readMyEnterpriseIds()
        if (!myIds.length) return summary

        const block = await load()
        let dirty = false

        // Pass 1 — mark our own enterprises.
        for (const id of myIds) {
            summary.processedSelfIds++
            const cur = block.byEnterpriseId[id] || _normRecord({}, id)
            if (cur.userOverride === true) continue
            const next = Object.assign({}, cur, {
                kind:                "self",
                kinId:               cur.kinId || id,
                autoClassifiedKind:  "self",
                classifiedAt:        Date.now(),
                source:              "auto:myEnterpriseIds"
            })
            const normed = _normRecord(next, id)
            if (!_recordEquals(cur, normed)) {
                block.byEnterpriseId[id] = normed
                dirty = true
                summary.updated++
                summary.classifiedSelf++
            }
        }

        // Pass 2 — walk each own enterprise's contractual partners cache.
        // Highest-priority relation wins per partner — see _strongestKind.
        const records = await _readContractualPartnersFor(myIds)
        for (const ownId in records) {
            const rec = records[ownId]
            if (!rec || !Array.isArray(rec.partners)) continue
            for (const p of rec.partners) {
                const pid = p && p.partnerId != null ? String(p.partnerId) : null
                if (!pid) continue
                summary.processedPartnerIds++
                const cur = block.byEnterpriseId[pid] || _normRecord({}, pid)
                if (cur.userOverride === true) continue
                if (cur.kind === "self") continue // never demote our own enterprises
                const detectedKind = _strongestKind(p.relations || [])
                if (!detectedKind) continue
                const next = Object.assign({}, cur, {
                    kind:                detectedKind,
                    kinId:               null,
                    autoClassifiedKind:  detectedKind,
                    classifiedAt:        Date.now(),
                    source:              "auto:contractualPartners"
                })
                const normed = _normRecord(next, pid)
                if (!_recordEquals(cur, normed)) {
                    block.byEnterpriseId[pid] = normed
                    dirty = true
                    summary.updated++
                    if (detectedKind === "allied")    summary.classifiedAllied++
                    if (detectedKind === "interline") summary.classifiedInterline++
                    if (detectedKind === "codeshare") summary.classifiedCodeshare++
                    if (detectedKind === "neutral")   summary.classifiedNeutral++
                }
            }
        }

        if (dirty) {
            block.lastAutoClassifiedAt = Date.now()
            await _save(block)
            _emit("canopy:affiliations-changed", {action: "auto-classified", summary})
        }

        return summary
    }

    function _strongestKind(relations) {
        if (!relations || !relations.length) return null
        // Strength order: codeshare > allied > interline > anything mapped > null
        const ranks = {"codeshare": 4, "allied": 3, "interline": 2, "neutral": 1}
        let best = null, bestRank = 0
        for (const r of relations) {
            const tok = String(r || "").toUpperCase()
            const kind = RELATION_TO_KIND[tok]
            if (!kind) continue
            const rank = ranks[kind] || 0
            if (rank > bestRank) {
                bestRank = rank
                best = kind
            }
        }
        return best
    }

    function _recordEquals(a, b) {
        if (!a || !b) return false
        return a.kind === b.kind &&
            a.kinId === b.kinId &&
            a.accountId === b.accountId &&
            a.userOverride === b.userOverride &&
            a.autoClassifiedKind === b.autoClassifiedKind &&
            a.source === b.source
    }

    async function _readMyEnterpriseIds() {
        try {
            const out = await chrome.storage.local.get(["settings"])
            const block = (out.settings && out.settings.routeAssistant) || {}
            const carriers = block.carriers || {}
            const ids = Array.isArray(carriers.myEnterpriseIds) ? carriers.myEnterpriseIds : []
            return ids.map(id => String(id)).filter(id => id.length > 0)
        } catch (_) { return [] }
    }

    async function _readContractualPartnersFor(enterpriseIds) {
        const PREFIX = "routeAssistant:contractualPartners:"
        const keys = enterpriseIds.map(id => PREFIX + String(id))
        if (!keys.length) return {}
        const out = await chrome.storage.local.get(keys)
        const remapped = {}
        for (const k in out) {
            const id = k.slice(PREFIX.length)
            remapped[id] = out[k]
        }
        return remapped
    }

    function kindLabel(kind) {
        return KIND_LABELS[kind] || KIND_LABELS.neutral
    }

    function kindColor(kind) {
        return KIND_COLORS[kind] || KIND_COLORS.neutral
    }

    window.AesCanopyAffiliations = {
        load,
        classify,
        classifyMany,
        getAll,
        listKinIds,
        membersByKinId,
        setKind,
        setKinId,
        resetToDetected,
        remove,
        autoClassifyFromContractualPartners,
        kindLabel,
        kindColor,
        KINDS,
        KIND_LABELS,
        KIND_COLORS,
        RELATION_TO_KIND,
        KEY
    }
})()
