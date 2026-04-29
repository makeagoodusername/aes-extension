"use strict"

/**
 * CentralHubTile — base class for every hub tile.
 *
 * Subclasses set:
 *   this.id              — unique string ("route-assistant", "fleet-hub", …)
 *   this.title           — display title (rendered upper-case via CSS)
 *   this.section         — "fleet" | "routes" | "finance" | "tools"
 *   this.priority        — sort within section; lower = first (default 100)
 *   this.requiresAirline — bool; default true. If true and ctx.airline is
 *                          falsy, the tile renders a muted "no airline" state.
 *
 * Subclasses override:
 *   async loadStatus(ctx)            → {badge, badgeKind, summary}
 *   async renderBody(ctx, hostEl)    fills the expanded body
 *   openHref(ctx)                    relative URL for the Open button
 *   openHandler(ctx)                 callback alternative to openHref
 *   watchedStorageKeys(ctx)          string[] of prefixes; touching any
 *                                    triggers refresh()
 *   feedSlices(ctx)                  string[] of HubFeed slice names; any
 *                                    update triggers refresh(). Slices must
 *                                    be declared elsewhere via HubFeed.declare.
 *                                    Co-exists with watchedStorageKeys() —
 *                                    tiles can use both during migration.
 *
 * Lifecycle:
 *   await tile.mount(container, ctx, {expanded, onToggleChange})
 *   tile.toggle()
 *   await tile.refresh()
 *   tile.dispose()
 */
class CentralHubTile {
    constructor() {
        this.id = ""
        this.title = ""
        this.section = ""
        this.priority = 100
        this.requiresAirline = true

        this.expanded = false
        this.root = null
        this.headerEl = null
        this.bodyEl = null
        this.titleEl = null
        this.badgeEl = null
        this.summaryEl = null
        this.openBtn = null
        this.toggleBtn = null

        this.ctx = null
        this._lastStatus = null
        this._storageListener = null
        this._storageBusDisposers = null
        this._refreshing = false
        this._onToggleChange = null
        this._busDisposers = []
        this._feedDisposers = []
        this._feedFreshness = null  // last seen {stale, ageMs} from feed slices
    }

    /**
     * Opt-in subscription to CentralHubBus. The disposer is tracked here
     * and fired automatically on dispose() so tiles never leak handlers
     * across shell unmount. No-ops cleanly when bus.js hasn't loaded
     * (e.g. early CH-5b state) so existing tiles keep working.
     */
    subscribeBus(event, handler) {
        if (!window.CentralHubBus || typeof window.CentralHubBus.on !== "function") return
        const dispose = window.CentralHubBus.on(event, handler)
        if (typeof dispose === "function") this._busDisposers.push(dispose)
    }

    watchedStorageKeys(ctx) { return [] }

    /**
     * Opt-in HubFeed slices. Each name must be a previously-declared
     * `hub:*` slice (see modules/_shared/hub-feed.js + central-hub/feed/).
     * On mount, the tile subscribes to each slice and triggers `refresh()`
     * on update; freshness metadata is captured and surfaced as a header dot.
     */
    feedSlices(ctx) { return [] }

    async loadStatus(ctx) {
        return {badge: "—", badgeKind: "muted", summary: ""}
    }

    /**
     * Subclasses fill the expanded body. The optional `focusFilter` arg
     * (CH-5c) carries cross-tile drill-in payloads — tiles that don't
     * recognise the filter shape ignore it. Filters are simple plain
     * objects, e.g. {type: "fired-alerts"}.
     */
    async renderBody(ctx, hostEl, focusFilter) {
        hostEl.textContent = ""
    }

    openHref(ctx) { return null }

    openHandler(ctx) { return null }

    async mount(container, ctx, opts) {
        this.ctx = ctx
        this.expanded = !!(opts && opts.expanded)
        this._onToggleChange = (opts && opts.onToggleChange) || null

        this._buildRoot()
        container.appendChild(this.root)
        this._attachStorageListener()
        this._attachFeedSubscriptions()
        await this.refresh()
    }

    _buildRoot() {
        const T = window.AESTokens

        const root = document.createElement("section")
        root.className = "aes-central-hub-tile"
        root.id = "aes-central-hub-tile-" + this.id
        root.dataset.tileId = this.id
        root.dataset.section = this.section
        root.dataset.aesSurface = "tile"
        root.style.cssText = [
            "display:block",
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "margin-bottom:" + T.sp[3],
            "box-sizing:border-box"
        ].join(";")

        const header = document.createElement("div")
        header.className = "aes-central-hub-tile__header"
        header.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[3],
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "cursor:pointer",
            "user-select:none"
        ].join(";")
        header.addEventListener("click", (e) => {
            if (e.target.closest(".aes-central-hub-tile__open")) return
            if (e.target.closest(".aes-central-hub-tile__toggle")) return
            if (e.target.closest(".aes-central-hub-tile__pin")) return
            this.toggle()
        })

        const title = document.createElement("h3")
        title.className = "aes-central-hub-tile__title"
        title.textContent = this.title
        title.style.cssText = [
            "margin:0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "flex:0 0 auto"
        ].join(";")

        const summary = document.createElement("div")
        summary.className = "aes-central-hub-tile__summary"
        summary.style.cssText = [
            "flex:1 1 auto",
            "min-width:0",
            "color:" + T.color.oxide2,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis"
        ].join(";")

        const badge = document.createElement("div")
        badge.className = "aes-central-hub-tile__badge"
        badge.style.cssText = "flex:0 0 auto;"

        const actions = document.createElement("div")
        actions.className = "aes-central-hub-tile__actions"
        actions.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[2],
            "flex:0 0 auto"
        ].join(";")

        const openBtn = this._buildOpenButton()
        if (openBtn) actions.appendChild(openBtn)

        // C-2 — pin glyph (★/☆) precedes the toggle. Click bypasses
        // the header toggle handler via class match + stopPropagation.
        if (window.AesTilePin && typeof window.AesTilePin.build === "function") {
            const pinBtn = window.AesTilePin.build(this.id)
            if (pinBtn) actions.appendChild(pinBtn)
        }

        const toggleBtn = document.createElement("button")
        toggleBtn.type = "button"
        toggleBtn.className = "aes-central-hub-tile__toggle"
        toggleBtn.textContent = this.expanded ? "▾" : "▸"
        toggleBtn.setAttribute("aria-label", this.expanded ? "Collapse" : "Expand")
        toggleBtn.style.cssText = [
            "background:transparent",
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:0 " + T.sp[2],
            "min-width:24px",
            "height:22px",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "cursor:pointer"
        ].join(";")
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            this.toggle()
        })
        actions.appendChild(toggleBtn)

        header.append(title, summary, badge, actions)

        const body = document.createElement("div")
        body.className = "aes-central-hub-tile__body"
        body.style.cssText = [
            "padding:" + T.sp[3],
            "display:" + (this.expanded ? "block" : "none")
        ].join(";")

        root.append(header, body)

        this.root = root
        this.headerEl = header
        this.titleEl = title
        this.summaryEl = summary
        this.badgeEl = badge
        this.bodyEl = body
        this.openBtn = openBtn
        this.toggleBtn = toggleBtn
    }

    _buildOpenButton() {
        const T = window.AESTokens
        const href = this.openHref(this.ctx)
        const handler = this.openHandler(this.ctx)
        if (!href && !handler) return null

        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "aes-central-hub-tile__open"
        btn.textContent = "Open →"
        btn.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer",
            "transition:" + T.tr.fast,
            "flex-shrink:0"
        ].join(";")
        btn.addEventListener("mouseenter", () => {
            btn.style.background = T.color.rust
            btn.style.borderColor = T.color.rust
        })
        btn.addEventListener("mouseleave", () => {
            btn.style.background = T.color.oxide
            btn.style.borderColor = T.color.oxide
        })
        btn.addEventListener("click", (e) => {
            e.stopPropagation()
            if (handler) {
                try { handler(this.ctx) }
                catch (err) { console.warn("[AES Hub] tile open handler threw", this.id, err) }
                return
            }
            const url = typeof href === "function" ? href(this.ctx) : href
            if (!url) return
            window.location.href = url
        })
        return btn
    }

    toggle() {
        this.expanded = !this.expanded
        if (this.bodyEl) this.bodyEl.style.display = this.expanded ? "block" : "none"
        if (this.toggleBtn) {
            this.toggleBtn.textContent = this.expanded ? "▾" : "▸"
            this.toggleBtn.setAttribute("aria-label", this.expanded ? "Collapse" : "Expand")
        }
        if (this.expanded) this._renderBodySafe()
        if (typeof this._onToggleChange === "function") {
            try { this._onToggleChange(this.id, this.expanded) }
            catch (err) { console.warn("[AES Hub] toggle change cb threw", err) }
        }
    }

    async refresh() {
        if (this._refreshing) return
        if (!this.root) return
        this._refreshing = true
        try {
            let status
            if (this.requiresAirline && (!this.ctx || !this.ctx.airline)) {
                status = {badge: "NO AIRLINE", badgeKind: "muted", summary: "Airline context unavailable on this page."}
            } else {
                status = await this.loadStatus(this.ctx)
            }
            this._renderHeader(status)
            this._lastStatus = status
            if (this.expanded) await this._renderBodySafe()
        } catch (err) {
            console.warn("[AES Hub] tile refresh failed", this.id, err)
        } finally {
            this._refreshing = false
        }
    }

    _renderHeader(status) {
        if (!status) return
        if (this.summaryEl) {
            this.summaryEl.textContent = status.summary || ""
            this.summaryEl.title = status.summary || ""
        }
        if (this.badgeEl) {
            this.badgeEl.textContent = ""
            if (status.badge) {
                const el = window.CentralHubStatusBadges.makeBadgeEl(
                    status.badge,
                    status.badgeKind || "default"
                )
                this.badgeEl.appendChild(el)
            }
            const freshness = this._feedFreshness
            if (freshness && freshness.stale) {
                const T = window.AESTokens
                const dot = document.createElement("span")
                dot.className = "aes-central-hub-tile__freshness"
                dot.title = "Cached value is stale"
                                + (freshness.ageMs ? " (" + Math.round(freshness.ageMs / 1000) + "s old)" : "")
                dot.style.cssText = [
                    "display:inline-block",
                    "width:6px",
                    "height:6px",
                    "border-radius:50%",
                    "background:" + (T && T.color ? T.color.slate : "#888"),
                    "margin-left:" + (T && T.sp ? T.sp[1] : "4px"),
                    "vertical-align:middle"
                ].join(";")
                this.badgeEl.appendChild(dot)
            }
        }
    }

    async _renderBodySafe(focusFilter) {
        if (!this.bodyEl) return
        try {
            await this.renderBody(this.ctx, this.bodyEl, focusFilter)
        } catch (err) {
            console.warn("[AES Hub] tile body render failed", this.id, err)
            this.bodyEl.textContent = "(failed to load — see console)"
        }
    }

    _attachStorageListener() {
        const prefixes = this.watchedStorageKeys(this.ctx)
        if (!prefixes || !prefixes.length) return
        if (this._storageBusDisposers || this._storageListener) return

        if (typeof window.AesDataBus !== "undefined" && typeof window.AesDataBus.bridgeStorage === "function") {
            const disposers = []
            for (const prefix of prefixes) {
                const topic = "data:storage:hub-tile:" + this.id + ":" + prefix
                disposers.push(window.AesDataBus.bridgeStorage({prefix, topic}))
                disposers.push(window.AesDataBus.on(topic, () => this.refresh()))
            }
            this._storageBusDisposers = disposers
            return
        }

        this._storageListener = (changes, area) => {
            if (area !== "local") return
            for (const k in changes) {
                for (const p of prefixes) {
                    if (k === p || k.indexOf(p) === 0) { this.refresh(); return }
                }
            }
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    _attachFeedSubscriptions() {
        if (typeof window.HubFeed === "undefined") return
        const slices = this.feedSlices(this.ctx)
        if (!slices || !slices.length) return
        for (const slice of slices) {
            const off = window.HubFeed.subscribe(slice, (e) => {
                this._feedFreshness = {stale: !!e.stale, ageMs: e.ageMs, error: e.error || null}
                this.refresh()
            })
            if (typeof off === "function") this._feedDisposers.push(off)
        }
    }

    /**
     * Walk chrome.storage.local and return entries whose keys live under
     * `prefix` — i.e. start with `prefix + ":"`. Pass `prefix` WITHOUT a
     * trailing colon; the helper appends it. Returns
     * `Array<{key, value, suffix}>` where suffix is the part after the colon.
     *
     * Set `opts.includeExactKey` when the bare prefix is itself a valid
     * storage key (legacy + namespaced shape, e.g. RA's alertRules).
     */
    async _loadByPrefix(prefix, opts) {
        const all = await chrome.storage.local.get(null)
        const includeExact = !!(opts && opts.includeExactKey)
        const colonPrefix = prefix + ":"
        const out = []
        for (const k in all) {
            if (k === prefix) {
                if (includeExact) out.push({key: k, value: all[k], suffix: ""})
                continue
            }
            if (k.indexOf(colonPrefix) !== 0) continue
            out.push({key: k, value: all[k], suffix: k.substring(colonPrefix.length)})
        }
        return out
    }

    /**
     * Append a muted `<p>` "no data yet" message into `hostEl`. If
     * `opts.marginTop` is set (e.g. when rendering after a banner), the
     * paragraph gets a top margin instead of zero.
     */
    _renderEmptyState(hostEl, message, opts) {
        const T = window.AESTokens
        const p = document.createElement("p")
        const marginTop = opts && opts.marginTop
        p.style.cssText = "color:" + T.color.slate
            + ";margin:" + (marginTop ? marginTop + " 0 0 0" : "0") + ";"
        p.textContent = message
        hostEl.appendChild(p)
        return p
    }

    dispose() {
        if (this._storageBusDisposers) {
            for (const off of this._storageBusDisposers) {
                try { off() } catch (_) { /* noop */ }
            }
            this._storageBusDisposers = null
        }
        if (this._storageListener) {
            try { chrome.storage.onChanged.removeListener(this._storageListener) }
            catch (_) { /* noop */ }
            this._storageListener = null
        }
        if (this._busDisposers && this._busDisposers.length) {
            for (const dispose of this._busDisposers) {
                try { dispose() } catch (_) { /* noop */ }
            }
            this._busDisposers = []
        }
        if (this._feedDisposers && this._feedDisposers.length) {
            for (const dispose of this._feedDisposers) {
                try { dispose() } catch (_) { /* noop */ }
            }
            this._feedDisposers = []
        }
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root)
        }
        this.root = null
    }
}

if (typeof window !== "undefined") {
    window.CentralHubTile = CentralHubTile
}
