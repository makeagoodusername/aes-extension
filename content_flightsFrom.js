"use strict"

/**
 * flightsfrom.com scraper — runs on www.flightsfrom.com/<IATA> pages.
 *
 * Entry URL from FlightsFromController.start():
 *   https://www.flightsfrom.com/<IATA>?aesFfTs=<ts>#aesFfScan=<scanId>|<IATA>
 *
 * flightsfrom.com renders routes client-side, so the scraper:
 *   1. Reads the hash → stores context in sessionStorage (in case of SPA nav)
 *   2. Waits for the routes list DOM to appear
 *   3. Scrolls the page to force lazy-loaded rows to render
 *   4. Extracts per-route fields via multiple selector fallbacks
 *   5. Writes the dataset to chrome.storage.local and closes the tab
 *
 * SELECTORS live at the top of this file and are the expected thing to tune
 * when flightsfrom.com changes their markup. If nothing matches, open DevTools
 * on the scrape tab — the script logs candidate containers + a diagnostic
 * fallback that searches by IATA-code text content.
 *
 * Without the hash or stored context, the script is a no-op.
 */

const AES_FF = {
    SELECTORS: {
        // Containers that hold the destination list. The first one that
        // returns >= 3 route-like children wins. flightsfrom.com renders the
        // destinations as `<ul class="uk-list uk-list-divider">` of
        // `<li class="ff-li-list">` rows.
        routesContainers: [
            "ul.uk-list.uk-list-divider",
            "[data-testid='routes-list']",
            "[data-testid='destinations']",
            ".routes-list",
            ".destinations",
            "#routes",
            "#destinations",
            "table.routes tbody",
            ".route-list",
            "main ul[class*='list']",
            "main [class*='destination']"
        ],
        // Row selectors (children of the container above).
        routeRows: [
            "li.ff-li-list",
            "[data-testid='route-row']",
            ".route-row",
            ".destination-row",
            "li.route",
            "tr.route",
            "a[href*='/route/']"
        ]
    },
    SESSION_KEY:     "aesFlightsFromCtx",
    WAIT_MS:         20000,
    MAX_LOAD_ROUNDS: 50,     // upper bound on scroll/click rounds; loop stops early on stability
    SCROLL_GAP_MS:   700
}

function log(...args) { console.log("AES flightsFrom:", ...args) }

;(async function aesFlightsFromMain() {
    const ctx = loadOrCaptureContext()
    if (!ctx) return

    log("entry", {iata: ctx.iata, scanId: ctx.scanId, url: location.href})

    try {
        await writeStatus(ctx, {status: "scanning", progress: {phase: "waiting-for-routes"}})
        const container = await waitForRoutesContainer()
        if (!container) throw new Error("Routes container not found — selectors in AES_FF.SELECTORS.routesContainers may need updating (open DevTools and inspect the list)")

        await writeStatus(ctx, {status: "scanning", progress: {phase: "scrolling"}})
        await loadAllRoutes()

        await writeStatus(ctx, {status: "scanning", progress: {phase: "scraping"}})
        const routes = extractRoutes(container, ctx.iata)
        const airportName = extractAirportName()

        if (!routes.length) throw new Error("No routes extracted — row selectors in AES_FF.SELECTORS.routeRows may need updating")

        await FlightsFromStore.saveAirport({
            iata: ctx.iata,
            airportName: airportName,
            routes: routes,
            source: "flightsfrom.com"
        })
        await writeStatus(ctx, {status: "ok", progress: {phase: "done", routeCount: routes.length}})
        log(`done — ${routes.length} routes saved for ${ctx.iata}`)
        cleanupAndClose()
    } catch (error) {
        console.error("AES flightsFrom error:", error)
        await writeStatus(ctx, {status: "error", error: (error && error.message) || String(error)})
        // Leave the tab open on error so the user can inspect what
        // flightsfrom.com actually rendered — closing it would lose the
        // diagnostic logs above. A red banner makes it obvious the tab
        // is intentionally still here.
        sessionStorage.removeItem(AES_FF.SESSION_KEY)
        showErrorBanner((error && error.message) || String(error))
    }
})()

