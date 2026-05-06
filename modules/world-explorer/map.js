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
        };
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
                <div class="aes-bridge__card-body" style="flex: 1; min-height: 400px; padding: 0; background-color: #1a1a1a; overflow: hidden; position: relative;">
                    <canvas id="we-map-canvas" width="800" height="400" style="width: 100%; height: 100%; display: block; cursor: grab;"></canvas>
                    <div style="position: absolute; bottom: 10px; right: 10px; display: flex; flex-direction: column; gap: 5px;">
                        <button id="we-btn-zoomin" style="width: 30px; height: 30px; font-weight: bold;">+</button>
                        <button id="we-btn-zoomout" style="width: 30px; height: 30px; font-weight: bold;">-</button>
                    </div>
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
            if (this.shouldDrawRoute(route)) {
                this.drawRoute(route);
            }
        }
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

        let color = "#4b5563"; // Default competitor (Gray)
        if (route.isOurs) color = "#f59e0b"; // Amber for ours
        else if (route.isAlliance) color = "#3b82f6"; // Blue for alliance

        let lineWidth = route.isOurs ? 2 * this.scale : 1 * this.scale;
        lineWidth = Math.max(1, Math.min(lineWidth, 5)); // Cap line width

        let alpha = route.isOurs || route.isAlliance ? 0.8 : 0.4;

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
            const padding = 10 * this.scale;
            const curveOffset = 40 * this.scale;

            const minX = Math.min(p1.x, p2.x) - padding;
            const maxX = Math.max(p1.x, p2.x) + padding;
            const minY = Math.min(p1.y, p2.y) - curveOffset; // Account for curve
            const maxY = Math.max(p1.y, p2.y) + padding;

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

        if (this.isDragging) {
            const dx = x - this.lastDragX;
            const dy = y - this.lastDragY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastDragX = x;
            this.lastDragY = y;
            this.dragMoved = true;
            this.draw();
            return;
        }

        const hit = this.getHitRoute(x, y);
        const hitId = hit ? hit.id : null;

        if (this.hoveredRoute !== hitId) {
            this.hoveredRoute = hitId;
            this.canvas.style.cursor = hit ? "pointer" : "grab";
            this.draw();
        }
    }

    handleClick(e) {
        if (this.dragMoved) return; // Ignore click if we were dragging

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
