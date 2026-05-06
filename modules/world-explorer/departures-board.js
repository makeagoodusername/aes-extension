"use strict"

class WorldExplorerDeparturesBoard {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = null;
        this.routes = [];
        this.allHubs = new Set();

        // Filter state
        this.filters = {
            ownership: {
                isOurs: true,
                isAlliance: true,
                isSubsidiary: true,
                isCompetitor: true
            },
            types: {
                current: true,
                potential: true,
                realWorld: true,
                interlining: true
            },
            hubs: {}, // populated dynamically
            performanceMode: false
        };

        this.selectedRoute = null;
        this.onHoverCallback = null;
        this.onSelectCallback = null;
        this.onFilterChangeCallback = null;
    }

    init() {
        this.container = document.getElementById(this.containerId);
        if (!this.container) return;
        this.render();
    }

    setRoutes(routes) {
        this.routes = routes;

        // Extract unique hubs
        const oldHubs = new Set(Object.keys(this.filters.hubs));
        this.allHubs = new Set();

        routes.forEach(r => {
            if (r.hub) this.allHubs.add(r.hub);
            if (r.dest) this.allHubs.add(r.dest); // Add destination as well to allow filtering by any endpoint
        });

        // Initialize new hubs to visible
        this.allHubs.forEach(hub => {
            if (this.filters.hubs[hub] === undefined) {
                this.filters.hubs[hub] = true;
            }
        });

        this.render();
    }

    onHover(callback) {
        this.onHoverCallback = callback;
    }

    onSelect(callback) {
        this.onSelectCallback = callback;
    }

    onFilterChange(callback) {
        this.onFilterChangeCallback = callback;
    }

    selectRoute(routeId) {
        this.selectedRoute = routeId;
        this.render();
    }

    // Check if a route passes the current filters
    routePassesFilters(r) {
        // Ownership
        let ownershipPass = false;
        if (r.isOurs && this.filters.ownership.isOurs) ownershipPass = true;
        if (r.isAlliance && this.filters.ownership.isAlliance) ownershipPass = true;
        if (r.isSubsidiary && this.filters.ownership.isSubsidiary) ownershipPass = true;
        if (r.isCompetitor && this.filters.ownership.isCompetitor) ownershipPass = true;
        if (!r.isOurs && !r.isAlliance && !r.isSubsidiary && !r.isCompetitor) ownershipPass = true; // Fallback

        // Types
        let typePass = false;
        if (r.isCurrent && this.filters.types.current) typePass = true;
        if (r.isPotential && this.filters.types.potential) typePass = true;
        if (r.isRealWorld && this.filters.types.realWorld) typePass = true;
        if (r.isInterlining && this.filters.types.interlining) typePass = true;
        if (!r.isCurrent && !r.isPotential && !r.isRealWorld && !r.isInterlining) typePass = true; // Fallback if no specific type set (assume current)

        // Hubs (route is visible if EITHER its origin or destination is enabled)
        const hubPass = this.filters.hubs[r.hub] || this.filters.hubs[r.dest];

        return ownershipPass && typePass && hubPass;
    }

    render() {
        if (!this.container) return;

        // Filter routes for display
        const visibleRoutes = this.routes.filter(r => this.routePassesFilters(r));

        let html = `
            <div class="aes-bridge__card" style="background-color: #0a0a0a; border: 4px solid #1f1f1f; border-radius: 8px; font-family: 'Courier New', Courier, monospace; box-shadow: 0 10px 30px rgba(0,0,0,0.8); display: flex; flex-direction: column; max-height: 800px;">
                <div class="aes-bridge__card-header" style="border-bottom: 2px solid #333; background-color: #111; padding: 15px; display: flex; justify-content: space-between; align-items: center;">
                    <h2 style="color: #f59e0b; font-family: 'Courier New', Courier, monospace; text-transform: uppercase; letter-spacing: 4px; font-weight: bold; margin: 0; text-shadow: 0 0 5px rgba(245, 158, 11, 0.5);">Operations Center</h2>
                    <div style="color: #666; font-size: 0.9em;">Showing ${visibleRoutes.length} of ${this.routes.length} routes</div>
                </div>

                <div style="display: flex; flex: 1; min-height: 0;">
                    <!-- Filter Panel Sidebar -->
                    <div style="width: 280px; background-color: #111; border-right: 2px solid #333; padding: 15px; overflow-y: auto; color: #ccc;">
                        <h3 style="color: #fbbf24; margin-top: 0; font-size: 1.1em; border-bottom: 1px solid #333; padding-bottom: 5px;">FILTERS</h3>

                        <!-- Ownership Filters -->
                        <div style="margin-bottom: 20px;">
                            <h4 style="color: #9ca3af; font-size: 0.9em; margin-bottom: 10px; text-transform: uppercase;">Ownership</h4>
                            ${this.renderCheckbox('ownership', 'isOurs', 'My Routes', '#f59e0b')}
                            ${this.renderCheckbox('ownership', 'isAlliance', 'Alliance Routes', '#3b82f6')}
                            ${this.renderCheckbox('ownership', 'isSubsidiary', 'Subsidiaries', '#93c5fd')}
                            ${this.renderCheckbox('ownership', 'isCompetitor', 'Competitors', '#ef4444')}
                        </div>

                        <!-- Route Types Filters -->
                        <div style="margin-bottom: 20px;">
                            <h4 style="color: #9ca3af; font-size: 0.9em; margin-bottom: 10px; text-transform: uppercase;">Route Types</h4>
                            ${this.renderCheckbox('types', 'current', 'Current Routes', '#ccc')}
                            ${this.renderCheckbox('types', 'potential', 'Potential Routes', '#a855f7')}
                            ${this.renderCheckbox('types', 'realWorld', 'Real-World (Dashed)', '#10b981')}
                            ${this.renderCheckbox('types', 'interlining', 'Interlining', '#f472b6')}
                        </div>

                        <!-- Performance Controls -->
                        <div style="margin-bottom: 20px;">
                            <h4 style="color: #9ca3af; font-size: 0.9em; margin-bottom: 10px; text-transform: uppercase;">Display Mode</h4>
                            <label style="display: flex; align-items: center; margin-bottom: 5px; cursor: pointer;">
                                <input type="checkbox" id="filter-perf" ${this.filters.performanceMode ? 'checked' : ''} style="margin-right: 10px;">
                                <span style="font-size: 0.9em;">Raw Draw / Performance Mode</span>
                            </label>
                        </div>

                        <!-- Hub Filters -->
                        <div style="margin-bottom: 10px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                <h4 style="color: #9ca3af; font-size: 0.9em; margin: 0; text-transform: uppercase;">Hubs</h4>
                                <div>
                                    <button id="we-btn-hubs-all" style="background: none; border: 1px solid #333; color: #aaa; cursor: pointer; font-size: 0.8em; padding: 2px 5px;">All</button>
                                    <button id="we-btn-hubs-none" style="background: none; border: 1px solid #333; color: #aaa; cursor: pointer; font-size: 0.8em; padding: 2px 5px;">None</button>
                                </div>
                            </div>
                            <div style="max-height: 200px; overflow-y: auto; border: 1px solid #222; padding: 5px;">
                                ${Array.from(this.allHubs).sort().map(hub => `
                                    <label style="display: flex; align-items: center; margin-bottom: 3px; cursor: pointer;">
                                        <input type="checkbox" class="we-hub-filter" data-hub="${hub}" ${this.filters.hubs[hub] ? 'checked' : ''} style="margin-right: 8px;">
                                        <span style="font-size: 0.85em;">${escapeHtml(hub)}</span>
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                    </div>

                    <!-- Departures Board Body -->
                    <div class="aes-bridge__card-body" style="flex: 1; padding: 20px; background: repeating-linear-gradient(0deg, #0a0a0a, #0a0a0a 2px, #111 2px, #111 4px); overflow-y: auto;">
                        <table style="width: 100%; text-align: left; border-collapse: separate; border-spacing: 0 8px;">
                            <thead style="position: sticky; top: 0; background-color: rgba(10,10,10,0.9);">
                                <tr style="color: #fbbf24; font-size: 1.1em; letter-spacing: 1px;">
                                    <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">FLIGHT</th>
                                    <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">AIRLINE</th>
                                    <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">ROUTE</th>
                                    <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">TYPE</th>
                                </tr>
                            </thead>
                            <tbody>
            `;

        if (visibleRoutes.length === 0) {
            html += `<tr><td colspan="4" style="padding: 40px; text-align: center; color: #555; font-size: 1.5em; letter-spacing: 4px;">NO ROUTES MATCH FILTERS</td></tr>`;
        } else {
            // Only render up to 200 routes in the board to avoid DOM freeze
            const renderLimit = 200;
            const routesToRender = visibleRoutes.slice(0, renderLimit);

            routesToRender.forEach(r => {
                const isSelected = this.selectedRoute === r.id;

                // Determine base color based on category
                let baseColor = "#9ca3af";
                let typeLabel = "UNKNOWN";

                if (r.isOurs) { baseColor = "#f59e0b"; typeLabel = "OURS"; }
                else if (r.isAlliance) { baseColor = "#3b82f6"; typeLabel = "ALLIANCE"; }
                else if (r.isSubsidiary) { baseColor = "#93c5fd"; typeLabel = "SUBSIDIARY"; }
                else if (r.isCompetitor) { baseColor = "#ef4444"; typeLabel = "COMPETITOR"; }
                else if (r.isRealWorld) { baseColor = "#10b981"; typeLabel = "REAL WORLD"; }
                else if (r.isPotential) { baseColor = "#a855f7"; typeLabel = "POTENTIAL"; }
                else if (r.isInterlining) { baseColor = "#f472b6"; typeLabel = "INTERLINING"; }

                const bgColor = isSelected ? "#333" : "#1a1a1a";
                const fontColor = isSelected ? "#ffffff" : baseColor;
                const opacity = isSelected ? "1" : "0.9";
                const boxShadow = isSelected ? "box-shadow: inset 0 0 10px rgba(255, 255, 255, 0.2);" : "";

                const hoverClass = isSelected ? "" : "we-board-row-hover";

                // Simulated split-flap cell styling
                const cellStyle = `padding: 12px 15px; background-color: ${bgColor}; border-top: 1px solid #2a2a2a; border-bottom: 1px solid #000; font-weight: bold; font-size: 1.1em; text-transform: uppercase;`;

                html += `
                    <tr class="we-board-row ${hoverClass}" data-id="${r.id}" style="cursor: pointer; color: ${fontColor}; opacity: ${opacity}; transition: all 0.2s ease;">
                        <td style="${cellStyle} border-left: 2px solid #333; border-top-left-radius: 4px; border-bottom-left-radius: 4px; ${boxShadow}">${escapeHtml(r.flightNumber || "---")}</td>
                        <td style="${cellStyle} ${boxShadow}">${escapeHtml(r.airline)}</td>
                        <td style="${cellStyle} ${boxShadow}">${escapeHtml(r.hub)} → ${escapeHtml(r.dest)}</td>
                        <td style="${cellStyle} border-right: 2px solid #333; border-top-right-radius: 4px; border-bottom-right-radius: 4px; ${boxShadow}">${typeLabel}</td>
                    </tr>
                `;
            });

            if (visibleRoutes.length > renderLimit) {
                html += `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #888;">+ ${visibleRoutes.length - renderLimit} MORE ROUTES (HIDDEN FOR PERFORMANCE)</td></tr>`;
            }
        }

        html += `
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        this.container.innerHTML = html;

        // Add styles for hover
        if (!document.getElementById("we-styles-board")) {
            const style = document.createElement("style");
            style.id = "we-styles-board";
            style.textContent = `
                .we-board-row-hover:hover {
                    opacity: 1 !important;
                    transform: scale(1.01);
                }
                .we-board-row-hover:hover td {
                    background-color: #262626 !important;
                    color: #ffffff !important;
                    text-shadow: 0 0 8px rgba(255, 255, 255, 0.6) !important;
                }
            `;
            document.head.appendChild(style);
        }

        // Add event listeners for rows
        const rows = this.container.querySelectorAll(".we-board-row");
        rows.forEach(row => {
            const id = row.getAttribute("data-id");
            row.addEventListener("mouseenter", () => {
                if (this.onHoverCallback) this.onHoverCallback(id);
            });
            row.addEventListener("mouseleave", () => {
                if (this.onHoverCallback) this.onHoverCallback(null);
            });
            row.addEventListener("click", () => {
                this.selectRoute(id);
                if (this.onSelectCallback) this.onSelectCallback(id);
            });
        });

        // Add event listeners for filters
        this.container.querySelectorAll('.we-filter-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const category = e.target.getAttribute('data-cat');
                const key = e.target.getAttribute('data-key');
                this.filters[category][key] = e.target.checked;
                this.notifyFilterChange();
            });
        });

        const perfCb = this.container.querySelector('#filter-perf');
        if (perfCb) {
            perfCb.addEventListener('change', (e) => {
                this.filters.performanceMode = e.target.checked;
                this.notifyFilterChange();
            });
        }

        this.container.querySelectorAll('.we-hub-filter').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const hub = e.target.getAttribute('data-hub');
                this.filters.hubs[hub] = e.target.checked;
                this.notifyFilterChange();
            });
        });

        const btnAll = this.container.querySelector('#we-btn-hubs-all');
        if (btnAll) {
            btnAll.addEventListener('click', () => {
                Object.keys(this.filters.hubs).forEach(h => this.filters.hubs[h] = true);
                this.notifyFilterChange();
            });
        }

        const btnNone = this.container.querySelector('#we-btn-hubs-none');
        if (btnNone) {
            btnNone.addEventListener('click', () => {
                Object.keys(this.filters.hubs).forEach(h => this.filters.hubs[h] = false);
                this.notifyFilterChange();
            });
        }
    }

    renderCheckbox(category, key, label, color) {
        const isChecked = this.filters[category][key];
        return `
            <label style="display: flex; align-items: center; margin-bottom: 5px; cursor: pointer;">
                <input type="checkbox" class="we-filter-cb" data-cat="${category}" data-key="${key}" ${isChecked ? 'checked' : ''} style="margin-right: 10px;">
                <div style="width: 12px; height: 12px; background-color: ${color}; border-radius: 2px; margin-right: 8px;"></div>
                <span style="font-size: 0.9em;">${label}</span>
            </label>
        `;
    }

    notifyFilterChange() {
        this.render(); // Re-render the board with new filters

        if (this.onFilterChangeCallback) {
            // Generate the list of visible routes to pass to the map
            const visibleRoutes = this.routes.filter(r => this.routePassesFilters(r));
            this.onFilterChangeCallback(visibleRoutes, this.filters.performanceMode);
        }
    }
}

if (typeof window !== "undefined") {
    window.WorldExplorerDeparturesBoard = WorldExplorerDeparturesBoard;
}
