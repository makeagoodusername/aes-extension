"use strict"

/**
 * Smoke for modules/competitor-intel/iata-backfill-store.js — pure
 * helpers (_normIata, _normEnterpriseId, projectFromEnterprises,
 * projectFromEdges) plus an in-memory storage round-trip.
 *
 * The production module reads `chrome.storage.local`; the sandbox below
 * substitutes a plain Map-backed shim that mirrors the get/set/remove
 * subset the module actually uses.
 *
 * Lives in audit-jihwan/tests/ because audit/tests/competitor-intel/ is
 * root-owned in this checkout and not writable from the jihwan account.
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

function load(filename, sandbox) {
    const src = fs.readFileSync(path.resolve(__dirname, "../../..", filename), "utf8")
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, {filename})
}

function makeChromeStorage() {
    const store = new Map()
    return {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) {
                        const out = {}
                        for (const [k, v] of store) out[k] = v
                        return out
                    }
                    if (typeof keys === "string") {
                        return store.has(keys) ? {[keys]: store.get(keys)} : {}
                    }
                    if (Array.isArray(keys)) {
                        const out = {}
                        for (const k of keys) if (store.has(k)) out[k] = store.get(k)
                        return out
                    }
                    throw new Error("unexpected get arg shape")
                },
                async set(obj) {
                    for (const k in obj) store.set(k, obj[k])
                }
            }
        },
        _store: store
    }
}

const sb = {
    window: {},
    chrome: makeChromeStorage(),
    Symbol, Date, Math, Object, String, Number,
    location: {search: ""},
    console
}
load("modules/competitor-intel/iata-backfill-store.js", sb)
const ns = sb.window.AesCompetitorIataBackfill
assert.ok(ns, "module exports AesCompetitorIataBackfill")

let asserts = 0
const A = (cond, msg) => { assert.ok(cond, msg); asserts++ }
const E = (a, b, msg) => { assert.equal(a, b, msg); asserts++ }
const D = (a, b, msg) => { assert.deepEqual(a, b, msg); asserts++ }

// ---------- pure helpers ----------

E(ns._normIata("ba"), "BA", "normIata uppercases")
E(ns._normIata("WWW"), "WWW", "normIata accepts 3-char")
E(ns._normIata(" lh "), "LH", "normIata trims")
E(ns._normIata("xyzz"), null, "normIata rejects 4-char")
E(ns._normIata("a"), null, "normIata rejects 1-char")
E(ns._normIata(null), null, "normIata rejects null")
E(ns._normIata(""), null, "normIata rejects empty")

E(ns._normEnterpriseId("12345"), "12345", "normId accepts numeric string")
E(ns._normEnterpriseId(12345), "12345", "normId stringifies number")
E(ns._normEnterpriseId("iata:BA"), null, "normId rejects synthetic iata:")
E(ns._normEnterpriseId(null), null, "normId rejects null")
E(ns._normEnterpriseId(""), null, "normId rejects empty")

// ---------- projectFromEnterprises ----------

const ents = new Map([
    ["77",  {enterpriseId: "77",  iata: "BA",  name: "British Airways"}],
    ["88",  {enterpriseId: "88",  iata: "lh",  name: "Lufthansa"}],
    ["iata:WWW", {enterpriseId: "iata:WWW", iata: "WWW", name: "Wings"}],
    ["55",  {enterpriseId: "55",  iata: "1",   name: "Bad code"}],
    ["33",  {enterpriseId: "33",  name: "No iata"}]
])
const triples = ns.projectFromEnterprises(ents)
E(triples.length, 2, "projectFromEnterprises skips synthetic id, missing iata, bad iata")
D(triples.map(t => t.iata).sort(), ["BA", "LH"], "extracted both real entries")

// ---------- projectFromEdges ----------

const edges = new Map([
    ["LHR-JFK", {competitors: [
        {iata: "ba", enterpriseId: "77",  name: "British Airways"},
        {iata: "AA", enterpriseId: "99",  name: "American"},
        {iata: "WWW", enterpriseId: null}
    ]}],
    ["LHR-CDG", {competitors: [
        {iata: "BA", enterpriseId: "77"},
        {iata: "AF", enterpriseId: "44",  name: "Air France"}
    ]}]
])
const fromEdges = ns.projectFromEdges(edges)
D(fromEdges.map(t => t.iata).sort(), ["AA", "AF", "BA"], "edge projection dedupes by iata")

// ---------- storage round-trip ----------

;(async () => {
    const SERVER = "test-server"

    let blob = await ns.load(SERVER)
    D(blob.byIata, {}, "fresh load is empty")

    E(await ns.record(SERVER, "BA", "77", "British Airways"), true, "first record returns true")
    blob = await ns.load(SERVER)
    E(blob.byIata.BA.enterpriseId, "77", "record persists")
    E(blob.byIata.BA.name, "British Airways", "name persists")
    A(blob.byIata.BA.lastSeenAt > 0, "lastSeenAt set")

    E(await ns.record(SERVER, "BA", "77", "British Airways"), false, "duplicate record returns false within 24h")
    E(await ns.record(SERVER, "BA", "78", "British Airways v2"), true, "id change returns true")
    blob = await ns.load(SERVER)
    E(blob.byIata.BA.enterpriseId, "78", "id update persists")

    const seeded = await ns.bulkSeed(SERVER, [
        {iata: "AA", enterpriseId: "99", name: "American"},
        {iata: "AF", enterpriseId: "44", name: "Air France"},
        {iata: "BA", enterpriseId: "78", name: "British Airways v2"},  // unchanged within 24h
        {iata: "WWW", enterpriseId: "iata:WWW"},  // rejected
        {iata: "X", enterpriseId: "1"}  // bad iata
    ])
    E(seeded, 2, "bulkSeed counts only new entries")

    const all = await ns.loadAll(SERVER)
    E(all.size, 3, "three entries after bulkSeed")
    D(Array.from(all.keys()).sort(), ["AA", "AF", "BA"], "expected codes")

    const hit = await ns.lookup(SERVER, "ba")
    E(hit.enterpriseId, "78", "lookup case-insensitive")
    E(await ns.lookup(SERVER, "ZZ"), null, "lookup returns null on miss")

    E(await ns.record(null, "BA", "77"), false, "no server → false")
    E(await ns.record(SERVER, "", "77"), false, "no iata → false")
    E(await ns.record(SERVER, "BA", "iata:BA"), false, "synthetic id → false")

    console.log("ok — iata-backfill-store smoke: " + asserts + " assertions")
})().catch(e => {
    console.error("FAIL", e)
    process.exit(1)
})
