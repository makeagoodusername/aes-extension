/**
 * Shared aircraft type-spec fetcher and parser.
 *
 * Loads /action/enterprise/aircraftsType?id=<typeId> and returns
 * {seats, cargoCapacity, speed, range, paxSatisfaction}. Both the used-aircraft
 * market scanner and the route-assistant need this; centralising avoids two
 * copies that drift apart.
 *
 * The detail page is server-rendered with label/value rows in Bootstrap tables.
 * Labels can vary (Seats / Capacity / PAX / Total / Cargo / Payload / Cruise
 * speed / Range / Popularity with passengers / ...) so the parser walks every
 * table row and pattern-matches on the label rather than relying on positional
 * selectors.
 *
 * Per-stat rules:
 *   seats           — rows starting with "Seats"/"Capacity"/"PAX"/"Passengers"
 *                     (or "Total Seats"); fall back to summing per-class
 *                     rows (Y/C/F) if no total. Never counts a row that
 *                     mentions "cargo" or "payload".
 *   cargoCapacity   — rows mentioning "cargo"/"payload"/"freight" — take the
 *                     largest (some pages list both "Max Payload" and
 *                     "Cargo capacity").
 *   speed           — rows mentioning "speed" (excluding "stall"); prefer
 *                     cruise/cruising speed over max speed.
 *   range           — rows mentioning "range" — take the largest (max range).
 *   paxSatisfaction — rows mentioning "popularity" (AS calls it "Popularity
 *                     with passengers") or comfort/satisfaction/rating —
 *                     take the largest numeric value.
 */
class AESAircraftTypeSpecs {
    /**
     * Fetch and parse the AS aircraft type detail page.
     * @param {number|string} typeId
     * @returns {Promise<{seats, cargoCapacity, speed, range, paxSatisfaction}|null>}
     *   null on HTTP failure or parse failure. Never throws.
     */
    static async fetchById(typeId) {
        const url = "/action/enterprise/aircraftsType?id=" + typeId
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn("AES aircraft-type-specs: HTTP " + resp.status + " for typeId=" + typeId)
                return null
            }
            const html = await resp.text()
            const doc = new DOMParser().parseFromString(html, "text/html")
            return AESAircraftTypeSpecs.parseFromDoc(doc)
        } catch (error) {
            console.warn("AES aircraft-type-specs: fetch failed", typeId, error)
            return null
        }
    }

    /**
     * Pure parser — feed it a parsed Document, get back the specs object.
     * Exposed so callers that already have the page DOM can avoid a second fetch.
     */
    static parseFromDoc(doc) {
        let seats = null
        let cargoCapacity = null
        let classSeatSum = 0
        let classSeatHits = 0
        const speedCandidates = []
        const rangeCandidates = []
        let paxSatisfaction = null

        const trs = doc.querySelectorAll("table tr")
        for (const tr of trs) {
            const cells = tr.querySelectorAll("th, td")
            if (cells.length < 2) continue
            const label = ((cells[0].textContent || "") + "").trim()
            const labelLow = label.toLowerCase()
            const valueText = (cells[cells.length - 1].textContent || "").trim()
            const num = AESAircraftTypeSpecs.parseNumber(valueText)
            if (num === null) continue

            const isCargoish   = /(cargo|payload|freight)/i.test(labelLow)
            const isSpeedish   = /\bspeed\b/i.test(labelLow) && !/stall/i.test(labelLow)
            const isRangeish   = /\brange\b/i.test(labelLow)
            const isComfortish = /\b(popularity|comfort|satisfaction|rating)\b/i.test(labelLow)
                                 && !/(cargo|payload|crew|noise)/i.test(labelLow)

            if (!isCargoish && !isSpeedish && !isRangeish && !isComfortish) {
                if (/^(?:total\s*)?(?:seats?|capacity|pax|passengers?)\b/i.test(labelLow)
                    || /\bseats?\s*(?:\(.*\))?\s*$/i.test(labelLow)) {
                    if (seats === null || num > seats) seats = num
                } else if (/^(?:y|economy|c|business|f|first)\b/i.test(labelLow)
                           && /seat|class/i.test(labelLow + " " + (cells[1].textContent || ""))) {
                    classSeatSum += num
                    classSeatHits++
                }
            }

            if (isCargoish) {
                if (cargoCapacity === null || num > cargoCapacity) cargoCapacity = num
            }

            if (isSpeedish) {
                const cruise = /cruise|cruising/i.test(labelLow)
                speedCandidates.push({num: num, cruise: cruise})
            }

            if (isRangeish) {
                rangeCandidates.push({num: num})
            }

            if (isComfortish) {
                if (paxSatisfaction === null || num > paxSatisfaction) paxSatisfaction = num
            }
        }

        if (seats === null && classSeatHits >= 1) seats = classSeatSum

        let speed = null
        if (speedCandidates.length) {
            const cruise = speedCandidates.find(c => c.cruise)
            speed = (cruise || speedCandidates[0]).num
        }

        let range = null
        if (rangeCandidates.length) {
            range = rangeCandidates.reduce((max, c) => c.num > max ? c.num : max, 0)
        }

        return {
            seats:           seats,
            cargoCapacity:   cargoCapacity,
            speed:           speed,
            range:           range,
            paxSatisfaction: paxSatisfaction
        }
    }

    /**
     * Extract the first signed number from a cell of free text. Handles thousand
     * separators (",", ".", whitespace) and decimal notation. Returns the
     * rounded integer or null when no number is found.
     */
    static parseNumber(text) {
        if (!text) return null
        const stripped = text.replace(/[^\d.,\s-]/g, " ").trim()
        if (!stripped) return null
        const m = /(-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)/.exec(stripped)
        if (!m) return null
        const cleaned = m[1].replace(/[\s,](?=\d{3}\b)/g, "").replace(/,/g, ".")
        const n = parseFloat(cleaned)
        return isFinite(n) ? Math.round(n) : null
    }
}
