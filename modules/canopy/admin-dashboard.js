"use strict"

/**
 * Canopy Admin Dashboard
 *
 * A top-level monolithic overview of the conglomerate's financial health,
 * combining liquid cash reserves across all linked accounts on the current
 * server. It calculates a single aggregate sum at the top, followed by a
 * breakdown of contributions of the "total - 1" accounts (excluding the
 * currently active account to illustrate the outside liquidity).
 *
 * Public API:
 *   AesCanopyAdminDashboard.open()
 *   AesCanopyAdminDashboard.close()
 */
;(function () {
    if (window.AesCanopyAdminDashboard) return

    let _modal = null

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    function _fmtCurrency(value) {
        if (value == null || !Number.isFinite(value)) return "—"
        return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).replace("$", "AS$ ")
    }

    async function _loadFinancials() {
        if (!window.AesAccountRegistry || !window.chrome || !chrome.storage || !chrome.storage.local) {
            return { active: null, others: [], total: 0 }
        }

        try {
            const registry = await window.AesAccountRegistry.get()
            const activeServer = typeof AES !== "undefined" && AES.getServer ? AES.getServer() : null
            const activeAirline = typeof AES !== "undefined" && AES.getAirlineIdentity ? AES.getAirlineIdentity() : null

            if (!activeServer) return { active: null, others: [], total: 0 }

            const accountsOnServer = Object.values(registry).filter(a => a.server === activeServer)

            const activeAcc = accountsOnServer.find(a => a.airline === activeAirline) || null
            const otherAccs = accountsOnServer.filter(a => a.airline !== activeAirline)

            let totalReserve = 0
            const othersFinancials = []
            let activeReserve = 0

            // Fetch keys for index
            const indexKeysToFetch = accountsOnServer.map(a => a.server + a.airline + "accounting:index")
            const indices = await chrome.storage.local.get(indexKeysToFetch)

            const bankKeysToFetch = []
            const accountToLatestBankKey = {}

            for (const acc of accountsOnServer) {
                const idxKey = acc.server + acc.airline + "accounting:index"
                const idx = indices[idxKey]
                if (Array.isArray(idx) && idx.length > 0) {
                    const latestWeek = idx[0].weekId || idx[0].weekClosesAt
                    if (latestWeek) {
                        const bankKey = acc.server + acc.airline + "accounting:bank:" + latestWeek
                        bankKeysToFetch.push(bankKey)
                        accountToLatestBankKey[acc.airline] = bankKey
                    }
                }
            }

            let banks = {}
            if (bankKeysToFetch.length > 0) {
                banks = await chrome.storage.local.get(bankKeysToFetch)
            }

            for (const acc of accountsOnServer) {
                let reserve = 0
                const bankKey = accountToLatestBankKey[acc.airline]
                if (bankKey && banks[bankKey] && banks[bankKey].payload && Number.isFinite(banks[bankKey].payload.cashBalance)) {
                    reserve = Number(banks[bankKey].payload.cashBalance)
                }

                totalReserve += reserve

                if (acc.airline === activeAirline) {
                    activeReserve = reserve
                } else {
                    othersFinancials.push({
                        airline: acc.airline,
                        company: acc.company,
                        reserve: reserve
                    })
                }
            }

            // Sort others by reserve descending
            othersFinancials.sort((a, b) => b.reserve - a.reserve)

            return { active: activeAcc, activeReserve, others: othersFinancials, total: totalReserve }
        } catch (err) {
            console.warn("[AES CanopyAdminDashboard] Failed to load financials", err)
            return { active: null, others: [], total: 0 }
        }
    }

    async function _render() {
        if (!_modal) return

        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "position:fixed", "top:0", "left:0", "right:0", "bottom:0",
            "background:rgba(0,0,0,0.8)", "z-index:99999",
            "display:flex", "align-items:center", "justify-content:center",
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
        ].join(";")

        const box = document.createElement("div")
        box.style.cssText = [
            "background:var(--aes-bone, #f6f5f0)",
            "width:700px", "max-width:90vw", "max-height:90vh",
            "border:3px solid var(--aes-oxide, #2a2a2a)",
            "box-shadow:8px 8px 0 var(--aes-oxide, #2a2a2a)",
            "display:flex", "flex-direction:column",
            "overflow:hidden"
        ].join(";")

        const header = document.createElement("div")
        header.style.cssText = [
            "background:var(--aes-oxide, #2a2a2a)",
            "color:var(--aes-bone, #f6f5f0)",
            "padding:16px 24px",
            "display:flex", "justify-content:space-between", "align-items:center"
        ].join(";")

        const title = document.createElement("div")
        title.innerHTML = "<span style='font-weight:900;letter-spacing:0.05em;font-size:16px;'>CANOPY</span> <span style='opacity:0.7;font-weight:500;margin-left:8px;'>Admin Dashboard</span>"

        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.innerHTML = "&times;"
        closeBtn.style.cssText = [
            "background:none", "border:none", "color:var(--aes-bone, #f6f5f0)",
            "font-size:24px", "line-height:1", "cursor:pointer", "padding:0", "margin:0"
        ].join(";")
        closeBtn.onclick = close

        header.appendChild(title)
        header.appendChild(closeBtn)

        const body = document.createElement("div")
        body.style.cssText = "padding:24px;overflow-y:auto;flex:1;color:var(--aes-oxide, #2a2a2a);"
        body.innerHTML = "<div style='text-align:center;padding:40px;opacity:0.6;font-weight:bold;'>LOADING FINANCIALS...</div>"

        box.appendChild(header)
        box.appendChild(body)
        wrap.appendChild(box)
        _modal = wrap
        document.body.appendChild(_modal)

        const data = await _loadFinancials()

        body.innerHTML = ""

        if (!data.active && data.others.length === 0) {
            body.innerHTML = "<div style='text-align:center;padding:40px;opacity:0.6;'>No conglomerate accounts registered on this server.</div>"
            return
        }

        // Top Monolithic Total
        const totalWrap = document.createElement("div")
        totalWrap.style.cssText = "text-align:center;padding:20px;background:var(--aes-oxide, #2a2a2a);color:var(--aes-bone, #f6f5f0);margin-bottom:24px;border-radius:4px;"
        totalWrap.innerHTML = `
            <div style="font-size:12px;font-weight:bold;letter-spacing:0.1em;opacity:0.7;margin-bottom:8px;">COMBINED LIQUID RESERVES</div>
            <div style="font-size:36px;font-weight:900;letter-spacing:-0.02em;">${_fmtCurrency(data.total)}</div>
        `
        body.appendChild(totalWrap)

        // The "Minus One" Section
        const othersWrap = document.createElement("div")
        othersWrap.style.cssText = "border:2px solid var(--aes-oxide, #2a2a2a);"

        const othersHeader = document.createElement("div")
        othersHeader.style.cssText = "background:var(--aes-bone-2, #ebeadd);padding:12px 16px;font-weight:bold;font-size:13px;border-bottom:2px solid var(--aes-oxide, #2a2a2a);display:flex;justify-content:space-between;"
        othersHeader.innerHTML = `
            <span>EXTERNAL CONTRIBUTIONS (${data.others.length} ENTERPRISES)</span>
            <span>${_fmtCurrency(data.total - data.activeReserve)}</span>
        `
        othersWrap.appendChild(othersHeader)

        if (data.others.length === 0) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:20px;text-align:center;opacity:0.6;font-size:13px;"
            empty.innerHTML = "No other sibling accounts found. Register more accounts in Canopy."
            othersWrap.appendChild(empty)
        } else {
            for (const o of data.others) {
                const row = document.createElement("div")
                row.style.cssText = "padding:12px 16px;border-bottom:1px solid rgba(42,42,42,0.1);display:flex;justify-content:space-between;align-items:center;"
                row.innerHTML = `
                    <div>
                        <div style="font-weight:bold;font-size:14px;">${_esc(o.airline)}</div>
                        <div style="font-size:11px;opacity:0.6;">${_esc(o.company)}</div>
                    </div>
                    <div style="font-weight:bold;font-family:monospace;font-size:14px;">
                        ${_fmtCurrency(o.reserve)}
                    </div>
                `
                othersWrap.appendChild(row)
            }
        }

        // Active Account Info
        const activeWrap = document.createElement("div")
        activeWrap.style.cssText = "margin-top:16px;text-align:right;font-size:12px;opacity:0.6;"
        activeWrap.innerHTML = `Active enterprise (${_esc(data.active ? data.active.airline : "Unknown")}) contribution: <strong style="font-family:monospace;">${_fmtCurrency(data.activeReserve)}</strong>`

        body.appendChild(othersWrap)
        body.appendChild(activeWrap)
    }

    function open() {
        if (_modal) return
        _modal = document.createElement("div") // placeholder to prevent double-open
        _render()
    }

    function close() {
        if (_modal && _modal.parentNode) {
            _modal.parentNode.removeChild(_modal)
        }
        _modal = null
    }

    window.AesCanopyAdminDashboard = {
        open: open,
        close: close
    }
})()
