"use strict"

/**
 * Used aircraft market scanner — child tab worker.
 *
 * Two entry URLs the dashboard / results table hand off to this script:
 *
 *   SCAN mode — spawned by ScanController:
 *     https://<srv>.airlinesim.aero/app/aircraft/market?aesScanTs=<ts>#aesScan=<scanId>|<type>|<family>|<idx>
 *     Sets filters, iterates variants + pages, writes aggregated rows, closes.
 *
 *   GOTO mode — the "Open offer" link in the scan results table:
 *     https://<srv>.airlinesim.aero/app/aircraft/market#aesGoto=<type>|<family>[|<reg>]
 *     Sets the same filters, then stops; optionally scrolls to + highlights
 *     the row whose registration matches. AirlineSim has no per-offer URL
 *     (the market is Wicket-stateful), so this is how we reproduce the view.
 *
 * AirlineSim's market page uses Wicket: changing the Family or Type <select>
 * causes a full-page navigation (window.location.href = ...), and the offers
 * list is paginated (div.navigator with next/last links). So the hash is only
 * the one-shot hand-off — from then on, state lives in sessionStorage and
 * this script re-enters on each navigation:
 *
 *   phase 1: family not set  → set family, page navigates
 *   phase 2: type not set    → set type, page navigates
 *   phase 3 (scan):  scrape offers, accumulate, click "next" / advance variant
 *   phase 3 (goto):  done — clear context; highlight reg if provided
 *
 * Without a hash or stored context, this script is a no-op so a regular user
 * visit is unaffected. Every phase transition logs to the tab's DevTools
 * console with an "AES marketScan:" prefix.
 */

const AES_MARKETSCAN = {
    SELECTORS: {
        familySelect:    "select[name='tab:panel:filter-aircraftFamily']",
        typeSelect:      "select[name='tab:panel:filter-aircraftType']",
        offersContainer: "div.offers",
        offerItem:       "div.offers > div.even, div.offers > div.odd",
        nextPageLink:    "div.navigator a.next[href]:not([disabled])"
    },
    SESSION_KEY:       "aesMarketScanCtx",
    STEP_TIMEOUT_MS:   15000,
    SCRAPE_TIMEOUT_MS:  8000,
    MAX_FILTER_ATTEMPTS: 3,
    MAX_PAGES:          50
}

function log(...args) { console.log("AES marketScan:", ...args) }

;(async function aesMarketScanMain() {
    const ctx = loadOrCaptureContext()
    if (!ctx) return

    log("entry", {mode: ctx.mode, type: ctx.type, family: ctx.family, page: ctx.page || 1, url: location.href})

    try {
        if (ctx.mode === "goto") {
            await gotoOffer(ctx)
        } else {
            await advance(ctx)
        }
    } catch (error) {
        console.error("AES marketScan error:", error)
        if (ctx.mode === "goto") {
            sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
        } else {
            await finishWithError(ctx, (error && error.message) || String(error))
        }
    }
})()

function loadOrCaptureContext() {
    const hash = window.location.hash || ""
    if (hash.indexOf("#aesScan=") === 0) {
        const parts = hash.substring("#aesScan=".length).split("|")
        if (parts.length >= 4) {
            const ctx = {
                mode:            "scan",
                scanId:          parts[0],
                type:            decodeURIComponent(parts[1] || ""),
                family:          decodeURIComponent(parts[2] || ""),
                idx:             parseInt(parts[3], 10) || 0,
                server:          window.location.hostname.split(".")[0],
                familyAttempts:  0,
                typeAttempts:    0,
                page:            1,
                rows:            []
            }
            saveCtx(ctx)
            history.replaceState(null, "", window.location.pathname + window.location.search)
            return ctx
        }
        return null
    }
    if (hash.indexOf("#aesGoto=") === 0) {
        const parts = hash.substring("#aesGoto=".length).split("|")
        if (parts.length >= 2) {
            const ctx = {
                mode:            "goto",
                type:            decodeURIComponent(parts[0] || ""),
                family:          decodeURIComponent(parts[1] || ""),
                registration:    decodeURIComponent(parts[2] || ""),
                server:          window.location.hostname.split(".")[0],
                familyAttempts:  0,
                typeAttempts:    0
            }
            saveCtx(ctx)
            history.replaceState(null, "", window.location.pathname + window.location.search)
            return ctx
        }
        return null
    }
    const stored = sessionStorage.getItem(AES_MARKETSCAN.SESSION_KEY)
    if (!stored) return null
    try { return JSON.parse(stored) }
    catch {
        sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
        return null
    }
}

