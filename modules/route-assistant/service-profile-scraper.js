"use strict"

/**
 * Service-profile scraper for the Route Assistant.
 *
 * AS exposes per-class on-board service settings (catering, snacks,
 * headphones, magazines, …) under named profiles at:
 *
 *   /action/enterprise/serviceProfiles            — profile list
 *   /action/enterprise/serviceProfile?id=<id>     — profile detail
 *
 * The detail page renders one fieldset per category (Drinks, Snacks,
 * Entrees, Additional entrees, Headphones, Food presentation,
 * Newspapers/Magazines, Flight Magazines). Each category has Y/C/F radio
 * groups whose `name` attribute is a 3-letter code: 2-letter category
 * prefix + class letter. Drinks Y = `dry`, snacks C = `snc`, entrees F =
 * `mdf`, etc.
 *
 * The set of categories changes between AS versions (sometimes new ones
 * appear, names get rephrased). The parser doesn't hard-code prefixes —
 * it walks every `<input type="radio">` group, derives the prefix from
 * the first 2 chars of the `name`, and groups by the trailing class
 * letter. Categories surface in `record.categories` keyed by the
 * `<h4>` heading (lowercase, stripped to alphanumeric) for human
 * readability; the same code lives in `categoryByPrefix` for cross-ref.
 *
 * Output:
 *
 *   routeAssistant:serviceProfilesList → {profiles: [...], scrapedAt}
 *
 *   routeAssistant:serviceProfile:<id> → {
 *     id, name, scrapedAt,
 *     categories: {
 *       drinks:           {Y: 1, C: 3, F: 4},
 *       snacks:           {Y: 1, C: 2, F: 5},
 *       entrees:          {Y: 1, C: 4, F: 9},
 *       additionalEntrees:{Y: 0, C: 0, F: 0},
 *       headphones:       {Y: 1, C: 2, F: 3},
 *       …
 *     },
 *     categoryByPrefix: {dr: "drinks", sn: "snacks", md: "entrees", ...},
 *     classScore: {Y: 0.18, C: 0.46, F: 0.78}   // mean(level/maxObserved)
 *   }
 *
 * `classScore` is normalised across whatever categories the page exposes —
 * so it stays a [0..1] proxy regardless of category drift. The aggregator
 * surfaces this informationally in the Service tooltip; it does NOT
 * auto-modify the per-class yield (would risk double-counting the
 * markets-page price observation).
 */
class RouteAssistantServiceProfileScraper {
    static LIST_KEY        = "routeAssistant:serviceProfilesList"
    static DETAIL_PREFIX   = "routeAssistant:serviceProfile:"
    static CLASSES         = ["Y", "C", "F"]
    static CLASS_LETTER_TO_KEY = {y: "Y", c: "C", f: "F"}

    constructor(server) {
        if (!server) throw new Error("RouteAssistantServiceProfileScraper: server required")
        this.server = server
        this._sessionList = null
        this._sessionDetails = new Map()
    }

    static async loadList() {
        const out = await chrome.storage.local.get([RouteAssistantServiceProfileScraper.LIST_KEY])
        return out[RouteAssistantServiceProfileScraper.LIST_KEY] || null
    }

