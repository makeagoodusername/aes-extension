"use strict"

/**
 * CanvasRailController — orchestrates the assistant rail.
 *
 * Owns the cross-cutting interaction:
 *   - Mount rail-shell into the canvas's rail slot.
 *   - When Builder is active and a hub-changed/proposal-rerun is requested,
 *     ask the builder engine to stream proposals; render each as a card.
 *   - When Advisor is active (Phase E), subscribe to canvas:edit-staged
 *     and forward to the advisor engine; render its suggestions.
 *   - Track staged edits in memory; reflect count in rail footer.
 *   - Commit/discard buttons emit canvas:edit-committed / EDIT_DISCARDED.
 *
 * The controller does NOT load data itself — the canvas-modal supplies a
 * `getInputs()` callback returning {hub, fleet, schedules, preset}. This
 * keeps the controller pure and re-mountable on other surfaces.
 */
class CanvasRailController {

    constructor(deps) {
        const d = deps || {}
        this.getInputs = typeof d.getInputs === "function" ? d.getInputs : (() => ({}))
        this.onRailClose = typeof d.onRailClose === "function" ? d.onRailClose : null
        this.server      = d.server || ""
        this.airlineCode = d.airlineCode || ""
        this.builderEngine = (d.builderEngine !== undefined) ? d.builderEngine
            : (typeof window !== "undefined" && window.CanvasBuilderEngine
                ? new window.CanvasBuilderEngine() : null)
        this.advisorEngine = (d.advisorEngine !== undefined) ? d.advisorEngine
            : (typeof window !== "undefined" && window.CanvasAdvisorEngine
                ? new window.CanvasAdvisorEngine({getInputs: this.getInputs}) : null)
        this.commitBar = (typeof window !== "undefined" && window.CanvasCommitBar)
            ? new window.CanvasCommitBar({
                server:      this.server,
                airlineCode: this.airlineCode,
                getStaged:   () => this._stagedEdits.slice(),
                clearStaged: () => { this._stagedEdits = [] }
            })
            : null

        this._stagedEdits = []
        this._railShell = null
        this._busOff = []
        this._activeBuilderRunId = 0
    }

    /** Public: stage one or more edits from outside the rail (drop bridge,
     *  context menu, demand badges). Same envelope shape as Builder Adopt. */
    stageEdits(edits, info) {
        if (!Array.isArray(edits)) edits = [edits]
        this._stageEdits(edits.filter(Boolean), info || {})
    }

    mount(railSlotEl) {
        if (!railSlotEl) return
        const inputs = this._safeInputs()
        const initialMode = this._initialModeFromState()
        this._railShell = new window.CanvasRailShell({
            activeHub:    inputs && inputs.hub,
            mode:         initialMode,
            onModeChange: (mode) => this._onModeChange(mode),
            onClose:      () => { if (this.onRailClose) this.onRailClose() },
            onCommit:     () => this._onCommit(),
            onDiscard:    () => this._onDiscard()
        })
        this._railShell.mount(railSlotEl)
        this._railShell.setStagedCount(0)
        this._renderModeBody(initialMode)

        if (this.advisorEngine && typeof this.advisorEngine.start === "function") {
            try { this.advisorEngine.start() } catch (_) {}
        }
        this._wireBus()
    }

    dispose() {
        for (const off of this._busOff) { try { off() } catch (_) {} }
        this._busOff = []
        if (this.advisorEngine && typeof this.advisorEngine.stop === "function") {
            try { this.advisorEngine.stop() } catch (_) {}
        }
        this._railShell = null
    }

    /** Re-run the builder for the current hub. Cancels in-flight work. */
    async rerunBuilder() {
        const mode = this._currentMode()
        if (mode !== window.CanvasRailShell.MODE_BUILDER) return
        await this._runBuilder()
    }

