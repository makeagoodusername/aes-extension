"use strict"

/**
 * AES Command Registry — id-keyed list of palette-dispatchable actions.
 *
 * Mirrors the shape of `AESShortcutRegistry` (modules/customization/shortcut-registry.js):
 * an id-keyed default list plus a tiny resolver. Unlike the shortcut registry
 * the command set is built at runtime via `register()` calls from the seed
 * files (and any future caller); there's no static DEFAULTS array because the
 * command catalogue grows organically as new modules ship palette entries.
 *
 * Public API (window.AESCommandRegistry):
 *   register({id, scope, label, hint?, keywords?, run, available?}) → unregister
 *   list({scope?, query?}) → ordered Command[] (filtered by scope, then by query)
 *   dispatch(id) → Promise<{ok, error?}>  (also pushes id onto the recent ring)
 *   recent() → string[]  (most-recent-first; resolved from chrome.storage)
 *   subscribe(cb) → unsubscribe   (fires on register/unregister/dispatch)
 *
 * **Command shape:**
 *   id         "open.strategy"                    stable, dot-namespaced
 *   scope      "any" | "dashboard" | "scheduling" | "fleets" | "afp"
 *   label      "Open Strategy"                    short imperative
 *   hint       "Strategy modal — decisions, …"    one-line subtitle (optional)
 *   keywords   ["strat", "decisions", "plan"]     extra match terms (optional)
 *   priority   0                                  optional ranking boost
 *   run        () => void | Promise<void>         the action
 *   available  () => boolean                      gate (defaults to () => true)
 *
 * **Scopes** — a command's `scope` is the surface it belongs to. The palette
 * filters `list()` against the current page (resolved by host.js from
 * `location.pathname`); commands with `scope: "any"` always show. Cross-page
 * navigation commands use "any"; page-specific actions use the matching scope.
 *
 * **Query matching** — case-insensitive substring across `label + hint +
 * keywords`. Commands with all query words found rank above partial matches.
 * Recency boost: if a command was invoked recently, it sorts above non-recent
 * peers within the same match tier. No fuzzy matching in v1 — the seed of
 * 9–10 commands doesn't need it.
 *
 * **Recent ring** — capped at 8, persisted per-account at
 * `commandPalette:recent:acct:<id>` (or unscoped `commandPalette:recent` if
 * no account context). Each entry is `{id, ts}`. The ring is the source of
 * truth for "what showed up last time the user opened the palette" and is
 * intentionally tiny — losing it across reloads is fine, the user just
 * loses one cycle of recency bias.
 *
 * **Idempotent.** Re-registering an id replaces the prior entry (lets seed
 * files re-run on hot reload without leaking duplicates). The unsubscribe
 * function returned by `register()` removes only that exact registration.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AESCommandRegistry) return

    const RECENT_CAP = 8
    const RECENT_KEY_BASE = "commandPalette:recent"

    const byId = new Map()         // id → command
    const subs = new Set()         // cb
    let recentCache = []           // [{id, ts}]  newest-first
    let recentLoaded = false
    let recentLoading = null       // Promise during async load

    function notifySubs(kind, payload) {
        for (const cb of Array.from(subs)) {
            try { cb({kind, payload}) }
            catch (e) { console.warn("[AES command-registry] subscriber threw", e) }
        }
    }

    function register(cmd) {
        if (!cmd || typeof cmd.id !== "string" || !cmd.id) return () => {}
        if (typeof cmd.run !== "function") return () => {}
        const entry = {
            id:        cmd.id,
            scope:     cmd.scope || "any",
            label:     String(cmd.label || cmd.id),
            hint:      cmd.hint ? String(cmd.hint) : "",
            keywords:  Array.isArray(cmd.keywords)
                ? cmd.keywords.filter(k => typeof k === "string")
                : [],
            priority:  Number.isFinite(Number(cmd.priority)) ? Number(cmd.priority) : 0,
            run:       cmd.run,
            available: typeof cmd.available === "function" ? cmd.available : () => true
        }
        byId.set(entry.id, entry)
        notifySubs("registered", entry)
        return function unregister() {
            const cur = byId.get(entry.id)
            if (cur === entry) {
                byId.delete(entry.id)
                notifySubs("unregistered", entry)
            }
        }
    }

    function _legacyScoreCommand(cmd, queryWords) {
        if (!queryWords.length) return 1
        const haystack = (cmd.label + " " + cmd.hint + " " + cmd.keywords.join(" ")).toLowerCase()
        let score = 0
        for (const w of queryWords) {
            const i = haystack.indexOf(w)
            if (i < 0) return 0
            score += (i === 0) ? 4 : (i < cmd.label.length ? 3 : 1)
        }
        return score
    }

    // Use the shared subsequence scorer when available; fall back to the legacy
    // substring scorer on cold paths where fuzzy.js isn't loaded yet (e.g.
    // service-worker reuse). Either path returns a comparable scalar.
    function _scoreCommand(cmd, query, currentScope) {
        if (window.AESPaletteFuzzy && typeof window.AESPaletteFuzzy.score === "function") {
            return window.AESPaletteFuzzy.score(query, null, {
                label: cmd.label,
                hint: cmd.hint,
                keywords: cmd.keywords,
                isCurrentScope: currentScope && cmd.scope !== "any" && cmd.scope === currentScope,
                prefixBoost: true
            })
        }
        const queryWords = query ? query.split(/\s+/).filter(Boolean) : []
        return _legacyScoreCommand(cmd, queryWords)
    }

    function list(opts) {
        opts = opts || {}
        const scope = opts.scope || "any"
        const scopeBias = opts.scopeBias !== false   // default true: bias to current scope
        const query = (opts.query || "").trim().toLowerCase()
        const out = []
        for (const cmd of byId.values()) {
            if (cmd.scope !== "any" && scope !== "any" && cmd.scope !== scope) continue
            try { if (!cmd.available()) continue }
            catch (e) { console.warn("[AES command-registry] available() threw", cmd.id, e); continue }
            const score = _scoreCommand(cmd, query, scopeBias ? scope : null)
            if (!score) continue
            out.push({cmd, score: score + cmd.priority})
        }
        const recentRanks = new Map()
        const recentIds = recentCache.map(r => r.id)
        for (let i = 0; i < recentIds.length; i++) recentRanks.set(recentIds[i], recentIds.length - i)
        out.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            const ra = recentRanks.get(a.cmd.id) || 0
            const rb = recentRanks.get(b.cmd.id) || 0
            if (rb !== ra) return rb - ra
            return a.cmd.label.localeCompare(b.cmd.label)
        })
        return out.map(o => o.cmd)
    }

    async function dispatch(id) {
        const cmd = byId.get(id)
        if (!cmd) return {ok: false, error: "unknown-command"}
        try {
            if (!cmd.available()) return {ok: false, error: "unavailable"}
        } catch (e) { return {ok: false, error: "available-threw"} }
        try {
            const r = cmd.run()
            if (r && typeof r.then === "function") await r
        } catch (e) {
            console.warn("[AES command-registry] run() threw", id, e)
            notifySubs("dispatched", {id, ok: false, error: String(e && e.message || e)})
            return {ok: false, error: String(e && e.message || e)}
        }
        _pushRecent(id)
        notifySubs("dispatched", {id, ok: true})
        return {ok: true}
    }

    function _pushRecent(id) {
        const now = Date.now()
        recentCache = [{id, ts: now}].concat(recentCache.filter(r => r.id !== id))
        if (recentCache.length > RECENT_CAP) recentCache.length = RECENT_CAP
        _persistRecent()
    }

    function _accountKey() {
        const acct = (typeof window !== "undefined") ? window.__aesAccountId : null
        return acct ? (RECENT_KEY_BASE + ":acct:" + acct) : RECENT_KEY_BASE
    }

    function _persistRecent() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return
        const key = _accountKey()
        try { chrome.storage.local.set({[key]: recentCache}) }
        catch (_) { /* storage may be unavailable in worker contexts */ }
    }

    async function _loadRecent() {
        if (recentLoaded) return recentCache
        if (recentLoading) return recentLoading
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            recentLoaded = true
            return recentCache
        }
        recentLoading = new Promise(resolve => {
            const key = _accountKey()
            try {
                chrome.storage.local.get([key], (out) => {
                    const v = out && out[key]
                    if (Array.isArray(v)) {
                        recentCache = v.filter(r => r && typeof r.id === "string").slice(0, RECENT_CAP)
                    }
                    recentLoaded = true
                    resolve(recentCache)
                })
            } catch (_) { recentLoaded = true; resolve(recentCache) }
        })
        return recentLoading
    }

    function recent() {
        return recentCache.slice()
    }

    function subscribe(cb) {
        if (typeof cb !== "function") return () => {}
        subs.add(cb)
        return () => subs.delete(cb)
    }

    _loadRecent().catch(() => {})

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== "local") return
                const key = _accountKey()
                if (!changes[key]) return
                const v = changes[key].newValue
                if (Array.isArray(v)) {
                    recentCache = v.filter(r => r && typeof r.id === "string").slice(0, RECENT_CAP)
                    notifySubs("recent-updated", recentCache.slice())
                }
            })
        } catch (_) { /* permission boundary */ }
    }

    window.AESCommandRegistry = {register, list, dispatch, recent, subscribe}
})()