function showErrorBanner(message) {
    const banner = document.createElement("div")
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;"
        + "background:#7f1d1d;color:#fff;padding:10px 16px;font:13px/1.4 sans-serif;"
        + "box-shadow:0 2px 8px rgba(0,0,0,.4);"
    banner.innerHTML = "<strong>AES flightsFrom: scrape failed.</strong> "
        + escapeHtml(message)
        + " &nbsp; <em>This tab was kept open so you can inspect the page and the DevTools console. Close it manually when you're done.</em>"
    document.body.append(banner)
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function loadOrCaptureContext() {
    const hash = window.location.hash || ""
    if (hash.indexOf("#aesFfScan=") === 0) {
        const parts = hash.substring("#aesFfScan=".length).split("|")
        if (parts.length >= 2) {
            const ctx = {
                scanId: parts[0],
                iata:   decodeURIComponent(parts[1] || "").toUpperCase()
            }
            sessionStorage.setItem(AES_FF.SESSION_KEY, JSON.stringify(ctx))
            history.replaceState(null, "", window.location.pathname + window.location.search)
            return ctx
        }
        return null
    }
    const stored = sessionStorage.getItem(AES_FF.SESSION_KEY)
    if (!stored) return null
    try { return JSON.parse(stored) }
    catch {
        sessionStorage.removeItem(AES_FF.SESSION_KEY)
        return null
    }
}

async function writeStatus(ctx, patch) {
    if (typeof FlightsFromStore === "undefined") return
    await FlightsFromStore.saveStatus(ctx.iata, Object.assign({scanId: ctx.scanId}, patch))
}

async function waitForRoutesContainer() {
    const deadline = Date.now() + AES_FF.WAIT_MS
    while (Date.now() < deadline) {
        for (const sel of AES_FF.SELECTORS.routesContainers) {
            const el = document.querySelector(sel)
            if (el && countRouteLikeChildren(el) >= 3) {
                log(`matched container: "${sel}" (${countRouteLikeChildren(el)} route-like children)`)
                return el
            }
        }
        await sleep(400)
    }
    // Diagnostic: emit the most-promising candidates to help the user tune.
    const candidates = []
    document.querySelectorAll("div, ul, table, section, main").forEach(el => {
        const score = countRouteLikeChildren(el)
        if (score >= 3) candidates.push({el: el, score: score})
    })
    candidates.sort((a, b) => b.score - a.score)
    if (candidates.length) {
        log("container selectors did not match, but these elements look route-like:", candidates.slice(0, 5).map(c => ({
            score: c.score,
            tag:   c.el.tagName,
            id:    c.el.id || null,
            cls:   c.el.className || null
        })))
        // Fall back to the best-scoring candidate so the scrape still produces output.
        return candidates[0].el
    }
    return null
}

function countRouteLikeChildren(el) {
    if (!el || !el.children) return 0
    let n = 0
    for (const c of el.children) {
        const text = (c.textContent || "").trim()
        if (!text) continue
        if (/\b[A-Z]{3}\b/.test(text)) n++
    }
    return n
}

/**
 * Exhaustively load every destination on the flightsfrom airport page.
 *
 * Popular hubs (JFK, LHR, ...) ship with ~30–40 visible rows by default and
 * hide the long tail behind a "Show more" / "Load more" control. Some
 * variants instead append rows on inner-container scroll (not body scroll).
 *
 * This loop runs four nudges per round and only stops when two consecutive
 * rounds make zero progress on any of them:
 *   1. dismiss any overlay popup ("Looking for more travel info?", cookie banner)
 *   2. scroll the inner routes container to its bottom
 *   3. scroll the window to its bottom
 *   4. click any visible "show/load/view/see more/all" control
 */
async function loadAllRoutes() {
    log("loading all routes (overlay-dismiss + inner+outer scroll + expand clicks)...")
    let lastRowCount = 0
    let lastHeight = 0
    let stableRounds = 0
    let totalClicks = 0
    let totalDismissed = 0

    for (let round = 0; round < AES_FF.MAX_LOAD_ROUNDS; round++) {
        if (dismissOverlay()) totalDismissed++

        const innerContainer = findRoutesScrollContainer()
        if (innerContainer) {
            innerContainer.scrollTop = innerContainer.scrollHeight
        }
        window.scrollTo(0, document.body.scrollHeight)
        await sleep(AES_FF.SCROLL_GAP_MS)

        const clicked = clickExpandButton()
        if (clicked) {
            totalClicks++
            await sleep(AES_FF.SCROLL_GAP_MS)
        }

        const currentRows = countLiveRouteRows()
        const currentHeight = document.body.scrollHeight
        const grew = currentRows > lastRowCount || currentHeight > lastHeight

        if (!grew && !clicked) {
            stableRounds++
            if (stableRounds >= 2) {
                log(`load: stable at ${currentRows} rows / ${currentHeight}px after ${round + 1} round(s), ${totalClicks} click(s), ${totalDismissed} dismiss(es)`)
                break
            }
        } else {
            stableRounds = 0
            lastRowCount = currentRows
            lastHeight = currentHeight
        }
    }
    log(`load done: ${countLiveRouteRows()} li.ff-li-list rows, ${totalClicks} expand-button click(s), ${totalDismissed} overlay dismiss(es)`)
    window.scrollTo(0, 0)
}

function countLiveRouteRows() {
    return document.querySelectorAll("li.ff-li-list").length
}

/**
 * The route list often lives inside a fixed-height scrollable div (e.g.
 * `<div style="overflow:auto; max-height:600px">`). Scrolling the window
 * doesn't trigger lazy-loading inside that container — we have to scroll
 * the container itself. This walks up from the first route row to find
 * the nearest ancestor whose scrollHeight exceeds its clientHeight, i.e.
 * the actual scroll viewport.
 */
function findRoutesScrollContainer() {
    const firstRow = document.querySelector("li.ff-li-list")
    if (!firstRow) return null
    let el = firstRow.parentElement
    while (el && el !== document.body) {
        const overflowY = (window.getComputedStyle(el).overflowY || "").toLowerCase()
        const scrollable = (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
                        && el.scrollHeight > el.clientHeight + 4
        if (scrollable) return el
        el = el.parentElement
    }
    return null
}

/**
 * flightsfrom shows a marketing overlay ("Looking for more travel info?") and
 * a cookie/consent banner that can intercept clicks on "Show more" or block
 * inner-container scroll. Dismiss anything that looks like a close/accept/no-thanks
 * button and any element whose role is `dialog` or class name screams overlay.
 * Returns true if something was dismissed this round.
 */
function dismissOverlay() {
    let dismissed = false
    // 1. Try explicit close/accept buttons.
    const closeSelectors = [
        "[aria-label='Close']",
        "[aria-label='close']",
        "button.close",
        ".uk-modal-close-default",
        ".uk-modal-close",
        ".uk-alert-close",
        "[class*='close-button']",
        "[class*='dismiss']",
        "[class*='cookie'] button",
        "[id*='cookie'] button",
        "[class*='consent'] button",
        "[class*='gdpr'] button"
    ]
    for (const sel of closeSelectors) {
        for (const el of document.querySelectorAll(sel)) {
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) continue
            try { el.click(); dismissed = true } catch (e) { /* keep looking */ }
        }
    }
    // 2. Text-based fallback for "no thanks" / "accept" / "got it".
    if (!dismissed) {
        for (const el of document.querySelectorAll("button, a[role='button'], [role='button']")) {
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) continue
            const t = (el.textContent || "").trim().toLowerCase()
            if (/^(no thanks|not now|maybe later|dismiss|got it|accept|i agree|close)$/.test(t)) {
                try { el.click(); dismissed = true; break } catch (e) {}
            }
        }
    }
    if (dismissed) log("dismissed an overlay/banner")
    return dismissed
}