    _initialModeFromState() {
        try {
            // Read the canvas state synchronously via a sticky in-memory copy
            // when one exists (canvas-state-store.load is async; this read
            // happens during rail mount before the state has resolved).
            // Fall back to "builder" as the default first-mount mode.
            const last = (typeof window !== "undefined" && window.__aesCanvasLastState) || null
            if (last && (last.railMode === "advisor" || last.railMode === "builder")) {
                return last.railMode
            }
        } catch (_) {}
        return window.CanvasRailShell.MODE_BUILDER
    }

    _currentMode() {
        return this._railShell ? this._railShell.mode : window.CanvasRailShell.MODE_BUILDER
    }

    async _onModeChange(mode) {
        if (typeof window !== "undefined" && window.AesCanvasStateStore) {
            try { await window.AesCanvasStateStore.save({railMode: mode}) }
            catch (_) {}
        }
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.RAIL_MODE_CHANGED, {mode})
        }
        this._renderModeBody(mode)
    }

    _renderModeBody(mode) {
        if (!this._railShell) return
        if (mode === window.CanvasRailShell.MODE_ADVISOR) {
            this._renderAdvisorBody()
        } else {
            this._renderBuilderBody()
        }
    }

    _renderBuilderBody() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;"

        const lead = document.createElement("div")
        lead.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";line-height:1.4;"
        lead.textContent = "Builder fills empty wave cells using cached demand. Pick one to stage edits, or drag the canvas to take over."
        wrap.append(lead)

        const inputs = this._safeInputs()
        if (!inputs || !inputs.hub) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;padding:24px 0;text-align:center;"
            empty.textContent = "Pick a hub to run the builder."
            wrap.append(empty)
            this._railShell.setBody(wrap)
            return
        }

        const status = document.createElement("div")
        status.style.cssText = "font-size:10px;font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";"
        status.textContent = "Streaming proposals…"
        wrap.append(status)
        this._builderStatusEl = status
        this._builderProposalsHost = wrap
        this._railShell.setBody(wrap)

        // Kick off
        this._runBuilder().catch(e => console.warn("[AES Canvas] builder run failed", e))
    }

    _renderAdvisorBody() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        const lead = document.createElement("div")
        lead.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";line-height:1.4;"
        lead.textContent = "Advisor surfaces conflicts and suggestions as you edit. Drag a route to a cell to start."
        wrap.append(lead)

        // Phase H — auto-proposer surfacing CTA. Runs the configured silent-auto
        // proposer over the active hub's cached top routes; positive proposals
        // appear as Advisor cards via surface().
        const proposerRow = document.createElement("div")
        proposerRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        const proposerBtn = document.createElement("button")
        proposerBtn.type = "button"
        proposerBtn.textContent = "Run proposers now"
        proposerBtn.style.cssText = "padding:3px 8px;font-size:10px;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;font-weight:" + (T ? T.fw.bold : "700") + ";"
        const proposerStatus = document.createElement("span")
        proposerStatus.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        proposerBtn.addEventListener("click", async () => {
            proposerBtn.disabled = true
            proposerStatus.textContent = "Running…"
            const n = await this._runProposerSurfaceTick()
            proposerStatus.textContent = n + " surfaced"
            proposerBtn.disabled = false
        })
        proposerRow.append(proposerBtn, proposerStatus)
        wrap.append(proposerRow)

        this._advisorListEl = document.createElement("div")
        this._advisorListEl.setAttribute("role", "list")
        this._advisorListEl.setAttribute("aria-label", "Advisor suggestions")
        this._advisorListEl.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        wrap.append(this._advisorListEl)
        this._railShell.setBody(wrap)
    }

    async _runBuilder() {
        if (!this.builderEngine) return
        const inputs = this._safeInputs()
        if (!inputs || !inputs.hub || !inputs.preset) return
        // Clear prior cards (other than the leading status line).
        const host = this._builderProposalsHost
        if (!host) return
        // Remove existing builder cards from this host (siblings of the status line).
        for (const child of Array.from(host.querySelectorAll(".aes-canvas-builder-card"))) {
            child.remove()
        }
        if (this._builderStatusEl) this._builderStatusEl.textContent = "Streaming proposals…"
        const runId = ++this._activeBuilderRunId
        try {
            await this.builderEngine.propose({
                hub:       inputs.hub,
                fleet:     inputs.fleet || [],
                schedules: inputs.schedules || new Map(),
                preset:    inputs.preset,
                demandRows: null
            })
            if (runId !== this._activeBuilderRunId) return
            if (this._builderStatusEl) this._builderStatusEl.textContent = "Done — pick a card to stage edits."
        } catch (e) {
            if (this._builderStatusEl) this._builderStatusEl.textContent = "Builder error — see console."
            throw e
        }
    }

    _onProposal(proposal) {
        if (this._currentMode() !== window.CanvasRailShell.MODE_BUILDER) return
        const host = this._builderProposalsHost
        if (!host) return
        const card = window.CanvasBuilderCard.render(proposal, {
            onAdopt: (edits, info) => this._stageEdits(edits, info)
        })
        host.appendChild(card)
    }

    _stageEdits(edits, info) {
        if (!Array.isArray(edits) || !edits.length) return
        const batchId = "b-" + Date.now().toString(36)
        for (const e of edits) {
            this._stagedEdits.push(Object.assign({_batch: batchId}, e))
            if (typeof window !== "undefined" && window.CentralHubBus) {
                window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_STAGED,
                    {kind: e.kind, payload: e, batchId})
            }
        }
        if (this._railShell) this._railShell.setStagedCount(this._stagedEdits.length)
        // Auto-flip to Advisor on first staged batch (per plan).
        if (info && !info.fragment && this._currentMode() === window.CanvasRailShell.MODE_BUILDER) {
            this._railShell.setMode(window.CanvasRailShell.MODE_ADVISOR)
            this._onModeChange(window.CanvasRailShell.MODE_ADVISOR)
        }
    }

    async _onCommit() {
        if (!this._stagedEdits.length) return
        if (this.commitBar) {
            await this.commitBar.commit()
            if (this._railShell) this._railShell.setStagedCount(0)
            return
        }
        // Fallback path when commit-bar isn't loaded — emit + clear so the
        // rail returns to a clean state.
        const batchId = "c-" + Date.now().toString(36)
        const edits = this._stagedEdits.slice()
        this._stagedEdits = []
        if (this._railShell) this._railShell.setStagedCount(0)
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_COMMITTED, {batchId, edits})
        }
    }

    _onDiscard() {
        if (!this._stagedEdits.length) return
        if (this.commitBar) {
            this.commitBar.discard()
            if (this._railShell) this._railShell.setStagedCount(0)
            return
        }
        const batchId = "d-" + Date.now().toString(36)
        this._stagedEdits = []
        if (this._railShell) this._railShell.setStagedCount(0)
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_DISCARDED, {batchId})
        }
    }

    _safeInputs() {
        try { return this.getInputs() || {} }
        catch (e) { console.warn("[AES Canvas] rail getInputs failed", e); return {} }
    }

    /**
     * Phase H — manual proposer surface. Reads the active hub's cached
     * topRoutes + per-route price cache, runs the configured silent-auto
     * proposer through `surface()` (which emits ADVISOR_SUGGESTION on a
     * positive proposal). Returns the count of suggestions emitted so the
     * caller can update its status text.
     *
     * Reads settings via RouteAssistantSettings; uses the configured
     * `pricing.silentAutoStrategy` (defaults to "competitor-median").
     * Skips when surface() isn't available — older bundles without the
     * Phase 8 wrapper still work via the silent loop in panel.js.
     */
    async _runProposerSurfaceTick() {
        const inputs = this._safeInputs()
        const hub = inputs && inputs.hub
        if (!hub) return 0
        if (typeof window === "undefined") return 0
        if (!window.RouteAssistantSilentAutoProposers
            || typeof window.RouteAssistantSilentAutoProposers.surface !== "function") {
            return 0
        }
        let cfg = {}
        try {
            if (window.RouteAssistantSettings) {
                const s = await window.RouteAssistantSettings.load()
                const p = (s && s.pricing) || {}
                cfg = Object.assign({}, p)
                if (p.apply) cfg = Object.assign(cfg, p.apply)
            }
        } catch (_) {}
        const strategy = cfg.silentAutoStrategy || "competitor-median"
        const rows = await this._loadTopRoutes(hub)
        if (!rows || !rows.length) return 0
        const ctx = {hub}
        let n = 0
        for (const r of rows) {
            if (!r || !r.destIata) continue
            const prices = await this._loadCachedPrices(hub, r.destIata)
            if (!prices) continue
            const result = window.RouteAssistantSilentAutoProposers.surface(strategy, r, prices, cfg, ctx)
            if (result && result.ok) n++
        }
        return n
    }

    async _loadTopRoutes(hub) {
        try {
            const key = "routeAssistant:topRoutes:" + String(hub).toUpperCase()
            const data = await chrome.storage.local.get([key])
            const blob = data[key]
            return (blob && Array.isArray(blob.rows)) ? blob.rows : []
        } catch (_) { return [] }
    }

    async _loadCachedPrices(hub, dest) {
        try {
            const key = "routeAssistant:prices:" + String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
            const data = await chrome.storage.local.get([key])
            const blob = data[key]
            if (!blob) return null
            if (blob.prices && typeof blob.prices === "object" && Object.keys(blob.prices).length) {
                return blob.prices
            }
            // Bare-map shape: prices live at the top level.
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (isFinite(blob[cls])) return {Y: blob.Y, C: blob.C, F: blob.F, Cargo: blob.Cargo}
            }
            return null
        } catch (_) { return null }
    }

    _wireBus() {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        const sub = (event, handler) => {
            const off = window.CentralHubBus.on(event, handler)
            this._busOff.push(off)
        }
        sub(window.AesCanvasEvents.BUILDER_PROPOSAL, (p) => this._onProposal(p))
        // Re-run builder when the active hub changes.
        sub(window.AesCanvasEvents.HUB_CHANGED, () => {
            if (this._currentMode() === window.CanvasRailShell.MODE_BUILDER) {
                this._renderBuilderBody()
            }
        })
        sub(window.AesCanvasEvents.ADVISOR_SUGGESTION, (s) => this._onAdvisorSuggestion(s))
        // External stage events — advisor card actions, the demand-overlay
        // "Stage edit" badge, the silent-auto-proposer surface() wrapper, etc.
        // The controller's own _stageEdits emits also flow through here; we
        // skip those by checking for the controller-stamped batchId.
        sub(window.AesCanvasEvents.EDIT_STAGED, (e) => this._onExternalEditStaged(e))
    }

    _onExternalEditStaged(event) {
        if (!event || !event.payload) return
        // Guard: the controller's own _stageEdits emits with batchId `b-…`.
        // Skip those to avoid double-staging.
        if (event.batchId && /^b-/.test(String(event.batchId))) return
        const payload = event.payload
        const kind = event.kind || payload.kind
        if (!kind) return
        const edit = (payload.kind && payload.payload) ? payload : {kind, payload}
        // Don't recurse: bypass _stageEdits' bus emit by pushing directly.
        const batchId = "x-" + Date.now().toString(36)
        this._stagedEdits.push(Object.assign({_batch: batchId}, edit))
        if (this._railShell) this._railShell.setStagedCount(this._stagedEdits.length)
    }

    _onAdvisorSuggestion(suggestion) {
        if (!suggestion) return
        // Always queue advisor suggestions in the list. Mode-flipping is
        // handled in _stageEdits; if the user is in Builder mode we still
        // collect suggestions silently so they show up the moment they
        // flip to Advisor.
        if (!this._advisorListEl) {
            // Re-render advisor body lazily so the list element exists.
            this._renderAdvisorBody()
        }
        if (!this._advisorListEl) return
        const card = window.CanvasAdvisorCard.render(suggestion)
        // Newest at the top — feels more reactive to the user's last action.
        this._advisorListEl.insertBefore(card, this._advisorListEl.firstChild)
    }
}

if (typeof window !== "undefined") {
    window.CanvasRailController = CanvasRailController
}
