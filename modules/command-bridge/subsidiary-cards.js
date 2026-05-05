"use strict"

/**
 * Command Bridge slice CB-1 — subsidiary grid + orphans row.
 *
 * Renders one card per kinId from AesCanopyAffiliations (the codebase's
 * existing notion of a self-airline family — see
 * modules/canopy/affiliations-store.js Invariant L4-B). Each card lists
 * member airlines resolved through AesAccountRegistry, with a deep-link
 * to the airline's AS dashboard.
 *
 * Orphans = registry accounts that aren't named by any "self" affiliation
 * record's accountId field. A first-run user with no auto-classifier pass
 * yet sees every account as an orphan; that's the right experience —
 * once they run the auto-classifier in Affiliations Settings, kin
 * families populate this section.
 */
class AesBridgeSubsidiaryCards {
    constructor(opts) {
        this.host = (opts && opts.host) || null
        this.onPickAccount = (opts && opts.onPickAccount) || null
        this.onPickKin     = (opts && opts.onPickKin)     || null
    }

    async render() {
        if (!this.host) return
        this.host.innerHTML = ""

        const [accounts, affilByEntId, kinMap] = await Promise.all([
            AesAccountRegistry.list().catch(() => []),
            AesCanopyAffiliations.getAll().catch(() => ({})),
            AesCanopyAffiliations.membersByKinId().catch(() => new Map())
        ])

        // Cross-walk: kinId → [{enterpriseId, account|null}]
        const kins = []
        for (const [kinId, entIds] of kinMap.entries()) {
            const members = entIds.map(eid => {
                const aff = affilByEntId[eid] || null
                const acct = aff && aff.accountId
                    ? accounts.find(a => a.id === aff.accountId) || null
                    : null
                return {enterpriseId: eid, affiliation: aff, account: acct}
            })
            kins.push({kinId, members})
        }
        kins.sort((a, b) => {
            const al = AesBridgeSubsidiaryCards._latestLastSeen(a.members)
            const bl = AesBridgeSubsidiaryCards._latestLastSeen(b.members)
            return bl - al
        })

        // Orphans: registry accounts not present as a "self" affiliation member
        const linkedIds = new Set()
        for (const k of kins) for (const m of k.members) if (m.account) linkedIds.add(m.account.id)
        const orphans = accounts.filter(a => !linkedIds.has(a.id))

        this.host.appendChild(this._buildHeader(kins.length, orphans.length))

        if (kins.length > 0) {
            const grid = document.createElement("div")
            grid.className = "aes-bridge__kin-grid"
            for (const kin of kins) grid.appendChild(this._buildKinCard(kin))
            this.host.appendChild(grid)
        }

        if (orphans.length > 0) {
            this.host.appendChild(this._buildOrphansRow(orphans, kins.length === 0))
        } else if (kins.length === 0) {
            const empty = document.createElement("div")
            empty.className = "aes-bridge__empty"
            empty.textContent = "No accounts observed yet — visit any AS page to register the active airline."
            this.host.appendChild(empty)
        }
    }

    _buildHeader(kinCount, orphanCount) {
        const wrap = document.createElement("div")
        wrap.className = "aes-bridge__section-head"
        const h = document.createElement("h2")
        h.className = "aes-bridge__h2"
        h.textContent = "Subsidiaries"
        wrap.appendChild(h)
        const counter = document.createElement("span")
        counter.className = "aes-bridge__counter"
        counter.textContent = kinCount + " kin · " + orphanCount + " orphan" + (orphanCount === 1 ? "" : "s")
        wrap.appendChild(counter)
        return wrap
    }

    _buildKinCard(kin) {
        const card = document.createElement("article")
        card.className = "aes-bridge__kin-card"
        card.dataset.kinId = kin.kinId

        const head = document.createElement("header")
        head.className = "aes-bridge__kin-head"

        const dot = document.createElement("span")
        dot.className = "aes-bridge__kin-dot"
        dot.style.background = AesCanopyAffiliations.kindColor("self")
        head.appendChild(dot)

        const name = document.createElement("h3")
        name.className = "aes-bridge__kin-name"
        const labelAccount = kin.members.find(m => m.account)
        name.textContent = labelAccount && labelAccount.account.displayName
            ? labelAccount.account.displayName + (kin.members.length > 1 ? " family" : "")
            : "Kin " + kin.kinId.slice(0, 8)
        head.appendChild(name)

        const count = document.createElement("span")
        count.className = "aes-bridge__kin-count"
        count.textContent = kin.members.length + (kin.members.length === 1 ? " member" : " members")
        head.appendChild(count)

        if (typeof this.onPickKin === "function") {
            head.classList.add("aes-bridge__clickable")
            head.addEventListener("click", () => this.onPickKin(kin.kinId))
        }

        card.appendChild(head)

        const list = document.createElement("ul")
        list.className = "aes-bridge__member-list"
        for (const m of kin.members) list.appendChild(this._buildMemberRow(m))
        card.appendChild(list)

        return card
    }

