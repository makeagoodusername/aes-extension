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
- Status: FIXED
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
- Status: FIXED
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
- Status: FIXED
- Repro: kill the service worker mid-phase via chrome://extensions developer-tools "Inspect" → close (or use chrome.runtime.reload from the SW console). The background-tab-pool that owns the active phase is gone; no `run-done` event will be relayed.
- Expected: the orchestrator detects the broken pipe, resolves the phase Promise with `haltReason: "background-disconnect"` (or similar), and removes its message listener.
- Actual: `_runPhaseJobs` returns a Promise that resolves only inside `if (event.type === "run-done")`. The handler stays registered on `chrome.runtime.onMessage` and the await on line 73 (`await this._runPhaseJobs(phase, jobs)`) never returns. The caller (`start()`) is wedged; the auto-driver's `_busy = true` flag (auto-driver.js:68) stays true until the tab is closed; `aesAutoDrive:silentRunActive` storage flag stays true. Subsequent ticks short-circuit at `out.skipped = "busy"`.
- Notes: Same shape recurs at host.js:145-153 (auto-resume listener also never expires). Fix: wrap the addListener with a timeout (e.g. `MAX_PHASE_MS = 15min` after the last job-start/job-done event observed) that forcibly resolves with haltReason and cleans up the listener. Watchdog reset on every event keeps long phases viable; only true silence trips it. Bonus: the orphan-detection hook also gives the resume path a clean way to know "the prior run died" rather than "the prior run is in progress."

## F-9226-008: parseFleetCounts positional fallback silently mis-assigns fields when AS layout shifts
- Area: modules/competitor-intel/enterprise-scraper.js (parseFleetCounts lines 282-305)
- Severity: P2
- Found by: port-9226
- Status: FIXED
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
- Status: FIXED
- Fix: trimmed `RouteAssistantWaveKeybindsStore.DEFAULT_BINDINGS` to just `{"palette.open": "Mod+Shift+K"}` — removed `panel.toggleWaves`, `palette.savePresetVar`, `palette.pinActive`, `wave.next`, `wave.prev`, `wave.add`, `wave.delete`, `drag.cancel`. Per the finding's option (b): until a keydown listener that calls `WaveKeybindsStore.matches()`/`.resolve()` for these ids actually ships, the defaults were a UI promise the runtime couldn't keep. Note: the unified-settings adapter `drag-and-palette.js` referenced in the finding's Area does not exist on slice/e-integration (`find modules/unified-settings -type f` confirms no such file), so the user-visible chord settings card is not currently mounted; trimming DEFAULT_BINDINGS is still the right move because any future listing of `WaveKeybindsStore.list()` would inherit the dead ids again. Verified by: node script parsing the patched source — DEFAULT_BINDINGS contains exactly one key (`palette.open`). `grep -rn "panel\.toggleWaves\|palette\.savePresetVar\|palette\.pinActive\|wave\.next\|wave\.prev\|wave\.add\|wave\.delete\|drag\.cancel" modules/` returns only the comment block in wave-keybinds-store.js itself; no consumer call sites remain. The sole live consumer (wave-palette.js:532 — `resolve("palette.open")`) is unchanged.
- Repro: open Unified Settings → "Drag & Wave Palette" → "Wave palette chords" card. Click any chord row OTHER than "Open wave palette" (e.g. "Toggle wave panel", "Save preset variant", "Pin active preset", "Next wave", "Previous wave", "Add wave", "Delete wave", "Cancel drag") and record a new chord (e.g. F8). Save. Then on any AS app page, press the new chord. Nothing happens.
- Expected: every action exposed in the chord-binding card has a working keyboard handler that consumes its chord — that's the contract the settings card establishes when it lets you edit the chord.
- Actual: only `palette.open` is wired (modules/route-assistant/wave-palette.js:558 — `RouteAssistantWaveKeybindsStore.matches(event, chord)`). All eight other action ids — `panel.toggleWaves`, `palette.savePresetVar`, `palette.pinActive`, `wave.next`, `wave.prev`, `wave.add`, `wave.delete`, `drag.cancel` — appear in DEFAULT_BINDINGS (wave-keybinds-store.js:27-37) AND in the unified-settings adapter ACTION_LABELS (drag-and-palette.js:25-35) but no keydown listener anywhere in `modules/` ever calls `RouteAssistantWaveKeybindsStore.resolve(...)` or `.matches(...)` for them. Verified via `grep -rn "WaveKeybinds.matches\|wave\.next\|wave\.prev\|wave\.add\|wave\.delete\|drag\.cancel\|panel\.toggleWaves\|palette\.savePresetVar\|palette\.pinActive" modules/ --include="*.js"` — only one call site (`palette.open` in wave-palette.js:558) and the two definition files appear.
- Notes: The settings card promises functionality that doesn't exist. Two fixes available: (a) wire the missing chords — `panel.toggleWaves` should toggle wave-overlay visibility (wave-overlay.js or wave-strip.js owns that), `wave.next/prev/add/delete` should drive the wave editor / wave-strip selection state, `drag.cancel` should reach drag-arbiter's cancel path, `palette.savePresetVar` and `palette.pinActive` should call into wave-palette's save-as-variant / pin-active handlers; (b) trim DEFAULT_BINDINGS + ACTION_LABELS to just the wired action ids (`palette.open`) until the consumers are built. Until either lands, the card is a mute UI surface that wastes user time setting chords that do nothing.

## F-9225-002: AesWaveRegistry.search "+star" filter is dead — looks for `preset.starredAt` which is never written
- Area: modules/route-assistant/wave-registry.js (search, line 224-225)
- Severity: P2
- Found by: port-9225
- Status: FIXED
- Repro: open the Wave Palette (Mod+Shift+K on any AS app page), type "+star" into the search box. Even with starred presets persisted (see wave-favorites-store), the filtered list comes back empty (or unchanged).
- Expected: typing `+star` in the palette returns only presets that have been starred (per the user's `RouteAssistantWaveFavoritesStore` favorites map).
- Actual: `wave-registry.js:224-225` filters `candidates.filter(p => p.starredAt != null)`. The enriched preset shape built by `wave-registry.build()` (lines 64-78) merges in `tags`, `role`, `colorToken`, `pinnedTo` from `AesWavePresetMetaStore`, but DOES NOT merge in any starred state from `RouteAssistantWaveFavoritesStore`. The only place `preset.starredAt` would be set is `presets-store.js:55` (`newPreset()` sets it to `null`); no code path ever assigns a non-null value to `preset.starredAt`. Star info lives in a separate keyed map at `routeAssistant:waveFavorites:byPresetId.<presetId>.starredAt` — and `wave-palette.js:193` correctly reads it from there for badge rendering, while `wave-registry.search` looks in the wrong place.
- Notes: Two pieces of "drift between favorites/registry/keybinds stores" mentioned in the audit prompt. Fix: in `wave-registry.build()`, load `RouteAssistantWaveFavoritesStore.load()` alongside `AesWavePresetMetaStore.load()`, then in the enriched-preset map (lines 64-78) include `starredAt: (favBlock.byPresetId[p.id] || {}).starredAt || null` so the search filter (and any future starred-preset surface) sees the right value. Bonus: the preset-store default field `starredAt: null` (presets-store.js:55) is now misleading dead code — either delete it, or designate the canonical source of truth (preset-side OR favorites-side) and migrate consumers to read from one place.

## F-9225-003: AfpSpecResolver tags AS-fetched specs as `source: "heuristic"` — doc says `"as-fetched"`
- Area: modules/aircraft-flight-plan/spec-resolver.js (line 151)
- Severity: P3
- Found by: port-9225
- Status: FIXED
- Repro: navigate to `/app/fleets/aircraft/<id>/0` for an aircraft whose typeId resolves only via the page-link fallback (NOT via `RouteAssistantFleetStore`) — i.e. fleet store is cold but the AFP page's `<a href="aircraftsType?id=…">` link is present. Watch the spec card render. Inspect `document.querySelector('[data-aes-afp-spec-card="resolved"]').dataset.source`.
- Expected: per the JSDoc at spec-resolver.js:30 — `source ∈ "cached" | "fleet-store" | "heuristic" | "as-fetched"`. A fresh AS fetch via `AESAircraftTypeSpecs.fetchById(typeId)` should be tagged `"as-fetched"`.
- Actual: line 151 sets `const source = (viaPath === "fleet") ? "fleet-store" : "heuristic"`. Anything that wasn't fleet-store-derived gets the `"heuristic"` label, regardless of whether the data came from a fresh AS fetch or from a heuristic. The `"as-fetched"` enum value the doc lists is never actually used anywhere in the resolver. (The "heuristic" label IS appropriate when `RouteAssistantFuelBurn.heuristic()` synthesises burn data, but that's a different module entirely.)
- Notes: The mismatched value is currently only consumed by `data-source` on the rendered card (line 243), and downstream `_spec.source === "auto-build"` checks in flight-studio/panel.js never compare against "heuristic" or "as-fetched". So this is cosmetic today. Fix: change line 151 to `(viaPath === "fleet") ? "fleet-store" : "as-fetched"` and either remove `"heuristic"` from the doc enum or note that the fuel-burn helper is the only legitimate user of that label. Keep noting wherever `source` is exposed so future consumers gain a stable contract.

## F-9225-004: schedule-builder.validatePreset misreports "connection gap below minTransfer" for waves that legitimately wrap midnight
- Area: modules/schedule-management/schedule-builder.js (lines 41-49, validatePreset)
- Severity: P3
- Found by: port-9225
- Status: FIXED
- Repro: by code review + ScheduleFactors semantics — create a preset wave with `arrivalWindow.end = "23:30"` and `departureWindow.start = "00:30"` (a legitimate wave that wraps midnight, e.g. for a hub serving late-night arrivals connecting to early-morning long-hauls). Run `new ScheduleBuilder(preset).validatePreset()`.
- Expected: validator either accepts the wave (gap is +60 minutes when interpreted as wrapping) or rejects with a precise "windows wrap midnight — not supported" message. Either is honest.
- Actual: `gap = ScheduleFactors.minutesBetween("23:30", "00:30")` returns `-1380` (minutes-between subtracts parsed minutes-since-midnight without wrap awareness). Then `gap < minTransferMinutes` is true (the default is 45), so the validator reports `"wave N: connection gap (-1380m) is below minTransferMinutes (45m)"`. The negative number leaks through to the UI; the wave is rejected for the wrong reason; the user can't tell whether the validator hates the wrap, hates the gap, or has a bug.
- Notes: Same wrap-blindness affects `ScheduleFactors.minutesBetween` and any consumer that calls it on cross-midnight pairs (used by transit checks at lines 42-43 too — `minutesBetween("06:30", "06:00")` returns -30 even when the user might mean "30 minutes before midnight to 06:00 next day"). Fix: either (a) document explicitly that wave windows must be same-day (the current invariant by accident) and have validatePreset surface a clean "wave windows must be same-day; arrival end %s after departure start %s" message when the negative-gap path triggers; or (b) teach `minutesBetween` an `assumeWrap` option and fix the validator to use it. (a) is lower-risk and matches what the rest of the builder assumes. While there: `withinWindow` already handles wrap, so the codebase has both behaviours co-existing — pick one and document it.

## F-9225-005: AfpAutoPreview disabled-button helptext says "Waiting for route candidates (Slice C)" but the empty-state below it instructs the user to click the disabled button
- Area: modules/aircraft-flight-plan/auto-scheduler/preview-panel.js (gantt empty-state copy + CTA disabled-state)
- Severity: P3
- Found by: port-9225
- Status: FIXED
- Repro: open `/app/fleets/aircraft/<id>/0` for an aircraft whose route candidates haven't been generated this session (i.e. you haven't visited the per-route scheduling page or run the route-candidates panel for this hub yet). Look at the "Auto-build (preview)" card. The "Auto-build week" button has `disabled` and `title="Waiting for route candidates (Slice C)."`. Right below, the gantt-area placeholder says `No build yet. Click "Auto-build week" to generate a proposal.`
- Expected: the empty-state instruction is consistent with the button's disabled-state — either tells the user what to do FIRST to unblock the button (e.g. "Open this aircraft's hub on /app/com/scheduling so route candidates are computed, then return here"), or omits the click instruction when the button can't be clicked.
- Actual: the user sees a button they're told to click but that's already disabled, and the disabled tooltip mentions an internal slice name ("Slice C") rather than a user-actionable next step. Minor friction — but compounded for new users who don't know what "Slice C" is.
- Notes: Verified live at chrome-devtools MCP port 9225 on `/app/fleets/aircraft/21944/0`: `cta.title === "Waiting for route candidates (Slice C)."`, `cta.disabled === true`, `gantt.textContent === 'No build yet. Click "Auto-build week" to generate a proposal.'`. Two-line fix: (a) replace "Slice C" with a user-readable phrase in the disabled tooltip; (b) swap the gantt placeholder text when the CTA is disabled to "Route candidates not ready yet — open the route candidates panel first." (read the same predicate the CTA reads to decide).

## F-9225-006: CanvasShell._renderCurrentView's wave-view branch references undefined `T` — fresh Canvas open in waves view throws ReferenceError before rail / first-run overlay can mount
- Area: modules/canvas/canvas-shell.js (line 460, inside _renderCurrentView)
- Severity: P1
- Found by: port-9225
- Status: FIXED
- Repro: open `/app/fleets`, click "▦ Open Schedule Canvas". (`AesCanvasStateStore`'s default is `view: "waves"`, so a first-time / freshly-cleared user lands on the wave branch.) Watch the page console.
- Expected: the canvas modal mounts cleanly — header, hub picker, view toggle, wave spine, destinations dock, assistant rail, first-run overlay all rendered.
- Actual: console emits `[AES Schedule Canvas] open failed ReferenceError: T is not defined` (verified live at chrome-devtools MCP port 9225 on /app/fleets — see msgid=39 in the page console). The throw originates at `canvas-shell.js:460` — `this._mountDestinationsDock(inner, T)` — where `T` is referenced but never bound in `_renderCurrentView()`'s scope. (`T` is bound locally in `mount()` at line 67 and `_renderHeader()` at line 405, but those locals don't survive into `_renderCurrentView()`.) The callee `_mountDestinationsDock(parentEl, T)` at line 467 correctly takes T as a parameter; the caller at 460 is the bug. Git blame: line 460 was added in commit 911baa4d on 2026-04-29.
- Notes: When the throw fires, `CanvasShell.mount()` rejects — which means `CanvasModal._mount()` skips `_mountRail()` (line 159), `_wireScheduleWatcher()` (line 163), AND `CanvasFirstRunOverlay.maybeShow` (line 167). User sees a partial canvas: the header + spine render (the throw happens AFTER `spineRenderer.render()` at line 445) but the destinations drag-source dock is missing, the assistant rail never mounts, and the schedule watcher never attaches — cross-tab schedule changes won't repaint. The error is silently swallowed by `fleet-schedule-grid/host.js:181`'s catch handler ("[AES Schedule Canvas] open failed"), so the user has no in-page signal. Not reproducible after the user toggles to Timeline view: switching writes `view: "timeline"` to AesCanvasStateStore, and on the next open the timeline branch (lines 413-422) doesn't reference T. So the bug is invisible to anyone who happened to leave the canvas in timeline view, and silently blocks first-time / cleared-state users in the default view. Fix is one line: at canvas-shell.js:460, define `const T = (typeof window !== "undefined" && window.AESTokens) || null` at the top of `_renderCurrentView()` (mirroring `_renderHeader()` line 405).