/**
 * Find and click a single visible "show more"/"load more"/"view all"/"next"
 * style control. Returns true if something was clicked.
 *
 * Priority order:
 *   1. `.ff-show-all` — flightsfrom's canonical "Show all destinations" div
 *      on the airport routes page. Plain <div>, NOT a button/anchor, which
 *      was why earlier versions missed it and capped at the visible 40 rows.
 *   2. Text/class match on buttons + anchors + role='button' div elements,
 *      scoped to skip the right-side route-update box and the filter
 *      offcanvas (both have their own "Show more" controls we don't want).
 *   3. Pagination-next fallback for variants that paginate instead of
 *      lazy-loading.
 *
 * Diagnostic: when nothing matches but candidates exist, the first
 * non-matching candidate is logged so we can see what's near the routes
 * area and tune patterns next time.
 */
function clickExpandButton() {
    // Priority 1: ff-show-all — the actual control flightsfrom renders below
    // the destinations list when there are more than the default visible count.
    const showAll = document.querySelector(".ff-show-all")
    if (showAll) {
        const rect = showAll.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
            if (clickRobust(showAll)) {
                log(`expand click: .ff-show-all "${(showAll.textContent || "").trim().substring(0, 60)}"`)
                return true
            }
        }
    }

    // Priority 2: text + class matching on a wider net of clickable elements.
    // Includes <div> too — flightsfrom uses div.ff-show-all and similar.
    const candidates = document.querySelectorAll(
        "button, a[role='button'], [role='button'], a.uk-button, " +
        "[class*='show-more'], [class*='load-more'], [class*='view-all'], " +
        "[class*='showMore'], [class*='loadMore'], [class*='viewAll'], " +
        "[class*='see-more'], [class*='seeMore'], [class*='view-more'], [class*='viewMore'], " +
        "div.ff-show-all, div[class*='show-all'], div[class*='showAll']"
    )
    let firstSkipped = null
    for (const el of candidates) {
        if (isInUnrelatedSection(el)) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        if (el.disabled || el.getAttribute("aria-disabled") === "true") continue

        const text = (el.textContent || "").trim().toLowerCase()
        const cls  = String(el.className || "").toLowerCase()
        const matchesText  = /\b(show|load|view|see|display)\s+(more|all|other|additional|further)\b/.test(text)
                          || /\b(more|other)\s+(routes|destinations|flights)\b/.test(text)
                          || text === "more"
                          || text === "load more"
                          || text === "show more"
        const matchesClass = /show[-]?more|load[-]?more|view[-]?all|see[-]?more|view[-]?more|show[-]?all/.test(cls)

        if (matchesText || matchesClass) {
            if (clickRobust(el)) {
                log(`expand click: text="${text.substring(0, 60)}" class="${cls.substring(0, 60)}"`)
                return true
            }
        } else if (!firstSkipped && (text || cls)) {
            firstSkipped = {text: text.substring(0, 60), cls: cls.substring(0, 60)}
        }
    }

    // Priority 3: pagination-next fallback — some flightsfrom variants paginate.
    const nextLink = document.querySelector("a[rel='next'], .uk-pagination .uk-active + li a, [class*='pagination'] [class*='next']")
    if (nextLink && nextLink.getBoundingClientRect().width > 0) {
        if (clickRobust(nextLink)) {
            log("pagination-next click")
            return true
        }
    }

    if (firstSkipped) log("no expand button matched; nearest candidate:", firstSkipped)
    return false
}

