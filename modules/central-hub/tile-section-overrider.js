"use strict";

/**
 * Central Hub — Tile Section Overrider.
 *
 * Optional per-tile section reassignment. Shell consults this before
 * mounting tiles so a user can move e.g. "alliance-tile" from the
 * "tools" section to "operations" without changing tile code.
 *
 * Behind a kill switch — default OFF. Even when enabled, the override
 * map starts empty so the default IA is preserved. Storage is additive:
 *   centralHub.settings.tileSectionOverrides         { tileId → sectionId }
 *   centralHub.settings.tileSectionOverridesEnabled  bool (default false)
 *
 * Constraint per shell.js:_scrollToActiveSection: all five section
 * containers (fleet/routes/operations/finance/tools) MUST keep
 * rendering even when empty. Empty sections get an inline "tiles
 * moved out — restore defaults?" affordance via shell wiring.
 */
class CentralHubTileSectionOverrider {
    /**
     * Apply overrides to a list of registered tile specs. Returns a new
     * array with each spec's `section` field rewritten where an
     * override exists. Pure function — does not mutate inputs.
     *
     * @param {Array<{id, section, ...}>} specs
     * @param {{tileSectionOverrides, tileSectionOverridesEnabled}} settings
     * @param {Array<string>} validSections
     * @returns {Array}
     */
    static apply(specs, settings, validSections) {
        if (!Array.isArray(specs)) return [];
        const enabled = settings && settings.tileSectionOverridesEnabled === true;
        const overrides = (settings && settings.tileSectionOverrides && typeof settings.tileSectionOverrides === "object")
            ? settings.tileSectionOverrides : null;
        if (!enabled || !overrides) return specs.slice();
        const valid = new Set(Array.isArray(validSections) ? validSections : []);
        return specs.map(function (spec) {
            if (!spec || !spec.id) return spec;
            const override = overrides[spec.id];
            if (typeof override !== "string" || !override) return spec;
            if (valid.size && !valid.has(override)) return spec;
            return Object.assign({}, spec, { section: override, _sectionOverridden: true });
        });
    }

    /**
     * Set the override for a tile. Pass null to clear.
     */
    static async set(tileId, sectionId) {
        if (!window.CentralHubSettings) return;
        if (!tileId) return;
        const settings = await window.CentralHubSettings.load();
        const overrides = (settings.tileSectionOverrides && typeof settings.tileSectionOverrides === "object")
            ? Object.assign({}, settings.tileSectionOverrides) : {};
        if (sectionId == null) {
            delete overrides[tileId];
        } else {
            overrides[tileId] = String(sectionId);
        }
        await window.CentralHubSettings.patch({ tileSectionOverrides: overrides });
    }

    /**
     * Clear all overrides — used by the empty-section "restore defaults"
     * affordance.
     */
    static async clearAll() {
        if (!window.CentralHubSettings) return;
        await window.CentralHubSettings.patch({ tileSectionOverrides: {} });
    }
}

if (typeof window !== "undefined") {
    window.CentralHubTileSectionOverrider = CentralHubTileSectionOverrider;
}
