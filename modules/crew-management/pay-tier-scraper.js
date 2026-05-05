"use strict"

/**
 * AES — staffOverview salary-form context harvester (Slice 8).
 *
 * The staffOverview page renders one form per role with hidden Wicket
 * fields, an `action=salary` selector, and per-row `id` + `amount` inputs
 * for the salary slider. The applier needs the actionUrl + every hidden
 * input verbatim to round-trip a POST. Two entry points cover both call
 * sites:
 *
 *   captureFormContext(root=document)
 *     Live-DOM walker. Used by the content-staff-overview script after a
 *     successful scrape so the strategy panel + tile can show "form ready"
 *     and the applier can avoid an extra GET when freshness allows.
 *
 *   parseHtml(html)
 *     Static helper for the applier's own GET → parse → POST cycle. The
 *     applier never depends on the cached blob — it always re-parses its
 *     own response so an expired Wicket page-id is detected fresh.
 *
 * Output shape (both entry points):
 *   {
 *     actionUrl:  "/action/enterprise/staffOverview?...wicket-id...",
 *     hidden:     {[name]: value, ...},
 *     submit:     {name, value} | null,
 *     perRow:     {[positionId]: {amountInputName, currentAmount, idValue}},
 *     capturedAt: epoch-ms
 *   }
 *
 * Returns null when the salary form is absent (page format changed,
 * not on staffOverview, or page is in an error state).
 */
class CrewMgmtPayTierScraper {
    static STORAGE_LATEST_KEY = "crewMgmt:staffOverview:latest"
    static FORM_ACTION_RE      = /\/action\/enterprise\/staffOverview/i

    /** Walk the live DOM. Used by the content script. */
    static captureFormContext(root) {
        const r = root || (typeof document !== "undefined" ? document : null)
        if (!r) return null
        const html = r.documentElement
        if (html && html.dataset && html.dataset.aesPage !== "staff") return null
        return CrewMgmtPayTierScraper._parseRoot(r)
    }

    /** Parse a fetched HTML response. Used by the applier. */
    static parseHtml(html) {
        if (!html) return null
        try {
            const doc = new DOMParser().parseFromString(html, "text/html")
            return CrewMgmtPayTierScraper._parseRoot(doc)
        } catch (_) {
            return null
        }
    }

    static _parseRoot(root) {
        const form = CrewMgmtPayTierScraper._findForm(root)
        if (!form) return null

        const actionUrl = form.getAttribute("action") || ""
        if (!actionUrl) return null

        const hidden = {}
        for (const inp of form.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) hidden[name] = inp.getAttribute("value") || ""
        }

        let submit = null
        const submitEl = form.querySelector(
            "button[type='submit'][name], input[type='submit'][name], button[name][type=submit], button[name]:not([type='button'])"
        )
        if (submitEl) {
            submit = {
                name:  submitEl.getAttribute("name"),
                value: submitEl.getAttribute("value") || "1"
            }
        }

        const perRow = {}
        // Each role row holds <input name='id' value='positionId'> and
        // <input name='amount' value='salaryAS$'>. The form action handler
        // is selected by a sibling <input name='action' value='salary'>.
        // We index per row so the applier can assemble a body without
        // re-walking the DOM.
        for (const idInput of form.querySelectorAll("input[name='id']")) {
            const positionId = (idInput.value || "").trim()
            if (!positionId) continue
            // Same containing td as the amount field.
            const td = idInput.closest("td") || idInput.parentElement
            const amountInput = td && td.querySelector("input[name='amount']")
            if (!amountInput) continue
            perRow[positionId] = {
                amountInputName: amountInput.getAttribute("name") || "amount",
                idValue:         positionId,
                currentAmount:   CrewMgmtPayTierScraper._int(amountInput.value)
            }
        }

        return {
            actionUrl,
            hidden,
            submit,
            perRow,
            capturedAt: Date.now()
        }
    }

    static _findForm(root) {
        // Prefer the form that contains <input name='action' value='salary'>.
        const salaryInput = root.querySelector(
            "form[action*='/action/enterprise/staffOverview'] input[name='action'][value='salary']"
        )
        if (salaryInput) {
            const form = salaryInput.closest("form")
            if (form) return form
        }
        // Fallback: first staffOverview form on the page.
        for (const f of root.querySelectorAll("form")) {
            const action = f.getAttribute("action") || ""
            if (CrewMgmtPayTierScraper.FORM_ACTION_RE.test(action)) return f
        }
        return null
    }

    static _int(value) {
        if (value == null) return null
        const text = String(value)
        if (typeof AES !== "undefined" && typeof AES.cleanInteger === "function") {
            const n = AES.cleanInteger(text)
            return Number.isFinite(n) ? n : null
        }
        const cleaned = text.replace(/[^\d-]/g, "")
        const n = parseInt(cleaned, 10)
        return Number.isFinite(n) ? n : null
    }
}

if (typeof window !== "undefined") {
    window.CrewMgmtPayTierScraper = CrewMgmtPayTierScraper
}
