/**
 * "Best Cases" card stack — the panel's headline view of the most attractive
 * offers, with deal-class badge + headline data + rationale chips + an
 * Open-offer action.
 *
 * Renders the top N rows by dealScore (default 4). Skips Pass-class
 * offerings entirely; they're never best cases by definition.
 */
class MarketPanelBestCases {
    static MAX_CARDS = 4

    static render(host, data, cb) {
        host.innerHTML = ""
        host.style.cssText = [
            "padding:10px 12px",
            "background:var(--aes-bone)",
            "border-bottom:1px solid var(--aes-paper-rule)"
        ].join(";")

        const heading = document.createElement("div")
        heading.textContent = "Best cases"
        heading.style.cssText = [
            "font:9px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase",
            "color:var(--aes-slate)",
            "margin-bottom:6px"
        ].join(";")
        host.append(heading)

        const cards = (data && data.cards) || []
        if (!cards.length) {
            const empty = document.createElement("div")
            empty.textContent = data && data.emptyText
                ? data.emptyText
                : "No qualifying offers yet."
            empty.style.cssText = "font-size:11px;color:var(--aes-slate);font-style:italic;"
            host.append(empty)
            return
        }

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        host.append(list)

        for (const card of cards) {
            list.append(MarketPanelBestCases._card(card, cb))
        }
    }

    static _card(row, cb) {
        const el = document.createElement("div")
        el.style.cssText = [
            "padding:8px 10px",
            "background:var(--aes-bone-2)",
            "border-left:4px solid " + (row.dealColor || "var(--aes-slate)"),
            "border-top:1px solid var(--aes-paper-rule)",
            "border-right:1px solid var(--aes-paper-rule)",
            "border-bottom:1px solid var(--aes-paper-rule)",
            "display:flex",
            "flex-direction:column",
            "gap:4px"
        ].join(";")

        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;"

        const badge = document.createElement("span")
        badge.textContent = row.dealLabel || row.dealClass || "—"
        badge.style.cssText = [
            "padding:2px 6px",
            "font:9px/1 var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase",
            "background:" + (row.dealColor || "var(--aes-slate)"),
            "color:#fff"
        ].join(";")
        top.append(badge)

        const title = document.createElement("strong")
        title.textContent = row.aircraftType || "Unknown type"
        title.style.cssText = "font-size:13px;color:var(--aes-oxide);"
        top.append(title)

        if (row.aircraftType
                && typeof window !== "undefined"
                && window.AesCanopyDnaFit
                && window.AesCanopyDnaStore) {
            const dnaPillHost = document.createElement("span")
            dnaPillHost.style.cssText = "display:inline-flex;align-items:center;"
            top.append(dnaPillHost)
            MarketPanelBestCases._attachDnaFitPill(dnaPillHost, row.aircraftType)
        }

        if (row.registration) {
            const reg = document.createElement("span")
            reg.textContent = row.registration
            reg.style.cssText = [
                "font-family:var(--aes-font-mono)",
                "letter-spacing:var(--aes-tracking-mono)",
                "font-size:11px",
                "color:var(--aes-oxide-2)"
            ].join(";")
            top.append(reg)
        }

        const score = document.createElement("span")
        score.textContent = (typeof row.dealScore === "number") ? String(row.dealScore) : "—"
        score.style.cssText = [
            "margin-left:auto",
            "font-family:var(--aes-font-mono)",
            "font-weight:var(--aes-fw-bold)",
            "font-size:14px",
            "color:var(--aes-oxide)"
        ].join(";")
        score.title = "Composite deal score (0–100)"
        top.append(score)

        el.append(top)

        const headline = document.createElement("div")
        headline.style.cssText = [
            "font:11px var(--aes-font-mono)",
            "color:var(--aes-oxide-2)",
            "letter-spacing:var(--aes-tracking-mono)"
        ].join(";")
        const bits = []
        // Render the cost using the basis the row was scored on, so a
        // lease-only offer doesn't get hidden behind an em-dash and a
        // purchase row still reads as a one-time AS$ figure.
        if (row.priceBasis === "lease" && typeof row.monthlyLease === "number") {
            bits.push("AS$ " + Math.round(row.monthlyLease).toLocaleString() + "/mo lease")
        } else {
            const price = MarketScanDealMetrics.acquisitionPrice(row)
            if (price !== null) bits.push("AS$ " + Math.round(price).toLocaleString())
        }
        if (typeof row.pricePerSeat === "number") {
            const perSeatSuffix = row.priceBasis === "lease" ? "/seat/mo" : "/seat"
            bits.push(Math.round(row.pricePerSeat).toLocaleString() + perSeatSuffix)
        }
        if (row.ageYears !== null && row.ageYears !== undefined) {
            bits.push(MarketPanelBestCases._fmtAge(row.ageYears))
        }
        if (row.conditionPct !== null && row.conditionPct !== undefined) {
            bits.push(Math.round(row.conditionPct) + "%")
        }
        if (row.bidInterval) bits.push(row.bidInterval + " left")
        headline.textContent = bits.join(" · ")
        el.append(headline)

        if (Array.isArray(row.dealReasons) && row.dealReasons.length) {
            const chipRow = document.createElement("div")
            chipRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;"
            for (const r of row.dealReasons) {
                const chip = document.createElement("span")
                chip.textContent = r
                chip.style.cssText = [
                    "padding:1px 6px",
                    "font:10px var(--aes-font-display)",
                    "font-weight:var(--aes-fw-medium)",
                    "background:var(--aes-bone-3)",
                    "color:var(--aes-oxide-2)",
                    "border:1px solid var(--aes-paper-rule)"
                ].join(";")
                chipRow.append(chip)
            }
            el.append(chipRow)
        }

        // Auto-generated narrative — woven from the same decorated metrics
        // that drive the chips, but in trader prose so the user reads "why
        // this is good" at a glance instead of decoding chips + numbers.
        if (typeof MarketScanDealNarrative !== "undefined") {
            const summary = MarketScanDealNarrative.summarize(row)
            if (summary) {
                const narrative = document.createElement("div")
                narrative.textContent = summary
                narrative.style.cssText = [
                    "font:11px var(--aes-font-body)",
                    "color:var(--aes-oxide-2)",
                    "line-height:1.4",
                    "padding-top:2px"
                ].join(";")
                el.append(narrative)
            }
        }

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:6px;align-items:center;"
        const open = document.createElement("a")
        open.href = row.offerUrl || "#"
        open.textContent = "Open offer →"
        open.style.cssText = [
            "font:10px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "text-transform:uppercase",
            "letter-spacing:var(--aes-tracking-caps)",
            "color:var(--aes-rust)",
            "text-decoration:none"
        ].join(";")
        if (!row.offerUrl) {
            open.style.opacity = "0.5"
            open.style.pointerEvents = "none"
        }
        actions.append(open)

        const owner = document.createElement("span")
        owner.textContent = row.owner ? "Seller: " + row.owner : ""
        owner.style.cssText = "margin-left:auto;font-size:10px;color:var(--aes-slate);"
        actions.append(owner)

        el.append(actions)

        if (cb && typeof cb.onCardHover === "function") {
            el.addEventListener("mouseenter", () => cb.onCardHover(row))
        }
        return el
    }

