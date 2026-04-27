"use strict"

/**
 * Flight Studio — canonical leg-spec module (Slice S1).
 *
 * One source of truth for the data atom that menu / panel / paste-import /
 * apply-batch / audit-log / flight-number-registry all share. Pure data —
 * no DOM access except `validateAgainstForm()` which is opt-in.
 *
 * Schemas:
 *
 *   FlightSpec = {
 *       schemaVersion:     1,
 *       specId:            "<id>",                     // stable across edits
 *       server:            "free1",
 *       aircraftId:        "6968",
 *       flightNumberText?: "PAA42",                    // null → AS auto-assigns
 *       nickname?:         "Boomerang",
 *       note?:             "user note",
 *       legs:              LegSpec[],                  // ≥ 1
 *       createdAt:         <ms>,
 *       updatedAt:         <ms>,
 *       source:            "manual"|"paste"|"template"|"candidate"|"vfp-edit",
 *       templateId?:       "<id>",
 *       dryRun:            true|false
 *   }
 *
 *   LegSpec = {
 *       seq:                  1..N,
 *       origin:               "MCO",                   // IATA, uppercase
 *       destination:          "KCL",                   // IATA, uppercase
 *       depTimeLocal:         "09:00",                 // "HH:MM"
 *       service?:             "" | "<option value>",
 *       pricePct?:            50..200,                 // integer percent
 *       appliedAt?:           <ms>,
 *       flightNumberAssigned?: "PAA42",                // captured post-apply
 *       flightId?:            "9135",                  // AS numeric id
 *       error?:               "..."
 *   }
 *
 * Adapters keep the rest of the codebase oblivious to this shape:
 *   toFormDriverLeg(legSpec)  → leg shape that AesAfpFormDriver.fill() wants
 *   toBatchLegs(spec)         → array shape that auto-scheduler/apply-batch wants
 *   fromCandidate(c, ctx)     → lift a route-candidates row
 *   serializeLine(spec)       → canonical paste-grammar line (round-trip with paste-import)
 *
 * No exports beyond `window.AesAfpLegSpec` — Slice S1 ships a thin facade
 * so future slices (paste-import, registry-capturer) can swap in without
 * changing call sites.
 */
