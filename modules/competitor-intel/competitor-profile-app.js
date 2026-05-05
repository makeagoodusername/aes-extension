"use strict"

;(function () {
    if (typeof window === "undefined") return
    if (window.__aesCompetitorProfileBooted) return
    window.__aesCompetitorProfileBooted = true

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, {once: true})
        } else { fn() }
    }

    ready(boot)

    async function boot() {
        console.log("Competitor Profile Booting")

        const params = new URLSearchParams(window.location.search);
        const enterpriseId = params.get('enterpriseId') || "9037"; // default to example

        let ent = {};
        if (typeof window.AesCompetitorStore !== "undefined") {
             ent = window.AesCompetitorStore.getEnterpriseData(enterpriseId) || {};
        }

        // Mock data if running isolated
        if (!ent || Object.keys(ent).length === 0) {
            ent = {
                name: "Air France",
                code: "AF",
                country: "France",
                alliance: "SkyTeam",
                rating: "AAA",
                fleet: {
                    total: 245,
                    types: [
                        { type: "A320", count: 80, avgAge: "10y 0m" },
                        { type: "B777", count: 65, avgAge: "12y 6m" },
                        { type: "A350", count: 100, avgAge: "5y 0m" }
                    ]
                },
                financials: {
                    pax: 12000000,
                    cargo: 500000,
                },
                hubs: {
                    total: 2,
                    countries: 1,
                    list: [
                        { iata: "CDG", departures: 3500 },
                        { iata: "ORY", departures: 1200 }
                    ]
                },
                stations: 156,
                employees: 45000
            };
        }

        document.getElementById("aes-cp-masthead-stats").innerHTML = `<span><strong>${escapeHtml(ent.name || 'Unknown')}</strong> (${escapeHtml(ent.code || '?')})</span>`;

        document.getElementById("aes-cp-summary").innerHTML = `
        <div class="aes-bridge__card">
            <div class="aes-bridge__card-header">
                <h2>Summary</h2>
            </div>
            <div class="aes-bridge__card-body" style="display: flex; gap: 20px; align-items: center;">
                <div>
                    <p><strong>Base Country:</strong> <span id="aes-cp-country">${escapeHtml(ent.country || 'Unknown')}</span></p>
                    <p><strong>Alliance:</strong> <span id="aes-cp-alliance">${escapeHtml(ent.alliance || 'None')}</span></p>
                    <p><strong>Rating:</strong> <span id="aes-cp-rating">${escapeHtml(ent.rating || 'N/A')}</span></p>
                </div>
            </div>
        </div>
        `;

        document.getElementById("aes-cp-aircraft").innerHTML = `
        <div class="aes-bridge__card">
            <div class="aes-bridge__card-header">
                <h2>Fleet & Operations</h2>
            </div>
            <div class="aes-bridge__card-body">
                <p><strong>Total Aircraft:</strong> <span id="aes-cp-fleet-total">${escapeHtml(String(ent.fleet?.total || 0))}</span></p>
                <p><strong>Stations:</strong> <span id="aes-cp-stations">${escapeHtml(String(ent.stations || 0))}</span></p>
                <p><strong>Employees:</strong> <span id="aes-cp-employees">${escapeHtml(String(ent.employees || 0))}</span></p>
                <hr class="aes-paper-rule" style="margin: 10px 0;">
                <table class="aes-bridge-table" style="width: 100%; text-align: left;">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Count</th>
                            <th>Avg Age</th>
                        </tr>
                    </thead>
                    <tbody id="aes-cp-fleet-body">
                    </tbody>
                </table>
            </div>
        </div>
        `;

        const fleetBody = document.getElementById('aes-cp-fleet-body');
        if (ent.fleet && ent.fleet.types) {
            ent.fleet.types.forEach(f => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${escapeHtml(f.type)}</td><td>${escapeHtml(String(f.count))}</td><td>${escapeHtml(String(f.avgAge))}</td>`;
                fleetBody.appendChild(tr);
            });
        }

        document.getElementById("aes-cp-financials").innerHTML = `
            <div class="aes-bridge__card">
            <div class="aes-bridge__card-header">
                <h2>Performance (Scraped)</h2>
            </div>
            <div class="aes-bridge__card-body">
                <p><strong>Pax Carried:</strong> <span id="aes-cp-pax">${escapeHtml(String((ent.financials?.pax || 0).toLocaleString()))}</span></p>
                <p><strong>Cargo Carried:</strong> <span id="aes-cp-cargo">${escapeHtml(String((ent.financials?.cargo || 0).toLocaleString()))}</span></p>
            </div>
        </div>
        `;

        document.getElementById("aes-cp-network").innerHTML = `
        <div class="aes-bridge__card">
            <div class="aes-bridge__card-header">
                <h2>Network & Hubs</h2>
            </div>
            <div class="aes-bridge__card-body">
                    <p><strong>Total Hubs:</strong> <span id="aes-cp-hubs-total">${escapeHtml(String(ent.hubs?.total || 0))} across ${escapeHtml(String(ent.hubs?.countries || 0))} countries</span></p>
                    <hr class="aes-paper-rule" style="margin: 10px 0;">
                    <table class="aes-bridge-table" style="width: 100%; text-align: left;">
                    <thead>
                        <tr>
                            <th>Hub</th>
                            <th>Weekly Departures</th>
                        </tr>
                    </thead>
                    <tbody id="aes-cp-hubs-body">
                    </tbody>
                </table>
            </div>
        </div>
        `;

        const hubsBody = document.getElementById('aes-cp-hubs-body');
        if (ent.hubs && ent.hubs.list) {
            ent.hubs.list.forEach(h => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${escapeHtml(h.iata)}</td><td>${escapeHtml(String(h.departures))}</td>`;
                hubsBody.appendChild(tr);
            });
        }
    }
})()