    _buildMemberRow(member) {
        const li = document.createElement("li")
        li.className = "aes-bridge__member"

        const acct = member.account
        if (acct) {
            const a = document.createElement("a")
            a.href = "https://" + acct.server + ".airlinesim.aero/app/enterprise/dashboard"
            a.target = "_blank"
            a.rel = "noreferrer noopener"
            a.className = "aes-bridge__member-link"

            const label = document.createElement("span")
            label.className = "aes-bridge__member-label"
            label.textContent = acct.displayName || acct.airlineIdentity || "—"

            const server = document.createElement("span")
            server.className = "aes-bridge__member-server"
            server.textContent = acct.server || "—"

            const seen = document.createElement("span")
            seen.className = "aes-bridge__member-seen"
            seen.textContent = AesBridgeSubsidiaryCards._fmtAge(acct.lastSeenAt)

            a.append(label, server, seen)
            li.appendChild(a)

            if (typeof this.onPickAccount === "function") {
                a.addEventListener("auxclick", () => this.onPickAccount(acct.id))
            }
        } else {
            const stub = document.createElement("span")
            stub.className = "aes-bridge__member-link aes-bridge__member-link--unlinked"
            const label = document.createElement("span")
            label.className = "aes-bridge__member-label"
            label.textContent = "Enterprise " + member.enterpriseId
            const hint = document.createElement("span")
            hint.className = "aes-bridge__member-hint"
            hint.textContent = "no account link"
            stub.append(label, hint)
            li.appendChild(stub)
        }

        return li
    }

    _buildOrphansRow(orphans, isOnlyContent) {
        const wrap = document.createElement("section")
        wrap.className = "aes-bridge__orphans"

        const head = document.createElement("header")
        head.className = "aes-bridge__orphans-head"
        const h = document.createElement("h3")
        h.className = "aes-bridge__h3"
        h.textContent = isOnlyContent ? "Accounts" : "Unaffiliated"
        head.appendChild(h)
        if (!isOnlyContent) {
            const hint = document.createElement("span")
            hint.className = "aes-bridge__hint"
            hint.textContent = "no kin family yet — set affiliation in AES dropdown → Settings"
            head.appendChild(hint)
        }
        wrap.appendChild(head)

        const grid = document.createElement("div")
        grid.className = "aes-bridge__orphans-grid"
        for (const a of orphans) grid.appendChild(this._buildOrphanChip(a))
        wrap.appendChild(grid)
        return wrap
    }

    _buildOrphanChip(acct) {
        const a = document.createElement("a")
        a.href = "https://" + acct.server + ".airlinesim.aero/app/enterprise/dashboard"
        a.target = "_blank"
        a.rel = "noreferrer noopener"
        a.className = "aes-bridge__orphan-chip"

        const label = document.createElement("span")
        label.className = "aes-bridge__orphan-label"
        label.textContent = acct.displayName || acct.airlineIdentity || acct.id

        const meta = document.createElement("span")
        meta.className = "aes-bridge__orphan-meta"
        meta.textContent = (acct.server || "—") + " · " + AesBridgeSubsidiaryCards._fmtAge(acct.lastSeenAt)

        a.append(label, meta)
        return a
    }

    static _latestLastSeen(members) {
        let best = 0
        for (const m of members) {
            const t = m.account && Number(m.account.lastSeenAt) || 0
            if (t > best) best = t
        }
        return best
    }

    static _fmtAge(ms) {
        if (!ms) return "—"
        const d = Date.now() - Number(ms)
        if (d < 60_000)        return "just now"
        if (d < 3_600_000)     return Math.floor(d / 60_000) + "m ago"
        if (d < 86_400_000)    return Math.floor(d / 3_600_000) + "h ago"
        return Math.floor(d / 86_400_000) + "d ago"
    }
}

if (typeof window !== "undefined") {
    window.AesBridgeSubsidiaryCards = AesBridgeSubsidiaryCards
}
