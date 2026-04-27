"use strict";

// QOL: click any AS$ figure, IATA code, or registration in a table cell
// to copy it to the clipboard. Single delegated listener on document.body.
//
// Trigger: a TD or TH whose textContent (trimmed) matches one of:
//   - currency: optional sign + digits + optional thousand groups + optional decimals
//   - 3-letter uppercase IATA code
//   - 4–8 char alphanumeric/hyphen aircraft registration (fleet pages only)
//
// Skips: cells inside an <a>/<button>, inside form controls, or already
// inside an AES-injected panel that has its own click semantics.

(function () {
    if (window.AESSiteSkin && !window.AESSiteSkin.isEnabled()) return;

    // Currency: optional sign, optional currency prefix (AS$/$/€/£), and
    // then either thousand-grouped digits or 3+ ungrouped digits. "5" or
    // "12" don't trigger — too noisy. "AS$ 1500", "1,234,567.89", "$120"
    // all do.
    const RE_CURRENCY = /^-?(?:[A-Z]{1,3}\$|\$|€|£)?\s?-?(?:\d{1,3}(?:[,\s]\d{3})+|\d{3,})(?:\.\d+)?$/;
    const RE_IATA = /^[A-Z]{3}$/;
    const RE_REG = /^[A-Z0-9]{1,3}-[A-Z0-9]{2,5}$/;

    function isCopyable(cell) {
        if (cell.closest("a, button, [role='button'], input, textarea, select, [contenteditable='true']")) return false;
        if (cell.closest("#aes-route-assistant")) return false;
        if (cell.closest(".aes-panel")) return false;
        const text = (cell.textContent || "").trim();
        if (!text) return false;
        if (cell.children.length > 1) return false;
        if (cell.children.length === 1 && cell.firstElementChild.children.length) return false;
        if (RE_CURRENCY.test(text)) return true;
        if (RE_IATA.test(text)) return true;
        // Aircraft regs only on the fleet page family
        const pageKind = document.body && document.body.dataset.aesPage;
        if (pageKind === "fleet" && RE_REG.test(text)) return true;
        return false;
    }

    function flashToast(message) {
        let host = document.querySelector(".aes-skin-toast-host");
        if (!host) {
            host = document.createElement("div");
            host.className = "aes-toast-host aes-skin-toast-host";
            document.body.append(host);
        }
        const t = document.createElement("div");
        t.className = "aes-toast aes-toast--success";
        t.style.opacity = "0";
        const body = document.createElement("div");
        body.className = "aes-toast__body";
        const msg = document.createElement("div");
        msg.className = "aes-toast__msg";
        msg.textContent = message;
        body.append(msg);
        t.append(body);
        host.append(t);
        requestAnimationFrame(() => { t.style.opacity = "1"; });
        setTimeout(() => {
            t.style.opacity = "0";
            setTimeout(() => t.remove(), 200);
        }, 1400);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {
            // Fallback for older browsers / restricted contexts
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-1000px;top:-1000px;";
            document.body.append(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
            ta.remove();
            return ok;
        }
    }

    // Decorate cells on hover so the user knows what's copyable. We don't
    // pre-mark every cell on render (cheap mouseover is fine).
    document.addEventListener("mouseover", function (e) {
        const cell = e.target.closest("td, th");
        if (!cell) return;
        if (cell.dataset.aesSkinCopyChecked === "1") return;
        cell.dataset.aesSkinCopyChecked = "1";
        if (isCopyable(cell)) cell.classList.add("aes-skin-copyable");
    }, true);

    document.addEventListener("click", async function (e) {
        const cell = e.target.closest("td, th");
        if (!cell) return;
        if (!cell.classList.contains("aes-skin-copyable") && !isCopyable(cell)) return;
        const text = (cell.textContent || "").trim();
        if (!text) return;
        const ok = await copyText(text);
        if (ok) flashToast(`COPIED: ${text}`);
    }, true);
})();
