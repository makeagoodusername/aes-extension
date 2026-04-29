"use strict"

/**
 * Command Bridge slice CB-3 — Coalitions panel.
 *
 * Inline (non-modal) port of modules/canopy/orgs-settings-page.js, restyled
 * to the Bridge's brutalist tokens. Lists every user-defined org from
 * AesCanopyOrgsStore, with create / rename / delete and member add/remove
 * pulled from AesAccountRegistry. Members hold {accountId, server,
 * airlineCode, aircraftIds: null} — same shape the rest of the canopy
 * consumes (resolveOrgIdForTail() in orgs-store.js).
 *
 * Differs from orgs-settings-page.js:
 *   - Inline section, not a fixed modal.
 *   - Bridge token styling (bone / oxide / rust) instead of the
 *     dark Tailwind slate the original uses.
 *   - Default-preset slot is omitted (Phase 3 there, not in scope here).
 */
class AesBridgeCoalitionsPanel {
    constructor(opts) {
        this.host = (opts && opts.host) || null
        this.accounts = (opts && opts.accounts) || []
        this._orgs = []
        this._selectedId = null
        this._dispose = null
    }

    async mount() {
        if (!this.host) return
        if (typeof window.AesCanopyOrgsStore === "undefined") {
            this._renderUnavailable()
            return
        }
        await this._refresh()
        const handler = (changes, area) => {
            if (area !== "local") return
            if (!changes || !changes[window.AesCanopyOrgsStore.KEY]) return
            this._refresh().catch(() => {})
        }
        chrome.storage.onChanged.addListener(handler)
        this._dispose = () => {
            try { chrome.storage.onChanged.removeListener(handler) } catch (_) { /* noop */ }
        }
    }

    dispose() {
        if (typeof this._dispose === "function") {
            try { this._dispose() } catch (_) { /* noop */ }
            this._dispose = null
        }
    }

    async _refresh() {
        this._orgs = await window.AesCanopyOrgsStore.listOrgs()
        if (!this._selectedId && this._orgs.length) {
            this._selectedId = this._orgs[0].id
        } else if (this._selectedId && !this._orgs.find(o => o.id === this._selectedId)) {
            this._selectedId = this._orgs[0] ? this._orgs[0].id : null
        }
        this._render()
    }

    _renderUnavailable() {
        this.host.innerHTML = ""
        const stub = document.createElement("div")
        stub.className = "aes-bridge__stub"
        stub.innerHTML = '<strong>Coalitions</strong>AesCanopyOrgsStore is not loaded on this page — open Bridge from any AS tab to load the canopy stores.'
        this.host.appendChild(stub)
    }

    _render() {
        this.host.innerHTML = ""
        const head = document.createElement("div")
        head.className = "aes-bridge__section-head"
        const h = document.createElement("h2")
        h.className = "aes-bridge__h2"
        h.textContent = "Coalitions"
        head.appendChild(h)
        const counter = document.createElement("span")
        counter.className = "aes-bridge__counter"
        counter.textContent = this._orgs.length + " " + (this._orgs.length === 1 ? "coalition" : "coalitions")
        head.appendChild(counter)
        this.host.appendChild(head)

        const split = document.createElement("div")
        split.className = "aes-bridge__coalitions-split"
        split.appendChild(this._buildList())
        split.appendChild(this._buildDetail())
        this.host.appendChild(split)
    }

    _buildList() {
        const wrap = document.createElement("aside")
        wrap.className = "aes-bridge__coalitions-list"

        const newBtn = document.createElement("button")
        newBtn.type = "button"
        newBtn.className = "aes-bridge__coalitions-new"
        newBtn.textContent = "+ New coalition"
        newBtn.addEventListener("click", async () => {
            const name = window.prompt("Coalition name:", "Asia Operations")
            if (!name || !name.trim()) return
            const org = await window.AesCanopyOrgsStore.create({name: name.trim()})
            this._selectedId = org.id
            await this._refresh()
        })
        wrap.appendChild(newBtn)

        if (!this._orgs.length) {
            const empty = document.createElement("p")
            empty.className = "aes-bridge__coalitions-empty"
            empty.textContent = "Group accounts that aren't formal kin — e.g. Asia Ops, Cargo wing."
            wrap.appendChild(empty)
            return wrap
        }

        const list = document.createElement("ul")
        list.className = "aes-bridge__coalitions-list-items"
        for (const org of this._orgs) {
            const li = document.createElement("li")
            li.className = "aes-bridge__coalitions-item"
            if (org.id === this._selectedId) li.classList.add("aes-bridge__coalitions-item--on")
            li.dataset.orgId = org.id
            const name = document.createElement("span")
            name.className = "aes-bridge__coalitions-item-name"
            name.textContent = org.name
            const meta = document.createElement("span")
            meta.className = "aes-bridge__coalitions-item-meta"
            const n = (org.members || []).length
            meta.textContent = n + (n === 1 ? " member" : " members")
            li.append(name, meta)
            li.addEventListener("click", () => {
                this._selectedId = org.id
                this._render()
            })
            list.appendChild(li)
        }
        wrap.appendChild(list)
        return wrap
    }

