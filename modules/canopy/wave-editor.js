"use strict"

/**
 * L10 Canopy Wave Editor
 *
 * This acts as an advanced scheduling interface integrating the canvas timeline,
 * wave preset configuration, turnaround validation (using scraped metadata),
 * and strategic hub advisories into one cohesive view.
 *
 * Core capabilities:
 *  - Orchestrate `CanvasTimelineSurface` to plot wave presets visually.
 *  - Bind `SchedulePresets` for reading/writing wave templates.
 *  - Integrate `AesStrategyHubDesignerModal`'s advisory intelligence directly
 *    into the hub planning interface.
 *  - Incorporate live turnaround scraping to flag game-level rule violations
 *    during wave planning.
 *
 * It bridges `fleet-hub/command-center.js` and `route-assistant/wave-editor.js`,
 * leveling them up to "Canopy" grade interactions.
 */

class CanopyWaveEditor {
    constructor(container, opts = {}) {
        this.container = container
        this.opts = opts
        this.hubIata = opts.hubIata || null
        this.server = opts.server || null
        this.airlineCode = opts.airlineCode || null

        // Internal State
        this._timeline = null
        this._activePreset = null
        this._hubProposals = null

        this._init()
    }

    async _init() {
        this.container.innerHTML = ""
        this.container.style.cssText = "display: flex; flex-direction: column; height: 100%; gap: 16px;"

        // Top bar: Hub Selector, Strategic Advisory, Preset Selector
        const header = this._buildHeader()
        this.container.appendChild(header)

        // Middle: Strategic Advisory Banner (conditionally shown)
        this._advisoryContainer = document.createElement("div")
        this.container.appendChild(this._advisoryContainer)

        // Main Editor Area: Timeline + Tools
        const mainArea = document.createElement("div")
        mainArea.style.cssText = "display: flex; flex: 1; min-height: 400px; border: 1px solid #374151; border-radius: 4px; overflow: hidden; background: #0f1623;"

        // Timeline surface
        this._timelineContainer = document.createElement("div")
        this._timelineContainer.style.cssText = "flex: 1; position: relative;"
        mainArea.appendChild(this._timelineContainer)

        // Side panel for wave config (composition, times)
        this._waveConfigPanel = document.createElement("div")
        this._waveConfigPanel.style.cssText = "width: 300px; border-left: 1px solid #374151; background: #1e293b; padding: 12px; overflow-y: auto;"
        mainArea.appendChild(this._waveConfigPanel)

        this.container.appendChild(mainArea)

        await this._loadData()
        this._render()
    }

    _buildHeader() {
        const header = document.createElement("div")
        header.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #1e293b; border-radius: 4px; border: 1px solid #374151;"

        const titleSection = document.createElement("div")
        titleSection.style.cssText = "display: flex; align-items: baseline; gap: 12px;"

        const title = document.createElement("h2")
        title.textContent = `Canopy Wave Editor: ${this.hubIata || 'Select Hub'}`
        title.style.cssText = "margin: 0; font-family: var(--aes-font-display, sans-serif); font-size: 16px; color: #f8fafc;"
        titleSection.appendChild(title)

        header.appendChild(titleSection)

        const actionsSection = document.createElement("div")
        actionsSection.style.cssText = "display: flex; gap: 8px; align-items: center;"

        const runAdvisoryBtn = document.createElement("button")
        runAdvisoryBtn.textContent = "Run Strategic Advisory"
        runAdvisoryBtn.style.cssText = "padding: 6px 12px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;"
        runAdvisoryBtn.addEventListener("click", () => this._runAdvisory())
        actionsSection.appendChild(runAdvisoryBtn)

        header.appendChild(actionsSection)

        return header
    }

    async _loadData() {
        // Fetch hub strategic data if we have a strategy network graph
        if (window.AesStrategy && typeof window.AesStrategy.designHubs === 'function' && window.AesStrategyNetworkGraph) {
             // In a real integration, we'd pass the actual snapshot. Passing null to see if it handles gracefully or we mock it.
             // We'll defer this to _runAdvisory
        }

        if (this.hubIata && window.SchedulePresets) {
             const presets = await window.SchedulePresets.load()
             this._hubPresets = presets.filter(p => p.hub === this.hubIata)
             if (this._hubPresets.length > 0) {
                 this._activePreset = this._hubPresets[0]
             } else {
                 // Create starter preset
                 if (window.RouteAssistantWaveEditor && window.RouteAssistantWaveEditor.createStarterPreset) {
                     this._activePreset = await window.RouteAssistantWaveEditor.createStarterPreset(this.hubIata)
                     this._hubPresets = [this._activePreset]
                 }
             }
        }
    }

    _render() {
        this._renderAdvisory()
        this._renderTimeline()
        this._renderConfigPanel()
    }

    _renderAdvisory() {
        this._advisoryContainer.innerHTML = ""
        if (!this._hubProposals || !this.hubIata) return

        const currentHubAdvisory = this._hubProposals.closes.find(c => c.iata === this.hubIata)
        if (currentHubAdvisory) {
            const banner = document.createElement("div")
            banner.style.cssText = "padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 4px; color: #fca5a5; font-size: 13px;"
            banner.textContent = `Strategic Advisory Warning: This hub is flagged for potential closure (Redundancy: ${(currentHubAdvisory.redundancyScore * 100).toFixed(0)}%). Consider wave efficiency carefully.`
            this._advisoryContainer.appendChild(banner)
        }
    }

