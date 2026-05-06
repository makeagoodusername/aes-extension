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

        board.onFilterChange((visibleRoutes, performanceMode) => {
            map.setPerformanceMode(performanceMode);
            map.setRoutes(visibleRoutes);
        });

        const server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : localStorage.getItem("aes_active_server") || "unknown";

        let accountId = null;
        let myAirlineId = null;
        let myAllianceId = null;
        let subsidiaryIds = [];

        if (window.__aesAccountId) {
            accountId = window.__aesAccountId;
        } else if (typeof chrome !== "undefined" && chrome.storage) {
            const data = await chrome.storage.local.get(["aesAccounts"]);
            if (data.aesAccounts && data.aesAccounts.accounts) {
                const accounts = Object.values(data.aesAccounts.accounts);
                const acct = accounts.find(a => a.server === server) || accounts[0];
                if (acct) {
                    accountId = acct.id;
                    myAirlineId = acct.airlineId;
                }
            }
        }

        // Let's try to get affiliation data if available
        if (server && myAirlineId && typeof chrome !== "undefined" && chrome.storage) {
            try {
                const affKey = `aesCanopy:affiliations:${server}`;
                const affData = await chrome.storage.local.get([affKey]);
                if (affData && affData[affKey] && affData[affKey].byAirline) {
                    const myAff = affData[affKey].byAirline[myAirlineId];
                    if (myAff) {
                        myAllianceId = myAff.allianceId;
                        if (myAff.enterpriseId) {
                            // Find all other airlines in the same enterprise to mark as subsidiaries
                            for (const [aId, aData] of Object.entries(affData[affKey].byAirline)) {
                                if (aId !== String(myAirlineId) && aData.enterpriseId === myAff.enterpriseId) {
                                    subsidiaryIds.push(aId);
                                }
                            }
                        }
                    }
                }
            } catch(e) {
                console.warn("Failed to load affiliation data", e);
            }
        }

        let allRoutes = [];

        if (server && typeof chrome !== "undefined" && chrome.storage) {
            // Brute force fetch all keys to find relevant data
            let allStorage = {};
            if (chrome.storage.local.getKeys) {
                // If supported, only fetch what we need (though we need a lot)
                const keys = await chrome.storage.local.getKeys();
                // We want schedules, potential routes, interlining, and anything else route-like
                const relevantKeys = keys.filter(k =>
                    k.startsWith(`scheduleStore:${server}:`) ||
                    k.startsWith('routeAssistant:demand:') ||
                    k.startsWith('aesCanopy:geography')
                );

                // Chunk to avoid max limits
                for (let i = 0; i < relevantKeys.length; i += 100) {
                    const chunk = relevantKeys.slice(i, i + 100);
                    const data = await chrome.storage.local.get(chunk);
                    Object.assign(allStorage, data);
                }
            } else {
                allStorage = await chrome.storage.local.get(null);
            }

            // Build a quick airport coordinate map to make visualization possible
            // In a real implementation this would need a complete airport database
            const coordMap = {
                "JFK": {lat: 40.64, lon: -73.78},
                "LHR": {lat: 51.47, lon: -0.45},
                "CDG": {lat: 49.00, lon: 2.55},
                "SYD": {lat: -33.94, lon: 151.17},
                "DXB": {lat: 25.25, lon: 55.36},
                "FRA": {lat: 50.03, lon: 8.57},
                "NRT": {lat: 35.76, lon: 140.38},
                "LAX": {lat: 33.94, lon: -118.40},
                "ORD": {lat: 41.98, lon: -87.90},
                "ATL": {lat: 33.64, lon: -84.42},
                "SIN": {lat: 1.36, lon: 103.99},
                "HKG": {lat: 22.30, lon: 113.91},
            };

            // Hash function to deterministically generate pseudo-coordinates for airports we don't know
            // so they at least show up consistently on the map
            const pseudoCoord = (iata) => {
                if (coordMap[iata]) return coordMap[iata];

                let hash = 0;
                for (let i = 0; i < iata.length; i++) {
                    hash = ((hash << 5) - hash) + iata.charCodeAt(i);
                    hash |= 0;
                }

                // pseudo lat: -60 to 70
                // pseudo lon: -180 to 180
                const lat = ((Math.abs(hash) % 130) - 60);
                const lon = ((Math.abs(hash * 31) % 360) - 180);

                coordMap[iata] = {lat, lon};
                return {lat, lon};
            };

            // Extract actual schedules we have
            const addedPairs = new Set();

            for (const key in allStorage) {
                // 1. Own/Other Schedules
                if (key.startsWith(`scheduleStore:${server}:`)) {
                    const schedule = allStorage[key];
                    if (!schedule || !schedule.flights) continue;

                    const isOurs = key.includes(`:acct:${accountId}:`);
                    // Check if this is an alliance or subsidiary schedule if we know the airline ID
                    // This requires parsing the key or having the airline ID in the schedule object

                    schedule.flights.forEach(f => {
                        const hub = f.origin;
                        const dest = f.destination;

                        // Deduplicate same routes for visualization unless we want overlapping lines
                        const pairKey = `${hub}-${dest}-${f.flightNumber}`;
                        if (addedPairs.has(pairKey)) return;
                        addedPairs.add(pairKey);

                        const originCoord = pseudoCoord(hub);
                        const destCoord = pseudoCoord(dest);

                        allRoutes.push({
                            id: f.flightId || Math.random().toString(),
                            hub, dest,
                            hubLat: originCoord.lat,
                            hubLon: originCoord.lon,
                            destLat: destCoord.lat,
                            destLon: destCoord.lon,
                            airline: isOurs ? "My Airline" : (f.airlineCode || "Other"),
                            isOurs: isOurs,
                            isAlliance: false, // We'd need to cross reference airline ID
                            isSubsidiary: false,
                            isCompetitor: !isOurs, // Simplify for now
                            isCurrent: true,
                            isPotential: false,
                            isRealWorld: false,
                            isInterlining: false,
                            flightNumber: f.flightNumber || "N/A"
                        });
                    });
                }

                // 2. Potential / Demand routes
                if (key.startsWith('routeAssistant:demand:')) {
                    // Just extracting some as potential routes to populate the map
                    // Since there might be thousands, we sample a few for performance unless in performance mode
                    const data = allStorage[key];
                    if (data && data.origin && data.destination && Math.random() > 0.9) {
                        const hub = data.origin;
                        const dest = data.destination;

                        const pairKey = `pot-${hub}-${dest}`;
                        if (!addedPairs.has(pairKey)) {
                            addedPairs.add(pairKey);

                            const originCoord = pseudoCoord(hub);
                            const destCoord = pseudoCoord(dest);

                            allRoutes.push({
                                id: `pot-${Math.random()}`,
                                hub, dest,
                                hubLat: originCoord.lat, hubLon: originCoord.lon,
                                destLat: destCoord.lat, destLon: destCoord.lon,
                                airline: "System",
                                isOurs: false, isAlliance: false, isSubsidiary: false, isCompetitor: false,
                                isCurrent: false,
                                isPotential: true,
                                isRealWorld: false,
                                isInterlining: false,
                                flightNumber: "POTENTIAL"
                            });
                        }
                    }
                }
            }
        }

        // If we didn't find enough real data, populate with an extensive set of mock data
        // to demonstrate the filtering and "entire world" performance capabilities
        if (allRoutes.length < 50) {
            console.log("Not enough local data, seeding extensive global mock data for demonstration...");

            const majorHubs = [
                {iata: "JFK", lat: 40.64, lon: -73.78, region: "NA"},
                {iata: "LHR", lat: 51.47, lon: -0.45, region: "EU"},
                {iata: "CDG", lat: 49.00, lon: 2.55, region: "EU"},
                {iata: "FRA", lat: 50.03, lon: 8.57, region: "EU"},
                {iata: "DXB", lat: 25.25, lon: 55.36, region: "ME"},
                {iata: "SYD", lat: -33.94, lon: 151.17, region: "OC"},
                {iata: "NRT", lat: 35.76, lon: 140.38, region: "AS"},
                {iata: "HND", lat: 35.55, lon: 139.77, region: "AS"},
                {iata: "SIN", lat: 1.36, lon: 103.99, region: "AS"},
                {iata: "HKG", lat: 22.30, lon: 113.91, region: "AS"},
                {iata: "LAX", lat: 33.94, lon: -118.40, region: "NA"},
                {iata: "SFO", lat: 37.61, lon: -122.37, region: "NA"},
                {iata: "ORD", lat: 41.98, lon: -87.90, region: "NA"},
                {iata: "ATL", lat: 33.64, lon: -84.42, region: "NA"},
                {iata: "GRU", lat: -23.43, lon: -46.47, region: "SA"},
                {iata: "JNB", lat: -26.13, lon: 28.24, region: "AF"},
                {iata: "IST", lat: 41.27, lon: 28.72, region: "EU"},
                {iata: "DOH", lat: 25.27, lon: 51.60, region: "ME"}
            ];

            // 1. My Routes (Focused around 2-3 hubs)
            const myHubs = [majorHubs[0], majorHubs[1]]; // JFK, LHR

            // Add my routes
            for (let i = 0; i < majorHubs.length; i++) {
                if (i === 0 || i === 1) continue;
                allRoutes.push(createMockRoute(myHubs[0], majorHubs[i], "My Airline", "isOurs", "isCurrent", "FN" + (100+i)));

                // Add some secondary routes from the other hub
                if (Math.random() > 0.5) {
                    allRoutes.push(createMockRoute(myHubs[1], majorHubs[i], "My Airline", "isOurs", "isCurrent", "FN" + (200+i)));
                }
            }

            // 2. Alliance Routes
            const allianceHub = majorHubs[3]; // FRA
            for (let i = 0; i < majorHubs.length; i++) {
                if (majorHubs[i] === allianceHub) continue;
                if (Math.random() > 0.3) {
                    allRoutes.push(createMockRoute(allianceHub, majorHubs[i], "Alliance Air", "isAlliance", "isCurrent", "AL" + (300+i)));
                }
            }

            // 3. Subsidiary Routes
            const subHub = majorHubs[11]; // SFO
            for (let i = 0; i < 8; i++) {
                const dest = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                if (dest !== subHub) {
                    allRoutes.push(createMockRoute(subHub, dest, "My Express", "isSubsidiary", "isCurrent", "EX" + (400+i)));
                }
            }

            // 4. Competitor Routes
            const compHubs = [majorHubs[2], majorHubs[4], majorHubs[13]]; // CDG, DXB, ATL
            compHubs.forEach((hub, idx) => {
                for (let i = 0; i < majorHubs.length; i++) {
                    if (majorHubs[i] === hub) continue;
                    if (Math.random() > 0.4) {
                        allRoutes.push(createMockRoute(hub, majorHubs[i], `Competitor ${idx+1}`, "isCompetitor", "isCurrent", `C${idx}` + (500+i)));
                    }
                }
            });

            // 5. Potential Routes
            for (let i = 0; i < 40; i++) {
                const origin = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                const dest = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                if (origin !== dest) {
                    allRoutes.push(createMockRoute(origin, dest, "System", "isCompetitor", "isPotential", "POT" + i));
                }
            }

            // 6. Real World Routes (dashed)
            for (let i = 0; i < 30; i++) {
                const origin = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                const dest = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                if (origin !== dest) {
                    allRoutes.push(createMockRoute(origin, dest, "Real World", "isCompetitor", "isRealWorld", "RW" + i));
                }
            }

            // 7. Interlining Routes
            for (let i = 0; i < 15; i++) {
                const origin = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                const dest = majorHubs[Math.floor(Math.random() * majorHubs.length)];
                if (origin !== dest) {
                    allRoutes.push(createMockRoute(origin, dest, "Partner Air", "isCompetitor", "isInterlining", "IL" + i));
                }
            }
        }

        // Make sure the initial view respects the initial filter state from the board
        map.setRoutes(allRoutes);
        board.setRoutes(allRoutes);

        // Trigger a filter update right away to ensure they sync up
        board.notifyFilterChange();
    }

    function createMockRoute(hub, dest, airline, ownershipType, routeType, flightNumber) {
        const r = {
            id: Math.random().toString(),
            hub: hub.iata, dest: dest.iata,
            hubLat: hub.lat, hubLon: hub.lon,
            destLat: dest.lat, destLon: dest.lon,
            airline: airline,
            flightNumber: flightNumber,

            isOurs: false, isAlliance: false, isSubsidiary: false, isCompetitor: false,
            isCurrent: false, isPotential: false, isRealWorld: false, isInterlining: false
        };

        r[ownershipType] = true;
        r[routeType] = true;

        return r;
    }
})()
