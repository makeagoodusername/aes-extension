"use strict"

/**
 * Track 6 slice 6d — locked-leg confirmation modal.
 *
 * Surfaces the locked-leg conflict before an Apply-batch fires, so the user
 * doesn't get silent skips. The previous Track 7 7e behaviour was to filter
 * locked legs out of the apply payload + log a console warning; the user
 * had no in-page signal that N of their proposed legs would not be applied.
 *
 * Two distinct conflict sources, both surfaced in one modal:
 *   1. PROPOSED legs carrying `modifiers.locked === true` — the diff
 *      engine carries a lock forward when the proposed leg originated
 *      from a current leg AS marks immutable. apply-batch will silently
 *      skip these unless the user explicitly chooses Override.
 *   2. CURRENT legs in `schedule-diff.compare(...).locked[]` — current
 *      legs the new schedule would normally delete (because nothing
 *      proposed matched them) but which AS owns. They'll stay in place
 *      regardless; this is informational so the user can decide whether
 *      to coexist or bail.
 *
 * Three choices:
 *   - "continue"  — proceed with apply (locked legs skipped / current
 *                    locked legs left in place). Default.
 *   - "override"  — try to clear the locked legs first via the delete-
 *                    batch pipeline (Track 6 6c), then proceed. Risky:
 *                    AS may refuse to delete its own locked legs, in
 *                    which case the delete-batch surfaces per-leg errors
 *                    in the audit log + caller continues with the apply.
 *   - "cancel"    — bail completely; no apply, no delete.
 *
 * Pure renderer. No chrome.storage reads, no chrome.runtime sends — the
 * caller owns the choice flow. This module just paints the modal and
 * resolves the Promise.
 *
 * Public API (window.AesAfpLockedConfirmModal):
 *   .open(opts) → Promise<{choice: 'continue' | 'override' | 'cancel'}>
 *
 * opts shape:
 *   {
 *     proposedLockedLegs: [],   // legs in apply payload with modifiers.locked
 *     currentLockedStays: [],   // optional: result.locked from schedule-diff
 *     aircraftId:         "",   // for header display
 *     hub:                "",   // for header display
 *     allowOverride:      bool  // default true; pass false to hide Override
 *   }
 *
 * Esc / overlay-click → resolves with {choice: 'cancel'}.
 */
