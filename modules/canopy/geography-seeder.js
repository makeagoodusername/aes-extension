"use strict"

/**
 * Populates `aesCanopy:geography:countryIdMap:<server>` from the AS
 * country data already cached in `RouteAssistantDemandStore`.
 *
 * Idea: every demand record carries `countryId` (AS-internal integer)
 * and (after the parallel-scanner's seedAllCountries pass) often a
 * country name. We harvest those into a per-server map so future
 * lookups can resolve countryId → ISO2 without re-scraping.
 *
 * The mapping is best-effort — AS doesn't expose ISO2 codes directly,
 * so we infer when the country name maps unambiguously to an ISO2 entry
 * in `AesGeographyBase.COUNTRY_CONTINENT`. Unmapped entries record name
 * only; the resolver falls back to continent-only matching.
 *
 * `populate(server)` is safe to call repeatedly; it merges with any
 * existing map and only overwrites entries whose iso2 was previously
 * null (so manual user overrides survive).
 */
;(function () {
    if (window.AesCanopyGeographySeeder) return

    const KEY_PREFIX = "aesCanopy:geography:countryIdMap"

    function _key(server) { return KEY_PREFIX + ":" + server }

    // Common AS country name → ISO2 mappings. Extend as new edge cases
    // surface. Keep minimal — the resolver gracefully degrades when a
    // mapping is missing.
    const NAME_TO_ISO2 = {
        "United States":            "US",
        "United Kingdom":           "GB",
        "Russia":                   "RU",
        "Russian Federation":       "RU",
        "South Korea":              "KR",
        "North Korea":              "KP",
        "Czech Republic":           "CZ",
        "Czechia":                  "CZ",
        "Vietnam":                  "VN",
        "Iran":                     "IR",
        "Syria":                    "SY",
        "Bolivia":                  "BO",
        "Venezuela":                "VE",
        "Tanzania":                 "TZ",
        "Moldova":                  "MD",
        "Macedonia":                "MK",
        "North Macedonia":          "MK",
        "Cape Verde":               "CV",
        "Brunei":                   "BN",
        "Laos":                     "LA"
    }

    // Lazy reverse index: lowercased+normalized canonical English name → ISO2.
    // Built once from `AesGeographyBase.COUNTRY_CONTINENT` × the platform's
    // `Intl.DisplayNames("en", {type:"region"})` so any AS country whose
    // name matches the canonical form resolves without a hand-curated entry.
    // NAME_TO_ISO2 still wins for variants Intl doesn't return ("Russia",
    // "Czech Republic", "South Korea", "Vietnam", …). The normalizer folds
    // "&"↔"and" so "Trinidad & Tobago" (Intl form) matches AS's
    // "Trinidad and Tobago".
    function _normalizeName(s) {
        return String(s).trim().toLowerCase().replace(/\s*&\s*/g, " and ").replace(/\s+/g, " ")
    }
    let _iso2ByName = null
    function _buildIso2ByName() {
        const out = Object.create(null)
        if (typeof window.AesGeographyBase === "undefined" || typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function") {
            return out
        }
        let dn
        try { dn = new Intl.DisplayNames(["en"], {type: "region"}) }
        catch (_) { return out }
        for (const code in window.AesGeographyBase.COUNTRY_CONTINENT) {
            let name
            try { name = dn.of(code) } catch (_) { continue }
            if (!name || typeof name !== "string") continue
            out[_normalizeName(name)] = code
        }
        return out
    }

    function _guessIso2(name) {
        if (!name) return null
        const k = String(name).trim()
        if (NAME_TO_ISO2[k]) return NAME_TO_ISO2[k]
        if (_iso2ByName === null) _iso2ByName = _buildIso2ByName()
        const hit = _iso2ByName[_normalizeName(k)]
        return hit || null
    }

    async function load(server) {
        if (!server) return null
        const k = _key(server)
        const out = await chrome.storage.local.get([k])
        return out[k] || null
    }

    async function populate(server) {
        if (!server) return null
        if (typeof RouteAssistantDemandStore === "undefined" || !RouteAssistantDemandStore) {
            return null
        }
        const existing = await load(server)
        const byCountryId = (existing && existing.byCountryId) || {}
        const before = existing ? JSON.stringify(existing.byCountryId || {}) : null
        // RouteAssistantDemandStore exposes a getAll-style helper through
        // its store; fall back to scanning chrome.storage if absent.
        let allRecords = []
        if (typeof RouteAssistantDemandStore.list === "function") {
            try { allRecords = (await RouteAssistantDemandStore.list()) || [] } catch (_) {}
        }
        if (!allRecords.length) {
            // Best-effort scan of demand keys.
            const all = await chrome.storage.local.get(null)
            for (const k in all) {
                if (k.indexOf("routeAssistant:demand:") === 0 && all[k]) {
                    allRecords.push(all[k])
                }
            }
        }
        for (const rec of allRecords) {
            if (!rec || rec.countryId == null) continue
            const cid = Number(rec.countryId)
            if (!isFinite(cid)) continue
            const slot = byCountryId[cid] || {iso2: null, name: null}
            if (rec.countryName && !slot.name) slot.name = String(rec.countryName)
            if (!slot.iso2) {
                const guess = _guessIso2(slot.name || rec.countryName)
                if (guess) slot.iso2 = guess
            }
            byCountryId[cid] = slot
        }
        // Idempotent re-seed: if the merged map equals the prior persisted
        // map, return the existing block unchanged so scrapedAt + storage
        // writes (and their onChanged echoes) don't churn.
        if (existing && before === JSON.stringify(byCountryId)) {
            return existing
        }
        const block = {schemaVersion: 1, scrapedAt: Date.now(), byCountryId}
        await chrome.storage.local.set({[_key(server)]: block})
        return block
    }

    /**
     * Manual override — sets the iso2 for a specific countryId on a server.
     * Used by the settings UI when the user corrects a missed inference.
     */
    async function setIso2(server, countryId, iso2) {
        if (!server || countryId == null) return null
        const k = _key(server)
        const out = await chrome.storage.local.get([k])
        const block = out[k] || {schemaVersion: 1, scrapedAt: Date.now(), byCountryId: {}}
        const slot = block.byCountryId[countryId] || {iso2: null, name: null}
        slot.iso2 = iso2 ? String(iso2).toUpperCase() : null
        block.byCountryId[countryId] = slot
        block.scrapedAt = Date.now()
        await chrome.storage.local.set({[k]: block})
        return slot
    }

    window.AesCanopyGeographySeeder = {load, populate, setIso2, KEY_PREFIX}
})()
