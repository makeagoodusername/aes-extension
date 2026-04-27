"use strict"

/**
 * Settings for the Competitor Intelligence module. One cross-server blob at
 * `competitorIntel:settings` (the data the user wants tweaked is the same
 * regardless of which AS world they're playing). All numeric inputs are
 * clamped on save so a hand-edited storage value can't put the bulk scanner
 * into an unsafe state.
 */
class AesCompetitorSettings {
    static KEY = "competitorIntel:settings"

    static CONCURRENCY_MAX = 5

    static _defaults() {
        return {
            autoScrapeOnVisit: true,
            ttls: {
                airportDays: 7,
                enterpriseDeepDays: 14,
                profileCacheHours: 6
            },
            scan: {
                concurrency: 3,
                staggerMs: 800
            },
            ui: {
                showAllianceLogos: true,
                showFreshnessPill: true,
                defaultSort: "weeklyDepartures"
            }
        }
    }

    static async load() {
        const data = await chrome.storage.local.get([AesCompetitorSettings.KEY])
        const stored = data[AesCompetitorSettings.KEY] || {}
        const defaults = AesCompetitorSettings._defaults()
        return {
            autoScrapeOnVisit: typeof stored.autoScrapeOnVisit === "boolean"
                ? stored.autoScrapeOnVisit : defaults.autoScrapeOnVisit,
            ttls: Object.assign({}, defaults.ttls, stored.ttls || {}),
            scan: Object.assign({}, defaults.scan, stored.scan || {}),
            ui: Object.assign({}, defaults.ui, stored.ui || {})
        }
    }

    static _clampInt(v, min, max, fallback) {
        const n = parseInt(v, 10)
        if (!isFinite(n)) return fallback
        return Math.max(min, Math.min(max, n))
    }

    static async save(updates) {
        const current = await AesCompetitorSettings.load()
        const merged = {
            autoScrapeOnVisit: typeof updates.autoScrapeOnVisit === "boolean"
                ? updates.autoScrapeOnVisit : current.autoScrapeOnVisit,
            ttls: Object.assign({}, current.ttls, updates.ttls || {}),
            scan: Object.assign({}, current.scan, updates.scan || {}),
            ui:   Object.assign({}, current.ui,   updates.ui   || {})
        }
        merged.ttls.airportDays = AesCompetitorSettings._clampInt(merged.ttls.airportDays, 1, 90, 7)
        merged.ttls.enterpriseDeepDays = AesCompetitorSettings._clampInt(merged.ttls.enterpriseDeepDays, 1, 90, 14)
        merged.ttls.profileCacheHours = AesCompetitorSettings._clampInt(merged.ttls.profileCacheHours, 1, 168, 6)
        merged.scan.concurrency = AesCompetitorSettings._clampInt(merged.scan.concurrency, 1, AesCompetitorSettings.CONCURRENCY_MAX, 3)
        merged.scan.staggerMs = AesCompetitorSettings._clampInt(merged.scan.staggerMs, 0, 10000, 800)

        await chrome.storage.local.set({[AesCompetitorSettings.KEY]: merged})
        return merged
    }

    /** Convenience helpers for callers that only need TTLs in ms. */
    static airportTtlMs(settings) {
        return (settings && settings.ttls && settings.ttls.airportDays || 7) * 86400000
    }
    static enterpriseDeepTtlMs(settings) {
        return (settings && settings.ttls && settings.ttls.enterpriseDeepDays || 14) * 86400000
    }
    static profileCacheTtlMs(settings) {
        return (settings && settings.ttls && settings.ttls.profileCacheHours || 6) * 3600000
    }
}

/**
 * Inline settings UI used by both airport and enterprise panels. Returns
 * a `<details>` element so open/closed state is handled natively. The
 * Save button writes through `AesCompetitorSettings.save` (which clamps
 * everything) and invokes the caller's `onSave(updates)` so the host
 * cache stays in sync without a full panel re-render.
 */
class AesCompetitorSettingsUi {
    static build({settings, onSave}) {
        const root = document.createElement("details")
        root.className = "aes-competitor-settings"
        const summary = document.createElement("summary")
        summary.textContent = "Settings"
        root.appendChild(summary)

        const form = document.createElement("div")
        form.className = "aes-competitor-settings-form"

        const cur = settings || {
            autoScrapeOnVisit: true,
            ttls: {airportDays: 7, enterpriseDeepDays: 14, profileCacheHours: 6},
            scan: {concurrency: 3, staggerMs: 800}
        }

        const auto = AesCompetitorSettingsUi._field({
            label: "Auto-scrape on visit",
            type: "checkbox",
            checked: !!cur.autoScrapeOnVisit
        })
        const conc = AesCompetitorSettingsUi._field({
            label: "Scan concurrency (1–" + AesCompetitorSettings.CONCURRENCY_MAX + ")",
            type: "number",
            value: cur.scan && cur.scan.concurrency,
            min: 1, max: AesCompetitorSettings.CONCURRENCY_MAX
        })
        const stag = AesCompetitorSettingsUi._field({
            label: "Stagger (ms)",
            type: "number",
            value: cur.scan && cur.scan.staggerMs,
            min: 0, max: 10000
        })
        const aTtl = AesCompetitorSettingsUi._field({
            label: "Airport TTL (days)",
            type: "number",
            value: cur.ttls && cur.ttls.airportDays,
            min: 1, max: 90
        })
        const eTtl = AesCompetitorSettingsUi._field({
            label: "Enterprise deep TTL (days)",
            type: "number",
            value: cur.ttls && cur.ttls.enterpriseDeepDays,
            min: 1, max: 90
        })

        form.append(auto.row, conc.row, stag.row, aTtl.row, eTtl.row)

        const status = document.createElement("span")
        status.className = "aes-competitor-settings-status"

        const save = document.createElement("button")
        save.type = "button"
        save.className = "aes-competitor-button-bulk"
        save.textContent = "Save"
        save.addEventListener("click", async () => {
            save.disabled = true
            status.textContent = "Saving…"
            try {
                const updates = {
                    autoScrapeOnVisit: auto.input.checked,
                    scan: {
                        concurrency: parseInt(conc.input.value, 10),
                        staggerMs:   parseInt(stag.input.value, 10)
                    },
                    ttls: {
                        airportDays:        parseInt(aTtl.input.value, 10),
                        enterpriseDeepDays: parseInt(eTtl.input.value, 10)
                    }
                }
                if (onSave) await onSave(updates)
                status.textContent = "Saved"
                setTimeout(() => { status.textContent = "" }, 2000)
            } catch (e) {
                console.warn("[AES competitor-intel] settings save failed:", e)
                status.textContent = "Save failed"
            } finally {
                save.disabled = false
            }
        })

        const actions = document.createElement("div")
        actions.className = "aes-competitor-settings-actions"
        actions.append(save, status)
        form.appendChild(actions)
        root.appendChild(form)
        return root
    }

    static _field({label, type, value, checked, min, max}) {
        const row = document.createElement("label")
        row.className = "aes-competitor-settings-row"
        const text = document.createElement("span")
        text.textContent = label
        const input = document.createElement("input")
        input.type = type
        if (type === "checkbox") input.checked = !!checked
        else if (value != null) input.value = value
        if (min != null) input.min = min
        if (max != null) input.max = max
        row.appendChild(text)
        row.appendChild(input)
        return {row, input}
    }
}
