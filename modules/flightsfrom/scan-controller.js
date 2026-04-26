/**
 * Orchestrates a single-airport flightsfrom.com scrape. Opens a child tab at
 * `https://www.flightsfrom.com/<IATA>#aesFfScan=<scanId>|<IATA>`, watches
 * chrome.storage.local for the status record the child writes, and notifies
 * UI listeners. Only one active scan per controller instance — callers should
 * wait for the current scan to finish (or cancel it) before starting another.
 */
class FlightsFromController {
    constructor() {
        this.activeScan = null  // {scanId, iata, startedAt, status}
        this.listeners = []
        this.storageListener = null
        this.watchdog = null
        this.WATCHDOG_MS = 90 * 1000  // flightsfrom can be slow under load
    }

    onUpdate(cb) { this.listeners.push(cb) }

    _notify() {
        for (const cb of this.listeners) {
            try { cb(this.activeScan) } catch (e) { console.error("FlightsFromController listener:", e) }
        }
    }

    /**
     * Kick off a scrape for an airport. Resolves with the activeScan record
     * once the child tab is opened; progress arrives via onUpdate callbacks.
     * @param {string} iata - IATA code (3 letters)
     */
    async start(iata) {
        if (!iata || !/^[A-Za-z]{3}$/.test(iata)) {
            throw new Error("Invalid IATA: " + iata)
        }
        iata = iata.toUpperCase()
        if (this.activeScan && this.activeScan.status === "running") {
            throw new Error("Another scan is already running (" + this.activeScan.iata + ")")
        }

        const scanId = Date.now().toString(36)
        this.activeScan = {
            scanId: scanId,
            iata: iata,
            startedAt: Date.now(),
            status: "running",
            error: null,
            progress: null
        }

        // Seed the status record so the child can update it incrementally.
        await FlightsFromStore.saveStatus(iata, {
            scanId: scanId,
            status: "running",
            startedAt: this.activeScan.startedAt,
            error: null,
            progress: null
        })

        this._installStorageListener()
        this._armWatchdog()

        const url = "https://www.flightsfrom.com/" + encodeURIComponent(iata)
            + "?aesFfTs=" + Date.now()
            + "#aesFfScan=" + scanId + "|" + encodeURIComponent(iata)
        const win = window.open(url, "_blank")
        if (!win) {
            this.activeScan.status = "error"
            this.activeScan.error = "pop-up blocked (allow pop-ups for www.flightsfrom.com)"
            await FlightsFromStore.saveStatus(iata, {
                scanId: scanId,
                status: "error",
                error: this.activeScan.error
            })
            this._clearWatchdog()
            this._notify()
            return this.activeScan
        }

        this._notify()
        return this.activeScan
    }

    async cancel() {
        if (!this.activeScan || this.activeScan.status !== "running") return
        this.activeScan.status = "aborted"
        await FlightsFromStore.saveStatus(this.activeScan.iata, {
            scanId: this.activeScan.scanId,
            status: "aborted"
        })
        this._clearWatchdog()
        this._notify()
    }

    _installStorageListener() {
        if (this.storageListener) return
        this.storageListener = (changes, area) => {
            if (area !== "local") return
            const scan = this.activeScan
            if (!scan) return
            const statusKey = "flightsFrom:" + scan.iata + ":status"
            if (!(statusKey in changes)) return
            const blob = changes[statusKey].newValue
            if (!blob || blob.scanId !== scan.scanId) return
            this._handleStatus(blob)
        }
        chrome.storage.onChanged.addListener(this.storageListener)
    }

    _handleStatus(blob) {
        const scan = this.activeScan
        if (!scan) return

        if (blob.progress) scan.progress = blob.progress

        if (blob.status === "scanning") {
            this._armWatchdog()  // reset
            this._notify()
            return
        }
        // Terminal: ok / error / aborted
        scan.status = blob.status
        scan.error = blob.error || null
        scan.finishedAt = Date.now()
        this._clearWatchdog()
        this._notify()
    }

    _armWatchdog() {
        this._clearWatchdog()
        this.watchdog = setTimeout(() => this._handleTimeout(), this.WATCHDOG_MS)
    }

    _clearWatchdog() {
        if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null }
    }

    async _handleTimeout() {
        const scan = this.activeScan
        if (!scan || scan.status !== "running") return
        scan.status = "timeout"
        scan.error = "no progress within " + Math.round(this.WATCHDOG_MS / 1000) + "s"
        await FlightsFromStore.saveStatus(scan.iata, {
            scanId: scan.scanId,
            status: "timeout",
            error: scan.error
        })
        this._notify()
    }

    dispose() {
        if (this.storageListener) chrome.storage.onChanged.removeListener(this.storageListener)
        this.storageListener = null
        this._clearWatchdog()
        this.listeners = []
    }
}
