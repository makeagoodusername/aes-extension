"use strict";

// QOL: a brutalist top strip showing the user's current page identity,
// parsed from location.pathname and the document title. Inserted as the
// first child of <body> so AS's navbar sits above it.
//
// Skipped on Route Assistant scheduling pages (they have their own
// header chrome and the strip would compete for vertical space).

(function () {
    if (window.AESSiteSkin
        && typeof window.AESSiteSkin.isEnabled === "function"
        && !window.AESSiteSkin.isEnabled()) return;

    const SKIPPED_PAGES = new Set(["scheduling"]);

    function tail(s) { return (s || "").split("/").filter(Boolean).pop(); }

    function buildCrumbs() {
        const path = location.pathname;
        const m = (re) => path.match(re);
        let r;

        // Format: ordered list of crumb strings, last one is treated as the leaf.
        if (m(/^\/app\/finance\/accounting/))   return ["FINANCE", "ACCOUNTING"];
        if (m(/^\/app\/finance\/leasing/))      return ["FINANCE", "LEASING"];
        if (m(/^\/app\/finance\/capital/))      return ["FINANCE", "CAPITAL"];
        if (m(/^\/app\/finance\/assets/))       return ["FINANCE", "ASSETS"];
        if (m(/^\/action\/enterprise\/schedule/)) return ["FINANCE", "CASHFLOW"];
        if (m(/^\/app\/fleets\/aircraft\//))    {
            const reg = (document.title || "").trim().split("—")[0].trim()
                     || tail(path.replace(/\/[01]\??.*/, ""));
            return ["FLEET", "AIRCRAFT", reg.toUpperCase()];
        }
        if (m(/^\/app\/fleets/))                return ["FLEET"];
        if ((r = m(/^\/app\/com\/scheduling\/([^/?#]+)/))) return ["SCHEDULING", r[1].toUpperCase()];
        if ((r = m(/^\/app\/com\/inventory\/([^/?#]+)/)))  return ["INVENTORY", r[1].toUpperCase()];
        if ((r = m(/^\/app\/com\/markets\/([^/?#]+)/)))    return ["MARKETS", r[1].toUpperCase()];
        if (m(/^\/app\/com\/markets/))               return ["MARKETS"];
        if (m(/^\/app\/aircraft\/market/))           return ["AIRCRAFT", "MARKET"];
        if ((r = m(/^\/app\/info\/airports\/([^/?#]+)/)))  return ["INFO", "AIRPORT", r[1].toUpperCase()];
        if ((r = m(/^\/app\/info\/enterprises\/([^/?#]+)/))) return ["INFO", "ENTERPRISE", r[1].toUpperCase()];
        if (m(/^\/app\/ops\/stations/))              return ["OPS", "STATIONS"];
        if (m(/^\/app\/ops\//))                       return ["OPS"];
        if (m(/^\/app\/enterprise\/dashboard/))      return ["DASHBOARD"];
        if (m(/^\/app\/enterprise\/settings/))       return ["SETTINGS"];
        if (m(/^\/action\/info\/flight/))            return ["FLIGHT", "INFO"];
        if (m(/^\/action\/enterprise\/staffOverview/)) return ["STAFF"];
        return null;
    }

    function render() {
        const crumbs = buildCrumbs();
        if (!crumbs || !crumbs.length) return;

        const pageKind = document.body && document.body.dataset.aesPage;
        if (pageKind && SKIPPED_PAGES.has(pageKind)) return;

        if (document.querySelector(".aes-skin-breadcrumb")) return;

        const strip = document.createElement("nav");
        strip.className = "aes-skin-breadcrumb";
        strip.setAttribute("aria-label", "Page location");

        crumbs.forEach((crumb, i) => {
            if (i > 0) {
                const sep = document.createElement("span");
                sep.className = "aes-skin-breadcrumb__sep";
                sep.textContent = "/";
                strip.append(sep);
            }
            const span = document.createElement("span");
            span.className = "aes-skin-breadcrumb__crumb"
                          + (i === crumbs.length - 1 ? " aes-skin-breadcrumb__crumb--leaf" : "");
            span.textContent = crumb;
            strip.append(span);
        });

        document.body.insertBefore(strip, document.body.firstChild);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", render, { once: true });
    } else {
        render();
    }
})();
