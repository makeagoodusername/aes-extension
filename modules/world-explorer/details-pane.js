"use strict"

class WorldExplorerDetailsPane {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = null;
        this.route = null;
        this.station = null;
    }

    init() {
        this.container = document.getElementById(this.containerId);
        if (!this.container) return;
        this.render();
    }

    setRoute(route) {
        this.route = route;
        this.station = null;
        this.render();
    }

    setStation(station) {
        this.station = station;
        this.route = null;
        this.render();
    }

    clear() {
        this.route = null;
        this.station = null;
        this.render();
    }

    render() {
        if (!this.container) return;

        if (!this.route && !this.station) {
            this.container.innerHTML = `
                <div class="aes-bridge__card" style="height: 100%;">
                    <div class="aes-bridge__card-header">
                        <h2>Details</h2>
                    </div>
                    <div class="aes-bridge__card-body" style="padding: 20px; color: #64748b; text-align: center;">
                        Select a route or station on the map to view details.
                    </div>
                </div>
            `;
            return;
        }

        let content = '';

        if (this.route) {
            const reputation = Math.floor(Math.random() * 40) + 60; // Mock ORS
            const planeModel = this.route.isOurs ? "A320-200" : "737-800"; // Mock plane

            content = `
                <div style="margin-bottom: 20px;">
                    <h3 style="margin-top: 0; color: #334155; font-size: 1.5em;">Flight ${escapeHtml(this.route.flightNumber)}</h3>
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                        <span style="background: ${this.route.isOurs ? '#f59e0b' : '#3b82f6'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold;">
                            ${escapeHtml(this.route.airline)}
                        </span>
                        <span style="color: #64748b; font-size: 0.9em;">
                            ${this.route.isOurs ? 'Kin' : 'Competitor'}
                        </span>
                    </div>

                    <div style="display: flex; justify-content: space-between; background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 15px;">
                        <div style="text-align: center;">
                            <div style="font-size: 2em; font-weight: bold; color: #1e293b;">${escapeHtml(this.route.hub)}</div>
                            <div style="font-size: 0.8em; color: #64748b;">Origin</div>
                        </div>
                        <div style="display: flex; align-items: center; color: #94a3b8;">
                            &rarr;
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 2em; font-weight: bold; color: #1e293b;">${escapeHtml(this.route.dest)}</div>
                            <div style="font-size: 0.8em; color: #64748b;">Destination</div>
                        </div>
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                        <tbody>
                            <tr style="border-bottom: 1px solid #e2e8f0;">
                                <td style="padding: 8px 0; color: #64748b;">Aircraft</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #334155;">${planeModel}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #e2e8f0;">
                                <td style="padding: 8px 0; color: #64748b;">ORS Reputation</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #10b981;">${reputation}</td>
                            </tr>
                        </tbody>
                    </table>

                    <div style="display: flex; gap: 10px;">
                        <button class="aes-btn" style="flex: 1;" onclick="window.open('https://airlinesim.aero/app/info/station/${this.route.hub}', '_blank')">Open ${escapeHtml(this.route.hub)} Station</button>
                        <button class="aes-btn" style="flex: 1;" onclick="window.open('https://airlinesim.aero/app/info/station/${this.route.dest}', '_blank')">Open ${escapeHtml(this.route.dest)} Station</button>
                    </div>
                </div>
            `;
        } else if (this.station) {
            content = `
                <div style="margin-bottom: 20px;">
                    <h3 style="margin-top: 0; color: #334155; font-size: 1.5em;">Station ${escapeHtml(this.station.code)}</h3>
                    <button class="aes-btn" style="width: 100%; margin-bottom: 15px;" onclick="window.open('https://airlinesim.aero/app/info/station/${this.station.code}', '_blank')">Open Station in AS</button>
                </div>
            `;
        }

        this.container.innerHTML = `
            <div class="aes-bridge__card" style="height: 100%;">
                <div class="aes-bridge__card-header">
                    <h2>Details</h2>
                </div>
                <div class="aes-bridge__card-body" style="padding: 20px;">
                    ${content}
                </div>
            </div>
        `;
    }
}

if (typeof window !== "undefined") {
    window.WorldExplorerDetailsPane = WorldExplorerDetailsPane;
}
