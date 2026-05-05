"use strict"

/**
 * Seed navigation commands.
 *
 * Always-available commands that route the user to a top-level AS surface
 * (dashboard, scheduling, fleets, settings) or open an in-page AES surface
 * (Customization Studio, Shortcuts help). Mirrors the keys-style entries
 * from `AESShortcutRegistry.DEFAULTS` so the palette and the chord
 * navigator stay in sync — if a slice adds a new top-level destination,
 * register it in both places.
 *
 * `available: () => true` for every command in this seed: navigation never
 * conditionally disappears.
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AESCommandRegistry) return
    if (window.__aesCommandPaletteSeedNavInstalled) return
    window.__aesCommandPaletteSeedNavInstalled = true

    const reg = window.AESCommandRegistry

    const HUB_RE = /\/app\/com\/scheduling\/([^/?#]+)/

    function currentHub() {
        const m = location.pathname.match(HUB_RE)
        return m ? m[1] : null
    }

    function nav(path) {
        if (!path) return
        location.assign(path)
    }

    reg.register({
        id: "nav.dashboard",
        scope: "any",
        label: "Go to Dashboard",
        hint: "Central Hub — tiles, briefing, alerts",
        keywords: ["dashboard", "central", "hub", "home"],
        run: () => nav("/app/enterprise/dashboard")
    })

    reg.register({
        id: "nav.scheduling",
        scope: "any",
        label: "Go to Scheduling (current hub)",
        hint: "Route Assistant panel + scheduling controls",
        keywords: ["scheduling", "routes", "ra", "route assistant"],
        available: () => !!currentHub() || !!_lastKnownHub(),
        run: () => {
            const hub = currentHub() || _lastKnownHub()
            if (hub) nav("/app/com/scheduling/" + hub)
        }
    })

    reg.register({
        id: "nav.fleets",
        scope: "any",
        label: "Go to Fleets",
        hint: "Fleet Hub — aircraft, schedules, routines",
        keywords: ["fleets", "fleet hub", "aircraft", "tails"],
        run: () => nav("/app/fleets")
    })

    reg.register({
        id: "nav.accounting",
        scope: "any",
        label: "Go to Accounting",
        hint: "Finance — accounting, P&L, sister rollup",
        keywords: ["accounting", "finance", "money", "pnl", "p&l"],
        run: () => nav("/app/finance/accounting")
    })

    reg.register({
        id: "nav.settings",
        scope: "any",
        label: "Go to Enterprise Settings",
        hint: "AS-side enterprise config",
        keywords: ["settings", "config", "enterprise"],
        run: () => nav("/app/enterprise/settings")
    })

    reg.register({
        id: "nav.studio",
        scope: "any",
        label: "Open Customization Studio",
        hint: "Theme, color, typography, keybindings",
        keywords: ["customization", "studio", "theme", "colors", "keybindings", "settings"],
        available: () => typeof window.AESCustomizationHost !== "undefined"
            && typeof window.AESCustomizationHost.toggle === "function",
        run: () => {
            try { window.AESCustomizationHost.toggle() }
            catch (e) { console.warn("[AES palette] studio toggle threw", e) }
        }
    })

    reg.register({
        id: "nav.shortcuts",
        scope: "any",
        label: "Show Keyboard Shortcuts",
        hint: "Cheat sheet for every chord binding",
        keywords: ["shortcuts", "keys", "help", "?", "cheatsheet"],
        available: () => typeof window.AESSiteSkin !== "undefined"
            && typeof window.AESSiteSkin.showShortcuts === "function",
        run: () => {
            try { window.AESSiteSkin.showShortcuts() }
            catch (e) { console.warn("[AES palette] showShortcuts threw", e) }
        }
    })

    /* Last-known hub fallback so "Go to Scheduling" works from pages that
       don't carry a hub in the URL (dashboard, fleets, AFP). Reads the
       most-recent scheduling page the user visited; populated by host.js
       on every palette open. */
    function _lastKnownHub() {
        try {
            const v = localStorage.getItem("aesCommandPalette:lastHub")
            return (typeof v === "string" && v) ? v : null
        } catch (_) { return null }
    }
})()
