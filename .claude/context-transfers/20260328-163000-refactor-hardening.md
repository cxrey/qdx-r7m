# Context Transfer -- processMarket split, base rate consolidation, and defensive hardening

**Generated:** 2026-03-28T16:30:00Z
**Branch:** master
**Last commit:** 3338a63 Initial commit: Polymarket Scanner

---

## Summary

Split the monolithic `api.js` into `api.js` (HTTP-only) + `processMarket.js` (pure computation). Consolidated 5 duplicated `analyzeBaseRate + calculateEdgeScore` call sites into a single `enrichWithBaseRate` function. Applied ~20 defensive hardening fixes across 6 files through iterative code reviews. Initialized the project as a git repo with all changes in the initial commit.

## Key Decisions

- **`processMarket.js` has zero HTTP/browser deps**: Designed for future Web Worker migration. All engine imports are synchronous pure functions.
- **`enrichWithBaseRate` is the single source of truth**: Replaces duplicated base rate enrichment in useMarkets (x2), RefreshManager (x2), useDirectLookup (x1).
- **`enrichWithBaseRate` short-circuits on unchanged base rate**: Uses both identity check (`===`) and shallow equality (baseRate, gapType, confidence fields) to avoid unnecessary object allocation across 5K markets.
- **`_engineFailures` array on market objects**: Tracks which of the 6 engines failed per market, enabling consumers to detect degraded results without parsing console output.
- **`usePortfolio` uses ref for `loadedMarkets`**: `loadedMarketsRef.current` stabilizes `refreshPositions` callback identity, preventing ~7/sec timer teardown from Immer price updates.
- **`api.js` PAGE_SIZE=500, DELAY_MS=50**: Aggressive fetching with partial-page early exit. MAX_PAGES lowered to 50 (25K cap).

## Traps & Failed Approaches

- The project directory is NOT inside a git repo's parent -- `git` commands fail unless `cd`'d to `/c/Users/ace/polymarket-scanner` first.
- `outcomePrices[0] ? parseFloat(...)` was wrong -- falsy `"0"` string caused null prices. Fixed to `!= null` check.
- `daysLeft >= 1` excluded day-0 markets from the imminent-expiry scoring band. Fixed to `>= 0`.
- `usePortfolio.marketLookup` useMemo depended on `[loadedMarkets]` (full ref, rebuilds ~7/sec). Changed to `[loadedMarkets.length]` with ref access.

## Working State

### Completed
- [x] Split api.js into api.js + processMarket.js
- [x] Refactor calculateEdgeScore to accept single object param
- [x] Wrap each engine call in individual try-catch with _engineFailures tracking
- [x] Create enrichWithBaseRate with short-circuit optimization
- [x] Consolidate all 5 consumer call sites to use enrichWithBaseRate
- [x] Add retry wrapper (2 retries, 2s delay) to fetchAllMarkets in useMarkets
- [x] Log base rate fetch failures (non-AbortError)
- [x] Verify all imports with grep -- no stale analyzeBaseRate/calculateEdgeScore imports in consumers
- [x] Fix usePortfolio timer churn (loadedMarketsRef, stable refreshPositions)
- [x] Stabilize marketLookup useMemo with loadedMarkets.length dep
- [x] api.js: PAGE_SIZE 100->500, DELAY_MS 150->50, MAX_PAGES 500->50
- [x] api.js: Partial page early exit (break instead of 3 empty round-trips)
- [x] api.js: Error logging on all fetch functions (AbortError excluded)
- [x] api.js: Stop-reason log distinguishes done/aborted/empty/cap
- [x] processMarket.js: Fix /primari/i typo -> /primary/i
- [x] processMarket.js: Fix falsy "0" price check (outcomePrices != null)
- [x] processMarket.js: Fix daysLeft >= 0 for day-0 markets
- [x] processMarket.js: Remove dead score += 0 branch
- [x] processMarket.js: Add regex /g flag warning comment
- [x] processMarket.js: Defensive copy of _engineFailures in enrichWithBaseRate
- [x] MarketRow.jsx: O(1) isMarketHeld gate before O(n) getHeldPosition
- [x] MarketRow.jsx: Memo comparator checks filters.highlightHeld and filters.showPortfolioFit
- [x] useDirectLookup.js: Defense-in-depth try-catch around enrichWithBaseRate
- [x] RefreshManager.js: Tier 2 uses reassignment instead of partial field copy
- [x] Git repo initialized, initial commit 3338a63

### Not Started (Planned)
- [ ] Tech debt Phase 1: Extract 43+ scoring thresholds from calculateEdgeScore to scoringConfig.js
- [ ] Tech debt Phase 1: Add unit tests (processMarket, calculateEdgeScore, enrichWithBaseRate, inferCategory)
- [ ] Tech debt Phase 2: Decompose processMarket into parseMarketData + runEngines helpers
- [ ] Tech debt Phase 2: Extract CATEGORY_RULES to categoryRules.js with priority field
- [ ] Tech debt Phase 3: Add JSDoc @typedef ProcessedMarket
- [ ] Tech debt Phase 3: Extract shared processAndFilter helper for 3 consumer call sites
- [ ] Web Worker migration of processMarket.js (the split was a prerequisite)

## Relevant Files

- `src/processMarket.js` -- pure computation: processMarket, calculateEdgeScore, enrichWithBaseRate, ALL_CATEGORIES
- `src/api.js` -- HTTP-only: fetchAllMarkets (paginated + retry), fetchOrderBook, fetchPriceHistory, 4 lookup functions
- `src/hooks/useMarkets.js` -- main data hook, retry wrapper, enrichWithBaseRate consumer
- `src/hooks/usePortfolio.js` -- loadedMarketsRef pattern, stable refreshPositions, marketLookup optimization
- `src/hooks/useDirectLookup.js` -- direct market lookup by URL/slug/ID, enrichWithBaseRate consumer
- `src/RefreshManager.js` -- 3-tier refresh (WS/discovery/catalog), enrichWithBaseRate consumer (2 sites)
- `src/components/MarketRow.jsx` -- O(1) isMarketHeld gate, memo comparator with filter checks

## Prompt for New Session

> Read the file `C:\Users\ace\polymarket-scanner\.claude\context-transfers\20260328-163000-refactor-hardening.md` and continue where the previous session left off.
>
> The polymarket-scanner project at `C:\Users\ace\polymarket-scanner` just completed a major refactoring pass: api.js was split into api.js (HTTP) + processMarket.js (computation), base rate enrichment was consolidated into `enrichWithBaseRate`, and ~20 defensive fixes were applied across 6 files. All changes are in the initial git commit `3338a63` on `master`.
>
> The next priority is **Tech Debt Phase 1** from the tech debt report in `.claude/plans/scalable-chasing-riddle.md`:
> 1. Extract the 43+ hardcoded scoring thresholds from `calculateEdgeScore` (src/processMarket.js lines 143-227) into a new `src/scoringConfig.js` with documented rationale for each threshold.
> 2. Add unit tests for processMarket, calculateEdgeScore, enrichWithBaseRate, and inferCategory using vitest.
>
> Key constraints: `processMarket.js` must remain Web Worker-compatible (no HTTP/browser deps). The `_engineFailures` array is a new field on returned market objects. `enrichWithBaseRate` has a short-circuit optimization that checks 3 fields (baseRate, gapType, confidence) for shallow equality.