/**
 * Skip "Show more" controls that belong to other sections of the page —
 * the right-side route-update box ("Show more (95 remaining)" — only
 * adds news entries, not destinations), the filter offcanvas drawers
 * (expand the airline / country / aircraft-type lists), and the FAQ.
 * Returns true when `el` is inside one of those.
 */
function isInUnrelatedSection(el) {
    if (!el || !el.closest) return false
    return !!el.closest(
        "#route-update, " +
        ".ff-mobile-filters, " +
        ".uk-offcanvas, " +
        ".uk-accordion, " +
        "#ff-filters, " +
        "#ff-sort"
    )
}

/**
 * Some click handlers listen for mousedown/mouseup rather than the synthetic
 * click event. Try the simple click first, fall back to a mouse-event sequence
 * before giving up.
 */
function clickRobust(el) {
    try {
        el.click()
        return true
    } catch (e) { /* ignore */ }
    try {
        const opts = {bubbles: true, cancelable: true, view: window}
        el.dispatchEvent(new MouseEvent("mousedown", opts))
        el.dispatchEvent(new MouseEvent("mouseup", opts))
        el.dispatchEvent(new MouseEvent("click", opts))
        return true
    } catch (e) {
        return false
    }
}

function extractRoutes(container, hubIata) {
    let rows = []
    let matchedSelector = null
    for (const sel of AES_FF.SELECTORS.routeRows) {
        const found = Array.from(container.querySelectorAll(sel))
        if (found.length >= 3) {
            rows = found
            matchedSelector = sel
            log(`matched rows: "${sel}" (${found.length} rows)`)
            break
        }
    }
    if (!rows.length) {
        rows = Array.from(container.children).filter(c => /\b[A-Z]{3}\b/.test((c.textContent || "")))
        log(`row-selector fallback: ${rows.length} direct children with IATA-code text`)
    }

    const out = []
    let rejectedHub = 0
    let rejectedEmpty = 0
    let firstRowHtmlLogged = false

    for (const row of rows) {
        const route = extractRoute(row, hubIata)
        if (!route) {
            rejectedEmpty++
            continue
        }
        if (route.destIata === hubIata) {
            // Sidebar / breadcrumb / "Routes from <hub>" headers all have the
            // hub IATA as the first 3-letter token; reject so they don't
            // pollute the dataset (which would map every row's demand to the
            // hub's own demand and look identical).
            rejectedHub++
            continue
        }
        // Require AT LEAST one piece of route data — frequency, seats,
        // distance, or an airline list. A row with just an IATA and nothing
        // else is almost certainly a navigation link, not a route entry.
        const hasData = route.weeklyFlights || route.seatsPerWeek || route.distanceKm
            || (route.airlines && route.airlines.length > 0)
        if (!hasData) {
            rejectedEmpty++
            if (!firstRowHtmlLogged) {
                console.warn("AES flightsFrom: rejecting empty route rows. First sample row HTML:", row.outerHTML)
                firstRowHtmlLogged = true
            }
            continue
        }
        out.push(route)
    }

    log(`extracted ${out.length} routes (rejected: ${rejectedHub} hub-IATA, ${rejectedEmpty} empty)`)
    if (out.length === 0 && rows.length > 0) {
        console.warn(`AES flightsFrom: no valid routes from ${rows.length} candidate rows. Selector "${matchedSelector || "fallback"}" likely matches the wrong elements. First 3 candidate rows:`,
            rows.slice(0, 3).map(r => r.outerHTML))
    }
    return out
}

