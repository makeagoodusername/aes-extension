"use strict"

/**
 * Wear model — observation ring + linear regression (Track 2 slice 2b).
 *
 * AS does not publish a wear formula. We observe over time:
 *   each ~weekly cycle, record (currentRatio, currentCondition, blockHours
 *   actually flown in the trailing 7d). After 3+ samples, fit a closed-form
 *   OLS regression:
 *
 *     Δratio_per_week  =  α · weeklyBlockHours  +  β
 *
 * where Δratio_per_week is sample[i].ratio − sample[i-1].ratio, and the
 * x-feature is sample[i].weeklyBlockHours (the trailing-7d hours measured
 * AT the time of sample[i]). For the regression to be useful, samples must
 * be ~7 days apart so the trailing-7d window aligns with the inter-sample
 * interval.
 *
 * Equilibrium is the weekly hours rate that holds ratio steady (Δratio = 0):
 *
 *     equilibriumWeeklyBlockHours  =  −β / α       (only meaningful when α < 0)
 *
 * α >= 0 means the regression failed to detect the expected wear-with-flying
 * relationship — too few samples, near-constant flying intensity across
 * samples, or noise. We surface that as `valid: false` and callers fall
 * back to the settings-based budget.
 *
 *   aircraftFlightPlan:wearObservations:<server>:<aircraftId> →
 *     {server, aircraftId,
 *      samples: [
 *        {at, ratio, condition,
 *         weeklyBlockHours, weeklyBlockHoursSource}
 *      ],
 *      updatedAt}
 *
 * Ring buffer cap 12 (≈ a quarter of weekly samples — enough to smooth
 * outliers, recent enough that the regression follows the current schedule
 * shape). Newest-first.
 *
 * Sampling cadence is auto-driven: this module subscribes to
 * `chrome.storage.onChanged` for the maintenance key, and on each change,
 * if 6.5 days have elapsed since the last sample, takes a new one.
 *
 * Public API:
 *   WearModel.fit(server, aircraftId)              -> Fit
 *   WearModel.loadSamples(server, aircraftId)      -> Sample[]
 *   WearModel.maybeRecordSample(server, aircraftId, weeklyBlockHoursOpt)
 *                                                  -> Sample | null
 *
 * Bus events emitted (when AesAfp bus is present):
 *   "wear:updated" {sample} — fired after a sample is recorded
 */
