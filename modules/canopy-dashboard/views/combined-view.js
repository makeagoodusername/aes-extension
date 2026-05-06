
"use strict"

/**
 * Combined Canopy View.
 * Renders the aggregated dashboard for all airlines.
 * Includes general health alerts and cross-airline synergy recommendations.
 */
class CanopyCombinedView {
    constructor(hostEl, accounts) {
        this.hostEl = hostEl;
        this.accounts = accounts;
        this.root = null;
        this.automationEnabled = false;
    }

    async render() {
        this.hostEl.innerHTML = "";

        const T = window.AESTokens;

        // Load automation setting
        const stored = await chrome.storage.local.get(["aesCanopy:automationEnabled"]);
        this.automationEnabled = stored["aesCanopy:automationEnabled"] === true;

        this.root = document.createElement("div");
        this.root.style.cssText = "padding: 20px;";

        const topHeader = document.createElement("div");
        topHeader.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom: 24px;";

        const title = document.createElement("h3");
        title.textContent = "Combined Canopy Overview";
        title.style.cssText = "margin:0; color:" + T.color.oxide + "; font-family:" + T.font.display + ";";
        topHeader.appendChild(title);

        const toggleWrapper = document.createElement("label");
        toggleWrapper.style.cssText = "display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:bold;";

        const toggleCheckbox = document.createElement("input");
        toggleCheckbox.type = "checkbox";
        toggleCheckbox.checked = this.automationEnabled;
        toggleCheckbox.onchange = async (e) => {
            this.automationEnabled = e.target.checked;
            await chrome.storage.local.set({ ["aesCanopy:automationEnabled"]: this.automationEnabled });
            // Optionally could trigger a refresh or event here
        };

        const toggleLabel = document.createElement("span");
        toggleLabel.textContent = "Enable Role-Based Orchestration Automations";

        toggleWrapper.appendChild(toggleCheckbox);
        toggleWrapper.appendChild(toggleLabel);
        topHeader.appendChild(toggleWrapper);

        this.root.appendChild(topHeader);

        // Grid for summary table (Financials & Operations Breakdown)
        this._renderBreakdownTable();

        // Recommendations Section
        const recSection = document.createElement("div");
        const recTitle = document.createElement("h3");
        recTitle.textContent = "Canopy Recommendations & Synergies";
        recTitle.style.cssText = "border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 16px; margin-top: 24px;";
        recSection.appendChild(recTitle);

        this.recTableContainer = document.createElement("div");
        recSection.appendChild(this.recTableContainer);

        this.root.appendChild(recSection);

        // Planner Section
        const plannerContainer = document.createElement("div");
        this.root.appendChild(plannerContainer);

        if (window.CanopyExpansionPlanner) {
            this.planner = new window.CanopyExpansionPlanner(plannerContainer);
            await this.planner.render();
        }

        this.hostEl.appendChild(this.root);

        // Simulate async data loading
        setTimeout(() => {
            this._generateRecommendations();
        }, 800);
    }

