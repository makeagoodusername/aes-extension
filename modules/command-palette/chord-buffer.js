"use strict";

/**
 * AES Command Palette — chord buffer.
 *
 * Adds Vim-style key-sequence chords (e.g. "g g", "g s", "g c") on top
 * of the existing single-key palette/customization shortcuts. The buffer
 * captures up to 1.2s of letter input outside typing targets; if the
 * accumulated sequence matches a registered chord, the chord's run()
 * fires and the buffer resets. Otherwise it falls through.
 *
 * Importantly, this does NOT hijack one-key handlers — the chord buffer
 * only acts on the SECOND key of a sequence. The first key is captured
 * speculatively but if no chord registered with that prefix exists, the
 * buffer immediately drops it. Single-key bindings keep working.
 *
 * Public API:
 *   register({id, sequence: ["g","s"], scope?, run, available?}) → unregister
 *   registered() → Array<{id, sequence, scope}>
 */
(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.AESPaletteChords) return;

    const TIMEOUT_MS = 1200;

    const chords = new Map();   // id → {id, sequence:[lower-cased keys], scope, run, available}
    let buffer = [];            // recent keys (lower-cased)
    let bufferTimer = null;

    function clearBuffer() {
        buffer = [];
        if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    }

    function isTypingTarget(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function isPlainKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (typeof e.key !== "string" || e.key.length !== 1) return false;
        return /[a-zA-Z0-9]/.test(e.key);
    }

    function chordForBuffer() {
        if (!buffer.length) return null;
        for (const c of chords.values()) {
            if (c.sequence.length !== buffer.length) continue;
            let match = true;
            for (let i = 0; i < buffer.length; i++) {
                if (c.sequence[i] !== buffer[i]) { match = false; break; }
            }
            if (match) {
                try { if (c.available && !c.available()) continue; }
                catch (_) { continue; }
                return c;
            }
        }
        return null;
    }

    function bufferIsPrefix() {
        if (!buffer.length) return false;
        for (const c of chords.values()) {
            if (c.sequence.length <= buffer.length) continue;
            let match = true;
            for (let i = 0; i < buffer.length; i++) {
                if (c.sequence[i] !== buffer[i]) { match = false; break; }
            }
            if (match) return true;
        }
        return false;
    }

    function onKeyDown(e) {
        if (isTypingTarget(e.target)) { clearBuffer(); return; }
        if (e.key === "Escape") { clearBuffer(); return; }
        if (!isPlainKey(e)) {
            // Modifier or non-letter — drop buffer to avoid surprising chord fires.
            if (buffer.length) clearBuffer();
            return;
        }
        const k = e.key.toLowerCase();
        buffer.push(k);

        const matched = chordForBuffer();
        if (matched) {
            e.preventDefault();
            e.stopPropagation();
            clearBuffer();
            try {
                const r = matched.run();
                if (r && typeof r.then === "function") r.catch(function (err) {
                    console && console.warn && console.warn("[AES chord]", matched.id, err);
                });
            } catch (err) {
                console && console.warn && console.warn("[AES chord]", matched.id, err);
            }
            return;
        }

        if (bufferIsPrefix()) {
            // Wait for the next key. Reset the timer.
            if (bufferTimer) clearTimeout(bufferTimer);
            bufferTimer = setTimeout(clearBuffer, TIMEOUT_MS);
            return;
        }

        // Not a known chord prefix — drop the buffer so single-key handlers stay clean.
        clearBuffer();
    }

    function register(spec) {
        if (!spec || !Array.isArray(spec.sequence) || !spec.sequence.length) return function () {};
        if (typeof spec.run !== "function") return function () {};
        const seq = spec.sequence.map(function (k) { return String(k).toLowerCase(); });
        const id = String(spec.id || ("chord:" + seq.join(":")));
        const entry = {
            id: id,
            sequence: seq,
            scope: spec.scope || "any",
            run: spec.run,
            available: typeof spec.available === "function" ? spec.available : null
        };
        chords.set(id, entry);
        return function unregister() {
            const cur = chords.get(id);
            if (cur === entry) chords.delete(id);
        };
    }

    function registered() {
        return Array.from(chords.values()).map(function (c) {
            return {id: c.id, sequence: c.sequence.slice(), scope: c.scope};
        });
    }

    document.addEventListener("keydown", onKeyDown, true);

    window.AESPaletteChords = {register, registered};
})();
