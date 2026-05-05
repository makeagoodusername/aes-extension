"use strict"

/**
 * Track 8 slice 8d — single read/write bridge for the shared `settings`
 * blob in chrome.storage.local.
 *
 * Each AES module owns one top-level area inside that blob:
 *
 *   chrome.storage.local["settings"] = {
 *     aircraftFlightPlan: { … },     // owned by AesAfpSettings
 *     routeAssistant:     { … },     // owned by RouteAssistantSettings
 *     scheduleManagement: { … },     // owned by SchedulePresets et al
 *     flightInfo:         { … },     // owned by content_flightInfo.js
 *     usedAircraftScanner:{ … },
 *     centralHub:         { … },
 *     …
 *   }
 *
 * The same storage contract also carries L2 account-scoped slots:
 *
 *   settings.acct.<id>.<area>
 *
 * This bridge now exposes legacy + scoped helpers and serializes every
 * write through one tail-Promise queue so same-realm callers cannot lose
 * sibling areas or scoped branches under concurrent saves.
 */
;(function (root) {
    if (!root || root.AesSettings) return

    class AesSettings {
        static SETTINGS_KEY = "settings"
        static _saveQueue = Promise.resolve()

        static _isPlainObject(value) {
            return !!value && typeof value === "object" && !Array.isArray(value)
        }

        static _resolveAccountId(accountId) {
            if (accountId != null && accountId !== "") return String(accountId)
            if (typeof root.currentAccountIdSync === "function") {
                try {
                    const id = root.currentAccountIdSync()
                    return (id != null && id !== "") ? String(id) : null
                } catch (_) {}
            }
            return null
        }

        static _readArea(settings, area) {
            const block = settings && area ? settings[area] : null
            return AesSettings._isPlainObject(block) ? block : {}
        }

        static _cloneSettings(settings) {
            if (!AesSettings._isPlainObject(settings)) return {}
            try { return JSON.parse(JSON.stringify(settings)) }
            catch (_) { return Object.assign({}, settings) }
        }

        static async _readSettingsBlob() {
            if (root.AesWriteThrough && typeof root.AesWriteThrough.get === "function") {
                const cached = await root.AesWriteThrough.get(AesSettings.SETTINGS_KEY)
                return AesSettings._cloneSettings(cached)
            }
            const data = await chrome.storage.local.get([AesSettings.SETTINGS_KEY])
            const settings = data[AesSettings.SETTINGS_KEY]
            return AesSettings._cloneSettings(settings)
        }

        static async _writeSettingsBlob(settings, eventHint) {
            const events = eventHint ? [{
                topic: "data:settings:area:saved",
                hint:  eventHint
            }] : []
            if (root.AesWriteThrough && typeof root.AesWriteThrough.put === "function") {
                await root.AesWriteThrough.put(AesSettings.SETTINGS_KEY, settings, {events})
                return
            }
            await chrome.storage.local.set({[AesSettings.SETTINGS_KEY]: settings})
            if (events.length && root.AesDataBus && typeof root.AesDataBus.emit === "function") {
                root.AesDataBus.emit(events[0].topic, events[0].hint)
            }
        }

        static _enqueueWrite(mutator, eventHint) {
            const run = async () => {
                const settings = await AesSettings._readSettingsBlob()
                const result = await mutator(settings)
                await AesSettings._writeSettingsBlob(settings, eventHint)
                return result
            }
            const pending = AesSettings._saveQueue.then(run, run)
            AesSettings._saveQueue = pending.catch(() => {})
            return pending
        }

        /**
         * Read one area block. Returns the raw stored object, or {} if the
         * area has never been written. Does NOT merge with module defaults —
         * that's the module's `_mergeXxx` helper's job.
         */
        static async getArea(area) {
            if (!area) return {}
            const settings = await AesSettings.loadAll()
            return AesSettings._readArea(settings, area)
        }

        /**
         * Read `settings.acct.<id>.<area>` when available, otherwise fall
         * back to the legacy top-level `settings.<area>` slot.
         */
        static async getAreaScoped(area, accountId) {
            if (!area) return {}
            const settings = await AesSettings.loadAll()
            const id = AesSettings._resolveAccountId(accountId)
            if (id && AesSettings._isPlainObject(settings.acct)
                    && AesSettings._isPlainObject(settings.acct[id])) {
                const scoped = settings.acct[id][area]
                if (AesSettings._isPlainObject(scoped)) return scoped
            }
            return AesSettings._readArea(settings, area)
        }

        /**
         * Write one area block back, preserving every sibling area. Pass the
         * full block you want stored — this is replace, not merge. Module
         * `save()` helpers should compute the merged value first, then call
         * this as the storage I/O step.
         */
        static async saveArea(area, block) {
            if (!area) return null
            return AesSettings._enqueueWrite((settings) => {
                settings[area] = block
                return block
            }, {
                area:      area,
                accountId: null,
                scoped:    false,
                sections:  AesSettings._isPlainObject(block) ? Object.keys(block) : []
            })
        }

        /**
         * Write to `settings.acct.<id>.<area>` when an account id is available,
         * otherwise fall back to the legacy top-level slot. Shares the same
         * queue as saveArea() so mixed legacy/scoped writes remain ordered.
         */
        static async saveAreaScoped(area, block, accountId) {
            if (!area) return null
            const id = AesSettings._resolveAccountId(accountId)
            if (!id) return AesSettings.saveArea(area, block)
            return AesSettings._enqueueWrite((settings) => {
                settings.acct = AesSettings._isPlainObject(settings.acct) ? settings.acct : {}
                settings.acct[id] = AesSettings._isPlainObject(settings.acct[id]) ? settings.acct[id] : {}
                settings.acct[id][area] = block
                return block
            }, {
                area:      area,
                accountId: id,
                scoped:    true,
                sections:  AesSettings._isPlainObject(block) ? Object.keys(block) : []
            })
        }

        /**
         * Generic deep-merge primitive. Plain objects recurse; arrays and
         * scalars from `patch` replace the corresponding value in `base`.
         * `undefined` in patch keeps base; `null` in patch sets target null.
         *
         * Module-specific `_mergeXxx` helpers can use this as a base before
         * applying their typed validation (numeric ranges, enum guards).
         */
        static deepMerge(base, patch) {
            if (patch === undefined) return base
            if (base === undefined || base === null) return patch
            if (!AesSettings._isPlainObject(base) || !AesSettings._isPlainObject(patch)) return patch
            const out = Object.assign({}, base)
            for (const k of Object.keys(patch)) {
                const pv = patch[k]
                const bv = base[k]
                if (pv === undefined) continue
                if (AesSettings._isPlainObject(bv) && AesSettings._isPlainObject(pv)) {
                    out[k] = AesSettings.deepMerge(bv, pv)
                } else {
                    out[k] = pv
                }
            }
            return out
        }

        /** Diagnostics — returns the whole `settings` blob. Avoid in hot paths. */
        static async loadAll() {
            return AesSettings._readSettingsBlob()
        }
    }

    root.AesSettings = AesSettings
})(typeof globalThis !== "undefined"
    ? globalThis
    : (typeof window !== "undefined" ? window : null))