    _renderBreakdownTable() {
        const table = document.createElement("table");
        table.className = "table table-striped table-hover";
        table.style.cssText = "width:100%; border:1px solid #ddd; background:#fff; margin-bottom:24px;";

        const thead = document.createElement("thead");
        thead.innerHTML = `
            <tr style="background:#f5f5f5;">
                <th style="padding:12px; text-align:left; border-bottom:2px solid #ccc;">Entity</th>
                <th style="padding:12px; text-align:right; border-bottom:2px solid #ccc;">Cash Reserves</th>
                <th style="padding:12px; text-align:right; border-bottom:2px solid #ccc;">Active Planes</th>
                <th style="padding:12px; text-align:right; border-bottom:2px solid #ccc;">Avg Load Factor</th>
                <th style="padding:12px; text-align:right; border-bottom:2px solid #ccc;">Routes</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement("tbody");

        // --- Simulate Combined Totals ---
        const totalCash = this.accounts.length * 50000000; // Simulated
        const totalPlanes = this.accounts.length * 14;      // Simulated
        const avgLoad = 82; // Simulated %
        const totalRoutes = this.accounts.length * 38;      // Simulated

        const totalRow = document.createElement("tr");
        totalRow.style.cssText = "font-weight:bold; background:#e0f2fe; border-bottom:2px solid #bae6fd;";
        totalRow.innerHTML = `
            <td style="padding:12px;">Combined Canopy Totals</td>
            <td style="padding:12px; text-align:right;">AS$ ${totalCash.toLocaleString()}</td>
            <td style="padding:12px; text-align:right;">${totalPlanes}</td>
            <td style="padding:12px; text-align:right;">${avgLoad}%</td>
            <td style="padding:12px; text-align:right;">${totalRoutes}</td>
        `;
        tbody.appendChild(totalRow);

        // --- Simulated Breakdown for each account ---
        for (const acct of this.accounts) {
            const row = document.createElement("tr");

            // Randomish but consistent simulation based on airline identity length
            const cSeed = acct.airlineIdentity ? acct.airlineIdentity.length : 5;
            const cash = 20000000 + (cSeed * 1000000);
            const planes = 10 + cSeed;
            const load = 75 + (cSeed % 15);
            const routes = 20 + (cSeed * 3);

            row.innerHTML = `
                <td style="padding:12px;">${acct.displayName || acct.airlineIdentity || 'Unknown Airline'}</td>
                <td style="padding:12px; text-align:right;">AS$ ${cash.toLocaleString()}</td>
                <td style="padding:12px; text-align:right;">${planes}</td>
                <td style="padding:12px; text-align:right;">${load}%</td>
                <td style="padding:12px; text-align:right;">${routes}</td>
            `;
            tbody.appendChild(row);
        }

        if (this.accounts.length === 0) {
            const emptyRow = document.createElement("tr");
            emptyRow.innerHTML = `<td colspan="5" style="padding:12px; text-align:center; color:#666;">No accounts found in registry.</td>`;
            tbody.appendChild(emptyRow);
        }

        table.appendChild(tbody);
        this.root.appendChild(table);
    }

    _generateRecommendations() {
        this.recTableContainer.innerHTML = "";

        const recs = [
            { type: "synergy", description: "Cross-Airline Synergy: Interlining suggested between Airline A and Airline B at Hub FRA to boost regional expansion.", priority: "High" },
            { type: "health", description: "Cash Alert: Airline C cash runway is below 2 weeks. Consider pausing expansion.", priority: "High" },
            { type: "health", description: "Profit Decay: Route JFK-LAX across canopy showing 12% profit drop this week.", priority: "Medium" },
            { type: "expansion", description: "Regional Goal: Europe expansion target (10,000 seats) is 85% complete. 2 narrowbodies needed.", priority: "Medium" }
        ];

        const table = document.createElement("table");
        table.className = "table table-hover";
        table.style.cssText = "width:100%; border:1px solid #eee; background:#fff;";

        const thead = document.createElement("thead");
        thead.innerHTML = `
            <tr>
                <th style="padding:10px; width:15%;">Priority</th>
                <th style="padding:10px; width:70%;">Suggestion</th>
                <th style="padding:10px; width:15%; text-align:right;">Action</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement("tbody");

        for (const rec of recs) {
            const row = document.createElement("tr");

            const isHigh = rec.priority === "High";
            const badgeColor = isHigh ? "#ef4444" : "#f59e0b";

            row.innerHTML = `
                <td style="padding:10px;">
                    <span style="background:${badgeColor}; color:#fff; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:bold;">${rec.priority}</span>
                </td>
                <td style="padding:10px;">${rec.description}</td>
                <td style="padding:10px; text-align:right;">
                    <button class="btn btn-xs btn-primary apply-btn">Review</button>
                </td>
            `;

            // Add interaction
            const applyBtn = row.querySelector(".apply-btn");
            applyBtn.onclick = () => {
                alert(`Interacting with system for suggestion:\n${rec.description}`);
                applyBtn.textContent = "Reviewed";
                applyBtn.classList.replace("btn-primary", "btn-default");
                applyBtn.disabled = true;
            };

            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        this.recTableContainer.appendChild(table);
    }
}

if (typeof window !== "undefined") {
    window.CanopyCombinedView = CanopyCombinedView;
}