function saveCtx(ctx) {
    sessionStorage.setItem(AES_MARKETSCAN.SESSION_KEY, JSON.stringify(ctx))
}

/**
 * "Go to offer" flow — the scanner listing writes market URLs with
 * `#aesGoto=<type>|<family>[|<reg>]`. AirlineSim has no per-offer detail URL,
 * so the best we can do is re-open the market page, drive its family/type
 * <select>s to reproduce the filtered view, then walk the paginated offers
 * until we land on the row whose registration matches. Registration-search
 * pages are necessary because the scan-results table rank order isn't the
 * same as the market's default sort — anything past the first page of the
 * filtered listing needs "next" clicks to reach.
 */
async function gotoOffer(ctx) {
    const familyEl = await waitForElement(AES_MARKETSCAN.SELECTORS.familySelect, AES_MARKETSCAN.STEP_TIMEOUT_MS)
    if (!familyEl) throw new Error("Family filter not found on page")

    if (selectedLabel(familyEl) !== ctx.family) {
        ctx.familyAttempts = (ctx.familyAttempts || 0) + 1
        if (ctx.familyAttempts > AES_MARKETSCAN.MAX_FILTER_ATTEMPTS) {
            throw new Error(`Family filter did not stick after ${AES_MARKETSCAN.MAX_FILTER_ATTEMPTS} attempts (target "${ctx.family}")`)
        }
        log(`goto phase 1: setting family "${ctx.family}" (attempt ${ctx.familyAttempts})`)
        saveCtx(ctx)
        await waitForOption(familyEl, ctx.family, AES_MARKETSCAN.STEP_TIMEOUT_MS)
        await setSelectByLabel(familyEl, ctx.family)
        return
    }

    const typeEl = await waitForElement(AES_MARKETSCAN.SELECTORS.typeSelect, AES_MARKETSCAN.STEP_TIMEOUT_MS)
    if (!typeEl) throw new Error("Type filter not found after family navigation")

    if (selectedLabel(typeEl) !== ctx.type) {
        ctx.typeAttempts = (ctx.typeAttempts || 0) + 1
        if (ctx.typeAttempts > AES_MARKETSCAN.MAX_FILTER_ATTEMPTS) {
            throw new Error(`Type filter did not stick after ${AES_MARKETSCAN.MAX_FILTER_ATTEMPTS} attempts (target "${ctx.type}")`)
        }
        log(`goto phase 2: setting type "${ctx.type}" (attempt ${ctx.typeAttempts})`)
        saveCtx(ctx)
        await waitForOption(typeEl, ctx.type, AES_MARKETSCAN.STEP_TIMEOUT_MS)
        await setSelectByLabel(typeEl, ctx.type)
        return
    }

    if (!ctx.registration) {
        log(`goto complete: family="${ctx.family}", type="${ctx.type}"`)
        sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
        return
    }

    // Filters applied. Hunt for the registration across pages.
    await sleep(300)
    await waitForElement(AES_MARKETSCAN.SELECTORS.offersContainer, AES_MARKETSCAN.SCRAPE_TIMEOUT_MS)

    ctx.pagesSearched = (ctx.pagesSearched || 0) + 1

    if (highlightOfferByRegistration(ctx.registration)) {
        log(`goto complete: found "${ctx.registration}" on page ${ctx.pagesSearched}`)
        sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
        return
    }

    const nextLink = document.querySelector(AES_MARKETSCAN.SELECTORS.nextPageLink)
    if (!nextLink) {
        log(`registration "${ctx.registration}" not found across ${ctx.pagesSearched} page(s) — offer may have been sold`)
        sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
        return
    }
    if (ctx.pagesSearched >= AES_MARKETSCAN.MAX_PAGES) {
        log(`hit MAX_PAGES=${AES_MARKETSCAN.MAX_PAGES} searching for "${ctx.registration}"`)
        sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
        return
    }

    log(`registration "${ctx.registration}" not on page ${ctx.pagesSearched} — advancing`)
    saveCtx(ctx)
    window.location.href = nextLink.href
}

