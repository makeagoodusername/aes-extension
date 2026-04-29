"use strict"

/**
 * Standalone cross-domain change-log modal.
 *
 * Extracted from `modules/route-assistant/panel.js` so the modal opens on
 * EVERY AS page, not just the scheduling-page bundle. Self-contained — no
 * dependency on the RouteAssistantPanel instance, no dependency on
 * panel-only helpers (`smallBtnStyle`, `_formatRelativeTime`,
 * `_tier3StatusColor` are all inlined as private functions here).
 *
 * Public API:
 *   window.AesChangeLogModal.open(opts?)
 *     opts (optional):
 *       initialDomains: string[]   override default chip selection
 *       initialSearch:  string     pre-fill search box (e.g. for route deep-link)
 *
 *   window.AesChangeLogModal.isOpen() → boolean
 *   window.AesChangeLogModal.close() → void
 *
 * Singleton — calling `open()` while a modal is already mounted no-ops.
 *
 * Backed by `AesChangeLogAggregator` (modules/_shared/change-log-aggregator.js)
 * which fans out reads to the per-domain stores. Lives in the universal
 * foundation block so it's available everywhere — see manifest.json.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesChangeLogModal) return

    let openInstance = null

    // ── Private helpers (inlined copies of panel.js's local functions, so
    //    this module is self-contained and works on pages where panel.js
    //    isn't loaded). ───────────────────────────────────────────────────

    function smallBtnStyle() {
        return {
            background:    "#1e293b",
            color:         "#cbd5e1",
            border:        "1px solid #475569",
            borderRadius:  "3px",
            padding:       "2px 8px",
            fontSize:      "11px",
            cursor:        "pointer",
            fontFamily:    "inherit"
        }
    }

    function fmtRelative(ts) {
        if (!isFinite(ts) || ts <= 0) return "?"
        const diff = Date.now() - ts
        if (diff < 0)               return "just now"
        if (diff < 60 * 1000)       return Math.max(1, Math.round(diff / 1000)) + "s ago"
        if (diff < 3600 * 1000)     return Math.round(diff / 60000) + "m ago"
        if (diff < 86400 * 1000)    return Math.round(diff / 3600000) + "h ago"
        if (diff < 7 * 86400 * 1000) return Math.round(diff / 86400000) + "d ago"
        return new Date(ts).toLocaleDateString()
    }

    function statusColor(status) {
        switch (status) {
            case "verified":      return "#34d399"
            case "ok":            return "#34d399"
            case "applied":       return "#34d399"
            case "done":          return "#34d399"
            case "posted":        return "#fbbf24"
            case "started":       return "#60a5fa"
            case "queued":        return "#94a3b8"
            case "dry-run":       return "#a78bfa"
            case "aborted":       return "#9ca3af"
            case "skipped":       return "#9ca3af"
            case "queue-dismissed": return "#9ca3af"
            case "failed":        return "#f87171"
            case "error":         return "#f87171"
            default:              return "#6b7280"
        }
    }

    function domainGlyph(domain) {
        switch (domain) {
            case "pricing":         return "💲"
            case "service-profile": return "🍽"
            case "flight-numbers":  return "🔢"
            case "strategy":        return "🎯"
            case "auto-scheduler":  return "🛫"
            case "afp-audit":       return "📋"
            default:                return "•"
        }
    }

    function domainLabel(domain) {
        switch (domain) {
            case "pricing":         return "Pricing"
            case "service-profile": return "Service profile"
            case "flight-numbers":  return "Flight numbers"
            case "strategy":        return "Strategy"
            case "auto-scheduler":  return "Auto-scheduler"
            case "afp-audit":       return "AFP audit"
            default:                return domain
        }
    }

    function scopeText(e) {
        const s = e.scope || {}
        if (e.domain === "pricing" || e.domain === "flight-numbers"
            || e.domain === "auto-scheduler" || e.domain === "afp-audit") {
            if (s.hub && s.dest) return s.hub + "→" + s.dest
            if (s.tail) return "tail " + s.tail
            return "—"
        }
        if (e.domain === "service-profile") {
            return s.profileId != null ? "profile " + s.profileId : "—"
        }
        if (e.domain === "strategy") {
            return s.planId ? ("plan " + String(s.planId).slice(0, 8)) : "—"
        }
        return "—"
    }

    // ── Notes store ──────────────────────────────────────────────────────
    // Per-entry freeform annotations, keyed by UnifiedEntry.id (which is
    // collision-safe across domains by construction). Single envelope at
    // chrome.storage.local["aes:changeLog:notes"]; cap at NOTES_MAX_BYTES
    // by LRU-evicting oldest `updatedAt` when over.
    const NOTES_KEY = "aes:changeLog:notes"
    const NOTES_MAX_BYTES = 200 * 1024
    const NOTES_VERSION = 1
    const NotesStore = (function () {
        let cache = null    // {[entryId]: {text, createdAt, updatedAt}}
        async function load(force) {
            if (cache && !force) return cache
            const got = await chrome.storage.local.get([NOTES_KEY]).catch(() => ({}))
            const env = got[NOTES_KEY]
            cache = (env && env.notes && typeof env.notes === "object") ? env.notes : {}
            return cache
        }
        async function save(entryId, text) {
            await load()
            const trimmed = (text || "").trim()
            const now = Date.now()
            if (!trimmed) {
                if (cache[entryId]) delete cache[entryId]
            } else {
                const prev = cache[entryId]
                cache[entryId] = {
                    text:      trimmed,
                    createdAt: prev ? prev.createdAt : now,
                    updatedAt: now
                }
            }
            await commit()
        }
        async function clear(entryId) {
            await load()
            delete cache[entryId]
            await commit()
        }
        async function commit() {
            // LRU evict if over budget
            let env = {version: NOTES_VERSION, notes: cache}
            let serial = JSON.stringify(env)
            while (serial.length > NOTES_MAX_BYTES) {
                const ids = Object.keys(cache)
                if (!ids.length) break
                ids.sort((a, b) => (cache[a].updatedAt || 0) - (cache[b].updatedAt || 0))
                const evict = ids[0]
                console.info("[AES change-log] evicting note for", evict, "to fit storage cap")
                delete cache[evict]
                env = {version: NOTES_VERSION, notes: cache}
                serial = JSON.stringify(env)
            }
            await chrome.storage.local.set({[NOTES_KEY]: env}).catch(() => {})
        }
        function getSync() { return cache || {} }
        return {load, save, clear, getSync, KEY: NOTES_KEY}
    })()

    // ── Saved views store ────────────────────────────────────────────────
    // Pinned filter combos. Persisted as an array sorted by createdAt desc;
    // newest 8 retained when over cap. Each view stores a serialisable
    // filter snapshot (domains as array, not Set).
    const VIEWS_KEY = "aes:changeLog:savedViews"
    const VIEWS_MAX = 8
    const SavedViewsStore = (function () {
        let cache = null    // [{id, name, filters, createdAt}]
        async function load(force) {
            if (cache && !force) return cache
            const got = await chrome.storage.local.get([VIEWS_KEY]).catch(() => ({}))
            cache = Array.isArray(got[VIEWS_KEY]) ? got[VIEWS_KEY] : []
            return cache
        }
        async function add(name, filters) {
            await load()
            const view = {
                id:        "v_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
                name:      String(name || "").trim() || "Untitled view",
                filters:   serialiseFilters(filters),
                createdAt: Date.now()
            }
            cache.unshift(view)
            cache = cache.slice(0, VIEWS_MAX)
            await chrome.storage.local.set({[VIEWS_KEY]: cache}).catch(() => {})
            return view
        }
        async function remove(id) {
            await load()
            const idx = cache.findIndex(v => v.id === id)
            if (idx < 0) return null
            const removed = cache[idx]
            cache.splice(idx, 1)
            await chrome.storage.local.set({[VIEWS_KEY]: cache}).catch(() => {})
            return removed
        }
        async function reinsert(view) {
            await load()
            cache.unshift(view)
            cache = cache.slice(0, VIEWS_MAX)
            await chrome.storage.local.set({[VIEWS_KEY]: cache}).catch(() => {})
        }
        function getSync() { return cache || [] }
        return {load, add, remove, reinsert, getSync, KEY: VIEWS_KEY}
    })()

    function serialiseFilters(f) {
        return {
            domains: Array.from(f.domains || []),
            source:  f.source || "all",
            status:  f.status || "all",
            since:   isFinite(f.since) ? f.since : (7 * 24 * 3600 * 1000),
            search:  f.search || ""
        }
    }
    function filtersMatch(filters, snapshot) {
        if (!snapshot) return false
        const a = serialiseFilters(filters)
        if (a.source !== snapshot.source || a.status !== snapshot.status) return false
        if (a.since !== snapshot.since || a.search !== (snapshot.search || "")) return false
        const ad = (a.domains || []).slice().sort()
        const bd = (snapshot.domains || []).slice().sort()
        if (ad.length !== bd.length) return false
        for (let i = 0; i < ad.length; i++) if (ad[i] !== bd[i]) return false
        return true
    }
    function suggestViewName(filters) {
        const parts = []
        const ds = Array.from(filters.domains || [])
        const allDomains = (window.AesChangeLogAggregator && window.AesChangeLogAggregator.DOMAINS) || []
        if (ds.length === 1) parts.push(domainLabel(ds[0]))
        else if (ds.length && ds.length < allDomains.length) parts.push(ds.length + " domains")
        if (filters.status && filters.status !== "all") parts.push(filters.status)
        if (filters.source && filters.source !== "all") parts.push(filters.source)
        if (filters.search) parts.push("\"" + filters.search.slice(0, 16) + "\"")
        const sinceLabel = ({
            [String(60 * 60 * 1000)]:        "1h",
            [String(24 * 3600 * 1000)]:      "24h",
            [String(7 * 24 * 3600 * 1000)]:  "7d",
            [String(30 * 24 * 3600 * 1000)]: "30d",
            "0":                             "all-time"
        })[String(filters.since)]
        if (sinceLabel) parts.push("last " + sinceLabel)
        return parts.length ? parts.join(" · ") : "Custom view"
    }

    // ── Bucketing for the sparkline ──────────────────────────────────────
    // Computes time-bucketed entry counts + dominant status. `since` is in
    // ms (matches the filter shape). Returns at most ~30 buckets so the
    // strip doesn't get cramped.
    function bucketEntries(entries, since) {
        if (!Array.isArray(entries) || !entries.length) return []
        const now = Date.now()
        let start, end, bucketCount, bucketMs
        if (since > 0) {
            end = now
            start = now - since
            if (since <= 60 * 60 * 1000)        { bucketCount = 12; }
            else if (since <= 24 * 3600 * 1000) { bucketCount = 24; }
            else if (since <= 7 * 24 * 3600 * 1000)  { bucketCount = 14; }
            else if (since <= 30 * 24 * 3600 * 1000) { bucketCount = 30; }
            else                                { bucketCount = 30; }
            bucketMs = Math.max(1, Math.floor((end - start) / bucketCount))
        } else {
            // All-time: span the actual entry range, 20 buckets.
            const tss = entries.map(e => e.ts || 0).filter(t => t > 0)
            if (!tss.length) return []
            start = Math.min.apply(null, tss)
            end   = Math.max.apply(null, tss)
            if (end - start < 60 * 1000) end = start + 60 * 1000
            bucketCount = 20
            bucketMs = Math.max(1, Math.floor((end - start) / bucketCount))
        }
        const buckets = []
        for (let i = 0; i < bucketCount; i++) {
            buckets.push({
                tsStart:  start + i * bucketMs,
                tsEnd:    (i === bucketCount - 1) ? end : (start + (i + 1) * bucketMs),
                count:    0,
                statuses: {}
            })
        }
        for (const e of entries) {
            const t = e.ts || 0
            if (t < start || t > end) continue
            const idx = Math.min(bucketCount - 1, Math.floor((t - start) / bucketMs))
            const b = buckets[idx]
            b.count += 1
            const s = e.status || "unknown"
            b.statuses[s] = (b.statuses[s] || 0) + 1
        }
        for (const b of buckets) {
            b.dominantStatus = pickDominantStatus(b.statuses)
            delete b.statuses
        }
        return buckets
    }
    function pickDominantStatus(byStatus) {
        const fail = (byStatus.failed || 0) + (byStatus.error || 0)
        const ok = (byStatus.verified || 0) + (byStatus.applied || 0)
                 + (byStatus.ok || 0) + (byStatus.done || 0) + (byStatus.posted || 0)
        const dry = byStatus["dry-run"] || 0
        const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
        if (!total) return "empty"
        if (fail > total * 0.4) return "failed"
        if (dry === total) return "dry-run"
        if (ok > total * 0.6) return "verified"
        return "mixed"
    }
    function bucketColor(status) {
        switch (status) {
            case "failed":   return "#f87171"
            case "verified": return "#34d399"
            case "dry-run":  return "#a78bfa"
            case "mixed":    return "#5eead4"
            default:         return "#475569"
        }
    }
    function fmtBucketLabel(b) {
        const fmtT = (t) => new Date(t).toLocaleString([], {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
        })
        return fmtT(b.tsStart) + " – " + fmtT(b.tsEnd) + " · " + b.count + " entr"
            + (b.count === 1 ? "y" : "ies")
    }

    // ── Pure filter — same shape as panel.js's _filterUnifiedChangeLogEntries.

    function applyFilters(all, filters) {
        if (!Array.isArray(all)) return []
        const now = Date.now()
        const since = (filters && filters.since > 0) ? (now - filters.since) : 0
        const term = (filters && filters.search || "").trim().toLowerCase()
        const bucket = filters && filters.bucketFilter
        const notes = NotesStore.getSync()
        return all.filter(e => {
            if (!e) return false
            if (filters.domains && !filters.domains.has(e.domain)) return false
            if (filters.source !== "all" && e.source !== filters.source) return false
            if (filters.status !== "all" && e.status !== filters.status) return false
            if (since && e.ts < since) return false
            if (bucket && (e.ts < bucket.start || e.ts > bucket.end)) return false
            if (term) {
                const note = notes[e.id] && notes[e.id].text || ""
                const hay = [
                    e.summary || "",
                    e.source  || "",
                    e.status  || "",
                    e.reason  || "",
                    e.scope && e.scope.hub  || "",
                    e.scope && e.scope.dest || "",
                    e.scope && e.scope.routeKey || "",
                    e.scope && e.scope.tail || "",
                    e.scope && e.scope.profileId != null ? String(e.scope.profileId) : "",
                    e.scope && e.scope.planId || "",
                    note
                ].join(" ").toLowerCase()
                if (hay.indexOf(term) < 0) return false
            }
            return true
        })
    }

    // ── Renderers ────────────────────────────────────────────────────────

    function renderControls(filters, onChange, searchTimerRef) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        const agg = window.AesChangeLogAggregator
        if (!agg) return wrap

        // Active-route context chip — rendered first when filters.activeRouteContext is set.
        if (filters.activeRouteContext) {
            const ctx = filters.activeRouteContext
            const ctxRow = document.createElement("div")
            ctxRow.style.cssText = "display:flex;gap:6px;align-items:center;"
            const chip = document.createElement("button")
            chip.type = "button"
            chip.title = "Filter scoped to the route this AS page is showing — click to clear"
            chip.textContent = "📍 " + ctx.hub + "→" + ctx.dest + "  ✕"
            Object.assign(chip.style, smallBtnStyle())
            chip.style.background = "#0c4a6e"
            chip.style.borderColor = "#38bdf8"
            chip.style.color = "#7dd3fc"
            chip.style.fontSize = "10px"
            chip.addEventListener("click", () => {
                filters.activeRouteContext = null
                filters.search = ""
                onChange()
            })
            ctxRow.append(chip)
            wrap.append(ctxRow)
        }

        const chips = document.createElement("div")
        chips.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;"
        const lbl = document.createElement("span")
        lbl.textContent = "Domains:"
        lbl.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;margin-right:4px;"
        chips.append(lbl)
        const allBtn = document.createElement("button")
        allBtn.textContent = "All"
        Object.assign(allBtn.style, smallBtnStyle())
        allBtn.style.fontSize = "10px"
        allBtn.addEventListener("click", () => {
            filters.domains = new Set(agg.DOMAINS)
            onChange()
        })
        chips.append(allBtn)
        for (const d of agg.DOMAINS) {
            const chip = document.createElement("button")
            chip.textContent = domainGlyph(d) + " " + domainLabel(d)
            Object.assign(chip.style, smallBtnStyle())
            chip.style.fontSize = "10px"
            const active = filters.domains.has(d)
            chip.style.background = active ? "#0c4a6e" : "#1e293b"
            chip.style.borderColor = active ? "#38bdf8" : "#475569"
            chip.style.color = active ? "#7dd3fc" : "#94a3b8"
            chip.addEventListener("click", () => {
                if (filters.domains.has(d)) filters.domains.delete(d)
                else filters.domains.add(d)
                if (!filters.domains.size) {
                    filters.domains = new Set(agg.DOMAINS)
                }
                onChange()
            })
            chips.append(chip)
        }
        wrap.append(chips)

        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;color:#cbd5e1;"
        const mkSelect = (label, current, options, onPick) => {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:4px;align-items:center;"
            w.append(document.createTextNode(label))
            const sel = document.createElement("select")
            sel.style.cssText = "background:#1e293b;color:#fff;border:1px solid #475569;"
                + "border-radius:3px;padding:2px 4px;font-size:11px;"
            for (const [v, l] of options) {
                const opt = document.createElement("option")
                opt.value = v; opt.textContent = l
                if (v === current) opt.selected = true
                sel.append(opt)
            }
            sel.addEventListener("change", () => onPick(sel.value))
            w.append(sel)
            return w
        }
        row.append(mkSelect("Source", filters.source, [
            ["all",            "All sources"],
            ["manual",         "Manual"],
            ["silent-auto",    "Silent-auto"],
            ["sandbox",        "Sandbox"],
            ["batch",          "Batch"],
            ["strategy",       "Strategy"],
            ["tile",           "Tile"],
            ["verify-cta",     "Verify CTA"],
            ["auto-scheduler", "Auto-scheduler"],
            ["afp",            "AFP"]
        ], v => { filters.source = v; onChange() }))
        row.append(mkSelect("Status", filters.status, [
            ["all",      "All statuses"],
            ["verified", "Verified"],
            ["posted",   "Posted"],
            ["applied",  "Applied"],
            ["ok",       "OK"],
            ["done",     "Done"],
            ["dry-run",  "Dry-run"],
            ["queued",   "Queued"],
            ["started",  "Started"],
            ["failed",   "Failed"],
            ["error",    "Error"],
            ["aborted",  "Aborted"],
            ["skipped",  "Skipped"]
        ], v => { filters.status = v; onChange() }))
        row.append(mkSelect("Since", String(filters.since), [
            [String(60 * 60 * 1000),         "Last 1h"],
            [String(24 * 3600 * 1000),       "Last 24h"],
            [String(7 * 24 * 3600 * 1000),   "Last 7d"],
            [String(30 * 24 * 3600 * 1000),  "Last 30d"],
            ["0",                            "All time"]
        ], v => { filters.since = Number(v) || 0; onChange() }))
        const searchWrap = document.createElement("label")
        searchWrap.style.cssText = "display:flex;gap:4px;align-items:center;flex:1;min-width:160px;"
        searchWrap.append(document.createTextNode("Search"))
        const searchInp = document.createElement("input")
        searchInp.type = "text"
        searchInp.value = filters.search || ""
        searchInp.placeholder = "route, summary, source, status…"
        searchInp.style.cssText = "flex:1;background:#1e293b;color:#fff;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 6px;font-size:11px;"
        searchInp.addEventListener("input", () => {
            filters.search = searchInp.value
            clearTimeout(searchTimerRef.t)
            searchTimerRef.t = setTimeout(() => onChange(), 200)
        })
        searchWrap.append(searchInp)
        row.append(searchWrap)
        wrap.append(row)
        return wrap
    }

    function renderStats(entries, allEntries) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#94a3b8;"
        const byDomain = {}
        const byStatus = {}
        let dryRun = 0
        for (const e of entries) {
            if (!e) continue
            byDomain[e.domain] = (byDomain[e.domain] || 0) + 1
            byStatus[e.status] = (byStatus[e.status] || 0) + 1
            if (e.dryRun) dryRun += 1
        }

        const total = document.createElement("div")
        total.style.cssText = "color:#cbd5e1;font-weight:600;"
        total.textContent = entries.length + " visible · " + allEntries.length + " total"
        wrap.append(total)

        const agg = window.AesChangeLogAggregator
        if (Object.keys(byDomain).length) {
            const grp = document.createElement("div")
            grp.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;"
            const lbl = document.createElement("span")
            lbl.textContent = "by domain:"
            lbl.style.cssText = "color:#64748b;text-transform:uppercase;letter-spacing:0.04em;"
            grp.append(lbl)
            const order = (agg && agg.DOMAINS) || Object.keys(byDomain)
            for (const d of order) {
                if (!byDomain[d]) continue
                const chip = document.createElement("span")
                chip.style.cssText = "background:#1e293b;border:1px solid #334155;border-radius:3px;"
                    + "padding:0 4px;color:#cbd5e1;display:inline-flex;align-items:center;gap:3px;"
                chip.textContent = domainGlyph(d) + " " + byDomain[d]
                chip.title = domainLabel(d) + ": " + byDomain[d]
                grp.append(chip)
            }
            wrap.append(grp)
        }

        if (Object.keys(byStatus).length) {
            const grp = document.createElement("div")
            grp.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;"
            const lbl = document.createElement("span")
            lbl.textContent = "by status:"
            lbl.style.cssText = "color:#64748b;text-transform:uppercase;letter-spacing:0.04em;"
            grp.append(lbl)
            const statusOrder = ["verified", "posted", "applied", "ok", "done",
                                 "dry-run", "queued", "started", "failed", "error",
                                 "aborted", "skipped", "queue-dismissed"]
            const seen = new Set()
            const renderStatus = (s) => {
                const n = byStatus[s]
                if (!n) return
                seen.add(s)
                const chip = document.createElement("span")
                chip.style.cssText = "border-radius:3px;padding:0 4px;"
                    + "border:1px solid " + statusColor(s) + ";color:" + statusColor(s) + ";"
                    + "display:inline-flex;align-items:center;gap:3px;"
                chip.textContent = s + " " + n
                grp.append(chip)
            }
            for (const s of statusOrder) renderStatus(s)
            for (const s in byStatus) if (!seen.has(s)) renderStatus(s)
            wrap.append(grp)
        }

        if (dryRun > 0) {
            const dryWrap = document.createElement("span")
            dryWrap.style.cssText = "color:#a78bfa;border:1px solid #6d28d9;border-radius:3px;"
                + "padding:0 4px;font-weight:600;"
            dryWrap.textContent = "DRY ×" + dryRun
            wrap.append(dryWrap)
        }
        return wrap
    }

    /**
     * Sparkline timeline strip — renders the bucket array as a horizontal
     * row of clickable bars. Bar width auto-scales to fill the host;
     * heights are normalized against the busiest bucket. Click a bar →
     * applies a bucketFilter to entries; passes the bucket through to
     * onBucketClick so the modal can render the active-bucket chip + reset.
     */
    function renderSpark(entries, since, opts) {
        opts = opts || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        const buckets = bucketEntries(entries, since)
        if (!buckets.length) return wrap
        const maxCount = Math.max.apply(null, buckets.map(b => b.count)) || 1

        // Active-bucket chip (if any).
        if (opts.bucketFilter) {
            const chipRow = document.createElement("div")
            chipRow.style.cssText = "display:flex;gap:6px;align-items:center;"
            const chip = document.createElement("button")
            chip.type = "button"
            chip.title = "Filter scoped to a sparkline bar — click to clear"
            const fmtT = (t) => new Date(t).toLocaleString([], {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
            })
            chip.textContent = "🕐 " + fmtT(opts.bucketFilter.start)
                + " – " + fmtT(opts.bucketFilter.end) + "  ✕"
            Object.assign(chip.style, smallBtnStyle())
            chip.style.background = "#1e3a8a"
            chip.style.borderColor = "#60a5fa"
            chip.style.color = "#bfdbfe"
            chip.style.fontSize = "10px"
            chip.addEventListener("click", () => opts.onBucketClear && opts.onBucketClear())
            chipRow.append(chip)
            wrap.append(chipRow)
        }

        // Bar strip.
        const strip = document.createElement("div")
        strip.style.cssText = "display:flex;align-items:flex-end;gap:1px;height:36px;"
            + "background:rgba(15,23,42,0.6);border:1px solid #1f2937;border-radius:3px;"
            + "padding:3px 4px;"
        for (const b of buckets) {
            const bar = document.createElement("div")
            const h = b.count > 0 ? Math.max(2, Math.round((b.count / maxCount) * 28)) : 1
            bar.style.cssText = "flex:1;height:" + h + "px;border-radius:1px;cursor:pointer;"
                + "background:" + bucketColor(b.dominantStatus) + ";"
                + "opacity:" + (b.count > 0 ? 0.85 : 0.18) + ";"
                + "transition:opacity 0.1s;"
            bar.title = fmtBucketLabel(b)
            bar.addEventListener("mouseenter", () => bar.style.opacity = "1")
            bar.addEventListener("mouseleave", () => bar.style.opacity = b.count > 0 ? "0.85" : "0.18")
            bar.addEventListener("click", () => {
                if (!b.count) return
                if (opts.onBucketPick) opts.onBucketPick({start: b.tsStart, end: b.tsEnd})
            })
            strip.append(bar)
        }
        wrap.append(strip)
        return wrap
    }

    /**
     * Saved-views chip row. Renders left-to-right: ⭐ "Save current"
     * button, then a chip per saved view. Active view (filters match
     * snapshot) gets a highlighted chip. Save UI is an inline prompt
     * that takes over the chip row temporarily.
     */
    function renderViews(filters, opts) {
        opts = opts || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;"
        const lbl = document.createElement("span")
        lbl.textContent = "Views:"
        lbl.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
        wrap.append(lbl)

        const saveBtn = document.createElement("button")
        saveBtn.type = "button"
        saveBtn.textContent = "⭐ Save current"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.title = "Pin the current filter combination as a named view"
        saveBtn.addEventListener("click", () => opts.onSaveStart && opts.onSaveStart(wrap))
        wrap.append(saveBtn)

        const views = SavedViewsStore.getSync()
        for (const v of views) {
            const active = filtersMatch(filters, v.filters)
            const chip = document.createElement("span")
            chip.style.cssText = "display:inline-flex;align-items:center;gap:4px;border-radius:3px;"
                + "padding:2px 4px 2px 6px;font-size:10px;cursor:pointer;"
                + "background:" + (active ? "#0c4a6e" : "#1e293b") + ";"
                + "border:1px solid " + (active ? "#38bdf8" : "#475569") + ";"
                + "color:" + (active ? "#7dd3fc" : "#cbd5e1") + ";"
            const lblEl = document.createElement("span")
            lblEl.textContent = v.name
            lblEl.title = "Click to apply this view"
            lblEl.addEventListener("click", () => opts.onApply && opts.onApply(v))
            const x = document.createElement("button")
            x.type = "button"
            x.textContent = "✕"
            x.title = "Remove view"
            x.style.cssText = "background:transparent;color:inherit;border:none;cursor:pointer;"
                + "font-size:10px;padding:0 2px;"
            x.addEventListener("click", (ev) => {
                ev.stopPropagation()
                opts.onRemove && opts.onRemove(v)
            })
            chip.append(lblEl, x)
            wrap.append(chip)
        }
        return wrap
    }

    /**
     * Inline save-prompt UI rendered into the views chip row. Replaces the
     * row's children temporarily; calls onSubmit(name) or onCancel().
     */
    function renderSavePrompt(host, suggestedName, onSubmit, onCancel) {
        host.innerHTML = ""
        host.style.cssText = "display:flex;gap:6px;align-items:center;"
        const lbl = document.createElement("span")
        lbl.textContent = "Name this view:"
        lbl.style.cssText = "color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;"
        const inp = document.createElement("input")
        inp.type = "text"
        inp.value = suggestedName || ""
        inp.style.cssText = "background:#1e293b;color:#fff;border:1px solid #475569;"
            + "border-radius:3px;padding:2px 6px;font-size:11px;flex:1;min-width:160px;"
        const ok = document.createElement("button")
        ok.type = "button"
        ok.textContent = "Save"
        Object.assign(ok.style, smallBtnStyle())
        ok.style.fontSize = "10px"
        ok.style.background = "#0c4a6e"
        ok.style.borderColor = "#38bdf8"
        ok.style.color = "#7dd3fc"
        const cancel = document.createElement("button")
        cancel.type = "button"
        cancel.textContent = "Cancel"
        Object.assign(cancel.style, smallBtnStyle())
        cancel.style.fontSize = "10px"
        const submit = () => {
            const n = (inp.value || "").trim()
            if (!n) { onCancel(); return }
            onSubmit(n)
        }
        ok.addEventListener("click", submit)
        cancel.addEventListener("click", onCancel)
        inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); submit() }
            else if (ev.key === "Escape") { ev.preventDefault(); onCancel() }
        })
        host.append(lbl, inp, ok, cancel)
        setTimeout(() => { try { inp.focus(); inp.select() } catch (_) {} }, 0)
    }

    function renderList(entries, expandedSet, onToggle, onNoteSave) {
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:1px;"
        for (const e of entries) {
            list.append(renderRow(e, expandedSet, onToggle, onNoteSave))
        }
        return list
    }

    function renderRow(e, expandedSet, onToggle, onNoteSave) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;border-bottom:1px solid rgba(31,41,55,0.5);"

        const row = document.createElement("div")
        row.style.cssText = "display:flex;gap:8px;align-items:center;padding:4px 6px;"
            + "font-size:11px;cursor:pointer;color:#cbd5e1;"
        row.addEventListener("mouseenter", () => row.style.background = "rgba(255,255,255,0.04)")
        row.addEventListener("mouseleave", () => row.style.background = "")
        row.addEventListener("click", () => onToggle(e.id))
        row.title = "Click to expand full envelope"

        const isExpanded = expandedSet.has(e.id)
        const caret = document.createElement("span")
        caret.textContent = isExpanded ? "▾" : "▸"
        caret.style.cssText = "color:#64748b;font-size:10px;width:10px;flex-shrink:0;"

        const dot = document.createElement("span")
        dot.style.cssText = "display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;"
            + "background:" + statusColor(e.status)
        const domain = document.createElement("span")
        domain.textContent = domainGlyph(e.domain)
        domain.style.cssText = "font-size:14px;width:18px;text-align:center;flex-shrink:0;"
        domain.title = domainLabel(e.domain)
        const scope = document.createElement("span")
        scope.style.cssText = "font-family:monospace;color:#e2e8f0;flex-shrink:0;min-width:90px;"
        scope.textContent = scopeText(e)
        const summary = document.createElement("span")
        summary.style.cssText = "color:#cbd5e1;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        summary.textContent = e.summary || ""
        if (e.reason) summary.title = e.reason
        const src = document.createElement("span")
        src.textContent = e.source || ""
        src.style.cssText = "font-size:9px;color:#94a3b8;border:1px solid #374151;border-radius:3px;padding:0 4px;flex-shrink:0;"
        const time = document.createElement("span")
        time.textContent = fmtRelative(e.ts)
        time.style.cssText = "color:#6b7280;flex-shrink:0;font-variant-numeric:tabular-nums;"
        time.title = new Date(e.ts || 0).toLocaleString()

        row.append(caret, dot, domain, scope, summary, src, time)

        if (e.dryRun) {
            const dr = document.createElement("span")
            dr.textContent = "DRY"
            dr.style.cssText = "font-size:9px;color:#a78bfa;border:1px solid #6d28d9;border-radius:3px;padding:0 4px;flex-shrink:0;"
            row.insertBefore(dr, src)
        }
        if (e.count > 1) {
            const c = document.createElement("span")
            c.textContent = "×" + e.count
            c.style.cssText = "font-size:9px;color:#fbbf24;flex-shrink:0;"
            row.insertBefore(c, src)
        }

        // 📝 indicator for entries with annotations.
        const note = NotesStore.getSync()[e.id]
        if (note) {
            const noteIcon = document.createElement("span")
            noteIcon.textContent = "📝"
            noteIcon.style.cssText = "font-size:10px;flex-shrink:0;"
            noteIcon.title = note.text.length > 80 ? note.text.slice(0, 80) + "…" : note.text
            row.insertBefore(noteIcon, src)
        }

        wrap.append(row)
        if (isExpanded) wrap.append(renderDetail(e, onNoteSave))
        return wrap
    }

    function renderDetail(e, onNoteSave) {
        const detail = document.createElement("div")
        detail.style.cssText = "padding:6px 12px 8px 28px;background:rgba(15,23,42,0.5);"
            + "font-family:monospace;font-size:10px;color:#cbd5e1;"
            + "border-top:1px dashed rgba(71,85,105,0.4);"

        // Note editor — top of the detail block, above structured fields.
        const note = NotesStore.getSync()[e.id]
        const noteWrap = document.createElement("div")
        noteWrap.style.cssText = "background:rgba(15,23,42,0.8);border:1px solid #1f2937;"
            + "border-radius:3px;padding:6px 8px;margin-bottom:8px;"
            + "display:flex;flex-direction:column;gap:4px;"
        const noteHead = document.createElement("div")
        noteHead.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "color:#94a3b8;font-size:10px;"
        const noteLabel = document.createElement("span")
        noteLabel.textContent = "📝 Note"
        const noteMeta = document.createElement("span")
        noteMeta.style.cssText = "color:#64748b;font-size:9px;"
        noteMeta.textContent = note ? ("last edited " + fmtRelative(note.updatedAt)) : "no note yet"
        noteHead.append(noteLabel, noteMeta)
        const noteText = document.createElement("textarea")
        noteText.value = note ? note.text : ""
        noteText.placeholder = "Why does this matter? Add context for future you…"
        noteText.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #334155;"
            + "border-radius:3px;padding:4px 6px;font:11px/1.4 sans-serif;resize:vertical;"
            + "min-height:42px;max-height:140px;width:100%;box-sizing:border-box;"
        const noteActions = document.createElement("div")
        noteActions.style.cssText = "display:flex;gap:6px;align-items:center;"
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.disabled = true
        saveBtn.style.opacity = "0.5"
        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.fontSize = "10px"
        clearBtn.disabled = !note
        clearBtn.style.opacity = note ? "1" : "0.5"
        const refreshDirty = () => {
            const initial = note ? note.text : ""
            const dirty = noteText.value.trim() !== initial.trim()
            saveBtn.disabled = !dirty
            saveBtn.style.opacity = dirty ? "1" : "0.5"
        }
        noteText.addEventListener("input", refreshDirty)
        saveBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation()
            await NotesStore.save(e.id, noteText.value)
            if (typeof onNoteSave === "function") onNoteSave()
        })
        clearBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation()
            await NotesStore.clear(e.id)
            if (typeof onNoteSave === "function") onNoteSave()
        })
        // Stop bubbled clicks from collapsing the row.
        noteWrap.addEventListener("click", (ev) => ev.stopPropagation())
        noteActions.append(saveBtn, clearBtn)
        noteWrap.append(noteHead, noteText, noteActions)
        detail.append(noteWrap)

        const fmtVal = (v) => {
            if (v == null) return "—"
            if (typeof v === "object") return JSON.stringify(v)
            return String(v)
        }
        const addLine = (lbl, val) => {
            const line = document.createElement("div")
            line.style.cssText = "display:flex;gap:6px;margin-bottom:2px;"
            const k = document.createElement("span")
            k.textContent = lbl
            k.style.cssText = "color:#64748b;width:80px;flex-shrink:0;"
            const v = document.createElement("span")
            v.textContent = fmtVal(val)
            v.style.cssText = "color:#cbd5e1;word-break:break-word;flex:1;"
            line.append(k, v)
            detail.append(line)
        }
        addLine("id",       e.id)
        addLine("ts",       new Date(e.ts || 0).toISOString())
        addLine("domain",   e.domain)
        addLine("source",   e.source)
        addLine("status",   e.status)
        addLine("scope",    e.scope || null)
        if (e.prev != null) addLine("prev", e.prev)
        if (e.next != null) addLine("next", e.next)
        if (e.reason)       addLine("reason", e.reason)
        if (e.dryRun)       addLine("dry-run", "true")
        if (e.count > 1)    addLine("count", e.count)

        if (e.raw) {
            const rawWrap = document.createElement("details")
            rawWrap.style.cssText = "margin-top:6px;"
            const rawHead = document.createElement("summary")
            rawHead.textContent = "raw envelope"
            rawHead.style.cssText = "color:#64748b;cursor:pointer;font-size:10px;"
            const rawBody = document.createElement("pre")
            rawBody.style.cssText = "white-space:pre-wrap;word-break:break-word;color:#94a3b8;"
                + "background:rgba(0,0,0,0.3);padding:6px 8px;border-radius:3px;margin:4px 0 0 0;"
                + "max-height:300px;overflow-y:auto;font-size:10px;"
            try { rawBody.textContent = JSON.stringify(e.raw, null, 2) }
            catch (err) { rawBody.textContent = String(e.raw) }
            rawWrap.append(rawHead, rawBody)
            detail.append(rawWrap)
        }
        return detail
    }

    function exportEntries(entries, format) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19)
        const filename = "aes-change-log-" + ts + "." + format
        let blob, type
        if (format === "csv") {
            const escape = (v) => {
                const s = (v == null) ? "" : String(v)
                if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
                return s
            }
            const rows = [
                ["ts_iso", "domain", "source", "status", "scope", "summary", "reason", "dryRun", "count"]
            ]
            for (const e of entries) {
                rows.push([
                    new Date(e.ts || 0).toISOString(),
                    e.domain || "",
                    e.source || "",
                    e.status || "",
                    scopeText(e),
                    e.summary || "",
                    e.reason || "",
                    e.dryRun ? "1" : "",
                    e.count != null ? String(e.count) : "1"
                ])
            }
            const csv = rows.map(r => r.map(escape).join(",")).join("\n")
            blob = new Blob([csv], {type: "text/csv;charset=utf-8"})
            type = "csv"
        } else {
            const json = JSON.stringify(entries, null, 2)
            blob = new Blob([json], {type: "application/json;charset=utf-8"})
            type = "json"
        }
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        document.body.append(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        if (typeof window.RouteAssistantToast !== "undefined") {
            window.RouteAssistantToast.success("Exported " + entries.length + " " + type + " entr"
                + (entries.length === 1 ? "y" : "ies"))
        }
    }

    // ── Main entry point ─────────────────────────────────────────────────

    function open(opts) {
        if (openInstance) return openInstance
        opts = opts || {}
        if (!window.AesChangeLogAggregator) {
            console.warn("[AES change-log] aggregator not loaded — modal unavailable")
            return null
        }

        const agg = window.AesChangeLogAggregator
        // Detect the route this AS page is scoped to so we can pre-fill
        // the search filter. Skipped if the caller already supplied
        // initialSearch (don't override an explicit deep-link).
        const activeRoute = (typeof agg.detectActiveRoute === "function" && !opts.initialSearch)
            ? agg.detectActiveRoute() : null
        const filters = {
            domains: new Set(opts.initialDomains && opts.initialDomains.length
                            ? opts.initialDomains : agg.DOMAINS),
            source:  "all",
            status:  "all",
            since:   7 * 24 * 3600 * 1000,
            search:  opts.initialSearch || (activeRoute ? (activeRoute.hub + " " + activeRoute.dest) : ""),
            activeRouteContext: activeRoute,
            bucketFilter: null      // {start, end} when a sparkline bar is selected
        }

        const overlay = document.createElement("div")
        overlay.id = "aes-change-log-overlay"
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10004;"
            + "display:flex;align-items:center;justify-content:center;"
        const dialog = document.createElement("div")
        dialog.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #38bdf8;border-radius:6px;"
            + "width:920px;max-width:96vw;max-height:90vh;display:flex;flex-direction:column;"
            + "font:12px/1.4 sans-serif;overflow:hidden;"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "padding:12px 18px;border-bottom:1px solid #1f2937;"
        const title = document.createElement("div")
        title.style.cssText = "color:#7dd3fc;font-size:13px;font-weight:600;"
        title.textContent = "Change log · cross-domain"
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;color:#94a3b8;border:none;cursor:pointer;"
            + "font-size:14px;padding:0 4px;"
        head.append(title, closeBtn)
        dialog.append(head)

        const body = document.createElement("div")
        body.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;"
        dialog.append(body)

        const viewsHost = document.createElement("div")
        viewsHost.style.cssText = "padding:8px 18px 4px 18px;border-bottom:1px solid #1f2937;"
            + "background:rgba(15,23,42,0.3);"
        body.append(viewsHost)
        const controlsHost = document.createElement("div")
        controlsHost.style.cssText = "padding:10px 18px 6px 18px;border-bottom:1px solid #1f2937;"
        body.append(controlsHost)
        const sparkHost = document.createElement("div")
        sparkHost.style.cssText = "padding:6px 18px 6px 18px;border-bottom:1px solid #1f2937;"
            + "background:rgba(15,23,42,0.4);"
        body.append(sparkHost)
        const statsHost = document.createElement("div")
        statsHost.style.cssText = "padding:6px 18px 6px 18px;border-bottom:1px solid #1f2937;"
            + "background:rgba(15,23,42,0.4);"
        body.append(statsHost)
        const listHost = document.createElement("div")
        listHost.style.cssText = "flex:1;min-height:0;overflow-y:auto;padding:6px 18px 12px 18px;"
        body.append(listHost)

        const footer = document.createElement("div")
        footer.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "padding:10px 18px;border-top:1px solid #1f2937;font-size:11px;color:#94a3b8;"
        dialog.append(footer)

        const expanded = new Set()
        const searchTimerRef = {t: null}
        let liveTimer = null
        const sourceKeys = (agg.SOURCE_KEYS) || []
        const sourceKeySet = new Set(sourceKeys)
        const userStateKeys = new Set([NotesStore.KEY, SavedViewsStore.KEY])
        const onStorage = (changes, area) => {
            if (area !== "local") return
            let touched = false
            let userState = false
            for (const k in changes) {
                if (sourceKeySet.has(k)) { touched = true; break }
                if (userStateKeys.has(k)) { userState = true; break }
                for (const sk of sourceKeys) {
                    if (k.startsWith(sk + ":")) { touched = true; break }
                }
                if (touched || userState) break
            }
            if (touched) {
                clearTimeout(liveTimer)
                liveTimer = setTimeout(() => fetchAndRender(true), 250)
            } else if (userState) {
                // Re-pull user state from disk and re-render (no entry refetch).
                Promise.all([NotesStore.load(true), SavedViewsStore.load(true)])
                    .then(() => render())
            }
        }
        if (chrome && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(onStorage)
        }

        const cleanup = () => {
            document.removeEventListener("keydown", onKey)
            if (chrome && chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.removeListener(onStorage)
            }
            clearTimeout(liveTimer)
            clearTimeout(searchTimerRef.t)
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            openInstance = null
        }
        const onKey = (e) => { if (e.key === "Escape") cleanup() }
        closeBtn.addEventListener("click", cleanup)
        overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup() })
        document.addEventListener("keydown", onKey)

        listHost.innerHTML = "<div style='color:#94a3b8;padding:20px;text-align:center;'>Loading change log…</div>"
        overlay.append(dialog)
        document.body.append(overlay)

        let allEntries = []
        const fetchAndRender = async (isLive) => {
            try {
                allEntries = await agg.loadAll({sinceMs: 0, domains: agg.DOMAINS, limit: 1000})
            } catch (e) {
                allEntries = []
                console.warn("[AES change-log] aggregator threw", e)
            }
            render(isLive === true)
        }
        const visible = () => applyFilters(allEntries, filters)
        const toggleExpand = (id) => {
            if (expanded.has(id)) expanded.delete(id)
            else expanded.add(id)
            render()
        }
        const onNoteSave = () => render()
        const renderViewsRow = () => {
            viewsHost.innerHTML = ""
            viewsHost.append(renderViews(filters, {
                onSaveStart: (host) => {
                    const suggestion = suggestViewName(filters)
                    renderSavePrompt(host, suggestion,
                        async (name) => {
                            await SavedViewsStore.add(name, filters)
                            renderViewsRow()
                        },
                        () => renderViewsRow()
                    )
                },
                onApply: (v) => {
                    filters.domains = new Set(v.filters.domains || [])
                    filters.source = v.filters.source || "all"
                    filters.status = v.filters.status || "all"
                    filters.since = isFinite(v.filters.since) ? v.filters.since : (7 * 24 * 3600 * 1000)
                    filters.search = v.filters.search || ""
                    // Clear transient overlays — neither bucket selection nor
                    // active-route auto-fill belongs to a saved view's snapshot.
                    filters.bucketFilter = null
                    filters.activeRouteContext = null
                    render()
                },
                onRemove: async (v) => {
                    const removed = await SavedViewsStore.remove(v.id)
                    if (!removed) { renderViewsRow(); return }
                    if (typeof window.RouteAssistantToast !== "undefined"
                        && typeof window.RouteAssistantToast.show === "function") {
                        window.RouteAssistantToast.show("Removed view '" + removed.name + "'", {
                            type: "info",
                            duration: 5000,
                            action: {
                                label: "Undo",
                                fn: async () => {
                                    await SavedViewsStore.reinsert(removed)
                                    renderViewsRow()
                                }
                            }
                        })
                    }
                    renderViewsRow()
                }
            }))
        }
        const render = (isLive) => {
            renderViewsRow()
            controlsHost.innerHTML = ""
            controlsHost.append(renderControls(filters, () => render(), searchTimerRef))
            const entries = visible()
            sparkHost.innerHTML = ""
            sparkHost.append(renderSpark(allEntries, filters.since, {
                bucketFilter:   filters.bucketFilter,
                onBucketPick:   (b) => { filters.bucketFilter = b; render() },
                onBucketClear:  () => { filters.bucketFilter = null; render() }
            }))
            statsHost.innerHTML = ""
            statsHost.append(renderStats(entries, allEntries))
            listHost.innerHTML = ""
            if (!entries.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "color:#94a3b8;padding:20px;text-align:center;"
                empty.textContent = allEntries.length
                    ? "No entries match the current filters."
                    : "No entries yet — apply some changes (price, service, schedule) and they'll land here."
                listHost.append(empty)
            } else {
                listHost.append(renderList(entries, expanded, toggleExpand, onNoteSave))
            }
            footer.innerHTML = ""
            const left = document.createElement("span")
            const lbl = entries.length + " of " + allEntries.length + " entr"
                + (allEntries.length === 1 ? "y" : "ies")
            left.textContent = lbl + (isLive ? " · live" : "")
            if (isLive) left.style.color = "#86efac"
            footer.append(left)
            const exportRow = document.createElement("div")
            exportRow.style.cssText = "display:flex;gap:6px;"
            const exportJson = document.createElement("button")
            exportJson.textContent = "Export JSON"
            Object.assign(exportJson.style, smallBtnStyle())
            exportJson.style.fontSize = "10px"
            exportJson.addEventListener("click", () => exportEntries(visible(), "json"))
            const exportCsv = document.createElement("button")
            exportCsv.textContent = "Export CSV"
            Object.assign(exportCsv.style, smallBtnStyle())
            exportCsv.style.fontSize = "10px"
            exportCsv.addEventListener("click", () => exportEntries(visible(), "csv"))
            exportRow.append(exportJson, exportCsv)
            footer.append(exportRow)
        }
        // Prime the user-state caches BEFORE the first render so the
        // initial paint already reflects notes and views.
        Promise.all([NotesStore.load(), SavedViewsStore.load()])
            .then(() => fetchAndRender())
            .catch(() => fetchAndRender())
        openInstance = {close: cleanup}
        return openInstance
    }

    function close() {
        if (openInstance && typeof openInstance.close === "function") openInstance.close()
    }

    function isOpen() { return !!openInstance }

    window.AesChangeLogModal = {open, close, isOpen}
})()
