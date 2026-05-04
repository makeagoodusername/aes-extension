/**
 * Storage wrapper for accounting-page snapshots scraped from
 * `/app/finance/accounting/{0,1,2}` (Income Statement, Balance Sheet, Bank
 * Account) and the four sister-page records added in slice 2 (leasing,
 * capital, assets, cashflow).
 *
 * Keys follow the AES convention `<server><airlineCode>accounting:<type>:<id>`,
 * mirroring `modules/schedule-management/schedule-store.js`. Per-tab snapshots
 * are keyed by financial-week-close-date so each scrape during the same week
 * overwrites the previous in-flight snapshot, giving the user one stable
 * record per finalised week. Sister-page records are single overwrite-on-write
 * blobs (leasing, capital, assets, cashflow) — they're not period-stamped.
 *
 * The index at `<server><airlineCode>accounting:index` carries a summary list
 * (newest first) so the panel can render the history without scanning every
 * key. Capped at MAX_HISTORY = 200; older snapshot rows are pruned FIFO on
 * the next save.
 */
class AccountingSnapshotStore {
    static MAX_HISTORY = 200

    static TAB_TYPES = ["income", "balance", "bank"]
    static SISTER_TYPES = ["leasing", "capital", "assets", "cashflow"]

    static _tabKey(server, airline, type, weekId) {
        return server + airline + "accounting:" + type + ":" + weekId
    }

    static _sisterKey(server, airline, type) {
        return server + airline + "accounting:" + type
    }

    static _indexKey(server, airline) {
        return server + airline + "accounting:index"
    }

    /**
     * Persists one tab's scrape under its weekId and updates the index entry.
     * If three tabs ship under the same weekId, the index entry's hasIncome /
     * hasBalance / hasBank flags accumulate so the user can tell which tabs
     * have already been visited for that week.
     *
     * @param {object} args - {server, airline, weekId, type, payload, weekClosesAt}
     */
    static async saveTab(args) {
        const {server, airline, weekId, type, payload, weekClosesAt} = args
        if (!server || !airline || !weekId || !type) return
        if (!AccountingSnapshotStore.TAB_TYPES.includes(type)) return

        const key = AccountingSnapshotStore._tabKey(server, airline, type, weekId)
        const indexKey = AccountingSnapshotStore._indexKey(server, airline)
        const data = await chrome.storage.local.get([indexKey])
        const index = data[indexKey] || []

        const record = {
            weekId,
            weekClosesAt: weekClosesAt || weekId,
            type,
            scrapedAt: Date.now(),
            payload
        }

        let entry = index.find(e => e.weekId === weekId)
        if (!entry) {
            entry = {weekId, weekClosesAt: weekClosesAt || weekId}
            index.unshift(entry)
        }
        entry.scrapedAt = Date.now()
        entry["has" + type[0].toUpperCase() + type.slice(1)] = true

        index.sort((a, b) => (b.weekClosesAt || "").localeCompare(a.weekClosesAt || ""))

        const trimmed = index.slice(0, AccountingSnapshotStore.MAX_HISTORY)
        const dropped = index.slice(AccountingSnapshotStore.MAX_HISTORY)
        const droppedKeys = []
        for (const e of dropped) {
            for (const t of AccountingSnapshotStore.TAB_TYPES) {
                droppedKeys.push(AccountingSnapshotStore._tabKey(server, airline, t, e.weekId))
            }
        }

        await chrome.storage.local.set({[key]: record, [indexKey]: trimmed})
        if (droppedKeys.length) await chrome.storage.local.remove(droppedKeys)
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:accounting:snapshot:updated", {
                server, airline, weekId, type
            })
        }
    }

    /** Returns one tab's record, or null. */
    static async loadTab(server, airline, weekId, type) {
        const key = AccountingSnapshotStore._tabKey(server, airline, type, weekId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    /**
     * Loads the full set of tab records for one weekId. Returns
     * `{weekId, income, balance, bank}` with `null` for any tab not yet
     * scraped.
     */
    static async loadWeek(server, airline, weekId) {
        const keys = AccountingSnapshotStore.TAB_TYPES
            .map(t => AccountingSnapshotStore._tabKey(server, airline, t, weekId))
        const data = await chrome.storage.local.get(keys)
        const result = {weekId}
        for (const t of AccountingSnapshotStore.TAB_TYPES) {
            const k = AccountingSnapshotStore._tabKey(server, airline, t, weekId)
            result[t] = data[k] || null
        }
        return result
    }

    /** Returns the index list (newest first). Each entry is a summary. */
    static async loadIndex(server, airline) {
        const key = AccountingSnapshotStore._indexKey(server, airline)
        const data = await chrome.storage.local.get([key])
        return data[key] || []
    }

    /** Returns the most-recent week's record set, or null when index empty. */
    static async loadLatest(server, airline) {
        const index = await AccountingSnapshotStore.loadIndex(server, airline)
        if (!index.length) return null
        return AccountingSnapshotStore.loadWeek(server, airline, index[0].weekId)
    }

    /** Persists one of the four sister-page records (single record, overwrite). */
    static async saveSister(server, airline, type, payload) {
        if (!AccountingSnapshotStore.SISTER_TYPES.includes(type)) return
        const key = AccountingSnapshotStore._sisterKey(server, airline, type)
        await chrome.storage.local.set({[key]: {type, scrapedAt: Date.now(), payload}})
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:accounting:snapshot:updated", {
                server, airline, type, sister: true
            })
        }
    }

    /** Returns one sister-page record, or null. */
    static async loadSister(server, airline, type) {
        const key = AccountingSnapshotStore._sisterKey(server, airline, type)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    /** Returns all sister records as `{leasing, capital, assets, cashflow}`. */
    static async loadAllSisters(server, airline) {
        const keys = AccountingSnapshotStore.SISTER_TYPES
            .map(t => AccountingSnapshotStore._sisterKey(server, airline, t))
        const data = await chrome.storage.local.get(keys)
        const result = {}
        for (const t of AccountingSnapshotStore.SISTER_TYPES) {
            result[t] = data[AccountingSnapshotStore._sisterKey(server, airline, t)] || null
        }
        return result
    }

    /** Wipes every accounting record for the airline. */
    static async clear(server, airline) {
        const indexKey = AccountingSnapshotStore._indexKey(server, airline)
        const data = await chrome.storage.local.get([indexKey])
        const index = data[indexKey] || []
        const keys = []
        for (const e of index) {
            for (const t of AccountingSnapshotStore.TAB_TYPES) {
                keys.push(AccountingSnapshotStore._tabKey(server, airline, t, e.weekId))
            }
        }
        for (const t of AccountingSnapshotStore.SISTER_TYPES) {
            keys.push(AccountingSnapshotStore._sisterKey(server, airline, t))
        }
        keys.push(indexKey)
        await chrome.storage.local.remove(keys)
    }
}

if (typeof window !== "undefined") {
    window.AccountingSnapshotStore = AccountingSnapshotStore
}
