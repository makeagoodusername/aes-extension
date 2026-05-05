"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

function makeElement(tag) {
    return {
        tagName: String(tag || "").toUpperCase(),
        className: "",
        innerText: "",
        children: [],
        parentNode: null,
        append(child) {
            if (child) {
                child.parentNode = this
                this.children.push(child)
            }
        },
        prepend(child) {
            if (child) {
                child.parentNode = this
                this.children.unshift(child)
            }
        },
        insertBefore(child) {
            this.prepend(child)
        },
        remove() {
            if (!this.parentNode) return
            const idx = this.parentNode.children.indexOf(this)
            if (idx >= 0) this.parentNode.children.splice(idx, 1)
            this.parentNode = null
        }
    }
}

function installDom() {
    const body = makeElement("body")
    global.document = {
        body,
        createElement: makeElement,
        querySelector(selector) {
            if (selector !== ".feedbackPanel") return null
            return body.children.find(el => el.className === "feedbackPanel") || null
        }
    }
    global.window = global
    global.setTimeout = () => 0
    return {body}
}

function resetGlobals() {
    delete global.AesNotification
    delete global.AesNotifications
    delete global.aesNotify
    delete global.AesDataBus
}

function loadModule() {
    const src = fs.readFileSync(path.join(ROOT, "modules/_shared/notifications-api.js"), "utf8")
    eval(src)
}

let pass = 0
let fail = 0

function it(name, fn) {
    try {
        fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"))
    }
}

console.log("=== notifications-api ===")

it("exposes prefixed API without masking native Notification", () => {
    resetGlobals()
    installDom()
    function NativeNotification() {}
    global.Notification = NativeNotification
    loadModule()

    assert.strictEqual(global.Notification, NativeNotification)
    assert.strictEqual(typeof global.AesNotification, "function")
    assert.strictEqual(typeof global.AesNotifications, "function")
    assert.strictEqual(typeof global.aesNotify, "function")
})

it("renders AS feedbackPanel toast and emits registered bus topic", () => {
    resetGlobals()
    const {body} = installDom()
    const emitted = []
    global.AesDataBus = {
        emit(topic, payload) { emitted.push({topic, payload}) }
    }
    loadModule()

    const note = new global.AesNotifications().add("hello", {type: "warning", duration: 0})

    assert.strictEqual(body.children.length, 1)
    assert.strictEqual(body.children[0].className, "feedbackPanel")
    assert.strictEqual(body.children[0].children[0], note.element)
    assert.strictEqual(note.element.className, "feedbackPanelWARNING")
    assert.strictEqual(note.element.children[0].innerText, " hello")
    assert.strictEqual(emitted.length, 1)
    assert.strictEqual(emitted[0].topic, "data:notifications:posted")
    assert.strictEqual(emitted[0].payload.message, "hello")
    assert.strictEqual(emitted[0].payload.type, "warning")
    assert.strictEqual(typeof emitted[0].payload.ts, "number")
})

it("convenience helper reuses the existing feedback panel", () => {
    resetGlobals()
    const {body} = installDom()
    global.AesDataBus = {emit() {}}
    loadModule()

    global.aesNotify("one", {duration: 0})
    global.aesNotify("two", {type: "error", duration: 0})

    assert.strictEqual(body.children.length, 1)
    assert.strictEqual(body.children[0].children.length, 2)
    assert.strictEqual(body.children[0].children[1].className, "feedbackPanelERROR")
})

console.log("pass=" + pass + " fail=" + fail)
if (fail) process.exit(1)
