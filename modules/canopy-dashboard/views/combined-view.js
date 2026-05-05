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
    }

    async render() {
        this.hostEl.innerHTML = "";

        const T = window.AESTokens;

        this.root = document.createElement("div");
        this.root.style.cssText = "padding: 20px;";

        const title = document.createElement("h3");
        title.textContent = "Combined Canopy Overview";
        title.style.cssText = "margin-top:0; color:" + T.color.oxide + "; font-family:" + T.font.display + ";";
        this.root.appendChild(title);

        // Grid for summary cards
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px;";

        const financialsCard = this._buildSummaryCard("Financial Health", "Aggregating...");
        const fleetCard = this._buildSummaryCard("Fleet Status", "Aggregating...");
        const networkCard = this._buildSummaryCard("Network Reach", "Aggregating...");

        grid.appendChild(financialsCard.el);
        grid.appendChild(fleetCard.el);
        grid.appendChild(networkCard.el);

        this.root.appendChild(grid);

        // Recommendations Section
        const recSection = document.createElement("div");
        const recTitle = document.createElement("h3");
        recTitle.textContent = "Canopy Recommendations & Synergies";
        recTitle.style.cssText = "border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 16px;";
        recSection.appendChild(recTitle);

        this.recList = document.createElement("div");
        this.recList.style.cssText = "display:flex; flex-direction:column; gap: 8px;";
        recSection.appendChild(this.recList);

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
            financialsCard.update("Stable — Cash positive across 3 accounts.");
            fleetCard.update("42 Active Aircraft — 2 idle.");
            networkCard.update("114 Routes — Strong presence in Europe.");
            this._generateRecommendations();
        }, 800);
    }

    _buildSummaryCard(title, initialValue) {
        const el = document.createElement("div");
        el.style.cssText = "background: #fff; border: 1px solid #ddd; border-radius: 4px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);";

        const titleEl = document.createElement("h4");
        titleEl.textContent = title;
        titleEl.style.cssText = "margin: 0 0 8px 0; font-size: 14px; color: #666; text-transform: uppercase;";

        const valEl = document.createElement("div");
        valEl.textContent = initialValue;
        valEl.style.cssText = "font-size: 16px; font-weight: bold; color: #333;";

        el.appendChild(titleEl);
        el.appendChild(valEl);

        return { el, update: (val) => valEl.textContent = val };
    }

    _generateRecommendations() {
        this.recList.innerHTML = "";

        const recs = [
            { type: "synergy", text: "Cross-Airline Synergy: Interlining suggested between Airline A and Airline B at Hub FRA to boost regional expansion.", priority: "high" },
            { type: "health", text: "Cash Alert: Airline C cash runway is below 2 weeks. Consider pausing expansion.", priority: "high" },
            { type: "health", text: "Profit Decay: Route JFK-LAX across canopy showing 12% profit drop this week.", priority: "medium" },
            { type: "expansion", text: "Regional Goal: Europe expansion target (10,000 seats) is 85% complete. 2 narrowbodies needed.", priority: "medium" }
        ];

        for (const rec of recs) {
            const item = document.createElement("div");
            const isHigh = rec.priority === "high";
            item.style.cssText = `padding: 12px; border-left: 4px solid ${isHigh ? "#ef4444" : "#f59e0b"}; background: #f9fafb; border-radius: 0 4px 4px 0;`;
            item.textContent = rec.text;
            this.recList.appendChild(item);
        }
    }
}

if (typeof window !== "undefined") {
    window.CanopyCombinedView = CanopyCombinedView;
}
