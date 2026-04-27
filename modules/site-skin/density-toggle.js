"use strict";

// QOL: density toggle. The bootstrap script already applies
// data-aes-density to <html>; this module just listens for Shift+D and
// flips the storage value. A storage change handler in bootstrap.js
// re-applies the data attribute so the CSS rules pick it up immediately.

(function () {
    if (window.AESSiteSkin && !window.AESSiteSkin.isEnabled()) return;

    function isTypingTarget(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    document.addEventListener("keydown", function (e) {
        if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key !== "D" && e.key !== "d") return;
        if (isTypingTarget(e.target)) return;
        if (window.AESSiteSkin && typeof window.AESSiteSkin.cycleDensity === "function") {
            window.AESSiteSkin.cycleDensity();
            e.preventDefault();
        }
    }, true);
})();
