"use strict"

/**
 * AES Strategy — Standing Orders Store (Slice 24).
 *
 * Persists user-defined standing orders / automated rules under
 * \`aesStrategy:standingOrders:acct:<id>\`.
 *
 * Shape of a rule:
 * {
 *   id: string,
 *   name: string,
 *   enabled: boolean,
 *   trigger: {
 *     type: "lf-drop" | "competitor-entry" | "yield-variance" | ...
 *     threshold: number
 *   },
 *   action: {
 *     type: "price-cut" | "price-match" | "downgauge" | "suspend"
 *     value: number
 *   },
 *   scope: {
 *     hub?: string,
 *     equipFamily?: string
 *   },
 *   requireConfirm: boolean,
 *   lastFired: number
 * }
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyStandingOrdersStore) return

    function _accountId() {
        try { return (typeof window.AesAccountKey !== "undefined" && typeof window.AesAccountKey.currentAccountIdSync === "function")
            ? window.AesAccountKey.currentAccountIdSync()
            : null
        }
        catch (_) { return null }
    }

    function _scopedKey(accountId) {
        if (!accountId) return "aesStrategy:standingOrders"
        return "aesStrategy:standingOrders:acct:" + accountId
    }

    async function load() {
        const id = _accountId()
        const key = _scopedKey(id)
        try {
            const data = await chrome.storage.local.get([key])
            const rules = data[key]
            if (Array.isArray(rules)) return rules
            return []
        } catch (e) {
            console.warn("[AesStrategyStandingOrdersStore] load failed", e)
            return []
        }
    }

    async function save(rules) {
        const id = _accountId()
        const key = _scopedKey(id)
        try {
            const writes = {}
            writes[key] = rules
            await chrome.storage.local.set(writes)
            return rules
        } catch (e) {
            console.warn("[AesStrategyStandingOrdersStore] save failed", e)
            return []
        }
    }

    async function add(rule) {
        const rules = await load()
        rule.id = rule.id || "rule-" + Date.now() + "-" + Math.floor(Math.random() * 1000)
        rules.push(rule)
        await save(rules)
        return rule
    }

    async function update(id, patch) {
        const rules = await load()
        let updated = null
        for (let i = 0; i < rules.length; i++) {
            if (rules[i].id === id) {
                rules[i] = Object.assign({}, rules[i], patch)
                updated = rules[i]
                break
            }
        }
        if (updated) await save(rules)
        return updated
    }

    async function remove(id) {
        const rules = await load()
        const filtered = rules.filter(r => r.id !== id)
        await save(filtered)
    }

    window.AesStrategyStandingOrdersStore = {
        load,
        save,
        add,
        update,
        remove
    }
})()
