/**
 * Per-model overview cards. Groups the visible (filtered) offers by
 * `aircraftType` and renders one card per model with at-a-glance stats:
 * count, best deal class, best & median $/seat, median age + condition,
 * spec snapshot (seats / range), lease range when relevant, and a
 * fits-fleet flag.
 *
 * Cards are click-targets that toggle the model into the panel's scope
 * `types` set so the user can drill the next scan (or the visible filter)
 * to that model with one click.
 *
 * Pure rendering — no internal state. Caller passes the filtered row set,
 * the scope `types` set (so the active model is highlighted), and an
 * `onTypeToggle(type)` callback.
 */
class MarketPanelModelOverview {
    static MAX_CARDS = 24

    static render(host, rows, scopeTypes, leaseConfig, cb, watchSet, cashCtx, intentCtx) {
        host.innerHTML = ""
        host.style.cssText = [
            "padding:10px 12px",
            "background:var(--aes-bone)",
            "border-bottom:1px solid var(--aes-paper-rule)"
        ].join(";")

        const heading = document.createElement("div")
        heading.style.cssText = [
            "display:flex", "align-items:baseline", "gap:8px",
            "margin-bottom:8px"
        ].join(";")
        const h = document.createElement("span")
        h.textContent = "Models in scan"
        h.style.cssText = [
            "font:9px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase",
            "color:var(--aes-slate)"
        ].join(";")
        heading.append(h)

        const groups = MarketPanelModelOverview._group(rows, leaseConfig)
        const sub = document.createElement("span")
        sub.style.cssText = "font-size:11px;color:var(--aes-slate);font-style:italic;"
        sub.textContent = groups.length
            ? groups.length + " model" + (groups.length === 1 ? "" : "s")
                + " · click to pin to scope"
            : "Run a scan to see ranked models here."
        heading.append(sub)
        host.append(heading)

        if (!groups.length) return

        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(auto-fill, minmax(220px, 1fr))",
            "gap:8px"
        ].join(";")
        host.append(grid)

