/**
 * Per-aircraft fuel burn estimator.
 *
 * AS computes fuel per flight as:
 *     fuel_L = cycle_L + per_km_L × distance_km
 * Then converts via world price (ASc$/l) to AS$.
 *
 * Source of constants: in-game Performance Check tool on each type's fact
 * sheet. AS does NOT expose `cycle_L` and `per_km_L` directly — they're
 * derived by running the tool on two distances and solving the linear system.
 * That's a Phase-3b scrape; for now we use a heuristic from spec data.
 *
 * **Heuristic** (calibrated against forum-published data points for Q400,
 * A220-300, A319):
 *   loadProxy   = max(seats, cargoKg / 100)   # 100 kg cargo ≈ 1 pax
 *   speedClass  = "turboprop" if speed < 700 km/h, else "jet"
 *   effFactor   = 0.4 (turboprop) or 1.0 (jet)
 *   cycle_L     = 200 + loadProxy × 4
 *   per_km_L    = loadProxy × 0.05 × effFactor
 *
 * Validation (heuristic vs. forum data):
 *   Q400 (78 seats, 667 km/h):  est 512 + 1.56 vs actual 650 + 1.26  ✓ close
 *   A220-300 (140 seats, 871):  est 760 + 7.0  vs actual ~700 + 6.18 ✓ close
 *   A319-100 (144 seats, 833):  est 776 + 7.2  vs actual ~800 + 7.75 ✓ close
 *
 * The heuristic is rough by construction. Per-type overrides (scraped from
 * Performance Check, or user-entered) are tracked in
 * `routeAssistant:fuelBurnOverride:<typeId>` and beat the heuristic.
 */
class RouteAssistantFuelBurn {
    static OVERRIDE_PREFIX = "routeAssistant:fuelBurnOverride:"

    /**
     * Returns {cycleL, perKmL, source} for a type spec. Source is "override"
     * if a stored override exists, else "heuristic". Returns null when the
     * spec lacks payload data (no seats and no cargo).
     *
     * @param {object} spec  aircraft type spec — needs typeId, seats, cargoCapacity, speed
     * @param {object} [overrides] optional Map<typeId, override> from getOverrides()
     */
    static estimate(spec, overrides) {
        if (!spec) return null
        const typeId = spec.typeId
        if (overrides && typeId != null) {
            const o = overrides.get ? overrides.get(typeId) : overrides[typeId]
            if (o && isFinite(o.cycleL) && isFinite(o.perKmL) && o.perKmL >= 0) {
                return {cycleL: Math.max(0, o.cycleL), perKmL: o.perKmL, source: "override"}
            }
        }
        return RouteAssistantFuelBurn.heuristic(spec)
    }

    static heuristic(spec) {
        const seats   = numOrNull(spec.seats)         || 0
        const cargoKg = numOrNull(spec.cargoCapacity) || 0
        const speed   = numOrNull(spec.speed)         || 800
        const loadProxy = Math.max(seats, cargoKg / 100)
        if (loadProxy <= 0) return null
        const effFactor = speed < 700 ? 0.4 : 1.0
        return {
            cycleL: 200 + loadProxy * 4,
            perKmL: loadProxy * 0.05 * effFactor,
            source: "heuristic"
        }
    }

    /**
     * Compute fuel cost for a single round-trip flight in AS$.
     *
     *   fuelL    = cycleL + perKmL × distance_km × 2   (round trip)
     *   fuelL   *= ageMult                             (age penalty)
     *   fuel$   = fuelL × priceASc / 100               (cents → AS$)
     *
     * Returns {fuelL, fuelCost, breakdown} or null when inputs insufficient.
     */
    static costPerFlight(burn, distanceKm, fuelPriceASc, ageMult) {
        if (!burn || !isFinite(distanceKm) || distanceKm <= 0) return null
        if (!isFinite(fuelPriceASc) || fuelPriceASc <= 0) return null
        const ageM = isFinite(ageMult) && ageMult > 0 ? ageMult : 1
        const distRT = distanceKm * 2
        const baseL  = burn.cycleL + burn.perKmL * distRT
        const fuelL  = baseL * ageM
        const fuelCost = fuelL * fuelPriceASc / 100
        return {
            fuelL:    fuelL,
            fuelCost: fuelCost,
            cycleL:   burn.cycleL,
            perKmL:   burn.perKmL,
            distRT:   distRT,
            ageMult:  ageM,
            priceASc: fuelPriceASc,
            source:   burn.source
        }
    }

    static async getOverrides(typeIds) {
        if (!typeIds || !typeIds.length) return new Map()
        const keys = typeIds.map(id => RouteAssistantFuelBurn.OVERRIDE_PREFIX + id)
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const v = out[k]
            if (!v) continue
            const typeId = k.substring(RouteAssistantFuelBurn.OVERRIDE_PREFIX.length)
            map.set(Number(typeId), v)
            map.set(String(typeId), v)
        }
        return map
    }

    static async saveOverride(typeId, fields) {
        if (typeId == null) return null
        const cycleL = numOrNull(fields && fields.cycleL)
        const perKmL = numOrNull(fields && fields.perKmL)
        if (cycleL === null && perKmL === null) {
            await RouteAssistantFuelBurn.removeOverride(typeId)
            return null
        }
        const key = RouteAssistantFuelBurn.OVERRIDE_PREFIX + typeId
        const record = {
            typeId:    typeId,
            cycleL:    cycleL !== null ? Math.max(0, cycleL) : 0,
            perKmL:    perKmL !== null ? Math.max(0, perKmL) : 0,
            source:    "manual",
            updatedAt: Date.now()
        }
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async removeOverride(typeId) {
        await chrome.storage.local.remove([RouteAssistantFuelBurn.OVERRIDE_PREFIX + typeId])
    }
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}
