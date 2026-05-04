"use strict";

// QOL: sticky table headers + inline filter input on long AS tables.
//
// AS finance and fleet pages routinely render 30+ row tables without any
// way to filter or anchor the header. This module:
//   1. Marks tables with > MIN_ROWS_STICKY rows as sticky-thead (CSS does
//      the actual position:sticky work via .aes-skin-sticky).
//   2. Injects a brutalist filter input above tables with > MIN_ROWS_FILTER
//      rows. Typing hides non-matching rows (case-insensitive substring
//      match across full row textContent).
//
// Skips: Route Assistant root, AES-injected tables (those already provide
// their own filtering UI), and tables inside hidden tab panes.

(function () {
    if (window.AESSiteSkin
        && typeof window.AESSiteSkin.isEnabled === "function"
        && !window.AESSiteSkin.isEnabled()) return;
    if (window.AESSiteSkin
        && typeof window.AESSiteSkin.getPageKind === "function"
        && window.AESSiteSkin.getPageKind() === "scheduling") return;

    const MIN_ROWS_STICKY = 8;
    const MIN_ROWS_FILTER = 12;
    const SCAN_DELAY = 200;

    function isSkippableTable(table) {
        if (!table || !table.tBodies || !table.tBodies.length) return true;
        if (table.closest("#aes-route-assistant")) return true;
        if (table.closest(".aes-panel")) return true;
        if (table.classList.contains("aes-table")) return true;
        if (table.dataset.aesSkinPolished === "1") return true;
        return false;
    }

    function rowCount(table) {
        let total = 0;
        for (const tbody of table.tBodies) total += tbody.rows.length;
        return total;
    }

    function bindFilter(table, input, count) {
        if (!table || !input || !count || input.dataset.aesSkinFilterBound === "1") return;
        input.dataset.aesSkinFilterBound = "1";

        let scheduled = false;
        let lastQuery = input.value.trim();

        function applyFilter() {
            scheduled = false;
            const q = lastQuery.toLowerCase();
            let visible = 0;
            for (const tbody of table.tBodies) {
                for (const row of tbody.rows) {
                    const match = !q || row.textContent.toLowerCase().includes(q);
                    row.style.display = match ? "" : "none";
                    if (match) visible++;
                }
            }
            count.textContent = q
                ? `${visible}/${rowCount(table)} ROWS`
                : `${rowCount(table)} ROWS`;
        }

        input.addEventListener("input", function () {
            lastQuery = input.value.trim();
            if (!scheduled) {
                scheduled = true;
                setTimeout(applyFilter, 0);
            }
        });
    }

    function ensureFilterBinding(table) {
        const wrap = table && table.previousElementSibling;
        if (!wrap || !wrap.classList || !wrap.classList.contains("aes-skin-filter-wrap")) return;
        bindFilter(
            table,
            wrap.querySelector('input[data-aes-skin-filter="1"]'),
            wrap.querySelector(".aes-skin-filter-wrap__count")
        );
    }

    function injectFilter(table) {
        const wrap = document.createElement("div");
        wrap.className = "aes-skin-filter-wrap";

        const label = document.createElement("label");
        label.textContent = "FILTER";

        const input = document.createElement("input");
        input.type = "search";
        input.placeholder = "type to filter rows...";
        input.setAttribute("aria-label", "Filter table rows");
        input.dataset.aesSkinFilter = "1";

        const count = document.createElement("span");
        count.className = "aes-skin-filter-wrap__count";
        count.textContent = `${rowCount(table)} ROWS`;

        wrap.append(label, input, count);
        table.parentNode.insertBefore(wrap, table);

        bindFilter(table, input, count);
    }

    function polishTable(table) {
        if (table && table.dataset && table.dataset.aesSkinPolished === "1") {
            ensureFilterBinding(table);
            return;
        }
        if (isSkippableTable(table)) return;
        const rows = rowCount(table);
        if (rows < MIN_ROWS_STICKY) return;

        table.dataset.aesSkinPolished = "1";
        table.classList.add("aes-skin-sticky");

        if (rows >= MIN_ROWS_FILTER) injectFilter(table);
    }

    function scan() {
        const tables = document.querySelectorAll("table.table, table.aes-table--host, table");
        for (const t of tables) polishTable(t);
    }

    function init() {
        scan();
        // AS pages occasionally re-render content via Wicket AJAX — observe
        // body-level mutations and rescan with debounce.
        let timer = null;
        new MutationObserver(function () {
            if (timer) return;
            timer = setTimeout(function () {
                timer = null;
                scan();
            }, SCAN_DELAY);
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
