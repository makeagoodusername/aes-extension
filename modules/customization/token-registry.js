"use strict";

/**
 * AES Customization — token registry.
 *
 * Single source of truth for every CSS custom property the user can
 * override from the Studio. Mirrors css/design-tokens.css; adding a
 * token there means appending an entry here. Drives:
 *   - validation in the customization store (unknown vars are rejected)
 *   - the swatch grid + future sliders in the Studio
 *   - the JSON export schema
 *
 * Values stored here are the IMMUTABLE defaults — they survive a
 * "reset all" and are what the Default preset literally re-applies.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESTokenRegistry) return;

    const COLORS = [
        { var: "--aes-bone",         label: "Bone",          default: "#F4F1EA", format: "color", group: "color" },
        { var: "--aes-bone-2",       label: "Bone-2",        default: "#ECE7DC", format: "color", group: "color" },
        { var: "--aes-bone-3",       label: "Bone-3",        default: "#E0DAC8", format: "color", group: "color" },
        { var: "--aes-paper-rule",   label: "Paper rule",    default: "#C9C0B0", format: "color", group: "color" },
        { var: "--aes-oxide",        label: "Oxide",         default: "#2B2520", format: "color", group: "color" },
        { var: "--aes-oxide-2",      label: "Oxide-2",       default: "#4A413B", format: "color", group: "color" },
        { var: "--aes-slate",        label: "Slate",         default: "#7A6F66", format: "color", group: "color" },
        { var: "--aes-rust",         label: "Rust",          default: "#B8472A", format: "color", group: "color" },
        { var: "--aes-rust-deep",    label: "Rust deep",     default: "#8B3520", format: "color", group: "color" },
        { var: "--aes-cobalt",       label: "Cobalt (info)", default: "#3656A8", format: "color", group: "color" },
        { var: "--aes-moss",         label: "Moss (ok)",     default: "#2F5F3F", format: "color", group: "color" },
        { var: "--aes-amber",        label: "Amber (warn)",  default: "#B8861F", format: "color", group: "color" },
        { var: "--aes-crimson",      label: "Crimson (alert)", default: "#8B2727", format: "color", group: "color" },
        { var: "--aes-oxide-bg",     label: "Oxide bg",      default: "#1A1612", format: "color", group: "color-dark" },
        { var: "--aes-oxide-bg-2",   label: "Oxide bg-2",    default: "#28221C", format: "color", group: "color-dark" },
        { var: "--aes-vermilion",    label: "Vermilion",     default: "#C43A1F", format: "color", group: "color-cubist" },
        { var: "--aes-viridian",     label: "Viridian",      default: "#2A6E5A", format: "color", group: "color-cubist" },
        { var: "--aes-gold",         label: "Gold",          default: "#B88A2A", format: "color", group: "color-cubist" }
    ];

    const SPACING = [
        { var: "--aes-sp-1",   label: "sp-1", default: "4px",  format: "length", group: "spacing" },
        { var: "--aes-sp-2",   label: "sp-2", default: "8px",  format: "length", group: "spacing" },
        { var: "--aes-sp-3",   label: "sp-3", default: "12px", format: "length", group: "spacing" },
        { var: "--aes-sp-4",   label: "sp-4", default: "16px", format: "length", group: "spacing" },
        { var: "--aes-sp-5",   label: "sp-5", default: "24px", format: "length", group: "spacing" },
        { var: "--aes-sp-6",   label: "sp-6", default: "32px", format: "length", group: "spacing" },
        { var: "--aes-sp-7",   label: "sp-7", default: "48px", format: "length", group: "spacing" },
        { var: "--aes-radius", label: "Radius",   default: "0",    format: "length", group: "geom" },
        { var: "--aes-bw-1",   label: "Border 1", default: "1px",  format: "length", group: "geom" },
        { var: "--aes-bw-2",   label: "Border 2", default: "2px",  format: "length", group: "geom" },
        { var: "--aes-bw-3",   label: "Border 3", default: "3px",  format: "length", group: "geom" }
    ];

    const TYPE = [
        { var: "--aes-fs-micro",   label: "Font size — micro",   default: "10px", format: "length", group: "type" },
        { var: "--aes-fs-small",   label: "Font size — small",   default: "11px", format: "length", group: "type" },
        { var: "--aes-fs-body",    label: "Font size — body",    default: "12px", format: "length", group: "type" },
        { var: "--aes-fs-lead",    label: "Font size — lead",    default: "14px", format: "length", group: "type" },
        { var: "--aes-fs-h3",      label: "Font size — h3",      default: "18px", format: "length", group: "type" },
        { var: "--aes-fs-h2",      label: "Font size — h2",      default: "24px", format: "length", group: "type" },
        { var: "--aes-fs-h1",      label: "Font size — h1",      default: "36px", format: "length", group: "type" },
        { var: "--aes-fs-display", label: "Font size — display", default: "56px", format: "length", group: "type" }
    ];

    const ALL = COLORS.concat(SPACING).concat(TYPE);
    const BY_VAR = Object.create(null);
    for (const t of ALL) BY_VAR[t.var] = t;

    function get(cssVar)  { return BY_VAR[cssVar] || null; }
    function has(cssVar)  { return Object.prototype.hasOwnProperty.call(BY_VAR, cssVar); }
    function list(filter) { return filter ? ALL.filter(filter) : ALL.slice(); }

    /**
     * Default value snapshot — used by Reset and the Default preset.
     * @returns {Object<string, string>} cssVar → default value
     */
    function defaults() {
        const out = Object.create(null);
        for (const t of ALL) out[t.var] = t.default;
        return out;
    }

    window.AESTokenRegistry = {
        COLORS, SPACING, TYPE, ALL, BY_VAR,
        get, has, list, defaults
    };
})();
