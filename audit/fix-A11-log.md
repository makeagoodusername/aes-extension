# Fix A11 — Cross-context rate-limit signal (ORS -> background-tab-pool)

Status: DONE

Changes:
- ors-scraper.js:1064-1098 — added `_signalRateLimit(status, where)` static helper; `_RateLimitError` constructor now writes `aes:scrape-orchestrator:rateLimitSignal` to `chrome.storage.local` on every 429/503 (existing detection at lines 881, 931, 968 unchanged).
- background-tab-pool.js:53-58 — added `RATE_LIMIT_SIGNAL_KEY` constant.
- background-tab-pool.js:212-237 — `chrome.storage.onChanged` listener tracks `_latestRateLimitSignalAt`.
- background-tab-pool.js:239-260 — `_onJobResult` marks `result.rateLimited = true` when a fresh signal arrived during the run; trips breaker IMMEDIATELY (skips 3-strike threshold). Existing parser-miss path untouched.

Verified: `node --check` passes both files.
