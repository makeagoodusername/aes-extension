"use strict"

/**
 * Enterprise metadata scraper for the Route Assistant — Letter F slice 2.
 *
 * Fetches `/app/info/enterprises/<id>` and extracts the bits the Cmp
 * popover needs to mirror AS's own Stations table look:
 *   - Wide enterprise banner image URL (~200×32px in AS UI)
 *   - Profile picture / avatar URL (~32×32px)
 *   - Display name
 *   - IATA code (when present in headers / breadcrumbs)
 *
 * Why a separate scraper from `markets-page-scraper.js`: the markets
 * page only carries `{rank, name, enterpriseId, sharePct, change}`
 * per competitor — no images. Banner/avatar URLs are not guessable
 * from the enterpriseId alone (AS doesn't expose a stable
 * `/images/<id>/banner.png` convention), so each enterprise has to be
 * fetched once. Cache TTL is generous (90 days default) since
 * enterprises rarely rebrand.
 *
 * Cache (NOT directional — enterprise metadata is a property of the
 * enterprise, not the route, so it's cross-route reusable):
 *   routeAssistant:enterpriseMeta:<id>
 *     → {enterpriseId, server, name, iata?, bannerUrl?, avatarUrl?,
 *        scrapedAt, parserNotes?}
 *
 * Parser strategy: same defensive multi-strategy approach as
 * `carriers-scraper.js` — try several DOM shapes in priority order so
 * the scraper survives AS markup tweaks. When nothing matches the
 * record stores `parserNotes` so the panel can surface the failure
 * mode without silently treating "no data" as "no enterprise".
 */
class RouteAssistantEnterpriseMetaScraper {
    static CACHE_PREFIX = "routeAssistant:enterpriseMeta:"

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantEnterpriseMetaScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantEnterpriseMetaScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        this._sessionCache = new Map()
    }

    static _normaliseMaxAge(v) {
        const n = Number(v)
        return isFinite(n) && n > 0 ? n : null
    }

    static _isExpired(record, maxAgeDays) {
        if (!maxAgeDays) return false
        if (!record || typeof record.scrapedAt !== "number") return false
        return Date.now() - record.scrapedAt > maxAgeDays * 86400000
    }

    /**
     * Bulk-load cached records for a list of enterprise IDs (numbers
     * or strings). Returns Map<enterpriseId-as-string, record>. Used by
     * the panel on mount + after a bulk scrape so the popover paints
     * with whatever's already cached.
     */
    static async bulkLoadCache(ids, opts) {
        if (!ids || !ids.length) return new Map()
        const maxAgeDays = RouteAssistantEnterpriseMetaScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = ids.map(id => RouteAssistantEnterpriseMetaScraper.CACHE_PREFIX + String(id))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            if (RouteAssistantEnterpriseMetaScraper._isExpired(rec, maxAgeDays)) continue
            const id = k.substring(RouteAssistantEnterpriseMetaScraper.CACHE_PREFIX.length)
            map.set(id, rec)
        }
        return map
    }

    static async saveRecord(server, enterpriseId, fields) {
        const id = String(enterpriseId)
        const key = RouteAssistantEnterpriseMetaScraper.CACHE_PREFIX + id
        const rec = Object.assign({
            enterpriseId: id,
            server:       server,
            scrapedAt:    Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    /**
     * Fetch + parse one enterprise's info page. Idempotent within the
     * session — repeated calls short-circuit through `_sessionCache`.
     */
    async scrape(enterpriseId) {
        const id = String(enterpriseId)
        if (this._sessionCache.has(id)) return this._sessionCache.get(id)

        const url = `https://${this.server}.airlinesim.aero/app/info/enterprises/${encodeURIComponent(id)}`
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.ok) html = await resp.text()
        } catch (e) {
            console.warn(`[AES enterpriseMeta] fetch failed for #${id}:`, e)
        }

        const parsed = parseEnterpriseHtml(html, this.server, id)
        const record = await RouteAssistantEnterpriseMetaScraper.saveRecord(this.server, id, parsed)
        this._sessionCache.set(id, record)
        return record
    }

    /**
     * Concurrent bulk scrape — same orchestration shape as the other
     * RA scrapers so the panel's progress UI can be cloned. Resolves
     * once every id has either persisted or errored.
     */
    async bulkScrape(ids, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(10, opts.concurrency || 4))
        const staggerMs   = Math.max(0, opts.staggerMs || 600)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

        const total = ids.length
        if (!total) return []
        const results = new Array(total)

        let cursor = 0
        let inflight = 0
        let done = 0
        let lastDispatchAt = 0

        return new Promise(resolve => {
            const tryDispatch = () => {
                while (inflight < concurrency && cursor < total) {
                    const sinceLast = Date.now() - lastDispatchAt
                    if (sinceLast < staggerMs) {
                        setTimeout(tryDispatch, staggerMs - sinceLast)
                        return
                    }
                    const idx = cursor++
                    const id = ids[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    const finish = (rec) => {
                        results[idx] = rec
                        inflight--
                        done++
                        if (onProgress) {
                            try { onProgress(done, total) } catch (e) { /* noop */ }
                        }
                        if (done >= total) resolve(results)
                        else tryDispatch()
                    }
                    this.scrape(id).then(finish).catch(err => {
                        console.warn("[AES enterpriseMeta] scrape error:", err)
                        finish(null)
                    })
                }
            }
            tryDispatch()
        })
    }
}

