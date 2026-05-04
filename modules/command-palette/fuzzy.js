"use strict";

/**
 * AES Command Palette — fuzzy matching core.
 *
 * Pure subsequence scorer. Replaces registry.js's substring-only
 * _scoreCommand so typing "strt" matches "Open Strategy", "accntg"
 * matches "Open Accounting", etc.
 *
 * Scoring approach:
 *   - Tokenize the query on whitespace.
 *   - For each query token, scan the candidate haystack character-by-character.
 *     Award points per matched char with bonuses for:
 *       prefix match     (+12)  query starts at haystack[0]
 *       label-prefix     (+8)   match at start of label specifically
 *       token-boundary   (+5)   match starts after whitespace, hyphen, dot
 *       consecutive run  (+3)   match continues from previous matched char
 *       label region     (+2)   match falls inside label rather than hint/keywords
 *   - Penalty: -1 per non-matching gap character (capped at -10).
 *   - All-token match required: any token that fails to subsequence-match
 *     drops the candidate to score 0.
 *
 * Final score is normalized to roughly [0, 100] so callers can compose
 * with recency / scope biases without renormalization.
 *
 * Optional opts:
 *   { label, hint, keywords, recencyBoost, prefixBoost, isCurrentScope }
 *
 * Public API:
 *   window.AESPaletteFuzzy.score(query, candidate, opts) → number
 *   window.AESPaletteFuzzy.tokenize(s) → string[]
 */
(function () {
    if (typeof window === "undefined") return;
    if (window.AESPaletteFuzzy) return;

    const TOKEN_SPLIT = /[\s\-._/]+/;

    function tokenize(s) {
        if (!s) return [];
        return String(s).toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
    }

    function isBoundary(ch) {
        return !ch || /[\s\-._/]/.test(ch);
    }

    function scoreToken(token, label, hint, keywords) {
        const labelLower = label.toLowerCase();
        const hintLower  = hint ? String(hint).toLowerCase() : "";
        const kwLower    = keywords && keywords.length ? keywords.join(" ").toLowerCase() : "";

        const haystack = labelLower + "  " + hintLower + "  " + kwLower;
        const labelEnd = labelLower.length;

        let qi = 0;
        let lastMatch = -2;
        let score = 0;
        let gap = 0;

        for (let hi = 0; hi < haystack.length && qi < token.length; hi++) {
            const ch = haystack[hi];
            if (ch === token[qi]) {
                let bonus = 1;
                if (hi === 0)                                 bonus += 12;
                else if (hi <= labelEnd && hi === lastMatch + 1) bonus += 3;
                if (isBoundary(haystack[hi - 1]))             bonus += 5;
                if (hi === 0)                                 bonus += 8;
                if (hi <= labelEnd)                           bonus += 2;
                score += bonus;
                lastMatch = hi;
                qi++;
                gap = 0;
            } else if (qi > 0 && qi < token.length) {
                gap++;
                if (gap < 10) score -= 1;
            }
        }

        if (qi < token.length) return 0;
        return score;
    }

    function score(query, candidate, opts) {
        const o = opts || {};
        const c = candidate || {};
        const label    = String(o.label != null ? o.label : (c.label || ""));
        if (!label) return 0;
        const hint     = String(o.hint  != null ? o.hint  : (c.hint  || ""));
        const keywords = Array.isArray(o.keywords) ? o.keywords
                       : Array.isArray(c.keywords) ? c.keywords
                       : [];

        const q = String(query || "").trim().toLowerCase();
        if (!q) {
            // No query — scoring with neutral weight + scope/recency biases only.
            let base = 1;
            if (o.recencyBoost) base += Number(o.recencyBoost) || 0;
            if (o.isCurrentScope) base += 4;
            return base;
        }

        const tokens = tokenize(q);
        if (!tokens.length) return 0;

        let total = 0;
        for (const t of tokens) {
            const s = scoreToken(t, label, hint, keywords);
            if (s <= 0) return 0;
            total += s;
        }

        // Normalize roughly to [0, 100]: divide by ~token-count * 6 then clamp.
        let norm = total / Math.max(1, tokens.length * 0.6);
        if (norm > 100) norm = 100;

        if (o.recencyBoost) norm += Number(o.recencyBoost) || 0;
        if (o.isCurrentScope) norm += 8;
        if (o.prefixBoost && label.toLowerCase().indexOf(q) === 0) norm += 6;

        return norm;
    }

    window.AESPaletteFuzzy = {score, tokenize};
})();
