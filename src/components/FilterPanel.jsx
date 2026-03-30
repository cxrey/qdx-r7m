import { useCallback, useMemo } from 'react';
import DualRangeSlider from './DualRangeSlider';
import { DEFAULT_FILTERS } from '../filterDefaults';
import { useExecutionStyle } from '../contexts/ExecutionContext';

const SORT_OPTIONS = [
  { value: 'edgeScore', label: 'Edge Score' },
  { value: 'flbEdge', label: 'FLB Edge' },
  { value: 'theta', label: 'Daily Theta' },
  { value: 'strictness', label: 'Strictness Score' },
  { value: 'impliedDailyRate', label: 'Implied Daily Rate' },
  { value: 'volEfficiency', label: 'Volume Efficiency' },
  { value: 'effectiveVolume', label: 'Effective Volume' },
  { value: 'volVelocity', label: 'Volume Velocity' },
  { value: 'baseRateGap', label: 'Base Rate Gap' },
  { value: 'conjunctionGap', label: 'Conjunction Gap' },
  { value: 'volume', label: 'Volume' },
  { value: 'volume24hr', label: '24hr Volume' },
  { value: 'daysLeft', label: 'Days Left' },
  { value: 'yesPrice', label: 'Yes Price' },
  { value: 'noPrice', label: 'No Price' },
  { value: 'walletImbalance', label: 'Wallet Flow Imbalance' },
  { value: 'fee', label: 'Fee Rate' },
];

const PRIORITY_TYPES = [
  { value: 'SWEET_SPOT', label: 'Sweet Spot' },
  { value: 'OPPORTUNITY', label: 'Opportunity' },
  { value: 'MARGINAL', label: 'Marginal' },
  { value: 'EFFICIENT', label: 'Efficient' },
  { value: 'LOW_LIQUIDITY', label: 'Low Liquidity' },
];

const CONJUNCTION_TYPES = [
  { value: 'ALL_OF', label: 'All-Of (AND)' },
  { value: 'K_OF_N', label: 'K-of-N' },
  { value: 'ANY_OF', label: 'Any-Of (OR)' },
  { value: 'SEQUENTIAL', label: 'Sequential' },
  { value: 'THRESHOLD', label: 'Threshold' },
  { value: 'NONE', label: 'None (simple)' },
];

const RESOLUTION_TYPES = [
  { value: 'DATA_DRIVEN', label: 'Data-Driven' },
  { value: 'CONSENSUS_BASED', label: 'Consensus' },
  { value: 'MULTI_CONDITION', label: 'Multi-Condition' },
  { value: 'EXCLUSIONARY', label: 'Exclusionary' },
  { value: 'CONTINUOUS', label: 'Continuous' },
  { value: 'TOUCH', label: 'Touch' },
];

/** Shallow comparison — avoids JSON.stringify on every filter change */
function filtersEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

