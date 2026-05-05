"use strict";

/**
 * AES Customization — chord capture widget.
 *
 * Replaces a binding cell in the keybindings ledger with a temporary
 * keystroke recorder. Records the first non-modifier key, then waits
 * up to PREFIX_TIMEOUT_MS for a second key (so vim-style chords like
 * `g d` can be recorded). Esc cancels.
 *
 * Returns the captured chord via the onCommit callback. Caller is
 * responsible for conflict-checking and persisting via the store.
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESStudioChordCapture) return;

    const PREFIX_TIMEOUT_MS = 800;
    const SINGLE_KEYS = ["/", "?", "Esc"];

    /**
     * Begin capture inside the given cell. Returns a function that, if
     * called, aborts capture and returns the cell to its prior state.
     *
     * @param {HTMLElement} cell
     * @param {(chord: string) => void} onCommit
     * @returns {() => void} abort
     */
    function begin(cell, onCommit) {
        const T = window.AESTokens || {};
        const priorText = cell.textContent;
        const priorStyle = cell.getAttribute("style") || "";

        cell.style.cssText = (priorStyle ? priorStyle + ";" : "") + [
            "background:" + (T.color ? T.color.oxide : "#2B2520"),
            "color:" + (T.color ? T.color.bone : "#F4F1EA"),
            "outline:" + (T.geom ? T.geom.bw3 : "3px") + " solid " + (T.color ? T.color.rust : "#B8472A"),
            "outline-offset:-3px"
        ].join(";");
        cell.textContent = "↓ press keys (Esc to cancel)";

        let firstKey = null;
        let timer = null;

        function abort() {
            cleanup();
            cell.textContent = priorText;
            cell.setAttribute("style", priorStyle);
        }

        function commit(chord) {
            cleanup();
            cell.setAttribute("style", priorStyle);
            onCommit(chord);
        }

        function cleanup() {
            if (timer) { clearTimeout(timer); timer = null; }
            document.removeEventListener("keydown", onKey, true);
        }

        function onKey(e) {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                abort();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            const k = e.key;

            if (firstKey === null) {
                if (SINGLE_KEYS.indexOf(k) !== -1) {
                    e.preventDefault();
                    e.stopPropagation();
                    commit(k);
                    return;
                }
                if (k.length === 1 && /^[a-z0-9]$/i.test(k)) {
                    firstKey = k.toLowerCase();
                    cell.textContent = firstKey + " _";
                    e.preventDefault();
                    e.stopPropagation();
                    timer = setTimeout(function () { commit(firstKey); }, PREFIX_TIMEOUT_MS);
                    return;
                }
                return;
            }

            // Have first key — looking for the second
            if (k.length === 1 && /^[a-z0-9]$/i.test(k)) {
                e.preventDefault();
                e.stopPropagation();
                if (timer) { clearTimeout(timer); timer = null; }
                commit(firstKey + " " + k.toLowerCase());
            }
        }

        document.addEventListener("keydown", onKey, true);
        return abort;
    }

    window.AESStudioChordCapture = { begin };
})();
