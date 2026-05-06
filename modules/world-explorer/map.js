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

 feat/world-explorer-map-interactions-889865835095403658
        // Transform properties
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        // Interaction state
        this.isDragging = false;
        this.lastDragX = 0;
        this.lastDragY = 0;

        // Map backgrounds
        this.bgMode = "dark"; // "dark", "light", "none"
        this.bgImgDark = new Image();
        this.bgImgDark.src = "images/vintage-map-dark.svg";
        this.bgImgDark.onload = () => this.draw();

        this.bgImgLight = new Image();
        this.bgImgLight.src = "images/vintage-map.jpg";
        this.bgImgLight.onload = () => this.draw();

        // Filters
        this.filters = {
            ours: true,
            alliance: true,
            competitors: true
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="aes-bridge__card" style="height: 100%; position: relative; display: flex; flex-direction: column;">
                <div class="aes-bridge__card-header" style="display: flex; justify-content: space-between; align-items: center;">
                    <h2>Route Map</h2>
                    <div class="we-map-controls" style="display: flex; gap: 10px; align-items: center; font-size: 14px;">
                        <label><input type="checkbox" id="we-filter-ours" checked> Our Routes</label>
                        <label><input type="checkbox" id="we-filter-alliance" checked> Alliance</label>
                        <label><input type="checkbox" id="we-filter-comp" checked> Competitors</label>
                        <select id="we-bg-select">
                            <option value="dark">Dark Map</option>
                            <option value="light">Light Map</option>
                            <option value="none">No Background</option>
                        </select>
                    </div>
                </div>
 feat/world-explorer-map-interactions-889865835095403658
                <div class="aes-bridge__card-body" style="flex: 1; min-height: 400px; padding: 0; background-color: #1a1a1a; overflow: hidden; position: relative;">
                    <canvas id="we-map-canvas" width="800" height="400" style="width: 100%; height: 100%; display: block; cursor: grab;"></canvas>
                    <div style="position: absolute; bottom: 10px; right: 10px; display: flex; flex-direction: column; gap: 5px;">
                        <button id="we-btn-zoomin" style="width: 30px; height: 30px; font-weight: bold;">+</button>
                        <button id="we-btn-zoomout" style="width: 30px; height: 30px; font-weight: bold;">-</button>
                    </div>
=======
                <div class="aes-bridge__card-body" style="height: 400px; padding: 0; background-color: #f8fafc; overflow: hidden; position: relative;">
                    <canvas id="we-map-canvas" width="800" height="400" style="width: 100%; height: 100%; display: block;"></canvas>
 main
                </div>
            </div>
        `;

        this.canvas = document.getElementById("we-map-canvas");
        this.ctx = this.canvas.getContext("2d");

        this.resize();
        window.addEventListener("resize", () => this.resize());

        this.setupEventListeners();
    }

    setupEventListeners() {
        this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
        this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));
        this.canvas.addEventListener("mousemove", (e) => this.handleMouseMove(e));
        this.canvas.addEventListener("mouseup", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("mouseleave", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("click", (e) => this.handleClick(e));
 feat/world-explorer-map-interactions-889865835095403658

        document.getElementById("we-btn-zoomin").addEventListener("click", () => this.zoom(1.2, this.width / 2, this.height / 2));
        document.getElementById("we-btn-zoomout").addEventListener("click", () => this.zoom(1 / 1.2, this.width / 2, this.height / 2));

        document.getElementById("we-filter-ours").addEventListener("change", (e) => { this.filters.ours = e.target.checked; this.draw(); });
        document.getElementById("we-filter-alliance").addEventListener("change", (e) => { this.filters.alliance = e.target.checked; this.draw(); });
        document.getElementById("we-filter-comp").addEventListener("change", (e) => { this.filters.competitors = e.target.checked; this.draw(); });

        document.getElementById("we-bg-select").addEventListener("change", (e) => { this.bgMode = e.target.value; this.draw(); });
    }

    zoom(factor, cx, cy) {
        // Compute new scale
        const newScale = Math.max(0.5, Math.min(this.scale * factor, 10)); // Limit scale from 0.5x to 10x
        if (newScale === this.scale) return;

        // Adjust offset to zoom centered on cx, cy
        this.offsetX = cx - (cx - this.offsetX) * (newScale / this.scale);
        this.offsetY = cy - (cy - this.offsetY) * (newScale / this.scale);

        this.scale = newScale;
        this.draw();
    }

    handleWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        const zoomFactor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
        this.zoom(zoomFactor, cx, cy);
    }

    handleMouseDown(e) {
        // Differentiate drag vs click (roughly)
        this.isDragging = true;
        this.dragMoved = false;
        const rect = this.canvas.getBoundingClientRect();
        this.lastDragX = e.clientX - rect.left;
        this.lastDragY = e.clientY - rect.top;
        this.canvas.style.cursor = "grabbing";
    }

    handleMouseUp(e) {
        if (this.isDragging) {
            this.isDragging = false;
            this.canvas.style.cursor = "grab";
        }
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
 feat/world-explorer-map-interactions-889865835095403658
        // Base mapping to the unscaled canvas
        const baseWidth = this.width;
        const baseHeight = this.height; // Using canvas width/height as base map size

        const x = (lon + 180) * (baseWidth / 360);
        const y = (baseHeight / 2) - (lat * (baseHeight / 180));

        // Apply scale and offset
        return {
            x: x * this.scale + this.offsetX,
            y: y * this.scale + this.offsetY
        };

    }

    draw() {
        if (!this.ctx) return;

 feat/world-explorer-map-interactions-889865835095403658
        // Clear canvas
        this.ctx.fillStyle = this.bgMode === "light" ? "#f4ece0" : "#1a1a1a";
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw Background
        const img = this.bgMode === "light" ? this.bgImgLight : (this.bgMode === "dark" ? this.bgImgDark : null);
        if (img && img.complete && img.naturalWidth > 0) {
            // Fill background with image stretched to base map size, then scaled/offset
            const destW = this.width * this.scale;
            const destH = this.height * this.scale;
            this.ctx.drawImage(img, this.offsetX, this.offsetY, destW, destH);
        } else {
            // Fallback grid
            this.ctx.strokeStyle = this.bgMode === "light" ? "#ccc" : "#333";
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();

            const eqY = (this.height / 2) * this.scale + this.offsetY;
            this.ctx.moveTo(0, eqY);
            this.ctx.lineTo(this.width, eqY);

            const merX = (this.width / 2) * this.scale + this.offsetX;
            this.ctx.moveTo(merX, 0);
            this.ctx.lineTo(merX, this.height);

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

    shouldDrawRoute(route) {
        if (route.isOurs && this.filters.ours) return true;
        if (route.isAlliance && this.filters.alliance) return true;
        if (!route.isOurs && !route.isAlliance && this.filters.competitors) return true;
        return false;
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
        const radius = Math.max(2, 3 * this.scale);
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(p1.x, p1.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.beginPath();
        this.ctx.arc(p2.x, p2.y, radius, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    // Basic hit detection for the bezier curves
    getHitRoute(x, y) {
        for (const route of this.routes) {
            if (!this.shouldDrawRoute(route)) continue;

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
