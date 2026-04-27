"use strict"

;(function () {
    function run() {
        try {
            const server = window.location.hostname.split(".")[0]
            if (!server) return
            const parsed = window.CrewMgmtStaffPilotsScraper.parseDoc(document)
            const record = Object.assign({server: server}, parsed)
            chrome.storage.local.set({[window.CrewMgmtStaffPilotsScraper.STORAGE_KEY]: record})
        } catch (err) {
            console.warn("[AES crewMgmt] seed failed", err)
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, {once: true})
    } else {
        run()
    }
})()
