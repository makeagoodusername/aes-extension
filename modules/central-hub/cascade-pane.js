"use strict"

/**
 * CH-W3 — Cascade pane.
 *
 * Replaces the legacy single-column section flow with a salience-ranked
 * waterfall masonry. The shell mounts this in place of the section
 * containers when `centralHub:settings.layoutMode === "cascade"`; classic
 * flow remains the default.
 *
 * Layout model
 * ------------
 *   - N columns derived from main-pane width via ResizeObserver:
 *     `floor(width / --aes-tile-min-col)` clamped to [1, 5].
 *   - Tiles are pre-ranked by CentralHubSalience.rankTiles (shell hands
 *     them in render order). The packer assigns each tile, in order, to
 *     the column with the smallest current cumulative height — greedy
 *     waterfall, stable for ties (left-most wins).
 *   - cardKind hints determine column span:
 *       compact  → 1 column, dense single-row strip (just header)
 *       regular  → 1 column
 *       wide     → 2 columns (or 1 when columnCount === 1)
 *       marquee  → all columns (full-width row that closes its row)
 *
 * Pure module. No DOM in `packCascade`. The mount/host helpers are
 * separated so the packer is testable in node.
 *
 * Invariant CH-W3-A: section partitioning does not apply in cascade
 * mode. Tiles flow by salience across topics; a topic-chip filter
 * narrows the visible set, the packer never groups by topic.
 *
 * Invariant CH-W3-B: marquee tiles always close their current row and
 * start a new one. They never share their row with regular tiles. This
 * keeps tall hero-style tiles from being orphaned next to short cards.
 */