function highlightOfferByRegistration(reg) {
    const offerItems = document.querySelectorAll(AES_MARKETSCAN.SELECTORS.offerItem)
    for (const item of offerItems) {
        const regEl = item.querySelector(".reg span, .reg a")
        const regText = regEl ? (regEl.textContent || "").trim() : ""
        if (regText === reg) {
            item.style.outline = "3px solid #f90"
            item.style.outlineOffset = "2px"
            item.scrollIntoView({behavior: "smooth", block: "center"})
            return true
        }
    }
    return false
}

async function advance(ctx) {
    // Heartbeat on every re-entry — the script restarts on each Wicket
    // navigation (family-set, type-set, pagination, variant switch), and
    // without this the controller's watchdog only sees heartbeats from the
    // scrape phase. Slow connections that spend >watchdog on setup would
    // otherwise get killed mid-setup.
    await writeHeartbeat(ctx)

    const familyEl = await waitForElement(AES_MARKETSCAN.SELECTORS.familySelect, AES_MARKETSCAN.STEP_TIMEOUT_MS)
    if (!familyEl) throw new Error("Family filter not found on page")

    // Phase 1: Family
    if (selectedLabel(familyEl) !== ctx.family) {
        ctx.familyAttempts = (ctx.familyAttempts || 0) + 1
        if (ctx.familyAttempts > AES_MARKETSCAN.MAX_FILTER_ATTEMPTS) {
            throw new Error(`Family filter did not stick after ${AES_MARKETSCAN.MAX_FILTER_ATTEMPTS} attempts (target "${ctx.family}", current "${selectedLabel(familyEl)}")`)
        }
        log(`phase 1: setting family "${ctx.family}" (attempt ${ctx.familyAttempts})`)
        saveCtx(ctx)
        await waitForOption(familyEl, ctx.family, AES_MARKETSCAN.STEP_TIMEOUT_MS)
        await setSelectByLabel(familyEl, ctx.family)
        return
    }
    log(`family OK: "${ctx.family}"`)

    // Phase 2: Type — resolve variants first time, then iterate
    const typeEl = await waitForElement(AES_MARKETSCAN.SELECTORS.typeSelect, AES_MARKETSCAN.STEP_TIMEOUT_MS)
    if (!typeEl) throw new Error("Type filter not found after family navigation")

    if (!ctx.variants || ctx.variants.length === 0) {
        ctx.variants = resolveVariants(typeEl, ctx.type)
        ctx.variantIdx = 0
        if (ctx.variants.length === 0) {
            throw new Error(`No options in the Aircraft Type dropdown matched "${ctx.type}". Use an exact dropdown label (e.g. "Airbus A320-200 heavy") or a base name whose variants exist (e.g. "Airbus A320-200").`)
        }
        log(`resolved ${ctx.variants.length} variant(s) for "${ctx.type}":`, ctx.variants)
        saveCtx(ctx)
    }

    const wantedVariant = ctx.variants[ctx.variantIdx]
    if (selectedLabel(typeEl) !== wantedVariant) {
        ctx.typeAttempts = (ctx.typeAttempts || 0) + 1
        if (ctx.typeAttempts > AES_MARKETSCAN.MAX_FILTER_ATTEMPTS) {
            throw new Error(`Type filter did not stick after ${AES_MARKETSCAN.MAX_FILTER_ATTEMPTS} attempts (target "${wantedVariant}", current "${selectedLabel(typeEl)}")`)
        }
        log(`phase 2: setting type "${wantedVariant}" (variant ${ctx.variantIdx + 1}/${ctx.variants.length}, attempt ${ctx.typeAttempts})`)
        saveCtx(ctx)
        await waitForOption(typeEl, wantedVariant, AES_MARKETSCAN.STEP_TIMEOUT_MS)
        await setSelectByLabel(typeEl, wantedVariant)
        return
    }
    log(`type OK: "${wantedVariant}" (variant ${ctx.variantIdx + 1}/${ctx.variants.length})`)
    ctx.typeAttempts = 0

    // Phase 3: Scrape
    await scrapePageAndContinue(ctx)
}

/**
 * Expand a preset type into dropdown labels:
 *   1. Exact match wins — scan only that option.
 *   2. baseType match (e.g. "Airbus A320-200" → all A320-200 variants whose
 *      TypeFamilyMap.baseType reduces to "Airbus A320-200").
 *   3. Prefix fallback — for base names like "Boeing 737-800" whose AS
 *      variant tokens (BGW / HGW / SFP / BCF / winglets / scimitar / ...)
 *      aren't in TypeFamilyMap's strip list. Match anything that begins
 *      with "<wantedType> " or "<wantedType>(".
 */
