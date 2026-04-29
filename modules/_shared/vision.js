"use strict"

/**
 * AesVision — multimodal capture helpers.
 *
 * Two capture paths:
 *
 *   AesVision.captureTab({format?: "png"|"jpeg", quality?: 1..100})
 *     → Promise<{ok, dataUrl, format, capturedAt} | {ok:false, error}>
 *
 *     Routes through `aes:vision:capture-tab` to background.js which
 *     calls `chrome.tabs.captureVisibleTab` against the requesting tab's
 *     window. Returns a base64 data URL of what the user can currently
 *     see (visible viewport only — covered scroll regions are NOT
 *     captured; tile that yourself if you need a full-page image).
 *
 *   AesVision.frameOf(elOrSelector, {format?, quality?})
 *     → {ok, dataUrl, format, w, h} | {ok:false, error}
 *
 *     Synchronous capture of a <canvas> element by reference or selector.
 *     Cheaper than a full-tab capture for renderers we already own
 *     (schedule canvas, wave overlay, ORS sandbox sweep, billboard).
 *     Returns a data URL straight from `canvas.toDataURL`. Does NOT
 *     rasterise non-canvas DOM — that needs html2canvas-class deps
 *     which the project deliberately doesn't carry.
 *
 * Why both paths exist:
 *   - captureTab() catches what the user sees, including AS's own
 *     server-rendered chrome (charts, pricing matrix, alliance roster)
 *     that AES doesn't draw. Foundation for vision-model fallback when
 *     a Wicket scraper drifts.
 *   - frameOf() is the fast path for AES-rendered visualisations the
 *     LLM might want to "look at" without paying the IPC + decode cost
 *     of a full-tab snapshot.
 *
 * Both paths sit behind a single window namespace so an LLM tool surface
 * (Slice 28) can advertise one capability descriptor:
 *   {name: "captureView", params: ["target?"], returns: "dataUrl"}.
 *
 * Defensive: every error path returns an envelope rather than throwing.
 * Callers can render a "no preview" state without try/catch noise.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesVision) return

    function _err(msg) { return {ok: false, error: String(msg || "unknown")} }

    function captureTab(opts) {
        return new Promise((resolve) => {
            try {
                if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
                    resolve(_err("chrome.runtime.sendMessage unavailable"))
                    return
                }
                chrome.runtime.sendMessage(
                    {type: "aes:vision:capture-tab", opts: opts || {}},
                    (resp) => {
                        const lastErr = chrome.runtime.lastError
                        if (lastErr) { resolve(_err(lastErr.message)); return }
                        if (!resp) { resolve(_err("no response from background")); return }
                        resolve(resp)
                    }
                )
            } catch (e) { resolve(_err((e && e.message) || e)) }
        })
    }

    function _resolveCanvas(target) {
        if (!target) return null
        if (typeof target === "string") {
            try { return document.querySelector(target) } catch (_) { return null }
        }
        if (target.nodeType === 1) return target
        return null
    }

    function frameOf(target, opts) {
        const o = opts || {}
        const el = _resolveCanvas(target)
        if (!el) return _err("target not found")
        if (el.tagName !== "CANVAS") return _err("frameOf only handles <canvas> elements (got " + el.tagName + ")")
        const format = o.format === "jpeg" ? "jpeg" : "png"
        const mime = format === "jpeg" ? "image/jpeg" : "image/png"
        try {
            const dataUrl = (format === "jpeg" && Number.isFinite(o.quality))
                ? el.toDataURL(mime, Math.max(0.01, Math.min(1, o.quality / 100)))
                : el.toDataURL(mime)
            return {ok: true, dataUrl, format, w: el.width, h: el.height, capturedAt: Date.now()}
        } catch (e) {
            // toDataURL throws on tainted canvases (cross-origin pixels).
            // Return the error so the caller can fall back to captureTab.
            return _err((e && e.message) || e)
        }
    }

    window.AesVision = {captureTab, frameOf}
})()
