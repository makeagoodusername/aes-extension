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

        setTimeout(async () => {
            // Fetch real financial data
            const finData = await this._getFinancialData();

            let finHtml = `<div style="display:flex; flex-direction:column; gap:8px;">`;
            finHtml += `<div style="font-size: 20px; font-weight: bold; color: #059669;">Total Reserve: ${this._formatCurrency(finData.totalCash)}</div>`;

            if (finData.items.length > 0) {
                finHtml += `<div style="display:flex; height:12px; width:100%; border-radius:6px; overflow:hidden; margin-top:4px;">`;
                const colors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#6b7280"];

                finData.items.forEach((item, i) => {
                    const pct = finData.totalCash > 0 ? Math.max(1, (item.cash / finData.totalCash) * 100) : (100 / finData.items.length);
                    finHtml += `<div style="width:${pct}%; background:${colors[i % colors.length]}; border-right:${i < finData.items.length - 1 ? '1px solid #fff' : 'none'};" title="${item.name}: ${this._formatCurrency(item.cash)}"></div>`;
                });
                finHtml += `</div>`;

                finHtml += `<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; font-size:12px; color:#555;">`;
                finData.items.forEach((item, i) => {
                    finHtml += `<div style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${colors[i % colors.length]};"></span> ${item.name} (${this._formatCurrency(item.cash)})</div>`;
                });
                finHtml += `</div>`;
            }
            finHtml += `</div>`;

            financialsCard.updateHtml(finHtml);

            fleetCard.update("Aggregation pending cross-account fetch.");
            networkCard.update("Aggregation pending cross-account fetch.");
            await this._generateRecommendations();
        }, 100);

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

        return { el, update: (val) => valEl.textContent = val, updateHtml: (html) => valEl.innerHTML = html };
    }


    async _getFinancialData() {
        if (!this.accounts || this.accounts.length === 0) return { totalCash: 0, items: [] };

        const accountsWithCash = [];
        let totalCash = 0;

        for (const acct of this.accounts) {
            const indexKey = acct.server + acct.airlineIdentity + "accounting:index";
            const blob = await new Promise(r => chrome.storage.local.get(indexKey, r));
            const index = Array.isArray(blob[indexKey]) ? blob[indexKey] : [];
            if (!index.length) {
                accountsWithCash.push({ name: acct.displayName, cash: 0 });
                continue;
            }
            const newest = index[0];
            const week = newest.weekId || newest.weekClosesAt || "";
            const bankKey = acct.server + acct.airlineIdentity + "accounting:bank:" + week;
            const bankBlob = await new Promise(r => chrome.storage.local.get(bankKey, r));
            const bankRec = bankBlob[bankKey];
            const bank = bankRec && bankRec.payload;
            const cash = bank && Number.isFinite(bank.cashBalance) ? bank.cashBalance : 0;

            totalCash += cash;
            accountsWithCash.push({ name: acct.displayName, cash: cash, server: acct.server });
        }

        // Sort by cash descending
        accountsWithCash.sort((a, b) => b.cash - a.cash);

        return { totalCash, items: accountsWithCash };
    }

    _formatCurrency(val) {
        // Basic fallback
        return Math.floor(val).toLocaleString() + " AS$";
    }

    async _generateRecommendations() {
        this.recList.innerHTML = "";
        const recs = [];

        // Try to fetch active routines from AesConductorRoutineStore if available
        if (window.AesConductorRoutineStore) {
            for (const acct of this.accounts) {
                const host = { server: acct.server, airline: acct.airlineIdentity };
                const activeRoutines = await window.AesConductorRoutineStore.active(host);

                for (const r of activeRoutines) {
                    if (r.state === "proposing") {
                        const lastEntry = r.history && r.history.length > 0 ? r.history[r.history.length - 1] : null;
                        const reason = lastEntry ? lastEntry.reason : "Action recommended";

                        recs.push({
                            type: "routine",
                            text: `[${acct.displayName}] ${r.label || r.routineDefId} on ${r.target}: ${reason}`,
                            priority: "medium"
                        });
                    }
                }
            }
        }

        // Fallback or static recommendations
        if (recs.length === 0) {
            recs.push({ type: "synergy", text: "Cross-Airline Synergy: Interlining suggested between Airline A and Airline B at Hub FRA to boost regional expansion.", priority: "high" });
            recs.push({ type: "expansion", text: "Regional Goal: Europe expansion target (10,000 seats) is 85% complete. 2 narrowbodies needed.", priority: "medium" });
        }

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
