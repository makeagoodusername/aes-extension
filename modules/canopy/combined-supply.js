"use strict"

/**
 * Letter L slice L6 — combined-supply aggregator.
 *
 * Today the RA panel asks "of all the carriers on this route, which are
 * mine?" — a binary. Once L4-lite affiliations exist, the question becomes
 * structured:
 *
 *   - Kin supply        — total weekly flights + share from self+sister kin
 *   - Partner supply    — flights from allied / interline / codeshare partners
 *                         (count toward connection options, not direct competition)
 *   - Effective comp    — flights from neutrals + adversaries only; THIS is the
 *                         number that should drive pricing aggressiveness, ORS
 *                         rank target, defensive moves
 *   - Cannibalization   — kin combined share > overserved threshold
 *   - Gap (federation)  — high-demand kin-absent destination from any kin hub
 *
 * Pure module. No IO. The panel passes in classification + market data,
 * the aggregator returns plain decoration fields the columns render.
 *
 * v1 limitation (data plumbing): per-competitor weekly flight counts are
 * not exposed in `routeAssistant:markets:competitors:*` at the per-flight
 * level today (per-flight rows don't carry enterpriseId). v1 therefore
 * derives kin/partner/competitor *counts* from the deduped market-share
 * leaderboards (`competitorEntries[]`), and kin/partner/competitor *shares*
 * from the same leaderboard. Per-account sister-kin frequencies require
 * the L3 markets refactor — until then, MyWk reflects this account's
 * own frequency. See the Slice L6 deferrals in HANDOVER §1 for the path.
 *
 * Pillar: FEDERATE (primary), DECIDE (secondary). No POSTs. Read-only.
 */