        const limit = Math.min(groups.length, MarketPanelModelOverview.MAX_CARDS)
        for (let i = 0; i < limit; i++) {
            grid.append(MarketPanelModelOverview._card(groups[i], scopeTypes, cb, watchSet, cashCtx, intentCtx))
        }
        if (groups.length > limit) {
            const more = document.createElement("div")
            more.textContent = "+ " + (groups.length - limit) + " more"
            more.style.cssText = [
                "grid-column:1/-1",
                "text-align:center",
                "padding:6px",
                "font-size:11px",
                "color:var(--aes-slate)",
                "font-style:italic"
            ].join(";")
            grid.append(more)
        }
    }

    static _card(group, scopeTypes, cb, watchSet, cashCtx, intentCtx) {
        const isPinned = !!(scopeTypes && scopeTypes.has(group.type))
        const isWatched = !!(watchSet && watchSet.has(group.type))
        const el = document.createElement("button")
        el.type = "button"
        el.style.cssText = [
            "all:unset",
            "padding:8px 10px",
            "background:" + (isPinned ? "var(--aes-bone-3)" : "var(--aes-bone-2)"),
            "border-left:4px solid " + (group.bestColor || "var(--aes-slate)"),
            "border-top:1px solid var(--aes-paper-rule)",
            "border-right:1px solid var(--aes-paper-rule)",
            "border-bottom:1px solid var(--aes-paper-rule)",
            "display:flex",
            "flex-direction:column",
            "gap:4px",
            "cursor:pointer",
            "box-sizing:border-box"
        ].join(";")
        if (isPinned) el.style.outline = "2px solid var(--aes-rust)"
        el.title = (isPinned
            ? "Pinned in scope — click to remove from scope"
            : "Click to pin this model in the scan scope")
            + "\n" + group.count + " offer" + (group.count === 1 ? "" : "s")

        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;"

        if (group.bestLabel) {
            const badge = document.createElement("span")
            badge.textContent = group.bestLabel
            badge.style.cssText = [
                "padding:1px 5px",
                "font:9px/1 var(--aes-font-display)",
                "font-weight:var(--aes-fw-bold)",
                "letter-spacing:var(--aes-tracking-caps)",
                "text-transform:uppercase",
                "background:" + (group.bestColor || "var(--aes-slate)"),
                "color:#fff"
            ].join(";")
            top.append(badge)
        }

        const title = document.createElement("strong")
        title.textContent = group.type
        title.style.cssText = "font-size:12px;color:var(--aes-oxide);flex:1 1 auto;"
        top.append(title)

        const count = document.createElement("span")
        count.textContent = "×" + group.count
        count.style.cssText = [
            "font-family:var(--aes-font-mono)",
            "font-weight:var(--aes-fw-bold)",
            "font-size:12px",
            "color:var(--aes-oxide-2)"
        ].join(";")
        top.append(count)
        el.append(top)

        const fam = document.createElement("div")
        fam.textContent = (group.familyName || "Unknown family")
            + (group.fleetOwned ? " · in fleet" : "")
        fam.style.cssText = "font-size:10px;color:var(--aes-slate);"
        el.append(fam)

        const stats = document.createElement("div")
        stats.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(2, 1fr)",
            "gap:2px 8px",
            "font:11px var(--aes-font-mono)",
            "letter-spacing:var(--aes-tracking-mono)",
            "color:var(--aes-oxide-2)"
        ].join(";")
        const fmtMoney = v => v === null ? "—" : Math.round(v).toLocaleString()
        const fmtPct   = v => v === null ? "—" : Math.round(v) + "%"
        const fmtAge   = v => v === null ? "—" : MarketPanelModelOverview._fmtAge(v)
        const fmtNum   = v => v === null ? "—" : Math.round(v).toLocaleString()
        const seatsLabel = group.seats === null ? "—" : (group.seats + " seats")
        const rangeLabel = group.range === null ? "—" : (fmtNum(group.range) + " km")
        const ppsSuffix  = group.priceBasis === "lease" ? "/seat·mo" : "/seat"
        stats.append(
            MarketPanelModelOverview._stat("Best score",
                group.bestScore === null ? "—" : String(group.bestScore)),
            MarketPanelModelOverview._stat("Med " + ppsSuffix.replace(/^\//, ""),
                fmtMoney(group.medianPps)),
            MarketPanelModelOverview._stat("Best $/seat", fmtMoney(group.bestPps)),
            MarketPanelModelOverview._stat("Median age", fmtAge(group.medianAge)),
            MarketPanelModelOverview._stat("Cond.", fmtPct(group.medianCondition)),
            MarketPanelModelOverview._stat("Spec", seatsLabel + " · " + rangeLabel)
        )
        if (group.leaseLow !== null && group.leaseHigh !== null) {
            stats.append(MarketPanelModelOverview._stat("Lease range",
                "AS$ " + fmtMoney(group.leaseLow) + "–" + fmtMoney(group.leaseHigh) + "/mo"))
        }
        if (group.expiringSoon) {
            stats.append(MarketPanelModelOverview._stat("Closing soon",
                group.expiringSoon + " offer" + (group.expiringSoon === 1 ? "" : "s")))
        }
        if (group.medianAffordFraction !== null) {
            const pct = Math.round(group.medianAffordFraction * 100)
            const tooltip = MarketPanelModelOverview._cashTooltip(cashCtx)
            stats.append(MarketPanelModelOverview._stat("Cost",
                pct + "% of cash", tooltip))
        }
        if (group.ownedCount) {
            const ownedAge = group.ownedAvgAge !== null
                ? MarketPanelModelOverview._fmtAge(group.ownedAvgAge)
                : "?y"
            let delta = ""
            if (group.medianAge !== null && group.ownedAvgAge !== null) {
                const diff = group.medianAge - group.ownedAvgAge
                if (Math.abs(diff) >= 0.5) {
                    delta = diff < 0 ? " · younger than fleet" : " · older than fleet"
                }
            }
            stats.append(MarketPanelModelOverview._stat("Fleet",
                group.ownedCount + " owned · " + ownedAge + delta))
        }
        const intent = MarketPanelModelOverview._eyedSummary(group, intentCtx)
        if (intent) {
            stats.append(MarketPanelModelOverview._stat("Eyed", intent.label, intent.tooltip))
        }
        el.append(stats)

        // Action row — buttons stop propagation so they don't trigger the
        // parent card's pin-to-scope click. Hover-revealed to keep the card
        // tidy when at rest; visible on focus for keyboard nav.
        const actions = document.createElement("div")
        actions.style.cssText = [
            "display:flex", "gap:6px", "align-items:center",
            "padding-top:4px", "margin-top:2px",
            "border-top:1px dashed var(--aes-paper-rule)",
            "font:10px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase"
        ].join(";")

        const watchBtn = MarketPanelModelOverview._actionBtn(
            isWatched ? "★ Watching" : "☆ Watch",
            isWatched
                ? "Stop watching this model — you won't get STEAL alerts for it"
                : "Watch this model — get a notification when a STEAL appears",
            isWatched
        )
        watchBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            if (typeof cb.onWatchToggle === "function") cb.onWatchToggle(group.type)
        })
        actions.append(watchBtn)

        if (group.bestRow && group.bestRow.offerUrl) {
            const open = MarketPanelModelOverview._actionBtn(
                "Open best ↗",
                "Open the highest-scoring offer of this model in a new tab — use Place Bid there",
                false
            )
            open.addEventListener("click", (e) => {
                e.stopPropagation()
                // Stamp bid intent so the next scan can tell the user
                // "the offer you eyed is gone" / "got cheaper". Best-effort —
                // a storage failure must not block opening the offer page.
                if (intentCtx && intentCtx.server
                    && typeof BidIntentStore !== "undefined") {
                    BidIntentStore.recordOpen(intentCtx.server, group.bestRow)
                        .catch(() => {})
                }
                window.open(group.bestRow.offerUrl, "_blank", "noopener")
            })
            actions.append(open)
        }

        const strategy = MarketPanelModelOverview._actionBtn(
            "→ Strategy",
            "Open the Strategy panel for fleet/route ROI context",
            false
        )
        strategy.addEventListener("click", (e) => {
            e.stopPropagation()
            if (typeof cb.onSendToStrategy === "function") {
                cb.onSendToStrategy(group)
            }
        })
        actions.append(strategy)

        el.append(actions)

        if (typeof cb.onTypeToggle === "function") {
            el.addEventListener("click", () => cb.onTypeToggle(group.type))
        }
        return el
    }

    static _actionBtn(label, tooltip, active) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.title = tooltip || ""
        b.style.cssText = [
            "all:unset",
            "padding:2px 6px",
            "border:1px solid var(--aes-paper-rule)",
            "background:" + (active ? "var(--aes-rust)" : "transparent"),
            "color:" + (active ? "#fff" : "var(--aes-oxide-2)"),
            "cursor:pointer",
            "font:inherit",
            "letter-spacing:var(--aes-tracking-caps)"
        ].join(";")
        b.addEventListener("mouseenter", () => {
            if (!active) b.style.background = "var(--aes-bone-3)"
        })
        b.addEventListener("mouseleave", () => {
            if (!active) b.style.background = "transparent"
        })
        return b
    }

    static _stat(label, value, tooltip) {
        const wrap = document.createElement("span")
        wrap.style.cssText = "display:flex;justify-content:space-between;gap:6px;"
        if (tooltip) wrap.title = tooltip
        const k = document.createElement("span")
        k.textContent = label
        k.style.cssText = "color:var(--aes-slate);font-size:10px;"
        const v = document.createElement("span")
        v.textContent = value
        v.style.cssText = "color:var(--aes-oxide);"
        wrap.append(k, v)
        return wrap
    }

    /**
     * Tooltip explaining where the cash figure came from. Keeps the user
     * honest about freshness — a navbar live read is just-now; a snapshot
     * fallback may be days behind, so we say so explicitly.
     */
    static _cashTooltip(cashCtx) {
        if (!cashCtx) return "Affordability unknown — open /app/finance to seed a cash snapshot."
        const cashStr = isFinite(cashCtx.cash)
            ? Intl.NumberFormat().format(Math.round(cashCtx.cash)) + " AS$"
            : "—"
        if (cashCtx.source === "live") {
            return "Cash on hand: " + cashStr + " (live from the AS navbar)."
        }
        const ago = cashCtx.scrapedAt
            ? MarketPanelModelOverview._fmtAgo(Date.now() - cashCtx.scrapedAt)
            : null
        return "Cash on hand: " + cashStr + " (accounting snapshot"
            + (ago ? ", " + ago + " old" : "")
            + " — visit /app/finance to refresh)."
    }

    static _fmtAgo(ms) {
        const m = Math.max(0, Math.round(ms / 60000))
        if (m < 60)   return m + " min"
        if (m < 1440) return Math.round(m / 60) + " h"
        return Math.round(m / 1440) + " d"
    }

    /**
     * "Eyed N · last opened 2d ago" badge data when the user has clicked
     * Open-best on one or more rows of this model previously. Returns
     * `null` when nothing is eyed so the caller skips the row entirely.
     */
    static _eyedSummary(group, intentCtx) {
        if (!intentCtx || !intentCtx.intentByKey || !intentCtx.intentByKey.size) return null
        if (!Array.isArray(group.rowKeys) || !group.rowKeys.length) return null
        let count = 0
        let mostRecent = 0
        const regs = []
        for (const k of group.rowKeys) {
            const rec = intentCtx.intentByKey.get(k)
            if (!rec) continue
            count++
            if ((rec.lastOpenedAt || 0) > mostRecent) mostRecent = rec.lastOpenedAt || 0
            if (rec.registration) regs.push(rec.registration)
        }
        if (!count) return null
        const ago = mostRecent
            ? MarketPanelModelOverview._fmtAgo(Date.now() - mostRecent)
            : "—"
        return {
            label:   count + " · " + ago + " ago",
            tooltip: regs.length
                ? "Previously opened: " + regs.slice(0, 6).join(", ")
                    + (regs.length > 6 ? ", …" : "")
                : "You've opened " + count + " offer" + (count === 1 ? "" : "s") + " of this model."
        }
    }

    static _fmtAge(years) {
        const y = Math.floor(years)
        const m = Math.round((years - y) * 12)
        if (y === 0 && m === 0) return "<1mo"
        if (y === 0) return m + "mo"
        if (m === 0) return y + "y"
        return y + "y " + m + "mo"
    }

    /**
     * Group rows by aircraftType and reduce each group to a single card's
     * worth of stats. Pure — no input mutation. Sorts by best score desc
     * so the most attractive models surface first.
     */
    static _group(rows, leaseConfig) {
        const byType = new Map()
        for (const r of rows || []) {
            if (!r || !r.aircraftType) continue
            let g = byType.get(r.aircraftType)
            if (!g) {
                g = {
                    type:           r.aircraftType,
                    familyName:     r.familyName || "",
                    familyCategory: r.familyCategory || "",
                    bestColor:      null,
                    bestLabel:      null,
                    bestScore:      null,
                    bestRow:        null,
                    bestPps:        null,
                    fleetOwned:     false,
                    expiringSoon:   0,
                    priceBasis:     "purchase",
                    _pps:           [],
                    _age:           [],
                    _cond:          [],
                    _seats:         [],
                    _range:         [],
                    _lease:         [],
                    _afford:        [],
                    _keys:          [],
                    ownedCount:     0,
                    ownedAvgAge:    null
                }
                byType.set(r.aircraftType, g)
            }
            // Capture each row's intent key so the card can match against
            // the bid-intent store without re-deriving the dedup triple.
            const rowKey = (r.typeId || r.aircraftType || "?")
                + "|" + (r.registration || "?")
                + "|" + (r.owner || "?")
            g._keys.push(rowKey)
            g.count = (g.count || 0) + 1
            const score = MarketPanelModelOverview._numOrNull(r.dealScore)
            if (score !== null && (g.bestScore === null || score > g.bestScore)) {
                g.bestScore = score
                g.bestRow   = r
                g.bestColor = r.dealColor || g.bestColor
                g.bestLabel = r.dealLabel || r.dealClass || g.bestLabel
            }
            const pps = MarketPanelModelOverview._numOrNull(r.pricePerSeat)
            if (pps !== null) {
                g._pps.push(pps)
                if (g.bestPps === null || pps < g.bestPps) g.bestPps = pps
            }
            const age = MarketPanelModelOverview._numOrNull(r.ageYears)
            if (age !== null) g._age.push(age)
            const cond = MarketPanelModelOverview._numOrNull(r.conditionPct)
            if (cond !== null) g._cond.push(cond)
            const seats = MarketPanelModelOverview._numOrNull(r.seats)
            if (seats !== null) g._seats.push(seats)
            const rng = MarketPanelModelOverview._numOrNull(r.range)
            if (rng !== null) g._range.push(rng)
            let lease = MarketPanelModelOverview._numOrNull(r.monthlyLease)
            if (lease === null) lease = MarketPanelModelOverview._numOrNull(r.leasingRate)
            if (lease !== null) g._lease.push(lease)
            if (r.fleetOwned) g.fleetOwned = true
            if (r.priceBasis === "lease") g.priceBasis = "lease"
            const bidMs = MarketPanelModelOverview._numOrNull(r.bidIntervalMs)
            if (bidMs !== null && bidMs >= 0 && bidMs < 6 * 60 * 60 * 1000) {
                g.expiringSoon++
            }
            const af = MarketPanelModelOverview._numOrNull(r.affordFraction)
            if (af !== null) g._afford.push(af)
            // ownedCount/ownedAvgAge are decorated per-row but identical
            // across rows of the same model — last-write-wins is fine.
            if (typeof r.ownedCount === "number" && r.ownedCount > 0) {
                g.ownedCount  = r.ownedCount
                g.ownedAvgAge = (typeof r.ownedAvgAge === "number") ? r.ownedAvgAge : null
            }
        }
        const out = []
        for (const g of byType.values()) {
            g.medianPps       = MarketPanelModelOverview._median(g._pps)
            g.medianAge       = MarketPanelModelOverview._median(g._age)
            g.medianCondition = MarketPanelModelOverview._median(g._cond)
            g.seats           = MarketPanelModelOverview._median(g._seats)
            g.range           = MarketPanelModelOverview._median(g._range)
            g.leaseLow        = g._lease.length ? Math.min(...g._lease) : null
            g.leaseHigh       = g._lease.length ? Math.max(...g._lease) : null
            g.medianAffordFraction = MarketPanelModelOverview._median(g._afford)
            g.rowKeys              = g._keys.slice()
            delete g._pps; delete g._age; delete g._cond
            delete g._seats; delete g._range; delete g._lease
            delete g._afford; delete g._keys
            out.push(g)
        }
        out.sort((a, b) => {
            const sa = a.bestScore === null ? -Infinity : a.bestScore
            const sb = b.bestScore === null ? -Infinity : b.bestScore
            if (sa !== sb) return sb - sa
            return (b.count || 0) - (a.count || 0)
        })
        return out
    }

    static _numOrNull(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    static _median(arr) {
        if (!arr || !arr.length) return null
        const sorted = arr.slice().sort((a, b) => a - b)
        return sorted[Math.floor(sorted.length / 2)]
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelModelOverview
