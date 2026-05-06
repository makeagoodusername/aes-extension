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

        // Pan & Zoom state
        this.transform = { x: 0, y: 0, k: 1 };
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };

        // Controls state
        this.filterOwnership = "all";
        this.filterAirline = "all";
        this.colorScheme = "ownership";
        this.airlineColors = new Map();
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="aes-bridge__card" style="height: 100%; position: relative; display: flex; flex-direction: column;">
                <div class="aes-bridge__card-header" style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px;">
                    <h2>Route Map</h2>
                    <div class="aes-we-map-controls" style="display: flex; gap: 8px;">
                        <select id="we-filter-ownership" class="aes-bridge__input" style="padding: 4px; font-size: 12px; border-radius: 4px; background: #222; color: #fff; border: 1px solid #444;">
                            <option value="all">Show All</option>
                            <option value="ours">Our Airline</option>
                            <option value="competitors">Competitors</option>
                        </select>
                        <select id="we-filter-airline" class="aes-bridge__input" style="padding: 4px; font-size: 12px; border-radius: 4px; background: #222; color: #fff; border: 1px solid #444;">
                            <option value="all">All Airlines</option>
                        </select>
                        <select id="we-color-scheme" class="aes-bridge__input" style="padding: 4px; font-size: 12px; border-radius: 4px; background: #222; color: #fff; border: 1px solid #444;">
                            <option value="ownership">Color by Ownership</option>
                            <option value="airline">Color by Airline</option>
                        </select>
                        <button id="we-reset-view" class="aes-bridge__btn" style="padding: 4px 8px; font-size: 12px; border-radius: 4px; background: #333; color: #fff; border: 1px solid #555; cursor: pointer;">Reset View</button>
                    </div>
                </div>
                <div class="aes-bridge__card-body" style="flex: 1; min-height: 400px; padding: 0; background-color: #1a1a1a; overflow: hidden; position: relative;">
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
        this.canvas.addEventListener("mouseleave", (e) => this.handleMouseLeave(e));
        this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });

        this.setupControls();
    }

    setupControls() {
        const filterOwnership = document.getElementById("we-filter-ownership");
        const filterAirline = document.getElementById("we-filter-airline");
        const colorScheme = document.getElementById("we-color-scheme");
        const resetViewBtn = document.getElementById("we-reset-view");

        if (filterOwnership) {
            filterOwnership.addEventListener("change", (e) => {
                this.filterOwnership = e.target.value;
                this.draw();
            });
        }

        if (filterAirline) {
            filterAirline.addEventListener("change", (e) => {
                this.filterAirline = e.target.value;
                this.draw();
            });
        }

        if (colorScheme) {
            colorScheme.addEventListener("change", (e) => {
                this.colorScheme = e.target.value;
                this.draw();
            });
        }

        if (resetViewBtn) {
            resetViewBtn.addEventListener("click", () => {
                this.transform = { x: 0, y: 0, k: 1 };
                this.draw();
            });
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

    updateAirlineFilterOptions() {
        const select = document.getElementById("we-filter-airline");
        if (!select) return;

        const currentVal = select.value;
        select.innerHTML = '<option value="all">All Airlines</option>';

        const airlines = new Set();
        this.routes.forEach(r => {
            if (r.airline) airlines.add(r.airline);
        });

        Array.from(airlines).sort().forEach(airline => {
            const option = document.createElement("option");
            option.value = airline;
            option.textContent = airline;
            select.appendChild(option);
        });

        if (airlines.has(currentVal)) {
            select.value = currentVal;
        }
    }

    generateAirlineColors() {
        const airlines = new Set();
        this.routes.forEach(r => {
            if (r.airline) airlines.add(r.airline);
        });

        // A nice set of categorical colors for map lines
        const colors = [
            "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
            "#ec4899", "#06b6d4", "#f97316", "#84cc16", "#6366f1"
        ];

        let colorIdx = 0;
        Array.from(airlines).sort().forEach(airline => {
            if (!this.airlineColors.has(airline)) {
                this.airlineColors.set(airline, colors[colorIdx % colors.length]);
                colorIdx++;
            }
        });
    }

    setRoutes(routes) {
        // Expected route format: { id, hubLat, hubLon, destLat, destLon, airline, isOurs, flights }
        this.routes = routes;
        this.updateAirlineFilterOptions();
        this.generateAirlineColors();
        this.draw();
    }

    onSelect(callback) {
        this.onSelectCallback = callback;
    }

    selectRoute(routeId) {
        this.selectedRoute = routeId;
        this.draw();
    }

    // Very basic lat/lon to X/Y projection (Equirectangular) with pan/zoom applied
    project(lat, lon) {
        const x = (lon + 180) * (this.width / 360);
        const y = (this.height / 2) - (lat * (this.height / 180));

        // Apply transform
        return {
            x: x * this.transform.k + this.transform.x,
            y: y * this.transform.k + this.transform.y
        };
    }

    // Inverse project from screen coordinates to base canvas coordinates
    inverseTransform(x, y) {
        return {
            x: (x - this.transform.x) / this.transform.k,
            y: (y - this.transform.y) / this.transform.k
        };
    }

    draw() {
        if (!this.ctx) return;

        // Clear background
        this.ctx.fillStyle = "#1a1a1a";
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw basic equator/meridian for reference (transformed)
        this.ctx.strokeStyle = "#333";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        const eqLeft = this.project(0, -180);
        const eqRight = this.project(0, 180);
        this.ctx.moveTo(eqLeft.x, eqLeft.y);
        this.ctx.lineTo(eqRight.x, eqRight.y);

        const merTop = this.project(90, 0);
        const merBot = this.project(-90, 0);
        this.ctx.moveTo(merTop.x, merTop.y);
        this.ctx.lineTo(merBot.x, merBot.y);
        this.ctx.stroke();

        // Draw routes
        for (const route of this.routes) {
            if (this.shouldDrawRoute(route)) {
                this.drawRoute(route);
            }
        }
    }

    shouldDrawRoute(route) {
        if (this.filterOwnership === "ours" && !route.isOurs) return false;
        if (this.filterOwnership === "competitors" && route.isOurs) return false;

        if (this.filterAirline !== "all" && route.airline !== this.filterAirline) return false;

        return true;
    }

    drawRoute(route) {
        const p1 = this.project(route.hubLat, route.hubLon);
        const p2 = this.project(route.destLat, route.destLon);

        let color;
        let lineWidth = route.isOurs ? 2 : 1;
        let alpha = route.isOurs ? 0.8 : 0.4;

        if (this.colorScheme === "airline" && route.airline) {
            color = this.airlineColors.get(route.airline) || "#ffffff";
            alpha = 0.8; // Boost alpha if coloring by airline to make it visible
        } else {
            color = route.isOurs ? "#f59e0b" : "#4b5563"; // Amber for ours, gray for competitors
        }

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
        // Scale line width so it doesn't get too thick when zoomed in
        this.ctx.lineWidth = lineWidth * Math.max(0.5, this.transform.k * 0.7);
        this.ctx.beginPath();
        this.ctx.moveTo(p1.x, p1.y);

        // Draw a slight arc for aesthetic
        const midX = (p1.x + p2.x) / 2;
        // Scale the arc height based on zoom
        const arcHeight = 30 * this.transform.k;
        const midY = (p1.y + p2.y) / 2 - arcHeight; // Control point offset
        this.ctx.quadraticCurveTo(midX, midY, p2.x, p2.y);
        this.ctx.stroke();

        // Draw endpoints
        const radius = 3 * Math.max(0.5, this.transform.k * 0.7);
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

            // Scale the arc height based on zoom (same as in drawRoute)
            const arcHeight = 30 * this.transform.k;

            // Fast bounding box check first
            const minX = Math.min(p1.x, p2.x) - 10;
            const maxX = Math.max(p1.x, p2.x) + 10;
            const minY = Math.min(p1.y, p2.y) - arcHeight - 10; // Account for curve
            const maxY = Math.max(p1.y, p2.y) + 10;

            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                // Good enough for now, real implementation would sample the curve
                return route;
            }
        }
        return null;
    }

    handleMouseDown(e) {
        if (e.button !== 0) return; // Only left click for pan
        this.isDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.dragAmount = 0; // Track amount dragged to differentiate click from pan
        this.canvas.style.cursor = "grabbing";
    }

    handleMouseUp(e) {
        this.isDragging = false;
        this.canvas.style.cursor = this.hoveredRoute ? "pointer" : "default";
    }

    handleMouseLeave(e) {
        this.isDragging = false;
        this.canvas.style.cursor = "default";
        if (this.hoveredRoute !== null) {
            this.hoveredRoute = null;
            this.draw();
        }
    }

    handleWheel(e) {
        e.preventDefault(); // Prevent page scroll

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Zoom delta
        const zoomIntensity = 0.1;
        const delta = e.deltaY < 0 ? 1 + zoomIntensity : 1 - zoomIntensity;

        // Calculate new scale, clamped
        let newK = this.transform.k * delta;
        newK = Math.max(0.5, Math.min(newK, 10)); // Min zoom 0.5x, max zoom 10x

        // Adjust translation to zoom towards the mouse cursor
        // X_screen = X_base * k + X_trans
        // We want X_screen to stay the same before and after zoom
        const kRatio = newK / this.transform.k;
        this.transform.x = x - (x - this.transform.x) * kRatio;
        this.transform.y = y - (y - this.transform.y) * kRatio;
        this.transform.k = newK;

        this.draw();
    }

    handleMouseMove(e) {
        if (this.isDragging) {
            const dx = e.clientX - this.dragStart.x;
            const dy = e.clientY - this.dragStart.y;
            this.dragAmount += Math.abs(dx) + Math.abs(dy); // Accumulate drag distance
            this.transform.x += dx;
            this.transform.y += dy;
            this.dragStart = { x: e.clientX, y: e.clientY };
            this.draw();
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hit = this.getHitRoute(x, y);
        const hitId = hit ? hit.id : null;

        if (this.hoveredRoute !== hitId) {
            this.hoveredRoute = hitId;
            if (!this.isDragging) {
                this.canvas.style.cursor = hit ? "pointer" : "default";
            }
            this.draw();
        }
    }

    handleClick(e) {
        // Prevent click if we were dragging (threshold of 5 pixels)
        if (this.dragAmount > 5) {
            this.dragAmount = 0;
            return;
        }

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
