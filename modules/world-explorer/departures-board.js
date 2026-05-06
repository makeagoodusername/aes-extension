"use strict"

class WorldExplorerDeparturesBoard {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = null;
        this.routes = [];
        this.selectedRoute = null;
        this.onHoverCallback = null;
        this.onSelectCallback = null;
    }

    init() {
        this.container = document.getElementById(this.containerId);
        if (!this.container) return;
        this.render();
    }

    setRoutes(routes) {
        this.routes = routes;
        this.render();
    }

    setFilters(filters) {
        this.filters = filters;
        this.render();
    }

    shouldShowRoute(route) {
        if (!this.filters) return true;
        if (route.isOurs && !this.filters.showOurFlights) return false;
        if (!route.isOurs && !this.filters.showCompetitors) return false;
        return true;
    }

    onHover(callback) {
        this.onHoverCallback = callback;
    }

    onSelect(callback) {
        this.onSelectCallback = callback;
    }

    selectRoute(routeId) {
        this.selectedRoute = routeId;
        this.render();
    }

    render() {
        if (!this.container) return;

        let html = `
            <div class="aes-bridge__card" style="background-color: #0a0a0a; border: 4px solid #1f1f1f; border-radius: 8px; font-family: 'Courier New', Courier, monospace; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <div class="aes-bridge__card-header" style="border-bottom: 2px solid #333; background-color: #111; padding: 15px;">
                    <h2 style="color: #f59e0b; font-family: 'Courier New', Courier, monospace; text-transform: uppercase; letter-spacing: 4px; font-weight: bold; margin: 0; text-shadow: 0 0 5px rgba(245, 158, 11, 0.5);">Departures Board</h2>
                </div>
                <div class="aes-bridge__card-body" style="padding: 20px; background: repeating-linear-gradient(0deg, #0a0a0a, #0a0a0a 2px, #111 2px, #111 4px);">
                    <table style="width: 100%; text-align: left; border-collapse: separate; border-spacing: 0 8px;">
                        <thead>
                            <tr style="color: #fbbf24; font-size: 1.1em; letter-spacing: 1px;">
                                <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">FLIGHT</th>
                                <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">AIRLINE</th>
                                <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">ORIGIN</th>
                                <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">DESTINATION</th>
                                <th style="padding: 10px 15px; border-bottom: 2px solid #fbbf24;">STATUS</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        const visibleRoutes = this.routes.filter(r => this.shouldShowRoute(r));

        if (visibleRoutes.length === 0) {
            html += `<tr><td colspan="5" style="padding: 20px; text-align: center; color: #555; font-size: 1.5em; letter-spacing: 4px;">NO FLIGHTS DISPLAYED</td></tr>`;
        } else {
            visibleRoutes.forEach(r => {
                const isSelected = this.selectedRoute === r.id;

                // Map affiliation kinds to colors
                const kindColors = {
                    "self":      "#10b981", // Kin (green)
                    "allied":    "#a855f7", // Allied (purple)
                    "interline": "#3b82f6", // Interline (blue)
                    "codeshare": "#06b6d4", // Codeshare (cyan)
                    "neutral":   "#9ca3af", // Neutral (gray)
                    "adversary": "#ef4444"  // Adversary (red)
                };

                const kindStr = r.kind || (r.isOurs ? "self" : "neutral");
                const statusStr = kindStr.toUpperCase();

                // Colors imitating split-flap or LED arrays
                const baseColor = kindColors[kindStr];
                const bgColor = isSelected ? "#333" : "#1a1a1a";
                const fontColor = isSelected ? "#fcd34d" : baseColor;
                const opacity = isSelected ? "1" : (r.isOurs ? "0.9" : "0.6");
                const boxShadow = isSelected ? "box-shadow: inset 0 0 10px rgba(252, 211, 77, 0.2);" : "";

                const hoverClass = isSelected ? "" : "we-board-row-hover";

                // Simulated split-flap cell styling
                const cellStyle = `padding: 12px 15px; background-color: ${bgColor}; border-top: 1px solid #2a2a2a; border-bottom: 1px solid #000; font-weight: bold; font-size: 1.2em; text-transform: uppercase;`;

                html += `
                    <tr class="we-board-row ${hoverClass}" data-id="${r.id}" style="cursor: pointer; color: ${fontColor}; opacity: ${opacity}; transition: all 0.2s ease;">
                        <td style="${cellStyle} border-left: 2px solid #333; border-top-left-radius: 4px; border-bottom-left-radius: 4px; ${boxShadow}">${escapeHtml(r.flightNumber || "---")}</td>
                        <td style="${cellStyle} ${boxShadow}">${escapeHtml(r.airline)}</td>
                        <td style="${cellStyle} ${boxShadow}">${escapeHtml(r.hub)}</td>
                        <td style="${cellStyle} ${boxShadow}">${escapeHtml(r.dest)}</td>
                        <td style="${cellStyle} border-right: 2px solid #333; border-top-right-radius: 4px; border-bottom-right-radius: 4px; ${boxShadow}">${statusStr}</td>
                    </tr>
                `;
            });
        }

        html += `
                        </tbody>
                    </table>
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
                    color: #fcd34d !important;
                    text-shadow: 0 0 8px rgba(252, 211, 77, 0.6) !important;
                }
            `;
            document.head.appendChild(style);
        }

        // Add event listeners
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
    }
}

if (typeof window !== "undefined") {
    window.WorldExplorerDeparturesBoard = WorldExplorerDeparturesBoard;
}