    static _fmtAge(years) {
        const y = Math.floor(years)
        const m = Math.round((years - y) * 12)
        if (y === 0 && m === 0) return "<1mo"
        if (y === 0) return m + "mo"
        if (m === 0) return y + "y"
        return y + "y " + m + "mo"
    }

    static async _attachDnaFitPill(host, aircraftType) {
        try {
            if (!MarketPanelBestCases._dnaTemplatePromise) {
                MarketPanelBestCases._dnaTemplatePromise = window.AesCanopyDnaStore.loadTemplate()
            }
            const dna = await MarketPanelBestCases._dnaTemplatePromise
            if (!dna) return
            const candidate = MarketPanelBestCases._typeToDnaCandidate(aircraftType)
            const result = window.AesCanopyDnaFit.dnaFitScoreAircraft(dna, candidate)
            if (!result || !result.breakdown || !Object.keys(result.breakdown).length) return
            window.AesCanopyDnaFit.renderInto(host, result,
                {label: aircraftType + " — fit vs DNA template"})
        } catch (_) { /* graceful — best-cases card still renders */ }
    }

    static _typeToDnaCandidate(aircraftType) {
        const family = (typeof TypeFamilyMap !== "undefined")
            ? TypeFamilyMap.resolve(aircraftType) : null
        const category = (family && typeof TypeFamilyMap !== "undefined")
            ? TypeFamilyMap.category(family) : null
        const sizeClass = (category === "widebody" || category === "narrowbody")
            ? category : "regional"
        const isCargo = /\b(freighter|cargo|p2f)\b/i.test(aircraftType)
        return {manufacturer: aircraftType, sizeClass: sizeClass, isCargo: isCargo}
    }

    /**
     * Pick the top N rows by dealScore, excluding Pass-class. Pure — does
     * not mutate input.
     */
    static compute(rows, limit) {
        const max = limit || MarketPanelBestCases.MAX_CARDS
        const eligible = rows.filter(r =>
            r && r.dealClass && r.dealClass !== "pass"
            && typeof r.dealScore === "number")
        eligible.sort((a, b) => (b.dealScore - a.dealScore))
        return {cards: eligible.slice(0, max)}
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelBestCases
