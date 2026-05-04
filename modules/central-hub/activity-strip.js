"use strict"

/**
 * CentralHubActivityStrip — single-line "since last visit" sentence mounted
 * between the hub's top bar and the hero strip. Aggregates counts of
 * journaled actions (override-save, note-save, watchlist-toggle,
 * apply-decision, weight-change) since the user's last acknowledged visit.
 *
 * Click semantics: jumps to the most-relevant tile based on the dominant
 * action type AND advances the lastSeenAt watermark so the sentence
 * resets. Until the user clicks (or the briefing tile's "Mark as read"
 * is used), the sentence is stable across page reloads (intentional —
 * the user must explicitly mark-as-read).
 *
 * Data source: AesStrategyJournal.loadAll() — the per-account ring (cap 750)
 * already populated by override / note / watchlist / apply / weight writes.
 * No new storage writes from the strip itself except the timestamp on click.
 *
 * Storage (read + write): SHARED with strategy-briefing-tile per the §4
 * stable-contract note that "any future since-last-visit surface should
 * read this same key rather than maintaining its own watermark":
 *   aesStrategy:lastSeenAt:acct:<accountId>     ← Class B
 *   aesStrategy:lastSeenAt                      ← legacy unscoped
 *
 * Shape `{ts, weekId}` matches the briefing tile's writer; activity-strip
 * sets `weekId: null` since it has no briefing context. Clicking either
 * surface advances the watermark for both — by design, since "I've seen
 * what changed" is one user intent regardless of which surface they
 * acknowledged it from.
 *
 * Cold-start safe: if AesStrategyJournal isn't loaded (older session, partial
 * mount), the strip renders "—" and a muted placeholder; no errors thrown.
 * Mounts both under the standard hero strip and under the cubist polyhedron
 * (the strip sits above the hero, independent of which hero variant renders).
 */
class CentralHubActivityStrip {
    static REFRESH_DEBOUNCE_MS = 300
    static DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000

    constructor(opts) {
        this.server  = (opts && opts.server)  || ""
        this.airline = (opts && opts.airline) || ""
        this.root = null
        this.sentenceEl = null
        this._storageListener = null
        this._refreshTimer = null
        this._sinceTs = 0
        this._counts = null
    }

    mount() {
        const T = window.AESTokens

        const root = document.createElement("button")
        root.type = "button"
        root.className = "aes-central-hub__activity"
        root.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:flex-start",
            "gap:" + T.sp[2],
            "padding:" + T.sp[2] + " " + T.sp[4],
            "background:" + T.color.bone2,
            "color:" + T.color.slate,
            "border:0",
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-align:left",
            "text-transform:uppercase",
            "cursor:pointer",
            "width:100%",
            "box-sizing:border-box",
            "transition:" + T.tr.fast
        ].join(";")
        root.addEventListener("mouseenter", () => { root.style.background = T.color.bone })
        root.addEventListener("mouseleave", () => { root.style.background = T.color.bone2 })
        root.addEventListener("click", (e) => {
            e.preventDefault()
            this._onAcknowledge()
        })

        const labelEl = document.createElement("span")
        labelEl.textContent = "ACTIVITY"
        labelEl.style.cssText = [
            "font-weight:" + T.fw.display,
            "color:" + T.color.oxide
        ].join(";")

        const sentenceEl = document.createElement("span")
        sentenceEl.className = "aes-central-hub__activity-sentence"
        sentenceEl.textContent = "Loading…"
        sentenceEl.style.cssText = [
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate,
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis"
        ].join(";")

        root.append(labelEl, sentenceEl)
        this.root = root
        this.sentenceEl = sentenceEl
        this._attachStorageListener()
        this._attachAuditFencePostListener()
        this._refresh()
        return root
    }

    dispose() {
        if (this._storageListener) {
            try { chrome.storage.onChanged.removeListener(this._storageListener) }
            catch (_) { /* noop */ }
            this._storageListener = null
        }
        if (this._busListener && window.CentralHubBus && typeof window.CentralHubBus.off === "function") {
            try { window.CentralHubBus.off("data:audit:change:recorded", this._busListener) }
            catch (_) { /* noop */ }
            this._busListener = null
        }
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer)
            this._refreshTimer = null
        }
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root)
        }
        this.root = null
        this.sentenceEl = null
    }

    _attachAuditFencePostListener() {
        // Slice E2 — refresh on cross-domain fence-posts so the activity
        // strip catches pricing/service/auto-scheduler appends, not just
        // strategy journal writes. Debounced via the same timer as the
        // storage listener.
        if (this._busListener) return
        if (typeof window === "undefined" || !window.CentralHubBus
                || typeof window.CentralHubBus.on !== "function") return
        this._busListener = () => {
            if (this._refreshTimer) return
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null
                this._refresh()
            }, CentralHubActivityStrip.REFRESH_DEBOUNCE_MS)
        }
        try { window.CentralHubBus.on("data:audit:change:recorded", this._busListener) }
        catch (_) { this._busListener = null }
    }

    _attachStorageListener() {
        if (this._storageListener) return
        this._storageListener = (changes, area) => {
            if (area !== "local") return
            let dirty = false
            for (const k in changes) {
                if (k.indexOf("aesStrategy:journal") === 0) { dirty = true; break }
                if (k.indexOf("aesStrategy:lastSeenAt") === 0) { dirty = true; break }
            }
            if (!dirty) return
            if (this._refreshTimer) return
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null
                this._refresh()
            }, CentralHubActivityStrip.REFRESH_DEBOUNCE_MS)
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    async _refresh() {
        try {
            this._sinceTs = await this._loadSinceTs()
            this._counts  = await this._loadCounts(this._sinceTs)
            this._render()
        } catch (err) {
            console.warn("[AES Hub activity] refresh failed", err)
            if (this.sentenceEl) {
                this.sentenceEl.textContent = "Activity unavailable"
            }
        }
    }

    async _loadSinceTs() {
        const accountId = (typeof window !== "undefined" && window.__aesAccountId) || null
        const scoped = accountId ? "aesStrategy:lastSeenAt:acct:" + accountId : null
        const keys = scoped ? [scoped, "aesStrategy:lastSeenAt"] : ["aesStrategy:lastSeenAt"]
        try {
            const data = await chrome.storage.local.get(keys)
            const rec = (scoped && data[scoped]) || data["aesStrategy:lastSeenAt"]
            const ts = rec && Number(rec.ts)
            if (Number.isFinite(ts) && ts > 0) return ts
        } catch (_) { /* fall through */ }
        return Date.now() - CentralHubActivityStrip.DEFAULT_LOOKBACK_MS
    }

    async _loadCounts(since) {
        if (typeof window.AesStrategyJournal === "undefined") {
            return null
        }
        const entries = await window.AesStrategyJournal.loadAll()
        if (!Array.isArray(entries)) return {}
        const counts = {}
        for (const e of entries) {
            const ts = Number(e && e.ts)
            if (!Number.isFinite(ts) || ts < since) continue
            const action = e.action || "other"
            counts[action] = (counts[action] || 0) + 1
        }
        return counts
    }

    _render() {
        if (!this.sentenceEl) return
        const counts = this._counts
        if (counts == null) {
            this.sentenceEl.textContent = "Journal not yet loaded"
            return
        }
        const total = Object.values(counts).reduce((s, n) => s + n, 0)
        if (total === 0) {
            this.sentenceEl.textContent = "Quiet since last visit"
            return
        }
        const parts = []
        const order = ["apply-decision", "override-save", "note-save", "watchlist-toggle", "weight-change"]
        for (const action of order) {
            const n = counts[action] || 0
            if (n > 0) parts.push(this._formatCount(action, n))
        }
        const since = this._sinceTs
        const sinceLabel = (window.AesUtils && window.AesUtils._formatDateRel)
            ? window.AesUtils._formatDateRel(since)
            : ""
        const tail = sinceLabel ? " · " + sinceLabel : ""
        this.sentenceEl.textContent = "Since last visit: " + parts.join(" · ") + tail
    }

    _formatCount(action, n) {
        const plural = n === 1 ? "" : "s"
        switch (action) {
            case "apply-decision":   return n + " decision" + plural + " applied"
            case "override-save":    return n + " override" + plural
            case "note-save":        return n + " note" + plural
            case "watchlist-toggle": return n + " watchlist toggle" + plural
            case "weight-change":    return n + " weight tune" + plural
            default:                 return n + " " + action
        }
    }

    _lastSeenKey() {
        const accountId = (typeof window !== "undefined" && window.__aesAccountId) || null
        return accountId ? "aesStrategy:lastSeenAt:acct:" + accountId : "aesStrategy:lastSeenAt"
    }

    _onAcknowledge() {
        const counts = this._counts || {}
        const tileId = this._dominantTileId(counts)
        if (window.CentralHubBus && tileId) {
            window.CentralHubBus.emit("open-tile", {
                tileId, expand: true, scrollIntoView: true,
                source: "activity-strip"
            })
        }
        const key = this._lastSeenKey()
        const rec = {ts: Date.now(), weekId: null}
        chrome.storage.local.set({ [key]: rec })
            .catch(() => { /* storage write failure is benign; strip will re-render on next event */ })
    }

    _dominantTileId(counts) {
        const total = Object.values(counts).reduce((s, n) => s + n, 0)
        if (total === 0) return null
        const strategyCount = (counts["apply-decision"] || 0) + (counts["weight-change"] || 0)
        const routeCount    = (counts["override-save"] || 0) + (counts["note-save"] || 0) + (counts["watchlist-toggle"] || 0)
        return strategyCount > routeCount ? "strategy" : "route-assistant"
    }
}

if (typeof window !== "undefined") {
    window.CentralHubActivityStrip = CentralHubActivityStrip
}