;(function () {
    if (typeof window === "undefined" || window.CentralHubCascade) return

    const MIN_COL_WIDTH_FALLBACK = 280     // px — fallback when --aes-tile-min-col is unset
    const COLUMN_COUNT_MIN = 1
    const COLUMN_COUNT_MAX = 5
    const COLUMN_GAP_PX = 12               // gap between columns; matches --aes-sp-3

    /**
     * Pure cascade packer.
     *
     *   tiles          — array of {id, cardKind, hint?} (rank-ordered)
     *   columnCount    — int 1..5
     *   heightProbes   — Map<tileId, number> — measured heights of
     *                    already-mounted tiles. Tiles missing a probe
     *                    get a fallback estimated height (200px) so the
     *                    first paint is reasonable; subsequent passes
     *                    use real heights.
     *   pinnedFullWidth — Set<tileId> — these tiles always claim full row
     *
     * Returns:
     *   {
     *     rows: [{kind: "row" | "marquee", columns: tilesByColumn[]}, ...]
     *   }
     *
     * Where each "row" carries a snapshot of the column heights at that
     * point so the renderer can apply consistent gaps. The renderer
     * iterates rows top→bottom and renders each as a flex/grid row.
     *
     * For a simpler v1 we emit a single row per cascade where each
     * column is a vertical stack — equivalent to a CSS column-count
     * masonry. Marquee + full-width pins break the cascade into
     * sub-cascades stitched by full-width banners.
     */
    function packCascade(tiles, columnCount, heightProbes, pinnedFullWidth) {
        const out = {bands: []}
        if (!Array.isArray(tiles) || !tiles.length) return out
        const cc = Math.max(COLUMN_COUNT_MIN, Math.min(COLUMN_COUNT_MAX,
            Number.isFinite(columnCount) ? columnCount : 3))
        const probes = heightProbes || new Map()
        const fullSet = pinnedFullWidth || new Set()

        let band = _newBand(cc)
        for (const t of tiles) {
            if (!t || !t.id) continue
            const kind = (t.cardKind === "compact" || t.cardKind === "wide"
                       || t.cardKind === "marquee" || t.cardKind === "regular")
                ? t.cardKind : "regular"

            // Full-width claims (marquee or pinned-full-width) close the
            // current band and emit a single banner band.
            if (kind === "marquee" || fullSet.has(t.id)) {
                if (_bandHasContent(band)) out.bands.push(band)
                out.bands.push({kind: "banner", tile: t, columns: cc})
                band = _newBand(cc)
                continue
            }

            const span = (kind === "wide" && cc > 1) ? 2 : 1
            const colIndex = _pickShortestColumn(band, span)
            const h = _heightFor(t, probes, kind)

            // Place the tile at colIndex spanning `span` columns.
            band.columns[colIndex].push({tile: t, span: span, kind: kind})
            // For wide tiles we add the height to BOTH the colIndex and
            // colIndex+1 trackers so subsequent placements respect the
            // visual occupation.
            band.colHeights[colIndex] += h
            if (span > 1 && colIndex + 1 < cc) {
                band.colHeights[colIndex + 1] += h
            }
        }
        if (_bandHasContent(band)) out.bands.push(band)
        return out
    }

    function _newBand(columnCount) {
        const cols = new Array(columnCount)
        const heights = new Array(columnCount).fill(0)
        for (let i = 0; i < columnCount; i++) cols[i] = []
        return {kind: "cascade", columns: cols, colHeights: heights}
    }

    function _bandHasContent(band) {
        if (!band || !band.columns) return false
        for (const c of band.columns) if (c && c.length) return true
        return false
    }

    function _pickShortestColumn(band, span) {
        const heights = band.colHeights
        const cc = heights.length
        if (span >= cc) return 0
        let best = 0
        let bestH = Number.POSITIVE_INFINITY
        const maxStart = cc - span
        for (let i = 0; i <= maxStart; i++) {
            // Effective height for a wide tile is the max of the columns
            // it occupies — placing it in the column where the tallest
            // neighbor is shortest minimises overall imbalance.
            let eff = heights[i]
            if (span > 1) {
                for (let j = 1; j < span; j++) {
                    if (heights[i + j] > eff) eff = heights[i + j]
                }
            }
            if (eff < bestH) {
                bestH = eff
                best = i
            }
        }
        return best
    }

    function _heightFor(tile, probes, kind) {
        if (probes && typeof probes.get === "function") {
            const m = probes.get(tile.id)
            if (typeof m === "number" && isFinite(m) && m > 0) return m
        }
        // Fallback estimates by cardKind. compact tiles are always thin,
        // marquee tiles handled separately, wide tiles tend to carry
        // tables (taller). regular is the middle.
        if (kind === "compact") return 60
        if (kind === "wide")    return 280
        return 200
    }

    /**
     * Compute column count from a container width and a per-column
     * min-width threshold. Pure. `minColPx` falls back to
     * MIN_COL_WIDTH_FALLBACK when missing/invalid so callers may
     * pass the resolved `--aes-tile-min-col` value.
     */
    function columnCountFor(containerWidthPx, minColPx) {
        const w = Number(containerWidthPx)
        if (!isFinite(w) || w <= 0) return 1
        const minColRaw = Number(minColPx)
        const minCol = (isFinite(minColRaw) && minColRaw > 0)
            ? minColRaw : MIN_COL_WIDTH_FALLBACK
        const raw = Math.floor((w + COLUMN_GAP_PX) / (minCol + COLUMN_GAP_PX))
        return Math.max(COLUMN_COUNT_MIN, Math.min(COLUMN_COUNT_MAX, raw))
    }

    function _readCssNumber(el, varName, fallback) {
        try {
            const cs = window.getComputedStyle(el)
            const raw = cs.getPropertyValue(varName)
            const n = parseInt(raw, 10)
            return isFinite(n) && n > 0 ? n : fallback
        } catch (_) { return fallback }
    }

    /**
     * Mount a cascade pane into `host`. Returns a controller with:
     *   {
     *     setTiles(tilesInRankOrder, heightProbes, pinnedFullWidth),
     *     setTopicFilter(topicSet | null),  // null = ALL
     *     refreshLayout(),
     *     dispose()
     *   }
     *
     * The shell still owns tile lifecycle (mount/refresh/dispose). The
     * cascade pane only reparents tile.root nodes between columns —
     * tiles never get unmounted on layout change.
     */
    function mount(host) {
        if (!host || !host.appendChild) return null

        host.classList.add("aes-cascade-pane")
        host.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "gap:" + COLUMN_GAP_PX + "px",
            "align-items:flex-start",
            "width:100%"
        ].join(";")

        const state = {
            tiles:        [],
            heights:      new Map(),
            fullSet:      new Set(),
            topicFilter:  null,
            columnCount:  1,
            disposed:     false,
            ro:           null,
            host:         host,
            columnEls:    [],
            // CH-W4 — runtime auto-promotion. Tiles whose body content
            // overflows their column get added here and treated as
            // cardKind="wide" until session end. Not persisted — the
            // user's persistent intent is `pinnedFullWidthTiles`.
            runtimeWideSet: new Set(),
            tileObservers:  new Map()
        }

        function _layout() {
            if (state.disposed) return
            const cc = state.columnCount
            // Bands may interleave column groups with full-width banners,
            // so we always clear the host and re-emit the entire flow.
            host.innerHTML = ""
            state.columnEls = []

            const visible = state.topicFilter
                ? state.tiles.filter(t => _tileMatchesTopics(t, state.topicFilter))
                : state.tiles
            // CH-W4 — apply runtime-wide overrides without mutating the
            // input tile specs (callers may share the array). Walks once
            // before the pack call.
            const effective = visible.map(t => {
                if (t && t.id && state.runtimeWideSet.has(t.id) && t.cardKind === "regular") {
                    return Object.assign({}, t, {cardKind: "wide"})
                }
                return t
            })
            const packed = packCascade(effective, cc, state.heights, state.fullSet)

            // Render bands top→bottom. Each cascade band emits its own
            // column row so a banner naturally breaks the masonry into
            // sub-cascades stitched by full-width rows.
            for (const band of packed.bands) {
                if (band.kind === "banner") {
                    const banner = document.createElement("div")
                    banner.className = "aes-cascade-pane__banner"
                    banner.style.cssText = [
                        "flex:0 0 100%",
                        "width:100%"
                    ].join(";")
                    if (band.tile && band.tile._root) banner.appendChild(band.tile._root)
                    host.appendChild(banner)
                    continue
                }
                // Cascade band: one row of `cc` columns.
                const rowEl = document.createElement("div")
                rowEl.className = "aes-cascade-pane__row"
                rowEl.style.cssText = [
                    "flex:0 0 100%",
                    "width:100%",
                    "display:flex",
                    "gap:" + COLUMN_GAP_PX + "px",
                    "align-items:flex-start"
                ].join(";")
                for (let ci = 0; ci < band.columns.length; ci++) {
                    const col = document.createElement("div")
                    col.className = "aes-cascade-pane__col"
                    col.dataset.colIdx = String(ci)
                    col.style.cssText = [
                        "flex:1 1 0",
                        "min-width:0",
                        "display:flex",
                        "flex-direction:column",
                        "gap:" + COLUMN_GAP_PX + "px"
                    ].join(";")
                    for (const slot of band.columns[ci]) {
                        if (!slot.tile || !slot.tile._root) continue
                        col.appendChild(slot.tile._root)
                        // Wide tile DOM hint — the actual visual span is
                        // a v2 enhancement; v1 packs them in single
                        // columns but tells CSS via data attribute so a
                        // future column-spanning grid can pick it up.
                        slot.tile._root.dataset.cascadeSpan = String(slot.span || 1)
                    }
                    rowEl.appendChild(col)
                    state.columnEls.push(col)
                }
                host.appendChild(rowEl)
            }

            // CH-W4 — attach ResizeObserver to each visible tile so
            // overflowing bodies trigger runtime promotion to "wide".
            // Idempotent — observers are reused across reflows.
            _ensureTileObservers()
        }

        function _ensureTileObservers() {
            if (typeof ResizeObserver === "undefined") return
            for (const t of state.tiles) {
                if (!t || !t.id || !t._root) continue
                if (state.tileObservers.has(t.id)) continue
                if (t.cardKind !== "regular") continue
                if (state.fullSet.has(t.id)) continue
                const root = t._root
                const ro = new ResizeObserver(() => {
                    if (state.disposed) return
                    if (state.runtimeWideSet.has(t.id)) return
                    // Probe the tile body — header chrome is typically
                    // narrow, the body holds the table that overflows.
                    const body = root.querySelector(".aes-central-hub-tile__body") || root
                    if (!body) return
                    if (body.scrollWidth > body.clientWidth + 2) {
                        state.runtimeWideSet.add(t.id)
                        // Re-flow once on the next frame so we don't
                        // thrash during the resize event itself.
                        if (typeof requestAnimationFrame === "function") {
                            requestAnimationFrame(_layout)
                        } else {
                            _layout()
                        }
                    }
                })
                ro.observe(root)
                state.tileObservers.set(t.id, ro)
            }
        }

        function setTiles(tilesInOrder, heightProbes, pinnedFullWidth) {
            state.tiles = (tilesInOrder || []).slice()
            state.heights = heightProbes || new Map()
            state.fullSet = pinnedFullWidth || new Set()
            _measureHeights()
            _layout()
        }

        function setTopicFilter(filter) {
            state.topicFilter = filter && filter.size ? filter : null
            _layout()
        }

        function refreshLayout() {
            _measureHeights()
            _layout()
        }

        function _measureHeights() {
            // Walk the current DOM (each tile's `_root`) and capture
            // bounding-rect heights so the next pack pass uses real
            // numbers. First-mount paints with fallback estimates.
            const probes = new Map(state.heights)
            for (const t of state.tiles) {
                const el = t && t._root
                if (!el) continue
                const h = el.getBoundingClientRect && el.getBoundingClientRect().height
                if (typeof h === "number" && h > 0) probes.set(t.id, h)
            }
            state.heights = probes
        }

        function _resize() {
            const minCol = _readCssNumber(host, "--aes-tile-min-col", MIN_COL_WIDTH_FALLBACK)
            const w = host.getBoundingClientRect().width
            const next = columnCountFor(w, minCol)
            if (next !== state.columnCount) {
                state.columnCount = next
                _layout()
            }
        }

        function dispose() {
            state.disposed = true
            if (state.ro && typeof state.ro.disconnect === "function") {
                try { state.ro.disconnect() } catch (_) {}
            }
            for (const ro of state.tileObservers.values()) {
                try { ro.disconnect() } catch (_) {}
            }
            state.tileObservers.clear()
            host.classList.remove("aes-cascade-pane")
            host.style.cssText = ""
            host.innerHTML = ""
        }

        if (typeof ResizeObserver !== "undefined") {
            state.ro = new ResizeObserver(() => _resize())
            state.ro.observe(host)
        }
        // Initial sizing.
        const initialW = host.getBoundingClientRect().width || window.innerWidth
        state.columnCount = columnCountFor(initialW, MIN_COL_WIDTH_FALLBACK)

        return {setTiles, setTopicFilter, refreshLayout, dispose}
    }

    /**
     * Helper: does a tile match the active topic filter? Tiles declare
     * `topics: string[]` (or fall back to spec.section). The filter is
     * a Set; intersection-non-empty matches.
     */
    function _tileMatchesTopics(tile, filterSet) {
        if (!filterSet || !filterSet.size) return true
        const topics = _topicsFor(tile)
        for (const t of topics) if (filterSet.has(t)) return true
        return false
    }

    /**
     * Resolve effective topics for a tile. v1 reads spec.topics if
     * present, otherwise falls back to [spec.section]. Topic overrides
     * (CH-W5) layer on top.
     */
    function _topicsFor(tile) {
        if (tile && Array.isArray(tile.topics) && tile.topics.length) return tile.topics
        if (tile && tile.section) return [tile.section]
        return []
    }

    window.CentralHubCascade = {
        packCascade,
        columnCountFor,
        mount,
        _topicsFor,
        _tileMatchesTopics
    }
})()
