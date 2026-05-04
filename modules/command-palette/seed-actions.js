"use strict"

/**
 * Seed action commands.
 *
 * Surfaces (palette-dispatchable) the in-page actions that today live behind
 * panel buttons — open the Strategy modal/sibling strategy surfaces, open
 * the Audit Log, run a silent-auto tick, verify the pricing pipeline. Every
 * command's `available()`
 * predicate guards the exact global it dispatches against, so a page that
 * doesn't carry a particular surface won't list its commands.
 *
 * Reused entry points (each one verified to exist):
 *   window.AesStrategyPanel.open()                   — strategy/panel.js
 *   window.AesStrategyHubDesignerModal.open()        — strategy/hub-designer-modal.js
 *   window.AesStrategyLayeredPanel.open()            — strategy/layered/panel.js
 *   window.AesUnifiedSettings.open({moduleId:"strategy"})
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

    function _strategyHubDesigner() {
        const hd = window.AesStrategyHubDesignerModal
        return (hd && typeof hd.open === "function") ? hd : null
    }

    function _strategyLayeredPanel() {
        const lp = window.AesStrategyLayeredPanel
        return (lp && typeof lp.open === "function") ? lp : null
    }

    function _unifiedSettings() {
        const us = window.AesUnifiedSettings
        return (us && typeof us.open === "function") ? us : null
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

    function _hasVisibleSurface(selector) {
        const nodes = document.querySelectorAll(selector)
        for (const el of Array.prototype.slice.call(nodes)) {
            try {
                const rect = el.getBoundingClientRect()
                const style = getComputedStyle(el)
                if (rect.width > 0 && rect.height > 0
                        && style.display !== "none"
                        && style.visibility !== "hidden") return true
            } catch (_) { /* detached */ }
        }
        return false
    }

    function _activateHubTile(tileId) {
        if (!tileId) return
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("open-tile", {
                    tileId: tileId,
                    expand: true,
                    scrollIntoView: true,
                    source: "command-palette"
                })
                return
            }
        } catch (e) {
            console.warn("[AES palette] open-tile emit failed", tileId, e)
        }
        const shell = window.__aesCentralHub
        const tile = shell && shell.tilesById && typeof shell.tilesById.get === "function"
            ? shell.tilesById.get(tileId)
            : null
        if (tile && !tile.expanded && typeof tile.toggle === "function") {
            try { tile.toggle() } catch (_) {}
        }
    }

    async function _openStrategy(opts) {
        const sp = _strategyPanel()
        if (!sp) return
        try {
            const ret = sp.open(opts || {})
            if (ret && typeof ret.then === "function") {
                await ret
            }
        }
        catch (e) {
            console.warn("[AES palette] strategy open threw", e)
            throw e
        }
    }

    function _registerStrategySection(id, label, hint, keywords, opts) {
        reg.register({
            id: id,
            scope: "any",
            label: label,
            hint: hint,
            keywords: keywords,
            available: () => !!_strategyPanel(),
            run: () => _openStrategy(opts)
        })
    }

    function _allDecisionFilter() {
        return {
            domain: "all",
            search: "",
            applicableOnly: false,
            advisoryOnly: false,
            selectedOnly: false
        }
    }

    reg.register({
        id: "open.strategy",
        scope: "any",
        label: "Open Strategy Panel",
        hint: "Decision engine — proposals, weights, journal",
        keywords: ["strategy", "decisions", "plan", "weights", "engine", "journal"],
        available: () => !!_strategyPanel(),
        run: () => _openStrategy({section: "overview", filter: _allDecisionFilter()})
    })

    _registerStrategySection(
        "open.strategy.settings",
        "Open Strategy Settings",
        "Tier, objective, domain gates, and auto-seed",
        ["strategy", "settings", "tier", "goal", "objective", "gates"],
        {section: "settings", filter: _allDecisionFilter()}
    )
    _registerStrategySection(
        "open.strategy.decisions",
        "Open Strategy Decisions",
        "Review and filter proposed schedule, service, price, crew, and alliance actions",
        ["strategy", "decisions", "apply", "review", "proposal"],
        {section: "decisions", filter: _allDecisionFilter()}
    )
    _registerStrategySection(
        "open.strategy.pricing",
        "Open Strategy Pricing Decisions",
        "Jump to price moves inside the strategy decision list",
        ["strategy", "pricing", "price", "fares", "revenue"],
        {section: "decisions", domain: "price"}
    )
    _registerStrategySection(
        "open.strategy.service",
        "Open Strategy Service Decisions",
        "Jump to service-profile strategy moves",
        ["strategy", "service", "ors", "profile"],
        {section: "decisions", domain: "service"}
    )
    _registerStrategySection(
        "open.strategy.schedules",
        "Open Strategy Schedules",
        "Jump to per-aircraft schedule placements",
        ["strategy", "schedule", "aircraft", "fleet", "placements"],
        {section: "aircraft", filter: _allDecisionFilter()}
    )
    _registerStrategySection(
        "open.strategy.learning",
        "Open Strategy Learning",
        "Closed-loop outcomes, weights, and learn-cycle controls",
        ["strategy", "learning", "weights", "outcomes", "learn"],
        {section: "learning", filter: _allDecisionFilter()}
    )
    _registerStrategySection(
        "open.strategy.journal",
        "Open Strategy Journal",
        "Strategy apply journal and decision history",
        ["strategy", "journal", "history", "reason", "audit", "log"],
        {section: "journal", filter: _allDecisionFilter()}
    )

    reg.register({
        id: "open.settings.strategy",
        scope: "any",
        label: "Open Unified Strategy Settings",
        hint: "Global AES settings page for the strategy module",
        keywords: ["strategy", "settings", "unified", "modules"],
        available: () => !!_unifiedSettings(),
        run: () => {
            const us = _unifiedSettings()
            if (!us) return
            try { us.open({tab: "modules", moduleId: "strategy"}) }
            catch (e) { console.warn("[AES palette] unified strategy settings open threw", e) }
        }
    })

    reg.register({
        id: "open.strategy.hubDesigner",
        scope: "any",
        label: "Open Hub Network Designer",
        hint: "Strategy hub open/close candidates",
        keywords: ["strategy", "hub", "designer", "network", "open", "close"],
        available: () => !!_strategyHubDesigner(),
        run: async () => {
            const hd = _strategyHubDesigner()
            if (!hd) return
            try {
                const ret = hd.open()
                if (ret && typeof ret.then === "function") await ret
            }
            catch (e) {
                console.warn("[AES palette] hub designer open threw", e)
                throw e
            }
            setTimeout(() => {
                if (!_hasVisibleSurface(".aes-hub-designer-modal, .aes-hub-designer-dialog, [data-aes-strategy-surface='hub-designer']")) {
                    _activateHubTile("strategy-hub-designer")
                }
            }, 180)
        }
    })

    reg.register({
        id: "open.strategy.portfolio",
        scope: "any",
        label: "Open Strategy Portfolio",
        hint: "Multi-world capital and fleet allocation",
        keywords: ["strategy", "portfolio", "multi-world", "allocation", "capital", "fleet"],
        available: () => !!(window.__aesCentralHub && window.__aesCentralHub.tilesById
            && window.__aesCentralHub.tilesById.has("strategy-portfolio")),
        run: () => _activateHubTile("strategy-portfolio")
    })

    reg.register({
        id: "open.strategy.slotTrading",
        scope: "any",
        label: "Open Strategy Slot Trading",
        hint: "Airport slot opportunities and slot-bid decisions",
        keywords: ["strategy", "slot", "slots", "slotBid", "trading", "airport", "bid"],
        available: () => !!_strategyPanel(),
        run: async () => {
            _activateHubTile("strategy-slot-trading")
            await _openStrategy({section: "decisions", domain: "slotBid", skipSeed: true})
        }
    })

    reg.register({
        id: "open.strategy.layered",
        scope: "any",
        label: "Open Layered Strategy Overrides",
        hint: "Family, account, division, fleet, and route overrides",
        keywords: ["strategy", "layered", "overrides", "family", "division", "fleet", "route"],
        available: () => !!_strategyLayeredPanel(),
        run: async () => {
            const lp = _strategyLayeredPanel()
            if (!lp) return
            try {
                const ret = lp.open({scope: "family"})
                if (ret && typeof ret.then === "function") await ret
            }
            catch (e) {
                console.warn("[AES palette] layered strategy open threw", e)
                throw e
            }
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