;(function () {
    if (window.AesCanopyCombinedSupply) return

    const PARTNER_KINDS = {"allied": 1, "interline": 1, "codeshare": 1}
    const KIN_KINDS     = {"self": 1}

    // Cannib heuristic: combined kin share above this threshold means the
    // federation is collectively dominating the route — likely eating each
    // others' demand. Tuned conservatively; user-visible warning with a
    // tooltip explaining the assumption.
    const DEFAULT_CANNIB_SHARE_PCT  = 80
    const DEFAULT_CANNIB_MIN_KIN    = 2     // single-kin users never see Cannib

    // Gap heuristic: federation-absent route is "gap" when paxScore ≥ this
    // threshold AND no kin (including this account) operates it from any of
    // the federation's hubs.
    const DEFAULT_GAP_MIN_PAXSCORE  = 8

    /**
     * Classify and aggregate per-row supply structure.
     *
     *   row             — per-route record from RouteAssistantAggregator output;
     *                     reads `competitorEntries[]`, `marketSharePax[]`,
     *                     `ourTotalFreq`, `ourPaxFreq`, `ourPaxShare`
     *   ctx             — {classifyKind(eid)→string, isOurs(eid)→bool}
     *                     classifyKind returns one of "self"|"allied"|
     *                     "interline"|"codeshare"|"neutral"|"adversary".
     *                     isOurs returns true for the *current account's*
     *                     enterprise ids (from the navbar dropdown). These
     *                     are already excluded from competitorEntries so
     *                     isOurs is consulted only for share aggregation.
     *   opts            — {cannibShareThresholdPct, cannibMinKin}
     *
     * Returns:
     *   {
     *     kinFlights,                  // your own + observable sister-kin freq
     *     kinShare,                    // your share + sister-kin's share (0..100)
     *     partnerFlights,              // count of allied/interline/codeshare entries
     *     effectiveCompetitorCount,    // count of neutral/adversary entries
     *     cannibalizationRisk,         // boolean
     *     cannibRationale,             // string for tooltip
     *     kinCount,                    // number of distinct kin enterprises seen
     *     partnerCount,                // alias for partnerFlights (clarity)
     *     unclassifiedCount,           // entries with no enterpriseId — counted
     *                                  // as effective comp by default
     *     // diagnostics for tooltip + panel debug
     *     classified: [{enterpriseId, kind, sharePct, name}]
     *   }
     */
    function combinedSupply(row, ctx, opts) {
        const out = {
            kinFlights:                row && typeof row.ownTotalFreq === "number" ? row.ownTotalFreq : 0,
            kinShare:                  null,   // null until we see at least one share datum
            partnerFlights:            0,
            partnerCount:              0,
            effectiveCompetitorCount:  0,
            cannibalizationRisk:       false,
            cannibRationale:           null,
            kinCount:                  0,
            unclassifiedCount:         0,
            classified:                []
        }

        if (!row) return out

        const classifyKind = (ctx && typeof ctx.classifyKind === "function")
            ? ctx.classifyKind
            : (() => "neutral")
        const isOurs = (ctx && typeof ctx.isOurs === "function")
            ? ctx.isOurs
            : (() => false)

        // 1. Walk dedup'd competitor leaderboard. competitorEntries already
        //    excludes the current account's enterprises; remaining sister-kin,
        //    partners, and competitors are classified here.
        const competitors = Array.isArray(row.competitorEntries) ? row.competitorEntries : []
        let kinShareFromOthers = 0
        let kinShareSeen = false

        for (const c of competitors) {
            const eid = c && c.enterpriseId != null ? String(c.enterpriseId) : null
            const sharePct = (typeof c.paxShare === "number" && isFinite(c.paxShare))
                ? c.paxShare : null

            if (!eid) {
                // No id — can't classify. Default to effective competitor.
                out.effectiveCompetitorCount++
                out.unclassifiedCount++
                continue
            }

            const kind = classifyKind(eid) || "neutral"
            out.classified.push({
                enterpriseId: eid, kind: kind,
                sharePct: sharePct, name: c.name || null
            })

            if (KIN_KINDS[kind]) {
                out.kinCount++
                if (sharePct != null) {
                    kinShareFromOthers += sharePct
                    kinShareSeen = true
                }
            } else if (PARTNER_KINDS[kind]) {
                out.partnerFlights++
            } else {
                out.effectiveCompetitorCount++
            }
        }
        out.partnerCount = out.partnerFlights

        // 2. kinShare = ourPaxShare + sister-kin shares observed in leaderboard.
        //    Either source can be missing; if both are absent, leave null so
        //    the column renders "—" rather than a misleading 0.
        const ourShare = (typeof row.ourPaxShare === "number" && isFinite(row.ourPaxShare))
            ? row.ourPaxShare : null
        if (ourShare != null || kinShareSeen) {
            out.kinShare = (ourShare || 0) + kinShareFromOthers
        }

        // 3. Cannibalization heuristic — fires only when 2+ kin are present
        //    AND combined kinShare crosses the threshold. Single-kin users
        //    never see it. Tooltip surfaces the rationale.
        const cannibShareThresholdPct =
            (opts && typeof opts.cannibShareThresholdPct === "number")
                ? opts.cannibShareThresholdPct : DEFAULT_CANNIB_SHARE_PCT
        const cannibMinKin =
            (opts && typeof opts.cannibMinKin === "number")
                ? opts.cannibMinKin : DEFAULT_CANNIB_MIN_KIN

        // The kin count for cannib = sister-kin observed in leaderboard PLUS
        // 1 for the current account when ourShare is present (we are kin too).
        const totalKinSeen = out.kinCount + (ourShare != null ? 1 : 0)
        if (totalKinSeen >= cannibMinKin
                && out.kinShare != null
                && out.kinShare >= cannibShareThresholdPct) {
            out.cannibalizationRisk = true
            out.cannibRationale = "Combined kin share " + Math.round(out.kinShare)
                + "% across " + totalKinSeen + " kin — federation is overserving "
                + "this route. Consider consolidating onto fewer kin."
        }

        return out
    }

    /**
     * Build a Set of routeKeys ("HUB-DEST") that the federation does NOT yet
     * operate but that meet the Gap threshold from any kin hub's topRoutes
     * cache.
     *
     *   kinHubsTopRoutes — array of {hub, rows: [{destIata, paxScore, operating, ...}]}
     *                      (one entry per kin hub, multiple hubs allowed)
     *   thisAccountKinFreqs — Map<"HUB-DEST", boolean> indicating routes the
     *                      current account already operates (built from row.operating).
     *                      Pass empty Map if the caller wants Gap to consider
     *                      every hub equally. The Gap detector unions both.
     *   opts             — {minPaxScore: number}
     *
     * Returns Set<"HUB-DEST"> — entries the panel can flag with ✚ in the
     * Gap? column.
     *
     * Pure: no IO; the caller resolves the hub→topRoutes data shape.
     */
    function detectGapRoutes(kinHubsTopRoutes, thisAccountKinFreqs, opts) {
        const out = new Set()
        const minPaxScore = (opts && typeof opts.minPaxScore === "number")
            ? opts.minPaxScore : DEFAULT_GAP_MIN_PAXSCORE

        if (!Array.isArray(kinHubsTopRoutes) || !kinHubsTopRoutes.length) return out

        // A route is "operated by federation" when ANY kin hub's topRoutes
        // record marks it operating, OR thisAccountKinFreqs flags it.
        const operatedKeys = new Set()
        for (const hubRec of kinHubsTopRoutes) {
            if (!hubRec || !hubRec.hub || !Array.isArray(hubRec.rows)) continue
            const HUB = String(hubRec.hub).toUpperCase()
            for (const r of hubRec.rows) {
                if (!r || !r.destIata) continue
                const key = HUB + "-" + String(r.destIata).toUpperCase()
                if (r.operating === true || (typeof r.ownTotalFreq === "number" && r.ownTotalFreq > 0)) {
                    operatedKeys.add(key)
                }
            }
        }
        if (thisAccountKinFreqs && typeof thisAccountKinFreqs.forEach === "function") {
            thisAccountKinFreqs.forEach((operating, key) => {
                if (operating) operatedKeys.add(String(key).toUpperCase())
            })
        }

        // Now scan all kin hubs' high-demand routes; emit Gap when not in
        // operatedKeys.
        for (const hubRec of kinHubsTopRoutes) {
            if (!hubRec || !hubRec.hub || !Array.isArray(hubRec.rows)) continue
            const HUB = String(hubRec.hub).toUpperCase()
            for (const r of hubRec.rows) {
                if (!r || !r.destIata) continue
                if (typeof r.paxScore !== "number" || r.paxScore < minPaxScore) continue
                const key = HUB + "-" + String(r.destIata).toUpperCase()
                if (operatedKeys.has(key)) continue
                out.add(key)
            }
        }
        return out
    }

    window.AesCanopyCombinedSupply = {
        combinedSupply,
        detectGapRoutes,
        DEFAULT_CANNIB_SHARE_PCT,
        DEFAULT_CANNIB_MIN_KIN,
        DEFAULT_GAP_MIN_PAXSCORE
    }
})()
