"use strict"

/**
 * Command Bridge slice CB-1 — Priority Board.
 *
 * Three-lane Kanban (NOW / NEXT / LATER) of cross-enterprise priorities.
 * The point: priorities live above any single airline's dashboard, so
 * "what should I be doing right now across my enterprise" has a single
 * answer instead of being re-derived from whichever AS tab is open.
 *
 * Each card has a title, optional note, and zero-or-more bindings to
 * accountIds (from AesAccountRegistry) and kinIds (from
 * AesCanopyAffiliations). The top of NOW is mirrored as a banner above
 * the lanes — an at-a-glance "current focus."
 *
 * Drag-and-drop: HTML5 drag is used both within and between lanes. The
 * card the cursor is hovering over becomes the insert anchor; dropping
 * past the last card appends.
 */
class AesBridgePriorityBoard {
    constructor(opts) {
        this.host = (opts && opts.host) || null
        this.accounts = (opts && opts.accounts) || []
        this.kinIds   = (opts && opts.kinIds)   || []
        this.kinLabels = (opts && opts.kinLabels) || new Map()
        this._items = []
        this._dispose = null
        this._lanes = AesBridgePriorityStore.LANES
    }

    async mount() {
        if (!this.host) return
        this.host.innerHTML = ""
        this.host.appendChild(this._buildShell())
        await this._reload()
        this._dispose = AesBridgePriorityStore.subscribe(blob => {
            this._items = blob.items || []
            this._renderLanes()
            this._renderBanner()
        })
    }

    dispose() {
        if (typeof this._dispose === "function") {
            try { this._dispose() } catch (_) { /* noop */ }
            this._dispose = null
        }
    }

    async _reload() {
        const blob = await AesBridgePriorityStore.load()
        this._items = blob.items || []
        this._renderLanes()
        this._renderBanner()
    }

    _buildShell() {
        const shell = document.createElement("div")
        shell.className = "aes-bridge__board-shell"

        const head = document.createElement("div")
        head.className = "aes-bridge__section-head"
        const h = document.createElement("h2")
        h.className = "aes-bridge__h2"
        h.textContent = "Priorities"
        head.appendChild(h)
        const sub = document.createElement("span")
        sub.className = "aes-bridge__counter"
        sub.textContent = "Drag to shift focus across the enterprise"
        head.appendChild(sub)

        const banner = document.createElement("div")
        banner.className = "aes-bridge__banner"
        this._bannerEl = banner

        const lanes = document.createElement("div")
        lanes.className = "aes-bridge__lanes"
        this._laneEls = new Map()
        for (const lane of this._lanes) {
            const laneEl = this._buildLane(lane)
            this._laneEls.set(lane, laneEl)
            lanes.appendChild(laneEl)
        }

        const adder = this._buildAdder()

        shell.append(head, banner, lanes, adder)
        return shell
    }

    _buildLane(lane) {
        const el = document.createElement("section")
        el.className = "aes-bridge__lane"
        el.dataset.lane = lane

        const head = document.createElement("header")
        head.className = "aes-bridge__lane-head"
        const title = document.createElement("h3")
        title.className = "aes-bridge__lane-title"
        title.textContent = lane
        head.appendChild(title)
        const tally = document.createElement("span")
        tally.className = "aes-bridge__lane-tally"
        tally.dataset.tallyFor = lane
        head.appendChild(tally)
        el.appendChild(head)

        const list = document.createElement("ul")
        list.className = "aes-bridge__lane-list"
        list.dataset.lane = lane
        list.addEventListener("dragover", (ev) => this._onDragOver(ev, list))
        list.addEventListener("dragleave", () => this._clearDragMarker(list))
        list.addEventListener("drop", (ev) => this._onDrop(ev, list))
        el.appendChild(list)

        return el
    }

