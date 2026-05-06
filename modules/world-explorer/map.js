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

        // Pan and Zoom state
        this.transform = { k: 1, x: 0, y: 0 };
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="aes-bridge__card" style="height: 100%; position: relative;">
                <div class="aes-bridge__card-header">
                    <h2>Route Map</h2>
                </div>
                <div class="aes-bridge__card-body" style="height: 400px; padding: 0; background-color: #f8fafc; overflow: hidden; position: relative;">
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
        this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));
        this.canvas.addEventListener("mouseup", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("mouseleave", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
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

        // Apply transform
        return {
            x: x * this.transform.k + this.transform.x,
            y: y * this.transform.k + this.transform.y
        };
    }

    // Inverse projection for hit detection
    unproject(x, y) {
        const mappedX = (x - this.transform.x) / this.transform.k;
        const mappedY = (y - this.transform.y) / this.transform.k;

        const lon = (mappedX / (this.width / 360)) - 180;
        const lat = ((this.height / 2) - mappedY) / (this.height / 180);
        return { lat, lon };
    }

    draw() {
        if (!this.ctx) return;

        // Clear background
        this.ctx.fillStyle = "#f8fafc"; // Clean white/gray theme
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw world map background if available
        if (typeof window !== "undefined" && window.worldGeoJson && window.worldGeoJson.features) {
            this.ctx.fillStyle = "#e2e8f0"; // Light gray land
            this.ctx.strokeStyle = "#cbd5e1"; // Slightly darker borders
            this.ctx.lineWidth = 1;

            for (const feature of window.worldGeoJson.features) {
                if (feature.geometry.type === "Polygon") {
                    this.drawPolygon(feature.geometry.coordinates[0]);
                } else if (feature.geometry.type === "MultiPolygon") {
                    for (const polygon of feature.geometry.coordinates) {
                        this.drawPolygon(polygon[0]);
                    }
                }
            }
        } else {
            // Fallback grid if no world map
            this.ctx.strokeStyle = "#e2e8f0";
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            this.ctx.moveTo(0, this.height / 2);
            this.ctx.lineTo(this.width, this.height / 2);
            this.ctx.moveTo(this.width / 2, 0);
            this.ctx.lineTo(this.width / 2, this.height);
            this.ctx.stroke();
        }

        // Draw routes
        for (const route of this.routes) {
            if (this.shouldShowRoute(route)) {
                this.drawRoute(route);
            }
        }
    }

    shouldShowRoute(route) {
        if (!this.filters) return true;
        if (route.isOurs && !this.filters.showOurFlights) return false;
        if (!route.isOurs && !this.filters.showCompetitors) return false;
        return true;
    }

    setFilters(filters) {
        this.filters = filters;
        this.draw();
    }

    drawPolygon(coordinates) {
        if (!coordinates || coordinates.length === 0) return;

        this.ctx.beginPath();
        const start = this.project(coordinates[0][1], coordinates[0][0]);
        this.ctx.moveTo(start.x, start.y);

        for (let i = 1; i < coordinates.length; i++) {
            const pt = this.project(coordinates[i][1], coordinates[i][0]);
            this.ctx.lineTo(pt.x, pt.y);
        }

        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();
    }

    drawRoute(route) {
        const p1 = this.project(route.hubLat, route.hubLon);
        const p2 = this.project(route.destLat, route.destLon);

        // Map affiliation kinds to colors
        const kindColors = {
            "self":      "#10b981", // Kin (green)
            "allied":    "#a855f7", // Allied (purple)
            "interline": "#3b82f6", // Interline (blue)
            "codeshare": "#06b6d4", // Codeshare (cyan)
            "neutral":   "#94a3b8", // Neutral (gray)
            "adversary": "#ef4444"  // Adversary (red)
        };

        const baseColor = kindColors[route.kind] || (route.isOurs ? kindColors.self : kindColors.neutral);

        let color = baseColor;
        let lineWidth = route.isOurs ? 2 : 1;
        let alpha = route.isOurs ? 0.8 : 0.4;

        if (this.selectedRoute === route.id) {
            color = "#f59e0b"; // Highlight selected in amber
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
        const midY = (p1.y + p2.y) / 2 - 30 * this.transform.k; // Control point offset scaled by zoom
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
            const minY = Math.min(p1.y, p2.y) - 40 * this.transform.k; // Account for curve and zoom
            const maxY = Math.max(p1.y, p2.y) + 10;

            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                // Good enough for now, real implementation would sample the curve
                return route;
            }
        }
        return null;
    }

    handleMouseDown(e) {
        this.isDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
    }

    handleMouseUp(e) {
        if (!this.isDragging) return;
        this.isDragging = false;
        // Optional: you can detect if it was just a click vs a drag here
    }

    handleWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Determine zoom factor
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;

        // Calculate new scale, clamped to reasonable bounds
        const newK = Math.max(0.5, Math.min(10, this.transform.k * zoomDelta));

        // Adjust translation so we zoom in/out at the mouse cursor
        this.transform.x = mouseX - (mouseX - this.transform.x) * (newK / this.transform.k);
        this.transform.y = mouseY - (mouseY - this.transform.y) * (newK / this.transform.k);
        this.transform.k = newK;

        this.draw();
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.isDragging) {
            const dx = e.clientX - this.dragStart.x;
            const dy = e.clientY - this.dragStart.y;
            this.transform.x += dx;
            this.transform.y += dy;
            this.dragStart = { x: e.clientX, y: e.clientY };
            this.draw();
            this.canvas.style.cursor = "grabbing";
            return;
        }

        const hit = this.getHitRoute(x, y);
        const hitId = hit ? hit.id : null;

        if (this.hoveredRoute !== hitId) {
            this.hoveredRoute = hitId;
            this.canvas.style.cursor = hit ? "pointer" : "grab";
            this.draw();
        } else {
            this.canvas.style.cursor = hit ? "pointer" : "grab";
        }
    }

    handleClick(e) {
        // Simple heuristic: if we were dragging, it's not a click.
        // For a better implementation, measure distance dragged.

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
