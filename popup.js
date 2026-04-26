"use strict";

document.addEventListener("DOMContentLoaded", () => {
    const m = chrome.runtime.getManifest();
    const stamp = document.getElementById("aes-version-stamp");
    if (stamp) stamp.textContent = "v" + (m.version_name || m.version);

    const btn = document.getElementById("aes-openOptions-btn");
    if (btn) btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
});