function resolveVariants(typeEl, wantedType) {
    const opts = Array.from(typeEl.querySelectorAll("option"))
        .filter(o => o.value && (o.textContent || "").trim())
    const labels = opts.map(o => o.textContent.trim())

    // 1. Exact
    if (labels.includes(wantedType)) return [wantedType]

    // 2. baseType reduction
    if (typeof TypeFamilyMap !== "undefined" && TypeFamilyMap.baseType) {
        const byBase = labels.filter(l => TypeFamilyMap.baseType(l) === wantedType)
        if (byBase.length) return byBase
    }

    // 3. Prefix fallback with a word boundary
    const byPrefix = labels.filter(l =>
        l.indexOf(wantedType + " ") === 0 || l.indexOf(wantedType + "(") === 0
    )
    return byPrefix
}

function selectedLabel(selectEl) {
    const opt = selectEl.options[selectEl.selectedIndex]
    return opt ? (opt.textContent || "").trim() : ""
}

async function scrapePageAndContinue(ctx) {
    await sleep(300)
    const container = await waitForElement(AES_MARKETSCAN.SELECTORS.offersContainer, AES_MARKETSCAN.SCRAPE_TIMEOUT_MS)
    const pageRows = container ? scrapeOffers(container, ctx) : []
    await enrichRowsWithTypeSpecs(pageRows, ctx)
    ctx.rows = (ctx.rows || []).concat(pageRows)
    const variantLabel = ctx.variants[ctx.variantIdx]
    log(`phase 3: scraped "${variantLabel}" page ${ctx.page} — ${pageRows.length} offers (total ${ctx.rows.length})`)

    // Heartbeat — resets the controller's watchdog and surfaces progress.
    await writeHeartbeat(ctx)

    // More pages in this variant?
    const nextLink = document.querySelector(AES_MARKETSCAN.SELECTORS.nextPageLink)
    if (nextLink && ctx.page < AES_MARKETSCAN.MAX_PAGES) {
        ctx.page = (ctx.page || 1) + 1
        saveCtx(ctx)
        log(`  next page link found — navigating`)
        window.location.href = nextLink.href
        return
    }
    if (nextLink && ctx.page >= AES_MARKETSCAN.MAX_PAGES) {
        log(`  hit MAX_PAGES=${AES_MARKETSCAN.MAX_PAGES}; stopping pagination for this variant`)
    }

    // Variant exhausted — move to next variant
    ctx.variantIdx = (ctx.variantIdx || 0) + 1
    if (ctx.variantIdx < ctx.variants.length) {
        ctx.page = 1
        ctx.typeAttempts = 0
        saveCtx(ctx)
        log(`  variant complete — moving to "${ctx.variants[ctx.variantIdx]}" (${ctx.variantIdx + 1}/${ctx.variants.length})`)
        const typeEl = document.querySelector(AES_MARKETSCAN.SELECTORS.typeSelect)
        if (!typeEl) {
            throw new Error("Type select vanished between variants")
        }
        await setSelectByLabel(typeEl, ctx.variants[ctx.variantIdx])
        return
    }

    // All variants complete
    log(`phase 4: all variants complete — ${ctx.rows.length} offers across ${ctx.variants.length} variant(s)`)
    await finishWithResult(ctx, ctx.rows)
}

async function writeHeartbeat(ctx) {
    if (typeof MarketScanSession === "undefined") return
    await MarketScanSession.saveResult(ctx.server, ctx.scanId, {
        type:   ctx.type,
        status: "scanning",
        rows:   ctx.rows,
        progress: {
            variantIdx:   ctx.variantIdx,
            variantCount: ctx.variants ? ctx.variants.length : 0,
            variant:      ctx.variants ? ctx.variants[ctx.variantIdx] : null,
            page:         ctx.page,
            total:        ctx.rows.length
        }
    })
}

function scrapeOffers(container, ctx) {
    const offers = container.querySelectorAll(AES_MARKETSCAN.SELECTORS.offerItem)
    const out = []
    offers.forEach(el => out.push(extractOffer(el, ctx)))
    return out
}