    _buildAdder() {
        const wrap = document.createElement("form")
        wrap.className = "aes-bridge__adder"
        wrap.addEventListener("submit", (e) => { e.preventDefault(); this._submitAdder(wrap) })

        const title = document.createElement("input")
        title.type = "text"
        title.name = "title"
        title.placeholder = "New priority — e.g. Stabilize MEX yields"
        title.maxLength = 200
        title.required = true
        title.className = "aes-bridge__adder-title"

        const lane = document.createElement("select")
        lane.name = "lane"
        lane.className = "aes-bridge__adder-lane"
        for (const l of this._lanes) {
            const o = document.createElement("option")
            o.value = l; o.textContent = l
            lane.appendChild(o)
        }

        const kin = document.createElement("select")
        kin.name = "kinId"
        kin.className = "aes-bridge__adder-bind"
        const kinDefault = document.createElement("option")
        kinDefault.value = ""; kinDefault.textContent = "+ kin (any)"
        kin.appendChild(kinDefault)
        for (const id of this.kinIds) {
            const o = document.createElement("option")
            o.value = id; o.textContent = "kin: " + (this.kinLabels.get(id) || id.slice(0, 8))
            kin.appendChild(o)
        }

        const acct = document.createElement("select")
        acct.name = "accountId"
        acct.className = "aes-bridge__adder-bind"
        const acctDefault = document.createElement("option")
        acctDefault.value = ""; acctDefault.textContent = "+ account (any)"
        acct.appendChild(acctDefault)
        for (const a of this.accounts) {
            const o = document.createElement("option")
            o.value = a.id
            o.textContent = (a.displayName || a.airlineIdentity || a.id) + " · " + (a.server || "")
            acct.appendChild(o)
        }

        const btn = document.createElement("button")
        btn.type = "submit"
        btn.textContent = "Add"
        btn.className = "aes-bridge__adder-btn"

        wrap.append(title, lane, kin, acct, btn)
        return wrap
    }

    async _submitAdder(form) {
        const fd = new FormData(form)
        const title = (fd.get("title") || "").toString().trim()
        if (!title) return
        const lane = fd.get("lane") || "NOW"
        const kinId = fd.get("kinId")
        const accountId = fd.get("accountId")
        await AesBridgePriorityStore.add({
            title,
            lane,
            kinIds:     kinId ? [String(kinId)] : [],
            accountIds: accountId ? [String(accountId)] : [],
            note:       ""
        })
        form.reset()
        await this._reload()
    }

    _renderLanes() {
        for (const lane of this._lanes) {
            const el = this._laneEls.get(lane)
            if (!el) continue
            const list = el.querySelector(".aes-bridge__lane-list")
            const tally = el.querySelector('[data-tally-for="' + lane + '"]')
            list.innerHTML = ""
            const items = this._items
                .filter(i => i.lane === lane)
                .sort((a, b) => (a.rank || 0) - (b.rank || 0))
            tally.textContent = String(items.length)
            if (!items.length) {
                const ph = document.createElement("li")
                ph.className = "aes-bridge__lane-empty"
                ph.textContent = "Drop here"
                list.appendChild(ph)
            } else {
                for (const it of items) list.appendChild(this._buildCard(it))
            }
        }
    }

    _renderBanner() {
        if (!this._bannerEl) return
        const top = this._items
            .filter(i => i.lane === "NOW")
            .sort((a, b) => (a.rank || 0) - (b.rank || 0))[0]
        this._bannerEl.innerHTML = ""
        if (!top) {
            this._bannerEl.classList.add("aes-bridge__banner--empty")
            this._bannerEl.textContent = "No focus set — add a priority below to anchor your enterprise's NOW."
            return
        }
        this._bannerEl.classList.remove("aes-bridge__banner--empty")
        const label = document.createElement("span")
        label.className = "aes-bridge__banner-label"
        label.textContent = "Now"
        const title = document.createElement("strong")
        title.className = "aes-bridge__banner-title"
        title.textContent = top.title
        const bindings = this._buildBindingChips(top)
        bindings.classList.add("aes-bridge__banner-binds")
        this._bannerEl.append(label, title, bindings)
    }

