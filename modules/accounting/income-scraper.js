/**
 * Parses the Income Statement tab at `/app/finance/accounting/0`.
 *
 * AS renders a single `.income-statement .table` with four `<tbody>` blocks,
 * each ending in a `tr.figure-total` (subtotal — Revenue, Adjusted EBITDA,
 * EBITDA, EBIT, EBT) and optionally a `tr.figure-margin` (the `--` placeholder
 * margin row, intentionally skipped — those values are derivable from the
 * subtotals and AS doesn't actually compute them when revenue is zero).
 *
 * Currency cells use the `123,456 AS$` format that `AES.cleanInteger` already
 * handles. Negative cells carry `td.number.bad`; we preserve the sign via
 * cleanInteger's `[^\d-]` strip. The Change column carries `0%` strings; we
 * parse it as a separate field (parsePercent).
 *
 * The financial-week footer ("The current financial week closes on YYYY-MM-DD")
 * gives us the weekId — derived from the first `<span title>` after the table.
 */
class AccountingIncomeScraper {
    static TOTAL_LABELS = new Set([
        "Revenue", "Adjusted EBITDA", "EBITDA",
        "EBIT (Operative Result)", "EBT (Financial Result)"
    ])

    /**
     * Scrapes the active income-statement table from the current document.
     * @param {Document|HTMLElement} root - defaults to document
     * @returns {object|null} {weekClosesAt, rows, totals, scrapedAt} or null
     */
    static scrape(root = document) {
        const table = root.querySelector(".income-statement .table")
        if (!table) return null

        const rows = []
        const totals = {}
        let groupIndex = 0

        for (const tbody of table.querySelectorAll("tbody")) {
            for (const tr of tbody.children) {
                if (tr.classList.contains("figure-margin")) continue

                const isTotal = tr.classList.contains("figure-total")
                const labelEl = isTotal
                    ? tr.querySelector("th span") || tr.querySelector("th")
                    : tr.querySelector("td")
                if (!labelEl) continue
                const label = (labelEl.textContent || "").trim()
                if (!label) continue

                const numCells = tr.querySelectorAll("td.number")
                if (numCells.length < 5) continue

                const row = {
                    label,
                    isTotal,
                    group: groupIndex,
                    current: AES.cleanInteger(numCells[0].textContent),
                    last: AES.cleanInteger(numCells[1].textContent),
                    previous: AES.cleanInteger(numCells[2].textContent),
                    changePct: AccountingIncomeScraper._parsePercent(numCells[3].textContent),
                    total: AES.cleanInteger(numCells[4].textContent)
                }
                rows.push(row)

                if (isTotal && AccountingIncomeScraper.TOTAL_LABELS.has(label)) {
                    totals[AccountingIncomeScraper._totalKey(label)] = {
                        label,
                        current: row.current,
                        last: row.last,
                        previous: row.previous,
                        total: row.total
                    }
                    groupIndex++
                }
            }
        }

        const weekClosesAt = AccountingIncomeScraper._readWeekClosesAt(root)

        return {
            weekClosesAt,
            rows,
            totals,
            scrapedAt: Date.now()
        }
    }

    static _totalKey(label) {
        if (label === "EBIT (Operative Result)") return "ebit"
        if (label === "EBT (Financial Result)") return "ebt"
        if (label === "Adjusted EBITDA") return "adjEbitda"
        return label.toLowerCase()
    }

    static _parsePercent(text) {
        if (!text) return null
        const cleaned = String(text).replace(/[^\d.\-]/g, "")
        if (!cleaned || cleaned === "-" || cleaned === ".") return null
        const n = parseFloat(cleaned)
        return Number.isFinite(n) ? n : null
    }

    /**
     * Reads the "current financial week closes on YYYY-MM-DD" footer. The
     * date `<span>` carries a `title` attribute like "2026-05-02 UTC / ..."
     * — we use the leading YYYY-MM-DD as the canonical weekId.
     */
    static _readWeekClosesAt(root) {
        for (const p of root.querySelectorAll(".income-statement p")) {
            const span = p.querySelector("span[title]")
            const text = (p.textContent || "").trim()
            if (!span || !/closes on/i.test(text)) continue
            const title = (span.getAttribute("title") || "").trim()
            const m = title.match(/^(\d{4}-\d{2}-\d{2})/)
            if (m) return m[1]
            const inner = (span.textContent || "").trim()
            if (/^\d{4}-\d{2}-\d{2}$/.test(inner)) return inner
        }
        return null
    }
}
