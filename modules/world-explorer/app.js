"use strict"

;(function () {
    if (typeof window === "undefined") return
    if (window.__aesWorldExplorerBooted) return
    window.__aesWorldExplorerBooted = true

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, {once: true})
        } else { fn() }
    }

    ready(boot)

    let map = null;
    let board = null;
    let details = null;
    let networkGraph = null;
    let activeRoutes = [];

    async function boot() {
        console.log("World Explorer Booting")

        map = new WorldExplorerMap("aes-we-map");
        board = new WorldExplorerDeparturesBoard("aes-we-board");
        details = new WorldExplorerDetailsPane("aes-we-details");
        networkGraph = new WorldExplorerNetworkGraph("aes-we-network-graph");

        map.init();
        board.init();
        details.init();
        networkGraph.init();

        // Setup Tabs
        const btnMap = document.getElementById("we-tab-map");
        const btnNetwork = document.getElementById("we-tab-network");
        const viewMap = document.getElementById("we-view-map");
        const viewNetwork = document.getElementById("we-view-network");

        if (btnMap && btnNetwork) {
            btnMap.addEventListener("click", () => {
                btnMap.style.background = "#3b82f6";
                btnMap.style.color = "white";
                btnNetwork.style.background = "#e2e8f0";
                btnNetwork.style.color = "#334155";
                viewMap.style.display = "block";
                viewNetwork.style.display = "none";
                map.resize();
            });

            btnNetwork.addEventListener("click", () => {
                btnNetwork.style.background = "#3b82f6";
                btnNetwork.style.color = "white";
                btnMap.style.background = "#e2e8f0";
                btnMap.style.color = "#334155";
                viewMap.style.display = "none";
                viewNetwork.style.display = "block";
                networkGraph.resize();
            });
        }

        // Setup syncing
        // Setup Filters
        const filterOurs = document.getElementById("we-filter-our-flights");
        const filterComps = document.getElementById("we-filter-competitors");

        function updateFilters() {
            const filters = {
                showOurFlights: filterOurs ? filterOurs.checked : true,
                showCompetitors: filterComps ? filterComps.checked : true
            };
            map.setFilters(filters);
            board.setFilters(filters);
        }

        if (filterOurs) filterOurs.addEventListener("change", updateFilters);
        if (filterComps) filterComps.addEventListener("change", updateFilters);

        // Initial filters setup
        updateFilters();

        map.onSelect((id) => {
            board.selectRoute(id);
            const route = activeRoutes.find(r => r.id === id);
            if (route) details.setRoute(route);
            else details.clear();
        });

        board.onHover((id) => {
            map.hoveredRoute = id;
            map.draw();
        });

        board.onSelect((id) => {
            map.selectRoute(id);
            const route = activeRoutes.find(r => r.id === id);
            if (route) details.setRoute(route);
            else details.clear();
        });

        const server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : localStorage.getItem("aes_active_server");

        let accountId = null;
        if (window.__aesAccountId) {
            accountId = window.__aesAccountId;
        } else if (typeof chrome !== "undefined" && chrome.storage) {
            const data = await chrome.storage.local.get(["aesAccounts"]);
            accountId = Object.keys(data.aesAccounts?.accounts || {})[0] || null;
        }

        if (server && accountId && typeof chrome !== "undefined" && chrome.storage) {
            const scheduleKey = `scheduleStore:${server}:acct:${accountId}:active`;
            const data = await chrome.storage.local.get([scheduleKey]);
            const schedule = data[scheduleKey];

            if (schedule && schedule.flights) {
                schedule.flights.forEach(f => {
                    const hub = f.origin;
                    const dest = f.destination;
                    // Approximate lat/lons for the prototype
                    const hubLat = hub === "JFK" ? 40.64 : (hub === "LHR" ? 51.47 : 0);
                    const hubLon = hub === "JFK" ? -73.78 : (hub === "LHR" ? -0.45 : 0);
                    const destLat = dest === "CDG" ? 49.00 : (dest === "SYD" ? -33.94 : 0);
                    const destLon = dest === "CDG" ? 2.55 : (dest === "SYD" ? 151.17 : 0);

                    activeRoutes.push({
                        id: f.flightId || Math.random().toString(),
                        hub, dest,
                        hubLat, hubLon, destLat, destLon,
                        airline: "Our Airline",
                        isOurs: true,
                        isAlliance: false,
                        flightNumber: f.flightNumber || "N/A"
                    });
                });
            }
        }

        if (activeRoutes.length === 0) {
            activeRoutes = [
 feat/world-explorer-map-interactions-889865835095403658
                { id: "1", hub: "JFK", dest: "LHR", hubLat: 40.64, hubLon: -73.78, destLat: 51.47, destLon: -0.45, airline: "Fly Nyon", isOurs: true, isAlliance: false, flightNumber: "FN101" },
                { id: "2", hub: "JFK", dest: "CDG", hubLat: 40.64, hubLon: -73.78, destLat: 49.00, destLon: 2.55, airline: "Air France", isOurs: false, isAlliance: false, flightNumber: "AF001" },
                { id: "3", hub: "LHR", dest: "DXB", hubLat: 51.47, hubLon: -0.45, destLat: 25.25, destLon: 55.36, airline: "Emirates", isOurs: false, isAlliance: false, flightNumber: "EK002" },
                { id: "4", hub: "DXB", dest: "SYD", hubLat: 25.25, hubLon: 55.36, destLat: -33.94, destLon: 151.17, airline: "Fly Nyon", isOurs: true, isAlliance: false, flightNumber: "FN202" },
                { id: "5", hub: "LHR", dest: "CDG", hubLat: 51.47, hubLon: -0.45, destLat: 49.00, destLon: 2.55, airline: "British Airways", isOurs: false, isAlliance: true, flightNumber: "BA001" },
                { id: "6", hub: "JFK", dest: "SYD", hubLat: 40.64, hubLon: -73.78, destLat: -33.94, destLon: 151.17, airline: "Qantas", isOurs: false, isAlliance: true, flightNumber: "QF001" },
            ];
        }

        map.setRoutes(activeRoutes);
        board.setRoutes(activeRoutes);
    }
})()
