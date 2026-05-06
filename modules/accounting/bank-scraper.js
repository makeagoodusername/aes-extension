/**
 * Parses the Bank Account tab at `/app/finance/accounting/2`.
 *
 * Slice 1 ships the same generic active-tab extractor as the balance-sheet
 * scraper plus a navbar-balance shortcut so we always capture the headline
 * cash position even when the page's main table layout changes. Slice 1.5
 * will harden this once a Bank Account capture documents the transaction-list
 * structure.
 */
class AccountingBankScraper {
    /**
     * @param {Document|HTMLElement} root - defaults to document
     * @returns {object|null} {cashBalance, rows, scrapedAt} or null when
     *     neither the navbar balance nor any tab table is parseable.
     */
    static scrape(root = document) {
        const cashBalance = AccountingBankScraper._readNavbarBalance(root)
        const pane = AccountingBankScraper._activePane(root)
        const rows = []

        if (pane) {
            const tables = pane.getElementsByTagName("table")
            for (let i = 0; i < tables.length; i++) {
                const table = tables[i]
                if (!table.classList.contains("table")) continue

                const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
                const headers = head && head.cells ? Array.from(head.cells).map(th => (th.textContent || "").trim()) : []

                const tbody = table.tBodies.length > 0 ? table.tBodies[0] : null
                if (!tbody) continue
                for (const tr of tbody.rows) {
                    if (tr.classList.contains("figure-margin")) continue
                    const cells = Array.from(tr.cells).map(td => (td.textContent || "").trim())
                    if (!cells.length) continue

                    const numericValues = []
                    for (let j = 0; j < tr.cells.length; j++) {
                        const td = tr.cells[j]
                        if (td.classList.contains("number")) {
                            numericValues.push({
                                raw: (td.textContent || "").trim(),
                                value: AES.cleanInteger(td.textContent || "")
                            })
                        }
                    }
                    rows.push({headers, cells, numericValues})
                }
            }
        }

        if (cashBalance == null && !rows.length) return null

        return {cashBalance, rows, scrapedAt: Date.now()}
    }

    /**
     * Reads the navbar's headline balance — present on every AS page, not just
     * the Bank Account tab. Returns null when the navbar is missing or the
     * balance can't be parsed.
     */
    static _readNavbarBalance(root) {
        const balance = root.querySelector(".as-navbar-main .balance")
        if (!balance) return null
        const text = (balance.textContent || "").trim()
        if (!text) return null
        const value = AES.cleanInteger(text)
        return Number.isFinite(value) ? value : null
    }

    static _activePane(root) {
        return root.querySelector(".tab-pane.active")
            || root.querySelector(".tab-content")
            || null
    }
}
