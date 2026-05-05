"use strict"

/**
 * AES Strategy — layered overrides codec (Slice 5).
 *
 * Portable export/import for any single layer record (family /
 * division / fleet / route-extras). Mirrors
 * modules/customization/preset-codec.js — same two-pass clear+merge
 * pattern so a partial import never leaves a half-applied record on
 * disk.
 *
 * Bundle shape:
 *   {
 *     schema: "aes-strategy-layered-export",
 *     schemaVersion: 1,
 *     scope: {
 *       layer: "family"|"division"|"fleet"|"route-extras",
 *       kinId?, accountId?, divisionId?, fleetId?, hub?, dest?
 *     },
 *     record: {
 *       patch, pinned, label, schemaVersion, layerKind
 *     },
 *     // For division/fleet exports, optionally embed the def:
 *     def?: {id, name, kind, members, priority, color, description}
 *   }
 *
 * Public API (window.AesStrategyLayeredCodec):
 *   exportBundle(scope)   → Promise<bundle>
 *   apply(bundle)         → Promise<{ok, scope}>
 *   parse(json)           → bundle | null    (synchronous JSON validation)
 *   stringify(bundle)     → string
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredCodec) return

    const SCHEMA = "aes-strategy-layered-export"
    const SCHEMA_VERSION = 1

    function stringify(bundle) {
        return JSON.stringify(bundle, null, 2)
    }

    function parse(json) {
        try {
            const blob = (typeof json === "string") ? JSON.parse(json) : json
            if (!blob || blob.schema !== SCHEMA) return null
            if (Number(blob.schemaVersion) > SCHEMA_VERSION) return null
            if (!blob.scope || !blob.scope.layer) return null
            return blob
        } catch (_) { return null }
    }

    async function exportBundle(scope) {
        scope = scope || {}
        const layer = String(scope.layer || "")
        let record = null
        let def = null
        if (layer === "family") {
            const F = window.AesStrategyLayeredFamily
            if (!F) throw new Error("codec: family-store not loaded")
            record = await F.load(scope.kinId)
        } else if (layer === "division") {
            const D = window.AesStrategyLayeredDivision
            if (!D) throw new Error("codec: division-store not loaded")
            record = await D.loadRecord(scope.accountId, scope.divisionId)
            const idx = await D.loadIndex(scope.accountId)
            def = idx && idx.divisions ? idx.divisions[scope.divisionId] : null
        } else if (layer === "fleet") {
            const F = window.AesStrategyLayeredFleet
            if (!F) throw new Error("codec: fleet-store not loaded")
            record = await F.loadRecord(scope.accountId, scope.fleetId)
            const idx = await F.loadIndex(scope.accountId)
            def = idx && idx.fleets ? idx.fleets[scope.fleetId] : null
        } else if (layer === "route-extras") {
            const R = window.AesStrategyLayeredRouteExtras
            if (!R) throw new Error("codec: route-extras-store not loaded")
            record = await R.load(scope.accountId, scope.hub, scope.dest)
        } else {
            throw new Error("codec: unknown layer " + layer)
        }
        const bundle = {
            schema: SCHEMA,
            schemaVersion: SCHEMA_VERSION,
            scope: Object.assign({}, scope),
            record: record || {patch: {}, pinned: {}, label: "", schemaVersion: 1, layerKind: layer}
        }
        if (def) {
            bundle.def = {
                id: def.id, name: def.name, kind: def.kind,
                members: def.members, priority: def.priority,
                color: def.color, description: def.description
            }
        }
        return bundle
    }

    async function apply(bundleOrJson) {
        const bundle = (typeof bundleOrJson === "string") ? parse(bundleOrJson) : bundleOrJson
        if (!bundle) return {ok: false, reason: "invalid bundle"}
        const scope = bundle.scope || {}
        const layer = String(scope.layer || "")
        const rec   = bundle.record || {patch: {}, pinned: {}, label: ""}

        if (layer === "family") {
            const F = window.AesStrategyLayeredFamily
            if (!F) return {ok: false, reason: "family-store not loaded"}
            // Two-pass: clear then save. clearAll wipes the record;
            // save writes the imported patch atomically (single
            // chrome.storage.local.set inside save).
            await F.clearAll(scope.kinId)
            await F.save({kinId: scope.kinId, patch: rec.patch || {},
                          pinned: rec.pinned || {}, label: rec.label || ""})
            return {ok: true, scope}
        }
        if (layer === "division") {
            const D = window.AesStrategyLayeredDivision
            if (!D) return {ok: false, reason: "division-store not loaded"}
            // Ensure def exists; if absent, create it from the bundle's
            // embedded def (if any). Otherwise fall back to a manual
            // empty-membership stub the user can edit later.
            const idx = await D.loadIndex(scope.accountId)
            const id = scope.divisionId
            if (!idx.divisions[id]) {
                if (bundle.def) {
                    await D.create(scope.accountId,
                        Object.assign({}, bundle.def, {id: id}))
                } else {
                    await D.create(scope.accountId, {id: id, name: "Imported division", kind: "manual", members: {}})
                }
            } else if (bundle.def) {
                await D.updateDef(scope.accountId, id, bundle.def)
            }
            await D.saveRecord(scope.accountId, id,
                {patch: rec.patch || {}, pinned: rec.pinned || {}, label: rec.label || ""})
            return {ok: true, scope}
        }
        if (layer === "fleet") {
            const F = window.AesStrategyLayeredFleet
            if (!F) return {ok: false, reason: "fleet-store not loaded"}
            const idx = await F.loadIndex(scope.accountId)
            const id = scope.fleetId
            if (!idx.fleets[id]) {
                if (bundle.def) {
                    await F.create(scope.accountId,
                        Object.assign({}, bundle.def, {id: id}))
                } else {
                    await F.create(scope.accountId, {id: id, name: "Imported fleet", kind: "aircraft-types", members: {aircraftTypes: []}})
                }
            } else if (bundle.def) {
                await F.updateDef(scope.accountId, id, bundle.def)
            }
            await F.saveRecord(scope.accountId, id,
                {patch: rec.patch || {}, pinned: rec.pinned || {}, label: rec.label || ""})
            return {ok: true, scope}
        }
        if (layer === "route-extras") {
            const R = window.AesStrategyLayeredRouteExtras
            if (!R) return {ok: false, reason: "route-extras-store not loaded"}
            await R.clear(scope.accountId, scope.hub, scope.dest)
            await R.save(scope.accountId, scope.hub, scope.dest,
                {patch: rec.patch || {}, pinned: rec.pinned || {}, label: rec.label || ""})
            return {ok: true, scope}
        }
        return {ok: false, reason: "unknown layer " + layer}
    }

    window.AesStrategyLayeredCodec = {
        SCHEMA:        SCHEMA,
        SCHEMA_VERSION: SCHEMA_VERSION,
        exportBundle: exportBundle,
        apply:        apply,
        parse:        parse,
        stringify:    stringify
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const ok = parse(stringify({schema: SCHEMA, schemaVersion: 1,
                                         scope: {layer: "family", kinId: "kinX"},
                                         record: {patch: {weights: {profitWeight: 0.6}}, pinned: {}, label: ""}}))
            console.assert(ok && ok.scope.layer === "family",
                "[codec/smoke] parse round-trips a valid bundle")
            console.assert(parse('{"schema":"wrong"}') === null,
                "[codec/smoke] parse rejects wrong schema")
            console.assert(parse('{"schema":"' + SCHEMA + '","schemaVersion":99}') === null,
                "[codec/smoke] parse rejects future schemaVersion")
        }
    } catch (_) {}
})()
