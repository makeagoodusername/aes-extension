"use strict";

/**
 * AES Customization — built-in preset bundles.
 *
 * A preset is a {cssVar → value} map applied as the bottom layer of
 * the cascade (preset → global override → section override → tile
 * override). Switching presets is one chrome.storage.local write; the
 * applier rebuilds <style id="aes-customization-overrides"> in place
 * and the browser repaints.
 *
 * Default preset = current AES values verbatim. First-launch behaviour
 * is byte-identical to today.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESPresets) return;

    /* The Default preset is generated lazily from the registry so it
       cannot drift from design-tokens.css. */
    function defaultPreset() {
        const reg = window.AESTokenRegistry;
        return {
            id: "default",
            name: "Default",
            description: "The current AES look — bone canvas, oxide structure, rust signal.",
            builtIn: true,
            tokens: reg ? reg.defaults() : {}
        };
    }

    /* Editorial Brutalism — calm, dense data on quiet ground. Same
       palette as Default but tightens borders and adds hard offset
       shadows. Geometry and spacing are nudged toward generous. */
    const editorialBrutalism = {
        id: "editorial-brutalism",
        name: "Editorial Brutalism",
        description: "Print-magazine restraint: oxide + bone + rust, generous space, hard rules, no blur.",
        builtIn: true,
        tokens: {
            "--aes-bone":        "#F4F1EA",
            "--aes-bone-2":      "#ECE7DC",
            "--aes-bone-3":      "#DAD3BF",
            "--aes-paper-rule":  "#B8AE9A",
            "--aes-oxide":       "#1F1A15",
            "--aes-oxide-2":     "#3A322B",
            "--aes-slate":       "#7A6F66",
            "--aes-rust":        "#A03E25",
            "--aes-rust-deep":   "#76301B",
            "--aes-radius":      "0",
            "--aes-bw-1":        "1px",
            "--aes-bw-2":        "2px",
            "--aes-bw-3":        "4px",
            "--aes-sp-5":        "28px",
            "--aes-sp-6":        "40px",
            "--aes-sp-7":        "56px"
        }
    };

    /* Oxide Dark — inverted brightness. Bone↔oxide swap. Rust accent
       stays so the focus signal is unchanged. */
    const oxideDark = {
        id: "oxide-dark",
        name: "Oxide Dark",
        description: "Dark surfaces, bone text, rust accent kept loud.",
        builtIn: true,
        tokens: {
            "--aes-bone":        "#1A1612",
            "--aes-bone-2":      "#241E18",
            "--aes-bone-3":      "#2E2823",
            "--aes-paper-rule":  "#4A413B",
            "--aes-oxide":       "#F4F1EA",
            "--aes-oxide-2":     "#C9BFB5",
            "--aes-slate":       "#9A8F85",
            "--aes-rust":        "#D85937",
            "--aes-rust-deep":   "#A8442B"
        }
    };

    function listBuiltIn() {
        return [defaultPreset(), editorialBrutalism, oxideDark];
    }

    function getById(id) {
        if (id === "default") return defaultPreset();
        if (id === "editorial-brutalism") return editorialBrutalism;
        if (id === "oxide-dark") return oxideDark;
        return null;
    }

    window.AESPresets = {
        listBuiltIn,
        getById,
        DEFAULT_ID: "default"
    };
})();
