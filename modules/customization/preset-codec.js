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
            shortcuts: cloneShortcuts(snapshot.shortcuts || {})
        };
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
                globalOverrides: cloneTokens(data.globalOverrides || {}),
                shortcuts: cloneShortcuts(data.shortcuts || {})
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
        const patch = {
            active: { presetId: bundle.active.presetId },
            scopes: { global: "__CLEAR__" },
            shortcuts: bundle.shortcuts
        };
        // Apply the cleared global, then re-write overrides as a 2nd patch.
        return store.patch(patch).then(function () {
            return store.patch({ scopes: { global: bundle.globalOverrides || {} } });
        }).then(function () {
            if (bundle.preset && bundle.preset.id !== "default" && bundle.preset.id !== "editorial-brutalism" && bundle.preset.id !== "oxide-dark") {
                // Persist a user-defined preset alongside built-ins
                return store.patch({ presets: { [bundle.preset.id]: bundle.preset } });
            }
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
        parse,
        apply,
        downloadJson
    };
})();
