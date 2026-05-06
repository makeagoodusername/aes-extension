"use strict"

/**
 * UI for defining Custom Regions and Expansion Plans.
 * Handles grouping airports/routes, setting goals (seats/market share),
 * and direct fleet allocation.
 */
class CanopyExpansionPlanner {
    constructor(hostEl) {
        this.hostEl = hostEl;
        this.root = null;
        this.plans = { regions: [] };
    }

    async render() {
        if (window.RegionExpansionStore) {
            this.plans = await window.RegionExpansionStore.load();
        }

        this.hostEl.innerHTML = "";

        const T = window.AESTokens;

        this.root = document.createElement("div");
        this.root.style.cssText = "padding: 20px; border-top: 2px solid " + T.color.oxide + "; margin-top: 24px;";

        const title = document.createElement("h3");
        title.textContent = "Regional Expansion Planner";
        title.style.cssText = "margin-top:0; color:" + T.color.oxide + "; font-family:" + T.font.display + ";";
        this.root.appendChild(title);

        const createBtn = document.createElement("button");
        createBtn.textContent = "+ Create New Region Plan";
        createBtn.className = "btn btn-primary";
        createBtn.style.marginBottom = "16px";
        createBtn.onclick = () => this._openCreateModal();
        this.root.appendChild(createBtn);

        this.listEl = document.createElement("div");
        this.listEl.style.cssText = "display:flex; flex-direction:column; gap: 12px;";
        this.root.appendChild(this.listEl);

        this._renderList();

        this.hostEl.appendChild(this.root);
    }

    _renderList() {
        this.listEl.innerHTML = "";

        if (this.plans.regions.length === 0) {
            this.listEl.innerHTML = "<p style='color:#666;'>No expansion plans defined.</p>";
            return;
        }

        for (const plan of this.plans.regions) {
            const card = document.createElement("div");
            card.style.cssText = "background: #fff; border: 1px solid #ddd; border-radius: 4px; padding: 16px;";

            const header = document.createElement("div");
            header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;";

            const name = document.createElement("h4");
            name.textContent = plan.name;
            name.style.margin = "0";
            header.appendChild(name);

            const delBtn = document.createElement("button");
            delBtn.textContent = "Delete";
            delBtn.className = "btn btn-xs btn-danger";
            delBtn.onclick = async () => {
                if (window.RegionExpansionStore) {
                    await window.RegionExpansionStore.removeRegion(plan.id);
                    this.plans = await window.RegionExpansionStore.load();
                    this._renderList();
                }
            };
            header.appendChild(delBtn);
            card.appendChild(header);

            const details = document.createElement("div");
            details.style.cssText = "font-size: 14px; color: #555; display:flex; flex-direction:column; gap:4px;";

            details.innerHTML = `
                <div><strong>Group:</strong> ${plan.groupType === 'custom' ? plan.customIatas : plan.groupType}</div>
                <div><strong>Goals:</strong> Target ${plan.targetSeats} Weekly Seats | Target ${plan.targetShare}% Market Share</div>
                <div><strong>Target Role:</strong> ${plan.targetRole || "ANY"}</div>
                <div><strong>Fleet Allocation:</strong> ${plan.allocatedAircraftCount}x ${plan.allocatedAircraftType}</div>
                <div style="margin-top:8px; font-weight:bold; color:#059669;">Status: Orchestrator is actively managing this region.</div>
            `;

            card.appendChild(details);

            const logsContainer = document.createElement("div");
            logsContainer.style.cssText = "margin-top: 12px; padding-top: 8px; border-top: 1px solid #eee; font-family: monospace; font-size: 12px; color: #666;";
            logsContainer.textContent = "Loading orchestrator logs...";
            card.appendChild(logsContainer);

            this._loadLogs(plan.id, logsContainer);

            this.listEl.appendChild(card);
        }
    }

    async _loadLogs(regionId, container) {
        if (!window.CanopyExpansionLogStore) return;
        const logs = await window.CanopyExpansionLogStore.getLogs(regionId);

        container.innerHTML = "";
        if (logs.length === 0) {
            container.textContent = "No orchestrator activity yet.";
            return;
        }

        const recentLogs = logs.slice(-3).reverse();
        for (const log of recentLogs) {
            const row = document.createElement("div");
            const timeStr = new Date(log.ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});

            const actionSpan = document.createElement("span");
            actionSpan.style.cssText = `font-weight: bold; margin-right: 8px; color: ${log.action === 'AUTO_APPLY' ? '#059669' : '#3b82f6'};`;
            actionSpan.textContent = `[${log.action}]`;

            const textSpan = document.createElement("span");
            textSpan.textContent = `${timeStr} - ${log.message}`;

            row.appendChild(actionSpan);
            row.appendChild(textSpan);
            container.appendChild(row);
        }
    }

    _openCreateModal() {
        const name = prompt("Enter Region Name (e.g. 'South America Expansion'):", "New Region");
        if (!name) return;

        const targetSeats = prompt("Enter Target Weekly Seats (e.g. 10000):", "10000");
        const targetShare = prompt("Enter Target Market Share % (e.g. 20):", "20");

        const targetRole = prompt("Enter Target Airline Role (e.g. regional-feeder, flag-carrier, ANY):", "ANY");
        const allocatedAircraftType = prompt("Enter Fleet Type to Allocate (e.g. A320):", "A320");
        const allocatedAircraftCount = prompt("Enter Number of Aircraft to Allocate (e.g. 5):", "5");

        const newPlan = {
            name: name,
            groupType: "custom", // simplified for scaffold
            customIatas: "BOG, LIM, SCL, GRU", // dummy data for scaffold
            targetSeats: parseInt(targetSeats, 10) || 0,
            targetShare: parseInt(targetShare, 10) || 0,
            targetRole: targetRole || "ANY",
            allocatedAircraftType: allocatedAircraftType || "None",
            allocatedAircraftCount: parseInt(allocatedAircraftCount, 10) || 0,
            createdAt: Date.now()
        };

        if (window.RegionExpansionStore) {
            window.RegionExpansionStore.addRegion(newPlan).then(async () => {
                this.plans = await window.RegionExpansionStore.load();
                this._renderList();
            });
        }
    }
}

if (typeof window !== "undefined") {
    window.CanopyExpansionPlanner = CanopyExpansionPlanner;
}
