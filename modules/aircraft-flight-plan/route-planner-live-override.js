"use strict"

/**
 * Permanent-live shim for the legacy AFP route-planner panel.
 *
 * The upstream panel file is root-owned in this checkout, so this module
 * mounts after it and removes the obsolete dry-run CTA without changing
 * the original route-planner recommendation/schedule code.
 */
;(function () {
    if (typeof window === "undefined") return
    const api = window.AesAfpRoutePlannerPanel
    if (!api || api.__aesLiveOverride) return
    api.__aesLiveOverride = true

    function _scrubDryRunButtons(root) {
        const base = root && root.querySelectorAll ? root : document
        const buttons = base.querySelectorAll ? base.querySelectorAll("button") : []
        for (const btn of buttons) {
            if (String(btn.textContent || "").trim().toLowerCase() === "dry-run") {
                btn.remove()
            }
        }
    }

    function _liveInstance(inst) {
        if (inst && typeof inst.apply === "function") {
            const original = inst.apply
            inst.apply = function () { return original.call(inst, false) }
        }
        return inst
    }

    if (typeof api.mount === "function") {
        const originalMount = api.mount
        api.mount = function (host, opts) {
            const inst = _liveInstance(originalMount.call(this, host, opts))
            try { _scrubDryRunButtons(host || document) } catch (_) {}
            return inst
        }
    }

    if (typeof api.open === "function") {
        const originalOpen = api.open
        api.open = function () {
            const inst = _liveInstance(originalOpen.apply(this, arguments))
            setTimeout(() => { try { _scrubDryRunButtons(document) } catch (_) {} }, 0)
            setTimeout(() => { try { _scrubDryRunButtons(document) } catch (_) {} }, 100)
            return inst
        }
    }
})()