function extractOffer(offerEl, ctx) {
    const typeLink = offerEl.querySelector("h3 a.type")
    const aircraftType = typeLink ? (typeLink.textContent || "").trim() : null
    const typeId       = typeLink ? extractTypeId(typeLink.getAttribute("href")) : null

    const deadlineSpan = offerEl.querySelector(".deadline span")
    const bidInterval       = deadlineSpan ? (deadlineSpan.textContent || "").trim() : null
    const bidIntervalStatus = deadlineSpan ? ((deadlineSpan.className || "").trim() || null) : null

    const labelEl       = offerEl.querySelector("h3 .label")
    const offerCategory = labelEl ? (labelEl.textContent || "").trim() : null

    const owner         = fieldText(offerEl, ".owner")
    const registration  = fieldText(offerEl, ".reg")
    const ageText       = fieldText(offerEl, ".age")
    const conditionText = fieldText(offerEl, ".condition")
    const location      = fieldText(offerEl, ".location")

    const prices = extractPrices(offerEl)

    return {
        aircraftType:      aircraftType,
        typeId:            typeId,
        seats:             null,            // populated by enrichRowsWithTypeSpecs
        cargoCapacity:     null,
        speed:             null,
        range:             null,
        paxSatisfaction:   null,
        offerCategory:     offerCategory,
        bidInterval:       bidInterval,
        bidIntervalStatus: bidIntervalStatus,
        bidIntervalMs:     parseBidIntervalMs(bidInterval),
        owner:             owner,
        registration:      registration,
        age:               ageText,
        ageYears:          parseAgeYears(ageText),
        condition:         conditionText,
        conditionPct:      parsePercent(conditionText),
        location:          location,
        currentBid:        prices.currentBidBase,
        nextBid:           prices.nextBidBase,
        immediatePurchase: prices.immediatePurchaseBase,
        leasingRate:       prices.nextBidLeasingRate != null
                               ? prices.nextBidLeasingRate
                               : prices.immediatePurchaseLeasingRate,
        leasingDepot:      prices.nextBidLeasingDepot != null
                               ? prices.nextBidLeasingDepot
                               : prices.immediatePurchaseLeasingDepot,
        downPayment:       prices.nextBidDownPayment != null
                               ? prices.nextBidDownPayment
                               : prices.immediatePurchaseDownPayment,
        installment:       prices.nextBidInstallment != null
                               ? prices.nextBidInstallment
                               : prices.immediatePurchaseInstallment,
        offerUrl:          buildOfferGotoUrl(ctx, aircraftType, registration)
    }
}

function extractTypeId(href) {
    if (!href) return null
    const m = /aircraftsType\?id=(\d+)/.exec(href)
    return m ? parseInt(m[1], 10) : null
}

/**
 * For each unique aircraftsType id in the freshly-scraped page rows, fetch
 * `/action/enterprise/aircraftsType?id=<id>` once and parse the seat count
 * and cargo capacity. Results are cached on ctx.typeSpecsCache for the rest
 * of the variant + its pages, so a multi-page scan only does one fetch per
 * unique type. Failures are logged but never fatal — rows just keep null
 * seats/cargoCapacity if the detail page can't be parsed.
 */
async function enrichRowsWithTypeSpecs(rows, ctx) {
    if (!ctx.typeSpecsCache) ctx.typeSpecsCache = {}
    const cache = ctx.typeSpecsCache

    const wanted = new Set()
    for (const row of rows) {
        if (row.typeId && !(row.typeId in cache)) wanted.add(row.typeId)
    }
    if (!wanted.size) {
        applyTypeSpecsToRows(rows, cache)
        return
    }

    const fetched = await Promise.all(Array.from(wanted).map(async typeId => {
        const specs = await AESAircraftTypeSpecs.fetchById(typeId)
        return {typeId: typeId, specs: specs || {
            seats: null, cargoCapacity: null,
            speed: null, range: null, paxSatisfaction: null
        }}
    }))
    for (const f of fetched) {
        cache[f.typeId] = f.specs
    }
    log(`enriched ${wanted.size} aircraft type spec(s); cache now ${Object.keys(cache).length} entr(ies)`)
    for (const f of fetched) {
        log(`  type id=${f.typeId} → seats=${f.specs.seats} cargo=${f.specs.cargoCapacity} speed=${f.specs.speed} range=${f.specs.range} paxSat=${f.specs.paxSatisfaction}`)
    }
    applyTypeSpecsToRows(rows, cache)
}

