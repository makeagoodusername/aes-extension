"use strict"

/**
 * Command Bridge slice CB-2 — cross-account activity ribbon.
 *
 * Aggregates AesStrategyJournal entries across every account the
 * registry knows about (the journal is per-account scoped at
 * `aesStrategy:journal:acct:<id>` — see modules/strategy/journal-store.js).
 * Renders a single "since last visit" sentence with optional kin filter.
 *
 * Watermark: this surface keeps its OWN watermark
 * (`aes:command-bridge:activity:lastSeenAt`) — separate from the
 * per-account `aesStrategy:lastSeenAt:acct:*` keys that the in-page
 * activity strip uses. The bridge's "I've seen this" is a
 * cross-enterprise event; ack here doesn't ack any individual airline's
 * dashboard, and vice versa.
 */
class AesBridgeActivityRibbon {
    static WATERMARK_KEY = "aes:command-bridge:activity:lastSeenAt"
    static DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000
    static REFRESH_DEBOUNCE_MS = 300

    constructor(opts) {
        this.host = (opts && opts.host) || null
        this.accounts = (opts && opts.accounts) || []
        this.affiliations = (opts && opts.affiliations) || {}
        this.kinIds = (opts && opts.kinIds) || []
        this.kinLabels = (opts && opts.kinLabels) || new Map()
        this._activeFilter = null
        this._sinceTs = 0
        this._countsByAcct = new Map()
        this._refreshTimer = null
        this._storageListener = null
    }

    async mount() {
        if (!this.host) return
        this.host.innerHTML = ""

        const shell = document.createElement("div")
        shell.className = "aes-bridge__ribbon"

        const label = document.createElement("span")
        label.className = "aes-bridge__ribbon-label"
        label.textContent = "Activity"
        shell.appendChild(label)

        const sentence = document.createElement("button")
        sentence.type = "button"
        sentence.className = "aes-bridge__ribbon-sentence"
        sentence.textContent = "Loading…"
        sentence.addEventListener("click", () => this._acknowledge())
        shell.appendChild(sentence)
        this._sentenceEl = sentence

        const filter = document.createElement("div")
        filter.className = "aes-bridge__ribbon-filter"
        this._filterEl = filter
        shell.appendChild(filter)
        this._renderFilter()

        this.host.appendChild(shell)
        this._attachStorageListener()
        await this._refresh()
    }

