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

        // Viewport transform
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        // Interaction state
        this.isDragging = false;
        this.lastDragX = 0;
        this.lastDragY = 0;

        // Mode flags
        this.performanceMode = false;
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

        // Mouse interaction for pan/zoom and picking
        this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));
        window.addEventListener("mousemove", (e) => this.handleMouseMove(e));
        window.addEventListener("mouseup", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), {passive: false});
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
        // Expected route format: { id, hubLat, hubLon, destLat, destLon, airline, isOurs, flights, ... }
        this.routes = routes;
        this.draw();
    }

    setPerformanceMode(isPerformance) {
        this.performanceMode = isPerformance;
        this.draw();
    }

    onSelect(callback) {
        this.onSelectCallback = callback;
    }

    selectRoute(routeId) {
        this.selectedRoute = routeId;
        this.draw();
    }

    // Very basic lat/lon to X/Y projection (Equirectangular) -> returns world coordinates
    project(lat, lon) {
        const x = (lon + 180) * (this.width / 360);
        const y = (this.height / 2) - (lat * (this.height / 180));
        return { x, y };
    }

    // Transform screen coordinates to world coordinates
    screenToWorld(x, y) {
        return {
            x: (x - this.offsetX) / this.scale,
            y: (y - this.offsetY) / this.scale
        };
    }

    draw() {
        if (!this.ctx) return;

        // Clear background
        this.ctx.fillStyle = "#1a1a1a";
        this.ctx.fillRect(0, 0, this.width, this.height);

        this.ctx.save();

        // Apply view transform
        this.ctx.translate(this.offsetX, this.offsetY);
        this.ctx.scale(this.scale, this.scale);

        // Draw basic equator/meridian for reference
        this.ctx.strokeStyle = "#333";
        this.ctx.lineWidth = 1 / this.scale;
        this.ctx.beginPath();
        this.ctx.moveTo(0, this.height / 2);
        this.ctx.lineTo(this.width, this.height / 2);
        this.ctx.moveTo(this.width / 2, 0);
        this.ctx.lineTo(this.width / 2, this.height);
        this.ctx.stroke();

        // Draw routes
        for (const route of this.routes) {
            // Very simple culling for extreme zoom could go here
            this.drawRoute(route);
        }

        this.ctx.restore();
    }

    drawRoute(route) {
        const p1 = this.project(route.hubLat, route.hubLon);
        const p2 = this.project(route.destLat, route.destLon);

        let color = "#4b5563"; // default gray
        let isDashed = false;

        if (route.isOurs) color = "#f59e0b"; // Amber
        else if (route.isAlliance) color = "#3b82f6"; // Blue
        else if (route.isSubsidiary) color = "#93c5fd"; // Lighter blue
        else if (route.isCompetitor) color = "#ef4444"; // Red
        else if (route.isRealWorld) {
            color = "#10b981"; // Green
            isDashed = true;
        } else if (route.isPotential) {
            color = "#a855f7"; // Purple
            isDashed = true;
        } else if (route.isInterlining) {
            color = "#f472b6"; // Pink
            isDashed = true;
        }

        let lineWidth = route.isOurs ? 2 : 1;
        let alpha = route.isOurs ? 0.8 : 0.4;

        // Scale line width so it doesn't get huge when zoomed in
        lineWidth = lineWidth / Math.max(1, this.scale * 0.5);

        if (this.selectedRoute === route.id) {
            color = "#ffffff"; // Highlight selected in white
            lineWidth = 3 / Math.max(1, this.scale * 0.5);
            alpha = 1.0;
        } else if (this.hoveredRoute === route.id) {
            color = "#fcd34d"; // Highlight hovered
            lineWidth = 3 / Math.max(1, this.scale * 0.5);
            alpha = 0.9;
        }

        this.ctx.save();
        this.ctx.globalAlpha = alpha;
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = lineWidth;

        if (isDashed && !this.performanceMode) {
            this.ctx.setLineDash([5 / this.scale, 5 / this.scale]); // 'em dash recurring' equivalent
        }

        this.ctx.beginPath();
        this.ctx.moveTo(p1.x, p1.y);

        if (this.performanceMode) {
            // Draw straight lines in performance mode
            this.ctx.lineTo(p2.x, p2.y);
        } else {
            // Draw a slight arc for aesthetic
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            // Adjust curve based on distance
            const midX = (p1.x + p2.x) / 2;
            const midY = (p1.y + p2.y) / 2 - (dist * 0.2); // Control point offset relative to distance

            this.ctx.quadraticCurveTo(midX, midY, p2.x, p2.y);
        }

        this.ctx.stroke();

        // Draw endpoints
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        const nodeRadius = 3 / Math.max(1, this.scale * 0.5);
        this.ctx.arc(p1.x, p1.y, nodeRadius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.beginPath();
        this.ctx.arc(p2.x, p2.y, nodeRadius, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    // Hit detection now works in world coordinates
    getHitRoute(worldX, worldY) {
        // Adjust threshold based on zoom
        const threshold = 10 / this.scale;

        for (const route of this.routes) {
            const p1 = this.project(route.hubLat, route.hubLon);
            const p2 = this.project(route.destLat, route.destLon);

            // Fast bounding box check first
            const minX = Math.min(p1.x, p2.x) - threshold;
            const maxX = Math.max(p1.x, p2.x) + threshold;
            // Arc goes "up" (lower Y) so account for it
            const minY = Math.min(p1.y, p2.y) - (this.performanceMode ? threshold : Math.sqrt(Math.pow(p2.x-p1.x,2)+Math.pow(p2.y-p1.y,2))*0.2 + threshold);
            const maxY = Math.max(p1.y, p2.y) + threshold;

            if (worldX >= minX && worldX <= maxX && worldY >= minY && worldY <= maxY) {
                // If performance mode or straight line, use point-to-line distance
                if (this.performanceMode) {
                    const l2 = Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);
                    if (l2 === 0) continue; // Same point
                    let t = ((worldX - p1.x) * (p2.x - p1.x) + (worldY - p1.y) * (p2.y - p1.y)) / l2;
                    t = Math.max(0, Math.min(1, t));
                    const projX = p1.x + t * (p2.x - p1.x);
                    const projY = p1.y + t * (p2.y - p1.y);
                    const distSq = Math.pow(worldX - projX, 2) + Math.pow(worldY - projY, 2);
                    if (distSq <= threshold * threshold) {
                        return route;
                    }
                } else {
                    // Simple hit box is okay for now, real curve sampling is complex
                    return route;
                }
            }
        }
        return null;
    }

    handleMouseDown(e) {
        this.isDragging = true;
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
    }

    handleMouseMove(e) {
        if (this.isDragging) {
            const dx = e.clientX - this.lastDragX;
            const dy = e.clientY - this.lastDragY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastDragX = e.clientX;
            this.lastDragY = e.clientY;
            this.draw();
            return;
        }

        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        // Ensure we are hovering over the canvas
        if (screenX < 0 || screenX > rect.width || screenY < 0 || screenY > rect.height) return;

        const worldPos = this.screenToWorld(screenX, screenY);
        const hit = this.getHitRoute(worldPos.x, worldPos.y);
        const hitId = hit ? hit.id : null;

        if (this.hoveredRoute !== hitId) {
            this.hoveredRoute = hitId;
            if (!this.isDragging) {
                this.canvas.style.cursor = hit ? "pointer" : "grab";
            }
            this.draw();
        }
    }

    handleMouseUp(e) {
        this.isDragging = false;
        if (this.canvas) {
            this.canvas.style.cursor = this.hoveredRoute ? "pointer" : "grab";
        }
    }

    handleWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Determine zoom direction and factor
        const zoomIntensity = 0.1;
        const wheel = e.deltaY < 0 ? 1 : -1;
        const zoomFactor = Math.exp(wheel * zoomIntensity);

        const newScale = this.scale * zoomFactor;

        // Limit scale to prevent issues
        if (newScale < 0.1 || newScale > 20) return;

        // Zoom relative to mouse position
        this.offsetX = mouseX - (mouseX - this.offsetX) * zoomFactor;
        this.offsetY = mouseY - (mouseY - this.offsetY) * zoomFactor;
        this.scale = newScale;

        this.draw();
    }

    handleClick(e) {
        // Don't register click if we were dragging
        // Simplistic check: could track distance dragged instead

        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        const worldPos = this.screenToWorld(screenX, screenY);
        const hit = this.getHitRoute(worldPos.x, worldPos.y);

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