function applyTypeSpecsToRows(rows, cache) {
    for (const row of rows) {
        if (!row.typeId) continue
        const specs = cache[row.typeId]
        if (!specs) continue
        row.seats = specs.seats
        row.cargoCapacity = specs.cargoCapacity
        row.speed = specs.speed
        row.range = specs.range
        row.paxSatisfaction = specs.paxSatisfaction
    }
}

// Aircraft type-spec fetching/parsing lives in modules/aircraft-type-specs.js
// (loaded ahead of this script in the manifest). Used here via
// AESAircraftTypeSpecs.fetchById(typeId) — same behaviour as before, shared
// with the route-assistant so both stay in sync.

/**
 * AirlineSim has no direct URL for a single market offer — the listing is
 * Wicket-stateful and the "Place Bid" dropdown items are action URLs that fire
 * a bid on click. So we mint a self-link back to the market page with
 * `#aesGoto=<type>|<family>[|<reg>]`; when the user opens it, our content
 * script drives the filters and scrolls to the matching row.
 */
function buildOfferGotoUrl(ctx, aircraftType, registration) {
    if (!ctx || !ctx.server || !ctx.family || !aircraftType) return null
    const parts = [encodeURIComponent(aircraftType), encodeURIComponent(ctx.family)]
    if (registration) parts.push(encodeURIComponent(registration))
    return "https://" + ctx.server + ".airlinesim.aero/app/aircraft/market#aesGoto=" + parts.join("|")
}

function fieldText(root, selector) {
    const el = root.querySelector(selector)
    if (!el) return null
    const inner = el.querySelector("span, a")
    if (inner) return (inner.textContent || "").trim()
    return afterColon(el.textContent)
}

function afterColon(text) {
    if (!text) return null
    const s = String(text).trim()
    const i = s.indexOf(":")
    return (i >= 0 ? s.substring(i + 1) : s).trim() || null
}

function extractPrices(offerEl) {
    const out = {
        currentBidBase: null, currentBidDownPayment: null, currentBidInstallment: null,
        currentBidLeasingDepot: null, currentBidLeasingRate: null,
        nextBidBase: null, nextBidDownPayment: null, nextBidInstallment: null,
        nextBidLeasingDepot: null, nextBidLeasingRate: null,
        immediatePurchaseBase: null, immediatePurchaseDownPayment: null,
        immediatePurchaseInstallment: null, immediatePurchaseLeasingDepot: null,
        immediatePurchaseLeasingRate: null
    }
    const table = offerEl.querySelector("table")
    if (!table) return out

    const bodyRows = table.querySelectorAll("tbody tr")
    bodyRows.forEach(tr => {
        const firstCell = tr.querySelector("td.column1")
        if (!firstCell) return
        const label = (firstCell.textContent || "").trim().toLowerCase()
        const numberCells = tr.querySelectorAll("td.number")
        const [base, downPay, install, depot, rate] = [
            cleanNum(numberCells[0]),
            cleanNum(numberCells[1]),
            cleanNum(numberCells[2]),
            cleanNum(numberCells[3]),
            cleanNum(numberCells[4])
        ]
        if (label.indexOf("current") !== -1) {
            out.currentBidBase = base;               out.currentBidDownPayment = downPay
            out.currentBidInstallment = install;     out.currentBidLeasingDepot = depot
            out.currentBidLeasingRate = rate
        } else if (label.indexOf("next") !== -1) {
            out.nextBidBase = base;                  out.nextBidDownPayment = downPay
            out.nextBidInstallment = install;        out.nextBidLeasingDepot = depot
            out.nextBidLeasingRate = rate
        } else if (label.indexOf("immediate") !== -1 || label.indexOf("purchase") !== -1) {
            out.immediatePurchaseBase = base;        out.immediatePurchaseDownPayment = downPay
            out.immediatePurchaseInstallment = install; out.immediatePurchaseLeasingDepot = depot
            out.immediatePurchaseLeasingRate = rate
        }
    })
    return out
}

function cleanNum(td) {
    if (!td) return null
    const t = (td.textContent || "").trim()
    if (!t) return null
    if (typeof AES !== "undefined" && AES.cleanInteger) return AES.cleanInteger(t)
    const n = parseInt(t.replace(/[^\d-]/g, ""), 10)
    return isNaN(n) ? null : n
}

