"use strict"

/**
 * AES Strategy — Network graph layout (Slice 25).
 *
 * Pure Velocity-Verlet force-directed layout for the airline network
 * visualization. Builds nodes (airports) + edges (routes) from a
 * snapshot, then runs configurable force iterations to settle them. No
 * DOM, no I/O, no canvas — the tile owns rendering; this module owns
 * geometry.
 *
 * Vanilla physics — Coulomb-style repulsion + Hooke spring + center
 * pull + boundary clamp. No D3, no third-party (§4.11).
 *
 * Public API (window.AesStrategyNetworkGraphView):
 *   .build(snapshot, opts?) → State                      // builds nodes/edges
 *   .step(state, opts?)     → State                      // one tick (pure)
 *   .settle(state, opts?)   → State                      // run N steps
 *
 * State shape:
 *   {
 *     nodes: [{iata, x, y, vx, vy, mass, weight, isOurHub}],
 *     edges: [{from, to, frequency, lf, weight}],
 *     bounds: {w, h},
 *     temperature: number,        // 1.0 → 0 fade
 *     iter: number
 *   }
 *
 * Determinism: builds nodes from a seeded ring layout (no Math.random
 * in build). Step uses no randomness. This matters for the smoke that
 * asserts converged positions.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyNetworkGraphView) return

    const DEFAULT_W = 720
    const DEFAULT_H = 480
    const REPULSION = 1200
    const SPRING_LEN = 80
    const SPRING_K   = 0.04
    const CENTER_K   = 0.005
    const DAMPING    = 0.85
    const STEP_DT    = 1.0
    const MAX_VEL    = 8

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Pure builder: turn a snapshot into a graph state. Every hub becomes
     * a node; every byRoute entry becomes a node + an edge from hub →
     * dest. Mass is proportional to the route's profit/wk so heavy nodes
     * settle near the centre and pull lighter satellites in.
     */
    function build(snapshot, opts) {
        const w = _num(opts && opts.w, DEFAULT_W)
        const h = _num(opts && opts.h, DEFAULT_H)
        const cx = w / 2, cy = h / 2

        const nodeMap = new Map()
        const edges   = []
        const hubs    = (snapshot && Array.isArray(snapshot.hubs)) ? snapshot.hubs : []

        function _ensureNode(iata, isOurHub) {
            const key = String(iata || "").toUpperCase()
            if (!key) return null
            let node = nodeMap.get(key)
            if (!node) {
                node = {iata: key, x: 0, y: 0, vx: 0, vy: 0, mass: 1, weight: 0, isOurHub: false}
                nodeMap.set(key, node)
            }
            if (isOurHub) node.isOurHub = true
            return node
        }

        for (const hub of hubs) {
            const hubNode = _ensureNode(hub && hub.iata, true)
            if (!hubNode) continue
            const byRoute = (hub.byRoute && Array.isArray(hub.byRoute)) ? hub.byRoute : []
            for (const r of byRoute) {
                const destNode = _ensureNode(r && r.dest, false)
                if (!destNode) continue
                const ppw = _num(r.profitPerWeek, 0)
                const freq = _num(r.weeklyFlights, 0)
                const weight = Math.max(0, ppw)
                hubNode.weight  += weight
                destNode.weight += weight
                const lf = _num(r.paxLF, _num(r.loadFactor, 0))
                edges.push({from: hubNode.iata, to: destNode.iata, frequency: freq, lf: lf, weight: weight})
            }
        }

        // Mass proportional to log(1 + weight). Higher mass = harder to push.
        for (const node of nodeMap.values()) {
            node.mass = 1 + Math.log1p(node.weight / 1000)
        }

        // Deterministic seed: place every node on a ring sized to the
        // canvas, ordered by IATA. Seeded vs random keeps the layout
        // reproducible for tests + reduces flicker between mounts.
        const list = Array.from(nodeMap.values()).sort((a, b) => a.iata < b.iata ? -1 : 1)
        const radius = Math.min(w, h) * 0.35
        const n = list.length || 1
        for (let i = 0; i < list.length; i++) {
            const angle = (i / n) * Math.PI * 2
            list[i].x = cx + radius * Math.cos(angle)
            list[i].y = cy + radius * Math.sin(angle)
        }

        return {
            nodes:       list,
            edges:       edges,
            bounds:      {w, h},
            temperature: 1.0,
            iter:        0
        }
    }

    /**
     * Run one Velocity-Verlet tick. Pure: returns the same state object
     * with positions/velocities mutated. The caller drives the loop via
     * requestAnimationFrame and stops once `temperature < 0.05` or `iter
     * > maxIter`.
     */
    function step(state, opts) {
        if (!state || !Array.isArray(state.nodes) || !state.nodes.length) return state
        const dt = _num(opts && opts.dt, STEP_DT)
        const w  = state.bounds.w, h = state.bounds.h
        const cx = w / 2, cy = h / 2

        // 1) Build adjacency for spring forces.
        const byIata = new Map()
        for (const node of state.nodes) byIata.set(node.iata, node)

        // 2) Reset force accumulators.
        for (const node of state.nodes) { node._fx = 0; node._fy = 0 }

        // 3) Repulsion — every pair (O(n²) is fine for n ≤ 200).
        for (let i = 0; i < state.nodes.length; i++) {
            const a = state.nodes[i]
            for (let j = i + 1; j < state.nodes.length; j++) {
                const b = state.nodes[j]
                const dx = a.x - b.x, dy = a.y - b.y
                const d2 = dx * dx + dy * dy + 0.01
                const f = REPULSION / d2
                const d = Math.sqrt(d2)
                const fx = (dx / d) * f, fy = (dy / d) * f
                a._fx += fx; a._fy += fy
                b._fx -= fx; b._fy -= fy
            }
        }

        // 4) Spring forces along edges.
        for (const e of state.edges) {
            const a = byIata.get(e.from), b = byIata.get(e.to)
            if (!a || !b) continue
            const dx = b.x - a.x, dy = b.y - a.y
            const d  = Math.sqrt(dx * dx + dy * dy) || 0.01
            const f  = SPRING_K * (d - SPRING_LEN)
            const fx = (dx / d) * f, fy = (dy / d) * f
            a._fx += fx; a._fy += fy
            b._fx -= fx; b._fy -= fy
        }

        // 5) Center pull (keeps the graph from drifting off-canvas).
        for (const node of state.nodes) {
            node._fx += (cx - node.x) * CENTER_K
            node._fy += (cy - node.y) * CENTER_K
        }

        // 6) Integrate. Damp velocity by temperature so the graph settles.
        const damp = DAMPING * state.temperature
        for (const node of state.nodes) {
            node.vx = (node.vx + (node._fx / node.mass) * dt) * damp
            node.vy = (node.vy + (node._fy / node.mass) * dt) * damp
            // Clamp velocity so a runaway repulsion can't fling a node off.
            if (node.vx > MAX_VEL) node.vx = MAX_VEL; else if (node.vx < -MAX_VEL) node.vx = -MAX_VEL
            if (node.vy > MAX_VEL) node.vy = MAX_VEL; else if (node.vy < -MAX_VEL) node.vy = -MAX_VEL
            node.x += node.vx * dt
            node.y += node.vy * dt
            // Boundary clamp — keep nodes on canvas with a 16-px margin.
            if (node.x < 16)     node.x = 16
            if (node.x > w - 16) node.x = w - 16
            if (node.y < 16)     node.y = 16
            if (node.y > h - 16) node.y = h - 16
        }

        state.temperature *= 0.985
        state.iter += 1
        return state
    }

    function settle(state, opts) {
        const max = _num(opts && opts.maxIter, 240)
        for (let i = 0; i < max && state.temperature > 0.05; i++) step(state, opts)
        return state
    }

    window.AesStrategyNetworkGraphView = {
        build:  build,
        step:   step,
        settle: settle,
        // Expose constants for tests / tile.
        DEFAULT_W: DEFAULT_W,
        DEFAULT_H: DEFAULT_H
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const fakeSnap = {hubs: [
                {iata: "JFK", byRoute: [{dest: "LAX", weeklyFlights: 7, profitPerWeek: 50000, paxLF: 0.85}]},
                {iata: "LAX", byRoute: [{dest: "JFK", weeklyFlights: 7, profitPerWeek: 50000, paxLF: 0.85}]}
            ]}
            const s1 = build(fakeSnap, {w: 200, h: 200})
            console.assert(s1.nodes.length === 2, "[smoke ng] node count")
            console.assert(s1.edges.length === 2, "[smoke ng] edge count")
            const s2 = settle(build(fakeSnap, {w: 200, h: 200}))
            console.assert(s2.iter > 0 && s2.temperature < 0.1, "[smoke ng] settled")
            // Two-node spring should pull toward SPRING_LEN distance.
            const a = s2.nodes[0], b = s2.nodes[1]
            const d = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
            console.assert(d > 30 && d < 200, "[smoke ng] reasonable distance: " + d.toFixed(1))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
