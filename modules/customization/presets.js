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

    /* Deco — Ivory & Brass. Light Art Deco palette: ivory paper, lacquer
       text, brass accent, deep teal info, gilt warning, claret error. The
       `skin` field signals the applier to set body[data-aes-skin], which
       activates css/skin/skin-art-deco.css ornament effects. */
    const decoIvory = {
        id: "deco-ivory",
        name: "Deco — Ivory & Brass",
        description: "Light Art Deco: ivory + brass + deep teal, stepped frames, sunburst, fluting.",
        builtIn: true,
        skin: "art-deco",
        tokens: {
            "--aes-bone":         "#F1ECDD",
            "--aes-bone-2":       "#E7E0CC",
            "--aes-bone-3":       "#D9CFB4",
            "--aes-paper-rule":   "#B8A878",
            "--aes-oxide":        "#0E0B08",
            "--aes-oxide-2":      "#2A241D",
            "--aes-slate":        "#6E5F4A",
            "--aes-rust":         "#B8862E",
            "--aes-rust-deep":    "#8A6420",
            "--aes-rust-soft":    "rgba(184, 134, 46, 0.14)",
            "--aes-rust-fg":      "#0E0B08",
            "--aes-cobalt":       "#0F4A4E",
            "--aes-cobalt-soft":  "rgba(15, 74, 78, 0.14)",
            "--aes-moss":         "#1F5A3A",
            "--aes-moss-soft":    "rgba(31, 90, 58, 0.14)",
            "--aes-amber":        "#C49A3A",
            "--aes-amber-soft":   "rgba(196, 154, 58, 0.16)",
            "--aes-crimson":      "#7A1F2A",
            "--aes-crimson-soft": "rgba(122, 31, 42, 0.14)"
        }
    };

    /* Deco — Noir & Gold. Dark Art Deco palette: lacquer base, ivory text,
       brass accent kept warm, emerald success, claret error. Same skin
       activation as deco-ivory. */
    const decoNoir = {
        id: "deco-noir",
        name: "Deco — Noir & Gold",
        description: "Dark Art Deco: lacquer + brass + emerald, stepped frames, sunburst, fluting.",
        builtIn: true,
        skin: "art-deco",
        tokens: {
            "--aes-bone":         "#0E0B08",
            "--aes-bone-2":       "#161210",
            "--aes-bone-3":       "#1F1A14",
            "--aes-paper-rule":   "#3A3024",
            "--aes-oxide":        "#F1ECDD",
            "--aes-oxide-2":      "#D6CDB6",
            "--aes-slate":        "#9A8E76",
            "--aes-oxide-bg":     "#0E0B08",
            "--aes-oxide-bg-2":   "#161210",
            "--aes-bone-fg":      "#F1ECDD",
            "--aes-oxide-rule":   "#3A3024",
            "--aes-rust":         "#D8A23A",
            "--aes-rust-deep":    "#A37820",
            "--aes-rust-soft":    "rgba(216, 162, 58, 0.16)",
            "--aes-rust-fg":      "#0E0B08",
            "--aes-cobalt":       "#1A6E72",
            "--aes-cobalt-soft":  "rgba(26, 110, 114, 0.18)",
            "--aes-moss":         "#2F8A5A",
            "--aes-moss-soft":    "rgba(47, 138, 90, 0.18)",
            "--aes-amber":        "#E2B046",
            "--aes-amber-soft":   "rgba(226, 176, 70, 0.18)",
            "--aes-crimson":      "#A8323E",
            "--aes-crimson-soft": "rgba(168, 50, 62, 0.18)"
        }
    };

    /* Cascade Deco — CH-W5. Cascade layout + Art Deco skin at moderate
       ornament. Combines the deco-ivory palette with denser bleed strip
       so the cascade reads as elegant + content-forward. */
    const cascadeDeco = {
        id: "cascade-deco",
        name: "Cascade Deco",
        description: "Cascade layout + Art Deco skin. Moderate ornament, refined typography, content-first.",
        builtIn: true,
        skin: "art-deco",
        layoutMode: "cascade",
        ornament: "moderate",
        tokens: Object.assign({}, decoIvory.tokens, {
            "--aes-tile-bleed":                "6px",
            "--aes-tile-chrome-opacity-rest":  "0.45",
            "--aes-tile-chrome-opacity-hover": "1.0",
            "--aes-tile-min-col":              "300px"
        })
    };

    /* Cascade Quiet — CH-W5. Cascade layout + minimal chrome. Aggressively
       reduced bleed strip + low chrome opacity for users who want the
       data to dominate. Pairs well with tabular numerals. */
    const cascadeQuiet = {
        id: "cascade-quiet",
        name: "Cascade Quiet",
        description: "Cascade layout + minimal chrome. Bleed strip thin, chrome fades into the background.",
        builtIn: true,
        layoutMode: "cascade",
        numerals: {style: "tabular"},
        tokens: {
            "--aes-tile-bleed":                "2px",
            "--aes-tile-chrome-opacity-rest":  "0.35",
            "--aes-tile-chrome-opacity-hover": "1.0",
            "--aes-tile-min-col":              "260px"
        }
    };

    function listBuiltIn() {
        return [defaultPreset(), editorialBrutalism, oxideDark, decoIvory, decoNoir, cascadeDeco, cascadeQuiet];
    }

    function getById(id) {
        if (id === "default") return defaultPreset();
        if (id === "editorial-brutalism") return editorialBrutalism;
        if (id === "oxide-dark") return oxideDark;
        if (id === "deco-ivory") return decoIvory;
        if (id === "deco-noir") return decoNoir;
        if (id === "cascade-deco") return cascadeDeco;
        if (id === "cascade-quiet") return cascadeQuiet;
        return null;
    }

    window.AESPresets = {
        listBuiltIn,
        getById,
        DEFAULT_ID: "default"
    };
})();