    _buildDetail() {
        const detail = document.createElement("section")
        detail.className = "aes-bridge__coalitions-detail"

        const org = this._orgs.find(o => o.id === this._selectedId)
        if (!org) {
            const empty = document.createElement("div")
            empty.className = "aes-bridge__empty"
            empty.textContent = this._orgs.length
                ? "Select a coalition to edit."
                : "No coalitions yet — click + New to create one."
            detail.appendChild(empty)
            return detail
        }

        // Header row — rename + delete
        const headerRow = document.createElement("div")
        headerRow.className = "aes-bridge__coalitions-detail-head"

        const nameInput = document.createElement("input")
        nameInput.type = "text"
        nameInput.value = org.name
        nameInput.maxLength = 80
        nameInput.className = "aes-bridge__coalitions-name"

        const renameBtn = document.createElement("button")
        renameBtn.type = "button"
        renameBtn.className = "aes-bridge__btn aes-bridge__btn--primary"
        renameBtn.textContent = "Rename"
        renameBtn.addEventListener("click", async () => {
            const next = nameInput.value.trim()
            if (!next || next === org.name) return
            await window.AesCanopyOrgsStore.update(org.id, {name: next})
            await this._refresh()
        })

        const delBtn = document.createElement("button")
        delBtn.type = "button"
        delBtn.className = "aes-bridge__btn aes-bridge__btn--ghost"
        delBtn.textContent = "Delete"
        delBtn.addEventListener("click", async () => {
            if (!window.confirm("Delete coalition \"" + org.name + "\"?")) return
            await window.AesCanopyOrgsStore.remove(org.id)
            this._selectedId = null
            await this._refresh()
        })
        headerRow.append(nameInput, renameBtn, delBtn)
        detail.appendChild(headerRow)

        // Members heading
        const memHead = document.createElement("h3")
        memHead.className = "aes-bridge__h3"
        memHead.textContent = "Members"
        detail.appendChild(memHead)

        if (!(org.members || []).length) {
            const e = document.createElement("p")
            e.className = "aes-bridge__hint"
            e.textContent = "No members yet — pick an account below to add."
            detail.appendChild(e)
        } else {
            const list = document.createElement("ul")
            list.className = "aes-bridge__coalition-members"
            for (let i = 0; i < org.members.length; i++) {
                const m = org.members[i]
                const li = document.createElement("li")
                li.className = "aes-bridge__coalition-member"
                const acct = this.accounts.find(a => a.id === m.accountId)
                const lbl = document.createElement("span")
                lbl.textContent = (acct ? (acct.displayName || acct.airlineIdentity) : (m.airlineCode || m.accountId))
                    + " · " + (m.server || "?")
                const rm = document.createElement("button")
                rm.type = "button"
                rm.className = "aes-bridge__coalition-member-remove"
                rm.textContent = "×"
                rm.addEventListener("click", async () => {
                    const next = (org.members || []).slice()
                    next.splice(i, 1)
                    await window.AesCanopyOrgsStore.update(org.id, {members: next})
                    await this._refresh()
                })
                li.append(lbl, rm)
                list.appendChild(li)
            }
            detail.appendChild(list)
        }

        // Add member
        const addRow = document.createElement("div")
        addRow.className = "aes-bridge__coalition-add"
        if (!this.accounts.length) {
            const hint = document.createElement("span")
            hint.className = "aes-bridge__hint"
            hint.textContent = "No accounts in registry yet — visit any AS page to populate."
            addRow.appendChild(hint)
        } else {
            const select = document.createElement("select")
            select.className = "aes-bridge__adder-bind"
            const def = document.createElement("option")
            def.value = ""; def.textContent = "Add account…"
            select.appendChild(def)
            const memberIds = new Set((org.members || []).map(m => m.accountId))
            for (const a of this.accounts) {
                if (memberIds.has(a.id)) continue
                const o = document.createElement("option")
                o.value = a.id
                o.textContent = (a.displayName || a.airlineIdentity || a.id) + " · " + (a.server || "")
                select.appendChild(o)
            }
            const addBtn = document.createElement("button")
            addBtn.type = "button"
            addBtn.className = "aes-bridge__btn aes-bridge__btn--primary"
            addBtn.textContent = "Add"
            addBtn.addEventListener("click", async () => {
                const id = select.value
                if (!id) return
                const a = this.accounts.find(x => x.id === id)
                if (!a) return
                const next = (org.members || []).slice()
                next.push({
                    accountId:   a.id,
                    server:      a.server || "",
                    airlineCode: a.airlineIdentity || "",
                    aircraftIds: null
                })
                await window.AesCanopyOrgsStore.update(org.id, {members: next})
                await this._refresh()
            })
            addRow.append(select, addBtn)
        }
        detail.appendChild(addRow)

        return detail
    }
}

if (typeof window !== "undefined") {
    window.AesBridgeCoalitionsPanel = AesBridgeCoalitionsPanel
}