;(function () {
    if (window.AesAfpWearModel) return

    const PREFIX             = "aircraftFlightPlan:wearObservations:"
    const SAMPLES_CAP        = 12
    const MIN_SAMPLES_TO_FIT = 3
    const SAMPLE_INTERVAL_MS = 6.5 * 24 * 3600 * 1000   // a bit under 7d
    const MAINT_PREFIX       = "aircraftFlightPlan:maintenance:"

    function _key(server, aircraftId) {
        return PREFIX + String(server || "") + ":" + String(aircraftId || "")
    }

    function _empty(server, aircraftId) {
        return {
            server:     String(server || ""),
            aircraftId: String(aircraftId || ""),
            samples:    [],
            updatedAt:  null
        }
    }

    async function _loadRecord(server, aircraftId) {
        if (!server || !aircraftId) return _empty(server, aircraftId)
        const out = await chrome.storage.local.get([_key(server, aircraftId)])
        const rec = out[_key(server, aircraftId)]
        if (!rec || typeof rec !== "object") return _empty(server, aircraftId)
        return {
            server:     rec.server     || String(server),
            aircraftId: rec.aircraftId || String(aircraftId),
            samples:    Array.isArray(rec.samples) ? rec.samples : [],
            updatedAt:  isFinite(rec.updatedAt) ? rec.updatedAt : null
        }
    }

    async function loadSamples(server, aircraftId) {
        return (await _loadRecord(server, aircraftId)).samples
    }

    /**
     * Closed-form OLS over consecutive sample pairs. `samples` is newest-
     * first; we walk it oldest→newest so the Δratio direction matches the
     * passage of time.
     */
    function _fitFromSamples(samples) {
        const out = {
            slope:                       null,
            intercept:                   null,
            equilibriumWeeklyBlockHours: null,
            sampleCount:                 (samples || []).length,
            pairCount:                   0,
            valid:                       false,
            reason:                      ""
        }
        if (!samples || samples.length < MIN_SAMPLES_TO_FIT) {
            out.reason = "need-more-samples"
            return out
        }

        const ordered = samples.slice().reverse()  // oldest first
        const xs = []
        const ys = []
        for (let i = 1; i < ordered.length; i++) {
            const prev = ordered[i - 1]
            const cur  = ordered[i]
            if (!prev || !cur) continue
            const x = Number(cur.weeklyBlockHours)
            if (!isFinite(x) || x < 0) continue
            const dy = Number(cur.ratio) - Number(prev.ratio)
            if (!isFinite(dy)) continue
            xs.push(x)
            ys.push(dy)
        }
        out.pairCount = xs.length
        if (xs.length < 2) { out.reason = "need-more-pairs"; return out }

        let xMean = 0, yMean = 0
        for (let i = 0; i < xs.length; i++) { xMean += xs[i]; yMean += ys[i] }
        xMean /= xs.length; yMean /= xs.length

        let num = 0, den = 0
        for (let i = 0; i < xs.length; i++) {
            const dx = xs[i] - xMean
            num += dx * (ys[i] - yMean)
            den += dx * dx
        }
        if (den === 0) { out.reason = "x-degenerate"; return out }

        const slope = num / den
        const intercept = yMean - slope * xMean
        out.slope = slope
        out.intercept = intercept

        if (!(slope < 0)) { out.reason = "non-negative-slope"; return out }

        out.equilibriumWeeklyBlockHours = -intercept / slope
        out.valid = true
        return out
    }

    async function fit(server, aircraftId) {
        const samples = await loadSamples(server, aircraftId)
        return _fitFromSamples(samples)
    }

    async function _appendSample(server, aircraftId, sample) {
        const rec = await _loadRecord(server, aircraftId)
        let samples = rec.samples.slice()
        samples.unshift(sample)
        if (samples.length > SAMPLES_CAP) samples = samples.slice(0, SAMPLES_CAP)
        const next = {
            server:     String(server),
            aircraftId: String(aircraftId),
            samples,
            updatedAt:  Date.now()
        }
        await chrome.storage.local.set({[_key(server, aircraftId)]: next})
        return next
    }

    /**
     * Take a new sample if and only if 6.5d have passed since the last one
     * AND we have a maintenance reading AND we can compute weeklyBlockHours.
     * Returns the recorded sample, or null when any guard skipped the write.
     *
     * The cadence guard runs first — without it, every Wicket-driven
     * maintenance:scraped event would force a fresh distance-resolver pass
     * that's then discarded.
     */
    async function maybeRecordSample(server, aircraftId, opts) {
        if (!server || !aircraftId) return null
        const rec = await _loadRecord(server, aircraftId)
        const last = rec.samples[0]
        const now = Date.now()
        if (last && isFinite(last.at) && (now - last.at) < SAMPLE_INTERVAL_MS) {
            return null
        }

        if (typeof AesAfpMaintenanceStore === "undefined") return null
        const maint = await AesAfpMaintenanceStore.load(server, aircraftId)
        if (!isFinite(maint.ratio)) return null

        let weeklyBlockHours = null
        let source = null
        if (typeof AesAfpFlightLogStore !== "undefined") {
            const fromLog = await AesAfpFlightLogStore.weeklyBlockHours(server, aircraftId, now)
            if (fromLog != null) { weeklyBlockHours = fromLog; source = "flight-log" }
        }
        if (weeklyBlockHours == null && (opts && opts.spec)) {
            const fromVfp = await scheduledWeeklyBlockHours(opts.spec)
            if (fromVfp != null) { weeklyBlockHours = fromVfp; source = "scheduled-vfp" }
        }
        if (weeklyBlockHours == null) return null

        const sample = {
            at:                     now,
            ratio:                  Number(maint.ratio),
            condition:              isFinite(maint.condition) ? Number(maint.condition) : null,
            weeklyBlockHours,
            weeklyBlockHoursSource: source
        }
        await _appendSample(server, aircraftId, sample)
        if (window.AesAfp && window.AesAfp.bus) {
            try { AesAfp.bus.emit("wear:updated", {sample}) }
            catch (_) { /* noop */ }
        }
        return sample
    }

    /**
     * Resolve {server, aircraftId} from the current page URL. Returns null
     * off the per-aircraft pages — wear-model is registered on both /0 and
     * /1, but storage events fire from anywhere; only act on the relevant
     * pages so we don't take a sample on the Fleet Hub.
     */
    function _onPageCtx() {
        const m = window.location.pathname.match(/\/aircraft\/(\d+)/)
        if (!m) return null
        let server = ""
        try { server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : "" }
        catch (_) { server = "" }
        if (!server) return null
        return {server, aircraftId: m[1]}
    }

    /**
     * Compute weeklyBlockHours from the live Visual Flight Plan via the
     * distance-resolver cache (single bulk read — no scraping fan-out from
     * this hot path). Returns null off-/0 (no AesAfp / VFP DOM) or when
     * any dependency is missing.
     */
    async function scheduledWeeklyBlockHours(spec) {
        if (!window.AesAfp || typeof AesAfp.getCurrentSchedule !== "function") return null
        const ctx = AesAfp.ctx
        if (!ctx || !ctx.currentLocationIata) return null
        if (!spec || !isFinite(spec.cruiseSpeedKmh) || spec.cruiseSpeedKmh <= 0) return null
        if (typeof RouteAssistantDistanceResolver === "undefined") return null

        const legs = AesAfp.getCurrentSchedule()
        if (!Array.isArray(legs) || !legs.length) return null

        const hub = String(ctx.currentLocationIata).toUpperCase()
        const pairs = []
        for (const leg of legs) {
            if (!leg || !leg.destination) continue
            const dest = String(leg.destination).toUpperCase()
            if (/^[A-Z]{3}$/.test(dest)) pairs.push([hub, dest])
        }
        if (!pairs.length) return null

        const cache = await RouteAssistantDistanceResolver.bulkLoadCache(pairs)
        let totalMin = 0
        for (const [a, b] of pairs) {
            const key = RouteAssistantDistanceResolver._pairKey(a, b)
            const rec = cache.get(key)
            const km  = rec && rec.distanceKm
            if (!isFinite(km) || km <= 0) continue
            totalMin += (km / spec.cruiseSpeedKmh) * 60
        }
        return totalMin > 0 ? totalMin / 60 : null
    }

    /**
     * Maintenance-storage listener: trigger a sample-attempt whenever the
     * sidebar scraper writes a fresh reading for the aircraft we're on.
     * The VFP spec is supplied so maybeRecordSample can fall back to
     * scheduled-VFP hours when the flight log is short.
     */
    function _attachStorageListener() {
        chrome.storage.onChanged.addListener(async (changes, area) => {
            if (area !== "local") return
            const ctx = _onPageCtx()
            if (!ctx) return
            const wantedKey = MAINT_PREFIX + ctx.server + ":" + ctx.aircraftId
            if (!Object.prototype.hasOwnProperty.call(changes, wantedKey)) return
            try {
                const spec = (window.AesAfpSpecResolver && AesAfpSpecResolver.last) || null
                await maybeRecordSample(ctx.server, ctx.aircraftId, {spec})
            } catch (e) {
                console.warn("[AES AFP wear-model] sample attempt failed", e)
            }
        })
    }

    const AesAfpWearModel = {
        fit,
        loadSamples,
        maybeRecordSample,
        scheduledWeeklyBlockHours
    }
    window.AesAfpWearModel = AesAfpWearModel

    _attachStorageListener()
})()
