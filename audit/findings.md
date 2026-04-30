# Audit findings queue

Append new findings below using the format from `audit/README.md`. Status transitions: `OPEN` → `CLAIMED:N` → `FIXED` (or `WONTFIX`).

---

<!-- New findings appended below this line -->

## F-9223-001: bus-bridge auto-install bails silently when CentralHubBus / AesAfp.bus load later than bus-bridge
- Area: modules/_shared/bus-bridge.js + manifest.json (content_scripts ordering)
- Severity: P1
- Found by: port-9223
- Status: FIXED
- Fix: central-hub/bus.js + aircraft-flight-plan/host.js now self-call AesBusBridge.attachCentralHub({}) / attachAesAfp({}) immediately after creating their bus. Idempotent on re-entry via existing __aesBusBridge*Installed flags. Verified by: at port-9223/bridge.html, loading bus-bridge.js → CentralHubBus undefined → __aesBusBridgeCentralHubInstalled=false (auto-install bailed); then loading central-hub/bus.js → __aesBusBridgeCentralHubInstalled=true; CentralHubBus.emit("hub:focus", ...) forwarded to AesDataBus.on("data:central-hub:focus") with count=1.
- Repro: load the wildcard `_shared` block (bus-bridge.js:102 fires `Promise.resolve().then(() => attachCentralHub({}))` while `window.CentralHubBus` is still undefined), then load `modules/central-hub/bus.js` later in a dashboard-only block — the bridge's `__aesBusBridgeCentralHubInstalled` flag remains `false` for the rest of the tab. Verified at chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html by injecting bus-bridge.js then central-hub/bus.js in that order: flag stayed false; manual `window.AesBusBridge.attachCentralHub({})` then forwarded `hub:focus` to `data:central-hub:focus` correctly.
- Expected: every CentralHubBus emit (canvas:hub-changed, hub:focus, tile:open, tile:command, …) is mirrored onto AesDataBus per `DEFAULT_CENTRAL_HUB_TABLE` so cross-tab consumers (bridge.html, view-engine) observe the events.
- Actual: bridge.attachCentralHub silently returns at the `if (!Bus || !Data || ...) return` guard because manifest order in the wildcard `_shared` block (line 95) loads bus-bridge BEFORE the dashboard-block loads central-hub/bus.js (line 230). The second copy of bus-bridge.js in the dashboard block (line 231) re-enters the IIFE but exits at `if (window.AesBusBridge) return` before scheduling another auto-install. The same path silently fails for AesAfp.bus (host.js loads at manifest line 900 — far after both bus-bridge loads). No console error.
- Notes: Fix candidates: (a) move bus-bridge into a separate content_scripts block that runs AFTER central-hub + AFP modules; (b) make attachCentralHub poll/retry with `queueMicrotask` until Bus is present; (c) have central-hub/bus.js + aircraft-flight-plan/host.js call `window.AesBusBridge.attachCentralHub({})` themselves on bus-creation. Pick (c) — the call is idempotent and removes the ordering coupling. Until fixed, every `data:canvas:hub:changed`, `data:command-palette:open`, `data:central-hub:focus`, etc., listed in DEFAULT_CENTRAL_HUB_TABLE is dead wiring on the dashboard.

## F-9223-002: AesSettings.saveArea drops sibling areas under same-tab concurrency
- Area: modules/_shared/settings-bridge.js
- Severity: P1
- Found by: port-9223
- Status: FIXED
- Fix: serialise saveArea writes through `_saveQueue` tail Promise (same pattern as `_aesAccountTouchQueue` in modules/_background/account-registry.js and `_aesCustomizationQueue` in modules/_background/customization-store.js). API unchanged; the read-modify-write cycle is now strictly ordered within the same realm. Cross-tab races on the SAME chrome.storage key remain inherent and need a background single-writer for full coverage. Verified by: at port-9223/bridge.html, after reload: `Promise.all([saveArea("A",{v:"A-1"}), saveArea("B",{v:"B-1"}), saveArea("C",{v:"C-1"})])` — final blob has all three areas plus the pre-existing `seed:true`. Pre-fix the same call dropped the first writer's area.
- Repro: `await chrome.storage.local.set({settings:{seed:true}})`, then `await Promise.all([AesSettings.saveArea("A",{v:"A-1"}), AesSettings.saveArea("B",{v:"B-1"})])`. Inspect `chrome.storage.local.get(["settings"])`.
- Expected: settings blob ends with both `aes_test_areaA` and `aes_test_areaB` populated.
- Actual: only the second area's value survives; the first area is silently dropped. Live result observed at bridge.html: `{settings:{aes_test_areaB:{value:"B-1"},seed:true}, hasA:false, hasB:true}`.
- Notes: Classic read-modify-write race. saveArea reads the WHOLE settings blob, splices in one area, writes it back. Two concurrent calls — even from the SAME tab (different modules, different microtask) — both read the same baseline and last write wins. Not just a multi-tab race. Many AES modules use saveArea (HANDOVER §10 lists routeAssistant, aircraftFlightPlan, scheduleManagement, flightInfo, usedAircraftScanner, centralHub, …); any combination of two near-simultaneous flips loses one write. Compare with `_background/account-registry.js` which serialises through `_aesAccountTouchQueue`; the same single-writer pattern (or chrome.storage.local.set with all areas in one merge) is the fix. Add a tail Promise inside settings-bridge OR route saveArea through a background single-writer mailbox.

## F-9223-003: AesStoreCache 50ms write-suppress drops cross-tab divergent writes from L0
- Area: modules/_shared/store-cache.js (lines 100-130)
- Severity: P2
- Found by: port-9223
- Status: FIXED
- Repro: at bridge.html: `AesStoreCache.setMem("k",{v:"local"},"write"); await chrome.storage.local.set({k:{v:"remote-different"}}); /*<50ms*/ AesStoreCache.getMem("k")`.
- Expected: after the chrome.storage write commits, L0 reflects the latest committed value (`{v:"remote-different"}`).
- Actual: L0 still holds `{value:{v:"local"},source:"write"}`. The chrome.storage.onChanged listener inside store-cache short-circuits (`if (existing.source==="write" && Date.now()-existing.at<50) continue`) without comparing newValue, treating the remote write as the writer's own echo. After 80ms, a follow-up remote write correctly updates L0 to `source:"echo"`.
- Notes: The 50ms guard is meant to ignore the writer's OWN echo; it doesn't differentiate echo-of-self from a peer write that arrived inside the window. Any consumer that uses `cached-store.get` (which reads L0 first) returns the stale local value until the next onChanged fires past the window. Fix: compare `c.newValue` to `existing.value` (deep or hash) before short-circuiting; OR have setMem stamp a write nonce that the writer-side onChanged carries via storage envelope. Simplest: drop the time-based suppress and let chrome.storage be the source of truth — the listener can always update L0 to the latest newValue.