    dispose() {
        if (this._storageListener) {
            try { chrome.storage.onChanged.removeListener(this._storageListener) }
            catch (_) { /* noop */ }
            this._storageListener = null
        }
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer)
            this._refreshTimer = null
        }
    }

    _attachStorageListener() {
        if (this._storageListener) return
        this._storageListener = (changes, area) => {
            if (area !== "local") return
            let dirty = false
            for (const k in changes) {
                if (k.indexOf("aesStrategy:journal") === 0) { dirty = true; break }
                if (k === AesBridgeActivityRibbon.WATERMARK_KEY) { dirty = true; break }
            }
            if (!dirty) return
            if (this._refreshTimer) return
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null
                this._refresh().catch(() => {})
            }, AesBridgeActivityRibbon.REFRESH_DEBOUNCE_MS)
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    async _refresh() {
        this._sinceTs = await this._loadWatermark()
        this._countsByAcct = await this._loadCountsByAccount(this._sinceTs)
        this._renderSentence()
    }

    async _loadWatermark() {
        try {
            const got = await chrome.storage.local.get([AesBridgeActivityRibbon.WATERMARK_KEY])
            const rec = got[AesBridgeActivityRibbon.WATERMARK_KEY]
            const ts = rec && Number(rec.ts)
            if (Number.isFinite(ts) && ts > 0) return ts
        } catch (_) { /* fall through */ }
        return Date.now() - AesBridgeActivityRibbon.DEFAULT_LOOKBACK_MS
    }

    /**
     * Read every `aesStrategy:journal*` key in storage in one shot, then
     * derive the accountId per key (`...:acct:<id>` segment, or null for
     * the legacy unscoped ring). Counts are per accountId so the kinId
     * filter can sum them later.
     */
    async _loadCountsByAccount(since) {
        const out = new Map()
        try {
            const all = await chrome.storage.local.get(null)
            for (const k of Object.keys(all)) {
                if (k.indexOf("aesStrategy:journal") !== 0) continue
                const ring = Array.isArray(all[k]) ? all[k] : null
                if (!ring) continue
                const accountId = AesBridgeActivityRibbon._acctIdFromKey(k)
                const counts = out.get(accountId) || {}
                for (const e of ring) {
                    const ts = Number(e && e.ts)
                    if (!Number.isFinite(ts) || ts < since) continue
                    const action = (e && e.action) || "other"
                    counts[action] = (counts[action] || 0) + 1
                }
                out.set(accountId, counts)
            }
        } catch (_) { /* ignore */ }
        return out
    }

    static _acctIdFromKey(key) {
        const m = String(key).match(/:acct:([^:]+)/)
        return m ? m[1] : null
    }

    /**
     * Resolve which kinId an accountId belongs to, by walking the
     * affiliations record set: for each "self" record whose accountId
     * matches, return its kinId. Returns null when no match (orphan).
     */
    _kinIdForAccount(accountId) {
        if (!accountId) return null
        for (const eid in this.affiliations) {
            const r = this.affiliations[eid]
            if (r && r.kind === "self" && r.accountId === accountId) return r.kinId || eid
        }
        return null
    }

    _filteredCounts() {
        const merged = {}
        for (const [accountId, counts] of this._countsByAcct.entries()) {
            if (this._activeFilter) {
                const kid = this._kinIdForAccount(accountId)
                if (this._activeFilter === "__orphans__") {
                    if (kid) continue
                } else if (kid !== this._activeFilter) {
                    continue
                }
            }
            for (const action in counts) merged[action] = (merged[action] || 0) + counts[action]
        }
        return merged
    }

    _renderSentence() {
        if (!this._sentenceEl) return
        const counts = this._filteredCounts()
        const total = Object.values(counts).reduce((s, n) => s + n, 0)
        if (!total) {
            this._sentenceEl.textContent = "Quiet since last visit"
            this._sentenceEl.classList.add("aes-bridge__ribbon-sentence--quiet")
            return
        }
        this._sentenceEl.classList.remove("aes-bridge__ribbon-sentence--quiet")
        const parts = []
        const order = ["apply-decision", "override-save", "note-save", "watchlist-toggle", "weight-change"]
        for (const action of order) {
            const n = counts[action] || 0
            if (n > 0) parts.push(AesBridgeActivityRibbon._formatCount(action, n))
        }
        const ago = AesBridgeActivityRibbon._fmtAgo(this._sinceTs)
        this._sentenceEl.textContent = "Since " + ago + ": " + parts.join(" · ") + " — click to acknowledge"
    }

    static _formatCount(action, n) {
        const plural = n === 1 ? "" : "s"
        switch (action) {
            case "apply-decision":   return n + " decision" + plural
            case "override-save":    return n + " override" + plural
            case "note-save":        return n + " note" + plural
            case "watchlist-toggle": return n + " watchlist toggle" + plural
            case "weight-change":    return n + " weight tune" + plural
            default:                 return n + " " + action
        }
    }

    static _fmtAgo(ts) {
        const d = Date.now() - Number(ts)
        if (!isFinite(d) || d < 0) return "last visit"
        if (d < 60_000)        return "moments ago"
        if (d < 3_600_000)     return Math.floor(d / 60_000) + "m ago"
        if (d < 86_400_000)    return Math.floor(d / 3_600_000) + "h ago"
        return Math.floor(d / 86_400_000) + "d ago"
    }

    _renderFilter() {
        if (!this._filterEl) return
        const wrap = this._filterEl
        wrap.innerHTML = ""
        const chips = [{id: null, label: "All"}]
        for (const kid of this.kinIds) {
            chips.push({id: kid, label: this.kinLabels.get(kid) || kid.slice(0, 8)})
        }
        chips.push({id: "__orphans__", label: "Orphans"})

        for (const c of chips) {
            const b = document.createElement("button")
            b.type = "button"
            b.className = "aes-bridge__ribbon-chip"
            b.textContent = c.label
            if (this._activeFilter === c.id || (this._activeFilter == null && c.id == null)) {
                b.classList.add("aes-bridge__ribbon-chip--on")
            }
            b.addEventListener("click", () => {
                this._activeFilter = c.id
                this._renderFilter()
                this._renderSentence()
            })
            wrap.appendChild(b)
        }
    }

    async _acknowledge() {
        try {
            await chrome.storage.local.set({
                [AesBridgeActivityRibbon.WATERMARK_KEY]: {ts: Date.now()}
            })
        } catch (_) { /* benign */ }
        await this._refresh()
    }
}

if (typeof window !== "undefined") {
    window.AesBridgeActivityRibbon = AesBridgeActivityRibbon
}
