"use strict";

/**
 * Command Bridge module: Canopy Vault
 * Displays accounts with saved credentials and provides a one-click login mechanism.
 */
class AesBridgeCanopyVault {
    constructor(opts) {
        this.host = opts.host;
        this.accounts = opts.accounts || [];
    }

    async mount() {
        if (!this.host) return;
        this._render();
    }

    _render() {
        this.host.innerHTML = "";

        const header = document.createElement("h2");
        header.className = "aes-bridge__h2";
        header.textContent = "Canopy Vault";
        this.host.appendChild(header);

        const savedAccounts = this.accounts.filter(a => a.credentials && a.credentials.username);

        if (savedAccounts.length === 0) {
            const empty = document.createElement("p");
            empty.style.cssText = "color: #9ca3af; font-size: 14px; margin-top: 8px;";
            empty.textContent = "No accounts with saved credentials yet. Log in to an account on AirlineSim to save it to the vault.";
            this.host.appendChild(empty);
            return;
        }

        const grid = document.createElement("div");
        grid.style.cssText = "display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px;";

        for (const acct of savedAccounts) {
            const card = document.createElement("div");
            card.style.cssText = "background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 12px; width: 240px; display: flex; flex-direction: column; gap: 8px;";

            const title = document.createElement("div");
            title.style.cssText = "font-weight: 600; color: #f1f5f9; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            title.textContent = acct.displayName || acct.airlineIdentity || "Unknown";
            card.appendChild(title);

            const server = document.createElement("div");
            server.style.cssText = "color: #94a3b8; font-size: 12px;";
            server.textContent = "Server: " + (acct.server || "Unknown");
            card.appendChild(server);

            const user = document.createElement("div");
            user.style.cssText = "color: #94a3b8; font-size: 12px;";
            user.textContent = "User: " + acct.credentials.username;
            card.appendChild(user);

            const loginBtn = document.createElement("button");
            loginBtn.textContent = "Log In";
            loginBtn.style.cssText = "margin-top: auto; background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;";
            loginBtn.addEventListener("mouseover", () => loginBtn.style.background = "#2563eb");
            loginBtn.addEventListener("mouseout", () => loginBtn.style.background = "#3b82f6");

            loginBtn.addEventListener("click", () => {
                const loginUrl = "https://airlinesim.aero/auth/login";

                // We send a message to the background script to temporarily store these credentials for auto-fill
                chrome.runtime.sendMessage({
                    type: "aes:vault:prepare-login",
                    username: acct.credentials.username,
                    password: acct.credentials.password
                }, () => {
                    window.open(loginUrl, "_blank");
                });
            });

            card.appendChild(loginBtn);
            grid.appendChild(card);
        }

        this.host.appendChild(grid);
    }
}

if (typeof window !== "undefined") {
    window.AesBridgeCanopyVault = AesBridgeCanopyVault;
}
