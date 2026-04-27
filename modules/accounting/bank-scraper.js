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
            for (const table of pane.querySelectorAll("table.table")) {
                const headers = Array.from(table.querySelectorAll("thead th"))
                    .map(th => (th.textContent || "").trim())
                for (const tr of table.querySelectorAll("tbody tr")) {
                    if (tr.classList.contains("figure-margin")) continue
                    const cells = Array.from(tr.children).map(td => (td.textContent || "").trim())
                    if (!cells.length) continue
                    const numericCells = tr.querySelectorAll("td.number")
                    const numericValues = Array.from(numericCells).map(td => ({
                        raw: (td.textContent || "").trim(),
                        value: AES.cleanInteger(td.textContent || "")
                    }))
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
