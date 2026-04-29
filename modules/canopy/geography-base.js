"use strict"

/**
 * Bundled static geography. Game-world-agnostic. Not in chrome.storage.
 *
 * Provides:
 *   - 7 continents
 *   - ISO2 → continent map for ~250 countries
 *   - Default region seeds for `aesCanopy:regions` first-run
 *
 * The regions-store calls `defaultRegions()` once on first load to populate
 * a useful starting partition. Users can rename/edit/delete after.
 *
 * North Star §4.11 — no new dependencies. Static data inline.
 */
;(function () {
    if (window.AesGeographyBase) return

    const CONTINENTS = {
        AF: {id: "AF", label: "Africa"},
        AN: {id: "AN", label: "Antarctica"},
        AS: {id: "AS", label: "Asia"},
        EU: {id: "EU", label: "Europe"},
        NA: {id: "NA", label: "North America"},
        OC: {id: "OC", label: "Oceania"},
        SA: {id: "SA", label: "South America"}
    }

    // ISO 3166-1 alpha-2 → continent. Sourced from ISO mapping; covers
    // every sovereign state + most territories. Compact inline form.
    const COUNTRY_CONTINENT = {
        AD:"EU", AE:"AS", AF:"AS", AG:"NA", AI:"NA", AL:"EU", AM:"AS", AO:"AF",
        AQ:"AN", AR:"SA", AS:"OC", AT:"EU", AU:"OC", AW:"NA", AX:"EU", AZ:"AS",
        BA:"EU", BB:"NA", BD:"AS", BE:"EU", BF:"AF", BG:"EU", BH:"AS", BI:"AF",
        BJ:"AF", BL:"NA", BM:"NA", BN:"AS", BO:"SA", BQ:"NA", BR:"SA", BS:"NA",
        BT:"AS", BV:"AN", BW:"AF", BY:"EU", BZ:"NA", CA:"NA", CC:"AS", CD:"AF",
        CF:"AF", CG:"AF", CH:"EU", CI:"AF", CK:"OC", CL:"SA", CM:"AF", CN:"AS",
        CO:"SA", CR:"NA", CU:"NA", CV:"AF", CW:"NA", CX:"AS", CY:"AS", CZ:"EU",
        DE:"EU", DJ:"AF", DK:"EU", DM:"NA", DO:"NA", DZ:"AF", EC:"SA", EE:"EU",
        EG:"AF", EH:"AF", ER:"AF", ES:"EU", ET:"AF", FI:"EU", FJ:"OC", FK:"SA",
        FM:"OC", FO:"EU", FR:"EU", GA:"AF", GB:"EU", GD:"NA", GE:"AS", GF:"SA",
        GG:"EU", GH:"AF", GI:"EU", GL:"NA", GM:"AF", GN:"AF", GP:"NA", GQ:"AF",
        GR:"EU", GS:"AN", GT:"NA", GU:"OC", GW:"AF", GY:"SA", HK:"AS", HM:"AN",
        HN:"NA", HR:"EU", HT:"NA", HU:"EU", ID:"AS", IE:"EU", IL:"AS", IM:"EU",
        IN:"AS", IO:"AS", IQ:"AS", IR:"AS", IS:"EU", IT:"EU", JE:"EU", JM:"NA",
        JO:"AS", JP:"AS", KE:"AF", KG:"AS", KH:"AS", KI:"OC", KM:"AF", KN:"NA",
        KP:"AS", KR:"AS", KW:"AS", KY:"NA", KZ:"AS", LA:"AS", LB:"AS", LC:"NA",
        LI:"EU", LK:"AS", LR:"AF", LS:"AF", LT:"EU", LU:"EU", LV:"EU", LY:"AF",
        MA:"AF", MC:"EU", MD:"EU", ME:"EU", MF:"NA", MG:"AF", MH:"OC", MK:"EU",
        ML:"AF", MM:"AS", MN:"AS", MO:"AS", MP:"OC", MQ:"NA", MR:"AF", MS:"NA",
        MT:"EU", MU:"AF", MV:"AS", MW:"AF", MX:"NA", MY:"AS", MZ:"AF", NA:"AF",
        NC:"OC", NE:"AF", NF:"OC", NG:"AF", NI:"NA", NL:"EU", NO:"EU", NP:"AS",
        NR:"OC", NU:"OC", NZ:"OC", OM:"AS", PA:"NA", PE:"SA", PF:"OC", PG:"OC",
        PH:"AS", PK:"AS", PL:"EU", PM:"NA", PN:"OC", PR:"NA", PS:"AS", PT:"EU",
        PW:"OC", PY:"SA", QA:"AS", RE:"AF", RO:"EU", RS:"EU", RU:"EU", RW:"AF",
        SA:"AS", SB:"OC", SC:"AF", SD:"AF", SE:"EU", SG:"AS", SH:"AF", SI:"EU",
        SJ:"EU", SK:"EU", SL:"AF", SM:"EU", SN:"AF", SO:"AF", SR:"SA", SS:"AF",
        ST:"AF", SV:"NA", SX:"NA", SY:"AS", SZ:"AF", TC:"NA", TD:"AF", TF:"AN",
        TG:"AF", TH:"AS", TJ:"AS", TK:"OC", TL:"AS", TM:"AS", TN:"AF", TO:"OC",
        TR:"AS", TT:"NA", TV:"OC", TW:"AS", TZ:"AF", UA:"EU", UG:"AF", UM:"OC",
        US:"NA", UY:"SA", UZ:"AS", VA:"EU", VC:"NA", VE:"SA", VG:"NA", VI:"NA",
        VN:"AS", VU:"OC", WF:"OC", WS:"OC", XK:"EU", YE:"AS", YT:"AF", ZA:"AF",
        ZM:"AF", ZW:"AF"
    }

    /**
     * Default region seeds. Each uses `continents:` membership so the user
     * doesn't need country-level data populated to see useful groupings on
     * day one. After the parallel-scanner seeds the per-server countryIdMap,
     * users can refine into country-level membership via the settings UI.
     */
    function defaultRegions() {
        const now = Date.now()
        const mk = (id, name, continents, color) => ({
            id, name, description: "",
            colorToken: color,
            countries:  [],
            iso2Codes:  [],
            continents: continents.slice(),
            createdAt:  now,
            updatedAt:  now
        })
        return [
            mk("r-eu",    "Europe",          ["EU"],         "blue"),
            mk("r-na",    "North America",   ["NA"],         "indigo"),
            mk("r-as",    "Asia-Pacific",    ["AS", "OC"],   "rose"),
            mk("r-me",    "Middle East",     [],             "amber"),    // populated by iso2Codes after seed
            mk("r-sa",    "South America",   ["SA"],         "emerald"),
            mk("r-af",    "Africa",          ["AF"],         "orange"),
            mk("r-trans-atl", "Trans-Atlantic", [],          "sky"),       // composite — user adds matching
            mk("r-trans-pac", "Trans-Pacific",  [],          "violet")
        ]
    }

    function continentOfIso2(iso2) {
        const code = String(iso2 || "").toUpperCase()
        return COUNTRY_CONTINENT[code] || null
    }

    function listContinents() {
        return Object.values(CONTINENTS).map(c => Object.assign({}, c))
    }

    window.AesGeographyBase = {
        CONTINENTS, COUNTRY_CONTINENT,
        continentOfIso2,
        listContinents,
        defaultRegions
    }
})()
