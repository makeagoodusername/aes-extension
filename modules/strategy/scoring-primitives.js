"use strict"

/**
 * AES Strategy — shared scoring primitives.
 *
 * Pure helpers used by both the auto-scheduler's per-aircraft objective
 * (`auto-scheduler/objective.js`) and the strategy layer's per-route
 * scoring + fleet allocator. Keeping them in one place means the
 * strategy and the allocator can never silently disagree on what
 * `flightTimeMin` or `fuelKgPerLeg` mean.
 *
 * No DOM, no chrome.storage. Every function deterministic given inputs.
 *
 * Public API (window.AesStrategyScoring):
 *   KG_PER_LITRE_JETA
 *   num(v, fallback?)         → finite-or-fallback
 *   clamp(v, lo, hi)
 *   clamp01(v)
 *   flightTimeMin(distanceKm, cruiseSpeedKmh, taxiMin?)
 *   arrivalMin(depMin, blockMin)
 *   fuelKgPerLeg(distanceKm, fuelBurn)         using {cycleL, perKmL}
 *   fuelCostPerKgFromASc(fuelPriceASc)
 *   distanceFactor(distanceNm, satNm, floor)
 *   greatCircleKm({lat1, lon1}, {lat2, lon2})  — for future hub designer
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyScoring) return

    const KG_PER_LITRE_JETA = 0.8       // mirrors auto-scheduler/objective.js:42
    const KM_PER_NM         = 1.852
    const TAXI_MIN_DEFAULT  = 20         // pre-pushback + post-landing taxi assumption
    const EARTH_RADIUS_KM   = 6371

    function num(v, fallback) {
        const n = Number(v)
        return isFinite(n) ? n : fallback
    }

    function clamp(v, lo, hi) {
        if (v < lo) return lo
        if (v > hi) return hi
        return v
    }

    function clamp01(v) { return clamp(num(v, 0), 0, 1) }

    function flightTimeMin(distanceKm, cruiseSpeedKmh, taxiMin) {
        const km    = num(distanceKm, NaN)
        const speed = num(cruiseSpeedKmh, NaN)
        if (!isFinite(km) || km <= 0)       return null
        if (!isFinite(speed) || speed <= 0) return null
        const cruiseMin = (km / speed) * 60
        const taxi      = num(taxiMin, TAXI_MIN_DEFAULT)
        return Math.round(cruiseMin + taxi)
    }

    function arrivalMin(depMin, blockMin) {
        const d = num(depMin, NaN)
        const b = num(blockMin, NaN)
        if (!isFinite(d) || !isFinite(b)) return null
        return (d + b) % (24 * 60)
    }

    function fuelKgPerLeg(distanceKm, fuelBurn) {
        const km = num(distanceKm, 0)
        if (km <= 0 || !fuelBurn) return 0
        const cycleL = num(fuelBurn.cycleL, 0)
        const perKmL = num(fuelBurn.perKmL, 0)
        const fuelL  = cycleL + perKmL * km
        return fuelL * KG_PER_LITRE_JETA
    }

    function fuelCostPerKgFromASc(fuelPriceASc) {
        const v = num(fuelPriceASc, NaN)
        if (!isFinite(v) || v <= 0) return null
        return (v / 100) / KG_PER_LITRE_JETA
    }

    function distanceFactor(distanceNm, satNm, floor) {
        const sat = Math.max(1, num(satNm, 2500))
        const flr = clamp(num(floor, 0.2), 0, 1)
        return clamp(num(distanceNm, 0) / sat, flr, 1)
    }

    function kmFromNm(nm)  { return num(nm, 0) * KM_PER_NM }
    function nmFromKm(km)  { return num(km, 0) / KM_PER_NM }

    function greatCircleKm(a, b) {
        if (!a || !b) return null
        const lat1 = num(a.lat,  NaN), lon1 = num(a.lon,  NaN)
        const lat2 = num(b.lat,  NaN), lon2 = num(b.lon,  NaN)
        if (![lat1, lon1, lat2, lon2].every(isFinite)) return null
        const φ1 = lat1 * Math.PI / 180
        const φ2 = lat2 * Math.PI / 180
        const dφ = (lat2 - lat1) * Math.PI / 180
        const dλ = (lon2 - lon1) * Math.PI / 180
        const sinDφ = Math.sin(dφ / 2)
        const sinDλ = Math.sin(dλ / 2)
        const h = sinDφ * sinDφ + Math.cos(φ1) * Math.cos(φ2) * sinDλ * sinDλ
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
    }

    window.AesStrategyScoring = {
        KG_PER_LITRE_JETA, KM_PER_NM, TAXI_MIN_DEFAULT,
        num, clamp, clamp01,
        flightTimeMin, arrivalMin,
        fuelKgPerLeg, fuelCostPerKgFromASc,
        distanceFactor, kmFromNm, nmFromKm,
        greatCircleKm
    }
})()
