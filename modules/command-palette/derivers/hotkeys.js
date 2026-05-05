"use strict";

/**
 * Command palette hotkey auto-deriver.
 *
 * Reads AESShortcutRegistry.resolved() and contributes one legend
 * section per known shortcut to the palette legend index. The "?"
 * subcommand in legend.js renders these grouped by section.
 *
 * Inert on pages that don't load shortcut-registry (most non-AES
 * surfaces) — the registration is a single best-effort call at load.
 */
(function () {
    if (typeof window === "undefined") return;
    if (!window.AESCommandPalette || typeof window.AESCommandPalette.registerLegend !== "function") return;
    if (!window.AESShortcutRegistry) return;

    const palette = window.AESCommandPalette;
    const shortcutReg = window.AESShortcutRegistry;

    let resolved = [];
    try {
        const r = shortcutReg.resolved();
        if (Array.isArray(r)) resolved = r;
    } catch (_) {
        return;
    }
    if (!resolved.length) return;

    /* Group resolved shortcuts by their `group` field if present, else
       by the action id's leading dot-separated namespace ("nav.foo"
       → group "nav"). */
    const groups = new Map();
    for (const sc of resolved) {
        if (!sc || !sc.id) continue;
        const groupId = sc.group || (sc.id.indexOf(".") > 0 ? sc.id.split(".")[0] : "general");
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push({
            keys: String(sc.keys || sc.chord || ""),
            desc: String(sc.label || sc.description || sc.id)
        });
    }

    for (const [groupId, entries] of groups) {
        const filtered = entries.filter(function (e) { return e.keys && e.desc; });
        if (!filtered.length) continue;
        palette.registerLegend({
            sectionId: "shortcut:" + groupId,
            entries: filtered
        });
    }
})();
