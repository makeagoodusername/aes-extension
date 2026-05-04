"use strict";

/**
 * Node-runnable smoke for modules/command-palette/fuzzy.js.
 *
 *   node audit/tests/command-palette/fuzzy.test.js
 *
 * Loads fuzzy.js inside a synthetic global (it self-installs via
 * `window.AESPaletteFuzzy = ...`), then exercises subsequence matching,
 * scope bias, and prefix bonuses. Exits 0 if all assertions hold.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.resolve(__dirname, "../../../modules/command-palette/fuzzy.js");
const src = fs.readFileSync(file, "utf8");

const sandbox = {window: {}, console};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const fuzzy = sandbox.window.AESPaletteFuzzy;
if (!fuzzy) { console.error("FAIL: AESPaletteFuzzy not installed"); process.exit(1); }

let failures = 0;
function assert(cond, label) {
    if (cond) { console.log("PASS:", label); return; }
    console.error("FAIL:", label);
    failures++;
}

// 1. Empty query returns neutral baseline > 0
assert(fuzzy.score("", null, {label: "Open Strategy"}) > 0,
    "empty query yields baseline > 0");

// 2. Subsequence: 'strt' matches 'Open Strategy'
const sStrt = fuzzy.score("strt", null, {label: "Open Strategy", hint: "", keywords: []});
assert(sStrt > 0, "'strt' subsequence-matches 'Open Strategy'");

// 3. Same query, no match against unrelated label
const sStrtNeg = fuzzy.score("strt", null, {label: "Open Accounting", hint: "", keywords: []});
assert(sStrtNeg === 0, "'strt' yields 0 against 'Open Accounting'");

// 4. Prefix beats mid-string
const prefix = fuzzy.score("op", null, {label: "Open Strategy", hint: "", keywords: []});
const mid    = fuzzy.score("op", null, {label: "Stop Plan",     hint: "", keywords: []});
assert(prefix > mid, "prefix match outranks mid-string match");

// 5. Scope bias adds points
const baseScope = fuzzy.score("op", null, {label: "Open Strategy", isCurrentScope: false});
const lifted    = fuzzy.score("op", null, {label: "Open Strategy", isCurrentScope: true});
assert(lifted > baseScope, "isCurrentScope bias adds points");

// 6. Token order is order-independent across multi-word query
const a = fuzzy.score("open strat", null, {label: "Open Strategy", hint: "", keywords: []});
const b = fuzzy.score("strat open", null, {label: "Open Strategy", hint: "", keywords: []});
assert(a > 0 && b > 0, "multi-word query scores > 0 in both orders");

// 7. tokenize splits on whitespace, hyphen, dot, slash
const tk = fuzzy.tokenize("open-strategy.foo bar/baz");
assert(tk.length === 5 && tk[0] === "open" && tk[4] === "baz", "tokenize splits on common boundaries");

// 8. All-token requirement: missing token zeroes the score
const partial = fuzzy.score("open zzzzzz", null, {label: "Open Strategy", hint: "", keywords: []});
assert(partial === 0, "missing token zeroes the score");

if (failures) {
    console.error("\n" + failures + " failure(s)");
    process.exit(1);
}
console.log("\nfuzzy.test.js — all assertions passed");
