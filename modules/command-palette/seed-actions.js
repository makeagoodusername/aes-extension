"use strict"

/**
 * Seed action commands.
 *
 * Surfaces (palette-dispatchable) the in-page actions that today live behind
 * panel buttons — open the Strategy modal, open the Audit Log, run a silent-
 * auto tick, verify the pricing pipeline. Every command's `available()`
 * predicate guards the exact global it dispatches against, so a page that
 * doesn't carry a particular surface won't list its commands.
 *
 * Reused entry points (each one verified to exist):
 *   window.AesStrategyPanel.open()                   — strategy/panel.js:2050
 *   window.RouteAssistantPanel._currentInstance      — route-assistant/panel.js:4635
 *     ._openAuditLogModal()                          — :12006
 *     ._silentAutoTickNow()                          — :13661 (manual tick handler)
 *     ._runVerifyPipelineCta()                       — :13822
 *   window.RouteAssistantToast.{info,success,warn,error}(msg)  — toast feedback
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AESCommandRegistry) return
    if (window.__aesCommandPaletteSeedActionsInstalled) return
    window.__aesCommandPaletteSeedActionsInstalled = true

    const reg = window.AESCommandRegistry

    function _strategyPanel() {
        const sp = window.AesStrategyPanel
        return (sp && typeof sp.open === "function") ? sp : null
    }

    function _raPanelInstance() {
        const cls = window.RouteAssistantPanel
        return (cls && cls._currentInstance) || null
    }

    function _toast() {
        return (typeof window.RouteAssistantToast !== "undefined") ? window.RouteAssistantToast : null
    }

    function _notify(kind, msg) {
        const t = _toast()
        if (!t || typeof t[kind] !== "function") return
        try { t[kind](msg) } catch (_) { /* toast is best-effort */ }
    }

    reg.register({
        id: "open.strategy",
        scope: "any",
        label: "Open Strategy",
        hint: "Decision engine — proposals, weights, journal",
        keywords: ["strategy", "decisions", "plan", "weights", "engine", "journal"],
        available: () => !!_strategyPanel(),
        run: () => {
            const sp = _strategyPanel()
            if (!sp) return
            try { sp.open() }
            catch (e) { console.warn("[AES palette] strategy open threw", e) }
        }
    })

    reg.register({
        id: "open.auditLog",
        scope: "scheduling",
        label: "Open Auto-pricing Audit Log",
        hint: "Every apply (manual / bulk / silent-auto) with rationale + Undo",
        keywords: ["audit", "log", "applies", "history", "pricing", "undo"],
        available: () => {
            const inst = _raPanelInstance()
            return !!(inst && typeof inst._openAuditLogModal === "function")
        },
        run: () => {
            const inst = _raPanelInstance()
            if (!inst || typeof inst._openAuditLogModal !== "function") return
            try { inst._openAuditLogModal() }
            catch (e) { console.warn("[AES palette] auditLog open threw", e) }
        }
    })

    reg.register({
        id: "action.silentAutoTick",
        scope: "scheduling",
        label: "Run silent-auto tick now",
        hint: "Force one cycle of the auto-pricing loop (respects current gates)",
        keywords: ["silent-auto", "tick", "auto-pricing", "run", "force", "now"],
        available: () => {
            const inst = _raPanelInstance()
            return !!(inst && typeof inst._silentAutoTickNow === "function")
        },
        run: async () => {
            const inst = _raPanelInstance()
            if (!inst || typeof inst._silentAutoTickNow !== "function") return
            _notify("info", "Silent-auto: running a tick…")
            try {
                await inst._silentAutoTickNow()
            } catch (e) {
                console.warn("[AES palette] silentAutoTickNow threw", e)
                _notify("error", "Silent-auto tick failed — see console")
            }
        }
    })

    reg.register({
        id: "action.verifyPricing",
        scope: "scheduling",
        label: "Verify pricing pipeline",
        hint: "Forced dry-run — exercises every layer except the POST",
        keywords: ["verify", "pricing", "pipeline", "dry-run", "diagnose", "test"],
        available: () => {
            const inst = _raPanelInstance()
            return !!(inst && typeof inst._runVerifyPipelineCta === "function")
        },
        run: async () => {
            const inst = _raPanelInstance()
            if (!inst || typeof inst._runVerifyPipelineCta !== "function") return
            try {
                await inst._runVerifyPipelineCta()
            } catch (e) {
                console.warn("[AES palette] verify pipeline threw", e)
                _notify("error", "Verify pipeline failed — see console")
            }
        }
    })

    reg.register({
        id: "open.commandPalette.help",
        scope: "any",
        label: "Command palette: about",
        hint: "What this is, how to add commands",
        keywords: ["palette", "help", "about", "command"],
        run: () => {
            const t = _toast()
            const msg = "Cmd-K opens the command palette. Modules add commands via "
                + "AESCommandRegistry.register({id, label, run}). See "
                + "modules/command-palette/seed-actions.js for examples."
            if (t && typeof t.info === "function") t.info(msg, {duration: 7000})
            else console.info("[AES palette]", msg)
        }
    })
})()
