/**
 * Shared generic table-extractor for the four accounting sister pages —
 * `/app/finance/leasing`, `/app/finance/capital`, `/app/finance/assets`, and
 * `/action/enterprise/schedule` (cash flow).
 *
 * Until captures of each page document the precise structure, we ship a
 * verbatim extractor: every table on the active tab pane is captured row by
 * row with its headers, label cell, and numeric cells parsed via
 * `AES.cleanInteger`. This preserves all data losslessly so later slices can
 * sharpen the parser without re-scraping. Specialised parsers can replace
 * this generic extractor per page when the structure is documented.
 */
class AccountingSisterScraper {
    /**
     * @param {string} type - "leasing" | "capital" | "assets" | "cashflow"
     * @param {Document|HTMLElement} root - defaults to document
     * @returns {object|null} {type, tables: [{caption, headers, rows}], scrapedAt}
     */
    static scrape(type, root = document) {
        const pane = AccountingSisterScraper._activePane(root)
        if (!pane) return null

        const tables = []
        for (const table of pane.querySelectorAll("table.table, table")) {
            const captured = AccountingSisterScraper._captureTable(table)
            if (captured && (captured.rows.length || captured.headers.length)) {
                tables.push(captured)
            }
        }

        if (!tables.length) {
            // Pages like /app/finance/assets render an empty-state message
            // instead of an empty table when the user has nothing to show
            // (e.g. all aircraft leased → no owned assets). Treat that as a
            // valid scrape so the orchestrator records the visit and the job
            // doesn't time out.
            const empty = AccountingSisterScraper._emptyStateRecord(pane, type)
            if (empty) return empty
            return null
        }

        return {type, tables, scrapedAt: Date.now()}
    }

    static _emptyStateRecord(pane, type) {
        const explicit = pane.querySelector(
            ".assets-none, .leasing-none, .capital-none, .cashflow-none, .empty-state"
        )
        if (explicit) {
            return {
                type,
                tables: [],
                empty: true,
                emptyMessage: (explicit.textContent || "").trim(),
                scrapedAt: Date.now()
            }
        }
        // Generic fallback: a short paragraph or div whose visible text
        // signals nothing-to-show. Conservative — only matches obvious
        // phrasings to avoid false positives on transitional loaders.
        const candidates = pane.querySelectorAll("p, div")
        for (const el of candidates) {
            if (el.querySelector("table")) continue
            const t = (el.textContent || "").trim().toLowerCase()
            if (!t || t.length > 200) continue
            if (/does not possess|no entries|no records|nothing to show/.test(t)) {
                return {
                    type,
                    tables: [],
                    empty: true,
                    emptyMessage: t,
                    scrapedAt: Date.now()
                }
            }
        }
        return null
    }

    static _activePane(root) {
        return root.querySelector(".tab-pane.active")
            || root.querySelector(".tab-content")
            || root.querySelector("main")
            || root.querySelector("body")
    }

    static _captureTable(table) {
        const caption = AccountingSisterScraper._readCaption(table)
        const headers = Array.from(table.querySelectorAll("thead th"))
            .map(th => (th.textContent || "").trim())
        const rows = []

        for (const tbody of table.querySelectorAll("tbody")) {
            for (const tr of tbody.children) {
                if (tr.classList.contains("figure-margin")) continue
                const parsed = AccountingSisterScraper._parseRow(tr, headers)
                if (parsed) rows.push(parsed)
            }
        }

        return {caption, headers, rows}
    }

    static _readCaption(table) {
        const cap = table.querySelector("caption")
        if (cap?.textContent) return cap.textContent.trim()
        const prev = table.previousElementSibling
        if (prev?.tagName === "H3" || prev?.tagName === "H4") {
            return (prev.textContent || "").trim()
        }
        const fieldset = table.closest(".as-fieldset")
        const legend = fieldset?.querySelector(".legend")
        if (legend) return (legend.textContent || "").trim()
        return ""
    }

    static _parseRow(tr, headers) {
        const isTotal = tr.classList.contains("figure-total")
        const labelEl = isTotal
            ? tr.querySelector("th span") || tr.querySelector("th")
            : tr.querySelector("td, th")
        if (!labelEl) return null
        const label = (labelEl.textContent || "").trim()
        if (!label) return null

        const cells = Array.from(tr.children).map(td => (td.textContent || "").trim())
        const numCells = tr.querySelectorAll("td.number")
        const numericValues = []
        for (let i = 0; i < numCells.length; i++) {
            const text = (numCells[i].textContent || "").trim()
            const isPercent = /%/.test(text)
            const value = isPercent
                ? AccountingSisterScraper._parsePercent(text)
                : AES.cleanInteger(text)
            numericValues.push({
                column: headers[i + 1] || ("col" + (i + 1)),
                raw: text,
                value: Number.isFinite(value) ? value : null,
                isPercent
            })
        }

        return {label, isTotal, cells, numericValues}
    }

    static _parsePercent(text) {
        const cleaned = String(text).replace(/[^\d.\-]/g, "")
        if (!cleaned || cleaned === "-" || cleaned === ".") return null
        const n = parseFloat(cleaned)
        return Number.isFinite(n) ? n : null
    }
}