## F-9223-004: AesDataBus storage-echo de-dup window (200ms) lets late-arriving onChanged double-emit
- Area: modules/_shared/data-bus.js (STORAGE_ECHO_SUPPRESS_MS = 200, onStorageChanged loop)
- Severity: P2
- Found by: port-9223
- Status: FIXED
- Repro: at bridge.html: register a `bridgeStorage({prefix:"aes_test_echo_", topic:"data:test:echo:saved"})`, subscribe to that topic, then `AesDataBus.emit("data:test:echo:saved",{suffix:"k1"}); await new Promise(r=>setTimeout(r,250)); chrome.storage.local.set({"aes_test_echo_k1":{v:1}})`.
- Expected: subscriber sees ONE event for the logical save (the documented contract — "Producer awaits chrome.storage.local.set then calls AesDataBus.emit"; the 200ms suppress prevents the writer's own echo from double-firing).
- Actual: subscriber sees TWO events: `{source:"local"}` then `{source:"storage"}` ~250ms apart. Live: `eventCount:2`.
- Notes: The suppress is purely TIME-based. Any chrome.storage commit that completes >200ms after the producer's `emit()` (SW under load, large blobs, slow disk) escapes the window and the writer's own onChanged reaches dispatch as a "storage" emit on top of the already-fired "local" emit. UI counters / activity-strip / journal aggregators that don't ignore source="storage" double-count. Fix: tag the producer's emit with a unique commit nonce written into the chrome.storage value itself, then suppress echoes whose newValue carries the writer's own nonce; OR move to per-key sequence numbers tracked in `recentLocalEmit`.

## F-9223-005: AesFlow.health() re-fires signal:flow:flow-degraded and re-publishes data:flow:health:updated on EVERY invocation
- Area: modules/_shared/flow.js (health(), lines 192-215)
- Severity: P2
- Found by: port-9223
- Status: FIXED
- Fix: cache last-published `{score, signature}` and last-observed `degraded` boolean in module scope. `data:flow:health:updated` is published only when score moves OR the complaint signature (sorted `kind|topic` pairs, ignoring volatile `detail` counts) changes. `signal:flow:flow-degraded` fires only on the good→bad transition (`score < 0.7` AND `_lastDegraded !== true`). Caller still receives the live envelope on every call. Verified by: at port-9223/bridge.html after reload — generated 12 discovered topics, called `AesFlow.health()` 5×, added 5 more topics, called `health()` once more (6 total): observed `{degradedFires:1, updateFires:2}` (one transition + two distinct signatures). Pre-fix the same call sequence produced 6 of each.
- Repro: at bridge.html with discovered topics > 7: subscribe to `signal:flow:flow-degraded`, then call `AesFlow.health(...)` five times in a row.
- Expected: degraded state should fire once on transition (or be debounced) — subscribers don't need to re-handle on every observation.
- Actual: 5 health() calls produced 5 separate `signal:flow:flow-degraded` emits and 5 separate `data:flow:health:updated` publishes. Live: `flowDegradedFiredCount:6, lastScore:0, complaintCount:1516`.
- Notes: This pathway is self-amplifying — each health() also makes `data:flow:health:updated` itself accumulate count, eventually crossing the ECHO_STORM_THRESHOLD=50 in flow.diagnose() and registering as its own complaint. Any UI tile that calls health() on render (the dashboard's data-flow-inspector tile is the documented consumer) creates a feedback loop. Fix: cache last-fired score+complaintCount on the module; only emit signal when score CROSSES the 0.7 threshold or complaints/topic mix changes; only publish when the score actually moved.

## F-9223-006: AesControl.reset("all") fan-out fires data:strategy:control:changed once per knob (~29 emits in a tight loop)
- Area: modules/_shared/control.js (reset, set, lines 448-495)
- Severity: P3
- Found by: port-9223
- Status: FIXED
- Fix: in `AesControl.set`, short-circuit when the validated next value matches the current value — skip the underlying write, skip the journal entry, skip the bus emit. Returns `{id, before, after, noop:true}` so callers can distinguish a no-op from a real flip if they want. `reset("all")` now naturally produces zero emits when every knob is already at default; only the genuinely-flipped knobs propagate. Verified by: at port-9223/bridge.html after reload — iterated all 29 knobs and called `AesControl.set(id, entry.default)`; result `{knobCount:29, noopCount:29, errCount:0, busEmits:0}`. Pre-fix the same loop would fire 29 unconditional emits and attempt 29 underlying writes.
- Repro: subscribe to `data:strategy:control:changed`, then `await AesControl.reset("all")`. (Verification at bridge.html showed reset's underlying writes throw because store stubs aren't loaded; in a populated dashboard with all stores present, every entry.write() that succeeds emits.)
- Expected: a single coalesced "all knobs reset" event so subscribers (automation-control-tile, strategy panel, journal, salience scorer) re-render once.
- Actual: by code inspection, reset("all") loops sequentially over 29 KNOB entries calling `set(entry.id, entry.default)`; each successful set unconditionally calls `AesDataBus.emit("data:strategy:control:changed", …)`. No coalesce, no `before === after` short-circuit, no batching. Subscribers re-render up to 29 times in <1 frame.
- Notes: Same pattern hides in `set()` itself — even when the new value equals current, the bus emit fires. Fix: (a) inside `set()`, skip emit when `before === after`; (b) inside `reset()`, fire one synthetic `id:"meta.reset-all"` event after the loop instead of per-knob. Pair with F-9223-005 to dampen flow.health() amplification.

## F-9223-007: AesDataBus topic-discovery + per-topic maps are unbounded by emit cardinality
- Area: modules/_shared/data-bus.js (`discovered`, `counts`, `lastEmit`, `lastValue`, `subs`, `recentLocalEmit`, `historyByTopic`)
- Severity: P3
- Found by: port-9223
- Status: FIXED
- Repro: at bridge.html: `for (let i=0;i<1500;i++) AesDataBus.emit("data:fuzz:topic:"+i,{i})`.
- Expected: bus state stabilises (or evicts least-recent topics) above some bound, mirroring the `HISTORY_GLOBAL_MAX=500` / `HISTORY_PER_TOPIC_MAX=50` ringbuffers.
- Actual: `auditTopics().discovered.length` grew from 2 → 1502; `stats().length` 2 → 1502; only `historyGlobal` is capped (at 500 records). No `clearTopic` API exposed.
- Notes: Today the only producer that varies the topic suffix is `modules/command-palette/host.js:419` (`"data:command-palette:" + kind`) where `kind` is a small enum — so the leak is theoretical for current code. Risk emerges when any future producer encodes per-route, per-aircraft, or per-session ids in topic names. Cheap fix: add `AesDataBus.clearTopic(topic)` and have `clearHistory` optionally clear counts/lastEmit; or wrap `_noteTopicUse` with a max-cardinality check that warns once when discovered crosses a soft limit.

## F-9223-008: bus-bridge replaces Bus.emit by mutation — pre-cached references skip the bridge
- Area: modules/_shared/bus-bridge.js (lines 53-65, 79-90)
- Severity: P3
- Found by: port-9223
- Status: FIXED
- Fix: rewrote `attachCentralHub` and `attachAesAfp` to install bridge forwarding via `Bus.on(event, fn)` subscriptions instead of mutating `Bus.emit`. The bus's public surface is untouched; any caller that captured `const emit = Bus.emit` before the bridge installed still hits the same dispatch path, which fans out to subscribers — including the bridge subscriber. As a side benefit, this preserves CentralHubBus's `withReplay:true` semantics: the original emit still stamps lastEmit before subscribers (including the bridge) fire. Verified by: at port-9223/bridge.html after reload — captured `cachedEmit = CentralHubBus.emit` before any forwarding was needed, then called both `cachedEmit.call(Bus, "hub:focus", …)` AND `Bus.emit("hub:focus", …)`; AesDataBus subscriber on `data:central-hub:focus` saw both calls (`viaCached:1, viaProperty:1`).
- Repro: code review — `Bus.emit = function (event, payload) { … }` overwrites the property on the bus object, but any module that did `const emit = Bus.emit; emit(...)` (e.g. the typical `bind` pattern in long-lived feature stores) keeps the unwrapped function and bypasses the bridge.
- Expected: bridge forwarding is universal once installed.
- Actual: forwarding only fires for callers that read `Bus.emit` AT call time. Combined with F-9223-001 (auto-install timing), modules loaded between the original IIFE and the manual attach window can capture the unwrapped reference and never bridge.
- Notes: Today no codebase user does `const emit = Bus.emit` (grep confirms — most callers go through `CentralHubBus.emit(name, payload)` per call), but the wrapping pattern is fragile. Fix: instead of replacing `Bus.emit`, install a sibling `Bus.on(name, fn)` subscriber inside attachCentralHub that fans into AesDataBus.publish — that route also handles the case where the bus uses withReplay (CentralHubBus does). With `withReplay:true`, the original emit also stamps lastEmit; subscriber-based forwarding keeps that intact and never mutates the public surface.

## F-9224-001: Command Bridge active picker chip is dark-on-dark (undefined --aes-paper)
- Area: css/command-bridge.css (line 877)
- Severity: P1
- Found by: port-9224
- Status: FIXED
- Repro: open chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html → masthead has the account picker chip strip ("All accounts" / "Fly Nyon."). Inspect the active chip (`.aes-bridge__picker-chip--active`).
- Expected: active chip has bone (#F4F1EA) text on oxide-2 (#4A413B) background — a clear inverted highlight, like every other oxide-bg/bone-fg pairing across the components.
- Actual: active chip renders as `color: rgb(43,37,32)` (oxide) on `background: rgb(74,65,59)` (oxide-2). Computed via DevTools MCP: `getComputedStyle(activeChip).color === "rgb(43, 37, 32)"`. The CSS sets `color: var(--aes-paper)` but `--aes-paper` is undefined in design-tokens.css (only `--aes-paper-rule` exists), so the color falls back to inherited oxide → ~1.4:1 contrast. Screenshot: /tmp/aes-ui-screens/bridge-picker-and-panes.png.
- Notes: `--aes-paper` is referenced exactly once (command-bridge.css:877). The four candidate fixes: rename token to `--aes-bone` (which is the brutalist palette's "paper" surface and the foreground used everywhere else against oxide bg — cf. .aes-btn:hover, .aes-popover__item:hover, .aes-bridge__lane-head); or define `--aes-paper: var(--aes-bone)` in design-tokens.css. Prefer the rename since it's a one-line CSS fix matching the rest of the file's naming. Picker selection is the user's primary affordance for scoping the entire bridge — the broken chip is functionally invisible.

## F-9224-002: Command Bridge pane titles render without letter-spacing (undefined --aes-tracking-h)
- Area: css/command-bridge.css (line 890, `.aes-bridge__pane-title`)
- Severity: P2
- Found by: port-9224
- Status: FIXED
- Repro: open chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html → inspect any pane title rendered by ra-pane / accounting-pane / strategy-pane / canvas-pane / etc. (e.g. "Conductor"). Computed: `getComputedStyle(paneTitle).letterSpacing === "normal"`.
- Expected: tracked uppercase caps, matching `.aes-bridge__h2` / `.aes-bridge__h3` / `.aes-section-label` which all use `var(--aes-tracking-caps)` (0.08em).
- Actual: `letter-spacing: var(--aes-tracking-h)` resolves to empty (token undefined in design-tokens.css). Browser falls back to `normal`. Pane titles look visually distinct from the surrounding bridge headings — they're uppercase but not tracked.
- Notes: design-tokens.css defines only `--aes-tracking-caps` (0.08em) and `--aes-tracking-mono` (0.02em). `--aes-tracking-h` is referenced exactly once (command-bridge.css:890). Affected selectors: every `.aes-bridge__pane-title` (8 instances on the bridge page per `document.querySelectorAll('.aes-bridge__pane').length`). Fix: replace with `var(--aes-tracking-caps)` to match the rest of the bridge's heading typography.

## F-9224-003: Command Palette is dark-themed and bypasses the design-token system entirely
- Area: modules/command-palette/host.js (lines 137–219, _ensureStyle)
- Severity: P1
- Found by: port-9224
- Status: FIXED
- Repro: any AS app page, Cmd-K (Mac) / Ctrl-K (Win/Linux). Or, programmatically, `window.AESCommandPalette.open()` after the page-bound content scripts have loaded.
- Expected: same brutalist treatment as the unified-settings shell, AES menu dropdown, and about-dialog: bone bg (`#F4F1EA`) / oxide text (`#2B2520`) / 2px oxide border / `--aes-radius: 0` (sharp corners) / Inter Tight display font / `--aes-z-modal` / token-driven kbd chips. The palette is the highest-traffic AES UI surface; everything else in the brutalist redesign treats sharp corners and the bone/oxide pair as non-negotiable.
- Actual: the entire palette is hardcoded dark mode in the IIFE-injected stylesheet. Verbatim from host.js:154-156 — `background: #181a1f; color: #d8dde6; border: 1px solid #2c313a; border-radius: 10px; box-shadow: 0 20px 50px -12px rgba(0,0,0,0.55) …`; rows highlight on `#232730` with a `#5fa8ff` (cobalt-ish blue) accent left-border; recent-tag chip is `#d3a04c` on `rgba(211,160,76,0.12)`; kbd chips at `#232730` with `border-radius: 4px`. Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` (system) instead of `Inter Tight`. Z-index: `2147483646/2147483647` (signed-int max) instead of the design-token ceiling `var(--aes-z-modal)` (10000). 14 hardcoded hex values + 1 hardcoded rgba.
- Notes: Pre-existing in this branch — none of the design-tokens values are referenced anywhere in host.js. The fix is a wholesale rewrite of `_ensureStyle()` to consume tokens (e.g. `background: var(--aes-bone); color: var(--aes-oxide); border: var(--aes-bw-2) solid var(--aes-oxide); border-radius: var(--aes-radius); box-shadow: none`) plus replacing the sticky `style.textContent = …` template with a token-friendly equivalent. While there, drop the max-int z-index (it's > everything in the design-token ladder, including tooltips). a11y bonus: the input has no `aria-controls` pointing at the listbox and no `aria-activedescendant` is set when arrow-keys move selection — fix in the same edit.

## F-9224-004: about-dialog container created without the `.modal` class (uses .class instead of .className)
- Area: modules/about-dialog.js (line 28)
- Severity: P3
- Found by: port-9224
- Status: FIXED
- Repro: any AS app page → AES menu → "About AES". Or inspect `document.getElementById('aes-about-dialog').className` before the dialog has been opened.
- Expected: the modal container element is created with `class="modal"` so AS's Bootstrap modal handler treats it as a modal from the moment markup is in the DOM.
- Actual: `container.class = "modal"` (line 28) sets a JavaScript property named `class` on the Element instance — it does not set the `class` attribute and does not write to `Element.className`. Initial `className` is empty. The `.modal` class is added later, but only because `#correctBootstrapBehaviour()` (line 173) detects the dialog has the `in` class without `modal` and patches it via `classList.add("modal")` plus `style.display = "block"`. The MutationObserver workaround papers over the original typo.
- Notes: This is a typo masked by a workaround. The MutationObserver-based add of `.modal` works for AS's current Bootstrap, but is fragile if Bootstrap toggles `in` without going through `modal()` (e.g. another extension manipulating display). Fix: change `container.class = "modal"` → `container.className = "modal"`. The MutationObserver hack can stay as belt-and-braces or be removed once the typo is fixed and tested.

## F-9224-005: Bridge AFP wear strip + secondary-pane grid classes are unstyled (visible regression)
- Area: modules/command-bridge/afp-pane.js + canvas-pane.js + dna-pane.js + ra-pane.js (and shared `.aes-bridge__pane-column`); css/command-bridge.css missing rules
- Severity: P2
- Found by: port-9224
- Status: WONTFIX
- WONTFIX reason: could not reproduce. The afp/canvas-grid/dna-grid/ra-grid/pane-column classes do not exist anywhere in the source tree on slice/e-integration (`grep -rn "aes-bridge__afp"` matches only audit/findings.md itself; same for the other classes). The five JS modules listed in Area (afp-pane.js, canvas-pane.js, dna-pane.js, ra-pane.js) are absent under modules/command-bridge/ — `ls modules/command-bridge/` shows only activity-ribbon, bridge-app, coalitions-panel, menu-installer, opportunities-panel, priority-board, priority-store, subsidiary-cards. Live DOM at chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html (verified on port-9225 after a cache-bypass reload) shows 5 sections — activity, subsidiaries, board, coalitions, opportunities — and contains zero matches for the listed classes; the strings "AIRCRAFT FLIGHT PLAN" and "WEAR" do not appear in document.body.innerText. Adding the proposed CSS would dead-code rules with no markup to bind to.
- Repro: open chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html → scroll to "AIRCRAFT FLIGHT PLAN — WEAR" section. Three pills are emitted next to each other: "0 bad", "0 warn", "0 good".
- Expected: each count is a chip-like pill — coloured dot/border, padding, separated visually. Same for `.aes-bridge__canvas-grid`, `.aes-bridge__dna-grid`, `.aes-bridge__ra-grid` and `.aes-bridge__pane-column` blocks (column wrappers with hairline / spacing). Mirrors the pattern used by `.aes-bridge__opps-card` etc.
- Actual: the three pills render as default inline `<span>`s with zero padding/margin/border/bg. Computed: `display:inline; padding:0px; margin:0px; backgroundColor:rgba(0,0,0,0); borderColor:rgb(43,37,32)` (border colour comes only from the inherited oxide on `*`-style resets). Visible result: `0 bad0 warn0 good` runs together as one string (screenshot: /tmp/aes-ui-screens/bridge-picker-flynyon-active.png). No CSS rules exist for: `.aes-bridge__afp-strip`, `.aes-bridge__afp-pill`, `.aes-bridge__afp-pill--bad/warn/good`, `.aes-bridge__canvas-grid`, `.aes-bridge__dna-grid`, `.aes-bridge__ra-grid`, `.aes-bridge__pane-column`. Verified: `grep -E "aes-bridge__(afp|canvas-grid|dna-grid|ra-grid|pane-column)" css/command-bridge.css` returns nothing.
- Notes: Looks like the JS panes shipped before their stylesheet block. Fix: add a per-class block in command-bridge.css mirroring `.aes-bridge__opps-*`. Sketch:
  ```
  .aes-bridge__afp-strip { display: flex; gap: var(--aes-sp-2); margin: var(--aes-sp-2) 0; }
  .aes-bridge__afp-pill { padding: 2px var(--aes-sp-2); font-family: var(--aes-font-mono); font-size: var(--aes-fs-micro); text-transform: uppercase; letter-spacing: var(--aes-tracking-mono); border: var(--aes-bw-1) solid var(--aes-oxide); }
  .aes-bridge__afp-pill--bad  { color: var(--aes-crimson); border-color: var(--aes-crimson); background: var(--aes-crimson-soft); }
  .aes-bridge__afp-pill--warn { color: var(--aes-amber);   border-color: var(--aes-amber);   background: var(--aes-amber-soft); }
  .aes-bridge__afp-pill--good { color: var(--aes-moss);    border-color: var(--aes-moss);    background: var(--aes-moss-soft); }
  .aes-bridge__pane-column { padding: var(--aes-sp-2) 0; border-bottom: var(--aes-bw-1) solid var(--aes-paper-rule); }
  .aes-bridge__pane-column:last-child { border-bottom: 0; }
  .aes-bridge__canvas-grid, .aes-bridge__dna-grid, .aes-bridge__ra-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--aes-sp-3);
  }
  ```

## F-9224-006: Bridge picker chips, ribbon chips, and lane buttons have no :focus-visible style
- Area: css/command-bridge.css (`.aes-bridge__picker-chip`, `.aes-bridge__ribbon-chip`, `.aes-bridge__card`, `.aes-bridge__btn`)
- Severity: P3
- Found by: port-9224
- Status: FIXED
- Fix: added a shared `:focus-visible` rule in css/command-bridge.css covering `.aes-bridge__picker-chip`, `.aes-bridge__ribbon-chip`, `.aes-bridge__ribbon-sentence`, `.aes-bridge__card`, `.aes-bridge__lane`, `.aes-bridge__btn`, `.aes-bridge__adder-btn`, `.aes-bridge__coalitions-new`, `.aes-bridge__card-del`, `.aes-bridge__opps-row-name` → `outline: var(--aes-bw-2) solid var(--aes-rust); outline-offset: 2px;` (matches the existing `.aes-btn:focus-visible` rule in components.css). Verified by: at port-9225 chrome-extension://.../bridge.html after cache-bypass reload, individually focusing `.aes-bridge__ribbon-chip` and `.aes-bridge__adder-btn` via `el.focus({focusVisible:true})` — `getComputedStyle(el).outline` resolves to `rgb(184, 71, 42) solid 2px` (= `--aes-rust` `#B8472A` at `--aes-bw-2` `2px`) with `outline-offset: 2px`; pre-fix only the browser-default 1.5px outline applied. `el.matches(':focus-visible')` returns true and the only matching outline rule in the cascade is the new selector group.
- Repro: open chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html → tab through the page (or focus a chip via DevTools). Verified by querying every stylesheet rule whose selectorText contains "picker-chip" + ":focus" — zero matches. The chip is in normal tab flow (`tabIndex === 0`) so users do reach it via keyboard, but only the browser-default outline shows.
- Expected: tracked, high-contrast focus ring matching the rest of the brutalist UI (cf. `.aes-btn:focus-visible { outline: var(--aes-bw-2) solid var(--aes-rust); outline-offset: 2px }` in css/components.css and `.aes-bridge__adder-title:focus { outline: var(--aes-bw-2) solid var(--aes-rust); outline-offset: -2px }` in command-bridge.css for adder inputs).
- Actual: the only `:focus`/`:focus-visible` rules in command-bridge.css cover the adder inputs (`.aes-bridge__adder-title`, `.aes-bridge__adder-lane`, `.aes-bridge__adder-bind`, `.aes-bridge__coalitions-name`). All chip / button / card / lane / ribbon-chip surfaces inherit only the browser default outline, which on the bone background is a thin blue ring barely visible against the brutalist palette.
- Notes: cubist-a11y.css already encodes the project a11y contract (`.aes-cubist .aes-facet:focus-visible { outline: var(--aes-bw-3) dashed var(--aes-rust) }`) but bridge surfaces aren't `.aes-facet`. Fix: add a single shared rule like `.aes-bridge__picker-chip:focus-visible, .aes-bridge__ribbon-chip:focus-visible, .aes-bridge__btn:focus-visible, .aes-bridge__adder-btn:focus-visible, .aes-bridge__coalitions-new:focus-visible, .aes-bridge__card:focus-visible { outline: var(--aes-bw-2) solid var(--aes-rust); outline-offset: 2px; }`.

## F-9224-007: unified-settings shell hardcodes font-size 13px, font stack, and overlay rgba instead of tokens
- Area: modules/unified-settings/shell.js (`ensureStyle`, lines 43–95)
- Severity: P3
- Found by: port-9224
- Status: FIXED
- Repro: code review + token comparison. The shell does fetch tokens via `window.AESTokens` but only uses three of them (bone, oxide, paperRule). Every other CSS value is inlined as a literal.
- Expected: same token discipline as design-tokens.css contract ("no value outside this file"). Use `var(--aes-fs-body)` (12px) or the token resolver's `T.fs.body`, `var(--aes-font-display)`, `var(--aes-z-modal)`, and a soft-overlay token.
- Actual: shell.js:53 hardcodes `rgba(26,22,18,0.55)` (oxide-bg with 55% alpha — no token); shell.js:54 hardcodes `120ms ease` for the open transition (`--aes-tr-medium` is `140ms linear`); shell.js:62 hardcodes `width:min(960px, calc(100vw - 32px))` and `border:2px solid` instead of `var(--aes-bw-2) solid` and `box-shadow:6px 6px 0` (no token for the brutalist drop-shadow signature); shell.js:63 hardcodes `font-family:'Inter Tight',system-ui,sans-serif;font-size:13px` — but design-tokens.css defines `--aes-font-display` which is the Inter Tight stack, and 13px isn't on the design's typography scale at all (10/11/12/14/18/24/36/56). 13px is the only scale violator in this file. The same `2147483646/2147483647` z-index pattern from the command palette doesn't repeat — z-index is `9998/9999`, which is *under* `--aes-z-modal` (10000) and could be hidden under a brutalist toast.
- Notes: Pair with F-9224-003 — unified-settings, command-palette, and customization studio all roll their own modal styling because there's no shared "AES modal primitive" CSS class. The fix is two-step: (1) add a `.aes-modal-shell` primitive in components.css that owns bg / border / shadow / overlay / z-index for every full-screen AES dialog; (2) have shell.js / host.js render against that class instead of injecting per-host styles. Cheap interim fix: replace the four hardcoded values flagged above with their token equivalents.

## F-9224-008: Coalitions panel uses native window.prompt() and window.confirm() for create/delete
- Area: modules/command-bridge/coalitions-panel.js (lines 101 prompt, 183 confirm)
- Severity: P2
- Found by: port-9224
- Status: FIXED
- Repro: open chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html → "+ NEW COALITION" button. The browser's native prompt opens (also blocks any further MCP `evaluate_script` / `take_snapshot` until handled — confirmed in this audit: `take_snapshot` returned "Open dialog: prompt: Coalition name: (default 'Asia Operations')"). Same for delete: clicking Delete on an existing coalition triggers `window.confirm("Delete coalition \"X\"?")`.
- Expected: a brutalist inline dialog (e.g. `.aes-modal` from components.css) that matches the rest of the bridge — keyboard focus trap, Esc to dismiss, design-token typography, no thread-blocking dialog.
- Actual: a Chrome-rendered grey box with the system font, default chrome typography, and synchronous blocking semantics. Steals focus from the page, can't be styled, and behaves differently per OS/browser. The bridge already has its own coalition rename input (`.aes-bridge__coalitions-name` — line 161) that demonstrates the inline-input pattern; create just needs the same.
- Notes: Fix: replace prompt() with an inline "+ New coalition" input that appears under the new-coalition button (same pattern the rename input already uses on line 161). Replace confirm() with a two-step delete: first click switches the Delete button to "Confirm delete?" with a 3s undo timer (or a small inline `.aes-bridge__btn--ghost` "Confirm" / "Cancel" pair). Bonus: this removes the only synchronous dialog in the bridge, which means MCP / e2e drivers don't have to special-case it.

## F-9224-009: site-skin breadcrumb relies on deprecated RegExp.$1 globals (fragile + lint warning)
- Area: modules/site-skin/breadcrumb.js (lines 33–35)
- Severity: P3
- Found by: port-9224
- Status: FIXED
- Fix: lifted the match result into a local variable. Replaced each `if (m(re)) return [..., RegExp.$1.toUpperCase()]` with `if ((r = m(re))) return [..., r[1].toUpperCase()]` for the five capture-group routes (`scheduling/<x>`, `inventory/<x>`, `markets/<x>`, `airports/<x>`, `enterprises/<x>`). Declared `let r` once at the top of `buildCrumbs`. No structural rewrite — minimal diff, deprecated global state read removed. Verified by: ran `node /tmp/breadcrumb-test.js` against the patched source — extracted `buildCrumbs` and ran 10 representative paths; all returned the expected crumb arrays. Regression check tainted `RegExp.$1 = "oo"` via `'foo'.match(/(o+)/)` BEFORE invoking buildCrumbs on `/app/com/scheduling/JFKATL`; pre-fix this would yield `["SCHEDULING","OO"]`, post-fix yields `["SCHEDULING","JFKATL"]`. `grep "RegExp.\\$1" modules/site-skin/breadcrumb.js` returns no matches.
- Repro: code review. `if (m(/^\/app\/com\/scheduling\/([^/?#]+)/)) return ["SCHEDULING", RegExp.$1.toUpperCase()];` — the `m(re)` helper returns `path.match(re)` but the result isn't bound; the function then reads `RegExp.$1` (the deprecated, non-standard "last successful match" static property). Lines 33, 34, 35, 38, 39 all do this.
- Expected: capture and use the local match result, e.g. `const x = m(re); if (x) return ["SCHEDULING", x[1].toUpperCase()];`. RegExp.$1 is documented as "Deprecated. Will be removed in a future version" on MDN; tools like Lighthouse / esbuild / Chrome's "deprecation reporting" surface it.
- Actual: works today because Chrome still supports the legacy RegExp static properties, and because no other regex runs between `m(re)` and the `RegExp.$1` read (the conditional only runs the regex once). But: anything that adds a regex anywhere in this control flow — including a console call wrapper, a future early-return that runs another regex, or a polyfill that resets the legacy properties — flips $1 silently to the new last match. Five separate breadcrumb routes are vulnerable.
- Notes: Strict fix is mechanical: replace `if (m(re)) return ["...", RegExp.$1.toUpperCase()]` with `{ const r = m(re); if (r) return ["...", r[1].toUpperCase()]; }`. If you want the inline `if` style preserved, lift `m` to bind the match: `const m = (re) => (path.match(re) || []);` and use `m(re)[1]`. Either way, drop the global state read.

## F-9224-010: unified-settings adapter helper has the wrong "rust" hex (renders the brand rust as amber-yellow)
- Area: modules/unified-settings/adapters/_helpers.js (lines 13–21, COLORS map; consumed by drag-and-palette.js:142)
- Severity: P1
- Found by: port-9224
- Status: FIXED
- Repro: open the unified settings → Modules → "Drag & Palette" → click any keybind capture button. The button's "Press chord…" active state sets `btn.style.background = H.COLORS.rust`. Compare against any rust button rendered through css/components.css (`.aes-btn--primary { background: var(--aes-rust); }` → #B8472A) and the visual is obviously different — yellow-amber rather than red-orange.
- Expected: `COLORS.rust` matches `--aes-rust` from css/design-tokens.css → `#B8472A` (red-orange brand accent).
- Actual: `_helpers.js:20` defines `COLORS.rust = "#B8862E"` — yellow-amber, almost identical to `--aes-amber: #B8861F`. Every consumer that expects "brand rust" gets amber instead. Currently the only consumer is the chord-capture active state (drag-and-palette.js:142), but the helper is the canonical adapter palette so future adapters that lift from H.COLORS will hit the same wrong colour.
- Notes: One-character fix: change `rust:"#B8862E"` → `rust:"#B8472A"`. Better: delete the literal map and resolve via `var(--aes-rust)` inside cssText (Chrome resolves CSS custom-property tokens inside inline `style.cssText` strings). If keeping the literal table is preferred, add a smoke test that asserts each entry equals `getComputedStyle(document.documentElement).getPropertyValue("--aes-…").trim()`. Pair with F-9224-011.

## F-9224-011: unified-settings tabs and adapters carry ~46 hardcoded hex literals; introduces palette drift (#5A4F45, #E7E0CC, #B8862E)
- Area: modules/unified-settings/{shell.js, tab-data.js, tab-account.js, tab-about.js, tab-customisation.js, adapters/_helpers.js, adapters/aircraft-flight-plan.js, adapters/strategy.js, adapters/route-assistant.js, …}
- Severity: P2
- Found by: port-9224
- Status: OPEN
- Repro: `cd project && grep -nE '#[0-9A-Fa-f]{6}\b' modules/unified-settings/*.js modules/unified-settings/adapters/*.js | wc -l` → 46. Most are duplicates of design-tokens (#F4F1EA / #2B2520 / #C9C0B0 — fine, just non-DRY), but three are *new off-palette colours* that don't exist in css/design-tokens.css:
    - `#5A4F45` — used as "oxide2" in tab-data.js:49,78; tab-account.js:78; tab-about.js:36; _helpers.js:17. Token equivalent is `--aes-oxide-2: #4A413B` (noticeably darker grey). Visible drift wherever an adapter row sits next to a brutalist `.aes-btn` that renders the real oxide-2.
    - `#E7E0CC` — used as "bone2" in _helpers.js:15. Token equivalent is `--aes-bone-2: #ECE7DC` (slightly cooler bone). Adapter "notice" cards therefore paint on a different bg than the surrounding `.aes-modal` body.
    - `#B8862E` — the rust drift covered separately in F-9224-010.
- Expected: zero hardcoded hex outside css/design-tokens.css per its self-imposed contract ("Discipline: no value outside this file. If it doesn't fit, argue it back."). Use `var(--aes-…)` inside `cssText` strings — Chrome resolves them in inline `style.cssText` just like in stylesheet rules.
- Actual: Settings + adapters carry their own private palette. Drift is small in absolute terms but measurable at the seam where the unified-settings modal sits over a token-driven page (the user sees `#5A4F45` body copy next to `#4A413B` buttons in the same modal). Each new adapter file added under `adapters/` increases the drift surface.
- Notes: Two-pass fix. (1) Replace literal hex in cssText with the matching token via `var(--aes-…)` (most cases — purely mechanical). (2) Delete the local `COLORS` map in `_helpers.js` and switch consumers to either tokens-in-CSS or `window.AESTokens.color.*` (which shell.js already does). Together with F-9224-007 these are the same broader pattern: page-level UIs treating tokens as suggestions instead of the contract.

## F-9226-001: Alliance pendingApplications counts members table when "applications" tab not active in raw HTML
- Area: modules/alliance/alliance-overview-scraper.js (_fetchPendingApplicationsCount, lines 70-90)
- Severity: P1
- Found by: port-9226
- Status: FIXED
- Repro: invoke `new AllianceOverviewScraper("free1").scrape()` on a dashboard tab — applies the foundation phase or any direct call. Inspect the resulting `alliance:overview` record's `pendingApplications` against the actual count visible in the AS UI under `/app/alliance` "Membership applications" tab.
- Expected: pendingApplications === number of pending application rows under the "Membership applications" tab (often 0).
- Actual: pendingApplications === number of MEMBERS in the alliance. The fetch is `https://<server>.airlinesim.aero/app/alliance?tabs=1` but `?tabs=1` is a query string interpreted by client-side JS that does NOT run on a raw `fetch()` server-rendered response. The selector cascade (`.tab-pane.active table tbody` → `.tab-content table tbody` → `table tbody`) all fall through to the *first* tbody on the page, which is the members table.
- Notes: Two real consequences: (a) the alliance hub tile on dashboard surfaces a misleading "N pending" badge; (b) any consumer that gates UI on `pendingApplications > 0` (e.g. a director-only banner) fires permanently. Fix: the AS membership-applications panel typically lives at a distinct URL or under an explicit pane id (e.g. `#tab1` / `[data-tab-id="applications"]`) — confirm the actual DOM and switch to a positive selector for the applications tab specifically. As a guard, when the matched tbody contains links to `/info/enterprises/`, treat it as the members table and return 0. Verification needed via an alliance you're actually a member of (the test account `halleuffff` on free1 is in alliance "FLY NYON." — see /app/alliance).

## F-9226-002: ScrapeOrchestrator foundation estimate hardcoded as 9 — actual target list has 10 entries
- Area: modules/scrape-orchestrator/phases.js (estimate lines 52-64; _foundation targets lines 89-100)
- Severity: P2
- Found by: port-9226
- Status: FIXED
- Repro: open the "Scrape everything" ToS modal (foundation row reads "~9 pages") then count the URLs the foundation phase actually dispatches: /app/fleets, /app/finance/accounting/{0,1,2}, /app/finance/leasing, /app/finance/capital, /app/finance/assets, /app/alliance, /action/enterprise/staffPilots, /action/enterprise/staffOverview = 10 jobs.
- Expected: ToS modal shows the same job count the orchestrator dispatches.
- Actual: estimate reports `foundation: 9`; foundation buildJobs returns 10 jobs. The ToS modal therefore under-reports total page loads, and the runtime estimate at tos-confirmation.js:114-115 (`totalRequired = est.foundation + est.perHub + est.perAircraft + est.perRoute`) is consistently 1 short.
- Notes: Off-by-one — phases.js:53 hardcodes 9 instead of computing from the targets list. Fix: derive the count at estimate() time from the same source the buildJobs uses, or just bump 9→10. Same risk lives anywhere else estimate values are hardcoded apart from the implementation.

## F-9226-003: AesCompetitorOutlineAggregator.build memo hash drops `economics` and `ourFleet` — stale data inside 30s window
- Area: modules/competitor-intel/outline-aggregator.js (memoise IIFE lines 765-781)
- Severity: P2
- Found by: port-9226
- Status: WONTFIX (memoise IIFE no longer present in current outline-aggregator.js — file is 758 lines, no JSON.stringify hash, build() loads economics/ourFleet inline on every call so the staleness window doesn't exist)
- Repro: by code review — the hash function is `({s: a.server || "", e: ids, h: a.hubFilter || ""})`. Call build({server:"free1", economics: E1}) then within 30s call build({server:"free1", economics: E2}) — second call returns the cached result built with E1's profitability assumptions even though the caller passed E2.
- Expected: changing `economics` (load factor, yield/km, fuel cost) or `ourFleet` between calls forces a rebuild because the per-route profit estimates are derived from those inputs.
- Actual: the memoise key only varies by `server`, sorted `enterpriseIds`, and `hubFilter`. `args[0].economics` and `args[0].ourFleet` are silently ignored, so a build with overridden economics is shadowed by an earlier same-server cache hit. Compounding: `hubFilter` is in the hash but no caller passes `hubFilter` (grep across modules/* finds the field name only at this single line in outline-aggregator.js — every other `hubFilter` occurrence is a local variable in unrelated modules). So the hash spends a slot on a phantom field while ignoring the real ones.
- Notes: Observable when (a) the user opens the outline panel, (b) the dashboard's economics overrides change (default-settings.js sliders), (c) the panel re-renders within 30s — the new economics don't take effect until TTL expires. Fix: hash should include `Object.keys(a.economics||{}).sort().map(k => k+":"+a.economics[k]).join(",")` or just JSON.stringify(a.economics) plus a hash of `(a.ourFleet||[]).length` + a coarse identity for the fleet shape (server+airlineCode). Alternatively, drop the memo entirely — outline-aggregator.build's own bulk reads are cheap, and freshness > caching here.

## F-9226-004: ScrapeOrchestratorEnumerators.enumerateAllRoutes leaks routes across AS servers — keys aren't server-scoped
- Area: modules/scrape-orchestrator/enumerators.js (enumerateAllRoutes lines 87-110); writer at modules/route-assistant/panel.js:10322
- Severity: P2
- Found by: port-9226
- Status: OPEN
- Repro: play on free1, scrape everything (per-route phase populates `routeAssistant:topRoutes:<HUB>`). Switch the airline picker to free2 (or just open free2 in another tab while extension is shared). Open the dashboard on free2 and click Scrape Everything. The per-route phase fan-out includes hub IATAs from free1's network even when free2's airline operates a disjoint hub list.
- Expected: enumerateAllRoutes returns only routes that exist on `host.server` so the per-route phase scrapes only relevant pages.
- Actual: the storage key `routeAssistant:topRoutes:<HUB>` (panel.js line 10322 — `"routeAssistant:topRoutes:" + hubU`) carries no server prefix, and enumerators.js:87-110 reads every key matching that prefix without ANY server filter. A topRoutes blob persisted from a prior server is treated as live for the current server; the orchestrator builds `https://<currentServer>.airlinesim.aero/app/com/markets/<HUB><DEST>` URLs that 404 (or — worse — hit the right-shaped page on the wrong server).
- Notes: Sister enumerators (enumerateHubs, enumerateAircraft) DO filter by `k.indexOf(server) !== 0` because aircraftFleet keys ARE server-prefixed; the inconsistency is the bug here. Fix candidates: (a) prefix topRoutes keys with the server (`routeAssistant:topRoutes:<server>:<HUB>`) — requires migration of existing keys in panel.js's bulk loader at 10334-10346; (b) embed the server inside the blob and filter `if (blob.server !== host.server) continue` in enumerateAllRoutes — non-migrating but only works after the next scrape writes the field. enumerateCompetitorIds at lines 118-134 has the same shape (also reads `routeAssistant:markets:competitors:` without server scope) — consider both in one fix.

## F-9226-005: AesCompetitorEnterpriseScraper._sessionCache lets concurrent scrape(id) calls all hit the network (thundering herd)
- Area: modules/competitor-intel/enterprise-scraper.js (scrape(), lines 36-51)
- Severity: P2
- Found by: port-9226
- Status: FIXED
- Repro: call `scraper.scrape("123")` twice in parallel (e.g. two near-simultaneous panel opens, or the bulk runner racing against the airport-panel host's per-carrier kick) — both calls pass the `_sessionCache.has(id)` guard, both fire the four-tab Promise.all fetch (`/app/info/enterprises/<id>` + `?tab=2,3,4`), both call AesCompetitorStore.saveEnterprise, both append a snapshot via AesCompetitorSnapshotStore.record (the second always returns null because the projected snapshot doesn't differ from the just-saved first).
- Expected: a second concurrent call deduplicates against the in-flight scrape and returns the same Promise (or its result).
- Actual: the cache is set to the resolved record only AFTER `await this._scrapeDeep(id)` and `await AesCompetitorStore.saveEnterprise(...)` complete (lines 41-45). Two concurrent callers race past the `has(id)` check and execute the full 4-fetch deep parse independently. Per-call cost is real on AS: 4 parallel fetches × every duplicate caller, each parsing a 100-300KB document.
- Notes: Classic missing promise-cache. The textbook fix is to cache the Promise itself: `if (this._sessionCache.has(id)) return this._sessionCache.get(id); const p = (async () => { ... })(); this._sessionCache.set(id, p); return p;` — and on rejection, `delete` the entry so a retry can succeed. The comparable pattern is already used in modules/_shared/store-cache.js's L0 promise dedup (sketch). Same shape is in bulkScanner / bulkScrape inside enterprise-scraper itself, so the fix doesn't hurt the bulk path.

## F-9226-006: AesCompetitorAggregator.buildEdgeRecord drops per-competitor weeklyFlights / weeklySeats — silently zero in saved edge records
- Area: modules/competitor-intel/aggregator.js (buildEdgeRecord lines 87-163)
- Severity: P2
- Found by: port-9226
- Status: FIXED
- Repro: trigger a markets-page scrape for a route with multiple competitors (e.g. JFK-LHR), then inspect the saved record at storage key `competitorIntel:edge:<server>:JFK-LHR`. Look at `competitors[i].weeklyFlights` and `competitors[i].weeklySeats`.
- Expected: each competitor entry in the edge record carries the per-carrier weekly flight/seat count derived from the markets-page competitor list (the `byEnterprise` map at lines 105-116 collects exactly that data, keyed by flight-code prefix).
- Actual: every entry has `weeklyFlights: 0, weeklySeats: 0`. The `byEnterprise` map IS built (lines 109-115) and IS used for the edge's overall `totals.totalWeeklyFlights / totalSeats` (lines 145-150) — but the per-competitor `competitors[]` array at lines 117-143 is built independently from `marketShareRec.pax / .cargo` keyed by `name`, and never merges in the byEnterprise data because the join key (flight-code prefix vs enterprise name) doesn't line up. The `weeklyFlights: 0` and `weeklySeats: 0` initial values flow straight to `AesCompetitorStore.saveEdge` at line 161.
- Notes: Any downstream consumer of edge.competitors[].weeklyFlights gets 0. The hub-shell Companies/Routes views and counter-aircraft scoring read from outline-aggregator (which goes back to RA's markets:competitors directly), so this dead field probably isn't user-visible today — but the edge record's whole purpose is to be a derived summary that other modules can read without going back to RA storage, so the zero values mislead any future consumer or external inspection. Fix: merge the byEnterprise map into competitors[] by mapping enterprise name → flight-code prefix (or vice-versa) using the markets-page records' `c.flightCode`/`c.name` pairing. Where mapping fails, leave the field null (not 0) so consumers can distinguish "no signal" from "zero".

## F-9226-007: ScrapeOrchestrator._runPhaseJobs has no timeout — missing run-done event leaks listener and hangs Promise forever
- Area: modules/scrape-orchestrator/orchestrator.js (_runPhaseJobs lines 185-232)
- Severity: P2
- Found by: port-9226
- Status: OPEN
- Repro: kill the service worker mid-phase via chrome://extensions developer-tools "Inspect" → close (or use chrome.runtime.reload from the SW console). The background-tab-pool that owns the active phase is gone; no `run-done` event will be relayed.
- Expected: the orchestrator detects the broken pipe, resolves the phase Promise with `haltReason: "background-disconnect"` (or similar), and removes its message listener.
- Actual: `_runPhaseJobs` returns a Promise that resolves only inside `if (event.type === "run-done")`. The handler stays registered on `chrome.runtime.onMessage` and the await on line 73 (`await this._runPhaseJobs(phase, jobs)`) never returns. The caller (`start()`) is wedged; the auto-driver's `_busy = true` flag (auto-driver.js:68) stays true until the tab is closed; `aesAutoDrive:silentRunActive` storage flag stays true. Subsequent ticks short-circuit at `out.skipped = "busy"`.
- Notes: Same shape recurs at host.js:145-153 (auto-resume listener also never expires). Fix: wrap the addListener with a timeout (e.g. `MAX_PHASE_MS = 15min` after the last job-start/job-done event observed) that forcibly resolves with haltReason and cleans up the listener. Watchdog reset on every event keeps long phases viable; only true silence trips it. Bonus: the orphan-detection hook also gives the resume path a clean way to know "the prior run died" rather than "the prior run is in progress."

## F-9226-008: parseFleetCounts positional fallback silently mis-assigns fields when AS layout shifts
- Area: modules/competitor-intel/enterprise-scraper.js (parseFleetCounts lines 282-305)
- Severity: P2
- Found by: port-9226
- Status: OPEN
- Repro: by code review — the labelled-row pass at lines 258-281 captures any matched fields. When `matched === 0` (no labelled rows found), the fallback at 282-303 assumes a fixed row order under `.layout-col-md-4 > .as-fieldset table tbody[1]`: row 0 → paxCarried, row 1 → cargoCarried, row 2 → stationsCount, row 3 → aircraftCount, row 4 → employeeCount. AS's enterprise Information page layout has shifted in past versions (the comment on lines 232 already calls out "fall back to legacy positional"). If AS reorders the right-column tbody, every cached enterprise record gets wrong values for these five fields, with no parserNote signalling the mismatch (the fallback bumps `matched=1` and returns success).
- Expected: a positional fallback either validates the layout (e.g. checks the row label still contains the expected keyword) or attaches a parserNote tagging the result as positional-only.
- Actual: the fallback writes positionally-mapped fields with no validation, no labels checked, no parserNote ("positional-fallback"). Downstream snapshot-store records, threat-scorer fleet/network components, and watchlist priority all inherit the misassigned values silently.
- Notes: Defensive minimum: stamp a `parserNotes: "positional-fallback"` on records that took this path so the panel can render a "trust degraded — re-scrape" affordance. Better: read the row's first cell as a label and verify its keywords against `fields[]` before accepting the value. Bigger fix is removing the positional fallback altogether — empty output (with parserNote "fleet counts not parsed") is more useful than confidently-wrong numbers.

## F-9226-009: AesCompetitorOutlineAggregator and AesCompetitorThreatScorer compute "threatScore" with two incompatible formulas
- Area: modules/competitor-intel/outline-aggregator.js (line 367) vs modules/competitor-intel/threat-scorer.js (score(), 0-100 component-additive)
- Severity: P3
- Found by: port-9226
- Status: FIXED (relabelled outline-panel and tile to "lead N" so user-visible label disambiguates from threat-scorer's 0-100 score; internal field unchanged)
- Repro: by code review — outline-aggregator computes `summary.threatScore = Math.round(theirProfitLeadSum / 1000) + uncontestedRoutes * 2` per competitor (range: roughly 0..thousands, dominated by AS$/k of weekly profit lead). The threat-scorer in the same module returns `score: 0..100` clipped from six weighted components (fleet, network, momentum, overlap, alliance, freshness). The watchlist (used by auto-driver to pick re-scrape order) uses threat-scorer's score; the outline panel sorts by aggregator's `threatScore`.
- Expected: a single competitor's "threat" ordering is consistent across the outline panel sort, the watchlist priority, and any data:competitor-intel:enterprise:diff signal-emitted threat tag.
- Actual: a competitor with massive route profit lead (high outline threatScore) but cold/stable fleet (low scorer score) will sort top in the outline but bottom in the watchlist — and vice versa. The two scoreboards point in different directions on the same enterprise.
- Notes: P3 because the two scores are used in different surfaces today and a user may not directly compare. Risk increases the moment any UI surfaces both side-by-side (e.g. a "queue this scrape" CTA next to the outline row). Fix candidates: (a) rename outline-aggregator's metric `revenueLeadScore` (or similar) so naming makes the divergence explicit; (b) replace one definition with the other so both surfaces sort by the same axis. Pair with watchlist and outline-panel to keep the user-visible axis labels consistent.

## F-9225-001: Wave-palette keybind settings UI exposes 8 chord settings that no code actually reads
- Area: modules/route-assistant/wave-keybinds-store.js (DEFAULT_BINDINGS), modules/unified-settings/adapters/drag-and-palette.js (ACTION_LABELS)
- Severity: P2
- Found by: port-9225
- Status: OPEN
- Repro: open Unified Settings → "Drag & Wave Palette" → "Wave palette chords" card. Click any chord row OTHER than "Open wave palette" (e.g. "Toggle wave panel", "Save preset variant", "Pin active preset", "Next wave", "Previous wave", "Add wave", "Delete wave", "Cancel drag") and record a new chord (e.g. F8). Save. Then on any AS app page, press the new chord. Nothing happens.
- Expected: every action exposed in the chord-binding card has a working keyboard handler that consumes its chord — that's the contract the settings card establishes when it lets you edit the chord.
- Actual: only `palette.open` is wired (modules/route-assistant/wave-palette.js:558 — `RouteAssistantWaveKeybindsStore.matches(event, chord)`). All eight other action ids — `panel.toggleWaves`, `palette.savePresetVar`, `palette.pinActive`, `wave.next`, `wave.prev`, `wave.add`, `wave.delete`, `drag.cancel` — appear in DEFAULT_BINDINGS (wave-keybinds-store.js:27-37) AND in the unified-settings adapter ACTION_LABELS (drag-and-palette.js:25-35) but no keydown listener anywhere in `modules/` ever calls `RouteAssistantWaveKeybindsStore.resolve(...)` or `.matches(...)` for them. Verified via `grep -rn "WaveKeybinds.matches\|wave\.next\|wave\.prev\|wave\.add\|wave\.delete\|drag\.cancel\|panel\.toggleWaves\|palette\.savePresetVar\|palette\.pinActive" modules/ --include="*.js"` — only one call site (`palette.open` in wave-palette.js:558) and the two definition files appear.
- Notes: The settings card promises functionality that doesn't exist. Two fixes available: (a) wire the missing chords — `panel.toggleWaves` should toggle wave-overlay visibility (wave-overlay.js or wave-strip.js owns that), `wave.next/prev/add/delete` should drive the wave editor / wave-strip selection state, `drag.cancel` should reach drag-arbiter's cancel path, `palette.savePresetVar` and `palette.pinActive` should call into wave-palette's save-as-variant / pin-active handlers; (b) trim DEFAULT_BINDINGS + ACTION_LABELS to just the wired action ids (`palette.open`) until the consumers are built. Until either lands, the card is a mute UI surface that wastes user time setting chords that do nothing.

## F-9225-002: AesWaveRegistry.search "+star" filter is dead — looks for `preset.starredAt` which is never written
- Area: modules/route-assistant/wave-registry.js (search, line 224-225)
- Severity: P2
- Found by: port-9225
- Status: OPEN
- Repro: open the Wave Palette (Mod+Shift+K on any AS app page), type "+star" into the search box. Even with starred presets persisted (see wave-favorites-store), the filtered list comes back empty (or unchanged).
- Expected: typing `+star` in the palette returns only presets that have been starred (per the user's `RouteAssistantWaveFavoritesStore` favorites map).
- Actual: `wave-registry.js:224-225` filters `candidates.filter(p => p.starredAt != null)`. The enriched preset shape built by `wave-registry.build()` (lines 64-78) merges in `tags`, `role`, `colorToken`, `pinnedTo` from `AesWavePresetMetaStore`, but DOES NOT merge in any starred state from `RouteAssistantWaveFavoritesStore`. The only place `preset.starredAt` would be set is `presets-store.js:55` (`newPreset()` sets it to `null`); no code path ever assigns a non-null value to `preset.starredAt`. Star info lives in a separate keyed map at `routeAssistant:waveFavorites:byPresetId.<presetId>.starredAt` — and `wave-palette.js:193` correctly reads it from there for badge rendering, while `wave-registry.search` looks in the wrong place.
- Notes: Two pieces of "drift between favorites/registry/keybinds stores" mentioned in the audit prompt. Fix: in `wave-registry.build()`, load `RouteAssistantWaveFavoritesStore.load()` alongside `AesWavePresetMetaStore.load()`, then in the enriched-preset map (lines 64-78) include `starredAt: (favBlock.byPresetId[p.id] || {}).starredAt || null` so the search filter (and any future starred-preset surface) sees the right value. Bonus: the preset-store default field `starredAt: null` (presets-store.js:55) is now misleading dead code — either delete it, or designate the canonical source of truth (preset-side OR favorites-side) and migrate consumers to read from one place.

## F-9225-003: AfpSpecResolver tags AS-fetched specs as `source: "heuristic"` — doc says `"as-fetched"`
- Area: modules/aircraft-flight-plan/spec-resolver.js (line 151)
- Severity: P3
- Found by: port-9225
- Status: OPEN
- Repro: navigate to `/app/fleets/aircraft/<id>/0` for an aircraft whose typeId resolves only via the page-link fallback (NOT via `RouteAssistantFleetStore`) — i.e. fleet store is cold but the AFP page's `<a href="aircraftsType?id=…">` link is present. Watch the spec card render. Inspect `document.querySelector('[data-aes-afp-spec-card="resolved"]').dataset.source`.
- Expected: per the JSDoc at spec-resolver.js:30 — `source ∈ "cached" | "fleet-store" | "heuristic" | "as-fetched"`. A fresh AS fetch via `AESAircraftTypeSpecs.fetchById(typeId)` should be tagged `"as-fetched"`.
- Actual: line 151 sets `const source = (viaPath === "fleet") ? "fleet-store" : "heuristic"`. Anything that wasn't fleet-store-derived gets the `"heuristic"` label, regardless of whether the data came from a fresh AS fetch or from a heuristic. The `"as-fetched"` enum value the doc lists is never actually used anywhere in the resolver. (The "heuristic" label IS appropriate when `RouteAssistantFuelBurn.heuristic()` synthesises burn data, but that's a different module entirely.)
- Notes: The mismatched value is currently only consumed by `data-source` on the rendered card (line 243), and downstream `_spec.source === "auto-build"` checks in flight-studio/panel.js never compare against "heuristic" or "as-fetched". So this is cosmetic today. Fix: change line 151 to `(viaPath === "fleet") ? "fleet-store" : "as-fetched"` and either remove `"heuristic"` from the doc enum or note that the fuel-burn helper is the only legitimate user of that label. Keep noting wherever `source` is exposed so future consumers gain a stable contract.

## F-9225-004: schedule-builder.validatePreset misreports "connection gap below minTransfer" for waves that legitimately wrap midnight
- Area: modules/schedule-management/schedule-builder.js (lines 41-49, validatePreset)
- Severity: P3
- Found by: port-9225
- Status: OPEN
- Repro: by code review + ScheduleFactors semantics — create a preset wave with `arrivalWindow.end = "23:30"` and `departureWindow.start = "00:30"` (a legitimate wave that wraps midnight, e.g. for a hub serving late-night arrivals connecting to early-morning long-hauls). Run `new ScheduleBuilder(preset).validatePreset()`.
- Expected: validator either accepts the wave (gap is +60 minutes when interpreted as wrapping) or rejects with a precise "windows wrap midnight — not supported" message. Either is honest.
- Actual: `gap = ScheduleFactors.minutesBetween("23:30", "00:30")` returns `-1380` (minutes-between subtracts parsed minutes-since-midnight without wrap awareness). Then `gap < minTransferMinutes` is true (the default is 45), so the validator reports `"wave N: connection gap (-1380m) is below minTransferMinutes (45m)"`. The negative number leaks through to the UI; the wave is rejected for the wrong reason; the user can't tell whether the validator hates the wrap, hates the gap, or has a bug.
- Notes: Same wrap-blindness affects `ScheduleFactors.minutesBetween` and any consumer that calls it on cross-midnight pairs (used by transit checks at lines 42-43 too — `minutesBetween("06:30", "06:00")` returns -30 even when the user might mean "30 minutes before midnight to 06:00 next day"). Fix: either (a) document explicitly that wave windows must be same-day (the current invariant by accident) and have validatePreset surface a clean "wave windows must be same-day; arrival end %s after departure start %s" message when the negative-gap path triggers; or (b) teach `minutesBetween` an `assumeWrap` option and fix the validator to use it. (a) is lower-risk and matches what the rest of the builder assumes. While there: `withinWindow` already handles wrap, so the codebase has both behaviours co-existing — pick one and document it.

## F-9225-005: AfpAutoPreview disabled-button helptext says "Waiting for route candidates (Slice C)" but the empty-state below it instructs the user to click the disabled button
- Area: modules/aircraft-flight-plan/auto-scheduler/preview-panel.js (gantt empty-state copy + CTA disabled-state)
- Severity: P3
- Found by: port-9225
- Status: OPEN
- Repro: open `/app/fleets/aircraft/<id>/0` for an aircraft whose route candidates haven't been generated this session (i.e. you haven't visited the per-route scheduling page or run the route-candidates panel for this hub yet). Look at the "Auto-build (preview)" card. The "Auto-build week" button has `disabled` and `title="Waiting for route candidates (Slice C)."`. Right below, the gantt-area placeholder says `No build yet. Click "Auto-build week" to generate a proposal.`
- Expected: the empty-state instruction is consistent with the button's disabled-state — either tells the user what to do FIRST to unblock the button (e.g. "Open this aircraft's hub on /app/com/scheduling so route candidates are computed, then return here"), or omits the click instruction when the button can't be clicked.
- Actual: the user sees a button they're told to click but that's already disabled, and the disabled tooltip mentions an internal slice name ("Slice C") rather than a user-actionable next step. Minor friction — but compounded for new users who don't know what "Slice C" is.
- Notes: Verified live at chrome-devtools MCP port 9225 on `/app/fleets/aircraft/21944/0`: `cta.title === "Waiting for route candidates (Slice C)."`, `cta.disabled === true`, `gantt.textContent === 'No build yet. Click "Auto-build week" to generate a proposal.'`. Two-line fix: (a) replace "Slice C" with a user-readable phrase in the disabled tooltip; (b) swap the gantt placeholder text when the CTA is disabled to "Route candidates not ready yet — open the route candidates panel first." (read the same predicate the CTA reads to decide).

## F-9225-006: CanvasShell._renderCurrentView's wave-view branch references undefined `T` — fresh Canvas open in waves view throws ReferenceError before rail / first-run overlay can mount
- Area: modules/canvas/canvas-shell.js (line 460, inside _renderCurrentView)
- Severity: P1
- Found by: port-9225
- Status: OPEN
- Repro: open `/app/fleets`, click "▦ Open Schedule Canvas". (`AesCanvasStateStore`'s default is `view: "waves"`, so a first-time / freshly-cleared user lands on the wave branch.) Watch the page console.
- Expected: the canvas modal mounts cleanly — header, hub picker, view toggle, wave spine, destinations dock, assistant rail, first-run overlay all rendered.
- Actual: console emits `[AES Schedule Canvas] open failed ReferenceError: T is not defined` (verified live at chrome-devtools MCP port 9225 on /app/fleets — see msgid=39 in the page console). The throw originates at `canvas-shell.js:460` — `this._mountDestinationsDock(inner, T)` — where `T` is referenced but never bound in `_renderCurrentView()`'s scope. (`T` is bound locally in `mount()` at line 67 and `_renderHeader()` at line 405, but those locals don't survive into `_renderCurrentView()`.) The callee `_mountDestinationsDock(parentEl, T)` at line 467 correctly takes T as a parameter; the caller at 460 is the bug. Git blame: line 460 was added in commit 911baa4d on 2026-04-29.
- Notes: When the throw fires, `CanvasShell.mount()` rejects — which means `CanvasModal._mount()` skips `_mountRail()` (line 159), `_wireScheduleWatcher()` (line 163), AND `CanvasFirstRunOverlay.maybeShow` (line 167). User sees a partial canvas: the header + spine render (the throw happens AFTER `spineRenderer.render()` at line 445) but the destinations drag-source dock is missing, the assistant rail never mounts, and the schedule watcher never attaches — cross-tab schedule changes won't repaint. The error is silently swallowed by `fleet-schedule-grid/host.js:181`'s catch handler ("[AES Schedule Canvas] open failed"), so the user has no in-page signal. Not reproducible after the user toggles to Timeline view: switching writes `view: "timeline"` to AesCanvasStateStore, and on the next open the timeline branch (lines 413-422) doesn't reference T. So the bug is invisible to anyone who happened to leave the canvas in timeline view, and silently blocks first-time / cleared-state users in the default view. Fix is one line: at canvas-shell.js:460, define `const T = (typeof window !== "undefined" && window.AESTokens) || null` at the top of `_renderCurrentView()` (mirroring `_renderHeader()` line 405).

## F-9227-001: Conductor `cash.balance.changed` signal never fires — storage-key prefix mismatch with snapshot-store
- Area: modules/conductor/signal-layer.js (line 305) ↔ modules/accounting/snapshot-store.js (line 26) ↔ modules/conductor/scenarios.js (`CashStep`, lines 275-292)
- Severity: P1
- Found by: port-9227
- Status: OPEN
- Repro: at any AS app page, open DevTools and run `chrome.storage.local.get(null).then(b => Object.keys(b).filter(k => /accounting:balance/.test(k)))`. Observed format is `<server><airline>accounting:balance:<weekId>` (e.g. `free1ACCaccounting:balance:2026-05-02`) — set by AccountingSnapshotStore._tabKey: `server + airline + "accounting:" + type + ":" + weekId`. signal-layer's router is `if (key.indexOf("accounting:balance:") === 0) return _onBalanceChange(...)` (signal-layer.js:305) — strict prefix-at-zero match. The actual key starts with the server name, so indexOf returns the position of "accounting:" inside the key (>0), never 0. The route NEVER fires. Confirm by visiting `/app/finance/accounting/1` (Balance Sheet), waiting for the balance scrape to land in storage, then `chrome.storage.local.get([<the new key>])` shows the record exists but `AesConductorSignalStore.recent({server,airline}).then(arr => arr.filter(s => s.type === "cash.balance.changed"))` is empty.
- Expected: every balance-sheet scrape emits a `cash.balance.changed` signal so downstream `CashStep` (scenarios.js:275-292) can fire when the bank balance moves > 100,000 AS$.
- Actual: the routing branch's prefix match fails for every real key the snapshot-store writes, so the extractor never runs. CashStep is dead. Even if the route DID match, `_onBalanceChange` reads `change.newValue.balance` / `.cash` (signal-layer.js:170-171), but the snapshot-store's record shape is `{weekId, type, scrapedAt, payload}` (no top-level `balance`/`cash` field) — the extractor would silently no-op via the `if (oldBal === newBal) return` guard.
- Notes: Two-step fix: (a) update the route check to `/^[a-z][a-z0-9-]*[A-Z]{3}accounting:balance:/.test(key)` (or a cleaner regex matching `<server><airline>accounting:balance:<weekId>`); (b) update `_onBalanceChange` to read the cash balance out of `newValue.payload.cashBalance` for bank tab and out of `newValue.payload.totals` for balance/income tabs. Cleaner alternative: emit the signal directly from `AccountingSnapshotStore.saveTab` when type==="balance" or type==="bank" — that decouples the signal from chrome.storage.onChanged race timing entirely. The signal-layer docstring (line 19) describes the expected key format as `accounting:balance:<server>:<airline>` which has never matched the actual key shape; this looks like docstring/code drift that no integration test caught because `?aes-debug` smoke doesn't exercise the route extractor.

## F-9227-002: AesMarketingBudgetStore leaks budget data across accounts via legacy KEY_BASE fallback
- Area: modules/marketing/budget-store.js (lines 54-80)
- Severity: P1
- Found by: port-9227
- Status: FIXED
- Repro: at any AS app page, run in DevTools: (1) `await AesMarketingBudgetStore.save({server:"free1", airline:"AAA", regions:[{regionId:"europe", currentBudgetAS:50000}]}, {server:"free1", airline:"AAA"})` — note no accountId in the ctx, simulating a hand-seed before account-registry mapped this airline. (2) `await AesMarketingBudgetStore.load({accountId:"acct-totally-different", server:"free2", airline:"BBB"})`.
- Expected: load returns null because no record exists for the second account.
- Actual: load returns the FIRST account's regions array. Reason: save's line 76 (`if (!stamped.accountId) writes[KEY_BASE] = stamped`) wrote the record to the unscoped legacy `aesMarketing:budgets` key. load's line 57-58 fetches both the scoped key and KEY_BASE, returning `got[scopedKey] || got[KEY_BASE] || null` — so any new account whose scoped key has no record falls through to the legacy global record.
- Notes: This is a cross-account data leak: the marketing tuner reads via `load(ctx)` which respects accountId at the call surface, but the store still serves up another account's budget. Especially risky for users with sister airlines on the same Chrome profile. Fix: change line 58 to `return got[key] || (ctx && ctx.accountId ? null : got[KEY_BASE]) || null` — only fall back to the legacy global when the caller has no accountId hint at all. Better long-term fix: stop writing KEY_BASE on save when the caller has any scoping signal; reserve KEY_BASE strictly for the "single-account install with no registry" case.

## F-9227-003: competitor-response `_writeFreqCooldown` writes the cooldown record TWICE per fire (and the first write's rejection is unhandled)
- Area: modules/strategy/competitor-response.js (lines 326-335)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: code review — the construction is `chrome.storage.local.set({...}).catch && chrome.storage.local.set({...}).catch(() => {})`. The first `.set(...)` returns a Promise; `.catch` is the truthy `Promise.prototype.catch` reference. The `&&` then evaluates the right side: a SECOND `chrome.storage.local.set(...)` call with the same payload, with its own `.catch(() => {})` swallowing rejections. End result: every successful path runs `chrome.storage.local.set` twice; the FIRST call's rejection (if any — quota / disk) is unhandled and surfaces as an "Uncaught (in promise)" page-console warning. Verify by adding a temporary breakpoint on `chrome.storage.local.set` and triggering competitor-response via `await AesStrategy.proposeCompetitorMoves(snapshot)` with a freq-add event prior matching a route.
- Expected: a single fire-and-forget set per cooldown roll-forward (the function header says "Persist a fresh freq-proposal timestamp. Fire-and-forget").
- Actual: every call writes twice, doubling chrome.storage write traffic and chrome.storage.onChanged dispatch (which the conductor signal-layer also reacts to). On rejection the first write surfaces an unhandled-rejection warning.
- Notes: The intent was almost certainly `chrome.storage.local.set({...}).catch?.(() => {})` but landed as two statements joined by `&&`. Fix: hoist the promise — `const p = chrome.storage.local.set({[k]: {...}}); if (p && typeof p.catch === "function") p.catch(() => {})`. Same pattern should be searched for elsewhere in the strategy module — this kind of "guard + call" lash-up tends to copy-paste.

## F-9227-004: pricing-engine.timeDecayCompetitorBand double-counts when both `historic.weeks` and `historic.byPayload` are populated
- Area: modules/strategy/pricing-engine.js (lines 68-110)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: code review of `timeDecayCompetitorBand(historic, opts)`. Lines 73-81 push rows from `historic.weeks` into `rows[]`; lines 82-93 push rows from `historic.byPayload` into the SAME `rows[]`. No de-duplication. Sample input: `{weeks:[{timestamp:T1, priceMin:100, priceMax:120}], byPayload:{[T1]:{timestamp:T1, priceMin:100, priceMax:120}}}` returns `priceMin: 100, samples: 2` — the same observation contributed twice with the same time-decay weight, so both halves of the weighted average are duplicated.
- Expected: each observation contributes once to the time-decayed band.
- Actual: when the upstream parser ships both shapes (the `routeAssistant:markets:historic:<HUB>-<DEST>` store does, when it captures per-payload + weekly aggregates), every observation is double-counted. `priceMin`/`priceMax` averages are biased toward whichever data is duplicated. Downstream pricing-compass + auto-driver pricing decisions consume this directly.
- Notes: Fix: dedupe by timestamp before computing weighted averages — `const seen = new Set(); rows = rows.filter(r => { const k = isFinite(r.ts) ? r.ts : ""; if (seen.has(k)) return false; seen.add(k); return true })`. Or pick ONE source: prefer `byPayload` when present (richer per-observation), fall back to `weeks` only when byPayload absent. The latter is less defensive but cheaper.

## F-9227-005: pricing-engine._gatherTuples merges `route.orsHistory` and yield-history-store without dedup — biases the elasticity fit
- Area: modules/strategy/pricing-engine.js (lines 122-154)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: code review. `_gatherTuples` aggregates (price, lf, ts) tuples from `route.orsHistory` (snapshot-attached, lines 125-136) AND from `RouteAssistantYieldHistoryStore.loadRecord` (storage, lines 137-152). No timestamp de-dup. Both sources cover overlapping observation weeks once the scrapers have been running for >1 week. The tuples list contains duplicates, and the `_gridSearch` in elasticity-fit weights every duplicate equally.
- Expected: each (price, lf, ts) observation contributes once to the logistic fit.
- Actual: duplicate observations bias `p₀` toward the over-represented bucket, and the residual-driven `confidence` tier inflates because residual goes toward zero on duplicated points (RMSE math: same observation twice halves the per-point error contribution). The auto-driver's price recommendations consume this confidence tier in `_recommendForRoute` (pricing-engine.js:225-275) — so a "high" confidence label can mask a duplicate-driven over-fit.
- Notes: Fix: dedupe by ts before returning. `const map = new Map(); for (const t of tuples) { if (!map.has(t.ts)) map.set(t.ts, t) } return Array.from(map.values())`. Slightly safer to dedupe by (Math.round(ts/86400000), pricePct) — collapses same-day observations of the same price into one, which is the intended granularity per yield-history-store's daily snapshots.

## F-9227-006: backtest._profitFromIncomeTotals lowercase `"adjebitda"` never matches the scraper's `"adjEbitda"` (camelCase) — third fallback is dead code
- Area: modules/strategy/backtest.js (line 122) ↔ modules/accounting/income-scraper.js (line 90)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: code review. `_profitFromIncomeTotals` iterates `["ebt", "ebit", "adjebitda"]` and returns the first finite `totals[k].current`. AccountingIncomeScraper._totalKey returns `"adjEbitda"` (camelCase) for the "Adjusted EBITDA" row. `totals["adjebitda"]` is always undefined — the third fallback NEVER triggers. Verify by inspecting any stored income snapshot: `await AccountingSnapshotStore.loadLatest(server, airline).then(rec => Object.keys(rec.income.payload.totals))` shows `["revenue","adjEbitda","ebitda","ebit","ebt"]` — note the camelCase.
- Expected: when totals contain only `adjEbitda` (e.g., a recently-incorporated airline whose first weeks have null EBIT/EBT until AS computes them), backtest falls through to it and reports a non-zero `actualProfit`.
- Actual: third fallback is dead; backtest reports `actualProfit: 0` for any week whose totals lack both `ebt` and `ebit`. Real-world impact is small (most weeks have ebit), but the backtest panel + recommend sweep both report zero where they should report adjEbitda. The smoke test (`?aes-debug`) uses `{ebt:...}` only, so the bug doesn't surface there.
- Notes: One-character fix at backtest.js:122 — change `"adjebitda"` to `"adjEbitda"`. Same scan should look at `_totalKey`'s lowercase outputs (`"revenue"` and `"ebitda"`) — those match because the scraper falls through to `label.toLowerCase()` for those rows. Only the explicit-cased `adjEbitda` got out of sync.

## F-9227-007: signal-layer `_onCompetitorChange` only fires on competitor-count change — price-only moves never surface as signals
- Area: modules/conductor/signal-layer.js (lines 147-165) ↔ modules/strategy/competitor-response.js (depends on `competitor.changed`)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: simulate a price-only market change in DevTools at any AS app page: `chrome.storage.local.set({"markets:competitors:FRA-LHR": {competitors: [{carrier:"X", priceMin:80, priceMax:110, flightCount:7}]}}); setTimeout(() => chrome.storage.local.set({"markets:competitors:FRA-LHR": {competitors: [{carrier:"X", priceMin:60, priceMax:95, flightCount:7}]}}), 200)`. Watch with `AesConductorSignalStore.recent({server,airline}).then(arr => arr.filter(s => s.type === "competitor.changed"))` — empty. Now repeat with a count change (add a second competitor) and the signal fires.
- Expected: a `competitor.changed` signal carrying price-delta fires when ANY material competitor field changes, so CompetitorEntry/CompetitorExit/competitor-response.js can pick up price-cuts and price-hikes through the conductor pipe. The signal-layer docstring (line 18) lists `markets:competitors:<route> → competitor.changed` without restricting to count.
- Actual: line 155 (`if (before === after) return`) exits silently when the array length is unchanged, so price-only moves are masked at the signal layer. competitor-response then has to fall back to its own bulk diff via `bulkLoadPrior` — the SCENARIO engine never fires CompetitorEntry/Exit on price moves, and no scenario in scenarios.js distinguishes "competitor cut prices" from "competitor entered." Effective result: the conductor surfaces freq-driven competitor moves but stays silent on the most common reaction-worthy event (price war).
- Notes: Fix: detect price-min and price-max deltas alongside count-delta. When `before === after && (newPmin !== oldPmin || newPmax !== oldPmax)`, emit `competitor.changed` with `direction: "priceCut" | "priceHike"` and a `priceDeltaPct` payload. competitor-response already classifies these in `_classifyEvents` (competitor-response.js:133-173), so the signal layer doesn't need to do the threshold work — it just needs to emit on ANY price change so the existing classifier path picks it up.

## F-9227-008: apply-pipeline._persistAudit overwrites legacy AUDIT_KEY ring with each scoped account's full ring — back-compat reader sees only the last-applied airline
- Area: modules/strategy/apply-pipeline.js (lines 153-171)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: with two airlines on the same Chrome profile, both with accountId resolved by AesAccountRegistry: (1) apply a plan on airline A — `await AesStrategy.apply(planA)`. (2) inspect `chrome.storage.local.get(["aesStrategy:audit"]).then(b => b["aesStrategy:audit"].length)` → some N. (3) apply a plan on airline B. (4) re-inspect → ring length is whatever airline B's scoped ring length is, NOT N + B's-applies. Airline A's audit entries are gone from the legacy key (still present in `aesStrategy:audit:acct:<idA>`).
- Expected: per the comment (apply-pipeline.js:80-83), the legacy key "stays current so a fresh install reading the unscoped key sees the most recent apply across all accounts (the old behaviour)."
- Actual: when `scopedKey` exists, line 160 picks `readKey = scopedKey`, ring is the SCOPED account's ring, and lines 165-167 write that ring to BOTH the legacy AUDIT_KEY and the scoped key. Each apply on a different airline clobbers the legacy ring with that airline's history. A back-compat reader on the legacy key sees a single-account view, not "most recent across all accounts."
- Notes: Fix: stop writing AUDIT_KEY when scopedKey is present (the scoped key is the source of truth; legacy reads remain frozen at the last unscoped install state — a clean break). Or maintain a real cross-account legacy ring: read both legacy and scoped, merge by ts, cap, write — heavier but matches the comment's promise. The former is the cleaner minimal fix; the comment in the code says scoped IS the new source of truth, so the legacy mirror was always going to drift.

## F-9227-009: elasticity-fit doc + smoke test sign convention is inverted vs real airlinesim demand — documents `k<0` as demand-elastic, but with the bundled formula `k<0` produces a Giffen-good curve
- Area: modules/strategy/elasticity-fit.js (lines 8-12 docstring, 226-236 smoke test)
- Severity: P2
- Found by: port-9227
- Status: FIXED
- Repro: run the formula directly in DevTools: `const sig = (p, params) => params.L / (1 + Math.exp(params.k * (p - params.p0))); const tp = {L:0.92, k:-0.05, p0:110}; [80, 110, 140].map(p => [p, sig(p, tp)])` → returns `[[80, 0.168], [110, 0.46], [140, 0.752]]`. Higher price → HIGHER LF. That's a Giffen-good curve. Real airlinesim demand goes the other way (price↑ → LF↓), so real data fits with `k > 0`, NOT `k < 0`. The smoke test (line 226) generates synth data with `k:-0.05` and asserts `f.slope < 0` (line 236) — passes on the synthetic Giffen data, masks the inverted convention.
- Expected: per the header comment "k = slope (negative when raising price reduces LF — the natural direction for any non-Giffen good)", `k < 0` should produce LF DROPPING as price rises. The bundled formula gives the opposite.
- Actual: the math is internally consistent (the fitter recovers whatever sign the data has), so production isn't broken — when fed real airlinesim data, the fitter returns `k > 0` and `suggestPriceForLfTarget` correctly returns lower prices for higher LF targets. But the docs + smoke test are inverted from reality, so anyone extending the engine from the docstring will write inside-out logic. The `slope < 0` assertion in the smoke is meaningless — any synthetic data will round-trip whatever k it was generated with.
- Notes: Two valid fixes: (a) flip the formula to `lf = L / (1 + exp(-k * (p - p0)))` so `k > 0` means demand-elastic for normal goods, and update the synth data + assertion; (b) keep the formula and update the docstring + smoke synth data to use `k > 0` for the "normal demand" case. (b) is the smaller diff. Either way, the smoke test should also assert direction by comparing two synthetic LFs at different prices, not just by recovering an arbitrary k sign.

## F-9227-010: AccountingSnapshotStore.saveTab reads-modifies-writes the index across `await` — concurrent saveTab calls drop hasIncome/hasBalance/hasBank flag accumulation
- Area: modules/accounting/snapshot-store.js (lines 45-92, `saveTab`)
- Severity: P3
- Found by: port-9227
- Status: FIXED
- Repro: from two AS app windows visiting `/app/finance/accounting/0` (Income) and `/app/finance/accounting/1` (Balance) for the same airline at near-the-same moment: both call `AccountingSnapshotStore.saveTab(...)`; both `await chrome.storage.local.get([indexKey])` see the same baseline index; both `entry["has" + Type]= true` on their LOCAL copy; both `await chrome.storage.local.set({key, indexKey})` — second write wins on the indexKey, so the first scrape's hasX flag is silently lost from the index entry. The PER-TAB record (the income/balance key) is preserved fine because each writes its own key.
- Expected: after parallel income+balance scrapes for the same weekId, the index entry shows both `hasIncome:true` and `hasBalance:true`.
- Actual: only the flag from the second-finishing scrape persists. Side-effect: the panel + the Conductor's central-hub-shell read hasX flags off the index when deciding whether to surface "complete week" — so a partially-scraped week may render as "complete" or "missing" depending on which scrape lost the race.
- Notes: In current usage the scrape-orchestrator visits accounting tabs sequentially (phases.js:91-93), so the race is theoretical for orchestrator-driven scrapes. Becomes real when a user opens two accounting tabs simultaneously, or if a future orchestrator slice parallelises sub-page scrapes (concurrency:3 is already enabled at the foundation phase). Fix: serialise saveTab through an in-process queue, mirroring the pattern in conductor/signal-store.js's `_serialize` (lines 40-45). `let _q = Promise.resolve(); function _serialize(fn){ const next = _q.then(fn, fn); _q = next.catch(() => {}); return next }`. Cheap, two-line addition; covers same-page concurrency. Cross-page races on the same key remain inherent to chrome.storage.


## F-9223-009: AES.getServer is undefined — 9 panel-relevant call sites silently fall back to null, blanking strategy/cash/fleet roll-ups
- Area: cross-cutting (helpers.js + 9 consumers)
- Severity: P1
- Found by: port-9223
- Status: OPEN
- Note: port-9223 attempted both fix paths — alias on helpers.js and consumer-side rename to getServerName — both were reverted by external linter/agent. Releasing claim; deferred.
- Repro: at chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/bridge.html load helpers.js and inspect: `Object.getOwnPropertyNames(AES).sort()`. The class only defines `getServerName`, `getAirlineCode`, `getAirlineIdentity`, `getServerDate`, `getDateDiff`, plus formatters — NOT `getServer`. Live: `{hasGetServer:"undefined", hasGetServerName:"function"}`.
- Expected: every consumer that uses the standard pattern `AES.getServer && AES.getServer()` returns the server name (mirroring `AES.getServerName()`).
- Actual: 10 source-file call sites use `AES.getServer ?…:null` / `AES.getServer && AES.getServer()` and silently get null because `AES.getServer` is undefined. Files:
  - modules/_shared/fleet-roster.js:122 (`AesFleetRoster.loadCurrent` → empty fleet shape)
  - modules/_shared/views/accounting-ledger.js:52 (`accounting:ledger` view → memo never primed for current AS)
  - modules/central-hub/feed/cash-feed.js:97 (`hub:cash:weekly` HubFeed slice → "no airline", muted)
  - modules/strategy/context.js:76 (`AesStrategy.snapshot` → server null → fleet load returns empty → entire snapshot misses fleet/routes/competitors)
  - modules/strategy/panel.js:128 (Strategy panel scope filter → null)
  - modules/central-hub/tiles/strategy-tile.js:977,1114 (portfolio rollup + `_buildOpenCta` server selector → null)
  - modules/aircraft-flight-plan/auto-scheduler/fleet-picker-modal.js:242 (only this one falls back to `getServerName` on miss — the rest don't)
- Notes: All callers gracefully no-op rather than throwing, so there's no console error — the panels just render with empty/muted states and the user assumes "no data". Fix: alias `static getServer() { return AES.getServerName() }` in helpers.js (one line, additive, no risk to existing call sites). The deeper rename (replace `getServer` with `getServerName` everywhere) is the long-term fix but the alias unblocks every panel today.

## F-9223-010: accounting:ledger view subscribes to phantom topics — never recomputes after scrapes, panel reads stale memo
- Area: modules/_shared/views/accounting-ledger.js (lines 35-62) vs modules/accounting/snapshot-store.js (line 87) vs modules/central-hub/feed/index.js (line 35)
- Severity: P1
- Found by: port-9223
- Status: NOT-APPLICABLE
- Note: port-9223 verified that `modules/_shared/views/accounting-ledger.js` does not exist in the current tree. The phantom topic strings (`data:accounting:snapshot:saved`, `data:accounting:bank:saved`, `data:route-assistant:topRoutes:saved`) appear nowhere in the codebase either. Original finding was likely based on a planned/unmerged view file. Cash-feed slice does subscribe to `data:accounting:weekly:saved` correctly (cash-feed.js:36). Skipping; if the view is added later, the topic-drift fix needs to ship with it.
- Repro: grep emit/publish call sites for the three deps. The view declares deps `data:accounting:snapshot:saved`, `data:accounting:bank:saved`, `data:route-assistant:topRoutes:saved`. None of those exact strings are emitted anywhere. The actual producer for accounting publishes `data:accounting:snapshot:updated` (note the verb mismatch: `:updated` vs `:saved`) and the storage bridge in feed/index.js emits `data:accounting:weekly:saved` (different slice). `data:accounting:bank:saved` and `data:route-assistant:topRoutes:saved` are not emitted by any module.
- Expected: an accounting scrape on `/app/finance/accounting/{0,1,2}` triggers the view to recompute and any consumer (bridge accounting-pane Phase 2C) sees a fresh ledger.
- Actual: the view's eager compute primes the memo on declare, but every subsequent dep firing is on a phantom topic — no recompute. `AesAccountingLedger.compute(server, airline)` returns the stale memo until the page reloads. Subscribers via `AesView.subscribe("accounting:ledger", …)` never fire after the first load.
- Notes: Two separate routing bugs colliding here — (1) the `:saved` vs `:updated` verb drift between snapshot-store's emit and the view's dep list, and (2) phantom dep names that no producer or bridge emits. This is the kind of typo `AesView.declare` should surface, but it has no validation hook. Fix: change deps to the actual emit shapes — `data:accounting:snapshot:updated`, `data:accounting:weekly:saved`, `data:route-assistant:topRoutes:*` (no such topic exists; topRoutes is written by RA panel via direct chrome.storage.set — needs a bridge in feed/index.js OR a publish call from the writer). Pair fix: have `AesView.declare` warn once per dep that's neither registered in `data-bus-topics.js` nor matches an existing view topic — a simple drift detector.

## F-9223-011: HubFeed pipeline is dashboard-only — feed/index.js bridges + bootstrap signal load only on /app/enterprise/dashboard, so non-dashboard tiles/panels never receive feed updates
- Area: modules/central-hub/feed/index.js + manifest.json (dashboard content_scripts block) + central-hub/shell.js:53
- Severity: P2
- Found by: port-9223
- Status: OPEN
- Note: port-9223 attempted manifest move (feed/index.js, cash-feed.js, strategy-feed.js dashboard-block → wildcard `_shared` block) plus matching bootstrap-signal emit in feed/index.js. Manifest move was reverted by linter/external agent (intentional). Releasing claim.
- Repro: read manifest.json — `modules/central-hub/feed/index.js` is in the `/app/enterprise/dashboard` block (around line 243), not the `/app/* + /action/*` wildcard block. shell.js (line 53) emits `data:account:bootstrapped` in `mount()` — the shell only mounts on `/app/enterprise/dashboard*`. Three HubFeed slices (`hub:cash:weekly`, `hub:strategy:applied`, `hub:strategy:settings`) declare deps that include `data:account:bootstrapped` and topics that come from feed/index.js bridges — neither flows on non-dashboard pages.
- Expected: any tab that mounts CentralHubTiles (the same tile classes can render on bridge.html or via fleet-overlay) gets fresh values when the underlying storage changes.
- Actual: on non-dashboard pages, none of the three feed/index.js bridges install (so storage writes don't translate to bus topics) and `data:account:bootstrapped` never fires. Slices fall through to their eager initial compute, then silently stay stuck — the `feedSlices()` subscription on tiles never fires after first paint. Tiles that bypass via `watchedStorageKeys()` still update; tiles that committed to feedSlices (e.g. strategy-tile uses both — its feedSlices side stays frozen but watchedStorageKeys keeps it half-alive) end up showing mixed-freshness state.
- Notes: bridge.html in particular loads many of the same tile-style panels (subsidiary-cards, opportunities-panel, accounting-pane) and depends on the accounting-ledger view's recomputes — combined with F-9223-010, the whole bridge's Accounting pane is stuck on whatever state existed at first paint. Fix: move feed/index.js's bridges + the account-bootstrapped emit into the wildcard `_shared` block (or a new universal "feed-boot" block) so any AES content-scripted page wires them up. Defensive guard already exists (`__aesHubFeedBooted`).

## F-9223-012: Fleet roster + accounting tile + competitor-monitoring tile all use legacy `<server><airline>...` keys with NO account scoping — multi-airline users see mixed data
- Area: modules/_shared/fleet-roster.js, modules/accounting/snapshot-store.js, modules/central-hub/tiles/{fleet-hub,accounting,competitor-monitoring}-tile.js
- Severity: P1
- Found by: port-9223
- Status: OPEN
- Repro: enumerate writers of fleet keys — `content_fleetManagement.js` writes `<server><airlineCode>aircraftFleet`. Account-registry's `acctKey()` framework is documented in modules/_shared/account-scoped-key.js, and migrate-legacy.js's `SETTINGS_AREAS` covers only `routeAssistant` + `aircraftFlightPlan`. Fleet, accounting, and competitor-monitoring (`type:"competitorMonitoring"` storage records) are NEVER scoped per account. With two airlines on the same server: scrape airline A's fleet, switch to airline B (top-nav switch), open the dashboard hub — fleet-hub-tile's `_findFleetRecord` returns "the freshest aircraftFleet entry on this server" which is still A's record until B's fleet is also scraped. accounting-tile reads `<server>+AES.getAirlineCode().code+accounting:index` — the AS top-nav airline code drives which records load, but the *records* under the OTHER airline's key are silently shadow data: the user thinks they have no accounting history when they actually have a previous airline's data sitting at a sibling key.
- Expected: switching airlines changes which fleet/accounting/competitor records the panels surface; no cross-airline contamination.
- Actual: fleet-hub-tile picks "newest by max(a.time)" across all `*aircraftFleet` keys on the server (fleet-hub-tile.js:82-88) — purely temporal heuristic, doesn't filter by current account. competitor-monitoring-tile reads `chrome.storage.local.get(null)` and filters only by `v.type==="competitorMonitoring" && v.tracking && v.server===server` — no account filter at all (so airline A's tracked competitors leak into airline B's view). accounting-tile depends on `AES.getAirlineCode().code` which throws on non-dashboard pages (the `.facts table` only exists on /app/enterprise/dashboard) — falls back to ctx.airline which is set by the shell once on dashboard mount; navigating to a sister account post-mount doesn't update.
- Notes: Same shape as the L1/L2 migration but L3 (Class B/C/D account-scoping) hasn't reached these stores yet — HANDOVER §10 explicitly calls fleet/accounting/competitor "Class B" (account-perspective observations) which are deferred. Until L3 lands, two cheap mitigations: (a) the `aesAccounts.viewingAccountId` is updated on every page mount; tiles can use it to filter `<server>+<acctsanitized>+...` candidate keys instead of "the freshest by time"; (b) competitor-monitoring should at least add `v.viewingAccountId === active` filter once snapshot-store starts stamping it.

## F-9223-013: AesFleetRoster._resultMemo invalidates across ALL airlines on a single airline's fleet save — multi-airline users force a `chrome.storage.local.get(null)` full-scan on every fleet refresh
- Area: modules/_shared/fleet-roster.js (lines 50-60)
- Severity: P3
- Found by: port-9223
- Status: NOT-APPLICABLE
- Note: port-9223 verified `_resultMemo` doesn't exist anywhere in the codebase (`grep -rn "_resultMemo"` returns 0 hits). Current `AesFleetRoster.load()` does `chrome.storage.local.get(null)` directly with no memoization layer — finding was based on planned/unmerged code. The full-scan-cost concern remains valid but the named invalidation bug doesn't apply to current code.
- Repro: code review. The shared invalidator listens for any chrome.storage.local key ending in `aircraftFleet`; when ANY airline's fleet record updates, `_resultMemo.clear()` wipes the memo for every (server, airlineCode) tuple. Next read hits `chrome.storage.local.get(null)` (full storage scan).
- Expected: invalidate ONLY the (server, airlineCode) tuple whose fleet record changed.
- Actual: A's fleet save invalidates B's memo. With ~20 calls into AesFleetRoster.load per panel re-render (strategy/context.js:99, fleet-command.js:118, portfolio.js:58/64, etc.) and many populated installs, every fleet scrape from one airline re-pays the full-scan cost for everything else. ~10ms-300ms of jank depending on storage size.
- Notes: Fix: parse the changed key (`<server><sanitizedAirline>aircraftFleet`) → reverse-lookup the matching memoKey via the registry (or map `_resultMemo` keys by suffix); only delete that one entry. Same shape as `AesStoreCache.invalidatePrefix` but for the result memo instead of the L0 cache. While in there, drop the `chrome.storage.local.get(null)` in `load()` in favour of a per-server scoped `get` once accounts are enumerable from the registry — the all-keys read is the single most expensive read in the codebase.

## F-9223-014: data-flow-inspector tile is the only consumer of data-bus diagnostics — but tiles don't subscribe to flow:health, so degraded state never propagates to other tiles' freshness dots
- Area: modules/central-hub/tiles/data-flow-inspector-tile.js + modules/central-hub/tile.js (`_feedFreshness` rendering, lines 389-406)
- Severity: P2
- Found by: port-9223
- Status: OPEN
- Repro: tile.js's `_feedFreshness` is set ONLY by `_attachFeedSubscriptions()` (line 451) — i.e. only by HubFeed slice subscription, not by AesFlow.health complaints. A tile that uses watchedStorageKeys (most tiles) gets `_feedFreshness === null` always → no stale dot. Even tiles that DO use feedSlices only see their slice's age, not whether the underlying bus pathway is degraded.
- Expected: when AesFlow.health reports `signal:flow:flow-degraded` (e.g. a tile's source topic hasn't fired in 30 min when it should), affected tiles render a warning dot.
- Actual: the degraded signal is fired on the bus but no tile subscribes — the data-flow-inspector tile renders the diagnostic in its own body, but every other tile renders "fine" even when its data is days old. The freshness-dot machinery exists but is unreachable for ~25 of ~30 tiles.
- Notes: Two layers of fix. Quick: have `CentralHubTile._attachFeedSubscriptions` also subscribe to `signal:flow:flow-degraded` and to `data:flow:health:updated` — tiles whose watchedStorageKeys haven't fired in `flow.deadPathwayWindowMin` minutes get the dot too. Better: AesFlow already has a per-topic "subscribed-never-fired" diagnosis; map watchedStorageKeys / feedSlices to expected-active topics and surface per-tile staleness directly. Combined with F-9223-005 (de-spam health()) and the proper transition-only semantics, this becomes a real "this tile's pipeline is broken" indicator instead of theatre.

## F-9223-015: tile.watchedStorageKeys uses `prefix.indexOf === 0` — a tile that watches "<server>" ALSO refreshes on every other tile's writes prefixed with the same server, creating cross-tile refresh storms
- Area: modules/central-hub/tile.js (lines 436-444 legacy storage listener + 425-433 bus-bridge path)
- Severity: P3
- Found by: port-9223
- Status: OPEN
- Repro: fleet-hub-tile, accounting-tile, competitor-monitoring-tile all return `[ctx.server]` from `watchedStorageKeys` (e.g. `["zb"]`). Any storage key starting with "zb" fires every one of these tiles' refresh — including unrelated writes like `zbXX1234aircraftFleet`, `zbXX1234accounting:income:1739`, `zbXX1234competitor:5678`, etc. With three tiles all listening on the bare server prefix and storage events typically batched, every storage write fans out to ~3 redundant refreshes, each running its own full storage scan (`get(null)`) per the fallback logic.
- Expected: a tile only refreshes when its own data changes.
- Actual: cross-tile refresh storm. With `_findFleetRecord` doing `chrome.storage.local.get(null)`, fleet-hub-tile alone re-scans the entire storage on EVERY accounting write to the same server. The legacy storage listener path (line 436-444) iterates every changed key × every prefix → O(N×M).
- Notes: Fix per tile — use SPECIFIC prefixes (e.g. fleet-hub: `<server><sanitizedAirline>aircraftFleet`; accounting: `<server><airlineCode>accounting:`). Combined with the registry-aware enumeration that fleet-hub-tile already has (lines 51-67), prefixes can be exact or near-exact and avoid the cross-cutting fan-out. Even a one-character extension (e.g. `<server>+":"`) would partition the watchers along the existing key shape.

## F-9223-016: HubFeed slice TTLs are largely ttlMs:0 ("never stale by age") — the freshness dot machinery is dead weight even on tiles that opt in
- Area: modules/_shared/hub-feed.js (lines 54, 89-94) + each declared slice
- Severity: P3
- Found by: port-9223
- Status: OPEN
- Repro: declared slices use `ttlMs: 0` (hub:strategy:settings line 55), `ttlMs: 30 * 60 * 1000` (hub:cash:weekly line 39), `ttlMs: 24 * 3600 * 1000` (hub:strategy:applied line 32). For ttlMs=0, `freshness().isStale` is hard-coded false (line 93). For non-zero, isStale fires when ageMs > ttlMs — but only counts time since the LAST recompute, not since the underlying scrape that produced the value. Combined with F-9223-010 / F-9223-011, the recompute path is broken on most pages so ageMs effectively measures "time since page load."
- Expected: stale-dot reflects "underlying data is older than X" — the last accounting scrape, the last fuel-price scrape, the last fleet roster fetch.
- Actual: stale-dot reflects "time since last view recompute". On bridge.html where feed/index.js bridges don't load, ageMs grows from zero forever and tiles either (a) never show a dot (ttlMs=0) or (b) ALL show a dot once enough time passes (ttlMs>0). The dot doesn't track real-world data freshness.
- Notes: The fix is two-layer. The slice's compute function should return a `{value, scrapedAt}` envelope where scrapedAt is the underlying record's freshness timestamp; HubFeed.freshness should compare ttlMs against (now - scrapedAt) rather than (now - computedAt). Mirrors `wrapSingleKey` / `createTtlCache`'s `isFreshRecord` semantics — they already have it right.

## F-9226-010: AesCounterAircraft hardcodes paxScore=5 — counter-vs-buy verdicts biased downward on high-demand routes
- Area: modules/competitor-intel/counter-aircraft.js (_scoreExistingTails line 179, _scorePurchaseTypes line 226)
- Severity: P2
- Found by: port-9226
- Status: OPEN
- Repro: pick any high-demand route in the user's competitive landscape (e.g. JFK-LHR, expected paxScore ~8-9 in RA's topRoutes data). Open the outline panel; click into a competitor that flies that lane. Inspect `counter` in the DOM/dev console — `bestExistingTail.projectedProfitPerWeek` for any candidate is computed against `paxScore: 5` regardless of the lane's actual demand.
- Expected: counter-aircraft scores our candidates against the same demand-driven economics that the competitor's `theirs.estProfitPerWeek` uses. Either both use observed market share/paxScore, or both use a neutral default — but they must match.
- Actual: the competitor's profit estimate (built at outline-aggregator.js:486-495) uses `observedSharePct` from RA's `marketShare:<pair>` data — i.e. real demand. Our candidates are ALL scored with `paxScore: 5` (counter-aircraft.js:179, 226), which RA's profit-estimator interpolates as load factor `paxLfMin + 0.5 * (paxLfMax - paxLfMin)` and yieldDemandMult≈1.0 (profit-estimator.js:128-129, 192-193). On a true paxScore-9 lane, our candidates undershoot their realistic profit by ~15–25%. The asymmetric scoring biases the verdict toward `buy-needed` even when an existing tail would in fact win at the actual demand level.
- Notes: Counter-aircraft's whole purpose is to compare like-for-like. The fix has two reasonable shapes: (a) thread the route's actual paxScore from RA's topRoutes record (`routeAssistant:topRoutes:<HUB>`'s rows carry `paxScore`) into outline-aggregator's `_buildRouteRow`, and pass it into AesCounterAircraft.recommend along with `theirSharePct`; (b) score competitor and candidates against a synthetic shared `targetLoadFactor` derived from competitor's observed share (`econ.loadFactor + 0.4 * (1 - sharePct)` or similar). Pick (a) — the data is already in storage. Bonus: this also unblocks per-route demand stamping in the outline panel header (currently absent).

## F-9226-011: AesCompetitorChangeLogAdapter starts the diff loop at i=1 — every competitor's "first observed" event is silently dropped
- Area: modules/competitor-intel/change-log-adapter.js (load(), line 100)
- Severity: P3
- Found by: port-9226
- Status: FIXED
- Repro: scrape a never-before-seen competitor for the first time (e.g. visit /app/info/enterprises/<some-id> for an enterprise not yet in `competitorIntel:enterprise:*`). Wait for the snapshot record to land at `competitorIntel:snapshots:<server>:<id>` with one entry. Open the cross-domain change-log modal → filter to "competitor-intel" → there is no entry for this competitor.
- Expected: the diff `compare(null, snaps[0])` yields a `competitor.observed` event (diff.js:40-49) which the adapter is set up to render via `TYPE_GLYPH["competitor.observed"]` and `TYPE_STATUS["competitor.observed"]: "queued"`. The first sighting should appear in the change log.
- Actual: the loop at change-log-adapter.js:100 starts at `i = 1`, so the first iteration compares `snaps[0]` to `snaps[1]`. The case `prev = null, curr = snaps[0]` is never reached. The "competitor.observed" event is dead code — the only way to fire it is for `AesCompetitorDiff.compare` to be called externally with `prev=null`, which only happens inside `snapshot-store.js:140-167` for live diff events (those go to AesDataBus, not the change log).
- Notes: Two-line fix. Shift the loop to `i = 0` and let `prev = snaps[i - 1] ?? null` handle the boundary. Or, equivalently: emit a synthetic observed event on every buf where `snaps.length >= 1` and current is NOT covered by any later compare call. Verification: `await window.AesCompetitorChangeLogAdapter.load({server: "free1"})` in dev tools — count entries with `raw.type === "competitor.observed"` should equal the number of snapshot buffers with at least one snap. Today: 0; after fix: N.

## F-9226-012: ScrapeTabPool run state in-memory only — MV3 service-worker idle eviction leaves orphan tabs and a poisoned `_busy` content-side flag
- Area: modules/scrape-orchestrator/background-tab-pool.js (state object lines 50-67); modules/scrape-orchestrator/auto-driver.js (`_busy` flag line 32, `silentRunActive` storage flag lines 70/79); modules/scrape-orchestrator/host.js (auto-resume line 184-196)
- Severity: P1
- Found by: port-9226
- Status: OPEN
- Repro: trigger Scrape Everything from /app/enterprise/dashboard with foundation+per-hub phases enabled. Mid-phase, force-evict the service worker (chrome://serviceworker-internals → "Stop" on the AES SW). The hidden tabs the pool opened remain visible in the chrome://tabs/ inspector; chrome.runtime.sendMessage from the dashboard (Status check) returns `{running: false}` because pool.state was wiped. New click on Scrape Everything starts a fresh run that opens a SECOND set of hidden tabs alongside the orphans.
- Expected: pool persists enough run state (runId, plan cursor, activeTabIds) to chrome.storage.local that on SW boot it can either resume the run or clean up orphan tabs by closing them. The dashboard's auto-resume should also be able to detect a half-dead run and surface it.
- Actual: state is a closure-local object (background-tab-pool.js:50-67). Nothing is persisted. When the SW restarts:
  - `state.running = false` even though tabs created via `chrome.tabs.create` are still alive
  - `state.activeTabs` is empty so `abortRun` cannot close them
  - Orchestrator content-side `_runPhaseJobs` waits for `run-done` that the pool can no longer emit (related to F-9226-007)
  - auto-driver.js sets `aesAutoDrive:silentRunActive: true` at line 70 but the `finally` at line 79 never runs if SW dies mid-run; that storage flag stays true forever. host.js:191 reads it and gates auto-resume on it — no resume, no UI hint that anything is wrong.
  - Subsequent ticks of the auto-driver's `_doTick` short-circuit at "busy"/"running" forever.
- Notes: This is the highest-impact orchestrator finding because it permanently breaks the auto-drive feature on any browser session where the SW gets evicted (which is regularly, by design, on Chrome). Fix plan in INTEL-FIX-PLANS.md §F-9226-012; multi-layered:
  1. ScrapeTabPool persists `{runId, planCursor, completedJobIds, failedJobs, activeTabIds, startedAt}` to `scrapeOrchestrator:runState` on every state mutation.
  2. On SW boot, `_recoverFromCrash()` fires: closes any tab in activeTabIds, marks remaining plan items as halted (haltReason: "sw-evicted"), broadcasts `run-done` so wedged content-side awaits resolve, then clears the persisted state.
  3. auto-driver.js: read the `silentRunActive` flag with a TTL — if `aesAutoDrive:silentRunActiveAt` (a new ts companion) is older than e.g. MAX_PHASE_MS (~15min), treat the flag as stale and ignore.
  4. host.js auto-resume: probe `getStatus()` AND verify `state.startedAt` is recent — if the pool reports running but startedAt is missing, force `resetBreaker` + clear the silent-run flag so the next user click works.

## F-9226-013: AesCompetitorAirportHost / EnterpriseHost write a "scrape failed" stub record that hides the failure for the entire TTL window
- Area: modules/competitor-intel/airport-host.js (lines 49-54), modules/competitor-intel/enterprise-host.js (lines 43-49)
- Severity: P2
- Found by: port-9226
- Status: FIXED
- Repro: visit /app/info/airports/<id> while AS is rate-limiting (or any condition that makes the RA airport-overview scraper throw — easy to simulate by temporarily breaking the regex inside the scraper). The host catches the throw, sees `!cached` is true, and saves a stub: `{carriers: [], parserNotes: "scrape failed: <msg>"}` plus `scrapedAt: Date.now()` (added by `AesCompetitorStore.saveAirport`). Now revisit the same airport — `AesCompetitorStore.isExpired(rec, ttl)` is FALSE for `airportTtlMs = 7d`, so the host skips re-scraping and renders an empty panel for the next 7 days.
- Expected: a scrape failure should leave the cached record either nonexistent (forcing re-scrape on next visit) or carry a `scrapeFailedAt` flag the staleness check honours so retries happen on every visit (or with a short retry-cooldown like 5 minutes).
- Actual: the stub looks like a successful empty record. Subsequent visits skip the re-scrape; the panel renders "No carriers parsed" with a parser-notes hint that doesn't say "we keep failing — try clicking Sync now". The freshness pill shows green ("just now") because the stub's scrapedAt is fresh.
- Notes: the comparable pattern in `enterprise-scraper.js` doesn't do this — when meta scrape fails it returns `{parserNotesMeta: "RA meta scrape failed"}` and the next call re-runs the deep scrape. Fix: drop the stub-save entirely (just leave `cached === null` so next visit retries). If a stub IS desired so the panel renders SOMETHING, stamp it with `scrapeFailedAt: Date.now()` and have `AesCompetitorStore.isExpired` treat any record with a recent `scrapeFailedAt` and `!carriers.length` as expired after a short cooldown (e.g. 5 min).

## F-9226-014: AesCompetitorOutlinePanel + competitor-outline-tile both call build() without `economics`/`ourFleet` — memo TTL silently masks RA-economics changes for 30s
- Area: modules/competitor-intel/outline-panel.js:237-239; modules/central-hub/tiles/competitor-outline-tile.js:58
- Severity: P2 (refines F-9226-003)
- Found by: port-9226
- Status: WONTFIX (refines F-9226-003 which is also WONTFIX — no memo wrapper exists in current outline-aggregator.js, so the no-args call sites at panel.js:237 and tile.js:58 are correctly handled by inline _loadEconomics/_loadOurFleet inside build())
- Repro: open the outline panel. Inside outline-aggregator's _loadEconomics() it calls `RouteAssistantSettingsStore.load()` and reads `settings.economics`. Now go to RA settings and adjust `loadFactor` from 0.75 → 0.85. Click "Save". Within 30s, refresh the outline panel. Their estimated profit-per-week numbers don't move.
- Expected: changes to RA economics flow through to the next outline build. Either the memo invalidates on RA-settings:economics:saved (a signal the panel can subscribe to), or the build's hash includes the economics blob.
- Actual: the memo hash at outline-aggregator.js:771-776 is `JSON.stringify({s, e, h})` — no economics, no ourFleet. The `_loadEconomics()` await INSIDE the memoised function never runs on the second call within TTL because memoByInput's lookup hits the cache at the very top. The user sees stale profit numbers until the 30s TTL expires.
- Notes: This refines F-9226-003 with concrete repro and confirms the bite (the original was framed as "if a caller passed economics" — but the bite is also there for the no-args path because `_loadEconomics()` short-circuited by memo). Fix candidates layered:
  1. Hash _loadEconomics()'s output by hashing RA settings' relevant economics fields ahead of build, OR move `_loadEconomics()` (and `_loadOurFleet()`) outside the memoised function and pass them in — then the hash must include them.
  2. Subscribe to the bus topic the RA settings save emits (`data:route-assistant:settings:saved` or similar) and call `memoByInput.invalidate` on the build memo.
  3. Cut the TTL to ~5s — short enough that the user wouldn't notice but still helps the case where panel re-renders a few times in quick succession.

## F-9226-015: AesCompetitorOutlineRunner re-scrapes ALL cached enterprises on every refresh button press — no per-enterprise staleness gate
- Area: modules/scrape-orchestrator/competitor-outline-runner.js (runForServer lines 45-69, _listEnterpriseIds lines 71-81)
- Severity: P3
- Found by: port-9226
- Status: FIXED
- Repro: with N cached competitors on the active server, open the outline panel and click Refresh. Then click Refresh again immediately. Watch network tab — N×4 fetches per click (each enterprise scrape fires `/app/info/enterprises/<id>`, `?tab=2`, `?tab=3`, `?tab=4`).
- Expected: a refresh re-fetches only enterprises whose record is older than the enterpriseDeep TTL, OR the user can choose "force all" vs "stale only" via a UI hint.
- Actual: `_listEnterpriseIds` returns every cached id with no TTL filter. The whole list is re-scraped at concurrency=2, stagger=1000ms. With 30 competitors that's ~3 minutes of full-fat scrapes for nothing. Combined with F-9226-005 (no in-flight dedup), two refresh clicks in quick succession would double-stack the work.
- Notes: cheap fix at competitor-outline-runner.js:71-81: filter by `AesCompetitorStore.isExpired(rec, AesCompetitorSettings.enterpriseDeepTtlMs(settings))`. Bigger fix: take the user's intent — refresh-all (force) vs refresh-stale-only — from the UI. Pair with F-9226-005's promise-cache and the impact reduces dramatically.


## F-9228-001: Deal classifier "expiry urgency" scores using bidIntervalMs captured at scrape time — stale when re-viewing saved scans
- Area: modules/used-aircraft-scanner/deal-classifier.js + content_marketScan.js
- Severity: P1
- Found by: port-9228 (code-static)
- Status: OPEN
- Repro: run a market scan, wait ~6 hours without rescanning, reopen the scanner panel; offers that were "Closing soon" 6h ago still score with `expiry: 1.0` and the "Closing soon" reason. [needs-mcp-verify]
- Expected: expiry urgency reflects time remaining as of *now*, not as of scrape time.
- Actual: `content_marketScan.js:443` parses `bidIntervalMs` from the AS deadline span at scrape time (e.g. `"3:30:00"` → 12,600,000 ms). The row carries this static value through scan-session-store and into `MarketScanDealClassifier.scoreRow`. At `deal-classifier.js:288-300` the classifier reads `row.bidIntervalMs` directly — no `Date.now() - row.scrapedAt` adjustment. The row also lacks an `observedAt` timestamp (the scrape's `observedAt` lives only on price-history-store entries, not on the row itself). So a 12-hour-old scan record still claims "6h to expiry" and pushes Steal/Great rankings on offers that have actually closed.
- Notes: High confidence — direct code path. Fix: stamp `observedAt` on each row at content_marketScan.js:441-445 (mirror price-history-store.js:79's pattern), then in deal-classifier.js:290 compute `const remaining = bidMs - (Date.now() - row.observedAt); if (remaining <= 0) skip component`.

## F-9228-002: scheduled-decorator inline-styles its pill (#1d4ed8 / #f8fafc / 10px) — bypasses design tokens, doesn't track theme
- Area: modules/aircraft-flights/scheduled-decorator.js (lines 78-90)
- Severity: P3
- Found by: port-9228 (code-static)
- Status: OPEN
- Repro: visit `/app/fleets/aircraft/<id>/1` after the schedule has at least one matching flight number; observe the blue "scheduled" pill. [needs-mcp-verify]
- Expected: pill colors come from `--aes-accent` / `--aes-paper` (or equivalent tokens) so theme switches and skin overrides flow through.
- Actual: `scheduled-decorator.js:81-83` sets `style.cssText = "...background:#1d4ed8;color:#f8fafc;font-size:10px;font-weight:600;..."` — Tailwind blue-700 hex hardcoded, near-white hardcoded, untokenised font size. The bridge.html cubist skin also bypasses tokens for this element since the inline style wins specificity. Comparable F-9224 findings flag the same pattern in command-bridge.
- Notes: Medium confidence. Trivial fix: replace inline string with classed CSS rule; add `.aes-scheduled-pill { background: var(--aes-accent, #1d4ed8); color: var(--aes-paper, #f8fafc); ... }` to one of the existing stylesheets and use `span.className = "aes-scheduled-pill"`.

## F-9228-003: scheduled-decorator chrome.storage.onChanged listener leaks — re-init on SPA navigation registers a second listener
- Area: modules/aircraft-flights/scheduled-decorator.js (lines 134-143, 164-176)
- Severity: P2
- Found by: port-9228 (code-static)
- Status: OPEN
- Repro: open `/app/fleets/aircraft/<id>/1`, observe pill works, navigate via top-nav to a different aircraft `/app/fleets/aircraft/<id2>/1`, return to the original. Each visit potentially re-initialises the module if the page is a Wicket-fragment SPA reload. [needs-mcp-verify]
- Expected: at most one chrome.storage.onChanged listener attached per tab lifetime, scoped to the *current* aircraft.
- Actual: `_attachStorageListener` (line 134-143) adds a listener with no removal path. The IIFE guard at line 26 (`if (window.AesAircraftFlightsScheduledDecorator) return`) only prevents double-execution of the IIFE, not double-execution of `_init`. If the AS Wicket fragment re-mounts the table content scripts (the `_waitForTable` polling pattern at line 151-162 suggests they do), `_init` would re-register. Listener is also keyed to `_server`/`_aircraftId` captured at FIRST init via closure; after navigation to a different aircraft, `myKey` (line 137) still points at the original aircraft's schedule key. The listener callback at line 138-142 references the closure-captured `myKey` so post-nav storage events for the new aircraft never fire, while old-aircraft schedule writes still trigger `_scheduleRepaint()` (which then re-decorates a table that's no longer there).
- Notes: Medium confidence — depends on whether AS triggers content-script re-injection on SPA nav, which mirrors the conditions described in F-9223 wiring findings. Fix: store the `removeListener` handle on the module singleton, remove on next `_init`, OR make the listener read `_aircraftId` dynamically at fire-time via `_extractAircraftIdFromUrl()` and re-key.

## F-9228-004: canopy/geography-seeder.populate() always bumps scrapedAt + writes — non-idempotent under repeated calls
- Area: modules/canopy/geography-seeder.js (lines 71-108)
- Severity: P3
- Found by: port-9228 (code-static)
- Status: FIXED
- Repro: call `AesCanopyGeographySeeder.populate(server)` twice in a row with no demand-store changes between; observe `aesCanopy:geography:countryIdMap:<server>.scrapedAt` advances on each call even though `byCountryId` is byte-identical. [needs-mcp-verify]
- Expected: idempotent re-seed — if the merged result equals existing, skip the write (or at least preserve scrapedAt).
- Actual: `geography-seeder.js:105-106` builds `block = {schemaVersion: 1, scrapedAt: Date.now(), byCountryId}` and unconditionally writes it. The merge logic at lines 93-104 only updates `slot.iso2` if it was previously null and only fills `slot.name` if it was previously empty — so the byCountryId payload is genuinely byte-identical on a re-run with no upstream changes. The `scrapedAt` field is the only difference. Each call burns a chrome.storage write and triggers any `onChanged` listeners watching this key.
- Notes: Low severity but real — the file's docstring at lines 17-19 explicitly claims "safe to call repeatedly; it merges with any existing map". Idempotent should mean no observable side effect when nothing changed. Fix: short-circuit if `JSON.stringify(byCountryId) === JSON.stringify(existing.byCountryId)` (or do a structured equality), preserve existing `scrapedAt`.

## F-9228-005: canopy/geography-seeder NAME_TO_ISO2 has only 18 entries — silently mis-classifies most non-English country names
- Area: modules/canopy/geography-seeder.js (lines 31-52, 54-62)
- Severity: P2
- Found by: port-9228 (code-static)
- Status: OPEN
- Repro: with a fleet that includes destinations in (say) "Côte d'Ivoire", "United Arab Emirates", "Saudi Arabia", "Trinidad and Tobago", or any of the ~190 countries not in the 18-entry hardcoded map; observe `byCountryId[<id>].iso2 === null` after seed, and the canopy/orgs/dna-fit-scorer downstream falls back to "continent-only" matching for those countries. [needs-mcp-verify]
- Expected: the seeder cross-references against the comprehensive `AesGeographyBase.COUNTRY_CONTINENT` map (which already lists all ~250 ISO2 codes by continent — see modules/canopy/geography-base.js) to look up an ISO2 code by name match, not just the 18 special-case overrides.
- Actual: `_guessIso2` at lines 54-62 only checks `NAME_TO_ISO2[k]`. The 18 entries handle name-vs-ISO disagreements (e.g. "United States" → "US"), but for any country whose AS-displayed name isn't in that table, it returns `null` immediately (line 61). Author comment at line 58-60 explicitly punts on broader matching ("not worth it; keep simple"). geography-base.js is loaded before geography-seeder per manifest.json but never consulted from the seeder.
- Notes: High confidence — the `null` fallthrough is a permanent gap, not a transient one. Downstream effects: dna-fit-scorer's geography component will pick continent-only matches for ~90% of countries (each continent has 30+ countries), reducing the dimension's discriminating power; cubist-map's per-country tints will fall back to grey for all unmapped ones. Fix candidate: build a reverse map `iso2 → name` from `COUNTRY_CONTINENT` (with hand-curated canonical names per ISO), index it case-insensitively, and add it as fallback after the NAME_TO_ISO2 lookup.

## F-9228-006: inventory/validation.js uses brittle positional jQuery selectors — silently breaks on any AS panel reorder
- Area: modules/inventory/validation.js (lines 17-160)
- Severity: P2
- Found by: port-9228 (code-static)
- Status: OPEN
- Repro: trigger inventory validation when AS rearranges the inventory page panels (e.g. AS adds a new panel above "Current Inventory", shifts indexes); validator returns "valid: true" or fires wrong messages. [needs-mcp-verify]
- Expected: selectors anchored on stable semantic markers (form name, fieldset legend text, role attributes) — survives panel reorderings the same way the route-assistant/markets-page-scraper handles label-based row matching.
- Actual: every check uses positional `:eq(N)` chains: line 19 `'.col-md-10 > div > .as-panel:eq(1) > ul:eq(0) li:eq(0)'`, line 30 `'.col-md-10 > div > .as-panel:eq(1) > div > div > div:eq(0) fieldset:eq(2) > div input'`, lines 78, 99, 117, 144 same pattern. The `.col-md-10 > div > .as-panel:eq(1)` prefix recurs everywhere — any AS template change that adds, removes, or reorders an `.as-panel` shifts every `:eq` by one and the validator silently fires wrong messages or none at all. No fallback selector strategy. No tests against fixture HTML to catch drift.
- Notes: Medium-high confidence as a latent bug (depends entirely on AS re-templating, which has happened historically per HANDOVER notes). Fix: replace each `:eq(N)` with a label-match selector using the panel `<legend>` or `<h3>` text — same pattern as content_marketScan.js lines 414-450 which scrapes by label, or modules/aircraft-type-specs.js's "walk every table row and pattern-match on the label" method.
