# Context Transfer — Gamma API field extraction, tech debt fixes, and GitHub push

**Generated:** 2026-03-29T22:48:00-04:00
**Branch:** master
**Repo:** https://github.com/cxrey/qdx-r7m
**Last commit:** `efc6a24` Add .env and .env.* to .gitignore

---

## Summary

This session (Session 5) continued from Session 4. Starting point: 647 tests passing, all prior feature work done. Ending point: 667 tests passing, build clean, pushed to GitHub. The session implemented a 7-change plan to extract unused Gamma API fields into `processMarket`, fixed the holders endpoint, raised concurrency limits, then ran two rounds of code review + a tech debt audit and fixed all approved items.

## Key Decisions

- **`safeNum()` helper for all numeric API fields**: Centralizes `Number()` + `isFinite()` guard. Rejects NaN, Infinity, empty strings. Used for all 15 numeric Gamma field extractions including yesPrice/noPrice.
- **Bid-ask spread replaces overround**: `spread` field now uses `gammaBestAsk - gammaBestBid` when available, falls back to `Math.abs(1 - yesPrice - noPrice)`. Downstream consumers (calculateEdgeScore, analyzeFLB) benefit automatically.
- **GAMMA_CATEGORY_MAP with regex fallback**: Gamma slugs like `"us-current-affairs"` map to display categories. Unmapped slugs fall through to regex `inferCategory()`. Logged once per unique slug via `_loggedSlugs` Set.
- **`fetchMarketTrades` uses `conditionId=` param only**: Live curl verified `market=` returns unrelated trades. Single URL, matches `fetchMarketHolders` pattern.
- **Concurrency DEFAULT=8, CEILING=12, FLOOR=2**: Based on documented CLOB rate limits (150/sec for /book).
- **No fee parameter lookup table yet**: `feesEnabled` and `gammaCategory` are extracted and stored raw. Fee calculation is a separate future prompt.

## Architecture & Design Context

- `processMarket` return object now has 37 fields (was 23). No TypeScript or JSDoc typedef yet — item #1 from tech debt audit, deferred.
- `ApiHealthManager.js` is the unified entry point for rate limits. `handleRateLimit(statusCode)` triggers: circuit breaker, concurrency reduction, backoff escalation. Integration tests verify all three fire.
- `enrichWithBaseRate()` is the single source of truth for base rate injection + edge score recalculation.

## Traps & Failed Approaches

- `Number('')` returns `0` (not NaN) — caught by test, fixed by adding `val === ''` check in `safeNum`.
- Gamma API does NOT return: `oneHourPriceChange`, `oneWeekPriceChange`, `oneMonthPriceChange`, `makerBaseFee`, `takerBaseFee`, `tags`. Verified via live curl.
- `/top-holders` endpoint returns 404. Use `/holders?market=` instead.
- `market=` param on `/trades` endpoint does NOT reliably filter by conditionId — returns unrelated trades. Use `conditionId=` param.

## Working State

### Completed
- [x] 7-change Gamma API field extraction plan (all 7 committed)
- [x] Code review round 1 fixes (URL encoding, crossed book warning, tests)
- [x] Tech debt Phase A (#2 polling try/catch, #7 formatter NaN guards, #4 unmapped category log)
- [x] Tech debt #3: safeNum guard on all numeric fields
- [x] Tech debt #5: fetchMarketTrades simplified to single URL
- [x] Tech debt #9: smartDiff numeric comparison fix
- [x] Tech debt #10: handleRateLimit integration tests
- [x] Code review round 2 fixes (#1 yesPrice/noPrice safeNum, #3 dedupe slug logs, #4 polling debug log)
- [x] Security scan and .gitignore hardening
- [x] Pushed to GitHub: https://github.com/cxrey/qdx-r7m

### Not Started (Planned)
- [ ] Fee calculation prompt (uses `feesEnabled` + `gammaCategory` already extracted)
- [ ] `@typedef ProcessedMarket` JSDoc (tech debt #1, deferred)
- [ ] Extract `analyzeTradeFlow` into composable helpers (tech debt #11, deferred)

## Relevant Files

- `src/processMarket.js` — 37-field market processor, `safeNum`, `GAMMA_CATEGORY_MAP`, spread logic
- `src/TradeFlowEngine.js` — Simplified `fetchMarketTrades`/`fetchMarketHolders` to single URLs
- `src/ApiHealthManager.js` — Unified rate limit: circuit breaker + concurrency + backoff
- `src/RefreshManager.js` — Polling try/catch fix, smartDiff numeric comparison
- `src/formatters.js` — All 6 functions now have NaN guards
- `src/workerManager.js` — `terminateAnalysisWorker()` on timeout
- `src/hooks/usePortfolio.js` — useMemo on 21-field return object
- `src/__tests__/processMarket.test.js` — 17+ new tests for Gamma fields
- `src/__tests__/clobConcurrency.test.js` — Integration tests for handleRateLimit
- `.claude/plans/warm-splashing-globe.md` — The 7-change plan (complete, can be deleted)

## Working Agreements

- Architect/contractor workflow: user reviews plans before implementation
- Commit after each change, run `npm test && npm run build` between each
- One fix at a time for tech debt items
- Verify API endpoints with live curl before changing fetch code
- Don't build fee lookup tables until slug-to-fee mapping is verified

## Prompt for New Session

> The Polymarket Scanner app at `C:\Users\ace\polymarket-scanner` is a React+Vite trading scanner. GitHub repo: https://github.com/cxrey/qdx-r7m. 667 tests passing, build clean, master branch at `efc6a24`.
>
> Key architecture: `processMarket.js` extracts 37 fields from Gamma API responses (uses `safeNum()` helper for numeric coercion). `ApiHealthManager.js` is the unified rate limit handler. `RefreshManager.js` orchestrates 3-tier refresh (WebSocket, new market discovery, full catalog). All scoring engines read the `spread` field which now uses real bid-ask data when available.
>
> Deferred tech debt: (1) Add `@typedef ProcessedMarket` JSDoc to `processMarket.js`, (2) Extract `analyzeTradeFlow` (340 lines) in `TradeFlowEngine.js` into composable helpers. Neither is urgent.
>
> The next planned feature is fee calculation using the already-extracted `feesEnabled` and `gammaCategory` fields. The user will provide a prompt for that when ready.
