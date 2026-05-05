"use strict";

/**
 * AES Shared — Site-skin coverage report.
 *
 * Static truth table mapping each AS page-family classifier (the value
 * that bootstrap.js stamps on `<html data-aes-page>`) to the CSS file
 * that styles it, the line-count depth of that file, and a sample
 * pathname. Powers the Coverage diagnostic tab in unified-settings.
 *
 * The table is intentionally hand-maintained — when bootstrap.js gains
 * a new page-kind classifier, add a row here so the diagnostics tab
 * surfaces the gap (or confirms coverage). Line counts are approximate
 * caps — rounding to nearest 10 keeps the table stable across whitespace
 * tweaks.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESSkinCoverage) return;

    /**
     * Depth band per page family:
     *   "deep"   ≥ 80 lines and matches AS-table polish parity
     *   "thin"   1–79 lines (skeletal)
     *   "absent" no skin file (CSS-wise)
     *   "global" handled entirely by skin-global.css (no per-page file)
     */
    const COVERAGE = [
        {pageKind: "fleet",          sample: "/app/fleets",                    skinFile: "css/skin/skin-fleet.css",     skinLines: 120, depth: "deep",   classifiedBy: "bootstrap.js:26"},
        {pageKind: "scheduling",     sample: "/app/com/scheduling/<HUB>",      skinFile: "css/skin/skin-schedule.css",  skinLines: 100, depth: "deep",   classifiedBy: "bootstrap.js:27"},
        {pageKind: "inventory",      sample: "/app/com/inventory",             skinFile: "(skin-global.css only)",      skinLines: 0,   depth: "global", classifiedBy: "bootstrap.js:28"},
        {pageKind: "markets",        sample: "/app/com/markets/<HUB>",         skinFile: "(skin-global.css only)",      skinLines: 0,   depth: "global", classifiedBy: "bootstrap.js:29"},
        {pageKind: "aircraft-market", sample: "/app/aircraft/market",          skinFile: "(skin-global.css only)",      skinLines: 0,   depth: "global", classifiedBy: "bootstrap.js:30"},
        {pageKind: "airports",       sample: "/app/info/airports/<IATA>",      skinFile: "css/skin/skin-info.css",      skinLines: 327, depth: "deep",   classifiedBy: "bootstrap.js:31"},
        {pageKind: "enterprises",    sample: "/app/info/enterprises/<id>",     skinFile: "css/skin/skin-info.css",      skinLines: 327, depth: "deep",   classifiedBy: "bootstrap.js:32"},
        {pageKind: "ops",            sample: "/app/ops/stations",              skinFile: "css/skin/skin-ops.css",       skinLines: 80,  depth: "deep",   classifiedBy: "bootstrap.js:33"},
        {pageKind: "dashboard",      sample: "/app/enterprise/dashboard",      skinFile: "(skin-global.css only)",      skinLines: 0,   depth: "global", classifiedBy: "bootstrap.js:34"},
        {pageKind: "marketing",      sample: "/app/enterprise/marketing",      skinFile: "css/skin/skin-marketing.css", skinLines: 100, depth: "deep",   classifiedBy: "bootstrap.js:35"},
        {pageKind: "settings",       sample: "/app/enterprise/settings",       skinFile: "(skin-global.css only)",      skinLines: 0,   depth: "global", classifiedBy: "bootstrap.js:36"},
        {pageKind: "alliance",       sample: "/app/alliance/<id>",             skinFile: "css/skin/skin-alliance.css",  skinLines: 110, depth: "deep",   classifiedBy: "bootstrap.js:37"},
        {pageKind: "flight-info",    sample: "/action/info/flight/<id>",       skinFile: "(skin-global.css only)",      skinLines: 0,   depth: "global", classifiedBy: "bootstrap.js:38"},
        {pageKind: "staff",          sample: "/action/enterprise/staffOverview", skinFile: "css/skin/skin-staff.css",   skinLines: 110, depth: "deep",   classifiedBy: "bootstrap.js:39"},
        {pageKind: "finance",        sample: "/app/finance/accounting",        skinFile: "css/skin/skin-finance.css",   skinLines: 34,  depth: "thin",   classifiedBy: "bootstrap.js:24"},
        {pageKind: "app",            sample: "/app/...",                       skinFile: "(fallback)",                  skinLines: 0,   depth: "absent", classifiedBy: "bootstrap.js:40"},
        {pageKind: "action",         sample: "/action/...",                    skinFile: "(fallback)",                  skinLines: 0,   depth: "absent", classifiedBy: "bootstrap.js:41"},
        {pageKind: "other",          sample: "(unknown)",                      skinFile: "(fallback)",                  skinLines: 0,   depth: "absent", classifiedBy: "bootstrap.js:42"}
    ];

    function currentPageKind() {
        try {
            return document.documentElement.dataset.aesPage || "other";
        } catch (_) {
            return "other";
        }
    }

    function report() {
        const cur = currentPageKind();
        return COVERAGE.map(function (row) {
            return Object.assign({}, row, {isCurrentPage: row.pageKind === cur});
        });
    }

    function current() {
        const cur = currentPageKind();
        const row = COVERAGE.find(function (r) { return r.pageKind === cur; });
        return row ? Object.assign({}, row, {pathname: location.pathname, isCurrentPage: true})
                   : {pageKind: cur, pathname: location.pathname, depth: "absent", isCurrentPage: true};
    }

    window.AESSkinCoverage = {report, current, COVERAGE};
})();
