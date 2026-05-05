/**
 * KPI strip — at-a-glance summary tiles for the panel header area. Reads
 * pre-computed metrics off the panel state; pure rendering, no logic.
 *
 * Five tiles: total / best score / median $/seat / steal count / expiring soon.
 * Lays out in a 5-column flex on wide widths and wraps to 2-3 columns when
 * the panel narrows below ~440px.
 */
class MarketPanelKpiStrip {
    static render(host, data) {
        host.innerHTML = ""
        host.style.cssText = [
            "display:flex",
            "gap:6px",
            "padding:8px 12px",
            "flex-wrap:wrap",
            "background:var(--aes-bone)",
            "border-bottom:1px solid var(--aes-paper-rule)"
        ].join(";")

        if (!data || !data.tiles || !data.tiles.length) {
            const empty = document.createElement("div")
            empty.textContent = "No data yet."
            empty.style.cssText = "color:var(--aes-slate);font-size:11px;font-style:italic;"
            host.append(empty)
            return
        }

        for (const tile of data.tiles) {
            host.append(MarketPanelKpiStrip._tile(tile))
        }
    }

    static _tile(t) {
        const el = document.createElement("div")
        el.style.cssText = [
            "flex:1 1 80px",
            "min-width:78px",
            "padding:6px 8px",
            "background:var(--aes-bone-2)",
            "border:1px solid var(--aes-paper-rule)",
            "display:flex",
            "flex-direction:column",
            "gap:2px"
        ].join(";")

        const label = document.createElement("span")
        label.textContent = t.label
        label.style.cssText = [
            "font:9px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase",
            "color:var(--aes-slate)"
        ].join(";")

        const value = document.createElement("span")
        value.textContent = t.value === null || t.value === undefined ? "—" : String(t.value)
        value.style.cssText = [
            "font-family:var(--aes-font-mono)",
            "font-weight:var(--aes-fw-bold)",
            "font-size:18px",
            "color:" + (t.color || "var(--aes-oxide)"),
            "letter-spacing:var(--aes-tracking-mono)",
            "line-height:1.1"
        ].join(";")

        el.append(label, value)
        if (t.tooltip) el.title = t.tooltip
        if (t.sub) {
            const sub = document.createElement("span")
            sub.textContent = t.sub
            sub.style.cssText = "font-size:9px;color:var(--aes-slate);font-family:var(--aes-font-mono);"
            el.append(sub)
        }
        return el
    }

    static _scoreColor(score) {
        if (score === null) return null
        if (score >= 85) return "var(--aes-rust)"
        if (score >= 70) return "var(--aes-moss)"
        return "var(--aes-oxide)"
    }

    /**
     * Compute the tiles array from a row set. Pure — caller passes already-
     * filtered rows so the strip reflects what's visible.
     */
    static compute(rows) {
        const total = rows.length
        let bestScore = null
        let stealCount = 0
        let expiringCount = 0
        const ppsArr = []
        for (const r of rows) {
            if (typeof r.dealScore === "number" && (bestScore === null || r.dealScore > bestScore)) {
                bestScore = r.dealScore
            }
            if (r.dealClass === "steal") stealCount++
            if (typeof r.bidIntervalMs === "number"
                && r.bidIntervalMs >= 0
                && r.bidIntervalMs < 6 * 60 * 60 * 1000) {
                expiringCount++
            }
            const pps = Number(r.pricePerSeat)
            if (isFinite(pps) && pps > 0) ppsArr.push(pps)
        }
        ppsArr.sort((a, b) => a - b)
        const medianPps = ppsArr.length
            ? ppsArr[Math.floor(ppsArr.length / 2)]
            : null
        return {tiles: [
            {label: "Offers", value: total},
            {label: "Best Score",
                value: bestScore === null ? "—" : bestScore,
                color: MarketPanelKpiStrip._scoreColor(bestScore),
                tooltip: "Highest composite deal score in the visible set"},
            {label: "Med $/seat",
                value: medianPps === null ? "—" : MarketPanelKpiStrip._fmtCurrency(medianPps),
                tooltip: "Median price-per-seat across visible offers (acquisition price ÷ seats; leasing excluded)"},
            {label: "Steals",
                value: stealCount,
                color: stealCount > 0 ? "var(--aes-rust)" : null,
                tooltip: "Offers classified as Steal — cheap on history, decent condition, young airframe"},
            {label: "<6h to bid",
                value: expiringCount,
                color: expiringCount > 0 ? "var(--aes-amber)" : null,
                tooltip: "Offers whose bid interval ends in under 6 hours"}
        ]}
    }

    static _fmtCurrency(n) {
        if (typeof AES !== "undefined" && AES.formatCurrency) {
            const node = AES.formatCurrency(n)
            if (node && node.textContent) return node.textContent
            if (typeof node === "string") return node
        }
        return Math.round(n).toLocaleString()
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelKpiStrip
