/**
 * Maps an AirlineSim aircraft type name (as it appears in the "Aircraft Type"
 * dropdown on the used market page) to its parent "Aircraft Family" name (as it
 * appears in the "Aircraft Family" dropdown).
 *
 * Used by the scanner to figure out which Family <select> value to set before
 * picking a Type, since the Type list is filtered by Family.
 *
 * The user's `settings.usedAircraftScanner.typeFamilyOverrides` is consulted
 * first, so anything that drifts (or gets added by AS later) can be patched
 * without a code change. The "Import all types" button in the dashboard panel
 * walks the live page once and populates that override map.
 */

const AS_FAMILY_ANY = "any aircraft family"

// Maps every AS Type dropdown label (current as of v6.13.x) to its parent
// Family. Family names must match the live "Aircraft Family" dropdown exactly,
// or the controller's family-set step fails.
//
// Legacy entries (older naming, e.g. "Embraer E170", "Bombardier CRJ-700",
// "Sukhoi Superjet 100-75") are kept so older / archive game worlds still
// work. New entries cover the modern dropdown labels.
const AS_TYPE_TO_FAMILY = {
    // 1900 Airliner
    "Beechcraft 1900C": "1900 Airliner",
    "Beechcraft 1900D": "1900 Airliner",
    "Raytheon / Beech 1900D Airliner": "1900 Airliner",

    // 208 Caravan
    "Cessna 208 Caravan": "208 Caravan",
    "Cessna 208B Grand Caravan": "208 Caravan",
    "Cessna 208B Super Cargomaster": "208 Caravan",

    // 408 SkyCourier
    "Cessna 408 SkyCourier": "408 SkyCourier",
    "Cessna 408 SkyCourier Freighter": "408 SkyCourier",
    "Cessna 408 SkyCourier Passenger": "408 SkyCourier",

    // 410
    "LET L-410UVP": "410",
    "LET L-410UVP-E": "410",
    "LET 410UVP": "410",
    "LET 410 NG": "410",

    // 737 MAX (legacy + current "737-8 / 737-9" naming)
    "Boeing 737 MAX 7": "737 MAX",
    "Boeing 737 MAX 8": "737 MAX",
    "Boeing 737 MAX 9": "737 MAX",
    "Boeing 737 MAX 10": "737 MAX",
    "Boeing 737-7": "737 MAX",
    "Boeing 737-8": "737 MAX",
    "Boeing 737-8 HGW": "737 MAX",
    "Boeing 737-8-200": "737 MAX",
    "Boeing 737-8-200 HGW": "737 MAX",
    "Boeing 737-9": "737 MAX",
    "Boeing 737-9 HGW": "737 MAX",
    "Boeing 737-10": "737 MAX",

    // 737-NG
    "Boeing 737-600": "737-600/700/800/900",
    "Boeing 737-700": "737-600/700/800/900",
    "Boeing 737-700ER": "737-600/700/800/900",
    "Boeing 737-800": "737-600/700/800/900",
    "Boeing 737-900": "737-600/700/800/900",
    "Boeing 737-900ER": "737-600/700/800/900",

    // 747-8
    "Boeing 747-8F": "747-8",
    "Boeing 747-8I": "747-8",

    // 767-200/300/400
    "Boeing 767-200": "767-200/300/400",
    "Boeing 767-200ER": "767-200/300/400",
    "Boeing 767-300": "767-200/300/400",
    "Boeing 767-300ER": "767-200/300/400",
    "Boeing 767-300F": "767-200/300/400",
    "Boeing 767-400ER": "767-200/300/400",

    // 777-200/300
    "Boeing 777-200": "777-200/300",
    "Boeing 777-200ER": "777-200/300",
    "Boeing 777-200LR": "777-200/300",
    "Boeing 777-200F": "777-200/300",
    "Boeing 777-300": "777-200/300",
    "Boeing 777-300ER": "777-200/300",
    "Boeing 777F": "777-200/300",

    // 787
    "Boeing 787-8": "787",
    "Boeing 787-9": "787",
    "Boeing 787-10": "787",

    // A220
    "Airbus A220-100": "A220",
    "Airbus A220-300": "A220",

    // A318 / A319
    "Airbus A318-100": "A318 / A319",
    "Airbus A319-100": "A318 / A319",

    // A319 / A320 / A321 NEO
    "Airbus A319neo": "A319 / A320 / A321 NEO",
    "Airbus A320neo": "A319 / A320 / A321 NEO",
    "Airbus A321neo": "A319 / A320 / A321 NEO",
    "Airbus A321LR": "A319 / A320 / A321 NEO",
    "Airbus A321XLR": "A319 / A320 / A321 NEO",

    // A320 / A321
    "Airbus A320-200": "A320 / A321",
    "Airbus A321-100": "A320 / A321",
    "Airbus A321-200": "A320 / A321",

    // A330 (incl. -200E/-200F/-300E/-300X/-300R sub-variants AS exposes as
    // distinct dropdown entries)
    "Airbus A330-200": "A330",
    "Airbus A330-200E": "A330",
    "Airbus A330-200F": "A330",
    "Airbus A330-200F Range": "A330",
    "Airbus A330-200F Payload": "A330",
    "Airbus A330-300": "A330",
    "Airbus A330-300E": "A330",
    "Airbus A330-300R": "A330",
    "Airbus A330-300X": "A330",

    // A330 NEO
    "Airbus A330-800": "A330 NEO",
    "Airbus A330-800E": "A330 NEO",
    "Airbus A330-900": "A330 NEO",
    "Airbus A330-900E": "A330 NEO",
    "Airbus A330-900X": "A330 NEO",

    // A350
    "Airbus A350-900": "A350",
    "Airbus A350-900ULR": "A350",
    "Airbus A350-1000": "A350",

    // A380
    "Airbus A380-800": "A380",

    // AN-28
    "Antonov AN-28": "AN-28",
    "PZL / Antonov AN-28-Skytruck": "AN-28",

    // AN140
    "Antonov AN-140": "AN140",
    "Antonov AN-140A": "AN140",

    // AN148 (also covers AN-158, AS lumps them under AN148)
    "Antonov AN-148": "AN148",
    "Antonov AN-148-100A": "AN148",
    "Antonov AN-148-100B": "AN148",
    "Antonov AN-148-100E": "AN148",
    "Antonov AN-158": "AN148",

    // ARJ21
    "COMAC ARJ21-700": "ARJ21",
    "Comac ARJ21-700": "ARJ21",
    "Comac ARJ21-700ER": "ARJ21",

    // ATR 42
    "ATR 42-300": "ATR 42",
    "ATR 42-500": "ATR 42",
    "ATR 42-500F": "ATR 42",
    "ATR 42-600": "ATR 42",

    // ATR 72
    "ATR 72-200": "ATR 72",
    "ATR 72-500": "ATR 72",
    "ATR 72-500F": "ATR 72",
    "ATR 72-600": "ATR 72",
    "ATR 72-600F": "ATR 72",

    // C919
    "COMAC C919": "C919",
    "Comac C919": "C919",
    "Comac C919 ER": "C919",

    // CRJ Series (legacy "Bombardier CRJ-XXX" + current "CRJ XXX NextGen")
    "Bombardier CRJ-100": "CRJ Series",
    "Bombardier CRJ-200": "CRJ Series",
    "Bombardier CRJ-700": "CRJ Series",
    "Bombardier CRJ-900": "CRJ Series",
    "Bombardier CRJ-1000": "CRJ Series",
    "CRJ 700 NextGen": "CRJ Series",
    "CRJ 700 NextGen ER": "CRJ Series",
    "CRJ 700 NextGen LR": "CRJ Series",
    "CRJ 900 NextGen": "CRJ Series",
    "CRJ 900 NextGen ER": "CRJ Series",
    "CRJ 900 NextGen LR": "CRJ Series",
    "CRJ 1000 NextGen": "CRJ Series",
    "CRJ 1000 NextGen EL": "CRJ Series",
    "CRJ 1000 NextGen ER": "CRJ Series",

    // Dash 8 (legacy "De Havilland Canada Dash 8-XXX" + current "DHC Dash 8-400 *")
    "De Havilland Canada Dash 8-100": "Dash 8",
    "De Havilland Canada Dash 8-200": "Dash 8",
    "De Havilland Canada Dash 8-300": "Dash 8",
    "De Havilland Canada Dash 8-Q400": "Dash 8",
    "DHC Dash 8-400 BASIC": "Dash 8",
    "DHC Dash 8-400 BASIC F-LCD": "Dash 8",
    "DHC Dash 8-400 EHGW": "Dash 8",
    "DHC Dash 8-400 EHGW F-LCD": "Dash 8",
    "DHC Dash 8-400CC": "Dash 8",

    // DHC-6
    "De Havilland DHC-6-400": "DHC-6",

    // DO228NG
    "General Atomics DO 228 NG": "DO228NG",

    // ERJ 135/140/145 (family rename from "ERJ" + ER/LR/XR sub-variants)
    "Embraer ERJ-135": "ERJ 135/140/145",
    "Embraer ERJ-135ER": "ERJ 135/140/145",
    "Embraer ERJ-135LR": "ERJ 135/140/145",
    "Embraer ERJ-140": "ERJ 135/140/145",
    "Embraer ERJ-140ER": "ERJ 135/140/145",
    "Embraer ERJ-140LR": "ERJ 135/140/145",
    "Embraer ERJ-145": "ERJ 135/140/145",
    "Embraer ERJ-145ER": "ERJ 135/140/145",
    "Embraer ERJ-145LR": "ERJ 135/140/145",
    "Embraer ERJ-145XR": "ERJ 135/140/145",

    // EMB 170/175/190/195 (family rename from "E-Jets" + new naming
    // "Embraer 170/175/190/195" alongside legacy "Embraer E170/E175/...")
    "Embraer E170": "EMB 170/175/190/195",
    "Embraer E175": "EMB 170/175/190/195",
    "Embraer E190": "EMB 170/175/190/195",
    "Embraer E195": "EMB 170/175/190/195",
    "Embraer 170": "EMB 170/175/190/195",
    "Embraer 170 LR": "EMB 170/175/190/195",
    "Embraer 175": "EMB 170/175/190/195",
    "Embraer 175 LR": "EMB 170/175/190/195",
    "Embraer 175 (enhanced)": "EMB 170/175/190/195",
    "Embraer 175 LR (enhanced)": "EMB 170/175/190/195",
    "Embraer 190": "EMB 170/175/190/195",
    "Embraer 190 LR": "EMB 170/175/190/195",
    "Embraer 190 AR": "EMB 170/175/190/195",
    "Embraer 190 SR": "EMB 170/175/190/195",
    "Embraer 195": "EMB 170/175/190/195",
    "Embraer 195 LR": "EMB 170/175/190/195",
    "Embraer 195 AR": "EMB 170/175/190/195",

    // EMB 175/190/195 E2 (family rename from "E-Jets E2")
    "Embraer E175-E2": "EMB 175/190/195 E2",
    "Embraer E190-E2": "EMB 175/190/195 E2",
    "Embraer E195-E2": "EMB 175/190/195 E2",
    "Embraer 175 E2": "EMB 175/190/195 E2",
    "Embraer 190 E2": "EMB 175/190/195 E2",
    "Embraer 195 E2": "EMB 175/190/195 E2",

    // Islander / Trislander
    "Britten-Norman BN-2B-26 Islander": "Islander / Trislander",
    "Britten-Norman BN-2T Turbine-Islander": "Islander / Trislander",

    // PC-12
    "Pilatus PC-12": "PC-12",
    "Pilatus PC-12 Cargo": "PC-12",
    "Pilatus PC-12 Mixed": "PC-12",
    "Pilatus PC-12 NGX": "PC-12",

    // PC-24
    "Pilatus PC-24": "PC-24",

    // Superjet (family rename from "Superjet 100")
    "Sukhoi Superjet 100-75": "Superjet",
    "Sukhoi Superjet 100-95": "Superjet",
    "Sukhoi Superjet 100-95LR": "Superjet",

    // TU-204/214 (family rename from "Tu-204")
    "Tupolev Tu-204": "TU-204/214",
    "Tupolev Tu-214": "TU-204/214",
    "Tupolev TU-204-100": "TU-204/214",
    "Tupolev TU-204-100C": "TU-204/214",
    "Tupolev TU-204-120": "TU-204/214",
    "Tupolev TU-204-120C": "TU-204/214",
    "Tupolev TU-204-300": "TU-204/214",

    // Xian Y-7 (AS lumps AVIC II MA-60/MA-600 into this family)
    "AVIC II / XIAN Y-7-200": "Xian Y-7",
    "AVIC II / MA-60": "Xian Y-7",
    "AVIC II / MA-600": "Xian Y-7",
    "AVIC II / MA-600F": "Xian Y-7",

    // Legacy archive types (older AS game worlds)
    "Fokker 50": "Fokker",
    "Fokker 70": "Fokker",
    "Fokker 100": "Fokker",
    "Ilyushin Il-62M": "Il-62",
    "Ilyushin Il-76": "Il-76",
    "Ilyushin Il-86": "Il-86",
    "Ilyushin Il-96-300": "Il-96",
    "Ilyushin Il-96-400": "Il-96",
    "Tupolev Tu-134": "Tu-134",
    "Tupolev Tu-154": "Tu-154",
    "McDonnell Douglas DC-9-30": "DC-9",
    "McDonnell Douglas DC-9-50": "DC-9",
    "McDonnell Douglas MD-81": "MD-80",
    "McDonnell Douglas MD-82": "MD-80",
    "McDonnell Douglas MD-83": "MD-80",
    "McDonnell Douglas MD-87": "MD-80",
    "McDonnell Douglas MD-88": "MD-80",
    "McDonnell Douglas MD-90": "MD-90",
    "Douglas DC-10-10": "DC-10",
    "Douglas DC-10-30": "DC-10",
    "McDonnell Douglas MD-11": "MD-11",
    "McDonnell Douglas MD-11F": "MD-11",
    "Boeing 707-320B": "707",
    "Boeing 707-320C": "707",
    "Boeing 717-200": "717",
    "Boeing 727-100": "727",
    "Boeing 727-200": "727",
    "Boeing 737-200": "737 Classic",
    "Boeing 737-300": "737 Classic",
    "Boeing 737-400": "737 Classic",
    "Boeing 737-500": "737 Classic",
    "Boeing 747-100": "747 Classic",
    "Boeing 747-200B": "747 Classic",
    "Boeing 747-200F": "747 Classic",
    "Boeing 747-300": "747 Classic",
    "Boeing 747-400": "747-400",
    "Boeing 747-400ER": "747-400",
    "Boeing 747-400F": "747-400",
    "Boeing 757-200": "757",
    "Boeing 757-200F": "757",
    "Boeing 757-300": "757",
    "Saab 340A": "Saab 340",
    "Saab 340B": "Saab 340",
    "Saab 2000": "Saab 2000"
}

// Family → category bucket. Drives the dashboard family-card grid colors and
// the results-table color rail. Five categories chosen to keep small utility
// turboprops (PC-12 / Caravan / Beech 1900) visually distinct from regional
// turboprops (ATR / Dash 8) — different roles in AS, different operating
// economics. PC-24 lives in "commuter" because in AS it slots into the same
// 8–19-pax niche as the turboprop commuters even though it's a light jet.
//
// Fokker is the one mixed-tech family AS exposes: F50 is a turboprop,
// F70/F100 are regional jets. Bucketed as "regional" since modern game worlds
// only expose F70/F100 — flag here so a future maintainer doesn't "fix" it.
const AS_FAMILY_CATEGORY = {
    // commuter (utility / small commuter, ≤ ~20 seats)
    "1900 Airliner":         "commuter",
    "208 Caravan":           "commuter",
    "408 SkyCourier":        "commuter",
    "410":                   "commuter",
    "AN-28":                 "commuter",
    "DHC-6":                 "commuter",
    "DO228NG":               "commuter",
    "Islander / Trislander": "commuter",
    "PC-12":                 "commuter",
    "PC-24":                 "commuter",

    // turboprop (regional turboprops, ~30–80 seats)
    "AN140":                 "turboprop",
    "ATR 42":                "turboprop",
    "ATR 72":                "turboprop",
    "Dash 8":                "turboprop",
    "Saab 340":              "turboprop",
    "Saab 2000":             "turboprop",
    "Xian Y-7":              "turboprop",

    // regional (regional jets)
    "AN148":                 "regional",
    "ARJ21":                 "regional",
    "CRJ Series":            "regional",
    "ERJ 135/140/145":       "regional",
    "EMB 170/175/190/195":   "regional",
    "EMB 175/190/195 E2":    "regional",
    "Superjet":              "regional",
    "Fokker":                "regional",  // F50 turboprop + F70/F100 jets — see header comment

    // narrowbody (single-aisle)
    "707":                   "narrowbody",
    "717":                   "narrowbody",
    "727":                   "narrowbody",
    "737 Classic":           "narrowbody",
    "737-600/700/800/900":   "narrowbody",
    "737 MAX":               "narrowbody",
    "757":                   "narrowbody",
    "A220":                  "narrowbody",
    "A318 / A319":           "narrowbody",
    "A319 / A320 / A321 NEO":"narrowbody",
    "A320 / A321":           "narrowbody",
    "C919":                  "narrowbody",
    "DC-9":                  "narrowbody",
    "MD-80":                 "narrowbody",
    "MD-90":                 "narrowbody",
    "TU-204/214":            "narrowbody",
    "Il-62":                 "narrowbody",
    "Tu-134":                "narrowbody",
    "Tu-154":                "narrowbody",

    // widebody (twin-aisle)
    "747-8":                 "widebody",
    "747 Classic":           "widebody",
    "747-400":               "widebody",
    "767-200/300/400":       "widebody",
    "777-200/300":           "widebody",
    "787":                   "widebody",
    "A330":                  "widebody",
    "A330 NEO":              "widebody",
    "A350":                  "widebody",
    "A380":                  "widebody",
    "DC-10":                 "widebody",
    "MD-11":                 "widebody",
    "Il-76":                 "widebody",
    "Il-86":                 "widebody",
    "Il-96":                 "widebody"
}

