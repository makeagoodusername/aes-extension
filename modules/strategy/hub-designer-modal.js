"use strict"

/**
 * AES Strategy — Hub Network Designer modal (Slice 14).
 *
 * Presentation surface for `AesStrategy.designHubs(snapshot)`. Opens a
 * full-screen overlay with two columns: open candidates (where to
 * acquire a hub) and close candidates (where to dismantle one). Every
 * row carries `advisoryOnly: true` from the proposer; this modal makes
 * that gating visible — there is no "Apply" button. The user copies
 * the IATA code and acts in AS by hand.
 *
 *   window.AesStrategyHubDesignerModal.open({snapshot?, server?, airline?, accountId?})
 */
;(function () {
    let _modalRoot = null
    let _escHandler = null

    async function open(opts) {
        if (_modalRoot) return
        opts = opts || {}
        const T = window.AESTokens
        if (!T) return

        const snap = opts.snapshot || await _acquireSnapshot(opts)
        if (!snap) {
            _toast(T, "Could not build snapshot — open the AS dashboard first.")
            return
        }

        const ns = window.AesStrategy
        if (!ns || typeof ns.designHubs !== "function") {
            _toast(T, "Hub Designer not loaded — refresh the dashboard.")
            return
        }

        const report = ns.designHubs(snap)
        if (!report) {
            _toast(T, "Hub Designer returned no graph (snapshot too thin).")
            return
        }

        _renderModal(T, report, snap)
    }

    function close() {
        if (!_modalRoot) return
        try { _modalRoot.remove() } catch (_) {}
        if (_escHandler) document.removeEventListener("keydown", _escHandler, true)
        _modalRoot = null
        _escHandler = null
    }

    async function _acquireSnapshot(opts) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.snapshot !== "function") return null
        try {
            return await ns.snapshot({
                server:      opts.server || null,
                airlineCode: opts.airline || null,
                accountId:   opts.accountId || null
            })
        } catch (_) { return null }
    }

    function _renderModal(T, report, snap) {
        const overlay = document.createElement("div")
        overlay.className = "aes-hub-designer-modal"
        overlay.dataset.aesStrategySurface = "hub-designer"
        overlay.style.cssText = [
            "position:fixed", "inset:0", "z-index:2147483640",
            "background:rgba(11,18,32,0.7)",
            "display:flex", "align-items:center", "justify-content:center",
            "padding:" + T.sp[4]
        ].join(";")
        overlay.addEventListener("click", e => { if (e.target === overlay) close() })

        const dialog = document.createElement("div")
        dialog.className = "aes-hub-designer-dialog"
        dialog.setAttribute("role", "dialog")
        dialog.setAttribute("aria-modal", "true")
        dialog.setAttribute("aria-label", "Hub network designer")
        dialog.style.cssText = [
            "background:" + T.color.bone,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "max-width:1040px", "width:100%",
            "max-height:90vh",
            "display:flex", "flex-direction:column",
            "overflow:hidden"
        ].join(";")

        dialog.appendChild(_renderHeader(T, report, snap))
        dialog.appendChild(_renderAdvisoryBanner(T))
        dialog.appendChild(_renderBody(T, report))
        dialog.appendChild(_renderFooter(T, report))

        overlay.appendChild(dialog)
        document.body.appendChild(overlay)
        _modalRoot = overlay

        _escHandler = e => {
            if (e.key === "Escape") {
                e.stopPropagation()
                close()
            }
        }
        document.addEventListener("keydown", _escHandler, true)
    }

    function _renderHeader(T, report, snap) {
        const head = document.createElement("div")
        head.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "padding:" + T.sp[3] + " " + T.sp[4],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone2
        ].join(";")

        const left = document.createElement("div")
        const title = document.createElement("h2")
        title.textContent = "Hub Network Designer"
        title.style.cssText = [
            "margin:0",
            "font:" + T.fw.display + " " + T.fs.h2 + " " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.oxide
        ].join(";")
        left.appendChild(title)

        const sub = document.createElement("div")
        sub.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";margin-top:" + T.sp[1] + ";"
        const s = report.summary || {}
        const hubCount = _safeCount(s.ourHubCount, 0)
        const candidateCount = _safeCount(s.candidateCount, 0)
        const networkEffect = Number(s.networkEffectScore)
        sub.textContent = hubCount + " current hubs · " + candidateCount + " candidates · "
            + "network-effect " + (isFinite(networkEffect) ? networkEffect.toFixed(2) : "—")
            + (snap.airline ? " · " + snap.airline : "")
        left.appendChild(sub)
        head.appendChild(left)

        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "✕"
        closeBtn.setAttribute("aria-label", "Close")
        closeBtn.style.cssText = [
            "background:transparent", "border:none",
            "color:" + T.color.oxide,
            "font:600 18px " + T.font.display,
            "cursor:pointer", "padding:" + T.sp[1] + " " + T.sp[2]
        ].join(";")
        closeBtn.addEventListener("click", close)
        head.appendChild(closeBtn)
        return head
    }

    function _renderAdvisoryBanner(T) {
        const banner = document.createElement("div")
        banner.style.cssText = [
            "padding:" + T.sp[2] + " " + T.sp[4],
            "background:" + (T.color.amberSoft || T.color.bone2),
            "border-bottom:1px solid " + T.color.paperRule,
            "color:" + T.color.oxide,
            "font:600 11px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase"
        ].join(";")
        banner.textContent = "Advisory only · hubs never auto-apply · copy the IATA and act in AS by hand"
        return banner
    }

    function _renderBody(T, report) {
        const body = document.createElement("div")
        body.style.cssText = [
            "flex:1 1 auto", "overflow:auto",
            "padding:" + T.sp[4],
            "display:grid",
            "grid-template-columns:1fr 1fr",
            "gap:" + T.sp[4]
        ].join(";")
        body.appendChild(_renderColumn(T, "Open candidates", report.opens, _renderOpenCard))
        body.appendChild(_renderColumn(T, "Close candidates", report.closes, _renderCloseCard))
        return body
    }

    function _renderColumn(T, title, items, renderCard) {
        const col = document.createElement("section")
        const h = document.createElement("h3")
        h.textContent = title + " · " + items.length
        h.style.cssText = [
            "margin:0 0 " + T.sp[2],
            "font:" + T.fw.display + " " + T.fs.lead + " " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "color:" + T.color.oxide
        ].join(";")
        col.appendChild(h)
        if (!items.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:" + T.color.oxide2 + ";font:12px " + T.font.display
                + ";padding:" + T.sp[3] + " 0;"
            empty.textContent = "No proposals above threshold."
            col.appendChild(empty)
            return col
        }
        for (const item of items) col.appendChild(renderCard(T, item))
        return col
    }

    function _renderOpenCard(T, c) {
        const card = _baseCard(T)
        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;"
        const code = document.createElement("span")
        code.textContent = c.iata
        code.style.cssText = "font:600 18px " + T.font.mono + ";color:" + T.color.oxide
            + ";letter-spacing:0.06em;cursor:pointer;"
        code.title = "click to copy"
        code.addEventListener("click", () => _copy(c.iata, code))
        head.appendChild(code)
        head.appendChild(_chip(T, "fit " + c.fitness.toFixed(2), _toneFor(c.fitness, 0.65, 0.75)))
        card.appendChild(head)

        const comps = document.createElement("div")
        comps.style.cssText = "display:flex;gap:" + T.sp[2] + ";flex-wrap:wrap;margin:" + T.sp[2] + " 0;"
        const k = c.components || {}
        comps.appendChild(_chip(T, "catch " + k.catchment.toFixed(2), "muted"))
        comps.appendChild(_chip(T, "sat " + k.saturation.toFixed(2), "muted"))
        comps.appendChild(_chip(T, "fleet " + k.fleetCompat.toFixed(2), "muted"))
        card.appendChild(comps)

        if (Array.isArray(c.rationale) && c.rationale.length) card.appendChild(_rationale(T, c.rationale))
        if (Array.isArray(c.expectedConnectingHubs) && c.expectedConnectingHubs.length) {
            const hubs = document.createElement("div")
            hubs.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";margin-top:" + T.sp[1] + ";"
            hubs.textContent = "reachable from: " + c.expectedConnectingHubs.join(" · ")
            card.appendChild(hubs)
        }
        return card
    }

    function _renderCloseCard(T, c) {
        const card = _baseCard(T)
        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;"
        const code = document.createElement("span")
        code.textContent = c.iata
        code.style.cssText = "font:600 18px " + T.font.mono + ";color:" + T.color.oxide
            + ";letter-spacing:0.06em;cursor:pointer;"
        code.title = "click to copy"
        code.addEventListener("click", () => _copy(c.iata, code))
        head.appendChild(code)
        head.appendChild(_chip(T, "redund " + (c.redundancyScore * 100).toFixed(0) + "%", "warn"))
        card.appendChild(head)

        const profit = document.createElement("div")
        const negative = c.weeklyProfit < 0
        profit.textContent = (negative ? "−$" : "$") + Math.abs(Math.round(c.weeklyProfit)).toLocaleString() + "/wk"
        profit.style.cssText = "font:600 13px " + T.font.mono
            + ";color:" + (negative ? T.color.crimson : T.color.moss)
            + ";margin:" + T.sp[1] + " 0;"
        card.appendChild(profit)

        if (Array.isArray(c.rationale) && c.rationale.length) card.appendChild(_rationale(T, c.rationale))
        if (Array.isArray(c.redundantWith) && c.redundantWith.length) {
            const r = document.createElement("div")
            r.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";margin-top:" + T.sp[1] + ";"
            r.textContent = "overlaps: " + c.redundantWith.join(" · ")
            card.appendChild(r)
        }
        return card
    }

    function _renderFooter(T, report) {
        const footer = document.createElement("div")
        footer.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "padding:" + T.sp[3] + " " + T.sp[4],
            "border-top:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "background:" + T.color.bone2
        ].join(";")
        const meta = document.createElement("span")
        meta.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
        const s = report.summary || {}
        const builtAt = Number(s.builtAt)
        const ageMin = isFinite(builtAt)
            ? Math.max(0, Math.round((Date.now() - builtAt) / 60000))
            : 0
        const openCount = _safeCount(s.openProposals, Array.isArray(report.opens) ? report.opens.length : 0)
        const closeCount = _safeCount(s.closeProposals, Array.isArray(report.closes) ? report.closes.length : 0)
        meta.textContent = "Built " + (ageMin < 1 ? "just now" : ageMin + "m ago")
            + " · " + openCount + " opens · "
            + closeCount + " closes"
        footer.appendChild(meta)

        const closeBtn = document.createElement("button")
        closeBtn.type = "button"
        closeBtn.textContent = "Close"
        closeBtn.style.cssText = [
            "background:" + T.color.oxide, "color:" + T.color.bone,
            "border:none", "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font:600 12px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        closeBtn.addEventListener("click", close)
        footer.appendChild(closeBtn)
        return footer
    }

    function _baseCard(T) {
        const card = document.createElement("div")
        card.style.cssText = [
            "border:1px solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[3],
            "margin-bottom:" + T.sp[2],
            "background:" + T.color.bone2
        ].join(";")
        return card
    }

    function _rationale(T, lines) {
        const ul = document.createElement("ul")
        ul.style.cssText = "margin:0;padding-left:" + T.sp[3] + ";font:12px " + T.font.display + ";color:" + T.color.oxide + ";"
        for (const line of lines) {
            const li = document.createElement("li")
            li.textContent = line
            ul.appendChild(li)
        }
        return ul
    }

    function _chip(T, label, tone) {
        const map = {
            ok:    {color: T.color.moss,    bg: T.color.mossSoft},
            warn:  {color: T.color.amber,   bg: T.color.amberSoft},
            err:   {color: T.color.crimson, bg: T.color.crimsonSoft},
            muted: {color: T.color.oxide2,  bg: "transparent"}
        }
        const s = map[tone] || map.muted
        const chip = document.createElement("span")
        chip.textContent = label
        chip.style.cssText = [
            "display:inline-block", "padding:1px 6px", "margin:1px 2px",
            "border:1px solid " + s.color, "border-radius:10px",
            "background:" + s.bg, "color:" + s.color,
            "font:600 10px " + T.font.mono,
            "letter-spacing:0.04em", "text-transform:uppercase"
        ].join(";")
        return chip
    }

    function _toneFor(value, warnAt, okAt) {
        if (value >= okAt) return "ok"
        if (value >= warnAt) return "warn"
        return "muted"
    }

    function _safeCount(value, fallback) {
        const n = Number(value)
        return isFinite(n) ? n : fallback
    }

    function _copy(text, srcEl) {
        try {
            navigator.clipboard.writeText(text)
            const orig = srcEl.textContent
            srcEl.textContent = "✓ " + text
            setTimeout(() => { srcEl.textContent = orig }, 1200)
        } catch (_) {}
    }

    function _toast(T, msg) {
        const el = document.createElement("div")
        el.textContent = msg
        el.style.cssText = [
            "position:fixed", "bottom:" + T.sp[4], "left:50%",
            "transform:translateX(-50%)",
            "background:" + T.color.oxide, "color:" + T.color.bone,
            "padding:" + T.sp[2] + " " + T.sp[4],
            "border-radius:" + T.geom.radius,
            "font:12px " + T.font.display,
            "z-index:2147483641"
        ].join(";")
        document.body.appendChild(el)
        setTimeout(() => { try { el.remove() } catch (_) {} }, 3000)
    }

    window.AesStrategyHubDesignerModal = { open, close }
})()
