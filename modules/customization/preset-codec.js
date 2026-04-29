"use strict";

/**
 * AES Customization — preset codec.
 *
 * JSON serializer / parser for theme exports. The export bundle is a
 * portable snapshot of the active preset plus the user's global
 * overrides plus shortcut rebinds. Suitable for round-tripping
 * through the Studio's Export / Import pair, posting in a forum, or
 * versioning in a dotfile.
 *
 * Validation is conservative — unknown CSS variables are dropped (not
 * a hard error) so themes from a future AES version partially load on
 * an older one.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESPresetCodec) return;

    const SCHEMA = "aes-customization-export";
    const SCHEMA_VERSION = 1;

    function exportBundle() {
        const store = window.AESCustomizationStore;
        const reg = window.AESTokenRegistry;
        if (!store || !reg) return null;
        const snapshot = store.get();
        const preset = store.activePreset();
        return {
            schema: SCHEMA,
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            extensionVersion: chromeRuntimeVersion(),
            active: { presetId: snapshot.active.presetId },
            preset: preset ? {
                id: preset.id,
                name: preset.name,
                tokens: cloneTokens(preset.tokens || {})
            } : null,
            globalOverrides: cloneTokens(snapshot.scopes && snapshot.scopes.global || {}),
            sectionOverrides: cloneSectionOverrides(snapshot.scopes && snapshot.scopes.section || {}),
            tileOverrides:    cloneTileOverrides(snapshot.scopes && snapshot.scopes.tile || {}),
            ornament: cloneOrnament(snapshot.ornament || {}),
            density:  cloneDensity(snapshot.density || {}),
            numerals: cloneNumerals(snapshot.numerals || {}),
            userPresets: cloneUserPresets(snapshot.userPresets || {}),
            shortcuts: cloneShortcuts(snapshot.shortcuts || {})
        };
    }

    /* B-3 — export a single user-defined preset as its own bundle, suitable
       for sharing one configuration without leaking the rest of the user's
       Studio state. */
    function exportUserPreset(preset) {
        if (!preset || !preset.snapshot) return null;
        const snap = preset.snapshot;
        return {
            schema: SCHEMA,
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            extensionVersion: chromeRuntimeVersion(),
            kind: "user-preset",
            preset: {
                id: String(preset.id || ""),
                name: String(preset.name || "Imported preset"),
                createdAt: Number(preset.createdAt) || Date.now()
            },
            active: { presetId: String(snap.presetId || "default") },
            globalOverrides:  cloneTokens(snap.globalOverrides  || {}),
            sectionOverrides: cloneSectionOverrides(snap.sectionOverrides || {}),
            tileOverrides:    cloneTileOverrides(snap.tileOverrides || {}),
            ornament: cloneOrnament(snap.ornament || {}),
            density:  cloneDensity(snap.density || {}),
            numerals: cloneNumerals(snap.numerals || {})
        };
    }

    function cloneSectionOverrides(map) {
        const out = {};
        for (const id of Object.keys(map)) {
            const v = map[id];
            if (v && typeof v === "object") out[id] = cloneTokens(v);
        }
        return out;
    }
    function cloneTileOverrides(map) {
        const out = {};
        for (const id of Object.keys(map)) {
            const v = map[id];
            if (v && typeof v === "object") out[id] = cloneTokens(v);
        }
        return out;
    }
    function cloneOrnament(o) {
        const out = {};
        if (o && typeof o.intensity === "string") out.intensity = o.intensity;
        return out;
    }
    function cloneDensity(d) {
        const out = { bySurface: {} };
        const src = (d && d.bySurface && typeof d.bySurface === "object") ? d.bySurface : {};
        for (const k of Object.keys(src)) {
            const v = src[k];
            if (typeof v === "string") out.bySurface[k] = v;
        }
        return out;
    }
    function cloneNumerals(n) {
        const out = {};
        if (!n || typeof n !== "object") return out;
        for (const k of Object.keys(n)) {
            const v = n[k];
            if (typeof v === "string") out[k] = v;
        }
        return out;
    }
    function cloneUserPresets(map) {
        const out = {};
        for (const id of Object.keys(map)) {
            const p = map[id];
            if (!p || typeof p !== "object") continue;
            out[id] = {
                id:        String(p.id || id),
                name:      String(p.name || "Untitled"),
                createdAt: Number(p.createdAt) || Date.now(),
                snapshot:  p.snapshot && typeof p.snapshot === "object" ? p.snapshot : {}
            };
        }
        return out;
    }

    function chromeRuntimeVersion() {
        try { return chrome.runtime.getManifest().version; }
        catch (_) { return "?"; }
    }

    function cloneTokens(map) {
        const reg = window.AESTokenRegistry;
        const out = {};
        for (const k of Object.keys(map)) {
            if (!reg || reg.has(k)) out[k] = String(map[k]);
        }
        return out;
    }

    function cloneShortcuts(map) {
        const out = {};
        for (const id of Object.keys(map)) {
            const v = map[id];
            if (v && typeof v === "object" && typeof v.keys === "string") {
                out[id] = { keys: v.keys, disabled: !!v.disabled };
            }
        }
        return out;
    }

    /**
     * @param {string} json
     * @returns {{ok: boolean, bundle?: Object, error?: string}}
     */
    function parse(json) {
        let data;
        try { data = JSON.parse(json); }
        catch (e) { return { ok: false, error: "Invalid JSON: " + (e && e.message) }; }
        if (!data || typeof data !== "object") return { ok: false, error: "Not an object" };
        if (data.schema !== SCHEMA) return { ok: false, error: "Wrong schema (expected '" + SCHEMA + "')" };
        const v = Number(data.schemaVersion);
        if (!isFinite(v) || v < 1) return { ok: false, error: "Bad schemaVersion" };
        if (v > SCHEMA_VERSION) {
            // Forward-compat: accept newer bundles, just warn that some
            // fields may be ignored. Down-rev validation is lenient.
        }
        return {
            ok: true,
            bundle: {
                active: data.active && typeof data.active === "object"
                    ? { presetId: String(data.active.presetId || "default") }
                    : { presetId: "default" },
                preset: data.preset && typeof data.preset === "object"
                    ? {
                        id: String(data.preset.id || "imported"),
                        name: String(data.preset.name || "Imported preset"),
                        tokens: cloneTokens(data.preset.tokens || {})
                    } : null,
                globalOverrides:  cloneTokens(data.globalOverrides || {}),
                sectionOverrides: cloneSectionOverrides(data.sectionOverrides || {}),
                tileOverrides:    cloneTileOverrides(data.tileOverrides || {}),
                ornament: cloneOrnament(data.ornament || {}),
                density:  cloneDensity(data.density || {}),
                numerals: cloneNumerals(data.numerals || {}),
                userPresets: cloneUserPresets(data.userPresets || {}),
                shortcuts: cloneShortcuts(data.shortcuts || {}),
                kind: data.kind === "user-preset" ? "user-preset" : null
            }
        };
    }

    /**
     * Apply a parsed bundle to the customization store. Idempotent —
     * the store's patch handler shallow-merges the result.
     */
    function apply(bundle) {
        const store = window.AESCustomizationStore;
        if (!store || !bundle) return Promise.resolve({ ok: false, error: "no store" });

        // Apply the clear pass + base preset assignment first.
        const clearPatch = {
            active: { presetId: bundle.active.presetId },
            scopes: { global: "__CLEAR__", section: "__CLEAR__", tile: "__CLEAR__" },
            ornament: bundle.ornament || { intensity: "moderate" },
            density: { bySurface: "__CLEAR__" },
            numerals: "__CLEAR__",
            shortcuts: bundle.shortcuts
        };

        return store.patch(clearPatch).then(function () {
            // Re-write overrides as a second patch (deep-merge fills the cleared branches).
            return store.patch({
                scopes: {
                    global:  bundle.globalOverrides  || {},
                    section: bundle.sectionOverrides || {},
                    tile:    bundle.tileOverrides    || {}
                },
                density: { bySurface: (bundle.density && bundle.density.bySurface) || {} },
                numerals: bundle.numerals || {}
            });
        }).then(function () {
            const builtIns = ["default", "editorial-brutalism", "oxide-dark", "deco-ivory", "deco-noir"];
            if (bundle.preset && builtIns.indexOf(bundle.preset.id) < 0) {
                // Persist a user-defined preset alongside built-ins.
                return store.patch({ presets: { [bundle.preset.id]: bundle.preset } });
            }
            return null;
        }).then(function () {
            // Persist any imported user-defined preset bundles (B-3).
            const up = bundle.userPresets || {};
            const ids = Object.keys(up);
            if (ids.length) return store.patch({ userPresets: up });
            return null;
        });
    }

    function downloadJson(bundle, filename) {
        const text = JSON.stringify(bundle, null, 2);
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || ("aes-theme-" + (bundle && bundle.active ? bundle.active.presetId : "export") + ".json");
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 0);
    }

    window.AESPresetCodec = {
        SCHEMA,
        SCHEMA_VERSION,
        exportBundle,
        exportUserPreset,
        parse,
        apply,
        downloadJson
    };
})();