## F-9227-001: Conductor `cash.balance.changed` signal never fires — storage-key prefix mismatch with snapshot-store
- Area: modules/conductor/signal-layer.js (line 305) ↔ modules/accounting/snapshot-store.js (line 26) ↔ modules/conductor/scenarios.js (`CashStep`, lines 275-292)
- Severity: P1
- Found by: port-9227
- Status: FIXED
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
- Status: FIXED
- Note: port-9223 attempted both fix paths — alias on helpers.js and consumer-side rename to getServerName — both were reverted by external linter/agent. Re-applied the alias in commit e88ac40 (port-9224) and committed atomically before the working tree could be reset.
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
- Status: FIXED
- Note: re-applied the manifest move + bootstrap-signal mirror in commit 0da8172 (port-9224). Both edits committed atomically before the working tree could be reset; shell.js gated on __aesAccountBootstrapEmitted to keep the dashboard surface emit-once.
- Repro: read manifest.json — `modules/central-hub/feed/index.js` is in the `/app/enterprise/dashboard` block (around line 243), not the `/app/* + /action/*` wildcard block. shell.js (line 53) emits `data:account:bootstrapped` in `mount()` — the shell only mounts on `/app/enterprise/dashboard*`. Three HubFeed slices (`hub:cash:weekly`, `hub:strategy:applied`, `hub:strategy:settings`) declare deps that include `data:account:bootstrapped` and topics that come from feed/index.js bridges — neither flows on non-dashboard pages.
- Expected: any tab that mounts CentralHubTiles (the same tile classes can render on bridge.html or via fleet-overlay) gets fresh values when the underlying storage changes.
- Actual: on non-dashboard pages, none of the three feed/index.js bridges install (so storage writes don't translate to bus topics) and `data:account:bootstrapped` never fires. Slices fall through to their eager initial compute, then silently stay stuck — the `feedSlices()` subscription on tiles never fires after first paint. Tiles that bypass via `watchedStorageKeys()` still update; tiles that committed to feedSlices (e.g. strategy-tile uses both — its feedSlices side stays frozen but watchedStorageKeys keeps it half-alive) end up showing mixed-freshness state.
- Notes: bridge.html in particular loads many of the same tile-style panels (subsidiary-cards, opportunities-panel, accounting-pane) and depends on the accounting-ledger view's recomputes — combined with F-9223-010, the whole bridge's Accounting pane is stuck on whatever state existed at first paint. Fix: move feed/index.js's bridges + the account-bootstrapped emit into the wildcard `_shared` block (or a new universal "feed-boot" block) so any AES content-scripted page wires them up. Defensive guard already exists (`__aesHubFeedBooted`).

## F-9223-012: Fleet roster + accounting tile + competitor-monitoring tile all use legacy `<server><airline>...` keys with NO account scoping — multi-airline users see mixed data
- Area: modules/_shared/fleet-roster.js, modules/accounting/snapshot-store.js, modules/central-hub/tiles/{fleet-hub,accounting,competitor-monitoring}-tile.js
- Severity: P1
- Found by: port-9223
- Status: FIXED
- Note (port-9224): commit 50cdd1d implements the two cheap mitigations from the Notes section — fleet-hub-tile._findFleetRecord and competitor-monitoring._loadCompetitors now filter by ctx.airline when supplied (single-key get / prefix-filtered scan), and watchedStorageKeys for all three tiles narrows from "<server>" to "<server><airline><domain>" so cross-airline writes no longer trigger spurious refreshes. Class-B/C/D account-scoping (HANDOVER §10) remains the durable fix for the storage shape itself.
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
- Status: WONTFIX
- Note (port-9224): the AesFlow surface this finding depends on (modules/_shared/flow.js, signal:flow:flow-degraded, data:flow:health:updated, deadPathwayWindowMin) is not present in the current tree — the file doesn't exist, no module emits the signals, and grep for "AesFlow" returns only audit/findings.md + HANDOVER.md hits. F-9223-005's "FIXED" status references the same missing file, so either the slice never landed or the infrastructure was rolled back. Re-open if/when AesFlow lands; the proposed wiring (CentralHubTile._attachFeedSubscriptions also subscribing to the flow-degraded signal) remains the right shape.
- Repro: tile.js's `_feedFreshness` is set ONLY by `_attachFeedSubscriptions()` (line 451) — i.e. only by HubFeed slice subscription, not by AesFlow.health complaints. A tile that uses watchedStorageKeys (most tiles) gets `_feedFreshness === null` always → no stale dot. Even tiles that DO use feedSlices only see their slice's age, not whether the underlying bus pathway is degraded.
- Expected: when AesFlow.health reports `signal:flow:flow-degraded` (e.g. a tile's source topic hasn't fired in 30 min when it should), affected tiles render a warning dot.
- Actual: the degraded signal is fired on the bus but no tile subscribes — the data-flow-inspector tile renders the diagnostic in its own body, but every other tile renders "fine" even when its data is days old. The freshness-dot machinery exists but is unreachable for ~25 of ~30 tiles.
- Notes: Two layers of fix. Quick: have `CentralHubTile._attachFeedSubscriptions` also subscribe to `signal:flow:flow-degraded` and to `data:flow:health:updated` — tiles whose watchedStorageKeys haven't fired in `flow.deadPathwayWindowMin` minutes get the dot too. Better: AesFlow already has a per-topic "subscribed-never-fired" diagnosis; map watchedStorageKeys / feedSlices to expected-active topics and surface per-tile staleness directly. Combined with F-9223-005 (de-spam health()) and the proper transition-only semantics, this becomes a real "this tile's pipeline is broken" indicator instead of theatre.

## F-9223-015: tile.watchedStorageKeys uses `prefix.indexOf === 0` — a tile that watches "<server>" ALSO refreshes on every other tile's writes prefixed with the same server, creating cross-tile refresh storms
- Area: modules/central-hub/tile.js (lines 436-444 legacy storage listener + 425-433 bus-bridge path)
- Severity: P3
- Found by: port-9223
- Status: FIXED
- Fix by: port-9223 — narrowed `watchedStorageKeys` in fleet-hub-tile.js (`<server><airline>aircraftFleet`), accounting-tile.js (`<server><airline>accounting:`), and competitor-monitoring-tile.js (`<server><airline>competitorMonitoring`). Each falls back to `[server]` when airline isn't yet resolved on first ctx pass (login pages, non-dashboard surfaces with empty top-nav). tile.js's storage listener / bridgeStorage path is unchanged — the narrower prefixes pass straight through and dedup naturally per-tile. Verified statically: each new prefix matches the writer's exact key-shape for that data type (fleet records: `<server><airline>aircraftFleet`; competitor records: `<server><airlineId>competitorMonitoring` per content_enterpriceOverview.js:10; accounting records: `<server><airline>accounting:<sub>:<week>` per cash-feed.js:47, accounting-tile._loadIndexAndSisters).
- Repro: fleet-hub-tile, accounting-tile, competitor-monitoring-tile all return `[ctx.server]` from `watchedStorageKeys` (e.g. `["zb"]`). Any storage key starting with "zb" fires every one of these tiles' refresh — including unrelated writes like `zbXX1234aircraftFleet`, `zbXX1234accounting:income:1739`, `zbXX1234competitor:5678`, etc. With three tiles all listening on the bare server prefix and storage events typically batched, every storage write fans out to ~3 redundant refreshes, each running its own full storage scan (`get(null)`) per the fallback logic.
- Expected: a tile only refreshes when its own data changes.
- Actual: cross-tile refresh storm. With `_findFleetRecord` doing `chrome.storage.local.get(null)`, fleet-hub-tile alone re-scans the entire storage on EVERY accounting write to the same server. The legacy storage listener path (line 436-444) iterates every changed key × every prefix → O(N×M).
- Notes: Fix per tile — use SPECIFIC prefixes (e.g. fleet-hub: `<server><sanitizedAirline>aircraftFleet`; accounting: `<server><airlineCode>accounting:`). Combined with the registry-aware enumeration that fleet-hub-tile already has (lines 51-67), prefixes can be exact or near-exact and avoid the cross-cutting fan-out. Even a one-character extension (e.g. `<server>+":"`) would partition the watchers along the existing key shape.

## F-9223-016: HubFeed slice TTLs are largely ttlMs:0 ("never stale by age") — the freshness dot machinery is dead weight even on tiles that opt in
- Area: modules/_shared/hub-feed.js (lines 54, 89-94) + each declared slice
- Severity: P3
- Found by: port-9223
- Status: FIXED
- Repro: declared slices use `ttlMs: 0` (hub:strategy:settings line 55), `ttlMs: 30 * 60 * 1000` (hub:cash:weekly line 39), `ttlMs: 24 * 3600 * 1000` (hub:strategy:applied line 32). For ttlMs=0, `freshness().isStale` is hard-coded false (line 93). For non-zero, isStale fires when ageMs > ttlMs — but only counts time since the LAST recompute, not since the underlying scrape that produced the value. Combined with F-9223-010 / F-9223-011, the recompute path is broken on most pages so ageMs effectively measures "time since page load."
- Expected: stale-dot reflects "underlying data is older than X" — the last accounting scrape, the last fuel-price scrape, the last fleet roster fetch.
- Actual: stale-dot reflects "time since last view recompute". On bridge.html where feed/index.js bridges don't load, ageMs grows from zero forever and tiles either (a) never show a dot (ttlMs=0) or (b) ALL show a dot once enough time passes (ttlMs>0). The dot doesn't track real-world data freshness.
- Notes: The fix is two-layer. The slice's compute function should return a `{value, scrapedAt}` envelope where scrapedAt is the underlying record's freshness timestamp; HubFeed.freshness should compare ttlMs against (now - scrapedAt) rather than (now - computedAt). Mirrors `wrapSingleKey` / `createTtlCache`'s `isFreshRecord` semantics — they already have it right.

## F-9226-010: AesCounterAircraft hardcodes paxScore=5 — counter-vs-buy verdicts biased downward on high-demand routes
- Area: modules/competitor-intel/counter-aircraft.js (_scoreExistingTails line 179, _scorePurchaseTypes line 226)
- Severity: P2
- Found by: port-9226
- Status: FIXED
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
- Status: FIXED (sub-fix #3 by port-9223 + sub-fixes #1/#2 by port-9226 in 55a5e56: pool now persists `scrapeOrchestrator:runState` on state mutations and `_recoverFromCrash()` IIFE on every SW boot closes orphan tabs + broadcasts synthetic `run-done` with reason `sw-evicted`. Sub-fix #4 host.js startedAt verification deferred — host.js has uncommitted concurrent work)
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
- Status: FIXED
- Repro: run a market scan, wait ~6 hours without rescanning, reopen the scanner panel; offers that were "Closing soon" 6h ago still score with `expiry: 1.0` and the "Closing soon" reason. [needs-mcp-verify]
- Expected: expiry urgency reflects time remaining as of *now*, not as of scrape time.
- Actual: `content_marketScan.js:443` parses `bidIntervalMs` from the AS deadline span at scrape time (e.g. `"3:30:00"` → 12,600,000 ms). The row carries this static value through scan-session-store and into `MarketScanDealClassifier.scoreRow`. At `deal-classifier.js:288-300` the classifier reads `row.bidIntervalMs` directly — no `Date.now() - row.scrapedAt` adjustment. The row also lacks an `observedAt` timestamp (the scrape's `observedAt` lives only on price-history-store entries, not on the row itself). So a 12-hour-old scan record still claims "6h to expiry" and pushes Steal/Great rankings on offers that have actually closed.
- Notes: High confidence — direct code path. Fix: stamp `observedAt` on each row at content_marketScan.js:441-445 (mirror price-history-store.js:79's pattern), then in deal-classifier.js:290 compute `const remaining = bidMs - (Date.now() - row.observedAt); if (remaining <= 0) skip component`.

## F-9228-002: scheduled-decorator inline-styles its pill (#1d4ed8 / #f8fafc / 10px) — bypasses design tokens, doesn't track theme
- Area: modules/aircraft-flights/scheduled-decorator.js (lines 78-90)
- Severity: P3
- Found by: port-9228 (code-static)
- Status: FIXED
- Repro: visit `/app/fleets/aircraft/<id>/1` after the schedule has at least one matching flight number; observe the blue "scheduled" pill. [needs-mcp-verify]
- Expected: pill colors come from `--aes-accent` / `--aes-paper` (or equivalent tokens) so theme switches and skin overrides flow through.
- Actual: `scheduled-decorator.js:81-83` sets `style.cssText = "...background:#1d4ed8;color:#f8fafc;font-size:10px;font-weight:600;..."` — Tailwind blue-700 hex hardcoded, near-white hardcoded, untokenised font size. The bridge.html cubist skin also bypasses tokens for this element since the inline style wins specificity. Comparable F-9224 findings flag the same pattern in command-bridge.
- Notes: Medium confidence. Trivial fix: replace inline string with classed CSS rule; add `.aes-scheduled-pill { background: var(--aes-accent, #1d4ed8); color: var(--aes-paper, #f8fafc); ... }` to one of the existing stylesheets and use `span.className = "aes-scheduled-pill"`.

## F-9228-003: scheduled-decorator chrome.storage.onChanged listener leaks — re-init on SPA navigation registers a second listener
- Area: modules/aircraft-flights/scheduled-decorator.js (lines 134-143, 164-176)
- Severity: P2
- Found by: port-9228 (code-static)
- Status: FIXED
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
- Status: FIXED
- Fix: re-applied the lazy reverse-map approach (port-9229). `_buildIso2ByName` enumerates `AesGeographyBase.COUNTRY_CONTINENT` (250 entries) and resolves each via `Intl.DisplayNames("en", {type:"region"})`, indexed by a normalized form that folds `&`↔`and` so "Trinidad & Tobago" (Intl) matches "Trinidad and Tobago" (AS). NAME_TO_ISO2 still wins first, so platform-specific aliases ("Czech Republic", "Russia", "South Korea", …) are unaffected. Verified offline against the full COUNTRY_CONTINENT — 250/250 codes resolve and all but one of the audit's example countries hit (St. Vincent edge case still falls through to NAME_TO_ISO2 if added there). Commit: see git log for `geography-seeder` reverse map.
- Repro: with a fleet that includes destinations in (say) "Côte d'Ivoire", "United Arab Emirates", "Saudi Arabia", "Trinidad and Tobago", or any of the ~190 countries not in the 18-entry hardcoded map; observe `byCountryId[<id>].iso2 === null` after seed, and the canopy/orgs/dna-fit-scorer downstream falls back to "continent-only" matching for those countries. [needs-mcp-verify]
- Expected: the seeder cross-references against the comprehensive `AesGeographyBase.COUNTRY_CONTINENT` map (which already lists all ~250 ISO2 codes by continent — see modules/canopy/geography-base.js) to look up an ISO2 code by name match, not just the 18 special-case overrides.
- Actual: `_guessIso2` at lines 54-62 only checks `NAME_TO_ISO2[k]`. The 18 entries handle name-vs-ISO disagreements (e.g. "United States" → "US"), but for any country whose AS-displayed name isn't in that table, it returns `null` immediately (line 61). Author comment at line 58-60 explicitly punts on broader matching ("not worth it; keep simple"). geography-base.js is loaded before geography-seeder per manifest.json but never consulted from the seeder.
- Notes: High confidence — the `null` fallthrough is a permanent gap, not a transient one. Downstream effects: dna-fit-scorer's geography component will pick continent-only matches for ~90% of countries (each continent has 30+ countries), reducing the dimension's discriminating power; cubist-map's per-country tints will fall back to grey for all unmapped ones. Fix candidate: build a reverse map `iso2 → name` from `COUNTRY_CONTINENT` (with hand-curated canonical names per ISO), index it case-insensitively, and add it as fallback after the NAME_TO_ISO2 lookup.

## F-9228-006: inventory/validation.js uses brittle positional jQuery selectors — silently breaks on any AS panel reorder
- Area: modules/inventory/validation.js (lines 17-160)
- Severity: P2
- Found by: port-9228 (code-static)
- Status: FIXED
- Fix: re-applied the rewrite (port-9229). Every `:eq(N)`/positional chain replaced with stable anchors: tab text-match for the "All Flight Numbers" tab, `name="settings:..."` for Apply-settings checkboxes, fieldset-by-legend lookup (`Validation._fieldsetByLegend(text)`) plus `name="serviceClasses"`/`name="flightStati"`/`name="loadMin"`/`name="loadMax"`/`name="display"` for the Data panel rules. Verified end-to-end against `CLAUDE/INVENTORY.html` via jsdom: pre-mutation only the 3 actually-unchecked Service Classes (C/F/Cargo) are flagged, post-mutation all 11 violations fire with correct human-readable label text.
- Repro: trigger inventory validation when AS rearranges the inventory page panels (e.g. AS adds a new panel above "Current Inventory", shifts indexes); validator returns "valid: true" or fires wrong messages. [needs-mcp-verify]
- Expected: selectors anchored on stable semantic markers (form name, fieldset legend text, role attributes) — survives panel reorderings the same way the route-assistant/markets-page-scraper handles label-based row matching.
- Actual: every check uses positional `:eq(N)` chains: line 19 `'.col-md-10 > div > .as-panel:eq(1) > ul:eq(0) li:eq(0)'`, line 30 `'.col-md-10 > div > .as-panel:eq(1) > div > div > div:eq(0) fieldset:eq(2) > div input'`, lines 78, 99, 117, 144 same pattern. The `.col-md-10 > div > .as-panel:eq(1)` prefix recurs everywhere — any AS template change that adds, removes, or reorders an `.as-panel` shifts every `:eq` by one and the validator silently fires wrong messages or none at all. No fallback selector strategy. No tests against fixture HTML to catch drift.
- Notes: Medium-high confidence as a latent bug (depends entirely on AS re-templating, which has happened historically per HANDOVER notes). Fix: replace each `:eq(N)` with a label-match selector using the panel `<legend>` or `<h3>` text — same pattern as content_marketScan.js lines 414-450 which scrapes by label, or modules/aircraft-type-specs.js's "walk every table row and pattern-match on the label" method.

## F-DASH-301: strategy-backtest-tile never registers with CentralHubTileRegistry — tile is invisible in the hub
- Area: modules/central-hub/tiles/strategy-backtest-tile.js (final block, ~line 306)
- Severity: P1
- Found by: dashboard-pass (Agent 3 — Strategy + Conductor)
- Status: FIXED
- Fix: appended a `CentralHubTileRegistry.register({id:"strategy-backtest", section:"tools", priority:7, factory:() => new CentralHubStrategyBacktestTile()})` block mirroring the pattern used by every other tile module (strategy-tile.js:1213, weekly-review-tile.js:228, conductor-tile.js:525, diagnostics-tile.js:412). Verified by `node --check`.
- Repro: open `https://*.airlinesim.aero/app/enterprise/dashboard*`. Inspect `CentralHubTileRegistry.all().map(t => t.id)` — the array does not include `"strategy-backtest"` even though `modules/central-hub/tiles/strategy-backtest-tile.js` is loaded by the manifest dashboard block (line 434).
- Expected: tile appears in section "tools" alongside strategy / conductor / weekly-review / diagnostics, lets the user click "Run backtest" to replay the last 12 weeks of accounting through current weights.
- Actual: file only set `window.CentralHubStrategyBacktestTile = …`. The class definition was loaded but never registered, so the shell never asked for it and `AesStrategyBacktest.run()` had no UI surface anywhere.
- Notes: pure registration-block omission. The class itself is well-formed, has `loadStatus`, `renderBody`, persistence to `aesStrategy:backtest:lastRun[:acct:<id>]`, and a working "Run backtest" button. Just the trailing register() call was missing.

## F-DASH-302: conductor-tile footer only exposed "Clear signals" — no manual outcome-driver tick, no way to clear scenario fires or routine instances
- Area: modules/central-hub/tiles/conductor-tile.js (`_buildFooter`, lines 498-522)
- Severity: P2
- Found by: dashboard-pass (Agent 3 — Strategy + Conductor)
- Status: FIXED
- Fix: rebuilt the footer action cluster. It now exposes (defensively, only when each module is loaded): "Tick outcomes" — calls `AesConductorOutcomeDriver.tickOnce({force:true})` to score open fires immediately instead of waiting for the next 5-minute interval; "Clear fires" — `AesConductorScenarioStore.clear(ctx)`; "Clear routines" — `AesConductorRoutineStore.clear(ctx)`; "Clear signals" — existing path. Each is gated behind a typeof check so the tile degrades gracefully on pages that don't load the conductor stack. Verified by `node --check`.
- Repro: open the dashboard, expand the Conductor tile, scroll to the footer. Pre-fix: only one "Clear" button (signals only). The user could see fires, routines, signals — but only manipulate signals. No way to force an outcome re-score.
- Expected: per the audit brief, "conductor-tile exposes scenario-store + routine-store + outcome-driver controls". The store APIs (`clear`, `tickOnce`) already exist in the module surface.
- Actual: footer wired only `AesConductorSignalStore.clear`. Routine instances accumulated forever (CAP=100 then evicted by oldest); scenario fires accumulated forever (CAP=200 then evicted); outcome attribution waited on the 5-minute interval with no manual escape hatch.
- Notes: per-scenario enable/disable is NOT added — the bundled `AesConductorScenarios.all()` returns a hard-coded `ALL` slice with no storage-backed enable flags. Adding that would require a new `aesConductor:scenarios:enabled` store + plumbing through `AesConductorScenarioEngine._activeScenarios()`, which is out of scope for a minimal patch. Per-fire dismiss/accept buttons (already present in `_buildScenarioRow`) cover the "act on a specific fire" case.

## F-DASH-303: strategy-tile.js openHandler closes over panel module that may not be loaded yet — degrades silently but should match other tiles' pattern (no fix needed)
- Area: modules/central-hub/tiles/strategy-tile.js (lines 74-86)
- Severity: P3
- Found by: dashboard-pass (Agent 3)
- Status: WORKS
- Notes: openHandler() returns a closure that checks `window.AesStrategyPanel && typeof open === "function"` before invoking; otherwise warns to console. Manifest order at lines 429-432 loads `modules/strategy/panel.js` before `modules/central-hub/tiles/strategy-tile.js` so by the time the user clicks Open the panel global is present. Logged as WORKS — no fix; just confirming the construction-safety check.

## F-DASH-304: weekly-review-tile + diagnostics-tile have requiresAirline=false but call AES strategy/aggregator APIs that themselves require account context — degrades safely
- Area: modules/central-hub/tiles/weekly-review-tile.js, diagnostics-tile.js
- Severity: P3
- Found by: dashboard-pass (Agent 3)
- Status: WORKS
- Notes: both tiles guard every backing-module call with `typeof window.X === "undefined"` checks (e.g. weekly-review-tile.js:67-78, diagnostics-tile.js:142-145, 60-71) so they render an empty/muted state instead of throwing when the dashboard is loaded without a fleet/airline scope. Verified all referenced globals (`AesChangeLogAggregator`, `AesServiceExperimentStore`, `AesStrategy`, `RouteAssistantPricingApplyLog`, `RouteAssistantServiceProfileApplyLog`, `RouteAssistantWaveOverlay`, `RouteAssistantWavePlanDiagnostics`, `SchedulePresets`) are loaded by the dashboard content_scripts block in `manifest.json`. No fix needed.

## F-DASH-305: strategy-briefing-tile auto-opens a modal once per game-week boundary — but the guard key fallback when `__aesAccountId` is null collides across airlines on the same browser profile
- Area: modules/central-hub/tiles/strategy-briefing-tile.js (`_maybeAutoOpen`, lines 776-783)
- Severity: P3
- Found by: dashboard-pass (Agent 3)
- Status: FIXED
- Fix (port-9229): `_maybeAutoOpen` now derives the guard key with a three-step fallback when `__aesAccountId` is unresolved — `acct:<id>` → `server:<server>:airline:<airline>` → `server:<server>` → bare global. Server/airline come from `this._mountCtx`, which is the same ctx the tile uses for `buildBriefing`. Cold-start / sign-out / multi-airline windows no longer share one global "briefing seen" bucket; only the truly contextless case still falls through to the bare key (and that path is short-lived because account-registry populates `__aesAccountId` shortly after page load).
- Repro: load the dashboard on airline A (no account-id resolved yet), let the briefing auto-open and write `aesStrategy:briefingLastWeekId = <week>`. Switch to airline B (different server) before account-registry has populated `window.__aesAccountId`. The same global guard key blocks the auto-open even though airline B has never seen this briefing.
- Expected: per-airline guard whenever airline identity is resolvable from `ctx`, falling back to per-server before falling back to global.
- Actual: lines 778-780 use `acct:<id>` when `__aesAccountId` is a string; otherwise the bare key. Empty-account-id periods (cold-start, sign-out) blur all airlines into one bucket.
- Notes: low severity — affects only the brief window before `__aesAccountId` populates from `AesAccountRegistry`. The bigger briefing flow works.

## F-DASH-601: shell._buildSalienceContext reads HubFeed slice value from list() output, but list() returns metadata only — hubFeedUnread map never populates
- Area: modules/central-hub/shell.js (lines 659-672)
- Severity: P2
- Found by: hub-shell-pass (Agent 6)
- Status: FIXED
- Fix: read the slice value via `window.HubFeed.read(s.name)` instead of `s.value`. `HubFeed.list()` returns `[{name, hasValue, error, computedAt, computedMs, ttlMs, isStale, ageMs}]` per modules/_shared/hub-feed.js:135-149 — there is no `value` field. The pre-fix code coerced `s.value` (always undefined) via `Number(undefined) → NaN` which never satisfied `isFinite && > 0`, so the salience scorer never saw any feed-driven unread signal.
- Repro: declare a slice named `hub:tile:foo:unread` returning `{count: 7}`, then call shell._buildSalienceContext(). Pre-fix: ctx.hubFeedUnread.get("foo") → undefined. Post-fix: ctx.hubFeedUnread.get("foo") → 7.
- Expected: salience scorer's `hubFeed` weight contributes when slices keyed `hub:tile:<id>:unread` carry positive counts.
- Actual: the entire feed-unread input was dead wiring. Ranking degraded silently to priority + pin + recents + signals + pulse.
- Notes: only matters once tiles begin emitting `hub:tile:<id>:unread` slices; today there are no producers, so the live blast radius is zero. Fixing now keeps the contract honest for upcoming tile-keyed feeds.

## F-DASH-602: cascade-pane mount() host is row-flex without wrap; banner bands set flex:0 0 100% but never break the row, so banners squeeze alongside columns instead of closing the cascade
- Area: modules/central-hub/cascade-pane.js (lines 200-206, 266-294)
- Severity: P2
- Found by: hub-shell-pass (Agent 6)
- Status: FIXED
- Fix: (a) added `flex-wrap:wrap` to the host's inline cssText so 100%-width children force a new row; (b) restructured `_layout` to clear the host on every layout pass and emit each cascade band as its own full-width row containing freshly-built per-column flex children (banner bands stay full-width siblings). Removed the dead `band._order` reference (always undefined → invalid `order:undefined` CSS).
- Repro: switch settings.layoutMode to "cascade" with at least one tile flagged `cardKind:"marquee"` or one tile in `pinnedFullWidthTiles`. Pre-fix: marquee tile rendered as a 100%-width child inside a non-wrapping flex row, visually overflowing the cascade and pushing the columns off-axis. Reflows after a column-count change failed to clear stale banners (host.innerHTML was only cleared when columnCount changed, not on every layout).
- Expected: marquee/full-width tiles close the current cascade band and emit a single full-width row before the next cascade band continues below.
- Actual: bands share a single non-wrapping row; banner with flex-basis:100% gets clamped by surrounding flex:1 1 0 columns; reflows leak previous banners.
- Notes: also dropped the `state.columnEls.length !== cc` short-circuit so column shells are rebuilt every layout — the band-per-row model means columns are scoped to their band, not the host.

## F-DASH-603: cascade-pane.columnCountFor signature ignored its second arg; _resize read --aes-tile-min-col then passed it as the dropped arg
- Area: modules/central-hub/cascade-pane.js (lines 167-173, 365-373)
- Severity: P3
- Found by: hub-shell-pass (Agent 6)
- Status: FIXED
- Fix: extended `columnCountFor(containerWidthPx, minColPx)` to honour the second argument, falling back to MIN_COL_WIDTH_FALLBACK on missing/invalid input. The `_resize` call site already passed the resolved CSS variable; previously it was silently dropped, so the column count derived from a hardcoded 280px floor regardless of the tile-min-col token.
- Repro: set `--aes-tile-min-col:380px` on the cascade host. Pre-fix: column count still computed from the 280 fallback. Post-fix: the override drives the column count.
- Expected: per the function's own docstring, the column count is derived from container width AND the current min-col token.
- Actual: minCol arg dropped on the floor.
- Notes: doc-comment in the signature now matches behaviour; pure fn, easy to test.


## F-DASH-501: competitor-monitoring-tile didn't refresh on competitor-intel:diff bus signal — needed manual reload to mirror new snapshots
- Area: modules/central-hub/tiles/competitor-monitoring-tile.js (mount, lines 36-52)
- Severity: P2
- Found by: dashboard-pass (Agent 5)
- Status: FIXED
- Fix: in `mount()`, subscribe to `data:competitor-intel:enterprise:diff` and `data:competitor-intel:enterprise:updated` (both emitted by `modules/competitor-intel/snapshot-store.js:134-147` after a successful save) and call `this.refresh()` on each. Disposers added to `this._busDisposers` so dispose() cleans up.
- Repro: open the dashboard with N tracked competitors; trigger a competitor-intel scrape on another tab that produces a snapshot diff; observe the monitoring tile badge stays at the pre-scrape count + last-overview date until manual reload.
- Expected: dataset-sourced bus events keep the tile in sync without polling chrome.storage.
- Actual: the only reactive path was watchedStorageKeys=[server] which fires on every storage change matching the prefix — but enterprise snapshot writes to `competitorIntel:snapshots:<server>:<eid>` are not stamped with `<server><airline>` competitor monitoring keys, so the storage-change listener also missed them. Now both the bus events AND the existing storage listener cover the cases.
- Notes: minor — covers the prompt's "verify monitoring tile receives them" requirement.

## F-DASH-502: competitor-intel-hub-tile body lacked any user-facing actions (bulk scan, watchlist, drilldown) despite owning the dashboard entry point
- Area: modules/central-hub/tiles/competitor-intel-hub-tile.js (renderBody)
- Severity: P2
- Found by: dashboard-pass (Agent 5)
- Status: FIXED
- Fix: appended an actions row to the body with three buttons — "Show watchlist (top 5)" calls `AesCompetitorWatchlist.derive({server, limit:5})` and renders the top items inline; "Drilldown enterprises →" opens `AesCompetitorIntelHost.open()` (the hub-shell modal); "Refresh stale enterprises" invokes `AesCompetitorOutlineRunner.runForServer({server})` (which already filters to past-TTL enterprises per F-9226-015). Each button is feature-detected — disabled with a tooltip when its global is absent. Also hardened the row-click handlers with `typeof === "function"` guards. Verified by `node --check`.
- Repro: open the dashboard, expand the Competitor Hub tile; before fix the body was four read-only count rows + a footer note.
- Expected: per the audit prompt — "let user run a bulk-scanner, view watchlist, drilldown enterprises".
- Actual: rows opened the host on click but no other affordances. No watchlist preview. No bulk-scan trigger.
- Notes: bulk-scanner.js itself isn't loaded on /app/enterprise/dashboard* (manifest.json:1040 — competitor-intel page block only), so the runner is the proper dashboard-side entry point.

## F-DASH-503: competitor-outline-tile body had no in-tile actions — refresh + open required Open-button workflow
- Area: modules/central-hub/tiles/competitor-outline-tile.js (renderBody)
- Severity: P3
- Found by: dashboard-pass (Agent 5)
- Status: FIXED
- Fix: after the top-3 preview rows, appended an actions row — "Open full outline →" reuses `AesCompetitorOutlinePanel.show()` and "Refresh stale rivals" invokes `AesCompetitorOutlineRunner.runForServer({server})`. Refresh button disables while running, displays the count, then re-runs `_cachedOutline = null; this.refresh()` so the badge + preview reflect the new state. Verified by `node --check`.
- Notes: the existing Open button on the tile chrome was the only user surface — body was preview-only. This adds parity with other action-bearing tiles (fleet-command, route-assistant).

## F-DASH-504: settings-tile unified-settings branch only exposed a single "Open Settings →" button — no per-tab quick-jump
- Area: modules/central-hub/tiles/settings-tile.js (renderBody, unified branch)
- Severity: P3
- Found by: dashboard-pass (Agent 5)
- Status: FIXED
- Fix: under the "Open Settings →" CTA, added a 5-button row that calls `AesUnifiedSettings.open()` then `setActiveTab(tabId)` for each of customisation/modules/account/data/about. The unified-settings host already exposes `setActiveTab` (modules/unified-settings/host.js:46-52) but no caller in the codebase used it. Verified by `node --check`.
- Notes: lower severity — the unified shell has its own tab strip — but the dashboard prompt explicitly said "Settings tile should expose the unified-settings shell directly from the hub."

## F-DASH-505: tools-tile body was a pure-link list — no in-extension utility actions despite the section name
- Area: modules/central-hub/tiles/tools-tile.js (renderBody)
- Severity: P3
- Found by: dashboard-pass (Agent 5)
- Status: FIXED
- Fix: prepended a utility-actions row before the link grid — "Open command palette" → `AESCommandPalette.open()`, "Run all cleanups" → `AesCleanup.runAll({reason:"manual-tools-tile"})`, "Clear bus history" → `AesDataBus.clearHistory()`, "Open options page →" → `chrome.runtime.openOptionsPage()`. Each button is feature-detected via `typeof === "function"` and disabled with a tooltip when the backing module is absent. Added a local `_actionBtn` helper mirroring the settings-tile pattern. Verified by `node --check`.
- Notes: the doc-comment at the top of the tile said it "mirrors the Community + Support sections" — those links remain. The prompt expectation "tools-tile should expose utility actions as buttons" is now met.

## F-DASH-506: competitor-monitoring-tile.openHandler dereferenced bare CentralHubLegacy instead of window.CentralHubLegacy — would throw on cold start if module missing
- Area: modules/central-hub/tiles/competitor-monitoring-tile.js (openHandler, line 33)
- Severity: P2
- Found by: dashboard-pass (Agent 5)
- Status: FIXED
- Fix: wrapped in `if (window.CentralHubLegacy && typeof window.CentralHubLegacy.switchDropdownTo === "function")`. CentralHubLegacy is registered at `modules/central-hub/legacy-bridge.js:37` and loaded earlier in the dashboard block (manifest.json:223), but the bare reference would throw if for any reason the module didn't initialise (e.g. `'use strict'` non-strict-equal lookup is fine but a missing global would still ReferenceError when called). The guard makes the Open button a no-op instead of a throw.
- Notes: defensive. The existing `if (typeof window.X === "undefined") return` pattern from competitor-outline-tile is the project convention — this matches.

## F-DASH-101: used-aircraft-scanner stores never exposed on window — tile's preset/diff/session features dead
- Area: modules/used-aircraft-scanner/presets-store.js, scan-session-store.js, scan-diff-store.js + modules/central-hub/tiles/used-aircraft-scanner-tile.js
- Severity: P1
- Found by: dashboard-pass (Agent 1, fleet+aircraft scope)
- Status: FIXED
- Fix: appended `if (typeof window !== "undefined") { window.UsedAircraftPresets = UsedAircraftPresets }` (and analogous lines for `MarketScanSession`, `MarketScanDiffStore`) to the three store files. The classes were declared at top level with `class` syntax, which in Chrome MV3 isolated-world content scripts goes to the script realm's lexical environment but NOT onto the global object — so `window.UsedAircraftPresets` was undefined. The tile's `typeof window.UsedAircraftPresets === "function"` guards (used-aircraft-scanner-tile.js lines 46, 77, 96, 162) all evaluated false, silently disabling preset-chip click activation, the BUILT_IN preset count in the badge, and the entire top-steals strip (which depended on `MarketScanDiffStore.loadAllDigests`). The active-session readback similarly fell through to a raw `chrome.storage.local.get` instead of `MarketScanSession.loadSession`. Other modules (scan-controller.js, market-panel/panel.js) that referenced the bare `UsedAircraftPresets` lexical kept working, masking the issue.
- Repro: load a dashboard with `chrome.storage.local.set({"settings": {"usedAircraftScanner": {"presets":[{"id":"p1","name":"Test","types":["A320"]}], "lastScanId":null}}})` plus a finished `<server>marketScan:digest:p1` digest blob. Open the Used Scanner tile, click a preset chip — pre-fix it was a no-op (no badge update, no active highlight). Top-steals row never rendered.
- Expected: preset chips activate, BUILT_IN_PRESETS counted in the badge, top-steals row renders with the best-3 dealScore rows from saved digests.
- Actual: pre-fix all three pathways short-circuited at the `typeof window.X === "function"` guard. Tile rendered presets via the `block.presets` fallback (just user-saved, no built-ins) and never showed top-steals.
- Notes: this is a recurring class — any tile using `window.X` for a class declared top-level in another module of the same content-script block needs explicit window exposure. Worth grepping the rest of the tiles in agent 2-6 scope for the same pattern.

## F-DASH-102: aircraft-profitability-tile watched empty-string prefix → refresh on every storage change
- Area: modules/central-hub/tiles/aircraft-profitability-tile.js (watchedStorageKeys, lines 26-28)
- Severity: P2
- Found by: dashboard-pass (Agent 1)
- Status: FIXED
- Fix: guard with `if (!server) return []` so the base-class storage listener doesn't subscribe to a thrash-prefix when ctx.server is missing. Also dropped the `+ ""` no-op tail.
- Repro: load the hub on a page where `ctx.server` resolves to "" (rare but possible during a partial bootstrap); pre-fix the tile would `refresh()` on every chrome.storage write across the entire extension because `k.indexOf("") === 0` is unconditionally true.
- Expected: tile only refreshes on changes whose key starts with the user's server prefix, or skips the listener entirely until server resolves.
- Actual: tile's listener fired on every storage change. Behaviour observed by code inspection of base-class `_attachStorageListener` (modules/central-hub/tile.js:412-436) which does `k.indexOf(p) === 0` — empty `p` always matches.
- Notes: same fix shape applied prophylactically to `fleet-optimizer-tile.watchedStorageKeys` (dropped the bare `server` from the prefix list when empty). `fleet-hub-tile` already guarded; `aircraft-flight-plan-tile` had a "::" suffix that prevented the false-match and was tightened to skip-when-empty for clarity.


## F-DASH-401: Accounting tile keyed snapshots by airline CODE; finance scrapers + panel save by airline NAME — tile always shows zero rows even when snapshots exist
- Area: modules/central-hub/tiles/accounting-tile.js (_airlineKey, line 36)
- Severity: P0
- Found by: dashboard-pass (Agent 4)
- Status: FIXED
- Fix: `_airlineKey()` now calls `AES.getAirlineIdentity()` (the top-nav airline name) instead of `AES.getAirlineCode().code`. Mirrors what `content_finance_accounting.js`, `content_finance_{leasing,capital,assets,cashflow}.js` (each `airline = AES.getAirlineIdentity()`) and `modules/accounting/panel.js:24` actually pass into `AccountingSnapshotStore.save{Tab,Sister}(server, airline, …)`. The cash-feed (`modules/central-hub/feed/cash-feed.js:108`) was already using the identity form; the tile was the odd one out.
- Repro: scrape any of /app/finance/accounting{,/0,/1,/2} or any sister page, then open the dashboard. Accounting tile would render "No accounting snapshots yet."
- Expected: tile lists the recently scraped weeks + lit-up sister pages.
- Actual: empty tile because `<server><CODE>accounting:index` was never written; the real key is `<server><NAME>accounting:index`.
- Notes: F-9223-012 covers a related multi-airline scoping issue; this finding is the orthogonal "wrong identifier kind" bug.

## F-DASH-402: Accounting tile linked the cash-flow sister page to /app/finance/cashflow — that route 404s; AS hosts the cashflow view at /action/enterprise/schedule
- Area: modules/central-hub/tiles/accounting-tile.js (sister page link map, line 137)
- Severity: P2
- Found by: dashboard-pass (Agent 4)
- Status: FIXED
- Fix: changed the cashflow link href to `/action/enterprise/schedule`, matching `modules/accounting/panel.js:914` (the canonical pages map) and the manifest entry at line 826 that wires `content_finance_cashflow.js` to that URL.
- Repro: open the accounting tile, click the "Cash flow" pill.
- Expected: navigates to the AS cashflow page; on first visit, content_finance_cashflow.js seeds the sister record.
- Actual: AS 404; sister cell stays "—".
- Notes: leasing/capital/assets links were already correct.

## F-DASH-403: Accounting tile never subscribed to its HubFeed slice — fresh accounting writes from non-dashboard tabs didn't recompute the tile and the freshness dot never lit
- Area: modules/central-hub/tiles/accounting-tile.js (feedSlices override missing)
- Severity: P2
- Found by: dashboard-pass (Agent 4)
- Status: FIXED
- Fix: added `feedSlices() { return ["hub:cash:weekly"] }`. The base class wires the subscription in `_attachFeedSubscriptions` (tile.js:438) and CentralHubTile._renderHeader paints the stale dot from the captured freshness. cash-feed.js already declares the slice with deps `[data:accounting:weekly:saved, data:account:bootstrapped]` and `feed/index.js` bridges accounting-key writes onto that bus topic.
- Repro: scrape an accounting week from another tab while the dashboard is open. Tile didn't refresh.
- Expected: the tile re-reads + re-renders within the slice's debounce window; stale dot disappears once a fresh value lands.
- Actual: only direct chrome.storage.onChanged (account-scoped) fires the watch.
- Notes: also tightened watchedStorageKeys to return [] when airline ctx is missing (was returning the bare server prefix, which the listener treats as "match every key" via the indexOf===0 path called out in F-9223-015).

## F-DASH-404: Inventory tile called window.RouteAssistantToast.{warn,progress} but RouteAssistantToast is a top-level class binding, not a window property — quick-price form throws "Cannot read property … of undefined"
- Area: modules/central-hub/tiles/inventory-tile.js (price-validation + apply progress paths, lines 396, 423)
- Severity: P1
- Found by: dashboard-pass (Agent 4)
- Status: FIXED
- Fix: switched to bare `RouteAssistantToast.warn(...)` / `RouteAssistantToast.progress(...)` (with `typeof RouteAssistantToast !== "undefined"` guard) — the rest of the codebase (route-assistant/panel.js, fleet-hub/command-center.js' `ns = window.RouteAssistantToast` is the rare exception) uses the bare-name form. `modules/route-assistant/toast-host.js` defines the class via `class RouteAssistantToast { … }` and ends with only `module.exports`; in MV3 content-script isolated worlds, top-level class declarations are global lexical bindings, not properties of `window`, so `window.RouteAssistantToast` resolves to `undefined`.
- Repro: open Inventory tile → Set price → enter blank/negative price → Apply.
- Expected: a "warn" toast pops, focus returns to the input.
- Actual: TypeError, the apply form locks up.
- Notes: the second hit was the apply-progress toast — same root cause; same fix shape. A wider sweep to add `if (typeof window !== "undefined") window.RouteAssistantToast = RouteAssistantToast` to toast-host.js would also fix it project-wide, but that file is owned by Agent 2 (Routes); leaving the tile-local fix in.

## F-DASH-405: Alliance tile constructor set this.section="tools" while registry registered section:"operations" — bleed-strip accent painted from the wrong palette key, and the tile would have been wrong-section if anything ever read this.section as authoritative
- Area: modules/central-hub/tiles/alliance-tile.js (constructor, line 19)
- Severity: P3
- Found by: dashboard-pass (Agent 4)
- Status: FIXED
- Fix: aligned the constructor field to "operations" (the section the tile is mounted under). CentralHubTile._buildRoot copies `this.section` into `dataset.section` and CentralHubTile._sectionAccent maps `operations → T.color.amber` (was falling through to `tools → slate`).
- Repro: render alliance tile; left bleed strip is grey instead of amber.
- Expected: amber bleed strip, matching the rest of the Operations section.
- Actual: grey (tools accent).
- Notes: low severity (purely cosmetic), but it was also a code-clarity hazard — anyone reading the tile would assume "tools" was the truthful section.

## F-DASH-406: General tile watched the bare `<server>` prefix, which devolves to `""` when ctx.server is missing — chrome.storage.onChanged listener then matches every key and fires refresh() on every storage write, project-wide
- Area: modules/central-hub/tiles/general-tile.js (watchedStorageKeys, line 27)
- Severity: P1
- Found by: dashboard-pass (Agent 4)
- Status: FIXED
- Fix: rewrote the function to return only the two concrete keys the tile actually reads (`<server><code>schedule`, `<server><name>personelManagement`). Returns `[]` when server or airline identity isn't available. The bare-string-prefix anti-pattern is the same shape as F-9223-015.
- Repro: open the dashboard with the general tile mounted; inspect the storage listener with `chrome.storage.local.set({foo: 1})` and watch refresh() fire.
- Expected: refresh() fires only when schedule/personnel writes land.
- Actual: refresh() fires on every storage write across the whole extension.
- Notes: also adds a "Game day YYYY-MM-DD · HH:MM UTC" greeting line at the top of the body when AES.getServerDate() is parseable, to match the Audit-spec "general should show greeting + last-game-date" requirement. AES.getServerDate() throws on pages without `.as-navbar-bottom`; wrapped in try/catch so cold-start is mount-safe.

## F-DASH-201: route-assistant-tile "Open scheduling →" link concatenated the hub IATA twice — produced /app/com/scheduling/JFKJFK rather than /app/com/scheduling/JFK
- Area: modules/central-hub/tiles/route-assistant-tile.js (_renderHub, line 200)
- Severity: P1
- Found by: dashboard-pass (Agent 2)
- Status: FIXED
- Fix: dropped the duplicated `encodeURIComponent(hubInfo.hub)`. The href now matches AS's documented format `/app/com/scheduling/<HUB>` (3 letters; the 6-letter form `<HUB><DEST>` is a different page).
- Repro: render the route-assistant tile with at least one cached topRoutes hub. Hover the heading row's "Open scheduling →" link.
- Expected: `/app/com/scheduling/JFK` (single hub IATA).
- Actual: `/app/com/scheduling/JFKJFK` — AS interprets the trailing 3 chars as a destination IATA which doesn't exist, so the page renders an unrelated lookup or 404.
- Notes: the same heading is the user's primary CTA back to the route assistant for that hub, so this had been silently routing every "open scheduling" click into the wrong route view.

## F-DASH-202: route-management-tile read sched.flights but the legacy schedule schema stores legs under sched.date[<dateStr>].schedule[] — body always rendered "no flights" even when extracts were present
- Area: modules/central-hub/tiles/route-management-tile.js (_loadSchedule, loadStatus, renderBody)
- Severity: P1
- Found by: dashboard-pass (Agent 2)
- Status: FIXED
- Fix: rewrote `_loadSchedule()` to walk `v.date` as the {<dateStr>: {schedule:[...]}} map content_fligthSchedule.js actually writes, picks the latest numeric date entry, and returns `{flights, dateStr}`. Status badge / body now render real leg/destination counts. Also tightened watchedStorageKeys to the exact `<server><airline>schedule` key instead of the bare-server prefix that fired refresh on every storage change. Open handler defensively checks window.CentralHubLegacy.
- Repro: extract a schedule on /app/info/enterprises/<id>?tab=3, open dashboard, expand the route-management tile.
- Expected: tile shows "<N> legs · <M> destinations · extracted <date>" and lists top route pairs.
- Actual: tile shows "No schedule extracted." even though `<server><airline>schedule` is present and populated.
- Notes: the schema mismatch is plain (`v.date` is an object, not a string; legs live under `v.date[<dateStr>].schedule`). Same shape route-assistant/panel.js iterates correctly at line 3013–3015, so the tile was diverging from the canonical reader. Bare-server watch dropped per F-DASH-406's pattern.

## F-DASH-203: station-automation-tile watchedStorageKeys returned a prefix that doesn't match any real storage key — refresh never fires from queue/run writes
- Area: modules/central-hub/tiles/station-automation-tile.js (watchedStorageKeys, line 21-22)
- Severity: P1
- Found by: dashboard-pass (Agent 2)
- Status: FIXED
- Fix: keys are `<server><airlineId>stationAutomationQueue` and `<server><airlineId>stationAutomationRun:<runId>...` per modules/station-automation/storage.js — feed those literal prefixes (resolving airlineId via AES.getAirlineIdentity() when ctx.airline is missing). Returns `[]` when server is unknown.
- Repro: open the dashboard, run the station-automation legacy panel to enqueue a country (writes the queue key), watch the tile body — it doesn't recount.
- Expected: tile refresh fires when the queue or active-run records change.
- Actual: prefix `stationAutomation:<server>:` matches no key (storage uses `<server><airlineId>stationAutomation*` without a colon separator), so the listener never fires.
- Notes: also synced this.section = "operations" to match the registry section so the bleed-strip accent uses the operations palette (was set to "routes" → cobalt instead of amber, mirrors F-DASH-405). The openHandler had already been wrapped with a window.CentralHubLegacy guard before this pass.

## F-DASH-204: service-profile-tile constructor set this.section="routes" but registry registers under "operations" — visual bleed accent + section dataset diverged from where the tile actually mounts
- Area: modules/central-hub/tiles/service-profile-tile.js (constructor, line 24)
- Severity: P3
- Found by: dashboard-pass (Agent 2)
- Status: FIXED
- Fix: changed this.section = "operations" to match the registry. CentralHubTile._buildRoot copies this.section into dataset.section and the bleed-color resolver maps operations → T.color.amber.
- Repro: render the dashboard; inspect the service-profile tile's left border.
- Expected: amber bleed strip, matching the operations section.
- Actual: cobalt blue (routes accent).
- Notes: identical pattern to F-DASH-405 (alliance) and F-DASH-203 (station-automation). The shell uses spec.section to bucket tiles into sections so placement is correct; the cosmetic divergence still misleads anyone reading the tile.

## F-DASH-205: route-management / schedule-management openHandler dereferenced bare CentralHubLegacy — would throw on cold start if the legacy bridge were absent (matches F-DASH-506 fix shape)
- Area: modules/central-hub/tiles/route-management-tile.js (openHandler) + modules/central-hub/tiles/schedule-management-tile.js (openHandler)
- Severity: P3
- Found by: dashboard-pass (Agent 2)
- Status: FIXED
- Fix: wrapped both in `if (window.CentralHubLegacy && typeof window.CentralHubLegacy.switchDropdownTo === "function")` before calling. flightsfrom-tile and station-automation-tile were already updated in earlier passes; route-launcher / world-view / route-assistant don't use the legacy bridge.
- Repro: drop the legacy-bridge load order (e.g. manifest regression) and click Open on either tile.
- Expected: silent no-op (legacy unavailable, tile still works).
- Actual: ReferenceError: CentralHubLegacy is not defined — bubbles into `_buildOpenButton`'s console.warn and the click is dead.
- Notes: legacy-bridge.js loads at manifest line 223 (well before the route tiles at 269/276) so production hasn't seen the throw, but the call-site convention should be consistent across tiles. Same fix applied earlier as F-DASH-506.


## F-DASH-001: 28 module classes declared but never exported to window — silent dead-ends across hub tiles
- Area: cross-cutting (28 files in modules/)
- Severity: P1
- Found by: dashboard-pass (Agent 1 + meta scan)
- Status: FIXED
- Repro: open the dashboard, expand any tile that consumes one of these via `if (typeof window.X === "function") X.method()` — the guard returns false silently, the feature dead-ends.
- Expected: every class consumed via `window.X` is reachable via `window.X` after its defining script loads.
- Actual: top-level `class Foo {}` in MV3 content-script files is lexical-scope only; without an explicit `window.Foo = Foo` assignment, `window.Foo` is undefined. 28 files had this gap — including `RouteAssistantToast`, `RouteAssistantSettings`, `RouteAssistantPanel`, `AccountingSnapshotStore`, `AccountingProjector`, `AccountingAggregator`, `ScheduleStore`, `SchedulePanel`, `SchedulePresets`, `ScheduleFactors`, `StationAutomationStorage`, `FlightsFromStore`, `AesCompetitorStore`, `RouteAssistantWavePlanDiagnostics`, `RouteAssistantWaveOverlay`, `RouteAssistantWaveEditor`, `RouteAssistantOrsScraper`, `RouteAssistantOrsModel`, `RouteAssistantMarketsPageScraper`, `RouteAssistantYieldHistoryStore`, `RouteAssistantTypeSpecsStore`, `RouteAssistantContractualPartnersScraper`, `RouteAssistantDemandStore`, `RouteAssistantRouteOverridesStore`, `RouteAssistantSandboxScenariosStore`, `RouteAssistantWatchlistStore`, `RouteAssistantDistanceResolver`, `RouteAssistantRouteNoteStore`. Verified by grep: any consumer in a different content-script block (e.g. dashboard tile referencing a route-assistant class) gating on `typeof window.X === "function"` saw `undefined`.
- Fix: appended `if (typeof window !== "undefined") { window.X = X }` to each file (idempotent, no behavioural change for callers using bare names within the same block). Files patched (28): flightsfrom/data-store.js; accounting/{aggregator,snapshot-store,projector}.js; schedule-management/{schedule-store,schedule-panel,range-buckets,presets-store}.js; station-automation/storage.js; route-assistant/{contractual-partners-scraper,demand-store,route-overrides-store,sandbox-scenarios-store,watchlist-store,distance-resolver,panel,settings-store,route-note-store,ors-scraper,ors-model,markets-page-scraper,wave-overlay,wave-editor,toast-host,yield-history-store,wave-plan-diagnostics,type-specs-store}.js; competitor-intel/competitor-store.js. All 28 pass `node --check` post-edit.
- Notes: This is the same root cause as F-DASH-101 (used-aircraft-scanner stores) and F-DASH-404 (toast-host). Bare-name consumers in the SAME content-script block still resolve via lexical scope (manifest load order guarantees that within a block) — but cross-block consumers (e.g. a dashboard tile reaching into a route-assistant store loaded only on the scheduling page, OR a tile using the `window.X` guard to avoid hard dependency) silently dead-end. The guard pattern `typeof window.X === "function"` is the safer one and is now universally honoured.

<!-- port-9228 station-automation tile interaction audit (F-9228-100+) -->
Audited 1 element; 3 bugs found.

(Tile-side wiring bugs the prompt asked me to look for — watchedStorageKeys prefix mismatch and section/registry divergence — were already filed and FIXED as F-DASH-203 + F-DASH-001 before this pass. The tile's only interactive element is the inherited Open button driven by `openHandler()` at modules/central-hub/tiles/station-automation-tile.js:33, which now properly guards `window.CentralHubLegacy.switchDropdownTo("stationAutomation")`. Bugs below are in the surrounding station-automation surfaces — status-strip + storage GC — that the audit brief instructed me to grep for as producers/consumers.)

## F-9228-100: status-strip "OPEN STATION AUTOMATION" link / compact badge drops the user on /app/enterprise/dashboard with no station-automation hash — label promises X, click delivers Y
- Area: modules/station-automation/status-strip.js (_dashboardLink lines 303-322, _renderCompact lines 332-357, _navigateToDashboard lines 361-365)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: `_navigateToDashboard` now in-tab-flips the legacy dropdown via `CentralHubLegacy.switchDropdownTo("stationAutomation")` when the dashboard is already mounted (the same path the hub tile uses). Otherwise it opens the dashboard with `#aes-section=stationAutomation`. content_dashboard.js parses the hash after building the dropdown and overrides the user's `defaultDashboard` so the click lands on the promised pane regardless of last preference.
- Repro: per the file's own docstring (lines 6-12) the strip mounts in the Schedule Management panel and the Route Assistant header. With at least one queued country, click the "OPEN STATION AUTOMATION" link (full mode) or the compact badge. A new tab opens at `https://<host>/app/enterprise/dashboard`. The dashboard renders with whatever the user's last `settings.general.defaultDashboard` choice was (legacy-defaults.js seeds it from the dropdown they last picked); for any user whose default is e.g. "general" or "routeAssistant", the click LANDS THEM ON A DIFFERENT PANE and they have to manually pick "Station Automation" from the dropdown.
- Expected: a link labelled "OPEN STATION AUTOMATION" lands on the Station Automation pane. Either pass `#aes-section=stationAutomation` on the URL and have content_dashboard.js read that hash post-render, or keep navigation in-tab and call `CentralHubLegacy.switchDropdownTo("stationAutomation")` after the dashboard is mounted. Cf. station-automation-tile.js:33-39 which already does the in-tab switch successfully when the user is already on the dashboard.
- Actual: `_navigateToDashboard` at lines 361-365 builds `https://${host}/app/enterprise/dashboard` and calls `window.open(url, "_blank")`. No hash, no query, no post-nav handoff. content_dashboard.js has no listener that would honour an intent to switch to stationAutomation after a fresh load — its dropdown defaults to legacy-defaults.js's `defaultDashboard` (or the user's last-persisted choice). Same call drives the click handlers at line 320 (full link) and line 355 (compact badge), so both affordances fail identically.
- Notes: Mirrors the affordance promise the legacy in-page Open button already keeps. Fix: navigate with `https://${host}/app/enterprise/dashboard#aes-section=stationAutomation`, and in content_dashboard.js's dashboard-render path, after the legacy dropdown is built, parse `window.location.hash` for `aes-section=` and call `CentralHubLegacy.switchDropdownTo` accordingly. Or, since the strip already runs on an AS app page (same origin), open the dashboard in-tab via `window.location.assign` to avoid the new-tab + dropdown-default round-trip entirely.

## F-9228-101: status-strip queued-summary suppresses threshold-only countries whenever any whitelist entry is present — display undercounts the queue
- Area: modules/station-automation/status-strip.js (_summarize lines 154-162, _renderFull lines 233-237, _renderCompact lines 337-340)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: `_summarize` now also returns `thresholdCountries` (queue entries with no airportWhitelist). _renderFull renders `<airports> + <thresholdCountries> threshold-only · across <countries>` when both populations are non-zero, and degrades gracefully to either-only otherwise. _renderCompact renders `<airports>+<tc> QUEUED` so the badge no longer hides threshold-only entries from the user.
- Repro: enqueue two entries — one threshold-based country (`{countryName:"France", paxThreshold:5, cargoThreshold:0}` — no airportWhitelist) and one bulk-target whitelist country (`{countryName:"Germany", airportWhitelist:["FRA","MUC","TXL"]}`). Mount the strip. Full mode reads "3 AIRPORTS ACROSS 2 COUNTRIES"; compact reads "3 QUEUED". But France is threshold-mode and could resolve to 0 or 50 airports at run time; the count "3" silently excludes France's resolution.
- Expected: when the queue mixes threshold and whitelist entries, the summary either reports both populations distinctly (e.g. "3 airports + 1 threshold-based country across 2 countries") or falls back to "2 countries queued" without an airport count to avoid an undercount. The compact badge has the same problem: `${s.airports || s.countries} QUEUED` shows "3 QUEUED" when the user-requested cardinality is "1 country (threshold) + 3 specific airports".
- Actual: `_summarize` at lines 154-162 sums `airports` only over entries with `airportWhitelist.length > 0`; threshold-mode entries contribute nothing to the count. The display ternary at lines 233-236 picks the airports-mode string whenever `s.airports > 0`, swallowing the country-mode info entirely. Same thing for compact at line 339: `${s.airports || s.countries}` resolves to airports as soon as ANY whitelist entry exists, hiding threshold-only entries from the badge.
- Notes: Mostly a UX/messaging bug, but since the strip's stated job (file docstring lines 6-12) is to surface queue cardinality without forcing a dashboard trip, an undercount is real and observable. Fix: in `_summarize`, also count `countriesThresholdOnly = queue.filter(e => !(e?.airportWhitelist?.length)).length`; render full mode as `"<airports> airport(s) + <countriesThresholdOnly> threshold-only · across <countries> countries"` when both are non-zero. Compact: `"<airports>+<countriesThresholdOnly> QUEUED"` or just `"<countries> QUEUED"` when mixed.

## F-9228-102: StationAutomationStorage.cleanupOldRuns leaves per-airport result blobs orphaned in the same pass that deletes their parent run
- Area: modules/station-automation/storage.js (cleanupOldRuns lines 167-187)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: split into two passes. The first pass identifies session records to drop and adds them to a `deletedSessions` Set. The second pass walks `:r:<idx>` blobs and removes any whose owner is already gone OR is in `deletedSessions`. Previously the orphan check tested the snapshot, which was still truthy in the same call — so blobs of deleted sessions leaked until the next cleanup invocation.
- Repro: in DevTools on the dashboard tab, write an old session plus its result blobs:
  ```
  await chrome.storage.local.set({
    "simworld_oneFLYNYstationAutomationRun:sr-old1": {runId:"sr-old1", server:"simworld_one", airlineId:"FLYNY", startedAt: Date.now() - 48*3600_000},
    "simworld_oneFLYNYstationAutomationRun:sr-old1:r:0": {iata:"AAA", status:"ok"},
    "simworld_oneFLYNYstationAutomationRun:sr-old1:r:1": {iata:"BBB", status:"ok"}
  })
  ```
  Then `await StationAutomationStorage.cleanupOldRuns("simworld_one", "FLYNY", null, 24*3600_000)`. After the call, the session key is gone but the two `:r:0` / `:r:1` blobs survive. `chrome.storage.local.get(null)` confirms.
- Expected: orphaning the results in the same call reaps both the session and its result blobs, so storage doesn't accumulate a half-deleted run between cleanup invocations.
- Actual: `cleanupOldRuns` snapshots `all = await chrome.storage.local.get(null)` once (line 168). For each session key, if old, it pushes the session key to `toRemove` (line 180). For each result key (`:r:` substring), it checks `if (!all[owner]) toRemove.push(k)` (line 183) — but `all[owner]` is the snapshot, which still contains the (about-to-be-deleted) session record. The result keys are NOT pushed. So the single-pass cleanup deletes the session and leaks its results until the NEXT cleanup pass (which finally sees `all[owner]` undefined). Cleanup runs from content_dashboard.js:2867 only on dashboard render, so a user who runs the dashboard, GC's session A, then never reopens the dashboard will leave A's results in storage indefinitely.
- Notes: Two-pass cleanup is observable in DevTools but the file's docstring at line 165 says "GC orphan/old run keys" implying single-pass. Fix shape (1 line): when adding a session key to toRemove, also iterate `all` for keys starting with `<sessionKey>:r:` and push each. OR refactor: build a `Set<string>` of toRemove first, then re-iterate result keys checking `toRemove.has(owner) || !all[owner]`. Mechanical fix, contained blast radius — hence P3.

## F-9228-007: Inventory tile "Open" button sends user to /app/com/markets when no inventory is cached, contradicting the empty-state instruction
- Area: modules/central-hub/tiles/inventory-tile.js (openHandler + loadStatus empty branch)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: openHandler keeps the /app/com/markets fallback (markets is the route-discovery surface — user picks a market and AS surfaces inventory link), but the empty-state summary now reads "Click Open to pick a route, or visit /app/com/inventory/<HUB><DEST> to seed." so the button label and effect agree.
- Repro: open the central-hub Inventory tile with no `routeAssistant:inventory:*` keys cached → click "Open →".
- Expected: button effect matches summary text.
- Actual (pre-fix): user landed on /app/com/markets while the summary instructed visiting /app/com/inventory/<HUB><DEST>.
- Notes: paired with F-9228-008 (stale _lastTopRoute) — both touch the same closure.

## F-9228-008: Inventory tile keeps stale `_lastTopRoute` after the cache is cleared — Open button navigates to a route that no longer has data
- Area: modules/central-hub/tiles/inventory-tile.js (loadStatus, line ~44)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: empty branch in loadStatus now sets `this._lastTopRoute = null` before returning the muted status. The openHandler closure correctly reaches its fallback path on subsequent clicks.
- Notes: one-line fix; previously _lastTopRoute was only assigned in the non-empty branch, so a cache-then-clear sequence left a stale {hub,dest}.

## F-9228-009: Storage-triggered refresh wipes the open quick-price form mid-edit, losing the user's typed price
- Area: modules/central-hub/tiles/inventory-tile.js (renderBody clobber + Set price / Cancel / Apply)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: track `this._editingPair` on Set-price click; clear on Cancel and on Apply finish. renderBody early-returns when editing and no focusFilter is in play, deferring the rerender until the user finishes the form. Apply/Cancel both trigger their own rerender so the deferred state isn't sticky.
- Repro: expand Inventory tile, click "Set price" on a row, type a price but don't click Apply, then trigger any write to a routeAssistant:inventory:<HUB>-<DEST> key (e.g. visit the inventory page in another tab).
- Notes: the storage→bus bridge in tile.js still fires; renderBody just becomes a no-op while editing.

## F-9228-300: schedule-management-tile builds recent-schedule keys from index objects (REPORTED, NOT FIXED — already correct)
- Area: modules/central-hub/tiles/schedule-management-tile.js
- Severity: P1 (claimed)
- Found by: port-9228
- Status: WONTFIX
- Notes: agent report described an older revision. Current code at lines 53-58 already maps each index entry through `(e && typeof e === "object") ? e.scheduleId : e`, producing valid keys. No change needed.

## F-9228-301: schedule-panel `_handoffToAfp` references undefined `this._presets`, fallback always evaluates to null
- Area: modules/schedule-management/schedule-panel.js (_handoffToAfp)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: replaced `(this._presets || []).find(p => p)` (this._presets was never assigned anywhere) with the actual user-selected preset id `this.editingId`, plus fall-through to `this.block.presets[0].id` when nothing is selected. The hand-off now reaches AesHandoffStore.set with a real presetId and the early-return "Cannot hand off" toast no longer fires on a valid editor state.
- Repro: in overlay mode, click "Apply all in AFP →" with `this.draft.presetId` null. Pre-fix: warning toast. Post-fix: handoff record written, AFP page opens.

## F-9228-302: schedule-panel `_refreshHistory` injects user-controlled fields into innerHTML — XSS via preset name / hub
- Area: modules/schedule-management/schedule-panel.js (_refreshHistory)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: replaced the `tr.innerHTML = \`<td>...\``  template with a `mkCell(txt)` helper that creates `<td>` elements via document.createElement and assigns through textContent — neutralises any markup in `entry.presetName` (set via free-text Identity field) or `entry.hub` (free-text input). The Delete button is appended unchanged.
- Repro: create a preset named `<img src=x onerror=alert(1)>`, build a schedule, open Schedule Management → Recent schedules. Pre-fix: alert fires. Post-fix: literal text rendered.

## F-9228-303: schedule-panel `_legTextInput` instance method is dead code
- Area: modules/schedule-management/schedule-panel.js
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: removed the unused `_legTextInput` instance method. The static `_mkLegTextInput` is the only caller path (used by `static buildLegRow`). Keeping two near-identical helpers invited drift.

## F-9228-304: open-stations-modal seeded mode never renders "candidates" source chips
- Area: modules/schedule-management/open-stations-modal.js (_renderAirportRow)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: appended `"candidates"` to the `ordered` array so seeded-mode rows render the chip declared in `OpenStationsModal.SOURCE_LABELS`. Previously the chip was unreachable.
- Notes: cosmetic — selection/queueing already worked.

## F-9228-305: schedule-panel `_buildScheduleDiffSummary` reference-equality cache never hits
- Area: modules/schedule-management/schedule-panel.js (_buildScheduleDiffSummary)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: dropped the `_diffCacheLegs / _diffCacheProposed / _diffCacheResult` memo. `this.schedule.legs` and `this.draft.flights` are reloaded from chrome.storage on every render, so reference-equality compared on fresh array instances always missed. The compare itself is cheap; the dead memo was misleading and accumulated GC pressure.

## F-9228-200: UAS tile triple-reads chrome.storage per refresh — orphan loadStatus digest fetch + bare "settings" watch amplification
- Area: modules/central-hub/tiles/used-aircraft-scanner-tile.js (loadStatus, watchedStorageKeys)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: (a) loadStatus only fetches digests inside the `session && session.finishedAt` branch where the result is consumed — running-scan and no-session paths used to orphan a `chrome.storage.local.get(null)` full scan. (b) F-9228-203 fix below scopes the settings watch so unrelated module writes don't fire UAS refreshes at all.
- Notes: paired with F-9228-203.

## F-9228-201: UAS tile latest.diffCounts.firstScan unguarded — TypeError when digest carries summary without diffCounts
- Area: modules/central-hub/tiles/used-aircraft-scanner-tile.js (loadStatus)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: added `latest.diffCounts &&` guard before the `.firstScan` read. Today panel.js writes both fields atomically, but any future digest writer that sets `summary` without `diffCounts` would have crashed the loadStatus path.

## F-9228-202: Top-steal link falls back to href="#" on missing offerUrl, navigates to current page in same tab
- Area: modules/central-hub/tiles/used-aircraft-scanner-tile.js (_stealsList)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: when offerUrl is missing, render the row as a `<span>` (with a "URL unavailable" tooltip) instead of an `<a href="#">`. The same row reads identically to the surrounding clickable rows in the rail, but no longer navigates the user away on click.

## F-9228-203: UAS tile watches bare "settings" — refreshes on every settings write across the entire extension
- Area: modules/central-hub/tiles/used-aircraft-scanner-tile.js (watchedStorageKeys + mount/dispose)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: dropped the bare `"settings"` prefix from watchedStorageKeys. mount() now attaches a slice-aware chrome.storage.onChanged listener that fingerprints `settings.usedAircraftScanner` before/after and only triggers refresh when the slice itself changed. dispose() removes the listener so it doesn't leak across hub unmounts. marketScan:* watches still fire normally for scan events.

## F-9228-204: UAS tile renderBody 3rd arg collides with base-class focusFilter contract
- Area: modules/central-hub/tiles/used-aircraft-scanner-tile.js (renderBody, _activatePreset)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: renamed the 3rd parameter to `focusFilter` (matching tile.js doc + every sibling tile). _activatePreset no longer passes the merged block positionally — instead caches it on `this._pendingBlock`, which renderBody consumes once and clears. Cross-tile drill-in via focusFilter (a documented hub feature) no longer silently masquerades as a preloaded block.

## F-9228-400: World-view wave-pane click handler reads wrong arg — focus-route never emits
- Area: modules/central-hub/tiles/world-view-tile.js (wave-pane onFlightClick)
- Severity: P1
- Found by: port-9228
- Status: FIXED
- Fix: `RouteAssistantWaveOverlay.renderGantt` invokes `onFlightClick(flight, hubIata)` — the second arg is the hub IATA *string*, not a route object. The handler now reads the destination from the flight itself (`flight.destination` for outbound, `flight.origin` for inbound — chosen by comparing to the hub IATA) and emits focus-route with a real {hub, dest}. Pre-fix: `route.destination`/`route.dest` were both undefined, so the synthesised payload silently bailed at the !destIata guard in _emitFocusRoute.

## F-9228-401: World-view subscribeBus("focus-route") persists invalid hub before validating against the snapshot
- Area: modules/central-hub/tiles/world-view-tile.js (mount handler + render path)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: deferred persist into the render pipeline. The handler now sets `this._pendingPersist = code`. After `_resolveFocusedHub` returns the actual focused hub (which falls back to hubs[0] if the requested hub isn't in the snapshot), we persist only when the request matched. Otherwise the pending value is dropped. settings storage no longer carries hubs the user can't pick.

## F-9228-402: World-view storage-echo on focus-pick triggers a duplicate render
- Area: modules/central-hub/tiles/world-view-tile.js (refresh override + onPick)
- Severity: P2
- Found by: port-9228
- Status: FIXED
- Fix: added an override of `refresh()` that consumes a one-shot `_suppressNextStorageRefresh` flag. onPick (and the deferred-persist path in F-9228-401) sets the flag right before writing settings, so the inevitable storage→bus echo refresh becomes a no-op. The user's direct re-render (already kicked off at onPick) is the only one that runs. Subsequent unrelated storage changes refresh as normal.

## F-9228-403: World-view recommendations empty-state hint points at /app/info/airports/<IATA>, but that endpoint expects numeric airportId
- Area: modules/world-view/views/recommendations-pane.js
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: changed the empty-state hint from `/app/info/airports/<IATA>` to `/app/com/scheduling/<IATA>` — the IATA-keyed surface every other hint in the tile uses. The previous URL led to a dead/404 page when pasted.

## F-9228-404: World-view alliance member chip is clickable when enterpriseId is null — silent no-op on click
- Area: modules/world-view/views/recommendations-pane.js (_allianceCard members)
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: extended the member filter from `m && m.name` to `m && m.name && m.enterpriseId` so chips that would silently bail at the focus-enterprise guard are no longer rendered. recommend-alliance.js explicitly maps missing ids to null in some paths; those records now drop from the chip strip.

## F-9228-405: World-view _loadPartnerCache declares an unused `server` parameter
- Area: modules/central-hub/tiles/world-view-tile.js
- Severity: P3
- Found by: port-9228
- Status: FIXED
- Fix: dropped the unused `server` arg from `_loadPartnerCache`. bulkLoadCache is server-agnostic (records carry .server but the cache fetch enumerates by ownIds). Both call sites updated. Removes the implicit "server-scoped" contract that would have misled future callers.


## F-9227-011: Hub cash slice + accounting tile stuck on "no airline" / "no snapshots" — eager compute fires before AS navbar paints
- Area: modules/central-hub/feed/index.js (bootstrap signal at line 76); modules/central-hub/feed/cash-feed.js (pickContext at line 93)
- Severity: P1
- Found by: port-9227 (live MCP at port 9227)
- Status: FIXED
- Repro: load /app/finance/accounting/{0,1,2} once so a snapshot lands in storage (verified at chrome.storage.local under `free1FLY NYON.accounting:index`). Hard-reload /app/enterprise/dashboard. Hero strip "CASH" card shows `— no airline`. Accounting tile body shows "No accounting snapshots yet. Visit /app/finance/accounting/{0,1,2}." Click Data Flow tile → "Recompute all views" → no change. Topics list never includes `data:accounting:weekly:saved`.
- Expected: cash card shows the latest cashBalance; accounting tile lists the captured weeks. Hero stays muted only on pages where there really is no airline (login, etc).
- Actual: hub:cash:weekly slice computes ONCE eagerly at content-script-load. At that moment AES.getAirlineIdentity() returns "" (the navbar hasn't been painted yet on document_idle). pickContext returns {airline: ""}. Slice value = `{value: null, label: "no airline"}` is cached. The slice's deps are `data:accounting:weekly:saved` and `data:account:bootstrapped`. The bootstrap signal fires at +50ms unconditionally (feed/index.js:76 `setTimeout(_emitAccountBootstrapped, 50)`); if the AS navbar still isn't in the DOM at +50ms, the recompute also returns "no airline" and the slice stays stuck. Subsequent storage echoes from sister tabs DO trigger `data:accounting:weekly:saved` only when the user visits /app/finance/accounting AGAIN with the dashboard open — first-load freshness is broken.
- Notes: Two layered fixes:
  1) feed/index.js — gate `_emitAccountBootstrapped` behind a poll that waits for `AES.getAirlineIdentity()` to return non-empty (cap at ~6s with fallback). This pushes the dep-fire to a moment when context is real, so every slice that depends on `data:account:bootstrapped` recomputes correctly.
  2) cash-feed.js — the eager compute should retry pickContext for ~1.5s before settling on "no airline", so slice consumers that only react to view:hub:cash:weekly:computed don't latch a permanent muted value.


## F-9227-012: Strategy modal "Open accounting →" link points to /app/accounting/income — 404
- Area: modules/strategy/store-readiness.js (_probeRoutes empty-state action)
- Severity: P3
- Found by: port-9227 (live MCP)
- Status: FIXED
- Repro: Open the dashboard hub → click Strategy tile → OPEN STRATEGY MODAL. The Store readiness panel shows "Routes known: empty" with action "Open accounting →" pointing at https://free1.airlinesim.aero/app/accounting/income — the AS server has no such route (canonical is /app/finance/accounting/{0,1,2}).
- Expected: /app/finance/accounting/0 (Income tab), matching every other accounting reference in the codebase (snapshot-store.js, balance-scraper.js, panel.js, central-hub accounting-tile.js, command palette, shortcuts).
- Fix: changed url to "/app/finance/accounting/0".


## F-9229-001: route-launcher-tile picker onPick races the onActiveChange listener — destination column briefly shows 50 rows
- Area: modules/central-hub/tiles/route-launcher-tile.js (_renderPicker onPick + _attachListeners onActiveChange)
- Severity: P3
- Found by: port-9230 (code-static)
- Status: FIXED
- Fix: dropped the manual `await this._renderRanker()` + `this.refresh()` from the picker's onPick callback. The onActiveChange listener attached in _attachListeners already runs the same two calls when RouteLauncher.setActive synchronously fires _fireActive, so onPick's inline rerender was racing the listener's. 4cbc643.
- Repro: open the dashboard hub, expand the Route Launcher tile while no aircraft is active, click an aircraft in the left picker. Pre-fix: the destinations column briefly shows 50 rows (two copies of the top 25), settles to 25 once refresh() catches up. Post-fix: a single render of 25 rows.
- Expected: one rerender of the destinations column per pick.
- Actual: setActive synchronously calls `_fireActive`, which invokes the active-change listener (async — its body runs synchronously up to the first `await this._renderRanker()`, leaving that promise in flight). _fireActive returns; setActive resolves; onPick's `await c.setActive(sel)` resumes and starts a SECOND `await this._renderRanker()`. Both calls clear `_destHost.textContent` early, then both await the cached `AesRouteLauncherRanker.rank(...)` + `AesAfpActiveDraftStore.load(...)`, then both iterate `top` (the same 25 entries) and append rows to the now-empty host — yielding 50 rows.
- Notes: classic "do it in both the listener and inline" race. Picker onPick should fire-and-forget (call setActive only) and trust the listener. The destination row click handler at line 262-274 has a similar shape (`await launchTo(...)` triggers onStatus, then `await this._renderFeed()` runs alongside the onStatus listener's `_renderFeed`) but renderFeed is idempotent enough that the double-call is observed only as a single visible rebuild — not filed separately.

## F-9231-001: competitor-intel-hub-tile watchlist preview reads `ranked.items` but `AesCompetitorWatchlist.derive` returns a plain array — preview is permanently empty
- Area: modules/central-hub/tiles/competitor-intel-hub-tile.js (lines 213–215)
- Severity: P2
- Found by: port-9231
- Status: FIXED
- Fix: replaced `const items = (ranked && ranked.items) || []` with `const items = Array.isArray(ranked) ? ranked : []`. Dropped the redundant `limit:5` arg into derive() (the function ignored it; tile already slices to 5 below). Verified by: code-static — re-read modules/competitor-intel/watchlist.js:38–93 (`return out` is `Array<{enterpriseId, name, code, priority, threat, ageDays, reasons, ...}>`); confirmed tile's row builder reads `it.code`/`it.name`/`it.score` which are the array entry's fields. The empty-state branch now only triggers when there are zero ranked entries.
- Repro: code-static. competitor-intel-hub-tile.js:214 `const ranked = await window.AesCompetitorWatchlist.derive({server, limit: 5})`. Line 215: `const items = (ranked && ranked.items) || []`. competitor-intel/watchlist.js:38–93 `derive(args)` returns `out` (line 92), an `Array<{enterpriseId, name, code, priority, threat, ...}>` populated by `out.push(...)`. Watchlist.derive accepts no `limit` arg either. So `ranked.items` is `undefined`; the loop at 222 iterates the empty fallback; the panel always shows the "No competitors cached yet — open one to seed" empty-state regardless of how many competitor enterprises are cached on the server.
- Expected: tile's "Show watchlist (top 5)" button renders the top-5 ranked threats with `[code] name` + score.
- Actual: empty-state copy ("No competitors cached yet — open one to seed.") even when `competitorIntel:enterprise:<server>:*` records exist for the active server. Behavioural dead-end — the tile's primary in-tile "watchlist" CTA never produces output.
- Notes: shape mismatch — likely written when `derive()` was planned to return `{items: [], meta: {...}}`. Two options: (a) treat `ranked` as the array directly: `const items = Array.isArray(ranked) ? ranked : []`; (b) keep the guard but slice from `ranked` instead of `ranked.items`. Pick (a) — matches every other call site in the tree (no other reader expects `.items`). The redundant `limit:5` param into `derive()` can stay (ignored) or be dropped; keep minimal.

## F-9231-002: competitor-intel-hub-tile watchlist row reads `it.score` but the watchlist entry exposes `threat` / `priority` — every row renders "score ?"
- Area: modules/central-hub/tiles/competitor-intel-hub-tile.js (line 233)
- Severity: P3
- Found by: port-9231
- Status: FIXED
- Fix: row now reads `it.priority` (with `Number(...).toFixed(0)` since priority is an integer rank, not a fractional score). Verified by: code-static — `derive()` in modules/competitor-intel/watchlist.js:72–83 sets `priority` via Math.round(...) and sorts on it at line 86, so the displayed value matches row ordering. No new fields read; nothing else relies on the removed `score` placeholder.
- Repro: code-static. After F-9231-001, items render with names but `it.score` is undefined for every entry. competitor-intel/watchlist.js:72–83 builds `{enterpriseId, name, code, priority, threat, threatBucket, ageDays, reasons, rationale, flags}` — no `score` field. The row's right-side label is therefore always literally `score ?`.
- Expected: numeric threat score next to each rival in the top-5 watchlist preview.
- Actual: every entry displays the placeholder "score ?".
- Notes: Use `it.priority` (the ranking field, monotonically aligned with the sort order) so the displayed number matches the row order. `it.threat` is the raw 0–100 threat bucket score; either is defensible. Pick `priority` since the sort key on line 86 of watchlist.js is `priority` — surfacing the value the rows are actually sorted on is least surprising.

## F-9230-001: RouteLauncher.setActive carries stale hub/equipment when only `{aircraftId}` is passed — `focus-aircraft` bus events route to the wrong base
- Area: modules/route-launcher/controller.js (setActive, lines 61-73)
- Severity: P2
- Found by: port-9230 (code-static)
- Status: FIXED
- Fix: in setActive, branch on `sameAircraft = prev.aircraftId === payload.aircraftId`. Same id → merge as before. Different id → start `next` from `payload` only so stale `hub` / `equipment` / `typeId` drop and the AesAfpActiveDraftStore fallback at lines 64-69 refills `hub` for the new aircraft. 05415dc.
- Verified by: code-static — re-read modules/route-launcher/controller.js after edit; (1) picker still passes the full record so same-id reselection preserves registration; (2) all four `focus-aircraft` emitters carry only `{aircraftId, …}` so the cross-aircraft branch correctly resets hub; (3) `_loadPersistedActive` direct-assigns `this.active`, untouched by the change.
- Repro: code-static. `setActive` built `next = Object.assign({}, this.active || {}, payload)`. The four `focus-aircraft` emitters in the codebase (modules/fleet-hub/optimizer-drilldown.js:270, modules/central-hub/tiles/fleet-optimizer-tile.js:177, modules/central-hub/tiles/aircraft-profitability-tile.js:157, modules/strategy/fleet-command-panel.js:645) all send `{aircraftId, ...}` WITHOUT `hub`. The controller's bus listener (controller.js:42-46) forwards the payload straight into `setActive`. If `this.active` is `{aircraftId:"A", hub:"ATL", equipment:..., typeId:...}` and the bus delivers `{aircraftId:"B", registration:"D-XYZ"}`, `next` becomes `{aircraftId:"B", hub:"ATL", equipment:..., typeId:..., registration:"D-XYZ"}`. The fallback at lines 64-69 only fills `hub` when it's already missing, so the wrong-aircraft `hub` stays put. The destination ranker then renders "ATL → …" rows for an aircraft based at, say, JFK; clicking one calls `launchTo({destIata})`, which the dispatcher posts as a JFK→? flight against an ATL-cached destIata via `slot-finder.findSlot` — at minimum the wave-built leg is impossible (no aircraft at ATL) and at worst AS rejects the POST with a stale-base error. The picker path is unaffected because the picker passes the full `{aircraftId, registration, equipment, typeId, hub}` record (aircraft-picker.js:115).
- Expected: a different `aircraftId` than the current `active.aircraftId` resets stale hub/equipment/typeId so the AFP-draft fallback (or a subsequent picker resolve) re-seeds them.
- Actual: stale fields ride along; bus-driven cross-tile picks silently target the wrong base.
- Notes: minimal fix — when `payload.aircraftId !== (this.active && this.active.aircraftId)`, treat it as a fresh selection: start `next` from `payload` only, drop the merge over `this.active`. Equivalently, scrub stale fields when the id changes. Don't preserve any prior fields across an id flip.

## F-9230-002: route-launcher tile rerenders three times per setActive — listener path + storage echo + nested renderRanker call
- Area: modules/central-hub/tiles/route-launcher-tile.js (`_attachListeners` onActiveChange, `watchedStorageKeys`) + modules/route-launcher/controller.js (`_persistActive` → onChanged echo)
- Severity: P3
- Found by: port-9230 (code-static)
- Status: FIXED
- Fix: added a `refresh()` override that consumes a one-shot `_suppressNextStorageRefresh` flag (matches F-9228-402). Listener sets the flag right before `await super.refresh()`; the inevitable storage onChanged → bridgeStorage → refresh echo arrives next tick and is swallowed. Dropped the listener's redundant `await this._renderRanker()` since the immediately-following refresh re-renders the body. 3d8889a.
- Verified by: code-static — re-read modules/central-hub/tiles/route-launcher-tile.js after edit; (1) refresh override only suppresses ONCE then resets the flag, so subsequent unrelated storage writes (log update, draft change on `aircraftFlightPlan:draft:` watched prefix) still refresh normally; (2) listener uses `super.refresh()` so its own refresh isn't suppressed; (3) `await this._persistActive(next)` always resolves before `_fireActive` (controller.js:71-72), so the listener runs before chrome.storage.onChanged dispatches the echo, guaranteeing the flag is set in time.
- Repro: code-static. `RouteLauncher.setActive(payload)` does `await this._persistActive(next)` (chrome.storage.local.set on the watched key `routeLauncher:activeAircraft:<server>`) then `this._fireActive(next)`. Two refresh paths ran for one user action: (a) the tile's `onActiveChange` listener body explicitly did `await this._renderRanker(); await this.refresh()`; (b) the storage write echoes back through `AesDataBus.bridgeStorage({prefix:"routeLauncher:activeAircraft:<server>", topic:"data:storage:hub-tile:route-launcher:..."})` and the tile's bridge subscription called `this.refresh()`. The base-class `_refreshing` re-entrancy guard collapses overlapping refreshes but, depending on microtask ordering, the storage-echo refresh could land BETWEEN the listener's `_renderRanker()` and `this.refresh()` — `_refreshing` was false at that gap so the echo proceeded to a full renderBody, then the listener's own refresh ran to a second full renderBody.
- Expected: a single coalesced render per setActive — match the F-9228-402 world-view fix shape.
- Actual: up to three repaint cycles per pick; visible only on slow machines as the destination column flickers, but every active-change wastes the full ranker pipeline (rank cache hit + draft store get + 25 row builds × N).
- Notes: minimal fix — same pattern as F-9228-402 in world-view-tile. Override `refresh()` on the route-launcher tile, set a one-shot `_suppressNextStorageRefresh` flag inside the onActiveChange listener BEFORE the listener's body returns control (the storage echo is guaranteed to land soon after `_persistActive`), and bail in the override when the flag is set. The listener's own `await this.refresh()` doesn't go through the storage-echo path so it still runs. Drop the listener's redundant `await this._renderRanker()` since the immediately-following `this.refresh()` re-renders the whole body anyway — the explicit ranker call was left over from the F-9229-001 era when refresh was guarded out.

## F-9230-003: schedule-management-tile watches bare "settings" key — refreshes on every settings write across the entire extension (UAS, RA, …)
- Area: modules/central-hub/tiles/schedule-management-tile.js (watchedStorageKeys)
- Severity: P3
- Found by: port-9230 (code-static)
- Status: FIXED
- Fix: dropped `"settings"` from watchedStorageKeys, added a slice-aware chrome.storage.onChanged listener in mount() that fingerprints `settings.scheduleManagement` before/after and only refreshes on a real change. dispose() removes the listener so it doesn't leak across hub unmounts. The per-airline `scheduleManagement:` watch fires normally for generated-schedule writes. 44aeee9.
- Verified by: code-static — re-read modules/central-hub/tiles/schedule-management-tile.js after edit; (1) listener bails on cross-area writes and on absent `changes.settings`; (2) JSON fingerprint correctly skips writes that touch sibling slices (e.g. `settings.usedAircraftScanner`); (3) dispose() removes the listener, matching F-9228-203's shape; (4) bridge-storage path on the per-airline `scheduleManagement:` prefix continues to drive refreshes from ScheduleStore saves.
- Repro: code-static. `watchedStorageKeys()` returned `["settings", server + airline + "scheduleManagement:"]`. The base-class storage listener uses `k.indexOf(prefix) === 0`, so the bare `"settings"` prefix matches the GLOBAL `settings` blob — every saveArea call across the extension (UsedAircraftPresets save, RouteAssistantSettings save, conductor signals, world-view settings, …) writes that key and the tile refreshes. The tile only consumes `settings.scheduleManagement` (presets list); siblings being written are noise. Same anti-pattern as F-9228-203 (UAS tile, already fixed by port-9228 with a slice-fingerprinting onChanged listener).
- Expected: tile refreshes only when `settings.scheduleManagement` changes, plus the per-airline `scheduleManagement:*` records as today.
- Actual: every settings-write across the extension re-runs `_loadPresets()` + `_loadRecentSchedules()` + a loadStatus + a renderBody for this tile; on a populated install with concurrent writers (e.g. a UAS scan finishing while the user is editing RA settings) the tile refreshes dozens of times per minute for state it doesn't read.
- Notes: minimal fix — replicate F-9228-203's shape. Drop `"settings"` from watchedStorageKeys, override `mount()` to register a chrome.storage.onChanged listener that compares `changes.settings.oldValue.scheduleManagement` vs `changes.settings.newValue.scheduleManagement` (JSON-stringify fingerprint) and only calls `this.refresh()` on a real change. Remove the listener in `dispose()`.

## F-9230-004: route-management-tile `_loadSchedule` does a full `chrome.storage.local.get(null)` scan even when both server and airline are known — exact-key fetch is available
- Area: modules/central-hub/tiles/route-management-tile.js (`_loadSchedule`)
- Severity: P3
- Found by: port-9230 (code-static)
- Status: FIXED
- Note on commit: 4accb92 also rolled in pre-existing uncommitted improvements to this file (F-DASH-202 / F-9223-012 / F-9223-015 / F-DASH-406 / F-DASH-205 — already FIXED in findings.md but never committed to git on this branch). Those were in the working tree before my edit landed; the commit captures all of them together. Not atomic per the one-finding-per-commit rule, but unwinding would require a destructive rebase that the hard rules forbid.
- Fix: short-circuit to a single `chrome.storage.local.get([key])` for `<server><airline>schedule` when both server and airline are known on `this.ctx`. Fall back to the all-keys scan only when airline ctx is missing (cross-airline / partial-context paths). The watch already targets the same exact key (lines 23-35), so the read path now matches the watch shape.
- Verified by: code-static — re-read modules/central-hub/tiles/route-management-tile.js after edit; (1) when ctx.airline is set, the targeted key matches what content_fligthSchedule.js writes (`server + airline + 'schedule'`, content_fligthSchedule.js:121), so the lookup is exact; (2) when airline is absent, the legacy full-scan with the same filter chain (`v.type === "schedule"` + per-server filter) preserves existing behavior; (3) the function still returns `null` on miss, so loadStatus + renderBody empty-state paths are unchanged.
- Repro: code-static. `_loadSchedule` always called `await chrome.storage.local.get(null)` and walked every key looking for `v.type === "schedule" && v.server === server && (!airline || v.airline === airline)`. The key shape is fixed: `<server><airlineCode>schedule` (content_fligthSchedule.js:121). On a populated install (hundreds of UAS / RA / world-view / strategy keys), every loadStatus + every renderBody fetched the full storage blob into the page just to read one key.
- Expected: `chrome.storage.local.get([server + airline + "schedule"])` when both are known.
- Actual: full-scan even when airline is known; the data the tile actually consumes is exactly one key.

## F-9231-003: `competitorIntel:assignHandoff` is an orphan storage write — outline-panel writes the blob then navigates away with no consumer
- Area: modules/competitor-intel/outline-panel.js (lines 659–667, `_handleAssign`)
- Severity: P2
- Found by: port-9231
- Status: FIXED
- Fix: removed the `chrome.storage.local.set({"competitorIntel:assignHandoff": handoff})` block in `_handleAssign`. Replaced the misleading inline comment with one that documents that the destination-page consumer never shipped (refs H-002). The `focus-route` CentralHubBus emit immediately above remains so tiles already mounted on the same page (e.g. competitor-monitoring-tile, world-view-tile) still react when the user opens the panel without navigating. Verified by: code-static — `grep -rn competitorIntel:assignHandoff project/` post-fix returns only audit/finding entries; no reader was ever wired. Cross-domain hand-off to port-fleet-aircraft + port-9230 if the prefill UX is later desired; the writer is now gone so any new consumer must round-trip via a bus topic (per H-002 fix candidate (b)).
- Repro: code-static. `outline-panel.js:_handleAssign(r)` builds a `handoff = {source:"competitor-outline", hub, dest, counter, createdAt}` blob and writes it to `chrome.storage.local` under the key `competitorIntel:assignHandoff` immediately before `window.location.href = …` navigates away to either `/app/fleets/aircraft/<id>/0` or `/app/com/scheduling/<hub>`. `grep -rn "competitorIntel:assignHandoff" project/` returns exactly one hit — the writer at outline-panel.js:667. No reader exists in `modules/`, `*.js`, or any `content_*.js`. The storage entry persists indefinitely (no TTL, no cleanup) and is overwritten by the next assign-click.
- Expected per the inline comment ("the destination page can read the suggested route + tail and prefill its UI"): the AFP host (`modules/aircraft-flight-plan/host.js`) and/or the scheduling content script (`content_scheduling.js`) read the blob on load, prefill the suggested tail/route, and delete the key. Per `audit/pathway-storage.md` H-002 the consumer "never shipped".
- Actual: the storage write is dead code. The bus emit (`focus-route` on CentralHubBus) at line 671–674 fires but doesn't survive the navigation that happens at line 680/684 — buses are page-scoped. Tile prefill never happens. The orphan key continues to consume storage and shows up in any `chrome.storage.local.get(null)` scan.
- Notes: Per H-002 the recommended fix is (a) wire the AFP/scheduling consumer, OR (b) drop the orphan write. Wiring AFP/scheduling is out-of-domain for port-9231 (cross-domain hand-off to port-fleet-aircraft + port-9230). Minimal in-domain fix: drop the storage write — the bus emit on the same page (when the user reopens the panel from the dashboard hub the targeting tiles already react via `focus-route`/`focus-enterprise`) is the only useful side-effect; the comment that lies about a destination-page consumer needs to go too. Cross-domain hand-off note: port-fleet-aircraft + port-9230 may want to wire a consumer if the prefill UX is desirable; for now we stop the orphan write.


## F-9227-013: Strategy backtest always returns "missing-server-or-airline" — _resolveCtx uses window.AES which is undefined in content-script context
- Area: modules/central-hub/tiles/strategy-backtest-tile.js (_resolveCtx, lines 207-225)
- Severity: P1
- Found by: port-9227 (live MCP)
- Status: FIXED
- Repro: Open dashboard hub → expand Strategy Backtest tile → click RUN BACKTEST. Storage record `aesStrategy:backtest:lastRun:acct:<id>` saved with `summary.notes: ["missing-server-or-airline"]` and `weeksWithData: 0` despite the airline navbar being painted (`AES.getAirlineIdentity()` resolves to "FLY NYON.") and 1 income snapshot existing in storage.
- Expected: ctx.server = "free1" and ctx.airlineCode = "FLY NYON." flow through to `_loadBundle`, the tab key `free1FLY NYON.accounting:income:2026-05-01` is read, and the backtest produces a per-week table.
- Actual: `_resolveCtx` gates every AES call on `window.AES` (typeof check). In MV3 content scripts, top-level `class AES {}` from helpers.js does NOT attach to the isolated-world window — `window.AES` is undefined. Both helpers.js's siblings (`accounting-tile.js`, `cash-feed.js`, `aircraft-flight-plan-tile.js`, every other tile) reference bare `AES` directly. The strategy-backtest tile's `window.AES` typeof check returned false, so server/airlineCode stayed null and the engine bailed with "missing-server-or-airline".
- Fix: replaced `window.AES` with `typeof AES !== "undefined"` checks and bare `AES.getServerName()` / `AES.getAirlineIdentity()` calls — mirrors the pattern used by every other tile/feed reading AES helpers. Also dropped the spurious `await` on `AES.getAirlineIdentity()` (it's synchronous; awaiting was harmless but misleading).


## F-9228-900: drag-to-schedule's _findStripRoot returns a single lane element; coordsToWave then queries within one lane and finds 0 — every drop falls through to "Drop outside wave-strip"
- Area: modules/aircraft-flight-plan/drag-to-schedule.js (_findStripRoot lines 77-86; _arbDrop lines 114-136)
- Severity: P1
- Found by: port-9228
- Status: OPEN
- Repro: On the AFP page (`/app/fleets/aircraft/<id>/0`), enable the candidate ⋮⋮ handle, drag a candidate row over any wave-strip lane, and release. The drop returns `{ok:false, message:"Drop outside wave-strip — release on a lane to schedule."}` even though the pointer is centred on a valid lane.
- Expected: `_findStripRoot()` returns the wave-strip wrapper (the parent `wrap` div in `wave-strip.js:_renderStrip` that contains every lane), so `coordsToWave(stripRoot, clientY)` can iterate the lane siblings and pick the closest by Y midpoint.
- Actual: `_findStripRoot` does `document.querySelectorAll('[data-aes-wave-strip-lane="1"]')[0].closest("div")`. The first match is the strip lane element itself — a `<div>` (built at `wave-strip.js:305` with `dataset.aesWaveStripLane = "1"`). `closest("div")` returns the element ITSELF when it matches the selector. So `stripRoot === lanes[0]`. `coordsToWave` then runs `rootEl.querySelectorAll('[data-aes-wave-strip-lane="1"]')`, which only walks descendants — the strip's children are bands (`data-aes-wave-kind`), not other lanes. Result: empty NodeList → `best = null` → drop rejected.
- Notes: Visual outline feedback in `_arbMove` is also broken for the same reason — `coordsToWave` returns null on every move, so no lane ever gets the dashed outline. Fix is to climb to the actual common ancestor: e.g. `lanes[0].parentElement.parentElement` (lane-wrapper → wrap), or tag `wrap` with a stable selector (e.g. `data-aes-wave-strip="1"`) and match on that. Track 7-D drag-to-schedule has been silently broken since the wave-strip Phase A2 rename to `data-aes-wave-strip-lane="1"`.

## F-9228-901: Active-draft setApplied / setDismissed / setEdit lose concurrent writes — patch's appliedLegs/dismissedLegs/perLegEdits replaces existing wholesale, mirroring F-9223-002
- Area: modules/aircraft-flight-plan/active-draft-store.js (setApplied 161-168, setDismissed 170-177, setEdit 149-159; save 96-120)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: On the AFP wave-applier per-leg list, click Apply on leg 1 then immediately click Apply on leg 2 (within ~50ms). Reload the page; only one of the two seqs is present in `aircraftFlightPlan:draft:<server>:<aircraftId>.appliedLegs`.
- Expected: both seq=1 and seq=2 end up flagged, regardless of click ordering — the helper's read-modify-write should serialise or merge field-wise.
- Actual: `setApplied` does `await load()` → `Object.assign({}, cur.appliedLegs, {[seq]: ts})` → `save({appliedLegs: next})`. Two concurrent calls (T1 for seq=1, T2 for seq=2) both load the empty/old map, each builds its own `next` containing only its own seq, then both call `save`. `save` (line 112) writes `appliedLegs: Object.assign({}, p.appliedLegs || {})` — the patch's appliedLegs replaces existing.appliedLegs WHOLESALE. Whichever save's `chrome.storage.local.set` lands second wins; the other seq is lost. Identical pattern to F-9223-002 (settings.saveArea sibling-area drop).
- Notes: setEdit (perLegEdits) and setDismissed (dismissedLegs) have the same shape and the same race. Fix: either serialise via a single in-flight chain (see how F-9223-002 was patched) or do a final field-level read-merge inside `save` itself (re-read existing.appliedLegs and merge with patch.appliedLegs key-by-key).

## F-9228-902: wave-strip band drop persists arrivalStart / arrivalEnd in two separate awaited writes — first succeeds, second fails leaves preset half-updated; failure path also leaves visual band in the failed-to-persist position
- Area: modules/aircraft-flight-plan/wave-strip.js (_arbBandDrop, lines 477-509)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: Resize a wave-strip band so BOTH start and end change (e.g. drag the whole band to translate it). If the second `RouteAssistantWaveEditor.updateWaveTime` call rejects (storage quota, transient race with another tab editing the same preset, etc), the first write has already committed.
- Expected: atomic update — either both edges land or neither. On any failure, the visual band reverts to its pre-drag position so the user sees what's actually persisted.
- Actual: `_arbBandDrop` loops `for (const [field, val] of writes) await RouteAssistantWaveEditor.updateWaveTime(...)`. A throw on iteration 2 leaves iteration 1's write committed and skips `_reRender()`, so the band stays visually at `c.pendingStart/c.pendingEnd` while storage holds `{start: pendingStart, end: original}`. The next user-triggered re-render pulls the divergence into view.
- Notes: Two ways to fix — (a) use a single bulk `updateWave({arrivalStart, arrivalEnd})` API on the wave-editor so the writes round-trip as one storage.set, (b) wrap the loop in try/catch that re-renders + restores `c.origLeftPct/origWidthPct` on any error. The catch at 505-508 already returns `ok:false` to the arbiter but does no visual rollback.

## F-9228-903: wave-applier builds wave plan against ctx.currentLocationIata but candidates are filtered/scored against getActiveHub() — Plan-from override de-syncs the two halves
- Area: modules/aircraft-flight-plan/wave-applier.js (buildFromCandidates line 89; renderPreview line 135-137)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: On AFP page, set the tools-strip Plan-from input to a hub other than the aircraft's actual location (e.g. aircraft at BOS, set Plan-from to JFK). Click Generate.
- Expected: `buildCtx.hubIata` matches the hub the candidates were sourced from, so the wave plan places candidates that are reachable from the same hub it's planning around.
- Actual: `buildFromCandidates` hardcodes `hubIata: String(ctx.currentLocationIata || "").toUpperCase()` (line 89) — i.e. the aircraft's actual location. `route-candidates` reads `AesAfp.getActiveHub()` which honours the override. Result: candidates are JFK-routes (reachable from JFK) but the wave overlay places them as if they were BOS-rooted. `renderPreview` repeats the same mistake for the Gantt's `hubIata` (line 135-137).
- Notes: Should call `AesAfp.getActiveHub()` (or fall back to `ctx.currentLocationIata`) the same way every other override-aware reader does. Same fix in two places.

## F-9228-904: wave-applier _maybeConsumeHandoff sets _state._handoffConsumed=true BEFORE awaiting consume() — a failed consume permanently blocks future handoff retries on this mount
- Area: modules/aircraft-flight-plan/wave-applier.js (_maybeConsumeHandoff lines 891-933)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: Trigger a Wave Designer handoff. If `AesHandoffStore.consume(aircraftId)` throws (transient chrome.storage error, quota, listener rejection), the catch logs and returns; subsequent ctx:ready / presets-loaded transitions all short-circuit on `if (_state._handoffConsumed) return`.
- Expected: the consume failure is recoverable — next ctx:ready re-attempts consumption, since the handoff record is still in the store (consume() rejected before deleting it).
- Actual: line 907 sets `_state._handoffConsumed = true` BEFORE the try block at 908 calls `consume()`. If consume() throws, the flag is now stuck true; the user has to reload the AFP page to retry.
- Notes: Move `_state._handoffConsumed = true` to AFTER the await consume() resolves (or set it conditionally on success). Less critical because handoff is a one-shot UX flow, but the bug surface widens if other handoff consumers (port C, dnd-grid) start sharing the store.

## F-9228-905: wave-strip "+ Create starter plan" button leaves itself permanently disabled when createStarterPreset returns falsy without throwing
- Area: modules/aircraft-flight-plan/wave-strip.js (_renderCreateCTA lines 147-162)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: Force `RouteAssistantWaveEditor.createStarterPreset(hubIata)` to resolve to null (no presets-block configured, hubIata invalid downstream of where wave-strip checked). The "+ Create starter plan" button stays disabled with no toast; user must reload to retry.
- Expected: the button re-enables (matches the +wave button at line 211-217 which uses a `finally` block).
- Actual: `btn.disabled = true; try { const created = await ...; if (created) { ...; await _reRender() } } catch (e) { ...; btn.disabled = false }`. The success path re-renders the strip wholesale (button is replaced by the populated header). The catch re-enables on throw. But the silent-falsy path (no throw, no `created`) exits without re-enabling and without re-rendering, so the dead button persists.
- Notes: One-line fix — wrap the body in `try / finally { if (!created) btn.disabled = false }` or move `btn.disabled = false` into a finally that no-ops when the strip has been re-rendered.

## F-9228-906: AFP tile _loadDrafts uses prefix without trailing colon — "free1" matches "free10" / "free11" keys when multiple servers are present
- Area: modules/central-hub/tiles/aircraft-flight-plan-tile.js (_loadDrafts line 33)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: Run two AS servers in the same Chrome profile where one server name is a prefix of another (e.g. AS sometimes spawns "free1" and "free10" simultaneously). Open the central hub on the "free1" airline. The Flight Plan tile counts drafts from BOTH "free1" and "free10".
- Expected: only drafts whose server matches `ctx.server` exactly are counted/listed.
- Actual: `_loadByPrefix("aircraftFlightPlan:draft:" + server)` — note no trailing `":"`. Prefix-match returns any key starting with `aircraftFlightPlan:draft:free1` including `…draft:free10:<id>`. The same module's `watchedStorageKeys` (line 25) DOES include the trailing colon, so the watch is correctly scoped, but the load isn't.
- Notes: Mirror the `watchedStorageKeys` shape — `_loadByPrefix("aircraftFlightPlan:draft:" + server + ":")`. Single-character fix. Tile authored before AES added staging servers with overlapping prefixes; the bug is latent until two such servers coexist.

## F-9228-907: wave-applier "Apply" leg button shows toast "Leg applied: ..." — implies the leg was scheduled, but the form is only PRE-FILLED and the user must still click AS's green Submit
- Area: modules/aircraft-flight-plan/wave-applier.js (applyLeg lines 172-190)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: On the per-leg apply list under a generated wave plan, click Apply on any row. Toast reads "Leg applied: BOS → JFK · 09:30". The user reasonably believes the leg has been scheduled; in fact only the New Flight Number form has been pre-filled and the AS Submit button has not been clicked.
- Expected: toast wording matches the button title ("Pre-fill the New Flight Number form for this leg (you click Submit)") — e.g. "Leg pre-filled: BOS → JFK — click Submit below to confirm".
- Actual: line 181-184 builds `"Leg applied: " + ...` and the audit-log records `action: "leg-applied"`. Per HANDOVER §10, AFP NEVER auto-submits — "applied" is reserved for the bulk apply-batch path that goes through the background tab. Single-leg in-page CTA only fills.
- Notes: Pure copy fix; no logic change. Also worth aligning the audit ACTION_LABELS so the recent-activity timeline doesn't say "Wave leg applied" for what's really a pre-fill.

## F-9228-500: Fleet CC echoes its own settings writes — every tab click / chevron toggle triggers a redundant full repaint (load 9 storage areas + DOM rebuild)
- Area: modules/fleet-hub/command-center.js (_attachStorageListener lines 612-616, _saveActiveTab line 255-263, _saveExpandedPresets line 267-277, _setActiveTab line 1365-1369, _toggleAircraftExpansion line 3942-3948, _togglePresetExpansion line 2863-2871, _handleFocusAircraft line 684)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: Open /app/fleets, switch from Overview → Schedules tab. `_setActiveTab` calls `_render()` synchronously, then awaits `_saveActiveTab(tabId)` which writes `chrome.storage.local.set({settings: …})`. The CC's own `_storageListener` (line 615) treats `k === FleetHubCommandCenter.SETTINGS_KEY` as a `fullHit` and 200 ms later re-runs `_loadAuxData()` (9 parallel chrome.storage gets) + `_render()`. Same pattern fires on every chevron expand/collapse on the Waves and Aircraft tabs and on every `focus-aircraft` bus event.
- Expected: Tab clicks render once. Settings writes that originated from the CC don't trip the CC's own repaint (writer-echo suppression, or a marker that filters out self-writes, or excluding the SETTINGS_KEY from the listener since the only meaningful fields the CC reads from settings are SchedulePresets — already covered by the bus listener `waves:preset-updated` and the dedicated waves/preset path).
- Actual: every CC interaction → 2 renders + 1 reload of 9 aux datasets. With routines + tags + drafts loaded that's >20 chrome.storage reads per click.
- Notes: settings is also written by RouteAssistant, AFP, scheduleManagement, strategy default-settings, used-aircraft-scanner, central-hub, etc. — every one of those writes also fires a CC repaint while the user is on /app/fleets. Minimal fix: track the last settings-blob written by the CC (Set of nonces or shallow signature of the fleetCommandCenter block) and skip when changes[settings].newValue.fleetCommandCenter matches; OR drop SETTINGS_KEY from `fullHit` and rely on per-store listeners for the data the CC actually reads (presets — `settings.routeAssistant.schedulePresets`; expanded sets — never need a repaint). Same writer-echo shape that bit AesStoreCache (F-9223-003) and AesDataBus (F-9223-004); newValue inspection is the durable answer.

## F-9228-501: `_handleStrategyStorageChange` racing with itself — concurrent `_composePlan({force:true})` invocations drop _strategyComposing guard
- Area: modules/fleet-hub/command-center.js (_handleStrategyStorageChange lines 726-735, _composePlan lines 345-391, _attachBusListeners line 669, _attachStorageListener lines 624-629)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: With apply-pipeline.js firing in tight succession (a quick-apply of N decisions writes `aesStrategy:plan:applied`, `aesStrategy:learn:weights:current`, AND `aesStrategy:autoTick:last` while emitting `strategy:decision-applied` per decision), the storage listener (line 624-629) fires `_handleStrategyStorageChange()` on each of the 3 keys, AND the bus subscriber at line 669 fires it once per emit. Each call enters `_composePlan({force:true})`. The compose-busy guard at line 354 — `if (!force && this._strategyComposing) return` — explicitly bypasses on `force:true`. Both calls do `this._strategyComposing = true` (overwriting), run snapshot+score+allocate+diff in parallel, both write `this._strategyPlan`, both clear the flag in `finally`, both call `_renderStrategyStripInPlace`.
- Expected: at most one in-flight compose, with a queue/coalesce so a burst of strategy storage events results in one final compose against the latest data.
- Actual: N parallel composes, each one awaiting AesStrategy.snapshot() (a non-trivial scrape + storage read pipeline), the latest-write-wins semantics depending on Promise resolution order. The strip repaints between every transition. `this._strategyComposing` is briefly `false` between writers' `finally` blocks even while another compose is mid-flight, so a NEW non-force `_composePlan()` reading the freshness gate (line 355-357) can also slip through during the gap.
- Notes: serialise via a tail Promise (same pattern as F-9223-002's saveArea fix in modules/_shared/settings-bridge.js): keep `this._composeQueue = this._composeQueue.then(() => doCompose())` and have `_handleStrategyStorageChange` enqueue rather than invoke. Add a coalesce window (~150 ms) on the storage path so a writer that stamps 3 keys in <50 ms only triggers one compose. Bus path can stay eager but should also serialise. Pair with F-9228-500's writer-echo fix.

## F-9228-502: Storage listener watches `aircraftFlightPlan:state:` but the CC reads no state field — every AFP page interaction triggers a redundant CC repaint
- Area: modules/fleet-hub/command-center.js (_attachStorageListener line 587 + 619, _loadAuxData line 280-294)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: open /app/fleets in tab A and an AFP page (`/app/fleets/aircraft/<id>/0`) in tab B. Edit a leg in tab B → state-store writes `aircraftFlightPlan:state:<server>:<aircraftId>`. The CC's listener (line 619) marks `fullHit=true` and schedules a 200 ms repaint that re-reads scheduleIndex + presets + waveDrafts + aircraftDrafts + aircraftTags + routines + knownAccounts + strategyAux + hubManagement. None of these depend on `aircraftFlightPlan:state:*` — the rows are owned by FleetHubHost (host.js line 186), which has its own listener and pushes new rows via `update(rows)`.
- Expected: the CC repaints only when its own dependencies change. Row data flows through `update(rows)` from the host; the CC's listener doesn't need state.
- Actual: state writes from a sibling tab fan out to the CC's full reload. Combined with the host's identical listener (which also runs `_renderOnce` → `_mountOrUpdateCommandCenter(rows)` → `update(rows)` → `_loadAuxData` + `_render`), one state write produces TWO full aux reloads + TWO renders.
- Notes: drop the `afpStatePrefix` watch from the CC's listener — the host already covers state-driven row refreshes. Same applies to `afpSchedulePrefix` (CC doesn't read schedule:state, only listIndex via ScheduleStore). Keep `afpDraftPrefix` (CC's `_loadAircraftDrafts` is the consumer). Net: drop two prefixes, halve the per-state-write storage churn.

## F-9228-503: Inline routine editor's matched-count footer is stale after every filter checkbox toggle until next full repaint
- Area: modules/fleet-hub/command-center.js (_multiCheckboxList lines 3739-3751, _renderRoutineEditor lines 3650-3658)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: Aircraft Plans tab → Routines panel → click + New routine, or Edit on an existing routine. The footer shows "N aircraft would match". Toggle a hub chip in the Hubs filter — the chip flips colour (line 3747-3750 inline restyle) and the underlying `draft.aircraftFilter.hubs` is mutated, but `matchLabel` (line 3654-3658) still shows the previous N because only the chip's own DOM was touched. The label only updates after the user explicitly Saves (which causes a repaint via storage) or cancels. The acknowledged-in-comment hack (line 3744-3746: "the matched-count footer below will be stale until next render; acceptable.") understates the impact: the user uses the footer to validate the filter before saving — so the value most relevant to the decision is the one that's stale.
- Expected: matched count updates live as the user toggles filters.
- Actual: footer never updates intra-edit. User has to memorise pre-edit count and recompute mentally.
- Notes: easy fix — after `setNext(...)` in `_multiCheckboxList`, if the parent has wired a notify callback, call it. Wire it from `_renderRoutineEditor` to recompute `matchedCount` via `AircraftTagsStore.match(this._rows, this._aircraftTags.byAircraftId, draft.aircraftFilter)` and update `matchLabel.textContent` in place. No full render needed. Bonus: same wiring lets the Save button enable/disable based on `draft.name.trim().length > 0` instead of failing at save with a toast (line 3771-3774).

## F-9228-504: `_renderRoutineEditor` dereferences `window.AircraftTagsStore.STATUSES` and `window.FleetRoutinesStore.TIERS` without guards — single missing module crashes the entire Aircraft Plans tab body
- Area: modules/fleet-hub/command-center.js (_renderRoutineEditor lines 3513-3521 + 3550, _handleRoutineSave line 3651)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: code-static. The Aircraft Plans tab renders the Routines panel unconditionally (line 3823). The "+ New routine" button creates a `_renderRoutineEditor(null)`. That function reads `window.AircraftTagsStore.STATUSES` (line 3513), `window.AircraftTagsStore.STATUS_LABELS` (line 3516), `window.AircraftTagsStore.ROLES` (line 3518), `window.FleetRoutinesStore.TIERS` (line 3550), `window.AircraftTagsStore.match` (line 3651) — each unguarded. If either store fails to load (manifest reorder, content-script load error, future code-split), the throw propagates out of `_renderBody` and the tab body fails to render. Other tabs are unaffected because `_renderBody` switches on `_activeTab`, but the user's persisted activeTab could be "aircraft" and they'd land on a broken tab.
- Expected: graceful degrade — show "(routine editor unavailable on this page)" the way `_renderPresetEditor` (line 2896-2903) does for missing `RouteAssistantWaveEditor`.
- Actual: throws; the catch in the chain is too far up to surface a useful message.
- Notes: wrap each store reference in a `typeof window.X !== "undefined"` check OR early-return from `_renderRoutineEditor` with the editor-unavailable card when either dependency is missing. Mirror the pattern at line 2655 (`canCreate = typeof RouteAssistantWaveEditor !== "undefined" && typeof SchedulePresets !== "undefined"`).

## F-9228-505: `_setApplyRoutineLabel` finds the in-flight Apply button by walking ALL "Apply…" buttons — bulk-apply / strategy-apply running concurrently corrupts each other's labels
- Area: modules/fleet-hub/command-center.js (_setApplyRoutineLabel lines 3414-3433, _renderRoutineRow lines 3296-3309, _renderOverviewBulkBar line 1553, _renderStrategyDecisionsInline line 1124)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: on the Aircraft Plans tab, click Apply on a routine that matches several aircraft (so the in-flight callback fires) AND simultaneously, on the Overview tab, click "Apply N selected" on the strategy decisions block (cross-tab scenario: open two CC instances, or trigger before the first finishes). The orchestrator's `onAircraftStart` / `onAircraftDone` callbacks call `_setApplyRoutineLabel(routine.id, label)`, which walks every button in `bodyEl` whose text starts with "Apply"|"Applying"|"Applied" and rewrites the FIRST disabled match. The strategy-apply button (line 1124, label "Apply N selected") and the bulk-pending button (line 1553, label "Apply all pending …") both match the regex `/^Apply/`. Whichever happens to be disabled at the moment of the orchestrator's onAircraftStart callback gets its label overwritten with "Applying X / Y…".
- Expected: the orchestrator's progress label updates the originating routine's button only.
- Actual: progress label can land on an unrelated button. Comment at line 3424-3429 acknowledges the approximation ("Most users apply one routine at a time") but the fragility is real once the user has multiple Apply* buttons in flight.
- Notes: tag the routine row's apply button with a data attribute on render — `applyBtn.dataset.routineId = routine.id` — then use `bodyEl.querySelector('[data-routine-id="' + id + '"]')` for an O(1) lookup. Same fix shape as `_findBulkButton` (line 1668-1678) only this one needs an actual marker rather than a regex sniff.

## F-9228-507: Inline strategy "Apply N selected" runs `AesStrategy.apply` directly — bypasses the canApply tier check used to disable the button, so a tier flip mid-render lets a stale-disabled-by-paint state still apply
- Area: modules/fleet-hub/command-center.js (_renderStrategyDecisionsInline lines 1124-1134, _applyStrategyDecisionsInline lines 1215-1239, _strategyHighConfDecisions lines 425-448)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: Overview tab → strategy block → tier shows "apply-on-confirm" → check 2 decisions → button enables. Now the user opens Strategy Settings in another tab and flips tier to "preview-only". The settings storage write fires `_handleStrategyStorageChange` → `_loadStrategyAux` updates `this._strategySettings` → `_renderStrategyStripInPlace` repaints THE STRIP only — the inline decisions block (rendered by `_renderOverview`) is NOT repainted by the strip-only code path. The pre-existing rendered Apply button still has its enabled state from before the tier flip. Click → `_applyStrategyDecisionsInline` calls `AesStrategy.apply` regardless of `previewOnly`.
- Expected: the in-place repaint covers the inline decisions block too, OR `_applyStrategyDecisionsInline` re-checks `previewOnly` (or `AesStrategySettings.canApply`) before calling apply().
- Actual: tier flip race — in-flight apply runs against the user's prior tier setting.
- Notes: cheap fix — at the top of `_applyStrategyDecisionsInline`, re-evaluate `tier === "preview-only"` and bail. Also consider triggering a body repaint (not just strip) when tier changes, since the inline decision rows' visibility logic depends on tier (the high-conf filter uses `canApply(s, domain)` indirectly via `_strategyHighConfDecisions` line 430-433).

## F-9228-508: `_handleFocusAircraft` repaints synchronously without `_loadAuxData` — a focus-aircraft event arriving before the CC's first aux load lands shows an empty Aircraft Plans tab
- Area: modules/fleet-hub/command-center.js (_handleFocusAircraft lines 678-699, mount lines 162-172)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: rare race — `mount()` does `await this._loadAuxData()` before `_render()` (line 163-164), so the first-paint case is fine. But: a `focus-aircraft` bus event can arrive AFTER mount completes; subsequent handler `_handleFocusAircraft` calls `_render()` directly without re-loading aux. If the user has been on the page for >1 minute and chrome.storage has been cleared (e.g. from an extension reset), the in-memory caches (`_aircraftDrafts`, `_aircraftTags`) are stale — the focus jump lands on an empty/wrong-state aircraft row.
- Expected: same pre-render guarantees as `_scheduleRepaint` (line 737-745) — `_loadAuxData()` then `_render()`.
- Actual: synchronous render with cached data. If the cache is stale, the focused row's tags/legs/preset all show "—".
- Notes: change `this._render()` at line 685 / 706 to `this._scheduleRepaint()` (or an immediate `await this._loadAuxData(); this._render()` before the rAF scroll). The 200 ms debounce is harmless here. Also consider: the strict scroll-into-view via `requestAnimationFrame` happens AFTER the synchronous render completes; if a `_scheduleRepaint`-driven render lands later, the rAF scroll has already happened against the older DOM. Move the rAF inside the post-render path so the scroll matches the rendered DOM.

## F-9228-509: Wave editor "Open full editor ▸" link uses `/app/com/scheduling/<HUB><HUB>` for "(global)" presets — produces an invalid URL `/app/com/scheduling/`
- Area: modules/fleet-hub/command-center.js (_renderPresetRow line 2847-2856, _renderPresetEditor line 2918-2928)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: Waves tab → if a preset has no `hub` field, it falls into the synthetic "(global)" bucket (line 2596). Its row's "Open ▸" link sets `open.href = "/app/com/scheduling/" + (hub === "(global)" ? "" : hub + hub)` — for global, that's literally `/app/com/scheduling/` (trailing slash, no IATA pair). Clicking opens AS's scheduling-without-hub page which 404s or redirects. Same shape on the editor's "Open full editor ▸" link (line 2920).
- Expected: either hide the Open links for (global) presets, or send the user to a hub picker (`/app/com/scheduling/`) intentionally with a friendly note, or to the AS fleet schedule grid.
- Actual: dead URL on click. The user thinks the link is broken.
- Notes: presets without a hub are uncommon (every starter preset created via RouteAssistantWaveEditor.createStarterPreset takes a hub, but legacy data + custom imports could land here). Either skip the Open links when hub === "(global)" or replace href with the hub-picker landing page. Trivial fix.

## F-9231-201: spec-resolver dead-wires when it parses ahead of host.js (load-order race)
- Area: modules/aircraft-flight-plan/spec-resolver.js (IIFE bottom, formerly lines 275–279)
- Severity: P1
- Found by: port-9231 (code-static)
- Status: FIXED
- Repro: Open `/app/fleets/aircraft/<id>/0`. Two content_scripts blocks match the URL: block-A (manifest.json:718–754) loads `spec-resolver.js` at line 729 BEFORE block-B (832–1025) loads `host.js` at line 895. spec-resolver.js's IIFE bottom guards `if (window.AesAfp && window.AesAfp.bus)` — at parse time block-B hasn't executed, so `window.AesAfp` is undefined and the listener is silently skipped. Later host.js mounts and emits `ctx:ready`, but spec-resolver never subscribed — `AesAfpSpecResolver.last` stays null, `route-candidates._runCompute` paints the "Waiting for aircraft spec…" placeholder forever, and Slice C / wave-applier / preview-panel all stall waiting for a `spec:resolved` event that never fires.
- Expected: spec-resolver attaches its `ctx:ready` listener regardless of cross-block load order, mirroring the `_attach` retry pattern at route-candidates.js:1337–1341 + the race-safe one-shot at :1352–1353.
- Actual: zero subscription, zero spec resolution, candidates pane permanently stuck on "Slice B is still resolving the aircraft type" — exactly the symptom in the user's screenshot for N001LL · Boeing 737-800 BGW · Hub JFK.
- Notes: Fix replaces the IIFE-bottom guard with `_attach()` that polls `setTimeout(_attach, 50)` until `window.AesAfp.bus` exists, then subscribes to `ctx:ready` AND fires a one-shot `resolveForCurrent()` if `AesAfp.ctx` is already populated (covers the case where mount() ran during the retry interval before our listener attached). Verified via `node --check`. Commit 2f62e6b.

## F-9231-202: route-candidates says "still resolving" when spec resolution attempted and produced null
- Area: modules/aircraft-flight-plan/route-candidates.js (_runCompute lines 1282–1287) + spec-resolver.js (`_emit` + public API)
- Severity: P3
- Found by: port-9231 (code-static)
- Status: FIXED
- Repro: Pre-F-9231-201 this was masked because the listener never fired at all. Post-201, when `spec:resolved` fires with `{spec: null}` (typeId not in fleet store, no `aircraftsType?id=` link on page, AS fetch failed), route-candidates checks `AesAfpSpecResolver.last`, finds null, and renders "Waiting for aircraft spec… Slice B is still resolving the aircraft type. Candidates will appear after spec:resolved fires." — but spec:resolved already fired. The user is told to wait for an event that has already happened.
- Expected: distinguish "still resolving" (resolver not yet attempted) from "resolved-as-null" (resolver attempted, no spec) and route the latter to the Spec card's Retry button.
- Actual: identical placeholder copy in both states; the user has no signal that the Retry button is the way out.
- Notes: Fix adds `AesAfpSpecResolver.attempted` flag (set in `_emit` regardless of payload) and uses it in route-candidates to swap the placeholder text once an attempt has completed. Verified via `node --check`. Commit e2c74c2.

## F-9231-203: wave-applier status copies the same misleading "Waiting for aircraft spec…" wording
- Area: modules/aircraft-flight-plan/wave-applier.js (_statusMessage lines 503–504)
- Severity: P3
- Found by: port-9231 (code-static)
- Status: FIXED
- Repro: Same scenario as F-9231-202 — `spec:resolved` fires with `{spec: null}`, `_state.spec` stays null, and the wave-applier panel's status strip says "Waiting for aircraft spec…" indefinitely. Identical confusion: the user thinks they need to wait, when in fact they need to click Retry on the Spec card.
- Expected: when the resolver has attempted at least once, switch the status to a warn-toned "Aircraft spec unavailable — see the Spec card." so the path forward is unambiguous.
- Actual: dead-end "Waiting…" message with no escape hatch.
- Notes: Fix consults `window.AesAfpSpecResolver.attempted` (introduced in F-9231-202) and switches both text and tone. Verified via `node --check`. Commit b799604.

## F-9231-204: Decision Context "Fill FROM + TO…" while TO field shows "IATA" — WORKS
- Area: modules/aircraft-flight-plan/flight-studio/panel.js (_renderSidebarFor line 362; _mkIataInput line 2980)
- Severity: P3 (user-confusion only)
- Found by: port-9231 (code-static)
- Status: WONTFIX (working-as-designed)
- Repro: Aircraft Flight Plan → Flight Studio. FROM=CVG, TO field appears to show "IATA". Decision Context pane says "Fill FROM + TO to see decision context." even though TO looks populated.
- Expected: the renderer reads `legs[0].destination` (from `_spec`, not from raw input). `_spec` is updated only when the user types into the input — `_mkIataInput` (line 2978–2988) attaches an "input" listener that only mutates state on real keystrokes. The "IATA" string the user sees is the HTML `<input placeholder="IATA">` attribute (line 2980), not a value. So `legs[0].destination = null`, `_asIata(null) = null`, the regex check at line 362 fails, and the "Fill FROM + TO" placeholder is the correct rendering.
- Actual: working as designed.
- Notes: Could improve UX by giving the placeholder a less letter-like sample (e.g. "—") so users don't read it as a typed value, but that's polish, not a bug. No code change shipped. Logged as WORKS in claims.log.

## F-9232-001: AFP Recent activity preview reads global timeline instead of per-aircraft ring — sidebar shows form-fills from a different aircraft / hub
- Area: modules/aircraft-flight-plan/audit-log.js (renderSlot, line 324)
- Severity: P2
- Found by: port-9232 (code-static)
- Status: FIXED
- Fix: scoped `renderSlot()`'s recent fetch to `getForAircraft(ctx.server, ctx.aircraftId, 10)` when ctx has both fields, falling back to `getRecent(10)` only when ctx hasn't resolved an aircraftId yet (first paint before mount). The per-aircraft ring is written atomically alongside the global timeline by `add()` so the data is always present; the legacy global read surfaced cross-aircraft noise. c589c36.
- Repro: code-static. The class exposes both `getRecent(n)` (reads `aircraftFlightPlan:auditLog`, the global 200-entry timeline shared across every aircraft + every hub) and `getForAircraft(server, aircraftId, n)` (reads the per-aircraft 50-entry ring, written atomically alongside the global on every `add()`). The sidebar slot renderer (renderSlot at line 319) lives in the per-aircraft `.col-md-2` panel and is repainted on every `ctx:ready`, every bus event that triggers `logAndEmit`, and the Clear button. Pre-fix it called `getRecent(10)` unconditionally — so loading aircraft N001LL at JFK while the user's previous session form-filled DEL→BOM / DEL→HYD on a *different* aircraft (still inside the global 200-entry window) renders three "Form filled · DEL→BOM"-style entries against an aircraft that has never been at DEL. The "Recent activity:" copy is literally next to "AES Route Assistant · N001LL · Boeing 737-800 BGW · Hub: JFK"; the data shown disagrees with the surrounding header.
- Expected: the sidebar's "Recent activity" preview is per-aircraft — only entries logged with the same `(server, aircraftId)` as the page's aircraft are visible. The global timeline is still useful (e.g. as a future cross-aircraft "What did I do this session" view) but it doesn't belong in the sidebar that's clearly scoped to one aircraft.
- Actual: every aircraft's sidebar shows the same 10 most-recent entries from the global ring, regardless of which aircraft those entries were logged against. The bug is silent — entries lack a per-row "(N001LL)" tag so users can't even tell the data is foreign.
- Notes: minimal fix — flip the read. The Clear button already calls `clear()` which wipes the global + every per-aircraft ring, so post-fix it still has the right semantics ("clear all activity"). The fmtRoute helper renders "DEL→BOM" from `e.hub` / `e.dest`, so cross-aircraft entries that share the same (hub, dest) shape were indistinguishable from current-aircraft entries — another reason the bug went unnoticed.

## F-9232-002: AFP auto-build draft persists flights without metadata — WEEKLY / SCORE cells read "—" after page reload even though the values are deterministic from the persisted build
- Area: modules/aircraft-flight-plan/auto-scheduler/allocator.js (lines 558–566), modules/aircraft-flight-plan/active-draft-store.js (_emptyState / load / save / setFlights), modules/aircraft-flight-plan/auto-scheduler/preview-panel.js (`_loadDraft`, lines 1782–1793)
- Severity: P2
- Found by: port-9232 (code-static)
- Status: FIXED
- Fix: widened `AesAfpActiveDraftStore` schema with a `metadata` field (default null), threaded `build.metadata` through `setFlights` in the allocator's persist path, and consumed the persisted metadata in preview-panel `_loadDraft`'s "adopt persisted flights" branch (replacing the hard-coded `metadata: null`). All other `setFlights` callers (schedule-management/schedule-panel, fleet-hub/routine-orchestrator + command-center, wave-applier) keep working without passing metadata — the field is optional and defaults to null. 4dcd9ca.
- Repro: code-static. `allocator.js:540-556` builds `build.metadata = {algo, totalScore, budgetUsedHours, budgetMaxHours, generatedAt, ...}`. `allocator.js:558-571` persists with `setFlights({hub, presetId, flights})` — metadata is dropped on the floor. `active-draft-store.js` schema (pre-fix) doesn't have a metadata field at all; `_emptyState`, `load`, `save`, `setFlights` all silently swallow any `metadata` field passed by a caller. On page reload, `preview-panel.js:1771-1796 _loadDraft` adopts the persisted flights into a synthetic `_state.lastBuild` with `metadata: null`. `_renderSummary`'s WEEKLY cell reads `meta.budgetUsedHours` (line 234) and SCORE cell reads `meta.totalScore` (line 258) — both fall to the `"—"` branch when metadata is null, even though the values were known and computed when persistence ran.
- Expected: a returning user sees LEGS=N, WEEKLY=Xh, SCORE=Y (matching what they had before the reload). Re-running auto-build is unnecessary just to repaint the summary header.
- Actual: LEGS populates correctly (read from `flights.length`), but WEEKLY and SCORE both show "—" until the user clicks "Re-run auto-build" — even though the same flights are sitting in the draft store and would yield the same metadata.
- Notes: F-9232-002 is the metadata-loss bug. It's not the cold-paint state the screenshot captured (that's working-as-designed when no flights exist), but it's the very next visible glitch any user who has ever auto-built will hit on reload. Per the user's spec: "Is the renderer initialised with placeholder dashes that never get replaced because the consumer doesn't subscribe?" — the consumer subscribes correctly; the SOURCE was missing data. After this fix, when the auto-scheduler re-runs and persists, metadata round-trips through chrome.storage; older drafts (written before this commit) load with `metadata: null` and continue to show "—" until the user re-runs once — that's an intentional graceful migration (no schema-version stamp needed because the field is purely additive).

## F-9231-004: alliance-tile loadStatus reports INFO badge + "Alliance · 0 members" when the airline is not in any alliance — should be MUTED with a "join" hint
- Area: modules/central-hub/tiles/alliance-tile.js (loadStatus, lines 75–95)
- Severity: P3
- Found by: port-9231
- Status: FIXED
- Fix: short-circuit `loadStatus` to MUTED + "Not in an alliance — visit /app/alliance to join." when the cached record has zero members. Keeps the INFO/WARN paths for genuine memberships and matches the MUTED envelope of the no-record branch. Verified by: code-static — re-read AllianceOverviewScraper._parseOverviewHtml; the no-`table.members` branch writes `members:[]` so the new guard fires exactly on the not-in-alliance state.
- Repro: code-static. AllianceOverviewScraper successfully fetches `/app/alliance` for an airline not currently in an alliance — the page renders an alternate H1 (e.g. "Alliance" or "No alliance") but no `table.members`. The scraper writes `{allianceName: <whatever h1 text>, members: [], pendingApplications: 0, parserNotes: "no_members_table"}`. loadStatus then runs the populated branch (line 85+): `badge = "0"`, `badgeKind = KIND.INFO`, `summary = "<H1 text> · 0 members"`. Visually identical to "your alliance has zero members" rather than "you are not in an alliance".
- Expected: when the cached record has zero members, the tile shows MUTED (matching the no-record case at line 78–84) with copy that points the user at the join-alliance flow on /app/alliance.
- Actual: INFO-styled "Alliance · 0 members" looks like a normal but extremely-empty alliance.
- Notes: minimal fix — collapse the empty-members branch into the no-record path. After loading rec, if `members.length === 0` AND `parserNotes` does not indicate a transient `fetch_failed`, return the same MUTED envelope as the no-record case but with a slightly different summary ("Not in an alliance — visit /app/alliance to join."). Keep the INFO/WARN paths for genuine alliance memberships. The body's empty-members branch already says "No members listed." — also worth tweaking, but loadStatus is the more visible gap because the badge sticks in the hero strip even when the body is collapsed.

## F-9231-005: unified-settings competitor-intel adapter calls `AesCompetitorOutlinePanel.open()` but the panel exposes `show()` — CTA is permanently disabled
- Area: modules/unified-settings/adapters/competitor-intel.js (lines 27, 30)
- Severity: P2
- Found by: port-9231
- Status: FIXED
- Fix: replaced both `.open` references with `.show({})`. The disabled-button guard now correctly tracks the real surface. Verified by: code-static — `grep -n "AesCompetitorOutlinePanel" /private/tmp/aes-claude-1/project/modules/` returns `.show()` everywhere; `.open()` previously only appeared in the broken adapter and now appears nowhere. Adapter probe + click both line up with the actual class method.
- Repro: code-static. unified-settings adapter probes `typeof window.AesCompetitorOutlinePanel.open === "function"` (line 27) and binds `window.AesCompetitorOutlinePanel.open()` (line 30). The panel class only exposes `static async show(opts)` (modules/competitor-intel/outline-panel.js:23). `.open` is undefined on the class even when the module is fully loaded. So `hasPanel` is always `false`, the action button is rendered disabled, and the H.notice "Competitor Outline not loaded on this page. Navigate to a hub or markets page first." misdirects users who ARE on a page where the panel is loaded.
- Expected: when the panel module is loaded, the "Open Competitor Outline →" CTA is enabled and clicking it calls `AesCompetitorOutlinePanel.show({})` (the real entry point used everywhere else — competitor-outline-tile.js:44, hub-shell.js, change-log-modal). The notice fires only when the module truly isn't on `window`.
- Actual: CTA always disabled. The user is told the panel isn't loaded even when it is, with no way to recover from within the unified-settings shell.
- Notes: minimal fix — replace both `.open` references with `.show`. The adapter is a "discovery surface" per its docstring; misdirecting the user to a non-existent state defeats the purpose. Verified by: every other call site in the tree (competitor-outline-tile.js, change-log-launcher.js, etc.) calls `.show({server: ...})` — `show()` is the real public surface.

<!-- port-9228 fleet-tile interaction audit (F-9228-700+) -->
<!-- Audited 7 tiles / ~38 interactive elements; 7 bugs found. -->

## F-9228-700: dna-drift-tile leaks four CentralHubBus handlers — `_wireBus` drops disposers, base-class `_busDisposers` sees nothing
- Area: modules/central-hub/tiles/dna-drift-tile.js (lines 46-56, `_wireBus`)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: code-static. `_wireBus` calls `window.CentralHubBus.on("canopy:dna-changed", handler)` four times (dna-changed, dna-override-changed, roles-changed, affiliations-changed) and discards every disposer that `on()` returns. The base class's `subscribeBus()` (modules/central-hub/tile.js:68-72) is the contract path that pushes disposers onto `_busDisposers`; `dispose()` (tile.js:504-509) iterates only that array. Result: when the shell unmounts the tile (or any future SPA-style remount triggers dispose) the four handlers stay attached to CentralHubBus. Each subsequent `canopy:*` emit re-fires the orphaned handler, which calls `this.refresh()` on a disposed tile (root === null, so the early return at tile.js:346 saves the throw, but the closure pins the dead instance forever — a slow leak across remounts).
- Expected: bus subscriptions go through `this.subscribeBus(event, handler)` so `dispose()` cleans them up. Mirrors how strategy-tile.js:60-70 and weekly-review-tile.js:59 handle the same pattern.
- Actual: handlers leak. On a single mount the leak is invisible; on any flow that disposes-and-remounts the tile, each cycle adds four more orphan listeners.
- Notes: One-line fix — replace each `window.CentralHubBus.on(event, handler)` with `this.subscribeBus(event, handler)`. The `try/catch` and `if (window.CentralHubBus)` guards become redundant (subscribeBus is defensive) but can stay. The `_wired` boolean is then orthogonal to leak prevention — it just avoids double-subscribing across `_compute()` calls within one mount.

## F-9228-701: family-tile "Open →" button is a no-op when expanded — silent failure of the chrome's primary CTA
- Area: modules/central-hub/tiles/family-tile.js (lines 41-46, `openHandler`)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: open the dashboard hub. Family tile is collapsed → click "Open →" in the chrome action cluster → tile expands. Click "Open →" again (now expanded) → nothing happens. The handler is `if (!this.expanded) this.toggle()`; when already expanded the function returns silently with no UI feedback, no toast, no nav. Per the audit guidance "Open button must navigate somewhere sensible matching the tile's name" — Family is supposed to lead to a Family Briefing modal (per the inline comment "M7 family briefing modal lands later").
- Expected: Open lands the user on a Family-specific surface. Until M7 ships, the button should at minimum fall back to a sensible target (e.g. `AesCanopyRolesSettingsPage.open()`, which the body already exposes as "Open Kin Roles →"), or be hidden via `openHref()=null && openHandler()=null` (base class skips the button — see tile.js:284) so the chrome doesn't promise an action it can't deliver.
- Actual: clicking Open in the expanded state does nothing. The toggle button right next to it (▾/▸) handles expand/collapse; Open is a redundant duplicate of the toggle in the collapsed case and dead in the expanded case.
- Notes: Two reasonable fixes: (a) drop `openHandler` entirely until M7 lands so the base class hides the chrome button (matches the cleaner shape used by service-profile-tile etc.); (b) point at the kin-roles page until the briefing modal exists: `if (window.AesCanopyRolesSettingsPage) AesCanopyRolesSettingsPage.open()`. Pick (a) — the body's "Open Kin Roles →" / "Re-detect kin" actions cover the user need; chrome promising "Open" without a destination is worse than no button.

## F-9228-702: route-launcher-tile loadStatus reads `K.GOOD` (undefined) — successful launches show INFO badge instead of OK
- Area: modules/central-hub/tiles/route-launcher-tile.js (loadStatus, line 69)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: code-static. The badge-kind ladder at line 67-70 reads `last && last.status === "created" ? K.GOOD || K.INFO : K.INFO`. `K` is `window.CentralHubStatusBadges.KIND` whose entries (status-badges.js:17-24) are `DEFAULT|INFO|OK|WARN|ALERT|MUTED`. There is no `GOOD`. `K.GOOD` is `undefined`, so the ternary always falls through to `K.INFO` (cobalt) for the "created" branch — even when a launch just succeeded. The submit-dispatcher (route-launcher/submit-dispatcher.js:65) writes `status: "created"` on success.
- Expected: a freshly-created flight surfaces a green/OK badge on the tile chrome (matching the "created" semantic — moss in the design tokens). The author clearly intended `K.OK` per the `|| K.INFO` defensive fallback shape.
- Actual: every successful launch and every in-flight/queued state both render as cobalt (INFO). The visual signal that distinguishes "just landed a successful submission" from "loading…" is lost. The "failed" branch correctly resolves to `K.WARN`.
- Notes: One-character fix — `K.OK` instead of `K.GOOD`. The `|| K.INFO` fallback can stay (defensive) or be dropped; OK is always defined. Pair with: the same KIND.OK semantic is used correctly elsewhere (fleet-hub-tile loadStatus line 92, fleet-command-tile line 94).

## F-9228-703: aircraft-profitability-tile watches bare `<server>` prefix — refreshes on every storage write to the server (F-9223-015 pattern)
- Area: modules/central-hub/tiles/aircraft-profitability-tile.js (watchedStorageKeys, lines 26-33)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: code-static. `watchedStorageKeys` returns `[server]` (the bare server prefix) when ctx.server is set. The base class's storage listener (tile.js:427-435) matches via `k.indexOf(p) === 0` — i.e. ANY storage key whose first chars equal the server prefix triggers refresh. On a populated `free1` profile that means writes to `free1FLYNYONaircraftFleet`, `free1FLYNYONaccounting:income:*`, `free1FLYNYONcompetitorMonitoring:*`, `free1FLYNYONscheduleManagement:*`, `free1FLYNYONwaveOverlay:*`, etc. ALL fire `aircraft-profitability-tile.refresh()`. Each refresh runs `_loadFleetWithProfit` → `chrome.storage.local.get(null)` (full-storage scan; line 40). On a 5MB profile this is ~10–80ms of jank per unrelated write. F-9223-015 documented this exact shape as the cross-tile refresh storm and fixed fleet-hub / accounting / competitor-monitoring; F-DASH-102 narrowed only the *empty*-server case for this tile but left the bare-server prefix in place.
- Expected: prefix narrowed to the actual writers this tile cares about. The legacy fleet-key shape `<server><airline>aircraftFleet` cannot be exact-prefix matched; a suffix-matching listener in `mount()` mirroring fleet-command-tile.js:49-59 is the cleanest fix. The companion profit key shape `<server>aircraftFlights<id>` can use a tighter prefix `[server + "aircraftFlights"]`.
- Actual: every server-prefixed write thrashes a full-scan refresh. Worst when accounting-tile lands a fresh income/balance/master record — that single write fires ~3-5 prefix-matching tile refreshes across the dashboard, each doing its own `get(null)`.
- Notes: Two-line fix in the same shape as fleet-command-tile — replace the bare `[server]` with `[server + "aircraftFlights"]` and add a `mount()` override that installs a chrome.storage.onChanged listener firing only for keys ending in `"aircraftFleet"`. Remove on `dispose()`. Captures both writers without the cross-cutting fan-out.

## F-9228-704: fleet-optimizer-tile watches `"settings.strategy"` — never matches any storage key
- Area: modules/central-hub/tiles/fleet-optimizer-tile.js (watchedStorageKeys, line 33)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: code-static. The tile returns `["settings", "settings.strategy", "aircraftFlightPlan"]` (with `server` unshifted when present). AesSettings's storage shape (modules/_shared/settings-bridge.js:9-14, 47) is a single key `chrome.storage.local["settings"] = {strategy: {...}, routeAssistant: {...}, …}` — there is NO storage key called `settings.strategy`. The base class's `indexOf(prefix) === 0` matcher needs an actual key prefix; nothing in the codebase ever writes a key beginning with `settings.strategy`. The entry is dead. The `"settings"` prefix already covers fleet-optimizer-settings writes (which all live under the `settings` blob via `AesSettings.saveArea("strategy", …)`).
- Expected: drop `"settings.strategy"` (covered by `"settings"`) — or replace it with a real key prefix if the author intended something specific. `AesStrategyFleetOptimizerSettings.load()` (strategy/fleet-optimizer-settings.js:185) reads from the `settings` blob, so no other key applies.
- Actual: dead prefix. Harmless (it just never matches) but signals confusion about the storage shape and adds a per-event indexOf cost for no benefit.
- Notes: One-line fix — remove the `"settings.strategy"` element. While there: `"settings"` itself is over-broad — it fires on every settings save across the entire extension (every adapter tab in unified-settings, every routeAssistant write, etc). Cheap narrow: gate the recompute behind a settings-area diff. Out-of-scope for the P3 dead-prefix fix; flag here for future.

## F-9228-705: fleet-command-tile pivot button passes `{}` as ctx but base-class re-renders use `this.ctx` — drift between manual and base-class re-render paths
- Area: modules/central-hub/tiles/fleet-command-tile.js (_renderPivotControls, line 173)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: code-static. Pivot button click handler at line 171-174 calls `this.renderBody({}, host)`. Every other re-render path (base class `_renderBodySafe` at tile.js:401-409, the tile's own `loadStatus` flow) runs `this.renderBody(this.ctx, this.bodyEl, focusFilter)` — i.e. the actual `this.ctx` plus the `bodyEl` plus an optional focusFilter. Today fleet-command-tile.renderBody ignores `ctx` (the function uses `this._lastView` and `T = window.AESTokens`), so the `{}` swap is benign. But the contract is that `ctx` carries `{server, airline}` — any future enhancement that reads `ctx.server` from inside renderBody (e.g. a "this account's tails are highlighted" overlay) silently sees an empty string when entered via pivot click vs the real server when entered any other way.
- Expected: pivot click does the same thing every other re-render path does — call `this._renderBodySafe()` (which threads `this.ctx` and respects the focusFilter contract) or at minimum `this.renderBody(this.ctx, host)`.
- Actual: `this.renderBody({}, host)`. Subtle latent contract drift: the function is currently ctx-agnostic so behavior is correct, but the call shape differs from the base-class invariant in a way that quietly breaks any future ctx-aware enhancement.
- Notes: One-line fix — `this.renderBody(this.ctx, host)`. Or, the more idiomatic shape used elsewhere: `this._renderBodySafe()` (it already targets `this.bodyEl` which equals `host` here since the pivot host is the body root). Either preserves the contract.

## F-9228-706: fleet-optimizer-tile candidate-row click never opens the optimizer drilldown — emits focus-aircraft only, leaves user with cross-tile scroll instead of detail
- Area: modules/central-hub/tiles/fleet-optimizer-tile.js (_renderCandidateColumn, lines 175-179)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: code-static. The Top stressors / Top slack tails columns render one row per candidate. Each row's click handler emits ONLY `CentralHubBus.emit("focus-aircraft", {aircraftId})`. The bus consumers for `focus-aircraft` are fleet-hub-tile (line 37), route-launcher-tile (line 76), and the RouteLauncher controller (controller.js:42-46) — all of which scroll the user to a DIFFERENT tile and pivot it to a single-aircraft view. Neither is the Fleet Optimizer drilldown panel (`AesFleetHubOptimizerDrilldown`, modules/fleet-hub/optimizer-drilldown.js) — which is exactly what the tile's footer "Open drill-down →" button at line 207-214 opens. Clicking a stressor name takes the user away from the optimizer context.
- Expected: clicking a candidate row opens the optimizer drilldown filtered to that tail, OR at least also expands the tile so the candidate's `r.suggestion` (currently only a `title` tooltip) becomes visible inline. Per `left.title = r.suggestion || ""` the suggestion text exists but is hidden behind a hover tooltip — discoverable only by serendipity.
- Actual: row click side-effects: (a) fleet-hub-tile scrolls into view + expands + pins focus banner to "#<aircraftId>"; (b) route-launcher-tile scrolls + expands; (c) RouteLauncher controller calls `setActive({aircraftId})` (now post-F-9230-001 fix). Nothing in the optimizer surface itself reacts. The user has to scroll back up and click "Open drill-down →" manually.
- Notes: Two reasonable fixes: (a) row click also calls `AesFleetHubOptimizerDrilldown.open({summary, focusAircraftId: r.aircraftId})` (the drilldown's `open()` accepts an opts object — extend it to honour the focus); (b) emit a new `focus-optimizer-aircraft` event on the bus that the drilldown subscribes to. Pick (a) — single in-tile click → richer in-tile detail, no cross-tile scroll.

## F-9228-800: scheduled-decorator silently no-ops on cold /1 visits — manifest /1* block omits aircraft-flight-plan/schedule-store.js
- Area: manifest.json lines 700-718 (/1* block) + modules/aircraft-flights/scheduled-decorator.js (lines 119, 142)
- Severity: P1
- Found by: port-9228
- Status: OPEN
- Repro: cold-load `https://*.airlinesim.aero/app/fleets/aircraft/<id>/1` (new tab, never visited /0 first). Open DevTools → `typeof AesAfpScheduleStore` returns `"undefined"`. No "scheduled" pill appears on any flight row, even though the persisted Schedule for that aircraft contains matching `flightNumberId`s. Storage has `<server>aesAfp:schedule:<aircraftId>` populated; the page just never reads it.
- Expected: pills paint on cold /1 load, mirroring the post-/0-navigation behavior shown in CLAUDE/https-:free1.airlinesim.aero:app:fleets:aircraft:22094:1?40.html (saved snapshot has `data-aes-scheduled-pill="1"` on every row).
- Actual: the /1* manifest entry (line 700-714) loads `scheduled-decorator.js` but NOT `modules/aircraft-flight-plan/schedule-store.js`. The decorator's two integration points both bail when the store is missing: `_loadAndDecorate` line 119 (`if (typeof AesAfpScheduleStore === "undefined") return`) and `_attachStorageListener` line 142 (same guard). With no listener attached, even a subsequent /0-side write doesn't trigger a repaint. Pills only appear when a user navigates /0 → /1 within the same tab (SPA fragment) so `window.AesAfpScheduleStore` survives from the /0 manifest's load — the path the captured HTML was saved through. A direct visit, page reload on /1, or /1 → other-page → /1 → reload all break the pills silently. Other consumers (route-assistant/panel.js, schedule-management/schedule-panel.js) hit the same guard but have alternate render paths; this surface has no fallback.
- Notes: High confidence — pure manifest omission. Fix: add `modules/aircraft-flight-plan/schedule-store.js` to the /1* block's `js` array (between line 707's `flight-data.js` and line 708's `maintenance-store.js`). Same pattern as the /0* block (line 837) which loads it. The decorator's runtime guards can stay as defense-in-depth.

## F-9228-801: content_aircraftFlights.js relies solely on `window.load` — extension reload mid-session leaves the page un-augmented
- Area: content_aircraftFlights.js (line 10)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: open `/app/fleets/aircraft/<id>/1` → wait for page to finish loading → reload the extension via chrome://extensions → AS page is now stale: no Profit/Loss + Extracted columns, no AES Statistics panel, no augmented InfoPanel rows.
- Expected: re-injected content script detects post-load state (`document.readyState === "complete"`) and runs the bootstrap flow immediately, mirroring the readyState-aware pattern used by `scheduled-decorator.js` lines 191-195.
- Actual: line 10 `window.addEventListener("load", ...)` is the only entrypoint. After `load` has fired, re-attaching the listener never invokes the callback. `aircraftFlightsTab`, `infoPanel`, `statisticsPanel`, the table column inserts, the saveData write, and `displayFlightProfit` all remain unexecuted. Combined with F-9228-800's silent dead-decorator path, post-extension-reload breakage is total.
- Notes: Trivial fix — gate on `document.readyState`: `if (document.readyState === "complete") init(); else window.addEventListener("load", init, {once:true})`. The bootstrap is async (awaits `getData`) so the wrapper needs to be a named function. Same shape as the prior fix landed in scheduled-decorator's `_init` block.

## F-9228-802: ExtractionButton class never wires its callback — every button created via this class is a no-op
- Area: modules/aircraft-flights/extraction-button.js (lines 1-25), call sites in content_aircraftFlights.js:84-91
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: in DevTools on `/app/fleets/aircraft/<id>/1`, run `addButtons()` (the function is in scope; only its call at content_aircraftFlights.js:23 is commented out). Two buttons render in the action bar. Click either — nothing happens, no console output, no popup, no extraction. No event listener exists on the elements.
- Expected: clicking "Extract finished flight profit" / "Extract all flight profit" runs the corresponding extraction flow (the `extractAllFlightProfit("finished")` / `extractAllFlightProfit("all")` path used by the legacy `createButtonOld` jQuery buttons).
- Actual: ExtractionButton's constructor stores `label`, `callback`, `className`, `type` as own props and calls `#createElement()` to build the `<button>`. `#createElement` (lines 17-24) sets `type`, `innerText`, `className` — and never registers a click handler. There's no `this.element.addEventListener("click", this.callback)` anywhere. Worse, the call sites at content_aircraftFlights.js:86-87 pass `{extractFinished: true}` / `{extractAll: true}` as the `callback` parameter — these are config objects, not functions, so even if a listener were wired the click would throw "callback is not a function". The class is currently dead because `addButtons()` is commented out (content_aircraftFlights.js:22, 93-102), but the file is loaded into every `/1` page and any caller (console, future re-enable) gets a silently broken UI.
- Notes: High confidence — pure missing wiring. Fix candidates: (a) accept a function as the second arg, register `button.addEventListener("click", callback)` inside `#createElement`; (b) at call sites, replace the config objects with `() => extractAllFlightProfit("finished")` / `() => extractAllFlightProfit("all")`. The `createButtonOld` jQuery path at content_aircraftFlights.js:232-257 already does the click-wired version — `ExtractionButton` was meant to replace it but the wiring step was never finished. Either delete the class+caller entirely or finish the migration.

## F-9228-803: extractAllFlightProfit() opens flights via window.open in a tight loop — popup-blocker silently kills all but the first
- Area: content_aircraftFlights.js (lines 245-271)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: load `/app/fleets/aircraft/<id>/1` for a tail with 10+ finished flights and default Chrome popup-blocker settings. Click "Extract all flight profit/loss" or "Extract finished flight profit/loss". Observe: 1 tab opens (sometimes 2), the rest are silently blocked, the user-visible warning span reads "Please reload page after all flight info pages open" — but those pages will never open. Both buttons are now hidden so the user has no way to retry without a page reload.
- Expected: either (a) batch the opens with a small delay so each consumes its own user-gesture credit, (b) detect blocked popups (`window.open` returns `null`) and surface a "X of Y blocked — allow popups for this site" banner, OR (c) replace the multi-popup pattern with an in-page `fetch` of `/action/info/flight?id=<id>` and parse the response.
- Actual: `extractAllFlightProfit` (line 259-271) iterates `aircraftFlightData.flights` synchronously and calls `window.open(url, "_blank")` for each one. Browsers credit a single user-gesture for at most 1-2 popups; the remainder return `null` without throwing. The return value is discarded so the failure is invisible. Meanwhile `createButtonOld`'s click handler hides BOTH buttons (line 246-247, 253-254) and sets the warning span text — there's no recovery path; the user sees a calm message saying it worked. F-9228-802's class-based replacement is also dead so this is the only live extraction surface.
- Notes: Medium-high confidence — `window.open` in a loop is a well-known popup-blocker antipattern. Quickest fix: check `if (!window.open(...)) blocked++` and after the loop replace the warning text with `${blocked} of ${total} popups blocked — allow popups for this domain and click again`. Better fix: switch to background-fetch via `chrome.runtime.sendMessage` — the flightInfo page is already content-script-instrumented (manifest line 691-698) so the data could be scraped programmatically.

## F-9228-804: getFlights() throws hard when a non-XFER row lacks a `/action/info/flight?id=` link — entire bootstrap flow halts
- Area: content_aircraftFlights.js (lines 362-366)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: load `/app/fleets/aircraft/<id>/1` for any tail whose flights table includes a row with a non-"XFER" flight number cell but no `<a href="...action/info/flight?id=...">` link (observed historically on freshly-cancelled or partially-cancelled flights, and on aircraft whose schedules were torn down between the page render and DOM hydration). `getFlights` throws `Error: getFlights(): no valid value for url`; `aircraftFlightsTab.constructor` propagates the throw, so `new AircraftFlightsTab()` at content_aircraftFlights.js:11 fails, leaving `aircraftFlightsTab` undefined. Subsequent `buildUI` / `getData` calls crash on `aircraftFlightsTab.getAircraftInfo()` etc. The page is left with no augmentation at all.
- Expected: gracefully skip rows with no info link (treat them like XFER) — same pattern as the `flightNumber === "XFER" || flightNumber === undefined` continue at line 359. The audit comment at lines 369-376 already acknowledges defensive parsing is needed for `id=` extraction; the absent-link case deserves the same treatment.
- Actual: line 365's `throw new Error("getFlights(): no valid value for url")` is followed by a dead `continue` — the throw exits the function (and the constructor). No try/catch around the call site at line 317 (`this.#data.flights = this.getFlights()`). The dead `continue` suggests the original author intended `console.warn(...) ; continue` but committed the wrong control-flow.
- Notes: Medium confidence — depends on AS template state at scrape time. Trivial fix: replace `throw new Error(...) continue` with `console.warn("[AES /1] row missing flight info link, skipping"); continue`. Also tighten the `idMatch` parse a few lines down (line 374) which currently sets `flight.id = null` on parse failure — the pushed flight then breaks downstream `flight.id === storedFlight.flightId` joins.

## F-9228-805: InfoPanel / AircraftStatisticsPanel / updateTable mount non-idempotently — a second `buildUI()` call duplicates DOM
- Area: modules/aircraft-flights/info-panel.js (lines 7-13, 24-28); modules/aircraft-flights/aircraft-statistics-panel.js (lines 6-16, 18-21); content_aircraftFlights.js (updateTable lines 42-68)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: on `/app/fleets/aircraft/<id>/1`, in DevTools call `buildUI()` a second time (the function is module-scoped). Observe: a second pair of "ID" / "Registration" rows appended to the Aircraft Info tbody, a second "Statistics" `<h3>` + panel inserted after the .as-panel, AND `updateTable` adds a SECOND "Profit/Loss" + "Extracted" header pair plus duplicate cells in every row.
- Expected: idempotent mount — re-running detects the existing AES-augmented rows / panel / cells and either no-ops or replaces. Same shape as the `[HOST_ATTR]` lookup pattern in modules/aircraft-flight-plan/host.js:1070-1075 (`if (!sidebarPanel) { build } else { reuse }`), and the `_stripExistingPills` pattern in scheduled-decorator.js:94-97.
- Actual: `InfoPanel.constructor` unconditionally appends two new `<tr>` to the existing tbody (line 24-28). `AircraftStatisticsPanel.#addToPage` unconditionally calls `target.after(this.container)` (line 19-21). `updateTable` unconditionally appends new headers and per-row cells. None tag with `data-aes-*` markers; none check for existing augmentation. Currently latent because the bootstrap fires from the once-only `window.load` event — but if the F-9228-801 fix introduces a `readyState === "complete"` re-entry path, or if a Wicket fragment re-render triggers re-init, all three surfaces will duplicate.
- Notes: Medium confidence as a latent bug, surfaces immediately if F-9228-801 is fixed naively. Fix: tag the AES-added rows / containers / cells with `data-aes-*` markers; the constructors / updateTable check for the markers first and reuse-or-rebuild.

## F-9228-806: saveData() write ignores chrome.runtime.lastError — quota / serialization failures are silent
- Area: content_aircraftFlights.js (lines 222-224)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: artificially fill chrome.storage.local to near the 5MB MV3 quota, then load `/app/fleets/aircraft/<id>/1`. The `chrome.storage.local.set({[key]: saveData}, function() {})` call's callback never reads `chrome.runtime.lastError`; the write fails silently. The Statistics panel + InfoPanel still render this session's scrape, but the persisted `<server>aircraftFlights<aircraftId>` blob remains stale and downstream consumers (yield-snapshot, fleet-roster aggregations per F-9223-013) read the old slice.
- Expected: callback checks `chrome.runtime.lastError` and either retries with a smaller payload (drop `flights[]` envelope first per the slice 4 comment at lines 207-220), surfaces a console warn, or sets a `aesAircraftFlights:saveErrors:<server>:<aircraftId>` breadcrumb so a tile/diagnostic can show "save failed".
- Actual: line 222-224 — `chrome.storage.local.set({[key]: saveData}, function() {})` — the callback is empty. No error path. Quota-exceeded errors are routinely the dominant failure mode for chrome.storage in long-running AS sessions.
- Notes: Low-medium severity (latent until quota pressure). Fix: `chrome.storage.local.set({[key]: saveData}, () => { if (chrome.runtime.lastError) console.warn("[AES /1] saveData failed:", chrome.runtime.lastError.message); });`.

## F-9228-807: aircraft-flights surface keys are not account-scoped — `<server>aircraftFlights<aircraftId>` and `<server>flightInfo<id>` collide across airlines
- Area: content_aircraftFlights.js (lines 146-157 getKeys, line 194 saveData key); content_flightInfo.js:17 (the writer)
- Severity: P2
- Found by: port-9228
- Status: OPEN
- Repro: own two airlines on the same AS server (e.g. free1) under the same browser profile. After fleet transfers or in shared-fleet sims, two airlines may both reference aircraft id 1234. Visit airline A's `/app/fleets/aircraft/1234/1` — saves to `free1aircraftFlights1234`. Switch enterprise to airline B and visit B's `/app/fleets/aircraft/1234/1` — overwrites A's persisted profit/finished-flight/registration data. Same shape across servers if the same id maps to different aircraft.
- Expected: namespace by account — `<server>:<airline>:aircraftFlights:<aircraftId>` or use the existing `AesAccountScopedKey` helper (modules/_shared/account-scoped-key.js). Same shape that F-9223-012 already flagged for the fleet-roster / accounting / competitor-monitoring tiles.
- Actual: `saveData` (line 194) builds `key = aircraftFlightData.server + aircraftFlightData.type + aircraftFlightData.aircraftId` — three concatenated strings, no airline component. `getKeys` (line 146-157) builds `${server}flightInfo${id}` — same shape. The flightInfo writer at content_flightInfo.js:17 uses the same triple-concat.
- Notes: Same root cause as F-9223-012; this finding documents the specific aircraft-flights surface so the remediation sweep covers it. Migration path is the same shim used elsewhere — read legacy key first, write to namespaced key.

## F-9228-808: aircraftFlightsTab bootstrap reads DOM at `window.load` with no Wicket-render race guard — partial-render zeros persisted state
- Area: content_aircraftFlights.js (lines 10-16, 294-403); helpers.js (getServerDate line 156)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: on a slow connection or under devtools-throttled "Slow 3G", load `/app/fleets/aircraft/<id>/1`. If Wicket finishes painting `.as-page-aircraft h1 span` or the flights tbody AFTER `load` fires, the bootstrap runs against a half-rendered DOM: `getAircraftInfo` returns `{registration: undefined, equipment: undefined}`; `getFlights` returns []. saveData then persists `finishedFlights:0, totalFlights:0, profit:0, flights:[]` — overwriting the previous good scrape. Secondary concern: helpers.js:156's `getServerDate` does `document.querySelector(".as-navbar-bottom span:has(.fa-clock-o)").innerText` and throws if length != 12 (line 162) — same race risk.
- Expected: bootstrap waits for the table + h1 spans + navbar before scraping, mirroring `scheduled-decorator.js`'s `_waitForTable` (lines 170-181, polls every 100ms for ~5s). The decorator's pattern was added precisely because "Wicket sometimes streams the flights table asynchronously" (line 167-168 comment).
- Actual: line 10 fires bootstrap on `load`; constructor at line 302 calls `this.getAircraftInfo()` immediately; line 351's `getFlights()` calls `document.querySelector("#aircraft-flight-instances-table")` and immediately `table.querySelectorAll("tbody tr")` — no retry, no readiness check. Empty-flights overwrites good prior data with a "no flights" state. `getServerDate` throw propagates through `Aircraft.constructor` (aircraft-data.js:21) and aborts the whole bootstrap.
- Notes: Medium-low confidence — depends on AS streaming behavior. Fix: copy `_waitForTable` into a shared helper or call it from a unified bootstrap. At minimum, guard against empty `flights[]` overwriting persisted state — if scrape returns 0 flights but prior persisted state had >0, skip the saveData write.

## F-9228-809: getTotalProfit() blindly accesses `value.data.money.CM5.Total` — partial / older flightInfo schemas crash the bootstrap
- Area: content_aircraftFlights.js (lines 175-191, 285)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: have a stored `<server>flightInfo<id>` blob produced by an older (pre-CM5) version of content_flightInfo.js — `flight.data.money` exists but lacks `CM5`, OR `flight.data` exists but `money` itself was the old-shape `{revenue, costs, profit}`. Visit `/app/fleets/aircraft/<id>/1`. `getTotalProfit` at line 178 reads `value.data.money.CM5.Total` → throws `TypeError: Cannot read properties of undefined (reading 'Total')`. The throw aborts `processData` → `displayData` never runs → no UI augmentation.
- Expected: defensive read — `const cm5 = value.data?.money?.CM5?.Total; if (typeof cm5 !== "number") return; profit += cm5; profitFlights++;`. Tolerate older schemas, log once, and either skip the affected flight or attempt schema migration.
- Actual: chained property access with no optional chaining. Single bad blob taints the whole tail. The `if (value.data)` guard at line 177 only covers the data-missing case, not the data-present-but-malformed case. `displayFlightProfit` line 285 has the same antipattern (`flight.data.money.CM5.Total`). Combined with F-9228-808 (zeroed save) and F-9228-806 (silent quota write), one bad flightInfo entry can corrupt the persisted state for a tail.
- Notes: Trivial fix — optional chaining + numeric-type guard. Also worth a one-time console warning when an older-shape blob is observed.

## F-9228-810: createButtonOld bases its XFER skip on the FIRST `td a` of the entire table — single-XFER row at top hides extraction buttons even when other flights are valid
- Area: content_aircraftFlights.js (lines 232-237)
- Severity: P3
- Found by: port-9228
- Status: OPEN
- Repro: an aircraft with a mix of XFER + regular flights where the XFER row happens to be first in the table. The check `cell?.innerText.trim() === "XFER"` at line 235 returns true → `return` skips the `createButtonOld` UI. User sees no "Extract all flight profit/loss" / "Extract finished flight profit/loss" buttons even though the tail has perfectly extractable finished flights.
- Expected: skip the buttons only when the table has NO non-XFER rows, e.g. check `aircraftFlightData.flights.length === 0` (after `getFlights` already filters XFER/undefined out at line 359). Or: only skip when EVERY row is XFER.
- Actual: line 233 selects `#aircraft-flight-instances-table td a` (first match in document order), reads `.innerText.trim()` and bails if equal to "XFER". This is brittle — it samples one cell only, and the original intent was probably "is this an XFER-only tail?" but the implementation samples the first link cell instead. Plus the selector grabs ANY `<a>` in any cell of any row, not specifically the flight-number cell.
- Notes: Low-impact (rare layout) but real — XFER rows can land first depending on AS sort. Fix: replace the sample with `if (!aircraftFlightData.flights.length) return;` so the buttons appear iff there's at least one non-XFER flight.
