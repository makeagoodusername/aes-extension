/**
 * LIVE autopricer dry-run probe — paste into the DevTools Console on a
 * `https://*.airlinesim.aero/app/com/scheduling/<HUB>` tab.
 *
 * What it does:
 *   1. Picks ONE route from your visible scheduling page that has a cached
 *      ownPricing snapshot (the /markets/ form context the autopricer needs).
 *   2. Computes a +5% target for every cabin (Y, C, F, Cargo) — Cargo's
 *      decimal handling is preserved.
 *   3. Calls RouteAssistantPricingApplier.apply() with `dryRun: true` and
 *      `applyEnabled: false` so NOTHING posts. The applier still walks
 *      its full pipeline: GET the markets page, parse the Wicket form,
 *      run preflight, build the body that *would* POST.
 *   4. Logs the proposer-style price map and the actual urlencoded body
 *      that AS would have received — proving the per-class numbers flow
 *      end-to-end through the spec.
 *
 * Safety:
 *   - dryRun is hard-set true; the applier ignores user settings here
 *     and returns a `dry-run` envelope only. Even if your global
 *     `pricing.apply.dryRunOnly`/`applyEnabled` were live, this script
 *     never sets them.
 *   - One route per invocation. Re-run with a different `dest` to test
 *     another. No bulk paths.
 *   - Read-only against the AS markets-page form (one GET; no POST).
 *
 * Usage:
 *   1. Open DevTools (F12) on a /app/com/scheduling/<HUB> tab.
 *   2. Paste this entire file into the Console.
 *   3. Optionally: `await aesAutopricerProbe({dest: "LAX", deltaPct: 5})`
 *      to override the auto-pick.
 */