    static async loadDetail(id) {
        const key = RouteAssistantServiceProfileScraper.DETAIL_PREFIX + String(id)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    /**
     * Bulk-load every cached detail record. Returns Map<id, record>.
     * Used by the panel on mount so the popover can resolve a profile id
     * to a full record without per-row fetches.
     */
    static async loadAllDetails() {
        const all = await chrome.storage.local.get(null)
        const map = new Map()
        const prefix = RouteAssistantServiceProfileScraper.DETAIL_PREFIX
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec || typeof rec.id !== "number") continue
            map.set(rec.id, rec)
        }
        return map
    }

    static async saveList(profiles) {
        const rec = {profiles: profiles || [], scrapedAt: Date.now()}
        await chrome.storage.local.set({[RouteAssistantServiceProfileScraper.LIST_KEY]: rec})
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:route-assistant:serviceProfile:updated", {
                kind:  "list",
                count: rec.profiles.length
            })
        }
        return rec
    }

    static async saveDetail(detail) {
        if (!detail || typeof detail.id !== "number") return null
        const key = RouteAssistantServiceProfileScraper.DETAIL_PREFIX + String(detail.id)
        const rec = Object.assign({scrapedAt: Date.now()}, detail)
        await chrome.storage.local.set({[key]: rec})
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:route-assistant:serviceProfile:updated", {
                kind: "detail",
                id:   detail.id
            })
        }
        return rec
    }

    /**
     * Fetch + parse the profile list. Returns the saved list record.
     */
    async scrapeList() {
        if (this._sessionList) return this._sessionList
        const url = "https://" + this.server + ".airlinesim.aero/action/enterprise/serviceProfiles"
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn("[AES serviceProfile] list HTTP " + resp.status)
                return null
            }
            const html = await resp.text()
            const profiles = RouteAssistantServiceProfileScraper.parseListFromHtml(html)
            const rec = await RouteAssistantServiceProfileScraper.saveList(profiles)
            this._sessionList = rec
            return rec
        } catch (e) {
            console.warn("[AES serviceProfile] list fetch failed", e)
            return null
        }
    }

    /**
     * Fetch + parse a single profile detail. Returns the saved detail record.
     */
    async scrapeDetail(id) {
        const numId = Number(id)
        if (!isFinite(numId)) return null
        if (this._sessionDetails.has(numId)) return this._sessionDetails.get(numId)
        const url = "https://" + this.server + ".airlinesim.aero/action/enterprise/serviceProfile?id=" + numId
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn("[AES serviceProfile] detail HTTP " + resp.status + " for id=" + numId)
                return null
            }
            const html = await resp.text()
            const detail = RouteAssistantServiceProfileScraper.parseDetailFromHtml(html, numId)
            if (!detail) return null
            const rec = await RouteAssistantServiceProfileScraper.saveDetail(detail)
            this._sessionDetails.set(numId, rec)
            return rec
        } catch (e) {
            console.warn("[AES serviceProfile] detail fetch failed for id=" + numId, e)
            return null
        }
    }

    /**
     * Sync everything: list first, then a detail per profile id. Used by
     * the panel's "Refresh service profiles" CTA. Returns the cached
     * detail map.
     */
    async syncAll() {
        const list = await this.scrapeList()
        if (!list || !Array.isArray(list.profiles)) return new Map()
        for (const p of list.profiles) {
            if (typeof p.id === "number") await this.scrapeDetail(p.id)
        }
        return RouteAssistantServiceProfileScraper.loadAllDetails()
    }

    static parseListFromHtml(html) {
        if (!html) return []
        const doc = new DOMParser().parseFromString(html, "text/html")
        return RouteAssistantServiceProfileScraper.parseListFromDoc(doc)
    }

    /**
     * Parse the profile list table. Each <tbody> row has:
     *   col 0: name
     *   col 1: minimum distance ("0 km", "1500 km", etc.)
     *   col 2: "default profile" text when this is the default
     *   col 3: edit link `/action/enterprise/serviceProfile?id=<id>`
     */
    static parseListFromDoc(doc) {
        const out = []
        if (!doc) return out
        const tableWells = doc.getElementsByClassName("as-table-well")
        for (let i = 0; i < tableWells.length; i++) {
            const tables = tableWells[i].getElementsByTagName("table")
            for (let j = 0; j < tables.length; j++) {
                const table = tables[j]
                const tbody = table.tBodies.length > 0 ? table.tBodies[0] : null
                if (!tbody) continue
                for (const tr of tbody.rows) {
                    const cells = tr.cells
                    if (!cells || cells.length < 4) continue
                    const name = (cells[0].textContent || "").trim()
                    if (!name) continue
                    const distText = (cells[1].textContent || "").trim()
                    const minDistanceKm = RouteAssistantServiceProfileScraper._parseInt(distText)
                    const isDefault = /default\s*profile/i.test(cells[2].textContent || "")

                    let id = null
                    let editLink = null
                    const links = cells[3].getElementsByTagName("a")
                    for (let k = 0; k < links.length; k++) {
                        if ((links[k].getAttribute("href") || "").indexOf("serviceProfile?id=") !== -1) {
                            editLink = links[k]
                            break
                        }
                    }
                    if (editLink) {
                        const m = /id=(\d+)/.exec(editLink.getAttribute("href") || "")
                        if (m) id = parseInt(m[1], 10)
                    }
                    if (id != null) {
                        out.push({id, name, minDistanceKm: minDistanceKm || 0, isDefault: !!isDefault})
                    }
                }
            }
        }
        return out
    }

    static parseDetailFromHtml(html, expectedId) {
        if (!html) return null
        const doc = new DOMParser().parseFromString(html, "text/html")
        return RouteAssistantServiceProfileScraper.parseDetailFromDoc(doc, expectedId)
    }

    /**
     * Walk every checked radio whose name fits the 3-letter pattern
     * (`<2-char prefix><class letter>`). Group by prefix → category, by
     * class-letter → class. Section headers (`<h4>`) provide a human
     * label per prefix where possible.
     */
    static parseDetailFromDoc(doc, expectedId) {
        if (!doc) return null

        // Map prefix → category label by walking the form's section headers
        // in document order. Each <h4> precedes the radios for one category.
        const prefixToCategory = {}
        let currentCategory = null
        const walker = doc.querySelector("form[action*='serviceChange']") || doc.body
        if (!walker) return null

        // Use a TreeWalker-style iteration through the form so headings
        // and radios appear in document order.
        const all = walker.getElementsByTagName("*")
        for (let i = 0; i < all.length; i++) {
            const node = all[i]
            const tag = node.tagName.toLowerCase()
            if (tag === "h4") {
                currentCategory = RouteAssistantServiceProfileScraper._slugifyCategory((node.textContent || "").trim())
                continue
            }
            if (tag === "input" && node.type === "radio") {
                const name = node.getAttribute("name") || ""
                if (name.length < 3) continue
                const prefix = name.slice(0, 2).toLowerCase()
                if (currentCategory && !prefixToCategory[prefix]) {
                    prefixToCategory[prefix] = currentCategory
                }
            }
        }

        const categories = {}
        const maxByPrefix = {}
        const radios = walker.getElementsByTagName("input")
        for (let i = 0; i < radios.length; i++) {
            const radio = radios[i]
            if (radio.type !== "radio") continue
            const name = radio.getAttribute("name") || ""
            if (name.length < 3) continue
            const prefix = name.slice(0, 2).toLowerCase()
            const clsLetter = name.slice(2, 3).toLowerCase()
            const clsKey = RouteAssistantServiceProfileScraper.CLASS_LETTER_TO_KEY[clsLetter]
            if (!clsKey) continue
            const valueText = radio.getAttribute("value") || ""
            const level = RouteAssistantServiceProfileScraper._parseInt(valueText)
            if (level == null) continue
            // Track the max value seen for this prefix so we can normalise
            // later — AS uses asymmetric scales (Y tops at 5, F at 9, etc.).
            if (!(prefix in maxByPrefix) || level > maxByPrefix[prefix]) {
                maxByPrefix[prefix] = level
            }
            const isChecked = radio.hasAttribute("checked")
            if (!isChecked) continue
            const catKey = prefixToCategory[prefix] || ("category_" + prefix)
            if (!categories[catKey]) categories[catKey] = {Y: null, C: null, F: null}
            categories[catKey][clsKey] = level
        }

        if (!Object.keys(categories).length) return null

        // Build classScore: mean(level / maxObservedForCategory) per class.
        const classScore = {Y: 0, C: 0, F: 0}
        const classCounts = {Y: 0, C: 0, F: 0}
        // Map category → prefix to look up max
        const catToPrefix = {}
        for (const p in prefixToCategory) catToPrefix[prefixToCategory[p]] = p
        for (const catKey in categories) {
            const prefix = catToPrefix[catKey]
            const ceiling = (prefix && maxByPrefix[prefix]) || 1
            const cat = categories[catKey]
            for (const cls of RouteAssistantServiceProfileScraper.CLASSES) {
                if (cat[cls] == null) continue
                classScore[cls] += cat[cls] / ceiling
                classCounts[cls] += 1
            }
        }
        for (const cls of RouteAssistantServiceProfileScraper.CLASSES) {
            classScore[cls] = classCounts[cls] > 0
                ? Math.round((classScore[cls] / classCounts[cls]) * 1000) / 1000
                : null
        }

        // Profile name + id from the page title (h2#title) and a hidden id.
        const titleEl = doc.querySelector("h2#title, #title")
        const name = titleEl ? (titleEl.textContent || "").trim() : null
        const idInput = doc.querySelector("input[name='id'][value]")
        const idVal = idInput ? parseInt(idInput.getAttribute("value"), 10) : null
        const id = (typeof expectedId === "number" && isFinite(expectedId))
            ? expectedId
            : (isFinite(idVal) ? idVal : null)

        return {
            id:               id,
            name:             name || ("Profile " + (id || "?")),
            categories:       categories,
            categoryByPrefix: prefixToCategory,
            classScore:       classScore
        }
    }

    /**
     * Slugify a category heading: "Newspapers/Magazines" → "newspapersMagazines",
     * "Additional entrees" → "additionalEntrees". Lowercase first word, then
     * camelCase the rest. Drops anything non-alphanumeric.
     */
    static _slugifyCategory(text) {
        if (!text) return null
        const words = String(text).trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
        if (!words.length) return null
        return words.map((w, i) => {
            const lower = w.toLowerCase()
            return i === 0 ? lower : (lower.charAt(0).toUpperCase() + lower.slice(1))
        }).join("")
    }

    static _parseInt(text) {
        if (text === null || text === undefined) return null
        const s = String(text).replace(/[^\d-]/g, "")
        if (!s) return null
        const n = parseInt(s, 10)
        return isFinite(n) ? n : null
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantServiceProfileScraper = RouteAssistantServiceProfileScraper
}
