"use strict"

class WorldExplorerMap {
    constructor(containerId) {
        this.containerId = containerId;
        this.canvas = null;
        this.ctx = null;
        this.width = 800;
        this.height = 400;
        this.routes = [];
        this.selectedRoute = null;
        this.hoveredRoute = null;
        this.onSelectCallback = null;
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="aes-bridge__card" style="height: 100%; position: relative;">
                <div class="aes-bridge__card-header">
                    <h2>Route Map</h2>
                </div>
                <div class="aes-bridge__card-body" style="height: 400px; padding: 0; background-color: #1a1a1a; overflow: hidden; position: relative;">
                    <canvas id="we-map-canvas" width="800" height="400" style="width: 100%; height: 100%; display: block;"></canvas>
                </div>
            </div>
        `;

        this.canvas = document.getElementById("we-map-canvas");
        this.ctx = this.canvas.getContext("2d");

        this.resize();
        window.addEventListener("resize", () => this.resize());

        this.canvas.addEventListener("mousemove", (e) => this.handleMouseMove(e));
        this.canvas.addEventListener("click", (e) => this.handleClick(e));
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.draw();
    }

    setRoutes(routes) {
        // Expected route format: { id, hubLat, hubLon, destLat, destLon, airline, isOurs, flights }
        this.routes = routes;
        this.draw();
    }

    onSelect(callback) {
        this.onSelectCallback = callback;
    }

    selectRoute(routeId) {
        this.selectedRoute = routeId;
        this.draw();
    }

    // Very basic lat/lon to X/Y projection (Equirectangular)
    project(lat, lon) {
        const x = (lon + 180) * (this.width / 360);
        const y = (this.height / 2) - (lat * (this.height / 180));
        return { x, y };
    }

    draw() {
        if (!this.ctx) return;

        // Clear background
        this.ctx.fillStyle = "#1a1a1a";
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw basic equator/meridian for reference
        this.ctx.strokeStyle = "#333";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, this.height / 2);
        this.ctx.lineTo(this.width, this.height / 2);
        this.ctx.moveTo(this.width / 2, 0);
        this.ctx.lineTo(this.width / 2, this.height);
        this.ctx.stroke();

        // Draw routes
        for (const route of this.routes) {
            this.drawRoute(route);
        }
    }

    drawRoute(route) {
        const p1 = this.project(route.hubLat, route.hubLon);
        const p2 = this.project(route.destLat, route.destLon);

        let color = route.isOurs ? "#f59e0b" : "#4b5563"; // Amber for ours, gray for competitors
        let lineWidth = route.isOurs ? 2 : 1;
        let alpha = route.isOurs ? 0.8 : 0.4;

        if (this.selectedRoute === route.id) {
            color = "#ef4444"; // Highlight selected in red
            lineWidth = 3;
            alpha = 1.0;
        } else if (this.hoveredRoute === route.id) {
            color = "#fcd34d"; // Highlight hovered
            lineWidth = 3;
            alpha = 0.9;
        }

        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = lineWidth;
        this.ctx.beginPath();
        this.ctx.moveTo(p1.x, p1.y);

        // Draw a slight arc for aesthetic
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2 - 30; // Control point offset
        this.ctx.quadraticCurveTo(midX, midY, p2.x, p2.y);
        this.ctx.stroke();

        // Draw endpoints
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(p1.x, p1.y, 3, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.beginPath();
        this.ctx.arc(p2.x, p2.y, 3, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    // Basic hit detection for the bezier curves
    getHitRoute(x, y) {
        for (const route of this.routes) {
            const p1 = this.project(route.hubLat, route.hubLon);
            const p2 = this.project(route.destLat, route.destLon);

            // Fast bounding box check first
            const minX = Math.min(p1.x, p2.x) - 10;
            const maxX = Math.max(p1.x, p2.x) + 10;
            const minY = Math.min(p1.y, p2.y) - 40; // Account for curve
            const maxY = Math.max(p1.y, p2.y) + 10;

            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                // Good enough for now, real implementation would sample the curve
                return route;
            }
        }
        return null;
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hit = this.getHitRoute(x, y);
        const hitId = hit ? hit.id : null;

        if (this.hoveredRoute !== hitId) {
            this.hoveredRoute = hitId;
            this.canvas.style.cursor = hit ? "pointer" : "default";
            this.draw();
        }
    }

    handleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hit = this.getHitRoute(x, y);
        if (hit) {
            this.selectRoute(hit.id);
            if (this.onSelectCallback) {
                this.onSelectCallback(hit.id);
            }
        } else {
            this.selectRoute(null);
            if (this.onSelectCallback) {
                this.onSelectCallback(null);
            }
        }
    }
}

if (typeof window !== "undefined") {
    window.WorldExplorerMap = WorldExplorerMap;
}
