"use strict"

/**
 * Letter M slice M0 — pure-function role detector.
 *
 * Given per-kin observable inputs, classify the account into one of six
 * roles (or "unclassified" when signals are insufficient). Heuristic-only;
 * the user override is absolute (invariant M-C). Confidence reflects how
 * strongly the signals support the classification — low confidence routes
 * still surface as drift cards in the family briefing for user review.
 *
 * Inputs (all optional — degrade gracefully when missing per §4.8):
 *   tails:      TailRow[] from AesFleetCommand.build() filtered to one kin
 *   fleetRec:   {aircraft: [{equipment, typeId, hubIata, …}]} from AesFleetRoster
 *   routes:     [{originIata, destIata, ...}] best-effort top routes (optional)
 *
 * Output:
 *   {
 *     role: "flag-carrier" | "regional-feeder" | "low-cost" |
 *           "cargo" | "charter-leisure" | "holding-lease" | "unclassified",
 *     confidence: 0..1,
 *     signals: ["wide-body share 64% (8 of 14 tails)", ...],
 *     primaryHubs:   [iata, ...],   // sorted by departure count desc
 *     secondaryHubs: [iata, ...]
 *   }
 *
 * The detector is pure — no DOM, no chrome.storage, no I/O. Safe to call
 * at 60 Hz. Pulled into the canopy block so cross-page consumers don't
 * have to re-derive these heuristics.
 */
