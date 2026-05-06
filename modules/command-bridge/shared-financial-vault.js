"use strict";

/**
 * Command Bridge module: Shared Financial Vault
 *
 * Displays a monolithic combined financial overview of all canopy accounts
 * (Session Sync v1). Shows Combined | Enterprise A | Enterprise B | ...
 */
class AesBridgeSharedFinancialVault {
    constructor(opts) {
        this.host = opts.host;
        this.accounts = opts.accounts || [];
        // Optional refresh callback from host.
        this.onRefresh = opts.onRefresh || (() => this.mount());
    }

    async mount() {
        if (!this.host) return;
        await this._fetchData();
        this._render();
    }

    async _fetchData() {
        // Collect financial data for each account using AccountingSnapshotStore
        this.financials = [];
        this.combined = {
            displayName: "Combined",
            cashBalance: 0,
            revenue: 0,
            ebitda: 0,
            ebit: 0,
            paxTransported: 0, // Mock, needs extraction
            cargoTransported: 0 // Mock, needs extraction
        };

        for (const acct of this.accounts) {
            const data = {
                acct: acct,
                displayName: acct.displayName || acct.airlineIdentity || "Unknown",
                hasData: false,
                expired: false,
                cashBalance: 0,
                revenue: 0,
                ebitda: 0,
                ebit: 0,
                paxTransported: 0,
                cargoTransported: 0,
                lastSeen: acct.lastSeenAt || 0
            };

            try {
                const latestPeriod = await window.AccountingSnapshotStore.loadLatest(acct.server, acct.airlineIdentity);

                if (latestPeriod) {
                    data.hasData = true;

                    // If older than 7 days, consider expired
                    if (Date.now() - data.lastSeen > 7 * 24 * 60 * 60 * 1000) {
                         data.expired = true;
                    }

                    if (latestPeriod.bank && latestPeriod.bank.payload) {
                        data.cashBalance = Number(latestPeriod.bank.payload.cashBalance) || 0;
                    }

                    if (latestPeriod.income && latestPeriod.income.payload && latestPeriod.income.payload.totals) {
                        const totals = latestPeriod.income.payload.totals;
                        data.revenue = totals.revenue && totals.revenue.current ? Number(totals.revenue.current) : 0;
                        data.ebitda = totals.ebitda && totals.ebitda.current ? Number(totals.ebitda.current) : 0;
                        data.ebit = totals.ebit && totals.ebit.current ? Number(totals.ebit.current) : 0;
                    }

                    // Sum into combined (even if expired, or we could conditionally exclude)
                    this.combined.cashBalance += data.cashBalance;
                    this.combined.revenue += data.revenue;
                    this.combined.ebitda += data.ebitda;
                    this.combined.ebit += data.ebit;
                }
            } catch (err) {
                console.error("Failed to load financials for account", acct.id, err);
            }

            this.financials.push(data);
        }
    }

