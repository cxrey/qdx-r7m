# Testing Guide

## Quick Start

```bash
npm test              # Run all 285 tests (~260ms)
npm test -- --watch   # Watch mode for development
npm test -- api       # Run a single test file by name
```

## Architecture

```
src/__tests__/
├── helpers/
│   ├── marketFixtures.js     # Shared factory functions (2 pipeline stages)
│   └── mockLocalStorage.js   # Reusable localStorage spy
├── api.test.js               # 48 tests — HTTP client functions
├── backgroundFetch.test.js   # 19 tests — batch orchestration algorithms
├── baseRateEngine.test.js    # 24 tests — resolved market analysis
├── clobRateLimit.test.js     # 15 tests — circuit breaker module
├── dualRangeSlider.test.js   # 30 tests — scale mapper + rounding
├── fetchUtils.test.js        # 13 tests — AbortSignal timeout utility
├── filterAndSort.test.js     # 48 tests — market filtering and sorting
├── hoverPrefetch.test.js     # 12 tests — debounced prefetch algorithm
├── processMarket.test.js     # 61 tests — market processing pipeline
└── tradeFlowEngine.test.js   # 16 tests — trade/holder/leaderboard fetching
```

## Test Categories

### Network Layer (`api.test.js`, `fetchUtils.test.js`, `tradeFlowEngine.test.js`)

Tests the HTTP client functions that talk to Polymarket's CLOB, Gamma, and Data APIs.

**What's covered:**
- URL construction and query parameters
- Response parsing (200 → JSON, non-200 → null)
- Error propagation (429/403 throw with `.status`, TypeError → null, AbortError → null)
- `fetchAllMarkets` pagination: batch concurrency (5), empty/partial page termination, MAX_PAGES=200 safety cap
- `fetchMarketBySlug` 5-stage fallback chain: events → markets → truncated slug → truncated markets → text search
- `fetchMarketTrades` dual-URL fallback
- `fetchMarketHolders` 3-endpoint sequential fallback
- `fetchLeaderboard` and `fetchWalletActivity` with localStorage caching
- `withTimeout` AbortSignal chaining, timer cleanup, and caller signal propagation

**Mock pattern:** `vi.stubGlobal('fetch', vi.fn())` with per-call `mockImplementation` for conditional responses. `fetchUtils.withTimeout` is mocked as a passthrough — timeout behavior is tested in isolation in `fetchUtils.test.js`.

### Rate Limiting (`clobRateLimit.test.js`)

Tests the circuit breaker that protects against Polymarket IP blocks.

**What's covered:**
- 429 → 60-second recovery window
- 403 → 300-second recovery window
- 403 upgrades existing 429 timer
- Duplicate 403 resets timer and re-notifies listeners
- Duplicate 429 is idempotent (no-op)
- `clearClobRateLimit()` immediate reset
- Listener subscribe/unsubscribe/notification
- `getClobRecoverySeconds()` countdown

**Mock pattern:** `vi.useFakeTimers()` with `advanceTimersByTime()`. Tests the real module — no mocks needed.

### Fetch Orchestration (`backgroundFetch.test.js`, `hoverPrefetch.test.js`)

Tests the batch fetch algorithms that coordinate CLOB requests across spread, flow, and gap-fill systems.

> **⚠️ Algorithm replication:** These tests replicate ~120 lines of logic from `ResultsTable.jsx` as standalone functions. This is tracked as `TODO(TD-1)` — the plan is to extract `useBackgroundBatchFetch` into its own module, then replace the copies with direct imports. Until then, changes to ResultsTable fetch logic must be mirrored in these test files.

**What's covered:**
- Spread batch: max 25 calls, 200ms inter-request delay, cache deduplication
- Flow batch: max 10 calls, 300ms inter-request delay, module cache + local cache dedup
- Gap filler: max 3 spread + 2 flow calls, semaphore prevents concurrency
- Total request volume: ≤40 CLOB requests across all three systems
- Rate limit integration: 429/403 trigger circuit breaker, remaining batch skipped
- Hover prefetch: 150ms debounce, abort on row change, 30s cache TTL, LRU eviction at 20 entries