function extractRoute(row, hubIata) {
    // flightsfrom.com layout: each <li class="ff-li-list"> contains a
    // .ff-row-name with `<a href="/JFK-LAX">LAX <strong>Los Angeles</strong></a>`,
    // a .ff-row-airline with the primary airline image + "+N" badge, and
    // a .ff-flights-daily span with text like "14-16 flights per day".
    // We try this path first, then fall back to generic selectors.

    let destIata = null
    let destName = null
    let detailHref = null

    const nameAnchor = row.querySelector(".ff-row-name a[href], a[href^='/']")
    if (nameAnchor) {
        const href = nameAnchor.getAttribute("href") || ""
        detailHref = href
        // /JFK-LAX style — pick the half that isn't the hub.
        const pair = href.match(/^\/([A-Z]{3})-([A-Z]{3})\b/)
        if (pair) {
            destIata = pair[1] === hubIata ? pair[2] : pair[1]
        } else {
            // /LAX style or /route/JFK-LAX — extract first IATA != hub.
            const single = href.match(/\/([A-Z]{3})(?:[/?#]|$)/g)
            if (single) {
                for (const s of single) {
                    const m = /([A-Z]{3})/.exec(s)
                    if (m && m[1] !== hubIata) { destIata = m[1]; break }
                }
            }
        }
        // Anchor text: "LAX <strong>Los Angeles</strong>"
        if (!destIata) {
            const m = /\b([A-Z]{3})\b/.exec(nameAnchor.textContent || "")
            if (m && m[1] !== hubIata) destIata = m[1]
        }
        const strong = nameAnchor.querySelector("strong")
        if (strong) destName = (strong.textContent || "").trim()
    }

    // Generic fallback — only kicks in if the flightsfrom selectors above
    // didn't yield anything (e.g. page redesign).
    if (!destIata) destIata = extractIataFromText((row.textContent || "").trim(), hubIata)
    if (!destIata) return null

    // Frequency: prefer the dedicated `.ff-flights-daily*` span, fall back to
    // any per-day / per-week phrase anywhere in the row text.
    const dailyEl = row.querySelector(".ff-flights-daily-desktop, .ff-flights-daily")
    let weeklyFlights = parseFlightFrequency(dailyEl ? (dailyEl.textContent || "") : null)
    if (!weeklyFlights) weeklyFlights = parseFlightFrequency((row.textContent || ""))

    // Airlines: primary from the airline image alt, additional count from the
    // "+N" badge. We store airlines as an array whose .length equals the
    // total airline count, so the Route Assistant's airlineCount column and
    // scoring still work via Array.isArray(r.airlines).
    let airlines = null
    const airlineImg = row.querySelector("img.ff-image-airline, [class*='airline'] img[alt]")
    const airlineBadge = row.querySelector(".flightsfrom-list-airline-ball, [class*='airline-ball']")
    if (airlineImg) {
        const primary = (airlineImg.getAttribute("alt") || airlineImg.getAttribute("title") || "").trim()
        let extra = 0
        if (airlineBadge) {
            const bm = /\+?(\d+)/.exec(airlineBadge.textContent || "")
            if (bm) extra = parseInt(bm[1], 10) || 0
        }
        airlines = [primary || "?"]
        for (let i = 0; i < extra; i++) airlines.push(null)
    }

    // Distance is not exposed on flightsfrom's listing page. Leave null —
    // the Route Assistant accepts unknown distance gracefully.
    const distanceKm = null

    return {
        destIata:       destIata,
        destName:       destName,
        weeklyFlights:  weeklyFlights,
        seatsPerWeek:   null,
        distanceKm:     distanceKm,
        airlines:       airlines,
        aircraft:       null,
        detailUrl:      detailHref ? absoluteUrl(detailHref) : null
    }
}

function firstText(root, selectors) {
    for (const sel of selectors) {
        const el = root.querySelector(sel)
        if (!el) continue
        const t = (el.textContent || "").trim()
        if (t) return t
    }
    return null
}

/**
 * Returns the first 3-uppercase-letter token in `text` that is NOT `skipIata`.
 */
function extractIataFromText(text, skipIata) {
    const re = /\b([A-Z]{3})\b/g
    let m
    while ((m = re.exec(text)) !== null) {
        if (m[1] !== skipIata) return m[1]
    }
    return null
}

/**
 * Parse a frequency expression into weekly flights.
 *   "14-16 flights per day"  → 16 * 7 = 112
 *   "14 flights per day"     → 14 * 7 =  98
 *   "14-16 flights per week" → 16
 *   "14 flights weekly"      → 14
 * For ranges we take the upper bound — it's the more useful "real-world
 * peak" signal when comparing routes.
 */
function parseFlightFrequency(text) {
    if (!text) return null
    const dailyRange = /(\d+)\s*[-–]\s*(\d+)\s*(?:x\s*)?(?:flights?|\/)?\s*(?:per\s+day|\/\s*day|daily|day)/i.exec(text)
    if (dailyRange) return parseInt(dailyRange[2], 10) * 7
    const daily = /(\d+)\s*(?:x\s*)?(?:flights?|\/)?\s*(?:per\s+day|\/\s*day|daily|day)/i.exec(text)
    if (daily) return parseInt(daily[1], 10) * 7
    const weeklyRange = /(\d+)\s*[-–]\s*(\d+)\s*(?:x\s*)?(?:flights?|\/)?\s*(?:per\s+week|\/\s*week|weekly|wk|week)/i.exec(text)
    if (weeklyRange) return parseInt(weeklyRange[2], 10)
    const weekly = /(\d+)\s*(?:x\s*)?(?:flights?|weekly|\/\s*week|per\s+week|wk)/i.exec(text)
    if (weekly) return parseInt(weekly[1], 10)
    return null
}

function extractAirportName() {
    const h1 = document.querySelector("h1")
    if (h1) {
        const t = (h1.textContent || "").trim()
        if (t) return t
    }
    const meta = document.querySelector("meta[property='og:title']")
    if (meta) {
        const t = (meta.getAttribute("content") || "").trim()
        if (t) return t
    }
    return null
}

function absoluteUrl(href) {
    if (!href) return null
    if (href.indexOf("http") === 0) return href
    const a = document.createElement("a")
    a.href = href
    return a.href
}

function cleanupAndClose() {
    sessionStorage.removeItem(AES_FF.SESSION_KEY)
    window.close()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