    _buildCard(item) {
        const li = document.createElement("li")
        li.className = "aes-bridge__card"
        li.dataset.id = item.id
        li.draggable = true
        li.addEventListener("dragstart", (ev) => this._onDragStart(ev, item))
        li.addEventListener("dragend",   () => this._clearAllDragMarkers())

        const head = document.createElement("div")
        head.className = "aes-bridge__card-head"
        const title = document.createElement("span")
        title.className = "aes-bridge__card-title"
        title.textContent = item.title
        head.appendChild(title)

        const del = document.createElement("button")
        del.type = "button"
        del.className = "aes-bridge__card-del"
        del.title = "Remove priority"
        del.textContent = "×"
        del.addEventListener("click", async (ev) => {
            ev.stopPropagation()
            await AesBridgePriorityStore.remove(item.id)
            await this._reload()
        })
        head.appendChild(del)
        li.appendChild(head)

        const binds = this._buildBindingChips(item)
        if (binds.childNodes.length > 0) li.appendChild(binds)

        if (item.note) {
            const note = document.createElement("p")
            note.className = "aes-bridge__card-note"
            note.textContent = item.note
            li.appendChild(note)
        }

        return li
    }

    _buildBindingChips(item) {
        const wrap = document.createElement("div")
        wrap.className = "aes-bridge__binds"
        for (const kid of item.kinIds || []) {
            const chip = document.createElement("span")
            chip.className = "aes-bridge__bind aes-bridge__bind--kin"
            chip.textContent = "kin · " + (this.kinLabels.get(kid) || kid.slice(0, 8))
            wrap.appendChild(chip)
        }
        for (const aid of item.accountIds || []) {
            const acct = this.accounts.find(a => a.id === aid)
            const chip = document.createElement("span")
            chip.className = "aes-bridge__bind aes-bridge__bind--acct"
            chip.textContent = acct ? (acct.displayName || acct.airlineIdentity || aid) : aid
            wrap.appendChild(chip)
        }
        return wrap
    }

    _onDragStart(ev, item) {
        try { ev.dataTransfer.setData("text/plain", item.id) } catch (_) { /* noop */ }
        ev.dataTransfer.effectAllowed = "move"
        this._draggingId = item.id
    }

    _onDragOver(ev, list) {
        ev.preventDefault()
        if (!this._draggingId) return
        ev.dataTransfer.dropEffect = "move"
        const cards = Array.from(list.querySelectorAll(".aes-bridge__card"))
            .filter(el => el.dataset.id !== this._draggingId)
        this._clearDragMarker(list)
        const before = cards.find(el => {
            const r = el.getBoundingClientRect()
            return ev.clientY < r.top + r.height / 2
        })
        if (before) {
            before.classList.add("aes-bridge__card--drop-before")
            list.dataset.dropBefore = before.dataset.id
        } else {
            list.classList.add("aes-bridge__lane-list--drop-tail")
            delete list.dataset.dropBefore
        }
    }

    async _onDrop(ev, list) {
        ev.preventDefault()
        if (!this._draggingId) return
        const lane = list.dataset.lane
        const beforeId = list.dataset.dropBefore || null
        const movingId = this._draggingId
        this._draggingId = null
        this._clearAllDragMarkers()
        await AesBridgePriorityStore.move(movingId, lane, beforeId)
        await this._reload()
    }

    _clearDragMarker(list) {
        for (const el of list.querySelectorAll(".aes-bridge__card--drop-before")) {
            el.classList.remove("aes-bridge__card--drop-before")
        }
        list.classList.remove("aes-bridge__lane-list--drop-tail")
        delete list.dataset.dropBefore
    }

    _clearAllDragMarkers() {
        if (!this.host) return
        for (const list of this.host.querySelectorAll(".aes-bridge__lane-list")) {
            this._clearDragMarker(list)
        }
    }
}

if (typeof window !== "undefined") {
    window.AesBridgePriorityBoard = AesBridgePriorityBoard
}
