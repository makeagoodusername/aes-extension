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

    async function boot() {
        console.log("World Explorer Booting")

        map = new WorldExplorerMap("aes-we-map");
        board = new WorldExplorerDeparturesBoard("aes-we-board");

        map.init();
        board.init();

        // Setup syncing
        map.onSelect((id) => {
            board.selectRoute(id);
        });

        board.onHover((id) => {
            map.hoveredRoute = id;
            map.draw();
        });

        board.onSelect((id) => {
            map.selectRoute(id);
        });

        const server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : localStorage.getItem("aes_active_server");

        let accountId = null;
        if (window.__aesAccountId) {
            accountId = window.__aesAccountId;
        } else if (typeof chrome !== "undefined" && chrome.storage) {
            const data = await chrome.storage.local.get(["aesAccounts"]);
            accountId = Object.keys(data.aesAccounts?.accounts || {})[0] || null;
        }

        let activeRoutes = [];
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
                        flightNumber: f.flightNumber || "N/A"
                    });
                });
            }
        }

        if (activeRoutes.length === 0) {
            activeRoutes = [
                { id: "1", hub: "JFK", dest: "LHR", hubLat: 40.64, hubLon: -73.78, destLat: 51.47, destLon: -0.45, airline: "Fly Nyon", isOurs: true, flightNumber: "FN101" },
                { id: "2", hub: "JFK", dest: "CDG", hubLat: 40.64, hubLon: -73.78, destLat: 49.00, destLon: 2.55, airline: "Air France", isOurs: false, flightNumber: "AF001" },
                { id: "3", hub: "LHR", dest: "DXB", hubLat: 51.47, hubLon: -0.45, destLat: 25.25, destLon: 55.36, airline: "Emirates", isOurs: false, flightNumber: "EK002" },
                { id: "4", hub: "DXB", dest: "SYD", hubLat: 25.25, hubLon: 55.36, destLat: -33.94, destLon: 151.17, airline: "Fly Nyon", isOurs: true, flightNumber: "FN202" },
            ];
        }

        map.setRoutes(activeRoutes);
        board.setRoutes(activeRoutes);
    }
})()