// Visual order in the family grid: small → large, left-to-right.
const AS_CATEGORY_ORDER = ["commuter", "turboprop", "regional", "narrowbody", "widebody"]

// Single source of truth for category color (used by family-grid cards AND
// the results-table row rail). Hex values match the existing scanner palette
// (status badges in content_dashboard.js use the same 3b82f6 / 16a34a base).
const AS_CATEGORY_COLOR = {
    commuter:   "#94a3b8",  // light slate
    turboprop:  "#64748b",  // slate
    regional:   "#3b82f6",  // blue
    narrowbody: "#16a34a",  // green
    widebody:   "#7c3aed",  // purple
    other:      "#9ca3af"   // grey — unmapped families and the Custom card
}

class TypeFamilyMap {
    /**
     * Strip variant suffixes ("heavy", "light", "medium", "high density",
     * "(enhanced)", "LR", "SHARP", "P2F", etc.) from an AS Type name to find
     * its base model. Used to look up the Family map.
     *
     * Example: "Airbus A320-200 heavy (enhanced) P2F" → "Airbus A320-200"
     */
    static baseType(typeName) {
        if (!typeName) return ""
        let s = typeName.trim()
        // Strip parenthetical tags
        s = s.replace(/\s*\([^)]*\)\s*/g, " ")
        // Strip known variant tokens at the end (repeated until stable).
        // Tokens must be preceded by whitespace so we don't accidentally chew
        // into base names like "A330-200E" / "A350-900ULR" / "Tu-204-100C".
        const variantTokens = /\s+(heavy|light|medium|high density|low density|standard|Passenger|LR|ER|SHARP|P2F|F|combi|cargo|Freighter|enhanced)$/i
        let prev
        do {
            prev = s
            s = s.replace(variantTokens, "")
        } while (s !== prev)
        return s.replace(/\s+/g, " ").trim()
    }

    /**
     * Resolves an AS Type to its Family.
     * @param {string} type - e.g. "Airbus A320-200 heavy (enhanced)"
     * @param {object} overrides - settings.usedAircraftScanner.typeFamilyOverrides
     * @returns {string|null} family name, or null if unknown
     */
    static resolve(type, overrides) {
        if (!type) return null
        if (overrides && overrides[type]) return overrides[type]
        if (AS_TYPE_TO_FAMILY[type]) return AS_TYPE_TO_FAMILY[type]
        const base = TypeFamilyMap.baseType(type)
        if (overrides && overrides[base]) return overrides[base]
        if (AS_TYPE_TO_FAMILY[base]) return AS_TYPE_TO_FAMILY[base]
        return null
    }

    /**
     * Adds (or replaces) a type→family mapping in the override map and persists it.
     * @returns {Promise<void>}
     */
    static async setOverride(type, family) {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        settings.usedAircraftScanner = settings.usedAircraftScanner || {}
        settings.usedAircraftScanner.typeFamilyOverrides =
            settings.usedAircraftScanner.typeFamilyOverrides || {}
        settings.usedAircraftScanner.typeFamilyOverrides[type] = family
        await chrome.storage.local.set({settings: settings})
    }

    /**
     * Category bucket for a family ("commuter" / "turboprop" / "regional" /
     * "narrowbody" / "widebody"). Returns "other" for unrecognised families
     * (e.g. user overrides pointing at families AS no longer exposes).
     */
    static category(family) {
        if (!family) return "other"
        return AS_FAMILY_CATEGORY[family] || "other"
    }

    /**
     * Color hex for a category. Falls back to the "other" grey for unknown
     * inputs so callers don't need to special-case nulls.
     */
    static categoryColor(category) {
        return AS_CATEGORY_COLOR[category] || AS_CATEGORY_COLOR.other
    }

    /**
     * Walks AS_TYPE_TO_FAMILY and returns one entry per family:
     * `[{family, category, types: string[]}, ...]` sorted by category
     * (commuter → widebody) then family name. Sole source for the dashboard
     * family-card grid's structure. User typeFamilyOverrides are NOT walked
     * here — they remain a scan-time concern; unknown labels in a preset land
     * in the grid's "Custom" card instead.
     */
    static familyList() {
        const byFamily = {}
        for (const type in AS_TYPE_TO_FAMILY) {
            const family = AS_TYPE_TO_FAMILY[type]
            if (!byFamily[family]) byFamily[family] = []
            byFamily[family].push(type)
        }
        const out = []
        for (const family in byFamily) {
            out.push({
                family: family,
                category: TypeFamilyMap.category(family),
                types: byFamily[family].slice().sort()
            })
        }
        out.sort((a, b) => {
            const ai = AS_CATEGORY_ORDER.indexOf(a.category)
            const bi = AS_CATEGORY_ORDER.indexOf(b.category)
            const ad = ai < 0 ? 999 : ai
            const bd = bi < 0 ? 999 : bi
            if (ad !== bd) return ad - bd
            return a.family.localeCompare(b.family)
        })
        return out
    }
}
