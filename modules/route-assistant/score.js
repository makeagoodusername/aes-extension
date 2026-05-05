/**
 * Pure scoring function for the Route Assistant.
 *
 * Identical formula to MarketScanResultsTable._scoreRows in the used-aircraft
 * scanner: per-field min/max normalisation across the visible row set, a
 * directional flip for "lower = better" fields, then a weighted average.
 *
 * Inputs are decoupled from the row shape so a future caller can score
 * arbitrary row arrays without dragging in DOM:
 *
 *   RouteAssistantScore.computeScores(rows, scoringConfig, fieldDefs)
 *
 * `rows`  — array of plain objects (e.g. one per route).
 * `scoringConfig` — settings.routeAssistant.scoring shape:
 *   { paxScore: {enabled, weight, min, max}, ... }
 * `fieldDefs` — array of {field, direction: "higher"|"lower"} describing
 *   every variable that may participate. The function ignores variables
 *   whose `enabled` flag is false or whose weight resolves to 0.
 *
 * Returns a new array of rows with `score` (0-100) added. Missing values
 * contribute 0 to the numerator but their full weight still counts in the
 * denominator, so sparse-data rows score proportionally lower than rows
 * that score equally well on every input. (Without this, a row with only
 * one favourable input would tie with a row that wins on every input.)
 */
class RouteAssistantScore {
    static computeScores(rows, scoringConfig, fieldDefs) {
        const fields = (fieldDefs || []).filter(f => {
            const cfg = scoringConfig && scoringConfig[f.field]
            return cfg && cfg.enabled
        })
        if (!fields.length) return (rows || []).map(r => Object.assign({score: null}, r))

        const ranges = {}
        const fullWeight = fields.reduce((sum, f) => {
            const cfg = scoringConfig[f.field]
            const w = RouteAssistantScore._weight(cfg && cfg.weight)
            return sum + (w > 0 ? w : 0)
        }, 0)
        for (const f of fields) {
            let lo = Infinity, hi = -Infinity
            for (const r of rows) {
                const v = r[f.field]
                if (v === null || v === undefined || v === "") continue
                const n = Number(v)
                if (!isFinite(n)) continue
                if (n < lo) lo = n
                if (n > hi) hi = n
            }
            ranges[f.field] = {lo: lo, hi: hi}
        }

        return rows.map(r => {
            let weightedSum = 0, contributed = 0
            for (const f of fields) {
                const cfg = scoringConfig[f.field]
                const w = RouteAssistantScore._weight(cfg && cfg.weight)
                if (w <= 0) continue
                const v = r[f.field]
                if (v === null || v === undefined || v === "") continue
                const n = Number(v)
                if (!isFinite(n)) continue
                const {lo, hi} = ranges[f.field]
                let norm
                if (hi === lo) norm = 1
                else norm = (n - lo) / (hi - lo)
                // Direction may be overridden by the user in scoringConfig.
                const dir = (cfg && cfg.direction) || f.direction
                const directional = dir === "lower" ? (1 - norm) : norm
                weightedSum += directional * w
                contributed += w
            }
            const score = (fullWeight > 0 && contributed > 0)
                ? Math.round((weightedSum / fullWeight) * 100)
                : null
            return Object.assign({score: score}, r)
        })
    }

    static _weight(v) {
        if (v === null || v === undefined || v === "") return 1
        const n = Number(v)
        if (!isFinite(n) || n < 0) return 1
        return n
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantScore
}