// ---------- Parser ----------

/**
 * Parse `/app/info/enterprises/<id>` HTML for the metadata bits the
 * popover needs. Each strategy is independently scoped so a partial
 * match still produces a useful record. Returns:
 *   {name, iata?, bannerUrl?, avatarUrl?, parserNotes?}
 *
 * Banner vs avatar disambiguation: banners are wide (>120px or class
 * mentions "banner"), avatars are square-ish (≤80px or class mentions
 * "avatar"/"profile"/"logo"). When both classes match, the wider
 * image wins the banner slot.
 */
function parseEnterpriseHtml(html, server, enterpriseId) {
    const fallback = {name: null, iata: null, bannerUrl: null, avatarUrl: null}
    if (!html) return Object.assign({}, fallback, {parserNotes: "no HTML returned"})

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return Object.assign({}, fallback, {parserNotes: "DOMParser failed"})
    }
    if (!doc || !doc.body) return Object.assign({}, fallback, {parserNotes: "empty document"})

    const baseUrl = `https://${server}.airlinesim.aero/`
    const notes = []
    let name = null
    let iata = null
    let bannerUrl = null
    let avatarUrl = null

    // --- Name ---
    const h1 = doc.querySelector("h1, h2, .as-page-title, [class*='page-title']")
    if (h1) name = (h1.textContent || "").trim() || null
    if (!name) {
        const t = (doc.querySelector("title") || {}).textContent || ""
        // AS title format is usually "Name (CODE) — AirlineSim". Strip
        // trailing site name.
        const cleaned = t.split(/[—|·-]/)[0].trim()
        if (cleaned) name = cleaned
    }
    const generalInfo = parseEnterpriseGeneralInfo(doc)
    if (generalInfo.name && (!name || /^enterprises$/i.test(name))) {
        name = generalInfo.name
    }
    if (generalInfo.iata && !iata) {
        iata = generalInfo.iata
    }

    // --- IATA / ICAO code ---
    // Common shapes: "Fly Gemini (FG)" in the heading, or a separate
    // labeled row "IATA: FG".
    if (name) {
        const m = /\(([A-Z0-9]{2,3})\)/.exec(name)
        if (m) {
            iata = m[1]
            name = name.replace(/\s*\(([A-Z0-9]{2,3})\)\s*$/, "").trim() || name
        }
    }
    if (!iata) {
        for (const row of doc.querySelectorAll("tr, dl > div, li")) {
            const text = (row.textContent || "").trim()
            const m = /\b(?:IATA|ICAO|Code)\b[^A-Z0-9]*([A-Z0-9]{2,4})\b/i.exec(text)
            if (m) { iata = m[1].toUpperCase(); break }
        }
    }

    // --- Image candidates ---
    // Strategy A: explicit class hints (banner / avatar / logo / profile).
    const candidates = []
    const seenSrc = new Set()
    const pushImg = (img, source) => {
        if (!img) return
        const src = img.getAttribute("src")
        if (!src) return
        const abs = absolutiseUrl(src, baseUrl)
        if (!abs || seenSrc.has(abs)) return
        seenSrc.add(abs)
        candidates.push({url: abs, source: source, el: img})
    }

    for (const sel of [
        "img[class*='banner' i]",
        "[class*='banner' i] img",
        "img[class*='avatar' i]",
        "[class*='avatar' i] img",
        "img[class*='logo' i]",
        "[class*='logo' i] img",
        "img[class*='profile' i]",
        "[class*='profile' i] img"
    ]) {
        const matches = doc.querySelectorAll(sel)
        for (const img of matches) pushImg(img, sel)
    }

    // Strategy B: og:image meta — usually the canonical banner.
    const og = doc.querySelector("meta[property='og:image'], meta[name='og:image']")
    if (og && og.getAttribute("content")) {
        const abs = absolutiseUrl(og.getAttribute("content"), baseUrl)
        if (abs && !seenSrc.has(abs)) {
            seenSrc.add(abs)
            candidates.push({url: abs, source: "og:image"})
        }
    }

    // Strategy C: any image in the first .panel-heading / header /
    // [class*='enterprise'] block. Catches AS pages that wrap the
    // banner in a generic class without the keyword.
    const headerScopes = doc.querySelectorAll(
        ".panel-heading, header, [class*='enterprise' i], main > :first-child"
    )
    for (const scope of headerScopes) {
        for (const img of scope.querySelectorAll("img")) {
            pushImg(img, "header-img")
        }
    }

    // Disambiguate: pick the widest candidate as the banner, the
    // smallest as the avatar. When the DOM gives us natural width via
    // the `width` attribute prefer that; otherwise heuristic on the
    // class name keyword.
    if (candidates.length) {
        const scored = candidates.map(c => {
            let w = parseInt(c.el && c.el.getAttribute("width"), 10)
            if (!isFinite(w) || w <= 0) {
                // Class-keyword scoring: banner-like classes get a +200
                // size boost so they win over generic logos when no
                // explicit width is set.
                if (/banner/i.test(c.source))  w = 220
                else if (/avatar|profile/i.test(c.source)) w = 32
                else if (/logo/i.test(c.source))  w = 48
                else w = 100
            }
            return Object.assign({width: w}, c)
        })
        scored.sort((a, b) => b.width - a.width)
        const widest = scored[0]
        const narrowest = scored[scored.length - 1]
        // Banner: widest IF it's clearly wide (>120px-ish) OR the
        // class keyword screams "banner".
        if (widest.width >= 120 || /banner|og:image|header/i.test(widest.source)) {
            bannerUrl = widest.url
        }
        // Avatar: narrowest non-banner candidate, or widest if there's
        // only one.
        if (scored.length > 1) {
            const remaining = scored.filter(c => c.url !== bannerUrl)
            if (remaining.length) avatarUrl = remaining[remaining.length - 1].url
        } else if (!bannerUrl) {
            avatarUrl = narrowest.url
        }
    }

    if (!bannerUrl && !avatarUrl) notes.push("no enterprise images matched (selectors may need tuning)")
    if (!name) notes.push("name not parsed")

    return {
        name:         name,
        iata:         iata,
        bannerUrl:    bannerUrl,
        avatarUrl:    avatarUrl,
        parserNotes:  notes.length ? notes.join("; ") : null
    }
}

