"use strict"

/**
 * Managing Routes host.
 *
 * The legacy dashboard owns the route list/table. This host is intentionally
 * glue-only: it finds the selected route in that table, mounts RoutePanel when
 * available, and keeps the panel updated as the table selection/account changes.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.top !== window) return
    if (window.__aesManagingRoutesHostMounted) return
    window.__aesManagingRoutesHostMounted = true

    const HOST_ID = "aes-managing-routes-panel-host"
    const ACTIVE_ROW_CLASS = "aes-managing-routes-row-active"
    const TOPIC_ACCOUNT_SWITCHED = "ACCOUNT_SWITCHED"
    const TOPIC_ROUTE_PANEL_ACTION = "ROUTE_PANEL_ACTION"
    const TOPIC_ROUTE_COMMAND = "ROUTE_COMMAND"
    const TOPIC_ACCOUNT_BOOTSTRAPPED = "data:account:bootstrapped"

    const state = {
        accountCtx: null,
        dashboardEl: null,
        hostEl: null,
        panel: null,
        selectedRoute: null,
        syncTimer: null,
        observers: [],
        disposers: [],
        dashboardListenersInstalledOn: null,
        historyPatched: false,
        priceContextSeq: 0
    }

    function logWarn() {
        const args = Array.prototype.slice.call(arguments)
        args.unshift("[AES managing-routes]")
        console.warn.apply(console, args)
    }

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, {once: true})
        } else {
            fn()
        }
    }

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim()
    }

    function normalizeCode(value) {
        return normalizeText(value).replace(/[^A-Za-z0-9]/g, "").toUpperCase()
    }

    function normalizeRouteKey(value) {
        const key = normalizeCode(value)
        return key.length >= 6 ? key.slice(0, 6) : key
    }

    function routeSignature(route) {
        if (!route) return ""
        return [
            route.routeKey || "",
            route.origin || "",
            route.destination || "",
            route.direction || "",
            route.flightNumber || "",
            route.marketId || ""
        ].join("|")
    }

    function sameRoute(a, b) {
        return routeSignature(a) === routeSignature(b)
    }

    function resolveCellText(row, selector) {
        const el = row && row.querySelector(selector)
        return normalizeText(el && el.textContent)
    }

    function routeFromRow(row) {
        if (!row) return null
        const rowKey = normalizeRouteKey(String(row.id || "").replace(/^aes-row-/, ""))
        const odText = normalizeRouteKey(resolveCellText(row, ".aes-od"))
        const routeKey = rowKey || odText
        const origin = routeKey.slice(0, 3) || normalizeCode(resolveCellText(row, ".aes-origin"))
        const destination = routeKey.slice(3, 6) || normalizeCode(resolveCellText(row, ".aes-destination"))
        if (!origin || !destination) return null

        const route = {
            origin: origin,
            destination: destination,
            routeKey: routeKey || (origin + destination),
            marketId: routeKey || (origin + destination)
        }
        const direction = resolveCellText(row, ".aes-direction")
        if (direction) route.direction = direction
        const flightNumber = resolveCellText(row, ".aes-flightNumber")
        if (flightNumber) route.flightNumber = flightNumber
        return route
    }

    function rowMatchesRoute(row, route) {
        const rowRoute = routeFromRow(row)
        if (!rowRoute || !route) return false
        const wantedKey = normalizeRouteKey(route.routeKey || route.marketId || route.od || (route.origin || "") + (route.destination || ""))
        const rowKey = normalizeRouteKey(rowRoute.routeKey || rowRoute.origin + rowRoute.destination)
        if (wantedKey && rowKey && wantedKey === rowKey) return true
        return normalizeCode(rowRoute.origin) === normalizeCode(route.origin)
            && normalizeCode(rowRoute.destination) === normalizeCode(route.destination)
    }

    function rows() {
        return Array.from(document.querySelectorAll("#aes-table-routeManagement tbody tr"))
    }

    function tableEl() {
        return document.getElementById("aes-table-routeManagement")
    }

    function findRowForRoute(route) {
        if (!route) return null
        return rows().find(function (row) { return rowMatchesRoute(row, route) }) || null
    }

    function firstSelectedRow() {
        const table = tableEl()
        if (!table) return null
        const active = table.querySelector("tbody tr." + ACTIVE_ROW_CLASS)
        if (active) return active
        const checked = rows().find(function (row) {
            return !!row.querySelector("input[type='checkbox']:checked")
        })
        return checked || table.querySelector("tbody tr")
    }

    function resolveSelectedRoute() {
        return routeFromRow(firstSelectedRow())
    }

    function clearActiveRows() {
        rows().forEach(function (row) { row.classList.remove(ACTIVE_ROW_CLASS) })
    }

    function markActiveRow(route) {
        clearActiveRows()
        const row = findRowForRoute(route)
        if (row) row.classList.add(ACTIVE_ROW_CLASS)
    }

    function readAccountCtx(override) {
        let serverId = ""
        let airline = null
        let identity = ""
        try { serverId = AES.getServerName() } catch (_) { /* noop */ }
        if (!serverId && window.location && window.location.hostname) {
            serverId = window.location.hostname.split(".")[0]
        }
        try { airline = AES.getAirlineCode() } catch (_) { airline = null }
        try { identity = AES.getAirlineIdentity() || "" } catch (_) { identity = "" }

        const airlineCode = normalizeText(airline && airline.code) || identity
        const airlineName = normalizeText(airline && airline.name) || identity || airlineCode
        const accountId = (override && (override.accountId || override.id))
            || window.__aesAccountId
            || [serverId, airlineCode || airlineName || "unknown"].join(":")

        return {
            serverId: serverId || (override && override.serverId) || "",
            accountId: accountId,
            ownerEnterpriseId: (override && override.ownerEnterpriseId) || airlineCode || accountId,
            enterpriseId: (override && override.enterpriseId) || airlineCode || accountId,
            airlineCode: airlineCode || null,
            airlineName: airlineName || null,
            services: {
                dataBus: !!window.AesDataBus,
                storage: !!(window.chrome && chrome.storage && chrome.storage.local),
                accountRegistry: !!window.AesAccountRegistry
            }
        }
    }

    function fixtureFor(route, accountCtx) {
        const label = route ? route.origin + " -> " + route.destination : "No route selected"
        return {
            route: route || null,
            accountCtx: accountCtx || null,
            label: label,
            pricing: {
                economy: {fare: 180, load: 0.78},
                business: {fare: 420, load: 0.64},
                first: {fare: 760, load: 0.42},
                cargo: {fare: 0.31, load: 0.58}
            },
            service: {
                profile: "Standard",
                reliability: 0.91
            },
            ors: {
                score: 72,
                refreshedAt: new Date().toISOString()
            }
        }
    }

    function formatPrice(value, cls) {
        const n = Number(value)
        if (!isFinite(n)) return "--"
        if (cls === "Cargo") {
            const rounded = Math.round(n * 100) / 100
            return "AS$ " + (n < 10 ? rounded.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(rounded)))
        }
        return "AS$ " + Math.round(n)
    }

    function formatPct(value) {
        const n = Number(value)
        if (!isFinite(n)) return null
        return Math.round(n * 100) + "%"
    }

    function pricingMetric(ctx, cls, label, fallbackValue, fallbackNote) {
        const cur = ctx && ctx.currentPrices && ctx.currentPrices[cls]
        const comp = ctx && ctx.competitors && ctx.competitors.medians && ctx.competitors.medians[cls]
        const hist = ctx && ctx.historyByClass && ctx.historyByClass[cls]
        const advice = ctx && ctx.adviceByClass && ctx.adviceByClass[cls]
        const note = []
        if (comp != null) note.push("comp " + formatPrice(comp, cls))
        if (hist && hist.avgPrice != null && Number(hist.avgPrice) > 0) {
            note.push("hist " + formatPrice(hist.avgPrice, cls))
        }
        if (advice && advice.stance && advice.stance !== "hold") note.push(advice.stance)
        return [label, cur != null ? formatPrice(cur, cls) : fallbackValue, note.join(" · ") || fallbackNote]
    }

    function pricingMetrics(fixture, ctx) {
        const y = pricingMetric(ctx, "Y", "Economy", "AS$ " + fixture.pricing.economy.fare,
            Math.round(fixture.pricing.economy.load * 100) + "% load")
        const c = pricingMetric(ctx, "C", "Business", "AS$ " + fixture.pricing.business.fare,
            Math.round(fixture.pricing.business.load * 100) + "% load")
        const f = pricingMetric(ctx, "F", "First", "AS$ " + fixture.pricing.first.fare,
            Math.round(fixture.pricing.first.load * 100) + "% load")
        const cargo = pricingMetric(ctx, "Cargo", "Cargo", "AS$ " + fixture.pricing.cargo.fare,
            Math.round(fixture.pricing.cargo.load * 100) + "% load")
        const ors = ctx && ctx.ors
            ? ["ORS", ors.rankAny != null ? "#" + ors.rankAny : "--",
                ors.ratingGapToTop != null ? "gap " + ors.ratingGapToTop : "rank context"]
            : ["ORS", String(fixture.ors.score), "score"]
        const schedule = ctx && ctx.schedule
            ? ["Schedule", ctx.schedule.weeklyFlights != null ? ctx.schedule.weeklyFlights + "/wk" : "--",
                [ctx.schedule.departureTime, ctx.schedule.primaryAircraftType].filter(Boolean).join(" · ") || "route schedule"]
            : ["Schedule", "--", "sync route data"]
        return [y, c, f, cargo, ors, schedule]
    }

    function resolveMountRoutePanel() {
        const candidates = [
            window.mountRoutePanel,
            window.RoutePanel && window.RoutePanel.mountRoutePanel,
            window.AESRoutePanel && window.AESRoutePanel.mountRoutePanel,
            window.AesRoutePanel && window.AesRoutePanel.mountRoutePanel
        ]
        return candidates.find(function (fn) { return typeof fn === "function" }) || null
    }

    function emitBus(topic, payload) {
        const bus = window.AesDataBus || window.AesBus || null
        if (!bus) return null
        try {
            if (typeof bus.emit === "function") return bus.emit(topic, payload || {})
            if (typeof bus.publish === "function") return bus.publish(topic, payload || {})
        } catch (err) {
            logWarn("bus emit failed", topic, err)
        }
        return null
    }

    function createMockRoutePanel(rootEl, opts) {
        const shadow = rootEl.shadowRoot || (rootEl.attachShadow ? rootEl.attachShadow({mode: "open"}) : null)
        const target = shadow || rootEl
        let current = Object.assign({}, opts || {})

        function actionButton(label, action, commandTopic) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = label
            btn.addEventListener("click", function () {
                const routeId = current.routeId || null
                if (commandTopic) {
                    emitBus(TOPIC_ROUTE_COMMAND, {action: action, routeId: routeId})
                } else {
                    emitBus(TOPIC_ROUTE_PANEL_ACTION, {
                        action: action,
                        routeId: routeId,
                        accountCtx: current.accountCtx || null
                    })
                }
            })
            return btn
        }

        function render() {
            const route = current.routeId || null
            const account = current.accountCtx || {}
            const fixture = current.fixtureData || fixtureFor(route, account)
            const priceContext = current.pricingContext || null
            const routeLabel = route ? route.origin + " -> " + route.destination : "No route selected"
            const routeMeta = route ? (route.routeKey || route.origin + route.destination) : "Waiting for dashboard table"

            target.textContent = ""
            const style = document.createElement("style")
            style.textContent = [
                ":host{display:block}",
                ".panel{border:1px solid #d7dce2;background:#fff;margin:12px 0 14px;padding:12px;font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033}",
                ".top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
                ".eyebrow{font-size:11px;text-transform:uppercase;color:#667085;font-weight:700;letter-spacing:.08em}",
                ".route{font-size:20px;font-weight:700;margin-top:2px}",
                ".meta{font-size:12px;color:#667085;margin-top:2px}",
                ".grid{display:grid;grid-template-columns:repeat(4,minmax(90px,1fr));gap:8px;margin-top:12px}",
                ".metric{border:1px solid #e4e7ec;background:#f8fafc;padding:8px}",
                ".metric b{display:block;font-size:16px}",
                ".actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}",
                "button{border:1px solid #a9b3c2;background:#fff;color:#172033;padding:5px 9px;font:12px system-ui;cursor:pointer}",
                "button:hover{background:#f2f4f7}",
                "@media(max-width:720px){.top{display:block}.grid{grid-template-columns:repeat(2,minmax(90px,1fr))}}"
            ].join("\n")

            const panel = document.createElement("section")
            panel.className = "panel"
            panel.dataset.mockMode = "true"

            const top = document.createElement("div")
            top.className = "top"

            const title = document.createElement("div")
            const eyebrow = document.createElement("div")
            eyebrow.className = "eyebrow"
            eyebrow.textContent = "Route management"
            const routeEl = document.createElement("div")
            routeEl.className = "route"
            routeEl.textContent = routeLabel
            const meta = document.createElement("div")
            meta.className = "meta"
            meta.textContent = routeMeta + " · " + (account.serverId || "unknown server") + " · " + (account.airlineCode || account.airlineName || "unknown airline")
            title.append(eyebrow, routeEl, meta)

            const status = document.createElement("div")
            status.className = "meta"
            const signalLabels = priceContext && priceContext.signals && priceContext.signals.labels || []
            status.textContent = signalLabels.length ? signalLabels.join(" / ") : "waiting for route context"
            top.append(title, status)

            const grid = document.createElement("div")
            grid.className = "grid"
            const metrics = pricingMetrics(fixture, priceContext)
            metrics.forEach(function (metric) {
                const box = document.createElement("div")
                box.className = "metric"
                const label = document.createElement("span")
                label.textContent = metric[0]
                const value = document.createElement("b")
                value.textContent = metric[1]
                const note = document.createElement("span")
                note.textContent = metric[2]
                box.append(label, value, note)
                grid.append(box)
            })

            const actions = document.createElement("div")
            actions.className = "actions"
            actions.append(
                actionButton("Inventory", "openInventory", true),
                actionButton("Pricing", "openPricing", true),
                actionButton("Schedule", "openSchedule", true),
                actionButton("Refresh ORS", "ors.refresh", false),
                actionButton("Recompute", "recompute", true)
            )

            panel.append(top, grid, actions)
            target.append(style, panel)
        }

        render()
        return {
            update: function (next) {
                current = Object.assign({}, current, next || {})
                if (!current.fixtureData) {
                    current.fixtureData = fixtureFor(current.routeId, current.accountCtx)
                }
                render()
            },
            unmount: function () {
                target.textContent = ""
            },
            destroy: function () {
                target.textContent = ""
            }
        }
    }

    function mountPanel(hostEl, route) {
        if (!hostEl) return
        const opts = {
            routeId: route || null,
            accountCtx: state.accountCtx,
            readOnly: false,
            theme: "aes",
            skin: "dashboard",
            initialTab: "overview"
        }

        const mount = resolveMountRoutePanel()
        if (mount) {
            try {
                state.panel = mount(hostEl, opts)
            } catch (err) {
                logWarn("RoutePanel mount failed; using mock fallback", err)
                hostEl.textContent = ""
                state.panel = createMockRoutePanel(hostEl, Object.assign({}, opts, {
                    mockMode: true,
                    fixtureData: fixtureFor(route, state.accountCtx)
                }))
            }
        } else {
            state.panel = createMockRoutePanel(hostEl, Object.assign({}, opts, {
                mockMode: true,
                fixtureData: fixtureFor(route, state.accountCtx)
            }))
        }
    }

    function updatePanel(route, extra) {
        if (!state.panel || !state.hostEl || !document.documentElement.contains(state.hostEl)) {
            state.panel = null
            mountPanel(state.hostEl, route)
            return
        }

        const payload = Object.assign({
            routeId: route || null,
            accountCtx: state.accountCtx
        }, extra || {})

        try {
            if (typeof state.panel.update === "function") {
                state.panel.update(payload)
            } else if (typeof state.panel.setProps === "function") {
                state.panel.setProps(payload)
            } else {
                if (typeof state.panel.unmount === "function") state.panel.unmount()
                state.panel = null
                mountPanel(state.hostEl, route)
            }
        } catch (err) {
            logWarn("RoutePanel update failed; remounting mock fallback", err)
            state.panel = null
            state.hostEl.textContent = ""
            mountPanel(state.hostEl, route)
        }
    }

    function loadPricingContext(route) {
        if (!route || !route.origin || !route.destination) return
        if (!window.AesPriceDiagnostics || typeof window.AesPriceDiagnostics.buildRouteContext !== "function") return
        const seq = ++state.priceContextSeq
        const snapshot = Object.assign({}, route)
        window.AesPriceDiagnostics.buildRouteContext(snapshot.origin, snapshot.destination)
            .then(function (ctx) {
                if (seq !== state.priceContextSeq) return
                if (!sameRoute(snapshot, state.selectedRoute)) return
                updatePanel(snapshot, {pricingContext: ctx || null})
            })
            .catch(function (err) {
                logWarn("pricing context load failed", err)
            })
    }

    function ensureHost(dashboardEl) {
        if (!dashboardEl) return null
        let host = dashboardEl.querySelector("#" + HOST_ID)
        if (!host) {
            host = document.createElement("div")
            host.id = HOST_ID
            host.className = "aes-managing-routes-panel-host"
            host.dataset.aesFeature = "managing-routes"
            host.dataset.mount = "route-panel"
        }
        const tableWrap = dashboardEl.querySelector("#aes-div-routeManagement")
        if (tableWrap && host.nextElementSibling !== tableWrap) {
            dashboardEl.insertBefore(host, tableWrap)
        } else if (!host.parentNode) {
            dashboardEl.appendChild(host)
        }
        return host
    }

    function setSelectedRoute(route, source) {
        if (!route) return
        const changed = !sameRoute(route, state.selectedRoute)
        state.selectedRoute = route
        markActiveRow(route)
        if (!state.panel || !state.hostEl) return
        if (changed || source === "account") {
            updatePanel(route)
            loadPricingContext(route)
        }
    }

    function setSelectedFromRow(row) {
        const route = routeFromRow(row)
        if (route) setSelectedRoute(route, "dom")
    }

    function installDashboardListeners(dashboardEl) {
        if (!dashboardEl || state.dashboardListenersInstalledOn === dashboardEl) return
        if (state.dashboardListenersInstalledOn) {
            state.dashboardListenersInstalledOn.removeEventListener("click", onDashboardClick, true)
            state.dashboardListenersInstalledOn.removeEventListener("change", onDashboardChange, true)
        }
        dashboardEl.addEventListener("click", onDashboardClick, true)
        dashboardEl.addEventListener("change", onDashboardChange, true)
        state.dashboardListenersInstalledOn = dashboardEl
    }

    function onDashboardClick(event) {
        const row = event.target && event.target.closest
            ? event.target.closest("#aes-table-routeManagement tbody tr")
            : null
        if (row) setSelectedFromRow(row)
    }

    function onDashboardChange(event) {
        const target = event.target
        if (!target || !target.matches || !target.matches("#aes-table-routeManagement tbody input[type='checkbox']")) return
        const row = target.closest("tr")
        if (target.checked && row) {
            setSelectedFromRow(row)
            return
        }
        if (row && state.selectedRoute && rowMatchesRoute(row, state.selectedRoute)) {
            scheduleSync("checkbox-change")
        }
    }

    function sync(reason) {
        state.syncTimer = null
        const dashboardEl = document.getElementById("aes-div-dashboard-routeManagement")
        const table = tableEl()

        if (!dashboardEl || !table) {
            state.dashboardEl = null
            state.hostEl = null
            return
        }

        state.dashboardEl = dashboardEl
        installDashboardListeners(dashboardEl)
        const hostEl = ensureHost(dashboardEl)
        const hostChanged = hostEl !== state.hostEl
        state.hostEl = hostEl

        let route = resolveSelectedRoute()
        if (!route) {
            route = null
        }

        const routeChanged = !sameRoute(route, state.selectedRoute)
        if (!state.panel || hostChanged) {
            mountPanel(hostEl, route)
        } else if (routeChanged) {
            updatePanel(route)
        }

        state.selectedRoute = route
        if (route) markActiveRow(route)
        if (route && (hostChanged || routeChanged)) loadPricingContext(route)
    }

    function scheduleSync(reason) {
        if (state.syncTimer) return
        state.syncTimer = setTimeout(function () { sync(reason) }, 50)
    }

    function normalizeBusRecord(record) {
        if (!record || typeof record !== "object") return {}
        if (record.payload && typeof record.payload === "object" && !record.action && !record.routeId) {
            return record.payload
        }
        return record
    }

    function coerceRoutes(payload) {
        if (!payload) return []
        const list = []
        if (Array.isArray(payload.routes)) list.push.apply(list, payload.routes)
        if (payload.routeId) list.push(payload.routeId)
        if (payload.route) list.push(payload.route)
        return list.filter(Boolean)
    }

    function selectRouteFromCommand(payload) {
        const routesToSelect = coerceRoutes(payload)
        const route = routesToSelect[0]
        const row = route ? findRowForRoute(route) : firstSelectedRow()
        if (!row) return
        const checkbox = row.querySelector("input[type='checkbox']")
        if (checkbox) checkbox.checked = true
        setSelectedFromRow(row)
    }

    function deselectRouteFromCommand(payload) {
        const routesToDeselect = coerceRoutes(payload)
        const affectedRows = routesToDeselect.length
            ? routesToDeselect.map(findRowForRoute).filter(Boolean)
            : rows()
        affectedRows.forEach(function (row) {
            const checkbox = row.querySelector("input[type='checkbox']")
            if (checkbox) checkbox.checked = false
            row.classList.remove(ACTIVE_ROW_CLASS)
        })
        scheduleSync("route-command-deselect")
    }

    function hideRoutesFromCommand(payload) {
        const routesToHide = coerceRoutes(payload)
        const affectedRows = routesToHide.length
            ? routesToHide.map(findRowForRoute).filter(Boolean)
            : rows().filter(function (row) {
                const checkbox = row.querySelector("input[type='checkbox']")
                return checkbox && checkbox.checked
            })
        affectedRows.forEach(function (row) { row.remove() })
        scheduleSync("route-command-hide")
    }

    function urlsForCommandRoutes(payload) {
        let selectedRoutes = coerceRoutes(payload)
        if (!selectedRoutes.length && state.selectedRoute) selectedRoutes = [state.selectedRoute]
        if (!selectedRoutes.length) {
            selectedRoutes = rows().filter(function (row) {
                const checkbox = row.querySelector("input[type='checkbox']")
                return checkbox && checkbox.checked
            }).map(routeFromRow).filter(Boolean)
        }
        const server = (state.accountCtx && state.accountCtx.serverId) || (function () {
            try { return AES.getServerName() } catch (_) { return window.location.hostname.split(".")[0] }
        })()
        return selectedRoutes.map(function (route) {
            const key = normalizeRouteKey(route.routeKey || route.marketId || route.origin + route.destination)
            return key ? "https://" + server + ".airlinesim.aero/app/com/inventory/" + key : null
        }).filter(Boolean)
    }

    function pricingUrlsForCommandRoutes(payload) {
        let selectedRoutes = coerceRoutes(payload)
        if (!selectedRoutes.length && state.selectedRoute) selectedRoutes = [state.selectedRoute]
        if (!selectedRoutes.length) {
            selectedRoutes = rows().filter(function (row) {
                const checkbox = row.querySelector("input[type='checkbox']")
                return checkbox && checkbox.checked
            }).map(routeFromRow).filter(Boolean)
        }
        const server = (state.accountCtx && state.accountCtx.serverId) || (function () {
            try { return AES.getServerName() } catch (_) { return window.location.hostname.split(".")[0] }
        })()
        return selectedRoutes.map(function (route) {
            const key = normalizeRouteKey(route.routeKey || route.marketId || route.origin + route.destination)
            return key ? "https://" + server + ".airlinesim.aero/app/com/markets/" + key : null
        }).filter(Boolean)
    }

    function openInventory(payload) {
        urlsForCommandRoutes(payload).slice(0, 10).forEach(function (url) {
            window.open(url, "_blank")
        })
    }

    function openPricing(payload) {
        pricingUrlsForCommandRoutes(payload).slice(0, 10).forEach(function (url) {
            window.open(url, "_blank")
        })
    }

    function openSchedule() {
        const anchor = document.querySelector("#enterprise-dashboard table tfoot td a[href*='tab=3']")
            || document.querySelector("a[href*='/app/info/enterprises/'][href*='tab=3']")
        if (anchor && anchor.href) {
            window.open(anchor.href, "_blank")
            return
        }
        const host = window.location.host
        window.open("https://" + host + "/app/info/enterprises/me?tab=3", "_blank")
    }

    function handleRouteCommand(record) {
        const payload = normalizeBusRecord(record)
        const action = payload.action || payload.command || payload.type
        switch (action) {
            case "select":
                selectRouteFromCommand(payload)
                break
            case "deselect":
                deselectRouteFromCommand(payload)
                break
            case "hide":
                hideRoutesFromCommand(payload)
                break
            case "openInventory":
                openInventory(payload)
                break
            case "openPricing":
                openPricing(payload)
                break
            case "openSchedule":
                openSchedule(payload)
                break
            case "refresh":
            case "recompute":
                scheduleSync("route-command-" + action)
                break
            case "createRoute":
                window.open("https://" + window.location.host + "/app/com/createRoute", "_blank")
                break
            default:
                if (action) logWarn("unhandled ROUTE_COMMAND action", action)
        }
    }

    function handleRoutePanelAction(record) {
        const payload = normalizeBusRecord(record)
        if (payload.routeId) {
            const row = findRowForRoute(payload.routeId)
            if (row) setSelectedFromRow(row)
        }
        if (payload.action === "ors.open") {
            openInventory({routeId: payload.routeId || state.selectedRoute})
            return
        }
        if (payload.action === "ors.refresh"
                || payload.action === "price.update"
                || payload.action === "service.tweak"
                || payload.action === "fleet.swap"
                || (payload.action && String(payload.action).indexOf("expense.") === 0)) {
            updatePanel(state.selectedRoute, {
                fixtureData: fixtureFor(state.selectedRoute, state.accountCtx)
            })
        }
    }

    function handleAccountSwitch(record) {
        const payload = normalizeBusRecord(record)
        state.accountCtx = readAccountCtx(payload)
        updatePanel(state.selectedRoute, {accountCtx: state.accountCtx})
        scheduleSync("account-switch")
    }

    function subscribeBusTopic(topic, handler) {
        const bus = window.AesDataBus || window.AesBus || null
        if (!bus) return
        try {
            if (typeof bus.register === "function") {
                bus.register(topic, {owner: "managing-routes", surface: "dashboard"})
            }
        } catch (_) { /* noop */ }
        if (typeof bus.on === "function") {
            state.disposers.push(bus.on(topic, handler))
        } else if (typeof bus.subscribe === "function") {
            state.disposers.push(bus.subscribe(topic, handler))
        }
    }

    function subscribeBus() {
        subscribeBusTopic(TOPIC_ACCOUNT_SWITCHED, handleAccountSwitch)
        subscribeBusTopic(TOPIC_ACCOUNT_BOOTSTRAPPED, handleAccountSwitch)
        subscribeBusTopic(TOPIC_ROUTE_PANEL_ACTION, handleRoutePanelAction)
        subscribeBusTopic(TOPIC_ROUTE_COMMAND, handleRouteCommand)
    }

    function patchHistory() {
        if (state.historyPatched || !window.history) return
        state.historyPatched = true
        ;["pushState", "replaceState"].forEach(function (name) {
            const original = window.history[name]
            if (typeof original !== "function") return
            window.history[name] = function () {
                const out = original.apply(this, arguments)
                scheduleSync("history-" + name)
                return out
            }
        })
        window.addEventListener("popstate", function () { scheduleSync("popstate") })
        window.addEventListener("hashchange", function () { scheduleSync("hashchange") })
    }

    function observeDom() {
        if (!document.body) return
        const observer = new MutationObserver(function (mutations) {
            for (const mutation of mutations) {
                if (mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length)) {
                    scheduleSync("dom")
                    return
                }
            }
        })
        observer.observe(document.body, {childList: true, subtree: true})
        state.observers.push(observer)
    }

    function installPageStyle() {
        if (document.getElementById("aes-managing-routes-host-style")) return
        const style = document.createElement("style")
        style.id = "aes-managing-routes-host-style"
        style.textContent = [
            "#aes-table-routeManagement tbody tr." + ACTIVE_ROW_CLASS + " > td{background:#eef6ff!important;box-shadow:inset 3px 0 0 #2563eb}",
            "#" + HOST_ID + "{clear:both}"
        ].join("\n")
        ;(document.head || document.documentElement).appendChild(style)
    }

    function boot() {
        state.accountCtx = readAccountCtx()
        installPageStyle()
        subscribeBus()
        patchHistory()
        observeDom()
        scheduleSync("boot")
        window.__aesManagingRoutesHost = {
            sync: function () { sync("manual") },
            state: state,
            readSelectedRoute: function () { return state.selectedRoute },
            readAccountCtx: function () { return state.accountCtx }
        }
    }

    ready(boot)
})()
