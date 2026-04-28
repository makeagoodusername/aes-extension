/**
 * Drives a scan: spawns child tabs (≤ concurrency at once, ≥ staggerMs apart),
 * listens for per-type result writes, advances the queue, and notifies the
 * dashboard UI on each state change.
 *
 * State lives in chrome.storage.local via MarketScanSession so a scan survives
 * a dashboard reload — the UI re-hydrates from the session record.
 */
class ScanController {
    constructor(server) {
        this.server = server
        this.session = null
        this.timers = {}        // {type: watchdogTimerId}
        this.staggerTimer = null
        this.listeners = []     // UI onUpdate callbacks
        this.storageListener = null
        this.WATCHDOG_MS = 30 * 1000
        // Mirror mode: another tab holds the lease for this session. We
        // observe progress via storage but don't dispatch / arm watchdogs.
        // The UI hides Start/Cancel and shows "tracking from another tab".
        this.mirror = false
    }

    /**
     * True when this controller is observing a scan owned by a different
     * tab. UIs check this to suppress action affordances.
     */
    isMirror() { return !!this.mirror }

    /**
     * Subscribe to state changes. Callback receives the latest session record.
     */
    onUpdate(callback) {
        this.listeners.push(callback)
    }

    _notify() {
        for (const cb of this.listeners) {
            try { cb(this.session) } catch (e) { console.error("ScanController listener:", e) }
        }
    }

    /**
     * Re-hydrate from a previously saved session (e.g. after a tab reload).
     * Returns the session or null if not found / not running.
     *
     * Lease-aware: if another tab currently owns the lease for this scan,
     * the controller enters mirror mode — observes storage events to keep
     * the UI fresh but does not dispatch child tabs or arm watchdogs (the
     * owner is doing both).
     */
    async resume(scanId) {
        const session = await MarketScanSession.loadSession(this.server, scanId)
        if (!session) return null
        this.session = session
        this._installStorageListener()
        if (session.status === "running") {
            // Single-call takeover: acquire returns true when no active
            // lease blocks us — that doubles as our mirror-mode signal.
            // No race with the prior owner because acquire only writes
            // when the existing lease is stale or owned by us.
            const acquired = await MarketScanLease.acquire(this.server, scanId)
            this.mirror = !acquired
            if (!this.mirror) {
                // Reconcile inFlight by counting "inflight" entries in the queue
                session.inFlight = session.queue.filter(e => e.status === "inflight").length
                // Reset watchdogs (we lost the timers across reload — give them fresh time)
                for (const entry of session.queue) {
                    if (entry.status === "inflight") this._armWatchdog(entry)
                }
                this.tick()
            }
        }
        this._notify()
        return session
    }

    /**
     * Kick off a new scan from a preset.
     * @param {object} preset - {id, name, types: [string]}
     * @param {object} opts - {concurrency, staggerMs, typeFamilyOverrides}
     */
    async start(preset, opts) {
        const overrides = (opts && opts.typeFamilyOverrides) || {}
        const queue = preset.types.map(type => {
            const family = TypeFamilyMap.resolve(type, overrides)
            if (!family) {
                return {type: type, family: null, status: "error", error: "no family mapping"}
            }
            return {type: type, family: family, status: "pending"}
        })

        this.session = MarketScanSession.create({
            server: this.server,
            presetId: preset.id,
            presetName: preset.name,
            queue: queue,
            concurrency: (opts && opts.concurrency) || 6,
            staggerMs: (opts && opts.staggerMs) || 2000
        })

        await MarketScanSession.cleanupOld(this.server, this.session.scanId)
        // Acquire lease against this fresh scanId. A new scanId always wins
        // because MarketScanLease.acquire treats a different scanId as a
        // valid takeover — the user explicitly asked to start a new scan.
        await MarketScanLease.acquire(this.server, this.session.scanId)
        this.mirror = false
        await MarketScanSession.saveSession(this.session)
        await UsedAircraftPresets.save({lastScanId: this.session.scanId})

        this._installStorageListener()
        this._notify()
        this.tick()
        return this.session
    }

    async cancel() {
        if (!this.session || this.session.status !== "running") return
        this.session.status = "aborted"
        this.session.finishedAt = Date.now()
        if (this.staggerTimer) { clearTimeout(this.staggerTimer); this.staggerTimer = null }
        for (const t in this.timers) clearTimeout(this.timers[t])
        this.timers = {}
        await MarketScanSession.saveSession(this.session)
        if (!this.mirror) {
            await MarketScanLease.release(this.server, this.session.scanId)
        }
        this._notify()
    }

    /**
     * Pump loop: dispatch as many pending entries as concurrency allows,
     * spaced staggerMs apart.
     */
    async tick() {
        if (!this.session || this.session.status !== "running") return
        // In mirror mode the lease-holding tab is dispatching; we just watch.
        if (this.mirror) return

        const now = Date.now()
        const spaceLeft = (this.session.concurrency || 6) - this.session.inFlight
        const sinceLast = now - (this.session.lastDispatchAt || 0)
        const stagger = this.session.staggerMs || 2000

        if (spaceLeft <= 0) return

        if (sinceLast < stagger) {
            // Wait the remainder, then try again
            if (this.staggerTimer) clearTimeout(this.staggerTimer)
            this.staggerTimer = setTimeout(() => {
                this.staggerTimer = null
                this.tick()
            }, stagger - sinceLast)
            return
        }

        const next = this.session.queue.find(e => e.status === "pending")
        if (!next) {
            await this._maybeFinish()
            return
        }

        next.status = "inflight"
        next.startedAt = Date.now()
        this.session.inFlight++
        this.session.lastDispatchAt = Date.now()
        await MarketScanSession.saveSession(this.session)
        this._notify()

        this._spawnChildTab(next)
        this._armWatchdog(next)

        // Schedule next dispatch attempt after the stagger window
        if (this.staggerTimer) clearTimeout(this.staggerTimer)
        this.staggerTimer = setTimeout(() => {
            this.staggerTimer = null
            this.tick()
        }, stagger)
    }

    _spawnChildTab(entry) {
        const url = "https://" + this.server + ".airlinesim.aero/app/aircraft/market"
            + "?aesScanTs=" + Date.now()
            + "#aesScan=" + this.session.scanId
            + "|" + encodeURIComponent(entry.type)
            + "|" + encodeURIComponent(entry.family)
            + "|" + entry.idx
        const win = window.open(url, "_blank")
        if (!win) {
            // Pop-up blocked — mark as error and let the pump continue
            entry.status = "error"
            entry.error = "pop-up blocked (allow pop-ups for *.airlinesim.aero)"
            entry.finishedAt = Date.now()
            this.session.inFlight = Math.max(0, this.session.inFlight - 1)
            // Don't await — let tick() continue
            MarketScanSession.saveSession(this.session)
            this._notify()
        }
    }

    _armWatchdog(entry) {
        if (this.timers[entry.type]) clearTimeout(this.timers[entry.type])
        this.timers[entry.type] = setTimeout(() => {
            this._handleTimeout(entry.type)
        }, this.WATCHDOG_MS)
    }

    async _handleTimeout(type) {
        if (!this.session) return
        const entry = this.session.queue.find(e => e.type === type)
        if (!entry || entry.status !== "inflight") return
        entry.status = "timeout"
        entry.error = "no result within " + Math.round(this.WATCHDOG_MS / 1000) + "s"
        entry.finishedAt = Date.now()
        this.session.inFlight = Math.max(0, this.session.inFlight - 1)
        delete this.timers[type]
        await MarketScanSession.saveSession(this.session)
        this._notify()
        this.tick()
    }

    _installStorageListener() {
        if (this.storageListener) return
        // Read `this.session` on every event rather than capturing a prefix in
        // this closure — the controller is a module-level singleton, so a
        // closure prefix from the first scan would silently ignore results
        // from every scan after it and force the watchdog to advance the
        // queue instead.
        this.storageListener = (changes, area) => {
            if (area !== "local") return
            const session = this.session
            if (!session) return
            const prefix = session.server + "marketScan:" + session.scanId + ":r:"
            for (const key in changes) {
                if (key.indexOf(prefix) !== 0) continue
                const blob = changes[key].newValue
                if (!blob) continue
                this._handleResult(blob)
            }
        }
        chrome.storage.onChanged.addListener(this.storageListener)
    }

    async _handleResult(blob) {
        if (!this.session) return
        const entry = this.session.queue.find(e => e.type === blob.type)
        if (!entry || entry.status !== "inflight") return

        // Heartbeat: the child tab is mid-scan (paging / iterating variants).
        // Reset the watchdog and record progress; don't finalize.
        if (blob.status === "scanning") {
            if (blob.progress) {
                entry.progress = blob.progress
            }
            if (!this.mirror) {
                this._armWatchdog(entry)
                // Refresh the lease while work is in progress so a different
                // tab doesn't think we crashed.
                MarketScanLease.refresh(this.server, this.session.scanId)
            }
            await MarketScanSession.saveSession(this.session)
            this._notify()
            return
        }

        entry.status = blob.status === "ok" ? "ok" : "error"
        if (blob.error) entry.error = blob.error
        entry.finishedAt = Date.now()
        this.session.inFlight = Math.max(0, this.session.inFlight - 1)
        if (this.timers[entry.type]) {
            clearTimeout(this.timers[entry.type])
            delete this.timers[entry.type]
        }
        await MarketScanSession.saveSession(this.session)
        this._notify()
        this.tick()
    }

    async _maybeFinish() {
        if (!this.session || this.session.status !== "running") return
        const allTerminal = this.session.queue.every(e => e.status !== "pending" && e.status !== "inflight")
        if (allTerminal) {
            this.session.status = "done"
            this.session.finishedAt = Date.now()
            if (this.staggerTimer) { clearTimeout(this.staggerTimer); this.staggerTimer = null }
            await MarketScanSession.saveSession(this.session)
            if (!this.mirror) {
                // Release the lease so any tab can start the next scan
                // immediately rather than waiting out the TTL. Also fold
                // in the freshly-completed observations to the per-type
                // history store so future classifier scores are anchored
                // against more samples.
                await MarketScanLease.release(this.server, this.session.scanId)
                ScanController._recordHistory(this.server, this.session)
            }
            this._notify()
        }
    }

    /**
     * Folds a finished scan's observations into per-type history. Best-
     * effort: any storage / module hiccup logs and moves on — the deal
     * classifier already has a within-scan fallback for cold-start types.
     */
    static async _recordHistory(server, session) {
        if (typeof MarketScanPriceHistory === "undefined") return
        try {
            const knownTypes = session.queue.map(e => e.type).filter(Boolean)
            const all = await MarketScanSession.loadResults(server, session.scanId, knownTypes)
            const rows = []
            for (const type in all) {
                const blob = all[type]
                if (!blob || !Array.isArray(blob.rows)) continue
                for (const r of blob.rows) rows.push(r)
            }
            if (typeof MarketScanDealMetrics !== "undefined") {
                // Re-decorate with the user's saved lease config so the
                // basis stamped on each history entry matches what the
                // classifier will look up against. Without this the entries
                // would default to lease-first regardless of the user's
                // setting and percentiles would drift from what the panel
                // shows live.
                let leaseConfig = null
                if (typeof UsedAircraftPresets !== "undefined") {
                    try {
                        const settings = await UsedAircraftPresets.load()
                        leaseConfig = settings && settings.leaseConfig
                    } catch (_) { /* ignore — fall through to default */ }
                }
                for (const r of rows) MarketScanDealMetrics.decorate(r, {leaseConfig})
            }
            await MarketScanPriceHistory.recordRows(server, rows)
        } catch (e) {
            console.error("AES marketScan: history recording failed:", e)
        }
    }

    /**
     * Returns the aggregated rows across all completed types in the current
     * session. Each row is augmented with the originating `type`.
     */
    async aggregatedRows() {
        if (!this.session) return []
        const knownTypes = this.session.queue.map(e => e.type).filter(Boolean)
        const results = await MarketScanSession.loadResults(
            this.server, this.session.scanId, knownTypes)
        const rows = []
        for (const type in results) {
            const blob = results[type]
            if (!blob || !Array.isArray(blob.rows)) continue
            for (const row of blob.rows) {
                rows.push(Object.assign({type: type}, row))
            }
        }
        return rows
    }

    dispose() {
        if (this.storageListener) chrome.storage.onChanged.removeListener(this.storageListener)
        this.storageListener = null
        if (this.staggerTimer) clearTimeout(this.staggerTimer)
        for (const t in this.timers) clearTimeout(this.timers[t])
        this.timers = {}
        this.listeners = []
    }
}
