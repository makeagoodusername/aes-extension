"use strict";

/**
 * Sidebar panel injected into the AS `flightsPrices?adjust=true` page.
 * Shows the formula's per-route per-class recommendations for the current
 * scope, lets the user deselect rows, and triggers an apply fan-out via
 * `RouteAssistantFlightsPricesBridge.applySelected()`.
 *
 * No business logic lives here — selection state, rendering, and the
 * Apply button click → bridge call. The bridge owns the formula+applier
 * round-trip; the panel is a dumb-as-possible UI surface so the bridge
 * stays unit-testable under Node.
 *
 * Usage:
 *   const panel = new RouteAssistantFlightsPricesPanel({ bridge, applier });
 *   panel.mount(containerEl);
 *   await panel.refresh(filter);
 */
(function() {
    "use strict";

    const STATUS_GLYPHS = {
        "verified":  "✓",
        "posted":    "✓",
        "dry-run":   "⏸",
        "aborted":   "✗",
        "failed":    "✗"
    };

    function fmtCurrency(v) {
        if (v == null || !isFinite(v)) return "—";
        return Math.round(Number(v)).toLocaleString() + " AS$";
    }

    function fmtPct(v) {
        if (v == null || !isFinite(v)) return "—";
        const n = Number(v);
        const sign = n > 0 ? "+" : "";
        return sign + n.toFixed(1) + "%";
    }

    function deltaClass(v) {
        if (v == null || !isFinite(v)) return "";
        if (v > 0) return "good";
        if (v < 0) return "bad";
        return "";
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function rowKey(row) {
        return row.hub + "-" + row.dest + ":" + row.classKey;
    }

    class RouteAssistantFlightsPricesPanel {
        constructor(opts) {
            opts = opts || {};
            this.bridge   = opts.bridge   || null;
            this.applier  = opts.applier  || null;
            this.settings = opts.settings || {};
            this.container = null;
            this._lastRows  = [];
            this._lastDiagnostics = {};
            this._lastFilter = {};
            this._results   = new Map();   // pair → result envelope
            this._selected  = new Set();   // rowKey strings
            this._busy      = false;
        }

        mount(container) {
            this.container = container;
            this.container.innerHTML = ""
                + '<div class="as-panel aes-fp-panel">'
                + '  <h3 class="aes-fp-panel-title">AES recommendations</h3>'
                + '  <p class="aes-fp-blurb">Live per-route, per-class price recommendations from the AES strategy formula. '
                +     'Select the rows you want to change and click <strong>Apply</strong> — each apply runs through the existing '
                +     'per-route applier (gated by your Auto-Pricing settings; bulk-recommended scope defaults live).</p>'
                + '  <div class="aes-fp-summary"></div>'
                + '  <div class="aes-fp-actions">'
                + '    <button type="button" class="btn btn-default aes-fp-refresh" title="Re-read storage caches and rebuild the strategy snapshot">↻ Refresh</button>'
                + '    <button type="button" class="btn btn-default aes-fp-select-all">Select all</button>'
                + '    <button type="button" class="btn btn-default aes-fp-select-none">Select none</button>'
                + '    <button type="button" class="btn btn-primary aes-fp-apply" disabled>Apply 0 routes</button>'
                + '    <span class="aes-fp-status"></span>'
                + '  </div>'
                + '  <div class="aes-fp-table-well as-table-well"></div>'
                + '</div>';

            this.$summary = this.container.querySelector(".aes-fp-summary");
            this.$apply   = this.container.querySelector(".aes-fp-apply");
            this.$status  = this.container.querySelector(".aes-fp-status");
            this.$tableWell = this.container.querySelector(".aes-fp-table-well");

            this.container.querySelector(".aes-fp-select-all")
                .addEventListener("click", () => this._selectAll(true));
            this.container.querySelector(".aes-fp-select-none")
                .addEventListener("click", () => this._selectAll(false));
            this.container.querySelector(".aes-fp-refresh")
                .addEventListener("click", () => this.refresh(this._lastFilter, { forceFresh: true }));
            this.$apply.addEventListener("click", () => this._handleApply());
        }

        async refresh(filter, opts) {
            opts = opts || {};
            if (!this.bridge) {
                this._renderEmpty("Bridge not initialised.");
                return;
            }
            this._lastFilter = filter || {};
            this._renderEmpty(opts.forceFresh
                ? "Refreshing from storage…"
                : "Computing recommendations…");
            let rec = null;
            try {
                rec = await this.bridge.computeRecommendations(filter, { forceFresh: !!opts.forceFresh });
            } catch (e) {
                this._renderEmpty("Failed to compute: " + (e && e.message || e));
                return;
            }
            this._lastRows = rec && rec.rows ? rec.rows : [];
            this._lastDiagnostics = rec && rec.diagnostics ? rec.diagnostics : {};
            this._results = new Map();
            this._selected = new Set(this._lastRows.map(rowKey));
            this._render();
        }

        // ------------------------------------------------------------------

        _renderEmpty(msg) {
            this.$summary.innerHTML = "";
            this.$tableWell.innerHTML = '<p class="aes-fp-empty">' + escapeHtml(msg) + '</p>';
            this._updateApplyButton();
        }

        _render() {
            if (!this._lastRows.length) {
                this._renderEmpty("No matching routes — pick a filter or scrape some markets pages first.");
                return;
            }
            // Group rows by route pair so each pair is one visual row block
            // with multiple class sub-rows.
            const byPair = new Map();
            for (const r of this._lastRows) {
                const k = r.hub + "-" + r.dest;
                if (!byPair.has(k)) byPair.set(k, []);
                byPair.get(k).push(r);
            }

            // Sort by max |Δ%| within each pair descending — biggest moves
            // surface first, so the operator scans the most-impactful rows
            // before scrolling. Ties broken alphabetically by route for
            // deterministic ordering across renders.
            const maxAbsDelta = (rows) => rows.reduce((m, r) =>
                Math.max(m, Math.abs(Number(r.deltaPct) || 0)), 0);
            const pairs = Array.from(byPair.entries()).sort((a, b) => {
                const ma = maxAbsDelta(a[1]), mb = maxAbsDelta(b[1]);
                if (ma !== mb) return mb - ma;
                return a[0].localeCompare(b[0]);
            });

            const lines = [];
            lines.push('<table class="aes-fp-table table table-bordered table-hover">');
            lines.push('<thead><tr>'
                + '<th style="width:32px;"></th>'
                + '<th>Route</th>'
                + '<th>Class</th>'
                + '<th class="text-right">Baseline</th>'
                + '<th class="text-right">Recommended</th>'
                + '<th class="text-right">Δ%</th>'
                + '<th class="text-right">Min</th>'
                + '<th class="text-right">Load</th>'
                + '<th>Rationale</th>'
                + '<th>Status</th>'
                + '</tr></thead><tbody>');

            for (const [pair, rows] of pairs) {
                const result = this._results.get(pair) || null;
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const key = rowKey(row);
                    const checked = this._selected.has(key) ? " checked" : "";
                    const clamped = row.clampedToFloor ? '<span class="aes-fp-tag warn" title="Bumped up to AS-stated minimum price">⚠ clamp</span>' : "";
                    const noFlightInfo = row.flightInfoMissing
                        ? '<span class="aes-fp-tag muted" title="No scraped flight-info for this route — open a flight-info page to seed Min Price + Load">no flight data</span>'
                        : "";
                    const rationale = (row.rationale || []).join(" · ");
                    const status = result ? this._renderStatus(result) : '<span class="muted">—</span>';
                    lines.push("<tr"
                        + (row.clampedToFloor ? ' class="aes-fp-row clamped"' : ' class="aes-fp-row"')
                        + ' data-key="' + escapeHtml(key) + '">');
                    if (i === 0) {
                        lines.push('<td rowspan="' + rows.length + '" class="text-center">');
                        lines.push('<input type="checkbox" class="aes-fp-route-check"'
                            + ' data-pair="' + escapeHtml(pair) + '"'
                            + (this._allRowsSelected(rows) ? " checked" : "")
                            + '/>');
                        lines.push('</td>');
                        lines.push('<td rowspan="' + rows.length + '"><strong>' + escapeHtml(row.hub) + '→' + escapeHtml(row.dest) + '</strong></td>');
                    }
                    lines.push('<td>' + escapeHtml(row.classKey) + ' ' + clamped + ' ' + noFlightInfo + '</td>');
                    lines.push('<td class="text-right">' + fmtCurrency(row.baseline) + '</td>');
                    lines.push('<td class="text-right"><strong>' + fmtCurrency(row.toPrice) + '</strong></td>');
                    lines.push('<td class="text-right ' + deltaClass(row.deltaPct) + '">' + fmtPct(row.deltaPct) + '</td>');
                    lines.push('<td class="text-right">' + fmtCurrency(row.minPrice) + '</td>');
                    lines.push('<td class="text-right">'
                        + (row.currentLoad == null ? "—" : Math.round(row.currentLoad) + "%") + '</td>');
                    if (i === 0) {
                        lines.push('<td rowspan="' + rows.length + '" class="aes-fp-rationale">' + escapeHtml(rationale) + '</td>');
                        lines.push('<td rowspan="' + rows.length + '">' + status + '</td>');
                    }
                    lines.push("</tr>");
                }
            }
            lines.push("</tbody></table>");

            this.$tableWell.innerHTML = lines.join("");

            // Wire row checkbox handlers (per-route, applies to all class
            // rows for that pair).
            for (const cb of this.$tableWell.querySelectorAll(".aes-fp-route-check")) {
                cb.addEventListener("change", (e) => {
                    const pair = e.target.getAttribute("data-pair");
                    const checked = e.target.checked;
                    for (const r of (byPair.get(pair) || [])) {
                        const k = rowKey(r);
                        if (checked) this._selected.add(k);
                        else this._selected.delete(k);
                    }
                    this._updateApplyButton();
                    this._renderSummary();
                });
            }

            this._renderSummary();
            this._updateApplyButton();
        }

        _renderStatus(env) {
            if (!env) return '<span class="muted">—</span>';
            const s = env.status || "?";
            const glyph = STATUS_GLYPHS[s] || "?";
            const cls = (s === "verified" || s === "posted") ? "good"
                : (s === "dry-run") ? "muted"
                : (s === "aborted") ? "warn"
                : "bad";
            // Failure-side detail: env.error.message > first preflight
            // blocker > applyGate reason. The applier only ever populates
            // one of these per result, so we walk in priority order.
            const tail = [];
            if (env.error && env.error.message) {
                tail.push(env.error.message);
            } else if (env.preflight && Array.isArray(env.preflight.blockers) && env.preflight.blockers.length) {
                tail.push("blocker: " + env.preflight.blockers[0].code);
            } else if (env.applyGate && env.applyGate.reason) {
                tail.push(env.applyGate.reason);
            }
            if (env.clamped) tail.push("⚠ clamped");
            const tailTxt = tail.length ? " · " + tail.join(" · ") : "";
            return '<span class="' + cls + '" title="' + escapeHtml(JSON.stringify(env.error || env.applyGate || {})) + '">'
                + glyph + " " + escapeHtml(s) + escapeHtml(tailTxt) + "</span>";
        }

        _renderSummary() {
            const totalRoutes = new Set(this._lastRows.map(r => r.hub + "-" + r.dest)).size;
            const totalRows   = this._lastRows.length;
            const selected = this._selected.size;
            const clampedRows = this._lastRows.filter(r => r.clampedToFloor).length;
            const stale = this._lastDiagnostics.routesWithoutFlightInfo || 0;
            const inScope = this._lastDiagnostics.routesInScope || 0;
            const apply = (this.settings && this.settings.routeAssistant
                && this.settings.routeAssistant.pricing
                && this.settings.routeAssistant.pricing.apply) || {};
            const liveScopes = Object.assign({bulkRecommended: true}, apply.liveScopes || {});
            const dryRun = apply.dryRunOnly === true || apply.enabled === false || liveScopes.bulkRecommended === false;
            const chips = [];
            chips.push('<span class="aes-fp-stat">'
                + totalRoutes + ' routes · ' + totalRows + ' class rows · ' + selected + ' selected'
                + (clampedRows ? ' · <span class="warn">⚠ ' + clampedRows + ' clamped</span>' : '')
                + (stale ? ' · <span class="muted">' + stale + '/' + inScope + ' missing flight-info</span>' : '')
                + '</span>');
            chips.push('<span class="aes-fp-mode ' + (dryRun ? 'muted' : 'good') + '">'
                + (dryRun ? '⏸ Dry-run (bulkRecommended scope is disabled)'
                          : '⚡ Live writes enabled')
                + '</span>');
            if (this._lastDiagnostics.strategyAvailable === false) {
                chips.push('<span class="aes-fp-mode warn" title="AesStrategy not loaded on this page; '
                    + 'recommendations cannot be computed. Check manifest or reload the page.">'
                    + '⚠ no strategy module</span>');
            } else if (this._lastDiagnostics.strategyError) {
                chips.push('<span class="aes-fp-mode bad" title="' + escapeHtml(this._lastDiagnostics.strategyError) + '">'
                    + '⚠ strategy error</span>');
            } else if (this._lastDiagnostics.snapshotCached) {
                chips.push('<span class="aes-fp-mode muted" title="Strategy snapshot served from in-memory cache; click Refresh to rebuild from storage.">cached</span>');
            }
            this.$summary.innerHTML = chips.join(" ");
        }

        _updateApplyButton() {
            const n = this._selected.size;
            this.$apply.disabled = !n || this._busy;
            this.$apply.textContent = "Apply " + n + " row" + (n === 1 ? "" : "s");
        }

        _selectAll(on) {
            if (on) for (const r of this._lastRows) this._selected.add(rowKey(r));
            else this._selected.clear();
            this._render();
        }

        _allRowsSelected(rows) {
            for (const r of rows) {
                if (!this._selected.has(rowKey(r))) return false;
            }
            return true;
        }

        async _handleApply() {
            if (!this.bridge || !this.applier) {
                this._setStatus("bad", "Bridge or applier missing");
                return;
            }
            const selectedRows = this._lastRows.filter(r => this._selected.has(rowKey(r)));
            if (!selectedRows.length) return;

            // Gate live writes behind a confirm step. Dry-run skips the
            // dialog (no AS-side effect) — preview→apply is itself the
            // dry-run UX. The gate snapshot here is the same one the
            // applier resolves when each call lands; we just compute it
            // ahead of time to decide whether to prompt.
            const apply = (this.settings && this.settings.routeAssistant
                && this.settings.routeAssistant.pricing
                && this.settings.routeAssistant.pricing.apply) || {};
            const liveScopes = Object.assign({bulkRecommended: true}, apply.liveScopes || {});
            const dryRun = apply.dryRunOnly === true || apply.enabled === false
                || liveScopes.bulkRecommended === false;
            if (!dryRun) {
                const confirmed = await this._confirmLiveWrites(selectedRows);
                if (!confirmed) {
                    this._setStatus("muted", "Apply cancelled.");
                    return;
                }
            }

            this._busy = true;
            this._updateApplyButton();
            this._setStatus("muted", "Applying " + selectedRows.length + " row(s)…");
            try {
                const out = await this.bridge.applySelected(selectedRows, {
                    applier: this.applier,
                    reason:  "flightsPrices panel apply",
                    onRow:   (r) => {
                        if (r && r.pair && r.result) this._results.set(r.pair, r.result);
                        this._render();
                    }
                });
                const s = out && out.summary;
                this._setStatus("good", s
                    ? "Done — " + s.verified + " verified, " + s.posted + " posted, "
                        + s.dryRun + " dry-run, " + s.aborted + " aborted, " + s.failed + " failed"
                        + (s.clamped ? " · " + s.clamped + " clamped" : "")
                    : "Done.");
            } catch (e) {
                this._setStatus("bad", "Apply threw: " + (e && e.message || e));
            } finally {
                this._busy = false;
                this._updateApplyButton();
            }
        }

        /**
         * Live-write confirmation modal. Resolves to true (confirm) or
         * false (cancel). DOM-only — uses the existing .aes-fp-confirm-*
         * styles in components.css; no Bootstrap modal dependency so this
         * stays self-contained.
         */
        _confirmLiveWrites(selectedRows) {
            return new Promise((resolve) => {
                const pairs = new Set(selectedRows.map(r => r.hub + "-" + r.dest));
                const clampedCells = selectedRows.filter(r => r.clampedToFloor).length;
                const noFlightInfo = selectedRows.filter(r => r.flightInfoMissing).length;

                const backdrop = document.createElement("div");
                backdrop.className = "aes-fp-confirm-backdrop";
                backdrop.innerHTML = ""
                    + '<div class="aes-fp-confirm-modal" role="dialog" aria-modal="true">'
                    + '  <h4>Apply live ticket-price changes?</h4>'
                    + '  <p>This will POST to AirlineSim per route — real money in-game. The'
                    +    ' live gate (apply.enabled + bulkRecommended scope) has cleared.</p>'
                    + '  <ul>'
                    + '    <li><strong>' + pairs.size + '</strong> route' + (pairs.size === 1 ? '' : 's')
                    +      ' — <strong>' + selectedRows.length + '</strong> class change'
                    +      (selectedRows.length === 1 ? '' : 's') + '</li>'
                    + (clampedCells
                        ? '<li><span class="warn">⚠ ' + clampedCells + ' will be clamped to the AS-stated minimum price</span></li>'
                        : '')
                    + (noFlightInfo
                        ? '<li><span class="muted">' + noFlightInfo
                            + ' lack scraped flight-info — min-price floor cannot protect those</span></li>'
                        : '')
                    + '    <li>Per-route circuit breaker, dedup, and audit log will engage automatically.</li>'
                    + '  </ul>'
                    + '  <div class="aes-fp-confirm-actions">'
                    + '    <button type="button" class="btn btn-default aes-fp-confirm-cancel">Cancel</button>'
                    + '    <button type="button" class="btn btn-primary aes-fp-confirm-ok">Apply '
                    +      selectedRows.length + ' change' + (selectedRows.length === 1 ? '' : 's') + '</button>'
                    + '  </div>'
                    + '</div>';

                const cleanup = (verdict) => {
                    document.removeEventListener("keydown", onKey, true);
                    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
                    resolve(verdict);
                };
                const onKey = (e) => {
                    if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
                    if (e.key === "Enter")  { e.preventDefault(); cleanup(true);  }
                };
                backdrop.addEventListener("click", (e) => {
                    if (e.target === backdrop) cleanup(false);
                });
                document.body.appendChild(backdrop);
                backdrop.querySelector(".aes-fp-confirm-cancel")
                    .addEventListener("click", () => cleanup(false));
                backdrop.querySelector(".aes-fp-confirm-ok")
                    .addEventListener("click", () => cleanup(true));
                document.addEventListener("keydown", onKey, true);
                const okBtn = backdrop.querySelector(".aes-fp-confirm-ok");
                if (okBtn && typeof okBtn.focus === "function") okBtn.focus();
            });
        }

        _setStatus(cls, text) {
            if (!this.$status) return;
            this.$status.className = "aes-fp-status " + (cls || "");
            this.$status.textContent = text || "";
        }
    }

    const api = { RouteAssistantFlightsPricesPanel };
    if (typeof window !== "undefined") {
        RouteAssistantFlightsPricesPanel.RouteAssistantFlightsPricesPanel = RouteAssistantFlightsPricesPanel;
        window.RouteAssistantFlightsPricesPanel = RouteAssistantFlightsPricesPanel;
        window.RouteAssistantFlightsPricesPanelAPI = api;
    }
})();
