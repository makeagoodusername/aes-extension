"use strict"

/**
 * Aircraft Flight Plan Assistant entry point.
 * Mounts on /app/fleets/aircraft/<id>/0.
 */
;(function () {
    window.addEventListener("load", () => {
        if (window.AesAfp && typeof window.AesAfp.mount === "function") {
            window.AesAfp.mount().catch(err => console.warn("[AES AFP] mount failed", err))
        }
    })
})()