;(function () {
    if (window.AesAfpLockedConfirmModal) return

    let _modalEl = null
    let _onKey   = null
    let _resolve = null

    function _close(choice) {
        if (_onKey) {
            try { document.removeEventListener("keydown", _onKey) } catch (_) { /* noop */ }
            _onKey = null
        }
        if (_modalEl && _modalEl.parentNode) {
            try { _modalEl.parentNode.removeChild(_modalEl) } catch (_) { /* noop */ }
        }
        _modalEl = null
        const r = _resolve
        _resolve = null
        if (r) r({choice: choice || "cancel"})
    }

    function _mkLegRow(leg, kindGlyph) {
        const tr = document.createElement("tr")
        const cells = [
            kindGlyph,
            leg && leg.flightId != null ? String(leg.flightId) : "—",
            (leg && leg.origin || "?") + "→" + (leg && leg.destination || "?"),
            (leg && leg.depTimeLocal) || "—",
            (leg && leg.waveLabel) || (leg && leg.direction) || "",
            (leg && leg.aircraftType) || ""
        ]
        for (const text of cells) {
            const td = document.createElement("td")
            td.textContent = text
            td.style.cssText = "padding:3px 6px;border-bottom:1px solid #1f2937;"
                + "color:#cbd5e1;font-size:11px;font-family:monospace;"
            tr.appendChild(td)
        }
        return tr
    }

    /**
     * Open the modal. Returns a Promise that resolves once the user picks
     * a choice (or dismisses via Esc / overlay click → cancel).
     *
     * Idempotent against double-open: if a modal is already up, the new
     * call resolves immediately with `{choice: 'cancel'}` — the caller
     * should never end up racing themselves.
     */
    function open(opts) {
        if (_modalEl) return Promise.resolve({choice: "cancel"})
        const o = opts || {}
        const proposed = Array.isArray(o.proposedLockedLegs) ? o.proposedLockedLegs : []
        const currentStays = Array.isArray(o.currentLockedStays) ? o.currentLockedStays : []
        const allowOverride = o.allowOverride !== false   // default true
        const aircraftId = o.aircraftId || ""
        const hub = o.hub || ""
        const totalLocked = proposed.length + currentStays.length
        if (totalLocked === 0) return Promise.resolve({choice: "continue"})

        return new Promise((resolve) => {
            _resolve = resolve

            // Overlay
            const overlay = document.createElement("div")
            overlay.setAttribute("data-aes-locked-confirm", "1")
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);"
                + "z-index:10010;display:flex;align-items:center;justify-content:center;"
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) _close("cancel")
            })

            // Modal
            const modal = document.createElement("div")
            modal.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #374151;"
                + "border-radius:6px;min-width:560px;max-width:80vw;max-height:80vh;"
                + "display:flex;flex-direction:column;font:12px/1.4 sans-serif;"
                + "box-shadow:0 10px 40px rgba(0,0,0,0.5);"

            // Header
            const head = document.createElement("div")
            head.style.cssText = "padding:10px 14px;border-bottom:1px solid #1f2937;"
                + "background:#111827;display:flex;align-items:center;gap:10px;"
            const title = document.createElement("strong")
            title.textContent = "Locked legs in apply request"
            title.style.cssText = "color:#fbbf24;font-size:13px;flex:1 1 auto;"
            const subtitle = document.createElement("span")
            subtitle.style.cssText = "color:#9ca3af;font-size:10px;font-family:monospace;"
            subtitle.textContent = (aircraftId ? "aircraft " + aircraftId + (hub ? " · " : "") : "")
                + (hub || "")
            head.appendChild(title)
            head.appendChild(subtitle)
            modal.appendChild(head)

            // Body
            const body = document.createElement("div")
            body.style.cssText = "padding:10px 14px;overflow-y:auto;flex:1 1 auto;"

            const intro = document.createElement("p")
            intro.style.cssText = "margin:0 0 8px 0;color:#cbd5e1;font-size:12px;line-height:1.5;"
            const parts = []
            if (proposed.length) {
                parts.push(proposed.length + " proposed leg" + (proposed.length === 1 ? "" : "s")
                    + " in your batch carry an AS-managed lock — they will be silently skipped.")
            }
            if (currentStays.length) {
                parts.push(currentStays.length + " current leg" + (currentStays.length === 1 ? "" : "s")
                    + " on this aircraft are locked and would normally be deleted by your new schedule"
                    + " — they'll stay in place.")
            }
            intro.textContent = parts.join(" ")
            body.appendChild(intro)

            // Combined table
            const table = document.createElement("table")
            table.style.cssText = "width:100%;border-collapse:collapse;margin-top:6px;"
            const thead = document.createElement("thead")
            const trh = document.createElement("tr")
            for (const lbl of ["", "FlightId", "Route", "Time", "Wave/Dir", "Aircraft"]) {
                const th = document.createElement("th")
                th.textContent = lbl
                th.style.cssText = "padding:3px 6px;border-bottom:1px solid #374151;"
                    + "color:#9ca3af;font-size:10px;font-weight:600;text-align:left;"
                    + "font-family:monospace;text-transform:uppercase;letter-spacing:0.5px;"
                trh.appendChild(th)
            }
            thead.appendChild(trh)
            table.appendChild(thead)
            const tbody = document.createElement("tbody")
            for (const l of proposed)     tbody.appendChild(_mkLegRow(l, "✈ skip"))
            for (const l of currentStays) tbody.appendChild(_mkLegRow(l, "🔒 stay"))
            table.appendChild(tbody)
            body.appendChild(table)

            modal.appendChild(body)

            // Footer
            const footer = document.createElement("div")
            footer.style.cssText = "padding:10px 14px;border-top:1px solid #1f2937;"
                + "background:#111827;display:flex;gap:8px;align-items:center;"

            const hint = document.createElement("span")
            hint.style.cssText = "color:#6b7280;font-size:10px;flex:1 1 auto;font-style:italic;"
            hint.textContent = "Esc / click outside = cancel"
            footer.appendChild(hint)

            const btnCancel = document.createElement("button")
            btnCancel.type = "button"
            btnCancel.textContent = "Cancel"
            btnCancel.style.cssText = "background:transparent;color:#cbd5e1;"
                + "border:1px solid #374151;border-radius:3px;padding:5px 12px;"
                + "font-size:11px;cursor:pointer;"
            btnCancel.addEventListener("click", () => _close("cancel"))
            footer.appendChild(btnCancel)

            if (allowOverride) {
                const btnOverride = document.createElement("button")
                btnOverride.type = "button"
                btnOverride.textContent = "Override (try delete + apply)"
                btnOverride.title = "Attempt to delete the locked legs first via the delete-batch"
                    + " pipeline, then run the apply. AS may refuse — failures will surface"
                    + " in the audit log and the apply still proceeds."
                btnOverride.style.cssText = "background:transparent;color:#f87171;"
                    + "border:1px solid #b91c1c;border-radius:3px;padding:5px 12px;"
                    + "font-size:11px;cursor:pointer;"
                btnOverride.addEventListener("click", () => _close("override"))
                footer.appendChild(btnOverride)
            }

            const btnContinue = document.createElement("button")
            btnContinue.type = "button"
            btnContinue.textContent = proposed.length
                ? "Continue (skip locked)"
                : "Continue"
            btnContinue.style.cssText = "background:#1d4ed8;color:#eff6ff;"
                + "border:1px solid #1e40af;border-radius:3px;padding:5px 14px;"
                + "font-size:11px;font-weight:600;cursor:pointer;"
            btnContinue.addEventListener("click", () => _close("continue"))
            footer.appendChild(btnContinue)

            modal.appendChild(footer)
            overlay.appendChild(modal)
            document.body.appendChild(overlay)
            _modalEl = overlay

            // Esc support — same convention as preview-panel + wave-applier modals.
            _onKey = (e) => {
                if (e.key === "Escape") _close("cancel")
            }
            document.addEventListener("keydown", _onKey)

            // Default focus on Continue (the safest path).
            try { btnContinue.focus() } catch (_) { /* noop */ }
        })
    }

    /**
     * Detect locked legs in an apply payload + an optional schedule-diff
     * result. Convenience for callers — returns null when no surface needed.
     *
     * Usage:
     *   const lock = AesAfpLockedConfirmModal.detect({legs, diffResult})
     *   if (lock) {
     *       const {choice} = await AesAfpLockedConfirmModal.open({...lock, aircraftId, hub})
     *       if (choice === "cancel") return
     *       if (choice === "override") await runDeleteBatch(lock.currentLockedStays)
     *       // continue with apply
     *   }
     */
    function detect(opts) {
        const o = opts || {}
        const legs = Array.isArray(o.legs) ? o.legs : []
        const proposedLockedLegs = legs.filter(l => l && l.modifiers && l.modifiers.locked === true)
        const currentLockedStays = (o.diffResult && Array.isArray(o.diffResult.locked))
            ? o.diffResult.locked
            : []
        if (!proposedLockedLegs.length && !currentLockedStays.length) return null
        return {proposedLockedLegs, currentLockedStays}
    }

    window.AesAfpLockedConfirmModal = {
        open:   open,
        detect: detect
    }

    // ── ?aes-debug smoke tests (project convention — no test runner) ──
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof window.AesAfpLockedConfirmModal.open   === "function",
                "[AES auto-6d smoke] open() exposed")
            console.assert(typeof window.AesAfpLockedConfirmModal.detect === "function",
                "[AES auto-6d smoke] detect() exposed")
            // Empty input → no surface needed.
            console.assert(window.AesAfpLockedConfirmModal.detect({legs: []}) === null,
                "[AES auto-6d smoke] detect returns null on empty input")
            // open() with zero locked → resolves continue immediately.
            window.AesAfpLockedConfirmModal.open({proposedLockedLegs: [], currentLockedStays: []})
                .then(r => console.assert(r.choice === "continue",
                    "[AES auto-6d smoke] zero-locked open() → continue"))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
