"use strict";

/**
 * Capture login credentials from the Airlinesim login page.
 */
(function() {
    if (window.__aesLoginBooted) return;
    window.__aesLoginBooted = true;

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, { once: true });
        } else {
            fn();
        }
    }

    ready(() => {

        // Check if we need to auto-fill
        chrome.runtime.sendMessage({ type: "aes:vault:get-prepared-login" }, (resp) => {
            if (resp && resp.username && resp.password) {
                let userField = document.querySelector("input[name='_username']") || document.querySelector("input[type='text']") || document.querySelector("input[type='email']");
                let passField = document.querySelector("input[name='_password']") || document.querySelector("input[type='password']");
                let submitBtn = document.querySelector("button[type='submit']") || document.querySelector("input[type='submit']");

                if (userField && passField) {
                    userField.value = resp.username;
                    passField.value = resp.password;

                    // Trigger events to simulate user input
                    userField.dispatchEvent(new Event('input', { bubbles: true }));
                    passField.dispatchEvent(new Event('input', { bubbles: true }));

                    if (submitBtn) {
                        setTimeout(() => submitBtn.click(), 500);
                    } else {
                        const form = document.querySelector("form");
                        if (form) setTimeout(() => form.submit(), 500);
                    }
                }
            }
        });

        const form = document.querySelector("form");
        if (!form) return;

        form.addEventListener("submit", () => {
            let userField = form.querySelector("input[name='_username']") || form.querySelector("input[type='text']") || form.querySelector("input[type='email']");
            let passField = form.querySelector("input[name='_password']") || form.querySelector("input[type='password']");

            if (userField && passField) {
                const user = userField.value.trim();
                const pass = passField.value;

                if (user && pass) {
                    chrome.runtime.sendMessage({
                        type: "aes:vault:save-credentials",
                        username: user,
                        password: pass
                    }, (resp) => {
                        // ignore error
                    });
                }
            }
        });
    });
})();