;(function () {
    if (window.AesCanopyRoleDetector) return

    // Equipment pattern groups. Match against the equipment STRING (not
    // typeId) because the equipment field is consistently populated by
    // content_fleetManagement.js whereas typeId is sometimes missing
    // until typeSpec is backfilled.
    const WIDEBODY_RE = /(?:^|[^0-9])(?:747|777|787|767|330|340|350|380|A300|A310|MD-?11|L-?10|DC-?10)(?:[^0-9]|$)/i
    const CARGO_RE    = /(?:F|Freighter|Cargo|BCF|P2F|PCF|SF)\s*$|Freighter|Cargo/i
    // Regional/turboprop/small-narrow patterns (ATR, Dash, EMB, CRJ, etc).
    const REGIONAL_RE = /^(?:ATR|Dash|DHC|Embraer|EMB|ERJ|E-?(?:1[0-9]{2}|7|9)|CRJ|Beechcraft|Saab|Q-?\d{3}|BAe|Beech|Jetstream)/i
    // Pure freighter type IDs we know about (for cases where equipment
    // string is opaque).
    const KNOWN_FREIGHTER_TOKENS = ["F", "BCF", "P2F", "PCF", "SF", "Freighter"]

    function _isWideBody(eq) {
        if (!eq) return false
        return WIDEBODY_RE.test(String(eq))
    }

    function _isCargo(eq) {
        if (!eq) return false
        const s = String(eq)
        // Endswith "F" is noisy (e.g. "747-400F" wins, but so would
        // "ATR-72F" hypothetically) — guard with KNOWN_FREIGHTER_TOKENS
        // word-boundary check.
        for (const tok of KNOWN_FREIGHTER_TOKENS) {
            if (new RegExp("(?:^|[^A-Za-z])" + tok + "(?:$|[^A-Za-z])").test(s)) return true
        }
        return /Freighter|Cargo/i.test(s)
    }

    function _isRegional(eq) {
        if (!eq) return false
        return REGIONAL_RE.test(String(eq))
    }

    /**
     * Pick the hub each aircraft is "based at." Falls back through
     * common TailRow / fleet-record fields. Returns null when nothing
     * resolves.
     */
    function _aircraftHub(a) {
        if (!a) return null
        return a.hubIata || a.hub || a.locIata || a.baseIata || null
    }

    function _equipmentOf(a) {
        if (!a) return ""
        return a.equipment || a.typeName || a.type || ""
    }

    /** Tally hub usage across the kin's aircraft. */
    function _hubBreakdown(aircraft) {
        const counts = new Map()
        for (const a of aircraft || []) {
            const h = _aircraftHub(a)
            if (!h) continue
            counts.set(h, (counts.get(h) || 0) + 1)
        }
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
        const total = aircraft.length || 0
        return {
            total,
            sorted, // [[iata, count], ...] desc
            primaryShare: total > 0 && sorted[0] ? sorted[0][1] / total : 0
        }
    }

    /** Equipment-class tally. */
    function _classBreakdown(aircraft) {
        let wide = 0, cargo = 0, regional = 0
        for (const a of aircraft || []) {
            const eq = _equipmentOf(a)
            if (_isCargo(eq))     cargo++
            else if (_isWideBody(eq)) wide++
            else if (_isRegional(eq)) regional++
        }
        const total = aircraft.length || 0
        return {
            total,
            wide,
            cargo,
            regional,
            wideShare:     total > 0 ? wide / total     : 0,
            cargoShare:    total > 0 ? cargo / total    : 0,
            regionalShare: total > 0 ? regional / total : 0
        }
    }

    function _pct(x) {
        return Math.round((Number(x) || 0) * 100)
    }

    /**
     * Run the detection. Returns the unclassified shape with confidence 0
     * when the kin has fewer than 2 known aircraft (signal too sparse).
     */
    function detectRole(input) {
        input = input || {}
        const aircraft = (input.fleetRec && Array.isArray(input.fleetRec.aircraft))
            ? input.fleetRec.aircraft
            : (Array.isArray(input.tails) ? input.tails : [])
        const total = aircraft.length

        if (total < 2) {
            return {
                role:           "unclassified",
                confidence:     0,
                signals:        [total === 0 ? "no fleet observed" : "fleet too small (1 tail)"],
                primaryHubs:    [],
                secondaryHubs:  []
            }
        }

        const hubs    = _hubBreakdown(aircraft)
        const classes = _classBreakdown(aircraft)

        const primaryHub = hubs.sorted[0] ? hubs.sorted[0][0] : null
        const primaryHubs   = primaryHub ? [primaryHub] : []
        const secondaryHubs = hubs.sorted.slice(1, 5).map(h => h[0])

        const signals = []

        // Cargo is the most distinctive — check first.
        if (classes.cargoShare >= 0.6) {
            signals.push(`cargo equipment ${_pct(classes.cargoShare)}% (${classes.cargo} of ${total} tails)`)
            return {
                role:          "cargo",
                confidence:    Math.min(1, classes.cargoShare + 0.1),
                signals,
                primaryHubs,
                secondaryHubs
            }
        }

        // Holding/lease — currently no fleet signal that distinguishes
        // this from cargo or operator (need the leasing portfolio from
        // sister-scraper). Defer to user override; emit unclassified
        // with a hint when cargo+operator signals are weak but fleet
        // exists.

        // Flag carrier — big wide-body share.
        if (classes.wideShare >= 0.5 && total >= 5) {
            signals.push(`wide-body share ${_pct(classes.wideShare)}% (${classes.wide} of ${total} tails)`)
            if (primaryHub) signals.push(`primary hub ${primaryHub} (${hubs.sorted[0][1]} of ${total} tails)`)
            return {
                role:          "flag-carrier",
                confidence:    Math.min(1, classes.wideShare + 0.15),
                signals,
                primaryHubs,
                secondaryHubs
            }
        }

        // Regional feeder — single-hub concentration with no/few wide-bodies.
        if (hubs.primaryShare >= 0.7 && classes.wideShare < 0.2 && total >= 3) {
            signals.push(`primary hub ${primaryHub} dominates (${_pct(hubs.primaryShare)}%)`)
            if (classes.regionalShare > 0) {
                signals.push(`regional equipment ${_pct(classes.regionalShare)}%`)
            }
            return {
                role:          "regional-feeder",
                confidence:    Math.min(1, hubs.primaryShare * 0.85),
                signals,
                primaryHubs,
                secondaryHubs
            }
        }

        // Low-cost — high regional/narrow share, point-to-point (low hub
        // concentration), no wide-bodies. Pricing-vs-market signal would
        // sharpen this in M0.1; absent for v1.
        if (classes.wideShare < 0.05 && classes.cargoShare < 0.05 &&
            hubs.primaryShare < 0.6 && total >= 4) {
            signals.push(`narrow-body fleet (no wide-bodies)`)
            signals.push(`distributed hubs (primary ${primaryHub || "n/a"} only ${_pct(hubs.primaryShare)}%)`)
            return {
                role:          "low-cost",
                confidence:    0.55,
                signals,
                primaryHubs,
                secondaryHubs
            }
        }

        // Charter / leisure — no reliable fleet signal alone. Defer to
        // user override; surface a hint instead.
        if (classes.wideShare > 0 && classes.wideShare < 0.4 && total >= 3) {
            signals.push(`mixed wide / narrow fleet (${_pct(classes.wideShare)}% wide)`)
            signals.push(`primary hub ${primaryHub} (${_pct(hubs.primaryShare)}%)`)
            return {
                role:          "unclassified",
                confidence:    0.3,
                signals:       ["mixed signals — set role manually"].concat(signals),
                primaryHubs,
                secondaryHubs
            }
        }

        // Default fallback.
        return {
            role:           "unclassified",
            confidence:     0.2,
            signals:        ["signals do not match a clear archetype"],
            primaryHubs,
            secondaryHubs
        }
    }

    /**
     * Convenience: detect every kin's role from a federated FleetCommandView.
     * Groups TailRow[] by accountId, runs detectRole per group, returns
     * a Map<accountId, detection>.
     */
    function detectAllFromFleetCommand(view) {
        const out = new Map()
        if (!view || !Array.isArray(view.tails)) return out
        const byAccount = new Map()
        for (const t of view.tails) {
            if (!t || !t.accountId) continue
            const list = byAccount.get(t.accountId) || []
            list.push(t)
            byAccount.set(t.accountId, list)
        }
        for (const [accountId, tails] of byAccount.entries()) {
            const detection = detectRole({tails})
            out.set(accountId, detection)
        }
        return out
    }

    window.AesCanopyRoleDetector = {
        detectRole,
        detectAllFromFleetCommand,
        // exposed for tests + future M slices
        _isWideBody,
        _isCargo,
        _isRegional
    }
})()