export default function FilterPanel({ filters, setFilters, categories, hasPortfolio }) {
  const { executionStyle, setExecutionStyle } = useExecutionStyle();
  const update = (key, val) => setFilters((f) => ({ ...f, [key]: val }));

  const hasActiveFilters = useMemo(() => {
    return Object.keys(DEFAULT_FILTERS).some(key => {
      if (key === 'search') return false; // search is handled separately
      return !filtersEqual(filters[key], DEFAULT_FILTERS[key]);
    });
  }, [filters]);

  const handleReset = useCallback(() => {
    setFilters(prev => ({ ...DEFAULT_FILTERS, search: prev.search }));
  }, [setFilters]);

  const toggleCategory = useCallback((cat) => {
    setFilters((f) => {
      const selected = f.categories.includes(cat)
        ? f.categories.filter((c) => c !== cat)
        : [...f.categories, cat];
      return { ...f, categories: selected };
    });
  }, [setFilters]);

  const toggleResolutionType = useCallback((type) => {
    setFilters((f) => {
      const selected = (f.resolutionTypes || []).includes(type)
        ? f.resolutionTypes.filter((t) => t !== type)
        : [...(f.resolutionTypes || []), type];
      return { ...f, resolutionTypes: selected };
    });
  }, [setFilters]);

  return (
    <div className="w-full lg:w-72 shrink-0 bg-gray-900 border-r border-gray-800 p-4 overflow-y-auto">
      {hasActiveFilters && (
        <div className="mb-3 flex justify-end">
          <button
            onClick={handleReset}
            className="text-xs text-gray-500 hover:text-gray-200 transition-colors"
          >
            Reset filters
          </button>
        </div>
      )}

      {/* Execution Style Toggle */}
      <div className="mb-4">
        <div className="text-xs font-semibold text-gray-400 uppercase mb-1">Execution Style</div>
        <div className="flex rounded overflow-hidden border border-gray-700">
          <button
            onClick={() => setExecutionStyle('taker')}
            className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${executionStyle === 'taker' ? 'bg-gray-700 text-gray-100' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
          >
            Taker
          </button>
          <button
            onClick={() => setExecutionStyle('maker')}
            className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${executionStyle === 'maker' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
          >
            Maker
          </button>
        </div>
      </div>

      {/* Positive Edge After Fees Filter */}
      <label className="flex items-center gap-2 mb-4 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={filters.positiveEdgeAfterFees || false}
          onChange={(e) => update('positiveEdgeAfterFees', e.target.checked)}
          className="accent-emerald-400"
        />
        <span className="text-gray-300">Positive edge after fees only</span>
      </label>

      {/* Volume Range */}
      <DualRangeSlider
        label="Volume"
        min={0} max={50_000_000}
        value={filters.volumeRange}
        onChange={(v) => update('volumeRange', v)}
        displayFormat={(v) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${(v / 1_000).toFixed(0)}K`}
        logScale
      />

      {/* Yes Price Range */}
      <DualRangeSlider
        label="Yes Price"
        min={0} max={100}
        value={filters.yesPriceRange}
        onChange={(v) => update('yesPriceRange', v)}
        displayFormat={(v) => `${v}¢`}
      />

      {/* No Price Range */}
      <DualRangeSlider
        label="No Price"
        min={0} max={100}
        value={filters.noPriceRange}
        onChange={(v) => update('noPriceRange', v)}
        displayFormat={(v) => `${v}¢`}
      />

      {/* Days Left */}
      <DualRangeSlider
        label="Days Left"
        min={0} max={365}
        value={filters.daysLeftRange}
        onChange={(v) => update('daysLeftRange', v)}
      />

      {/* Categories */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Categories</label>
        <div className="mt-1 max-h-48 overflow-y-auto space-y-1">
          {categories.map((cat) => (
            <label key={cat} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={filters.categories.includes(cat)}
                onChange={() => toggleCategory(cat)}
                className="accent-emerald-500 rounded"
              />
              {cat}
            </label>
          ))}
        </div>
      </div>

      {/* FLB Opportunities Only */}
      <div className="mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
          <input
            type="checkbox"
            checked={filters.flbOnly}
            onChange={(e) => update('flbOnly', e.target.checked)}
            className="accent-emerald-500"
          />
          FLB Opportunities Only
        </label>
      </div>

      {/* Theta Filters */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Min Daily Theta (¢)</label>
        <input
          type="number"
          min="0"
          step="0.05"
          value={filters.minTheta}
          onChange={(e) => update('minTheta', parseFloat(e.target.value) || 0)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
          placeholder="0"
        />
      </div>
      <div className="mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
          <input
            type="checkbox"
            checked={filters.hideDeadMoney}
            onChange={(e) => update('hideDeadMoney', e.target.checked)}
            className="accent-emerald-500"
          />
          Hide Dead Money
        </label>
      </div>

      {/* Resolution Type */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Resolution Type</label>
        <div className="mt-1 space-y-1">
          {RESOLUTION_TYPES.map((rt) => (
            <label key={rt.value} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={(filters.resolutionTypes || []).includes(rt.value)}
                onChange={() => toggleResolutionType(rt.value)}
                className="accent-emerald-500 rounded"
              />
              {rt.label}
            </label>
          ))}
        </div>
      </div>

      {/* Min Strictness */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Min Strictness (0-100)</label>
        <input
          type="number"
          min="0"
          max="100"
          step="5"
          value={filters.minStrictness || 0}
          onChange={(e) => update('minStrictness', parseInt(e.target.value) || 0)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
          placeholder="0"
        />
      </div>

      {/* Vol-Price Priority */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Vol-Price Priority</label>
        <div className="mt-1 space-y-1">
          {PRIORITY_TYPES.map((pt) => (
            <label key={pt.value} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={(filters.volPriorities || []).includes(pt.value)}
                onChange={() => {
                  setFilters((f) => {
                    const cur = f.volPriorities || [];
                    const selected = cur.includes(pt.value)
                      ? cur.filter((t) => t !== pt.value)
                      : [...cur, pt.value];
                    return { ...f, volPriorities: selected };
                  });
                }}
                className="accent-emerald-500 rounded"
              />
              {pt.label}
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
          <input
            type="checkbox"
            checked={filters.hideEfficient || false}
            onChange={(e) => update('hideEfficient', e.target.checked)}
            className="accent-emerald-500"
          />
          Hide Efficient Markets
        </label>
      </div>

      {/* Min Narrative Premium */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Min Narrative Gap (¢)</label>
        <input
          type="number"
          min="0"
          max="50"
          step="1"
          value={filters.minNarrativeGap || 0}
          onChange={(e) => update('minNarrativeGap', parseFloat(e.target.value) || 0)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
          placeholder="0"
        />
      </div>

      {/* Base Rate Confidence */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Base Rate Confidence</label>
        <select
          value={filters.baseRateConfidence || 'any'}
          onChange={(e) => update('baseRateConfidence', e.target.value)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
        >
          <option value="any">Any</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium+</option>
        </select>
      </div>

      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Min Est. Edge (%)</label>
        <input
          type="number"
          min="0"
          max="30"
          step="1"
          value={filters.minEstEdge || 0}
          onChange={(e) => update('minEstEdge', parseFloat(e.target.value) || 0)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
          placeholder="0"
        />
      </div>

      {/* Conjunction Type */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Conjunction Type</label>
        <div className="mt-1 space-y-1">
          {CONJUNCTION_TYPES.map((ct) => (
            <label key={ct.value} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={(filters.conjunctionTypes || []).includes(ct.value)}
                onChange={() => {
                  setFilters((f) => {
                    const cur = f.conjunctionTypes || [];
                    const selected = cur.includes(ct.value)
                      ? cur.filter((t) => t !== ct.value)
                      : [...cur, ct.value];
                    return { ...f, conjunctionTypes: selected };
                  });
                }}
                className="accent-emerald-500 rounded"
              />
              {ct.label}
            </label>
          ))}
        </div>
      </div>

      {/* Min Conjunction Gap */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Min Conjunction Gap (pp)</label>
        <input
          type="number"
          min="0"
          max="50"
          step="1"
          value={filters.minConjunctionGap || 0}
          onChange={(e) => update('minConjunctionGap', parseFloat(e.target.value) || 0)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
          placeholder="0"
        />
      </div>

      {/* Portfolio Filter */}
      {hasPortfolio && (
        <div className="mb-4">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Portfolio Filter</label>
          <div className="mt-1 space-y-1">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={filters.highlightHeld !== false}
                onChange={(e) => update('highlightHeld', e.target.checked)}
                className="accent-emerald-500"
              />
              Highlight held positions
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={filters.hideHeld || false}
                onChange={(e) => update('hideHeld', e.target.checked)}
                className="accent-emerald-500"
              />
              Hide held markets
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
              <input
                type="checkbox"
                checked={filters.showPortfolioFit !== false}
                onChange={(e) => update('showPortfolioFit', e.target.checked)}
                className="accent-emerald-500"
              />
              Show portfolio fit
            </label>
          </div>
        </div>
      )}

      {/* Trade Flow Filters */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Flow Direction</label>
        <select
          value={filters.flowDirection || 'any'}
          onChange={(e) => update('flowDirection', e.target.value)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
        >
          <option value="any">Any</option>
          <option value="yes">Wallet Consensus Yes</option>
          <option value="no">Wallet Consensus No</option>
          <option value="divergence">Large/Small Divergence</option>
        </select>
      </div>
      <div className="mb-4 space-y-1">
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
          <input
            type="checkbox"
            checked={filters.leaderboardActive || false}
            onChange={(e) => update('leaderboardActive', e.target.checked)}
            className="accent-emerald-500"
          />
          Leaderboard Active
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-gray-100">
          <input
            type="checkbox"
            checked={filters.relevantExpertActive || false}
            onChange={(e) => update('relevantExpertActive', e.target.checked)}
            className="accent-emerald-500"
          />
          Relevant Expert Active
        </label>
      </div>

      {/* Sort By */}
      <div className="mb-4">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Sort By</label>
        <select
          value={filters.sortBy}
          onChange={(e) => update('sortBy', e.target.value)}
          className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 mt-2 text-sm text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.sortAsc}
            onChange={(e) => update('sortAsc', e.target.checked)}
            className="accent-emerald-500"
          />
          Ascending
        </label>
      </div>

    </div>
  );
}
