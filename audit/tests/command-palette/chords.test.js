"use strict";

/**
 * Node-runnable smoke for modules/command-palette/chord-buffer.js.
 *
 *   node audit/tests/command-palette/chords.test.js
 *
 * Loads chord-buffer.js inside a synthetic DOM-ish global so the
 * `document.addEventListener("keydown", ...)` registration succeeds.
 * Then dispatches synthetic keydown events and checks that registered
 * chord runs fire.
 *
 * The smoke does NOT exercise the 1.2s timeout (would block CI). It
 * checks that:
 *   - a 2-key sequence matches when keys arrive contiguously
 *   - a non-prefix key resets the buffer
 *   - typing in an INPUT target does not fire chords
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Tiny event registry that lets us synthesize keydown.
const listeners = [];
const fakeDoc = {
    addEventListener(type, fn /*, capture */) {
        if (type === "keydown") listeners.push(fn);
    },
    removeEventListener() { /* noop */ }
};

function dispatch(key, target) {
    const e = {
        key: key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: target || null,
        preventDefault() { this._prev = true; },
        stopPropagation() {}
    };
    for (const fn of listeners) fn(e);
    return e;
}

const sandbox = {window: {}, document: fakeDoc, console, setTimeout, clearTimeout};
vm.createContext(sandbox);
const file = path.resolve(__dirname, "../../../modules/command-palette/chord-buffer.js");
vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);

const chords = sandbox.window.AESPaletteChords;
if (!chords) { console.error("FAIL: AESPaletteChords not installed"); process.exit(1); }

let failures = 0;
function assert(cond, label) {
    if (cond) { console.log("PASS:", label); return; }
    console.error("FAIL:", label);
    failures++;
}

// Register a couple of chords
let ggFired = 0, gsFired = 0;
chords.register({id: "test:g-g", sequence: ["g", "g"], run() { ggFired++; }});
chords.register({id: "test:g-s", sequence: ["g", "s"], run() { gsFired++; }});

// 1. registered() reflects registrations
assert(chords.registered().length === 2, "registered() returns 2 chords");

// 2. 'g' then 'g' fires g-g
dispatch("g");
dispatch("g");
assert(ggFired === 1, "'g g' fires g-g once");
assert(gsFired === 0, "g-s did not fire on g-g");

// 3. 'g' then 's' fires g-s
dispatch("g");
dispatch("s");
assert(gsFired === 1, "'g s' fires g-s");

// 4. Random non-prefix key after 'g' resets buffer (no fire on next 'g')
dispatch("g");
dispatch("z");   // not a chord prefix → buffer drops
dispatch("g");   // fresh first key, should not immediately fire
assert(ggFired === 1, "non-prefix key resets buffer; subsequent 'g' alone does not fire");

// 5. Typing in an INPUT target does not fire
dispatch("g", {tagName: "INPUT"});
dispatch("g", {tagName: "INPUT"});
assert(ggFired === 1, "chord ignored while typing in input");

// 6. Modifier-with-key does not enter the buffer
const e = {key: "g", ctrlKey: true, metaKey: false, altKey: false, target: null, preventDefault(){}, stopPropagation(){}};
for (const fn of listeners) fn(e);
dispatch("g");  // single 'g' alone shouldn't fire
assert(ggFired === 1, "modifier-key combinations bypass the buffer");

if (failures) {
    console.error("\n" + failures + " failure(s)");
    process.exit(1);
}
console.log("\nchords.test.js — all assertions passed");