function parseAgeYears(text) {
    if (!text) return null
    const y = /(\d+(?:\.\d+)?)\s*(?:yrs?|years?)/i.exec(text)
    const m = /(\d+)\s*mo/i.exec(text)
    if (!y && !m) return null
    const years  = y ? parseFloat(y[1]) : 0
    const months = m ? parseInt(m[1], 10) : 0
    return years + months / 12
}

function parsePercent(text) {
    if (!text) return null
    const m = /(\d+(?:\.\d+)?)/.exec(text)
    return m ? parseFloat(m[1]) : null
}

function parseBidIntervalMs(text) {
    if (!text) return null
    const colon = /^(\d+):(\d+)(?::(\d+))?$/.exec(text.trim())
    if (colon) {
        const h  = parseInt(colon[1], 10)
        const mi = parseInt(colon[2], 10)
        const s  = colon[3] ? parseInt(colon[3], 10) : 0
        return ((h * 60 + mi) * 60 + s) * 1000
    }
    let total = 0
    let matched = false
    const units = [
        {re: /(\d+)\s*d/i,        mult: 86400000},
        {re: /(\d+)\s*h/i,        mult:  3600000},
        {re: /(\d+)\s*m(?!s|o)/i, mult:    60000},
        {re: /(\d+)\s*s/i,        mult:     1000}
    ]
    for (const u of units) {
        const hit = u.re.exec(text)
        if (hit) { total += parseInt(hit[1], 10) * u.mult; matched = true }
    }
    return matched ? total : null
}

function absoluteUrl(url) {
    if (!url) return null
    if (url.indexOf("http") === 0) return url
    const a = document.createElement("a")
    a.href = url
    return a.href
}

async function finishWithResult(ctx, rows) {
    await writeResult(ctx, {type: ctx.type, status: "ok", rows: rows})
    cleanupAndClose()
}

async function finishWithError(ctx, message) {
    await writeResult(ctx, {type: ctx.type, status: "error", error: message, rows: (ctx && ctx.rows) || []})
    cleanupAndClose()
}

async function writeResult(ctx, blob) {
    if (typeof MarketScanSession === "undefined") {
        console.error("AES marketScan: MarketScanSession class missing — module not loaded.")
        return
    }
    await MarketScanSession.saveResult(ctx.server, ctx.scanId, blob)
}

function cleanupAndClose() {
    sessionStorage.removeItem(AES_MARKETSCAN.SESSION_KEY)
    window.close()
}

function waitForElement(selector, timeoutMs) {
    return new Promise(resolve => {
        const found = document.querySelector(selector)
        if (found) return resolve(found)

        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector)
            if (el) { observer.disconnect(); clearTimeout(timer); resolve(el) }
        })
        observer.observe(document.body || document.documentElement, {
            childList: true, subtree: true
        })

        const timer = setTimeout(() => { observer.disconnect(); resolve(null) }, timeoutMs)
    })
}

function waitForOption(selectEl, label, timeoutMs) {
    return new Promise(resolve => {
        if (matchOption(selectEl, label)) return resolve(true)

        const observer = new MutationObserver(() => {
            if (matchOption(selectEl, label)) {
                observer.disconnect(); clearTimeout(timer); resolve(true)
            }
        })
        observer.observe(selectEl, {childList: true, subtree: true})

        const timer = setTimeout(() => { observer.disconnect(); resolve(false) }, timeoutMs)
    })
}

function matchOption(selectEl, label) {
    const opts = selectEl.querySelectorAll("option")
    for (const o of opts) {
        if ((o.textContent || "").trim() === label) return true
    }
    return false
}

async function setSelectByLabel(selectEl, label) {
    const opts = selectEl.querySelectorAll("option")
    let target = null
    for (const o of opts) {
        if ((o.textContent || "").trim() === label) { target = o; break }
    }
    if (!target) throw new Error("Option not found in <select>: " + label)

    selectEl.value = target.value
    triggerChange(selectEl)
    await sleep(150)
}

function triggerChange(el) {
    el.dispatchEvent(new Event("input",  {bubbles: true}))
    el.dispatchEvent(new Event("change", {bubbles: true}))
    if (window.jQuery) {
        try { window.jQuery(el).trigger("change") } catch (e) { /* noop */ }
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}