**Mock pattern:** `vi.mock('../api')`, `vi.mock('../clobRateLimit')` with coupled mock behavior (triggerClobRateLimit mutates isClobRateLimited's return to replicate production coupling). `vi.useFakeTimers()` for delay verification.

### Data Processing (`processMarket.test.js`, `baseRateEngine.test.js`)

Tests the market processing pipeline and base rate statistical analysis.

**What's covered:**
- `processMarket`: price extraction, category inference, edge score calculation, days-left computation, engine integration wiring (FLB, theta, resolution, volume efficiency, base rate, conjunction)
- `computeBaseRates`: YES/NO resolution counting, price bucket distribution, ambiguous resolution filtering
- `analyzeBaseRate`: weighted average from 4 sources (catPrice×3, category×2, price×2, duration×1), gap classification (NARRATIVE_PREMIUM, NARRATIVE_DISCOUNT, FAIR), null guards for insufficient data
- `getBaseRateEdgeConfidence`: FLB agreement/conflict detection, confidence passthrough
- `fetchResolvedMarkets`: localStorage cache (24h TTL), concurrent page fetching, exponential backoff with Retry-After header, abort handling

**Mock pattern:** All engine modules mocked via `vi.mock()` — processMarket tests wiring, not engine internals. Base rate engine tests mock `fetch` and `localStorage` for network tests, use real `computeBaseRates`/`analyzeBaseRate` for pure computation tests.

### UI Logic (`filterAndSort.test.js`, `dualRangeSlider.test.js`)

Tests filtering, sorting, and UI utility functions.

**What's covered:**
- Multi-criteria filtering: category, price range, volume range, days-left range, edge score, text search
- Sorting by all columns (volume, price, edge, days left, etc.)
- `createScaleMapper`: linear and cubic (log) scale mapping with round-trip fidelity
- `smartRound`: adaptive rounding based on value magnitude (integers for small ranges, $100K increments for large)
- Defensive inputs: NaN, Infinity, null markets, empty arrays, inverted ranges

**Mock pattern:** Mostly pure function tests — no mocks needed. Uses `makeProcessedMarket()` factory from shared fixtures.

## Shared Test Helpers

### `helpers/marketFixtures.js`

Two factory functions for two pipeline stages:

```js
import { makeMarket, makeMarketList, resetCounter } from './helpers/marketFixtures';
import { makeProcessedMarket } from './helpers/marketFixtures';
```

| Factory | Shape | Used by |
|---------|-------|---------|
| `makeMarket(overrides)` | Raw API response (pre-processMarket) | api, backgroundFetch, hoverPrefetch |
| `makeProcessedMarket(overrides)` | Processed (post-processMarket) | filterAndSort |
| `makeMarketList(n)` | Array of n raw markets | backgroundFetch |
| `resetCounter()` | Reset auto-increment IDs | beforeEach cleanup |

### `helpers/mockLocalStorage.js`

```js
import { setupLocalStorageMock } from './helpers/mockLocalStorage';

const ls = setupLocalStorageMock();
vi.stubGlobal('localStorage', ls.mock);
ls.store['key'] = 'value';  // pre-populate for cache-hit tests
```

Returns `{ mock, store }` where all methods (`getItem`, `setItem`, `removeItem`) are `vi.fn()` spies backed by a plain object.

## Conventions

### Mock Strategy

- **`vi.stubGlobal('fetch', vi.fn())`** — every test file that makes HTTP calls
- **`vi.mock('../fetchUtils')`** — passthrough mock isolates timeout testing to `fetchUtils.test.js`
- **`vi.useFakeTimers()`** — all delay/timeout tests; always paired with `vi.useRealTimers()` in afterEach
- **`afterEach(() => vi.restoreAllMocks())`** — present in every test file
- **Inline `mockImplementation`** over generic helpers — every test needs per-call conditional logic

### Assertion Style

- Exact counts over ranges: `expect(callCount).toBe(300)` not `toBeGreaterThan(0)`
- Exact values over tolerances: `expect(result.baseRate).toBeCloseTo(0.5625, 4)` with worked-out calculation in comment
- URL assertions on specific `mockFetch.mock.calls[n][0]` indices
- Error shape assertions: `rejects.toMatchObject({ status: 429 })`

### Naming

- Test descriptions start with verbs: "returns", "throws", "stops", "skips"
- Describe blocks match export names: `describe('fetchOrderBook', ...)`
- Edge cases grouped under "defensive inputs" or "edge cases" describes

## Known Limitations

1. **TD-1 (deferred):** `backgroundFetch.test.js` and `hoverPrefetch.test.js` replicate algorithms from `ResultsTable.jsx` instead of importing them. Extraction into standalone modules is planned.
2. **TD-7 (deferred):** No integration test between real `clobRateLimit` module and consumer fetch loops. The coupling is tested via mock coordination in `backgroundFetch.test.js`.
3. **No React component tests:** No `@testing-library/react` installed. Component behavior is tested as standalone async functions.