;(function () {
    if (window.AesAfpLegSpec) return

    const SCHEMA_VERSION = 1
    const VALID_SOURCES  = new Set(["manual", "paste", "template", "candidate", "vfp-edit"])
    const VALID_MODES    = new Set(["dry-run", "pre-fill", "submit"])

    // ── id generation ─────────────────────────────────────────────────────
    function _genId() {
        // crypto.randomUUID is stable in Chrome ≥ 92; the AFP target browser
        // is current Chrome so we can rely on it. Fall back to a short
        // time-based id for the (currently impossible) case of unavailable
        // crypto, just to keep the surface non-throwing.
        try {
            if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
                return crypto.randomUUID()
            }
        } catch (_) { /* fall through */ }
        return "spec-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
    }

    // ── coercion helpers ─────────────────────────────────────────────────
    function _asIata(v) {
        const s = String(v == null ? "" : v).trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : null
    }

    function _asHHMM(v) {
        const s = String(v == null ? "" : v).trim()
        const m = s.match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h  = parseInt(m[1], 10)
        const mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return null
        return (h < 10 ? "0" + h : String(h)) + ":" + (mn < 10 ? "0" + mn : String(mn))
    }

    function _asPct(v) {
        if (v == null || v === "") return null
        const n = Math.round(Number(v))
        return (isFinite(n) && n >= 50 && n <= 200) ? n : null
    }

    function _asString(v) {
        return (typeof v === "string" && v.length) ? v : null
    }

    function _asFinite(v) {
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function _asSource(v) {
        return VALID_SOURCES.has(v) ? v : "manual"
    }

    // ── Public: construct ────────────────────────────────────────────────

    /**
     * Create a fresh FlightSpec. All fields optional; defaults are sane for
     * a brand-new compose session.
     */
    function createSpec(opts) {
        const o = opts || {}
        const now = Date.now()
        const baseLeg = {
            seq:          1,
            origin:       _asIata(o.origin)      || (o.originHub ? _asIata(o.originHub) : null),
            destination:  _asIata(o.destination) || null,
            depTimeLocal: _asHHMM(o.depTimeLocal) || "09:00",
            service:      _asString(o.service)   || "",
            pricePct:     _asPct(o.pricePct)     != null ? _asPct(o.pricePct) : 100
        }
        const spec = {
            schemaVersion:    SCHEMA_VERSION,
            specId:           _asString(o.specId) || _genId(),
            server:           String(o.server     || ""),
            aircraftId:       String(o.aircraftId || ""),
            flightNumberText: _asString(o.flightNumberText),
            nickname:         _asString(o.nickname),
            note:             _asString(o.note),
            legs:             Array.isArray(o.legs) && o.legs.length
                              ? o.legs.map(_normalizeLeg)
                              : [baseLeg],
            createdAt:        _asFinite(o.createdAt) || now,
            updatedAt:        _asFinite(o.updatedAt) || now,
            source:           _asSource(o.source),
            templateId:       _asString(o.templateId),
            dryRun:           o.dryRun !== false   // default true (S1 ships dry-run)
        }
        return _normalizeSpec(spec)
    }

    function _normalizeLeg(leg, idx) {
        const l = leg || {}
        const out = {
            seq:          (Number.isFinite(l.seq) && l.seq > 0) ? Math.round(l.seq) : (idx != null ? idx + 1 : 1),
            origin:       _asIata(l.origin),
            destination:  _asIata(l.destination),
            depTimeLocal: _asHHMM(l.depTimeLocal) || "09:00",
            service:      typeof l.service === "string" ? l.service : "",
            pricePct:     _asPct(l.pricePct) != null ? _asPct(l.pricePct) : 100
        }
        if (_asFinite(l.appliedAt)         != null) out.appliedAt            = _asFinite(l.appliedAt)
        if (_asString(l.flightNumberAssigned))      out.flightNumberAssigned = _asString(l.flightNumberAssigned)
        if (_asString(l.flightId))                  out.flightId             = _asString(l.flightId)
        if (_asString(l.error))                     out.error                = _asString(l.error)
        return out
    }

    /**
     * Densify `seq` (1..N), normalise each leg's fields, refresh updatedAt.
     * Idempotent.
     */
    function _normalizeSpec(spec) {
        const s = spec || {}
        const legs = Array.isArray(s.legs) ? s.legs.map(_normalizeLeg) : []
        for (let i = 0; i < legs.length; i++) legs[i].seq = i + 1
        return Object.assign({}, s, {legs, updatedAt: Date.now()})
    }

    function normalizeSpec(spec) { return _normalizeSpec(spec) }

    function cloneSpec(spec) {
        return JSON.parse(JSON.stringify(_normalizeSpec(spec)))
    }

    // ── Public: validate ─────────────────────────────────────────────────

    /**
     * Pure validation. Returns `{ok, errors[]}` where each error is
     * `{path: "legs.0.origin", reason: "missing-iata"}`. Fast — no DOM.
     */
    function validateSpec(spec) {
        const errors = []
        if (!spec || typeof spec !== "object") {
            return {ok: false, errors: [{path: "", reason: "not-an-object"}]}
        }
        if (!Array.isArray(spec.legs) || !spec.legs.length) {
            errors.push({path: "legs", reason: "no-legs"})
        }
        (spec.legs || []).forEach((leg, i) => {
            if (!_asIata(leg && leg.origin))      errors.push({path: "legs." + i + ".origin",       reason: "missing-iata"})
            if (!_asIata(leg && leg.destination)) errors.push({path: "legs." + i + ".destination",  reason: "missing-iata"})
            if (!_asHHMM(leg && leg.depTimeLocal)) errors.push({path: "legs." + i + ".depTimeLocal", reason: "bad-time"})
            if (leg && leg.pricePct != null && _asPct(leg.pricePct) == null) {
                errors.push({path: "legs." + i + ".pricePct", reason: "bad-percent"})
            }
            if (leg && leg.origin === leg.destination && _asIata(leg.origin)) {
                errors.push({path: "legs." + i, reason: "origin-equals-destination"})
            }
        })
        return {ok: errors.length === 0, errors}
    }

    /**
     * Live validation against the AS form's `<select name='origin'>`
     * options. Catches IATA codes that are spelled correctly but absent
     * from this airline's available routes. Caller passes the form
     * handles (typically from `AesAfp.getNewFlightForm()`).
     *
     * Returns `{ok, errors[]}` like validateSpec, with reasons:
     *   - "iata-not-in-airline-options"  (origin or dest not in select)
     */
    function validateAgainstForm(spec, formHandles) {
        const base = validateSpec(spec)
        if (!formHandles || !formHandles.originSelect || !formHandles.destSelect) {
            return base   // no form available — pure validation only
        }
        const errors = base.errors.slice()
        const optsByIata = (sel) => {
            const set = new Set()
            for (const opt of sel.options) {
                const m = (opt.textContent || "").match(/\(([A-Z]{3})\)/)
                if (m) set.add(m[1])
            }
            return set
        }
        const originOpts = optsByIata(formHandles.originSelect)
        const destOpts   = optsByIata(formHandles.destSelect)
        ;(spec.legs || []).forEach((leg, i) => {
            const o = _asIata(leg && leg.origin)
            const d = _asIata(leg && leg.destination)
            if (o && !originOpts.has(o)) errors.push({path: "legs." + i + ".origin",      reason: "iata-not-in-airline-options"})
            if (d && !destOpts.has(d))   errors.push({path: "legs." + i + ".destination", reason: "iata-not-in-airline-options"})
        })
        return {ok: errors.length === 0, errors}
    }

    // ── Public: adapters ─────────────────────────────────────────────────

    /**
     * Coerce a route-candidates row into a single-leg FlightSpec. Used
     * when the user clicks "Edit in Studio" on a candidate row (Slice S2+
     * UI) — for S1 we expose the adapter so paste-import can stand on it.
     */
    function fromCandidate(candidate, ctx) {
        const c = candidate || {}
        const x = ctx       || {}
        return createSpec({
            server:       x.server,
            aircraftId:   x.aircraftId,
            origin:       c.originIata || x.currentLocationIata,
            destination:  c.destIata,
            depTimeLocal: c.depTime || c.depTimeLocal,
            service:      c.service,
            pricePct:     c.pricePct,
            source:       "candidate"
        })
    }

    /**
     * Convert one LegSpec to the leg shape `AesAfpFormDriver.fill()` and
     * `dryRun()` accept — `{origin, destination, depTime, pricePct, service}`.
     * Single-leg only; for multi-leg, the panel iterates and calls fill()
     * per leg (S2 form-driver-x landing).
     */
    function toFormDriverLeg(legSpec) {
        const l = legSpec || {}
        return {
            origin:      _asIata(l.origin),
            destination: _asIata(l.destination),
            depTime:     _asHHMM(l.depTimeLocal) || undefined,
            pricePct:    _asPct(l.pricePct),
            service:     typeof l.service === "string" ? l.service : ""
        }
    }

    /**
     * Convert a multi-leg FlightSpec to the array shape that the existing
     * auto-scheduler `apply-batch.js` pipeline accepts. Each leg carries
     * the spec-level metadata sidecar (`_studio: {specId, ...}`) so the
     * S5 registry-capturer can match results back to the spec.
     */
    function toBatchLegs(spec) {
        const s = _normalizeSpec(spec || {})
        return s.legs.map((leg) => Object.assign({}, toFormDriverLeg(leg), {
            seq:    leg.seq,
            _studio: {
                specId:           s.specId,
                flightNumberText: s.flightNumberText || null,
                source:           s.source
            }
        }))
    }

    /**
     * Produce a canonical paste-grammar line. Round-trips with paste-import
     * (S3) — `parse(serialize(spec)) ≡ spec` for the supported subset.
     *
     *   "MCO 09:00 -> KCL 11:30 -> MCO 13:45 @ 100% Standard #PAA42"
     *
     * Notes:
     *   - depTimeLocal precedes each origin; the destination of the final
     *     leg has no depTime by definition (it's an arrival, not a dep).
     *   - "@ NNN%" is omitted when pricePct == 100 (the AS default).
     *   - "Standard" is the legacy label the user sees; we emit the spec's
     *     `service` value verbatim (S3 paste-import maps label → option value).
     *   - "#PAA42" is the optional flight-number text.
     */
    function serializeLine(spec) {
        const s = _normalizeSpec(spec || {})
        if (!s.legs.length) return ""
        const parts = []
        const first = s.legs[0]
        parts.push((first.origin || "???") + " " + (first.depTimeLocal || "??:??"))
        for (let i = 0; i < s.legs.length; i++) {
            const leg = s.legs[i]
            parts.push("->")
            const isLast = (i === s.legs.length - 1)
            if (isLast) {
                parts.push(leg.destination || "???")
            } else {
                parts.push(leg.destination || "???")
                const next = s.legs[i + 1]
                parts.push(next.depTimeLocal || "??:??")
            }
        }
        let line = parts.join(" ")
        const pct = _asPct(first.pricePct)
        if (pct != null && pct !== 100) line += " @ " + pct + "%"
        if (first.service && first.service !== "") line += " " + first.service
        if (s.flightNumberText) line += " #" + s.flightNumberText
        return line
    }

    // ── Public: mutation helpers ─────────────────────────────────────────

    function addLeg(spec, partial) {
        const s = _normalizeSpec(spec || {})
        const seed = partial || {}
        const tail = s.legs[s.legs.length - 1]
        const next = _normalizeLeg({
            origin:       _asIata(seed.origin)       || (tail ? tail.destination : null),
            destination:  _asIata(seed.destination)  || null,
            depTimeLocal: _asHHMM(seed.depTimeLocal) || "12:00",
            service:      typeof seed.service === "string" ? seed.service : (tail ? tail.service  : ""),
            pricePct:     _asPct(seed.pricePct)      != null ? _asPct(seed.pricePct) : (tail ? tail.pricePct : 100)
        }, s.legs.length)
        return _normalizeSpec(Object.assign({}, s, {legs: s.legs.concat([next])}))
    }

    function removeLeg(spec, idx) {
        const s = _normalizeSpec(spec || {})
        if (!Number.isFinite(idx) || idx < 0 || idx >= s.legs.length) return s
        if (s.legs.length <= 1) return s   // never empty
        const legs = s.legs.slice(0, idx).concat(s.legs.slice(idx + 1))
        return _normalizeSpec(Object.assign({}, s, {legs}))
    }

    function setLegField(spec, idx, field, value) {
        const s = _normalizeSpec(spec || {})
        if (!Number.isFinite(idx) || idx < 0 || idx >= s.legs.length) return s
        const leg = Object.assign({}, s.legs[idx])
        switch (field) {
            case "origin":       leg.origin       = _asIata(value);   break
            case "destination":  leg.destination  = _asIata(value);   break
            case "depTimeLocal": leg.depTimeLocal = _asHHMM(value) || leg.depTimeLocal; break
            case "service":      leg.service      = typeof value === "string" ? value : ""; break
            case "pricePct":     leg.pricePct     = _asPct(value) != null ? _asPct(value) : leg.pricePct; break
            default:             return s
        }
        const legs = s.legs.slice()
        legs[idx] = leg
        return _normalizeSpec(Object.assign({}, s, {legs}))
    }

    function setSpecField(spec, field, value) {
        const s = _normalizeSpec(spec || {})
        switch (field) {
            case "flightNumberText": return _normalizeSpec(Object.assign({}, s, {flightNumberText: _asString(value)}))
            case "nickname":         return _normalizeSpec(Object.assign({}, s, {nickname:         _asString(value)}))
            case "note":             return _normalizeSpec(Object.assign({}, s, {note:             _asString(value)}))
            case "dryRun":           return _normalizeSpec(Object.assign({}, s, {dryRun:           !!value}))
            default:                 return s
        }
    }

    // ── Namespace ────────────────────────────────────────────────────────
    window.AesAfpLegSpec = {
        SCHEMA_VERSION,
        VALID_SOURCES:    Array.from(VALID_SOURCES),
        VALID_MODES:      Array.from(VALID_MODES),
        createSpec,
        normalizeSpec,
        cloneSpec,
        validateSpec,
        validateAgainstForm,
        fromCandidate,
        toFormDriverLeg,
        toBatchLegs,
        serializeLine,
        addLeg,
        removeLeg,
        setLegField,
        setSpecField
    }
})()
