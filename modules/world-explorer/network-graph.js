"use strict"

class WorldExplorerNetworkGraph {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = null;
        this.canvas = null;
        this.ctx = null;
        this.width = 800;
        this.height = 600;

        this.nodes = [];
        this.edges = [];

        this.transform = { k: 1, x: 0, y: 0 };
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
        this.draggedNode = null;
    }

    init() {
        this.container = document.getElementById(this.containerId);
        if (!this.container) return;

        this.container.innerHTML = `
            <div class="aes-bridge__card" style="height: 100%; position: relative;">
                <div class="aes-bridge__card-header">
                    <h2>Network & Alliances</h2>
                </div>
                <div class="aes-bridge__card-body" style="height: 600px; padding: 0; background-color: #f8fafc; overflow: hidden; position: relative;">
                    <canvas id="we-network-canvas" width="800" height="600" style="width: 100%; height: 100%; display: block;"></canvas>
                </div>
            </div>
        `;

        this.canvas = document.getElementById("we-network-canvas");
        this.ctx = this.canvas.getContext("2d");

        this.resize();
        window.addEventListener("resize", () => this.resize());

        this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));
        this.canvas.addEventListener("mousemove", (e) => this.handleMouseMove(e));
        this.canvas.addEventListener("mouseup", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("mouseleave", (e) => this.handleMouseUp(e));
        this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });

        this.loadData();
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

    async loadData() {
        // Build a mock/heuristic graph based on Affiliations Store if available,
        // otherwise default to a demonstration mock.

        const cx = (this.width || 800) / 2;
        const cy = (this.height || 600) / 2;

        this.nodes = [
            { id: "self_1", label: "Our Airline", kind: "self", x: cx, y: cy, radius: 40 },
            { id: "ally_1", label: "SkyConnect", kind: "allied", x: cx - 150, y: cy - 100, radius: 30 },
            { id: "ally_2", label: "GlobalWings", kind: "allied", x: cx + 150, y: cy - 100, radius: 30 },
            { id: "interline_1", label: "Regional Air", kind: "interline", x: cx - 200, y: cy + 100, radius: 25 },
            { id: "codeshare_1", label: "EuroJet", kind: "codeshare", x: cx + 200, y: cy + 100, radius: 25 },
            { id: "adv_1", label: "Rival Air", kind: "adversary", x: cx, y: cy + 200, radius: 35 }
        ];

        this.edges = [
            { source: "self_1", target: "ally_1", kind: "allied" },
            { source: "self_1", target: "ally_2", kind: "allied" },
            { source: "ally_1", target: "ally_2", kind: "allied" }, // Alliance triangle
            { source: "self_1", target: "interline_1", kind: "interline" },
            { source: "self_1", target: "codeshare_1", kind: "codeshare" },
            { source: "ally_2", target: "codeshare_1", kind: "interline" },
            { source: "self_1", target: "adv_1", kind: "adversary" }
        ];

        if (window.AesCanopyAffiliations) {
            try {
                const affils = await window.AesCanopyAffiliations.getAll();
                const keys = Object.keys(affils);
                if (keys.length > 0) {
                    this.nodes = [];
                    this.edges = [];

                    // Simple radial layout
                    let radius = 150;
                    let angleStep = (Math.PI * 2) / keys.length;

                    // Group by kind to try and create clusters
                    const grouped = {};
                    keys.forEach(k => {
                        const a = affils[k];
                        if (!grouped[a.kind]) grouped[a.kind] = [];
                        grouped[a.kind].push(a);
                    });

                    let selfNodeId = null;

                    let index = 0;
                    for (const kind in grouped) {
                        for (const a of grouped[kind]) {
                            const isSelf = a.kind === "self";
                            const x = isSelf ? cx : cx + Math.cos(index * angleStep) * radius;
                            const y = isSelf ? cy : cy + Math.sin(index * angleStep) * radius;

                            if (isSelf) selfNodeId = a.enterpriseId;

                            this.nodes.push({
                                id: a.enterpriseId,
                                label: a.enterpriseId, // We'd ideally map to Org Store name here
                                kind: a.kind,
                                x: x,
                                y: y,
                                radius: isSelf ? 40 : 25
                            });

                            // Connect everything back to self for demonstration
                            if (!isSelf && selfNodeId) {
                                this.edges.push({
                                    source: selfNodeId,
                                    target: a.enterpriseId,
                                    kind: a.kind
                                });
                            }

                            if (!isSelf) index++;
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to load real graph data", e);
            }
        }

        // Run a simple force-directed layout simulation for a few iterations
        this.runForceSimulation();
        this.draw();
    }

    runForceSimulation() {
        const iterations = 100;
        // Check for 0/0 edge cases and layout basics correctly
        const centerX = (this.width || 800) / 2;
        const centerY = (this.height || 600) / 2;
        const center = { x: centerX, y: centerY };

        // Ensure nodes have a baseline position
        this.nodes.forEach((n, i) => {
            if (n.x === undefined || n.y === undefined || isNaN(n.x) || isNaN(n.y)) {
                n.x = centerX + Math.cos(i) * 50;
                n.y = centerY + Math.sin(i) * 50;
            }
        });

        // Ensure nodes array is valid to prevent NaN explosion
        if (this.nodes.length === 0) return;

        const k = Math.sqrt(((this.width || 800) * (this.height || 600)) / this.nodes.length) * 0.5;

        for (let i = 0; i < iterations; i++) {
            // Repulsion
            for (let j = 0; j < this.nodes.length; j++) {
                for (let l = j + 1; l < this.nodes.length; l++) {
                    const n1 = this.nodes[j];
                    const n2 = this.nodes[l];
                    const dx = n1.x - n2.x;
                    const dy = n1.y - n2.y;
                    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
                    const force = (k * k) / dist;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;

                    if (n1.kind !== 'self') { n1.x += fx * 0.1; n1.y += fy * 0.1; }
                    if (n2.kind !== 'self') { n2.x -= fx * 0.1; n2.y -= fy * 0.1; }
                }
            }

            // Attraction (Edges)
            for (const edge of this.edges) {
                const n1 = this.nodes.find(n => n.id === edge.source);
                const n2 = this.nodes.find(n => n.id === edge.target);
                if (!n1 || !n2) continue;

                const dx = n2.x - n1.x;
                const dy = n2.y - n1.y;
                const dist = Math.sqrt(dx*dx + dy*dy) || 1;
                const force = (dist * dist) / k;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;

                // Attract more strongly to 'self' to pull into orbit
                if (n1.kind !== 'self') { n1.x += fx * 0.2; n1.y += fy * 0.2; }
                if (n2.kind !== 'self') { n2.x -= fx * 0.2; n2.y -= fy * 0.2; }
            }

            // Gravity to center
            for (const n of this.nodes) {
                if (n.kind !== 'self') {
                    const dx = center.x - n.x;
                    const dy = center.y - n.y;
                    n.x += dx * 0.05;
                    n.y += dy * 0.05;
                }
            }
        }
    }

    draw() {
        if (!this.ctx) return;
        this.ctx.save();
        this.ctx.fillStyle = "#f8fafc";
        this.ctx.fillRect(0, 0, this.width, this.height);

        this.ctx.translate(this.transform.x, this.transform.y);
        this.ctx.scale(this.transform.k, this.transform.k);

        const kindColors = {
            "self":      "#10b981",
            "allied":    "#a855f7",
            "interline": "#3b82f6",
            "codeshare": "#06b6d4",
            "neutral":   "#9ca3af",
            "adversary": "#ef4444"
        };

        // Draw Edges
        for (const edge of this.edges) {
            const n1 = this.nodes.find(n => n.id === edge.source);
            const n2 = this.nodes.find(n => n.id === edge.target);
            if (!n1 || !n2) continue;

            this.ctx.beginPath();
            this.ctx.moveTo(n1.x, n1.y);
            this.ctx.lineTo(n2.x, n2.y);
            this.ctx.strokeStyle = kindColors[edge.kind] || "#cbd5e1";
            this.ctx.globalAlpha = 0.6;
            this.ctx.lineWidth = 2;

            if (edge.kind === "interline") this.ctx.setLineDash([5, 5]);
            else this.ctx.setLineDash([]);

            this.ctx.stroke();
        }
        this.ctx.setLineDash([]);
        this.ctx.globalAlpha = 1.0;

        // Draw Nodes
        for (const node of this.nodes) {
            this.ctx.beginPath();
            this.ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = kindColors[node.kind] || kindColors.neutral;
            this.ctx.fill();
            this.ctx.strokeStyle = "#ffffff";
            this.ctx.lineWidth = 2;
            this.ctx.stroke();

            // Label
            this.ctx.fillStyle = "#1e293b";
            this.ctx.font = "bold 12px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText(node.label, node.x, node.y + node.radius + 15);
        }

        this.ctx.restore();
    }

    getHitNode(x, y) {
        // Map screen to canvas space
        const mappedX = (x - this.transform.x) / this.transform.k;
        const mappedY = (y - this.transform.y) / this.transform.k;

        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            const dx = mappedX - node.x;
            const dy = mappedY - node.y;
            if (Math.sqrt(dx*dx + dy*dy) <= node.radius) {
                return node;
            }
        }
        return null;
    }

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const hit = this.getHitNode(x, y);
        if (hit) {
            this.draggedNode = hit;
            this.canvas.style.cursor = "grabbing";
        } else {
            this.isDragging = true;
            this.dragStart = { x: e.clientX, y: e.clientY };
            this.canvas.style.cursor = "grabbing";
        }
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.draggedNode) {
            this.draggedNode.x = (x - this.transform.x) / this.transform.k;
            this.draggedNode.y = (y - this.transform.y) / this.transform.k;
            this.draw();
            return;
        }

        if (this.isDragging) {
            const dx = e.clientX - this.dragStart.x;
            const dy = e.clientY - this.dragStart.y;
            this.transform.x += dx;
            this.transform.y += dy;
            this.dragStart = { x: e.clientX, y: e.clientY };
            this.draw();
            return;
        }

        const hit = this.getHitNode(x, y);
        this.canvas.style.cursor = hit ? "pointer" : "grab";
    }

    handleMouseUp(e) {
        this.isDragging = false;
        this.draggedNode = null;
        this.canvas.style.cursor = "grab";
    }

    handleWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        const newK = Math.max(0.5, Math.min(5, this.transform.k * zoomDelta));

        this.transform.x = mouseX - (mouseX - this.transform.x) * (newK / this.transform.k);
        this.transform.y = mouseY - (mouseY - this.transform.y) * (newK / this.transform.k);
        this.transform.k = newK;

        this.draw();
    }
}

if (typeof window !== "undefined") {
    window.WorldExplorerNetworkGraph = WorldExplorerNetworkGraph;
}
