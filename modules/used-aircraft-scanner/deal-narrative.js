"use strict"

/**
 * Plain-English deal rationale generator.
 *
 * Composes a 1–2 sentence trader-style summary of an offer woven from
 * metrics already decorated onto the row by `MarketScanDealMetrics.decorate`
 * + classified by `MarketScanDealClassifier.decorateAll`. Pure formatting —
 * does not recompute any metric, just stitches them into prose.
 *
 * Output shape:
 *   "<dealLabel> — <type> from <owner> at <price>.
 *    Strengths: <r1>, <r2>.
 *    Fits 8/12 of your routes, already in fleet (3).
 *    Watch: heavy maintenance ahead."
 *
 * Surfaced two places:
 *   - Under the chip rationale on each best-cases card
 *   - As the score-cell tooltip in the results table
 *
 * Returns null when the row carries no signal worth narrating (e.g. no
 * deal class set yet during a streaming scan).
 */
class MarketScanDealNarrative {
    static MAX_REASONS = 2

    static summarize(row) {
        if (!row) return null
        const sentences = []

        const head = MarketScanDealNarrative._headline(row)
        if (head) sentences.push(head)

        const reasons = Array.isArray(row.dealReasons)
            ? row.dealReasons.filter(r => typeof r === "string" && r)
            : []
        if (reasons.length) {
            const top = reasons.slice(0, MarketScanDealNarrative.MAX_REASONS)
            sentences.push("Strengths: " + top.join(", ") + ".")
        }

        const fit = MarketScanDealNarrative._fit(row)
        if (fit) sentences.push(fit)

        const caveats = MarketScanDealNarrative._caveats(row)
        if (caveats.length) sentences.push("Watch: " + caveats.join(", ") + ".")

        return sentences.length ? sentences.join(" ") : null
    }

    static _headline(row) {
        const type  = row.aircraftType || "Unknown type"
        const label = row.dealLabel || (row.dealClass
            ? row.dealClass.charAt(0).toUpperCase() + row.dealClass.slice(1)
            : null)
        const owner = row.owner ? " from " + row.owner : ""
        const price = MarketScanDealNarrative._priceFragment(row)
        if (label && price) return label + " — " + type + owner + " at " + price + "."
        if (price)          return type + owner + " — " + price + "."
        if (label)          return label + " — " + type + owner + "."
        return type + owner + "."
    }

    static _priceFragment(row) {
        // Buy mode: show what the user actually pays (purchase price).
        // Lease mode: show the monthly lease. The classifier still scores
        // both on lease rate, but the narrative copy should match the
        // displayed price columns (see results-table mode-aware columns).
        if (row.userMode === "buy" && typeof MarketScanDealMetrics !== "undefined") {
            const p = MarketScanDealMetrics.acquisitionPrice(row)
            if (p !== null) return "AS$" + Math.round(p).toLocaleString()
        }
        if (typeof row.monthlyLease === "number") {
            return "AS$" + Math.round(row.monthlyLease).toLocaleString() + "/mo lease"
        }
        if (typeof MarketScanDealMetrics !== "undefined") {
            const p = MarketScanDealMetrics.acquisitionPrice(row)
            if (p !== null) return "AS$" + Math.round(p).toLocaleString()
        }
        return null
    }

    static _fit(row) {
        const bits = []
        if (typeof row.routeFitCount === "number"
            && typeof row.routeFitTotal === "number"
            && row.routeFitTotal > 0) {
            bits.push("fits " + row.routeFitCount + "/" + row.routeFitTotal + " of your routes")
        }
        if (row.fleetOwned && row.fleetOwnedCount > 0) {
            bits.push("already in fleet (" + row.fleetOwnedCount + ")")
        }
        if (!bits.length) return null
        const joined = bits.join(", ")
        return joined.charAt(0).toUpperCase() + joined.slice(1) + "."
    }

    static _caveats(row) {
        const cv = []
        if (row.maintLevel === "red") cv.push("heavy maintenance ahead")
        if (typeof row.routeFitCount === "number"
            && typeof row.routeFitTotal === "number"
            && row.routeFitTotal > 0
            && row.routeFitCount === 0) {
            cv.push("doesn't cover any of your current top routes")
        }
        if (typeof row.ageYears === "number" && row.ageYears >= 25) {
            cv.push("near retirement (" + Math.round(row.ageYears) + "y)")
        }
        return cv
    }
}

if (typeof window !== "undefined") window.MarketScanDealNarrative = MarketScanDealNarrative
if (typeof module !== "undefined" && module.exports) module.exports = MarketScanDealNarrative