    _formatCurrency(val) {
        if (typeof val !== "number") return "—";
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val).replace("$", "") + " AS$";
    }

    _render() {
        this.host.innerHTML = "";

        const header = document.createElement("div");
        header.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;";

        const title = document.createElement("h2");
        title.className = "aes-bridge__h2";
        title.textContent = "Shared Financial Vault";
        title.style.margin = "0";

        const refreshBtn = document.createElement("button");
        refreshBtn.textContent = "Refresh";
        refreshBtn.style.cssText = "background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;";
        refreshBtn.addEventListener("mouseover", () => refreshBtn.style.background = "#2563eb");
        refreshBtn.addEventListener("mouseout", () => refreshBtn.style.background = "#3b82f6");
        refreshBtn.addEventListener("click", () => this.onRefresh());

        header.appendChild(title);
        header.appendChild(refreshBtn);
        this.host.appendChild(header);

        if (this.accounts.length === 0) {
            const empty = document.createElement("p");
            empty.style.cssText = "color: #9ca3af; font-size: 14px; margin-top: 8px;";
            empty.textContent = "No accounts registered. Visit your enterprises to start tracking.";
            this.host.appendChild(empty);
            return;
        }

        const tableContainer = document.createElement("div");
        tableContainer.style.cssText = "overflow-x: auto; background: var(--aes-bone-2); border: var(--aes-bw-2) solid var(--aes-oxide); border-radius: var(--aes-radius);";

        const table = document.createElement("table");
        table.style.cssText = "width: 100%; border-collapse: collapse; text-align: right; color: var(--aes-oxide); font-family: var(--aes-font-mono); font-size: var(--aes-fs-micro);";

        // Header Row
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        headerRow.style.borderBottom = "var(--aes-bw-2) solid var(--aes-oxide)";

        const thMetric = document.createElement("th");
        thMetric.textContent = "Metric";
        thMetric.style.cssText = "padding: var(--aes-sp-2); text-align: left; font-weight: bold; color: var(--aes-oxide-2); min-width: 150px; font-family: var(--aes-font-display); font-size: var(--aes-fs-small); letter-spacing: var(--aes-tracking-caps); text-transform: uppercase;";
        headerRow.appendChild(thMetric);

        // Combined column
        const thCombined = document.createElement("th");
        thCombined.textContent = "Combined";
        thCombined.style.cssText = "padding: var(--aes-sp-2); font-weight: bold; color: var(--aes-rust-deep); border-right: var(--aes-bw-2) dashed var(--aes-paper-rule); font-family: var(--aes-font-display); font-size: var(--aes-fs-small); letter-spacing: var(--aes-tracking-caps); text-transform: uppercase;";
        headerRow.appendChild(thCombined);

        // Enterprise columns
        for (const f of this.financials) {
            const th = document.createElement("th");
            th.textContent = f.displayName;
            th.style.cssText = "padding: var(--aes-sp-2); font-weight: bold; color: var(--aes-oxide); min-width: 120px; font-family: var(--aes-font-display); font-size: var(--aes-fs-small); letter-spacing: var(--aes-tracking-caps); text-transform: uppercase;";
            if (f.expired) {
                const exp = document.createElement("span");
                exp.textContent = " (Stale)";
                exp.style.cssText = "color: var(--aes-crimson); font-size: var(--aes-fs-micro);";
                th.appendChild(exp);
            }
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body Rows
        const tbody = document.createElement("tbody");

        const rowsData = [
            { label: "Cash Balance", key: "cashBalance", isCurrency: true },
            { label: "Revenue", key: "revenue", isCurrency: true },
            { label: "EBITDA", key: "ebitda", isCurrency: true },
            { label: "EBIT", key: "ebit", isCurrency: true }
        ];

        for (const rowSpec of rowsData) {
            const tr = document.createElement("tr");
            tr.style.borderBottom = "var(--aes-bw-1) solid var(--aes-paper-rule)";

            const tdLabel = document.createElement("td");
            tdLabel.textContent = rowSpec.label;
            tdLabel.style.cssText = "padding: var(--aes-sp-2); text-align: left; color: var(--aes-oxide-2); font-family: var(--aes-font-display); font-size: var(--aes-fs-body);";
            tr.appendChild(tdLabel);

            const tdCombined = document.createElement("td");
            tdCombined.textContent = rowSpec.isCurrency ? this._formatCurrency(this.combined[rowSpec.key]) : this.combined[rowSpec.key];
            tdCombined.style.cssText = "padding: var(--aes-sp-2); color: var(--aes-rust-deep); font-weight: bold; border-right: var(--aes-bw-2) dashed var(--aes-paper-rule);";
            tr.appendChild(tdCombined);

            for (const f of this.financials) {
                const td = document.createElement("td");
                if (!f.hasData) {
                    td.textContent = "—";
                    td.style.cssText = "padding: var(--aes-sp-2); color: var(--aes-slate); opacity: 0.6;";
                } else {
                    const val = f[rowSpec.key];
                    td.textContent = rowSpec.isCurrency ? this._formatCurrency(val) : val;
                    td.style.cssText = "padding: var(--aes-sp-2); color: var(--aes-oxide);";

                    if (rowSpec.isCurrency && val < 0) {
                        td.style.color = "var(--aes-crimson)";
                    }
                }
                tr.appendChild(td);
            }

            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        tableContainer.appendChild(table);
        this.host.appendChild(tableContainer);
    }
}

if (typeof window !== "undefined") {
    window.AesBridgeSharedFinancialVault = AesBridgeSharedFinancialVault;
}
