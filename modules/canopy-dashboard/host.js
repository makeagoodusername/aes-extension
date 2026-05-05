"use strict"

/**
 * Canopy Dashboard host. Mounts on /app/enterprise/dashboard*.
 *
 * This provides the unified UI for the canopy, containing context switching
 * (arrows, tabs) and the "Combined" view across all your airlines.
 */
class CanopyDashboardHost {
    constructor(anchorEl) {
        this.anchorEl = anchorEl;
        this.root = null;
        this.accounts = [];
        this.currentAccountIdx = -1; // -1 means "Combined" view
        this.shell = null;
    }

    async mount() {
        if (this.root) return;

        // Fetch accounts from L1 registry
        if (window.AesAccountRegistry) {
            this.accounts = await window.AesAccountRegistry.list();
        }

        // Find current account if possible
        if (window.__aesAccountId) {
            const idx = this.accounts.findIndex(a => a.id === window.__aesAccountId);
            if (idx !== -1) {
                this.currentAccountIdx = idx;
            }
        }

        const T = window.AESTokens;

        this.root = document.createElement("div");
        this.root.className = "aes-canopy-dashboard";
        this.root.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "margin:" + T.sp[3] + " 0",
            "font-family:" + T.font.display,
            "min-height:480px",
            "box-sizing:border-box"
        ].join(";");

        this.root.appendChild(this._buildTopBar());

        this.dashboardContainer = document.createElement("div");
        this.dashboardContainer.style.flex = "1";
        this.root.appendChild(this.dashboardContainer);

        this.anchorEl.before(this.root);

        await this._renderCurrentView();
        if (window.CanopyExpansionOrchestrator) window.CanopyExpansionOrchestrator.start();
    }

    _buildTopBar() {
        const T = window.AESTokens;
        const bar = document.createElement("div");
        bar.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:" + T.sp[3],
            "padding:" + T.sp[3] + " " + T.sp[4],
            "background:" + T.color.bone2,
            "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide,
            "box-sizing:border-box",
            "flex-wrap:wrap"
        ].join(";");

        const title = document.createElement("h2");
        title.textContent = "AES Canopy Dashboard";
        title.style.cssText = [
            "margin:0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.h3,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.oxide,
            "flex:0 0 auto"
        ].join(";");
        bar.appendChild(title);

        const controls = document.createElement("div");
        controls.style.cssText = "display:flex;align-items:center;gap:8px;margin-left:auto;";

        const prevBtn = document.createElement("button");
        prevBtn.textContent = "◀";
        prevBtn.className = "btn btn-default btn-xs";
        prevBtn.onclick = () => this._switchContext(-1);

        this.contextLabel = document.createElement("span");
        this.contextLabel.style.cssText = "font-weight:bold;min-width:150px;text-align:center;";
        this._updateContextLabel();

        const nextBtn = document.createElement("button");
        nextBtn.textContent = "▶";
        nextBtn.className = "btn btn-default btn-xs";
        nextBtn.onclick = () => this._switchContext(1);

        controls.appendChild(prevBtn);
        controls.appendChild(this.contextLabel);
        controls.appendChild(nextBtn);

        bar.appendChild(controls);
        return bar;
    }

    _updateContextLabel() {
        if (!this.contextLabel) return;
        if (this.currentAccountIdx === -1) {
            this.contextLabel.textContent = "Combined Canopy";
        } else {
            const acct = this.accounts[this.currentAccountIdx];
            this.contextLabel.textContent = acct ? `${acct.displayName} (${acct.server})` : "Unknown";
        }
    }

    async _switchContext(dir) {
        this.currentAccountIdx += dir;
        // Wrap around: -1 is Combined, 0 to N-1 are accounts
        if (this.currentAccountIdx > this.accounts.length - 1) {
            this.currentAccountIdx = -1;
        } else if (this.currentAccountIdx < -1) {
            this.currentAccountIdx = this.accounts.length - 1;
        }

        this._updateContextLabel();
        await this._renderCurrentView();
        if (window.CanopyExpansionOrchestrator) window.CanopyExpansionOrchestrator.start();
    }

    async _renderCurrentView() {
        this.dashboardContainer.innerHTML = "";

        if (this.currentAccountIdx === -1) {
            // Render Combined View
            if (window.CanopyCombinedView) {
                const combinedView = new window.CanopyCombinedView(this.dashboardContainer, this.accounts);
                await combinedView.render();
            } else {
                this.dashboardContainer.innerHTML = "<div style='padding:20px;text-align:center;color:#666;'>Combined View (Not Loaded)</div>";
            }
        } else {
            // Render specific account dashboard
            const acct = this.accounts[this.currentAccountIdx];
            if (window.CentralHubShell) {
                this.shell = new window.CentralHubShell({
                    server: acct.server,
                    airline: acct.airlineIdentity
                });
                await this.shell.mount(this.dashboardContainer);

                // Hack to make it fit inside
                if (this.shell.root) {
                    this.shell.root.style.margin = "0";
                    this.shell.root.style.border = "none";
                    this.shell.root.style.minHeight = "400px";
                }
            }
        }
    }
}

if (typeof window !== "undefined") {
    window.CanopyDashboardHost = CanopyDashboardHost;
}
