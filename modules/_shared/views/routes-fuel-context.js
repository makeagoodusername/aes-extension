"use strict"

/**
 * Canonical view: `routes:fuel-context`
 *
 * Composes the latest fuel-price scrape with the user's RA economics
 * settings into a single derived shape that downstream consumers
 * (strategy auto-driver, scanner market-panel, RA panel) read instead of
 * re-walking storage and re-implementing the auto-scaling math.
 *
 * Deps:
 *   data:route-assistant:fuel-price:updated — produced via AesDataBus.publish,
 *     so AesDataBus.last() returns {value, unit, scrapedAt} synchronously.
 *   data:route-assistant:settings:saved   — fired on every Settings.save();
 *     subscriber re-reads via RouteAssistantSettings.load().
 *
 * Output shape:
 *   {
 *     fuelPrice: {value, unit, scrapedAt} | null,
 *     settings:  {fuelCostPerHour, autoEnabled, baseline: {cost, value, unit}},
 *     effective: {fuelCostPerHour, multiplier, basis: "auto"|"manual"|"unset"}
 *   }
 *
 * `effective.basis`:
 *   "auto"   — auto-scaling enabled, baseline calibrated, current scrape unit
 *              matches → multiplier is current/baseline.
 *   "manual" — auto disabled OR baseline missing OR unit drift → multiplier = 1.
 *   "unset"  — settings unavailable; consumer should treat as no-op.
 *
 * Falls back gracefully when scraper hasn't run yet (fuelPrice = null) or
 * when AesDataBus.peek's fetcher returns nothing (settings = null).
 */
;(function () {
    if (typeof window === "undefined") return
    if (!window.AesView || !window.AesDataBus) return
    if (window.__aesViewRoutesFuelContextDeclared) return
    window.__aesViewRoutesFuelContextDeclared = true

    AesView.declare({
        name:       "routes:fuel-context",
        deps:       [
            "data:route-assistant:fuel-price:updated",
            "data:route-assistant:settings:saved"
        ],
        debounceMs: 50,
        compute:    async () => {
            const fuelPrice = await readFuelPrice()
            const settings  = await readSettings()
            return {
                fuelPrice: fuelPrice,
                settings:  shapeSettings(settings),
                effective: deriveEffective(fuelPrice, settings)
            }
        }
    })

    async function readFuelPrice() {
        const cached = AesDataBus.last("data:route-assistant:fuel-price:updated")
        if (cached && typeof cached.value === "number") return cached
        if (typeof RouteAssistantFuelPriceScraper === "undefined") return null
        const rec = await RouteAssistantFuelPriceScraper.getCached()
        if (!rec || typeof rec.value !== "number") return null
        const value = {value: rec.value, unit: rec.unit, scrapedAt: rec.scrapedAt}
        // Seed the bus cache so subsequent consumers hit last() instead of storage.
        if (typeof AesDataBus.publish === "function") {
            AesDataBus.publish("data:route-assistant:fuel-price:updated", value)
        }
        return value
    }

    async function readSettings() {
        if (typeof RouteAssistantSettings === "undefined") return null
        try { return await RouteAssistantSettings.load() }
        catch (_) { return null }
    }

    function shapeSettings(s) {
        if (!s || !s.economics) return null
        const e = s.economics
        return {
            fuelCostPerHour: Number(e.fuelCostPerHour) || 0,
            autoEnabled:     !!e.fuelPriceAutoEnabled,
            baseline: {
                cost:  e.fuelPriceBaselineCost  != null ? Number(e.fuelPriceBaselineCost)  : null,
                value: e.fuelPriceBaselineValue != null ? Number(e.fuelPriceBaselineValue) : null,
                unit:  e.fuelPriceBaselineUnit  || null
            }
        }
    }

    function deriveEffective(fuelPrice, settings) {
        if (!settings || !settings.economics) {
            return {fuelCostPerHour: 0, multiplier: 1, basis: "unset"}
        }
        const e        = settings.economics
        const baseCost = Number(e.fuelCostPerHour) || 0
        const auto     = !!e.fuelPriceAutoEnabled
        const bV       = e.fuelPriceBaselineValue
        const bU       = e.fuelPriceBaselineUnit
        const canScale = auto && fuelPrice
            && typeof fuelPrice.value === "number" && fuelPrice.value > 0
            && typeof bV === "number" && bV > 0
            && bU && fuelPrice.unit && bU === fuelPrice.unit
        if (!canScale) {
            return {fuelCostPerHour: baseCost, multiplier: 1, basis: "manual"}
        }
        const multiplier = fuelPrice.value / bV
        return {fuelCostPerHour: baseCost * multiplier, multiplier: multiplier, basis: "auto"}
    }
})()