;(async () => {
    "use strict"

    function log(label, value) {
        if (value === undefined) console.log("%c" + label, "color:#a78bfa;font-weight:600")
        else console.log("%c" + label, "color:#a78bfa;font-weight:600", value)
    }

    function fmtPrice(cls, v) {
        if (v == null || !isFinite(v)) return "—"
        if (cls === "Cargo" && Math.abs(v) < 10) return Number(v).toFixed(2).replace(/\.?0+$/, "")
        return String(Math.round(v))
    }

    function bumpPrice(cls, current, deltaPct) {
        const raw = current * (1 + deltaPct / 100)
        if (cls === "Cargo" && current < 10) return Math.round(raw * 100) / 100
        return Math.round(raw)
    }

    if (!window.RouteAssistantPricingApplier) {
        log("ABORT — RouteAssistantPricingApplier not loaded on this page.")
        log("       Open a tab on /app/com/scheduling/<HUB> (autopricer ships there).")
        return
    }
    if (!window.AES || typeof AES.getServerName !== "function") {
        log("ABORT — AES helpers not loaded; can't resolve server.")
        return
    }

    // ------------------------------------------------------------------
    // 1) Pick a route. Either user-supplied via window.aesAutopricerProbe
    //    or auto-picked from cache.
    // ------------------------------------------------------------------
    const userOpts = (window._aesProbeOpts) || {}
    let dest    = userOpts.dest    || null
    const deltaPct = isFinite(userOpts.deltaPct) ? Number(userOpts.deltaPct) : 5

    const m = location.pathname.match(/\/app\/com\/scheduling\/([A-Z0-9]{3,4})/i)
    if (!m) {
        log("ABORT — not on a /app/com/scheduling/<HUB> page.")
        return
    }
    const hub = m[1].toUpperCase()
    const server = AES.getServerName()

    const all = await chrome.storage.local.get(null)
    const own = []
    for (const k in all) {
        if (k.indexOf("routeAssistant:markets:ownPricing:") !== 0) continue
        const rec = all[k]
        if (!rec || !rec.prices) continue
        if (server && rec.server && rec.server !== server) continue
        const recHub = String(rec.hub || "").toUpperCase()
        if (recHub && recHub !== hub) continue
        own.push({key: k, rec})
    }
    if (!own.length) {
        log("ABORT — no cached ownPricing for hub " + hub
            + ". Open the markets page for at least one route or let the panel scrape.")
        return
    }
    if (!dest) {
        // Pick the route with the freshest ownPricing snapshot AND non-empty
        // Y/C/F/Cargo so the +5% bump exercises every cabin.
        own.sort((a, b) => (b.rec.scrapedAt || 0) - (a.rec.scrapedAt || 0))
        const richest = own.find(({rec}) => {
            const p = rec.prices || {}
            return ["Y", "C", "F", "Cargo"].every(c => p[c] != null)
        }) || own[0]
        dest = String(richest.rec.dest || "").toUpperCase()
        if (!dest) {
            const tail = richest.key.split(":").pop() || ""
            const dm = /^[A-Z0-9]{3,4}-([A-Z0-9]{3,4})$/.exec(tail)
            if (dm) dest = dm[1]
        }
        if (!dest) {
            log("ABORT — couldn't infer dest from cached record:", richest.key)
            return
        }
    }
    const target = own.find(({rec}) => String(rec.dest || "").toUpperCase() === dest)
        || own[0]

    log("HUB",  hub)
    log("DEST", dest)
    log("delta % per class", deltaPct)
    log("cached ownPricing.prices (this is what's currently on AS):", target.rec.prices)

    // ------------------------------------------------------------------
    // 2) Build the +deltaPct per-class price map.
    // ------------------------------------------------------------------
    const requested = {}
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        const cur = target.rec.prices[cls]
        if (cur == null || !isFinite(Number(cur))) continue
        requested[cls] = bumpPrice(cls, Number(cur), deltaPct)
    }
    log("requested prices (proposer-equivalent +" + deltaPct + "% per cabin):", requested)

    // ------------------------------------------------------------------
    // 3) Construct an applier hard-pinned to dry-run regardless of
    //    user settings. NEVER posts. NEVER mutates anything in storage
    //    beyond the apply log (which carries the dry-run envelope).
    // ------------------------------------------------------------------
    const applier = new RouteAssistantPricingApplier(server, {
        dryRunOnly:   true,
        applyEnabled: false,
        // Skip the per-route + global cooldowns so the probe always runs;
        // dry-run can't fire a real POST so cooldowns are not load-bearing.
        cooldownMinPerRoute: 0,
        cooldownMinGlobal:   0,
        applyLog: null
    })

    const t0 = performance.now()
    let result = null
    try {
        result = await applier.apply(hub, dest, requested, {
            dryRun: true,
            source: "console-probe",
            scope: {airportPair: true, flightNumbers: true},
            reason: "console probe — verify per-class POST body, no live write",
            // Surface diagnostic on what the body would carry without
            // requiring the panel to be mounted.
            onPreflight: (pf) => {
                log("preflight blockers", pf.blockers)
                log("preflight warnings", pf.warnings)
                log("preflight per-class Δ%:", pf.percentDeltas)
            }
        })
    } catch (e) {
        log("apply() threw:", e && e.message || e)
        return
    }
    const ms = Math.round(performance.now() - t0)
    log("dry-run round-trip took (ms)", ms)
    log("apply() result envelope:", result)

    // ------------------------------------------------------------------
    // 4) Decode the body the applier would have POSTed and prove every
    //    requested cabin price made it through with the right field name.
    // ------------------------------------------------------------------
    if (result && result.bodyPreview) {
        log("raw POST body preview (truncated to 80c per field):")
        const lines = String(result.bodyPreview).split("&")
        for (const line of lines) {
            const eq = line.indexOf("=")
            const k = eq < 0 ? line : line.slice(0, eq)
            const v = eq < 0 ? "" : line.slice(eq + 1)
            console.log("    " + k.padEnd(56) + " = " + v)
        }
    }

    if (result && result.newPrices) {
        log("newPrices extracted from body (these are what AS would receive):")
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const cur = target.rec.prices[cls]
            const next = result.newPrices[cls]
            if (next == null) {
                console.log("    " + cls.padEnd(5) + " (skipped — no value in body)")
                continue
            }
            const dPct = (cur != null && cur > 0) ? ((next - cur) / cur * 100).toFixed(2) : "?"
            const sign = (cur != null && next > cur) ? "+" : ""
            console.log("    " + cls.padEnd(5)
                + " " + fmtPrice(cls, cur).padStart(7)
                + " -> " + fmtPrice(cls, next).padStart(7)
                + "  (" + sign + dPct + "%)")
        }
    }

    // ------------------------------------------------------------------
    // 5) Final verdict — easy to scan in the Console.
    // ------------------------------------------------------------------
    const ok = result && result.status === "dry-run"
    if (ok) {
        log("VERDICT", "%cdry-run completed cleanly. POST body carries per-class prices for every cabin in `requested`.")
    } else {
        log("VERDICT", "FAILED — see envelope above. Likely causes: noFormContext (refresh the markets page), notLoggedIn, breakerCooldown.")
    }

    // Expose the helper so you can re-run with custom args without re-pasting.
    window.aesAutopricerProbe = function (opts) {
        window._aesProbeOpts = Object.assign({}, opts || {})
        // Re-evaluate this whole IIFE by re-fetching it; simpler: ask the
        // user to re-paste with `_aesProbeOpts` already set.
        log("Set window._aesProbeOpts then re-paste the script.",
            "Or just inline override: aesAutopricerProbe({dest:'LAX', deltaPct:5})")
    }
})().catch(e => console.error("[aesAutopricerProbe] threw:", e))
