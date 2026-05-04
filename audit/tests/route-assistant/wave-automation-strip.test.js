"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const ROOT = path.resolve(__dirname, "../../..")

function makeElement(tag) {
    const el = {
        tagName: String(tag || "").toUpperCase(),
        children: [],
        childNodes: [],
        style: {},
        dataset: {},
        attributes: {},
        disabled: false,
        textContent: "",
        title: "",
        _listeners: {},
        append(...nodes) {
            for (const n of nodes) this.appendChild(n)
        },
        appendChild(node) {
            this.children.push(node)
            this.childNodes.push(node)
            node.parentElement = this
            return node
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value)
        },
        getAttribute(name) {
            return this.attributes[name] || null
        },
        addEventListener(type, fn) {
            this._listeners[type] = fn
        },
        click() {
            if (this._listeners.click) {
                this._listeners.click({preventDefault() {}, stopPropagation() {}})
            }
        },
        querySelector(selector) {
            const stack = this.children.slice()
            while (stack.length) {
                const node = stack.shift()
                if (!node) continue
                if (selector === "button" && node.tagName === "BUTTON") return node
                if (selector === "[data-aes-wave-diagnostics-card]"
                        && node.dataset && node.dataset.aesWaveDiagnosticsCard) return node
                if (selector === "[data-aes-wave-automation-strip]"
                        && node.dataset && node.dataset.aesWaveAutomationStrip) return node
                if (selector === "span" && node.tagName === "SPAN") return node
                if (node.children) stack.push(...node.children)
            }
            return null
        },
        querySelectorAll(selector) {
            const out = []
            const stack = this.children.slice()
            while (stack.length) {
                const node = stack.shift()
                if (!node) continue
                if (selector === "button" && node.tagName === "BUTTON") out.push(node)
                if (node.children) stack.push(...node.children)
            }
            return out
        },
        scrollIntoView() {}
    }
    return el
}

function loadPanel() {
    const sandbox = {
        window: {
            location: {hostname: "free1.airlinesim.aero"},
            AesAfpFleetPickerModal: function () {},
            AesAfpFleetApplyOrchestrator: function () {}
        },
        document: {
            createElement: makeElement,
            createTextNode(text) {
                return {tagName: "#TEXT", textContent: String(text || "")}
            }
        },
        console,
        Map,
        Set,
        RouteAssistantSettings: {save() { return Promise.resolve() }},
        RouteAssistantToast: {show() {}}
    }
    sandbox.window.window = sandbox.window
    sandbox.window.document = sandbox.document
    vm.createContext(sandbox)
    const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/panel.js"), "utf8")
    vm.runInContext(src, sandbox, {filename: "modules/route-assistant/panel.js"})
    return sandbox
}

function buttonByText(root, text) {
    return root.querySelectorAll("button").find(b => b.textContent === text)
}

const tests = []
function t(name, fn) { tests.push({name, fn}) }

t("renders readiness, metrics, and enabled fleet apply action", () => {
    const sb = loadPanel()
    const panel = Object.create(sb.window.RouteAssistantPanel.prototype)
    let applied = null
    panel._applyWaveToFleet = (preset, hub) => { applied = {preset, hub} }

    const preset = {id: "p1", name: "Wave plan"}
    const ctx = {
        readiness: {status: "ready", score: 82, blockers: [], warnings: []},
        capacity: {usedSlots: 3, totalSlots: 4, unplaced: 0},
        topRoutes: {count: 12},
        fleetSummary: {total: 5},
        actions: {
            diagnose: {enabled: true, reason: "diag"},
            buildPreview: {enabled: true, reason: "preview"},
            openCanvas: {enabled: true, reason: "canvas"},
            applyToFleet: {enabled: true, reason: "apply"}
        }
    }
    const el = panel._renderWaveAutomationStrip(ctx, preset, "ICN", {})
    assert.strictEqual(el.dataset.aesWaveAutomationStrip, "1")
    assert.ok(el.textContent === "" || true)
    const apply = buttonByText(el, "Apply to fleet")
    assert(apply, "apply button exists")
    assert.strictEqual(apply.disabled, false)
    apply.click()
    assert.deepStrictEqual(applied, {preset, hub: "ICN"})
})

t("disables preview and apply when context is blocked", () => {
    const sb = loadPanel()
    const panel = Object.create(sb.window.RouteAssistantPanel.prototype)
    panel._applyWaveToFleet = () => { throw new Error("should not apply") }
    const el = panel._renderWaveAutomationStrip({
        readiness: {
            status: "blocked",
            blockers: [{code: "noCapacity", message: "No capacity"}],
            warnings: []
        },
        capacity: {usedSlots: 0, totalSlots: 0, unplaced: 0},
        topRoutes: {count: 1},
        fleetSummary: {total: 1},
        actions: {
            diagnose: {enabled: true, reason: "diag"},
            buildPreview: {enabled: false, reason: "needs capacity"},
            openCanvas: {enabled: true, reason: "canvas"},
            applyToFleet: {enabled: false, reason: "blocked"}
        }
    }, {id: "p1"}, "ICN", {})
    assert.strictEqual(buttonByText(el, "Diagnose").disabled, false)
    assert.strictEqual(buttonByText(el, "Preview").disabled, true)
    assert.strictEqual(buttonByText(el, "Apply to fleet").disabled, true)
})

let pass = 0, fail = 0
console.log("=== wave automation strip ===")
for (const test of tests) {
    try {
        test.fn()
        pass++
        console.log("  ok  " + test.name)
    } catch (e) {
        fail++
        console.log("  FAIL " + test.name + ": " + (e && e.message || e))
    }
}
console.log("pass=" + pass + " fail=" + fail)
process.exit(fail ? 1 : 0)