function parseEnterpriseGeneralInfo(doc) {
    const out = {name: null, iata: null}
    if (!doc) return out

    for (const tr of doc.querySelectorAll("tr")) {
        const cells = tr.querySelectorAll("th, td")
        if (cells.length < 2) continue
        const label = ((cells[0] && cells[0].textContent) || "")
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase()
        const value = ((cells[1] && cells[1].textContent) || "")
            .trim()
            .replace(/\s+/g, " ")
        if (!value) continue

        if (label === "name" && !out.name) {
            out.name = value
        } else if ((label === "code" || label === "iata" || label === "icao") && !out.iata) {
            const m = /\b([A-Z0-9]{2,4})\b/i.exec(value)
            out.iata = m ? m[1].toUpperCase() : value.toUpperCase()
        }
    }

    return out
}

/**
 * Resolve an `<img src>` against the AS base URL. Handles absolute
 * URLs (returns as-is), protocol-relative `//host/path`, and
 * server-relative `/path`.
 */
function absolutiseUrl(src, baseUrl) {
    if (!src) return null
    src = String(src).trim()
    if (!src) return null
    if (/^https?:\/\//i.test(src)) return src
    if (src.indexOf("//") === 0) return "https:" + src
    if (src.indexOf("/") === 0) {
        // baseUrl ends with "/"; strip the leading slash from src.
        return baseUrl.replace(/\/$/, "") + src
    }
    return baseUrl + src
}