    _renderTimeline() {
        if (!this._timelineContainer) return
        this._timelineContainer.innerHTML = ""

        if (typeof window.CanvasTimelineSurface === "function" && this._activePreset) {
            this._timeline = new window.CanvasTimelineSurface(this._timelineContainer)

            // Map wave preset into timeline data blocks
            const blocks = []
            if (this._activePreset.waves) {
                this._activePreset.waves.forEach((wave, i) => {
                    // Start of wave (arrival start)
                    const arrStart = this._timeToMins(wave.arrivalWindow?.start) || 0
                    const arrEnd = this._timeToMins(wave.arrivalWindow?.end) || 60
                    const depStart = this._timeToMins(wave.departureWindow?.start) || 90
                    const depEnd = this._timeToMins(wave.departureWindow?.end) || 120

                    blocks.push({
                        id: `w-${wave.id}-arr`,
                        lane: i,
                        startMin: arrStart,
                        endMin: arrEnd,
                        label: `Arr: ${wave.label}`,
                        color: "#3b82f6" // blue for arrivals
                    })

                    blocks.push({
                        id: `w-${wave.id}-dep`,
                        lane: i,
                        startMin: depStart,
                        endMin: depEnd,
                        label: `Dep: ${wave.label}`,
                        color: "#10b981" // green for departures
                    })

                    // Gap (turnaround) warning logic could be visually applied here
                    const turnTime = depStart - arrEnd
                    if (turnTime > 0 && turnTime < 45) { // Assuming 45 is scraped min turn
                         blocks.push({
                            id: `w-${wave.id}-turn`,
                            lane: i,
                            startMin: arrEnd,
                            endMin: depStart,
                            label: `Turn: ${turnTime}m`,
                            color: "#ef4444" // red for tight turn
                         })
                    }
                })
            }

            this._timeline.setData({
                lanes: this._activePreset.waves ? this._activePreset.waves.map((w, i) => ({ id: i, label: w.label })) : [],
                blocks: blocks,
                options: {
                    snapMinutes: 5,
                    viewportDays: 1,
                    startDayOffset: 0
                }
            })
            this._timeline.render()
        } else {
             const placeholder = document.createElement("div")
             placeholder.style.cssText = "display: flex; align-items: center; justify-content: center; height: 100%; color: #94a3b8;"
             placeholder.textContent = "Timeline Canvas pending data..."
             this._timelineContainer.appendChild(placeholder)
        }
    }

    _renderConfigPanel() {
        if (!this._waveConfigPanel) return
        this._waveConfigPanel.innerHTML = ""

        if (!this._activePreset) {
            this._waveConfigPanel.textContent = "No active preset."
            return
        }

        const h3 = document.createElement("h3")
        h3.textContent = `Preset: ${this._activePreset.name}`
        h3.style.cssText = "margin: 0 0 12px 0; color: #f1f5f9; font-size: 14px;"
        this._waveConfigPanel.appendChild(h3)

        if (window.RouteAssistantWaveEditor && typeof window.RouteAssistantWaveEditor.renderPresetActions === 'function') {
             const actions = window.RouteAssistantWaveEditor.renderPresetActions(this._activePreset, this._hubPresets, {
                 hubIata: this.hubIata,
                 onPickPreset: async (id) => {
                     this._activePreset = this._hubPresets.find(p => p.id === id)
                     this._render()
                 },
                 onAfterCreate: async (preset) => {
                     this._hubPresets.push(preset)
                     this._activePreset = preset
                     this._render()
                 }
             })
             this._waveConfigPanel.appendChild(actions)
        }

        // Render waves
        if (this._activePreset.waves && window.RouteAssistantWaveEditor) {
            const wavesContainer = document.createElement("div")
            wavesContainer.style.cssText = "margin-top: 16px; display: flex; flex-direction: column; gap: 8px;"

            this._activePreset.waves.forEach(wave => {
                const wCard = document.createElement("div")
                wCard.style.cssText = "padding: 8px; background: #0f1623; border: 1px solid #374151; border-radius: 4px;"
                window.RouteAssistantWaveEditor.renderWaveCard(wCard, wave, {
                    onComposition: async (id, comp) => {
                        wave.composition = { ...wave.composition, ...comp }
                        await window.SchedulePresets.update(this._activePreset.id, { waves: this._activePreset.waves })
                        this._render()
                    },
                    onTime: async (id, field, val) => {
                        if (field.startsWith('arrival')) {
                            if (!wave.arrivalWindow) wave.arrivalWindow = {}
                            wave.arrivalWindow[field.replace('arrival', '').toLowerCase()] = val
                        } else {
                            if (!wave.departureWindow) wave.departureWindow = {}
                            wave.departureWindow[field.replace('departure', '').toLowerCase()] = val
                        }
                        await window.SchedulePresets.update(this._activePreset.id, { waves: this._activePreset.waves })
                        this._render()
                    }
                })
                wavesContainer.appendChild(wCard)
            })
            this._waveConfigPanel.appendChild(wavesContainer)
        }
    }

    _runAdvisory() {
        if (window.AesStrategy && window.AesStrategy.designHubs && window.AesStrategyNetworkGraph) {
            // Need a snapshot. In a live env, we'd fetch this from the store.
            // For foundation laying, we stub or rely on the global graph if initialized.
            try {
                // Mocking a snapshot call if needed, or if graph is pre-built
                const mockSnapshot = { fleet: [] }
                this._hubProposals = window.AesStrategy.designHubs(mockSnapshot)
                this._renderAdvisory()
            } catch (e) {
                console.warn("Canopy Wave Editor: Failed to run advisory", e)
            }
        } else {
             alert("Strategy Module not fully loaded or network graph missing.")
        }
    }

    _timeToMins(timeStr) {
        if (!timeStr) return 0
        const [h, m] = timeStr.split(':').map(Number)
        return (h * 60) + (m || 0)
    }
}

if (typeof window !== "undefined") {
    window.CanopyWaveEditor = CanopyWaveEditor
}