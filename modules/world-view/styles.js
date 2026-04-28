"use strict"

/**
 * WorldViewStyles — small inline-style helpers + competitive-pressure
 * encoding shared across world-view subpanes. All values flow from
 * window.AESTokens so customization picks them up live.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewStyles) return

    function T() { return window.AESTokens }

    /**
     * Three-stop pressure encoding: green (quiet) → amber → crimson (fierce).
     * `score` is in [0..1].
     */
    function pressureColor(score) {
        const t = T()
        if (!isFinite(score)) return {bg: t.color.bone2, fg: t.color.slate, border: t.color.paperRule}
        if (score >= 0.66) return {bg: t.color.crimsonSoft, fg: t.color.crimson, border: t.color.crimson}
        if (score >= 0.33) return {bg: t.color.amberSoft,   fg: t.color.amber,   border: t.color.amber}
        return                {bg: t.color.mossSoft,    fg: t.color.moss,    border: t.color.moss}
    }

    /**
     * Glyph for carrier class — used by the world-map bubble corner and
     * treemap tile corner.
     */
    function carrierGlyph(carrierClass) {
        switch ((carrierClass || "").toLowerCase()) {
            case "own":       return {char: "●", color: T().color.cobalt}
            case "alliance":  return {char: "★", color: T().color.cobalt}
            case "interline": return {char: "⇄", color: T().color.amber}
            case "unagreed":  return {char: "▲", color: T().color.slate}
            default:          return {char: "·", color: T().color.slate}
        }
    }

    function panelBox() {
        const t = T()
        return [
            "background:" + t.color.bone,
            "border:" + t.geom.bw1 + " solid " + t.color.paperRule,
            "border-radius:" + t.geom.radius,
            "padding:" + t.sp[2],
            "box-sizing:border-box"
        ].join(";")
    }

    function paneTitle() {
        const t = T()
        return [
            "font-family:" + t.font.display,
            "font-size:" + t.fs.small,
            "font-weight:" + t.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + t.track.caps,
            "color:" + t.color.oxide,
            "margin:0 0 " + t.sp[1] + " 0"
        ].join(";")
    }

    function chip(active) {
        const t = T()
        return [
            "display:inline-flex",
            "align-items:center",
            "gap:" + t.sp[1],
            "padding:" + t.sp[1] + " " + t.sp[2],
            "background:" + (active ? t.color.oxide : "transparent"),
            "color:" + (active ? t.color.bone : t.color.oxide),
            "border:" + t.geom.bw1 + " solid " + t.color.oxide,
            "border-radius:" + t.geom.radius,
            "font-family:" + t.font.mono,
            "font-size:" + t.fs.small,
            "letter-spacing:" + t.track.mono,
            "cursor:pointer",
            "user-select:none",
            "transition:" + t.tr.fast
        ].join(";")
    }

    function metricCell() {
        const t = T()
        return [
            "display:flex",
            "flex-direction:column",
            "gap:2px",
            "padding:" + t.sp[2] + " " + t.sp[3],
            "border:" + t.geom.bw1 + " solid " + t.color.paperRule,
            "border-radius:" + t.geom.radius,
            "background:" + t.color.bone,
            "min-width:0"
        ].join(";")
    }

    function metricLabel() {
        const t = T()
        return [
            "font-family:" + t.font.display,
            "font-size:" + t.fs.micro,
            "font-weight:" + t.fw.medium,
            "text-transform:uppercase",
            "letter-spacing:" + t.track.caps,
            "color:" + t.color.slate
        ].join(";")
    }

    function metricValue() {
        const t = T()
        return [
            "font-family:" + t.font.mono,
            "font-size:" + t.fs.lead,
            "color:" + t.color.oxide,
            "white-space:nowrap",
            "overflow:hidden",
            "text-overflow:ellipsis"
        ].join(";")
    }

    function clamp01(x) {
        if (!isFinite(x)) return 0
        if (x < 0) return 0
        if (x > 1) return 1
        return x
    }

    function normalize(x, lo, hi) {
        if (!isFinite(x)) return 0
        const range = hi - lo
        if (range <= 0) return 0
        return clamp01((x - lo) / range)
    }

    window.WorldViewStyles = {
        pressureColor: pressureColor,
        carrierGlyph: carrierGlyph,
        panelBox: panelBox,
        paneTitle: paneTitle,
        chip: chip,
        metricCell: metricCell,
        metricLabel: metricLabel,
        metricValue: metricValue,
        clamp01: clamp01,
        normalize: normalize
    }
})()
