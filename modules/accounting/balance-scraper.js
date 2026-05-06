/**
 * Parses the Balance Sheet tab at `/app/finance/accounting/1`.
 *
 * Slice 1 ships a generic active-tab table-extractor: we capture every row
 * verbatim (label + numeric columns) so the data is preserved even before
 * the precise category structure is documented. Once a Balance Sheet capture
 * is taken, slice 1.5 will sharpen this into a typed asset/liability/equity
 * parser. Until then, the captured rows are still useful for raw mirror
 * display in the panel and for diff against future scrapes.
 *
 * Tab detection: AS marks the active tab with `.tab-pane.active`. Scoping the
 * search to that container avoids accidentally reading the previous tab's
 * leftover DOM if a partial AJAX swap is mid-flight.
 */
class AccountingBalanceScraper {
    /**
     * @param {Document|HTMLElement} root - defaults to document
     * @returns {object|null} {rows, totals, scrapedAt} or null when no
     *     parseable table is found.
     */
    static scrape(root = document) {
        const pane = AccountingBalanceScraper._activePane(root)
        if (!pane) return null
        const allTables = pane.getElementsByTagName("table")
        const tables = []
        for (let i = 0; i < allTables.length; i++) {
            if (allTables[i].classList.contains("table")) tables.push(allTables[i])
        }
        if (!tables.length) return null

        const rows = []
        const totals = {}

        for (const table of tables) {
            const headers = AccountingBalanceScraper._readHeaders(table)
            const tbodies = table.tBodies
            for (let i = 0; i < tbodies.length; i++) {
                const tbody = tbodies[i]
                for (const tr of tbody.rows) {
                    if (tr.classList.contains("figure-margin")) continue
                    const parsed = AccountingBalanceScraper._parseRow(tr, headers)
                    if (!parsed) continue
                    rows.push(parsed)
                    if (parsed.isTotal && parsed.label) {
                        totals[parsed.label] = {
                            label: parsed.label,
                            values: parsed.values
                        }
                    }
                }
            }
        }

        return {rows, totals, scrapedAt: Date.now()}
    }

    static _activePane(root) {
        return root.querySelector(".tab-pane.active")
            || root.querySelector(".tab-content")
            || root
    }

    static _readHeaders(table) {
        const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
        const ths = head && head.cells ? Array.from(head.cells) : []
        return ths.map(th => (th.textContent || "").trim())
    }

    static _parseRow(tr, headers) {
        const isTotal = tr.classList.contains("figure-total")
        let labelEl = null
        if (isTotal) {
            const ths = tr.getElementsByTagName("th")
            if (ths.length > 0) {
                const spans = ths[0].getElementsByTagName("span")
                labelEl = spans.length > 0 ? spans[0] : ths[0]
            }
        } else {
            labelEl = tr.cells.length > 0 ? tr.cells[0] : null
        }
        if (!labelEl) return null
        const label = (labelEl.textContent || "").trim()
        if (!label) return null

        const numCells = []
        for (let j = 0; j < tr.cells.length; j++) {
            if (tr.cells[j].classList.contains("number")) numCells.push(tr.cells[j])
        }
        if (!numCells.length) return null

        const values = []
        for (let i = 0; i < numCells.length; i++) {
            const text = (numCells[i].textContent || "").trim()
            const isPercent = /%/.test(text)
            const value = isPercent
                ? AccountingBalanceScraper._parsePercent(text)
                : AES.cleanInteger(text)
            values.push({
                column: headers[i + 1] || ("col" + (i + 1)),
                raw: text,
                value: Number.isFinite(value) ? value : null,
                isPercent
            })
        }

        return {label, isTotal, values}
    }

    static _parsePercent(text) {
        const cleaned = String(text).replace(/[^\d.\-]/g, "")
        if (!cleaned || cleaned === "-" || cleaned === ".") return null
        const n = parseFloat(cleaned)
        return Number.isFinite(n) ? n : null
    }
}
