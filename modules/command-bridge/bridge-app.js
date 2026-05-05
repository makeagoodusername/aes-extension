"use strict"

/**
 * Command Bridge slice CB-1 — page bootstrap.
 *
 * Wires the masthead, the activity-ribbon stub, the subsidiary grid,
 * the priority board, and the trailing stub blocks into the
 * #aes-bridge-root anchor. Re-renders the subsidiary grid on
 * registry / affiliations changes from other tabs; the priority
 * board self-subscribes for its own data.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.__aesBridgeBooted) return
    window.__aesBridgeBooted = true

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, {once: true})
        } else { fn() }
    }

    ready(boot)

    async function boot() {
        const root = document.getElementById("aes-bridge-root")
        if (!root) return

        stampVersion()

        const masthead = document.getElementById("aes-bridge-masthead-stats")
        const activityHost = document.getElementById("aes-bridge-activity")
        const subsHost = document.getElementById("aes-bridge-subsidiaries")
        const boardHost = document.getElementById("aes-bridge-board")
        const coalitionsHost = document.getElementById("aes-bridge-coalitions")
        const oppsHost = document.getElementById("aes-bridge-opportunities")

        // Universe used by every panel — fetch once, pass through.
        const accounts = await window.AesAccountRegistry.list().catch(() => [])
        const kinIds = await window.AesCanopyAffiliations.listKinIds().catch(() => [])
        const kinLabels = await buildKinLabels(kinIds, accounts)
        const affiliations = await window.AesCanopyAffiliations.getAll().catch(() => ({}))

        const subsidiaries = new window.AesBridgeSubsidiaryCards({host: subsHost})
        await subsidiaries.render()
        await renderMasthead(masthead)

        if (activityHost && window.AesBridgeActivityRibbon) {
            const ribbon = new window.AesBridgeActivityRibbon({
                host:         activityHost,
                accounts:     accounts,
                affiliations: affiliations,
                kinIds:       kinIds,
                kinLabels:    kinLabels
            })
            await ribbon.mount()
        }

        const board = new window.AesBridgePriorityBoard({
            host:      boardHost,
            accounts:  accounts,
            kinIds:    kinIds,
            kinLabels: kinLabels
        })
        await board.mount()

        if (coalitionsHost && window.AesBridgeCoalitionsPanel) {
            const coalitions = new window.AesBridgeCoalitionsPanel({
                host:     coalitionsHost,
                accounts: accounts
            })
            await coalitions.mount()
        }

        if (oppsHost && window.AesBridgeOpportunitiesPanel) {
            const opps = new window.AesBridgeOpportunitiesPanel({host: oppsHost})
            await opps.mount()
        }

        // Cross-tab listener: the registry and affiliations blob can change
        // any time another AS tab touches a page. Re-render the surfaces
        // that read them.
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            if (!changes) return
            const touched = changes.aesAccounts || changes["aesCanopy:affiliations"]
            if (!touched) return
            subsidiaries.render().catch(() => {})
            renderMasthead(masthead).catch(() => {})
        })

        wireFooterLink()
    }

    function stampVersion() {
        try {
            const m = chrome.runtime.getManifest()
            const el = document.getElementById("aes-bridge-version")
            if (el) el.textContent = "v" + (m.version_name || m.version || "?")
        } catch (_) { /* noop */ }
    }

    async function renderMasthead(host) {
        if (!host) return
        const accounts = await window.AesAccountRegistry.list().catch(() => [])
        const servers = new Set(accounts.map(a => a.server).filter(Boolean))
        host.innerHTML = ""
        const stat = (label, value) => {
            const wrap = document.createElement("span")
            wrap.className = "aes-bridge__stat"
            const v = document.createElement("strong")
            v.className = "aes-bridge__stat-value"
            v.textContent = String(value)
            const l = document.createElement("span")
            l.className = "aes-bridge__stat-label"
            l.textContent = label
            wrap.append(v, l)
            return wrap
        }
        host.appendChild(stat("accounts", accounts.length))
        host.appendChild(stat("servers", servers.size))
    }

    async function buildKinLabels(kinIds, accounts) {
        const labels = new Map()
        if (!kinIds.length) return labels
        const all = await window.AesCanopyAffiliations.getAll().catch(() => ({}))
        for (const kid of kinIds) {
            // Find the first member whose accountId resolves to a registered
            // account, and use that account's display name.
            let label = null
            for (const eid in all) {
                const r = all[eid]
                if (r.kind !== "self" || r.kinId !== kid || !r.accountId) continue
                const acct = accounts.find(a => a.id === r.accountId)
                if (acct) { label = acct.displayName || acct.airlineIdentity; break }
            }
            labels.set(kid, label || kid.slice(0, 8))
        }
        return labels
    }

    function wireFooterLink() {
        const a = document.getElementById("aes-bridge-footer-options")
        if (!a) return
        a.href = chrome.runtime.getURL("options.html")
    }
})()
