"use strict"

/**
 * Account-scoped company reputation cache.
 *
 * AirlineSim exposes the airline/company identity on every page, but the
 * overall rating is only visible on dashboard / enterprise overview surfaces.
 * This store keeps the latest observed identity + rating together so strategy
 * planning can treat brand reputation as an input even when the current page
 * is staff, route, or schedule planning.
 *
 * Storage:
 *   companyReputation:latest
 *   companyReputation:acct:<accountId>:latest
 */
class AesCompanyReputationStore {
    static PREFIX = "companyReputation"
    static SUFFIX = "latest"
    static RATING_SCORE = Object.freeze({
        AAA: 10,
        AA:  9,
        A:   8,
        BBB: 7,
        BB:  6,
        B:   5,
        CCC: 4,
        CC:  3,
        C:   2,
        D:   1
    })

    static _key() {
        const ak = (typeof window !== "undefined") && window.AesAccountKey
        if (ak && typeof ak.acctKey === "function") {
            return ak.acctKey(AesCompanyReputationStore.PREFIX, AesCompanyReputationStore.SUFFIX)
        }
        return AesCompanyReputationStore.PREFIX + ":" + AesCompanyReputationStore.SUFFIX
    }

    static _legacyKey() {
        return AesCompanyReputationStore.PREFIX + ":" + AesCompanyReputationStore.SUFFIX
    }

    static normaliseRatingLabel(value) {
        if (value == null) return null
        const raw = String(value).trim().toUpperCase().replace(/[^A-Z]/g, "")
        return AesCompanyReputationStore.RATING_SCORE[raw] ? raw : null
    }

    static scoreRating(value) {
        const label = AesCompanyReputationStore.normaliseRatingLabel(value)
        return label ? AesCompanyReputationStore.RATING_SCORE[label] : null
    }

    static ratingNorm(value) {
        const score = typeof value === "number"
            ? value
            : AesCompanyReputationStore.scoreRating(value)
        if (!Number.isFinite(score)) return null
        return Math.max(0, Math.min(1, score / 10))
    }

    static _clean(fields) {
        const src = fields || {}
        const label = AesCompanyReputationStore.normaliseRatingLabel(src.ratingLabel || src.rating)
        const score = label ? AesCompanyReputationStore.scoreRating(label) : null
        const norm = AesCompanyReputationStore.ratingNorm(score)
        const now = Date.now()
        return {
            displayName:  AesCompanyReputationStore._str(src.displayName),
            airlineCode:  AesCompanyReputationStore._str(src.airlineCode || src.code),
            enterpriseId: AesCompanyReputationStore._str(src.enterpriseId || src.id),
            ratingLabel:  label,
            ratingScore:  score,
            ratingNorm:   norm,
            scrapedAt:    Number.isFinite(Number(src.scrapedAt)) ? Number(src.scrapedAt) : now,
            source:       AesCompanyReputationStore._str(src.source) || "unknown",
            server:       AesCompanyReputationStore._str(src.server)
        }
    }

    static _str(value) {
        if (value == null) return null
        const s = String(value).trim()
        return s ? s : null
    }

    static async save(fields) {
        const rec = AesCompanyReputationStore._clean(fields)
        if (!rec.displayName && !rec.airlineCode && !rec.ratingLabel) return null
        const key = AesCompanyReputationStore._key()
        await chrome.storage.local.set({[key]: rec})
        try {
            if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                window.AesDataBus.emit("data:strategy:company-reputation:saved", rec)
            }
        } catch (_) {}
        return rec
    }

    static async loadLatest() {
        const key = AesCompanyReputationStore._key()
        const legacy = AesCompanyReputationStore._legacyKey()
        const data = await chrome.storage.local.get(key === legacy ? [key] : [key, legacy])
        return data[key] || data[legacy] || null
    }

    static fromDocument(root, opts) {
        const doc = root || (typeof document !== "undefined" ? document : null)
        opts = opts || {}
        const rec = {
            displayName:  opts.displayName || null,
            airlineCode:  opts.airlineCode || opts.code || null,
            enterpriseId: opts.enterpriseId || opts.id || null,
            ratingLabel:  opts.ratingLabel || opts.rating || null,
            source:       opts.source || "document",
            server:       opts.server || null
        }
        if (typeof AES !== "undefined") {
            try {
                rec.server = rec.server || AES.getServerName()
                const airline = AES.getAirlineCode && AES.getAirlineCode()
                if (airline) {
                    rec.displayName = rec.displayName || airline.name || null
                    rec.airlineCode = rec.airlineCode || airline.code || null
                }
            } catch (_) {}
        }
        if (doc) {
            const parsed = AesCompanyReputationStore._parseDocument(doc)
            rec.displayName = rec.displayName || parsed.displayName
            rec.airlineCode = rec.airlineCode || parsed.airlineCode
            rec.ratingLabel = rec.ratingLabel || parsed.ratingLabel
        }
        return AesCompanyReputationStore._clean(rec)
    }

    static async saveFromDocument(root, opts) {
        return AesCompanyReputationStore.save(AesCompanyReputationStore.fromDocument(root, opts))
    }

    static _parseDocument(doc) {
        const out = {displayName: null, airlineCode: null, ratingLabel: null}
        const rows = doc.querySelectorAll("tr")
        for (const row of rows) {
            const cells = row.querySelectorAll("th,td")
            if (cells.length < 2) continue
            const label = (cells[0].textContent || "").trim().toLowerCase()
            const value = (cells[cells.length - 1].textContent || "").trim()
            if (!out.displayName && /^(name|airline|company|enterprise)$/.test(label)) {
                out.displayName = value || null
            }
            if (!out.airlineCode && /\b(code|iata|icao)\b/.test(label)) {
                const code = value.replace(/[^A-Za-z0-9]/g, "")
                out.airlineCode = code || null
            }
            if (!out.ratingLabel && /\brating\b/.test(label)) {
                out.ratingLabel = AesCompanyReputationStore.normaliseRatingLabel(value)
            }
        }
        if (!out.ratingLabel) {
            const fieldsets = doc.querySelectorAll(".facts table, .layout-col-md-4 > .as-fieldset table")
            for (const table of fieldsets) {
                const trs = table.querySelectorAll("tr")
                if (!trs.length) continue
                const last = trs[trs.length - 1]
                const cells = last.querySelectorAll("td,th")
                if (cells.length >= 2) {
                    out.ratingLabel = AesCompanyReputationStore.normaliseRatingLabel(
                        cells[cells.length - 1].textContent || ""
                    )
                    if (out.ratingLabel) break
                }
            }
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesCompanyReputationStore = AesCompanyReputationStore
}
