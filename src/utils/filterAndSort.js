import { getVolEffSortValue } from '../VolumeEfficiencyEngine';
import { perfStart, perfEnd } from '../perfMonitor';

/**
 * Single-pass filter + sort for the markets table.
 *
 * Pure function — no React deps. Accepts all inputs explicitly
 * so it can be unit-tested without rendering a component.
 *
 * @param {object} opts
 * @param {object[]} opts.markets         — full processed markets array
 * @param {object}   opts.filters         — current filter/sort state
 * @param {string}   opts.searchLower     — pre-lowercased search text
 * @param {object}   opts.lookupState     — { isLookupActive, fetchedMarkets, foundInLoadedId }
 * @param {object}   opts.portfolio       — { hasPortfolio, isMarketHeld }
 * @param {string}   [opts.executionStyle='taker'] — 'maker' or 'taker', controls fee filter/sort behavior
 * @returns {object[]} filtered and sorted markets
 */
export function filterAndSort({ markets, filters, searchLower, lookupState, portfolio, executionStyle = 'taker' }) {
  const { isLookupActive, fetchedMarkets, foundInLoadedId } = lookupState;

  // If we have fetched markets from API lookup, show only those
  if (isLookupActive && fetchedMarkets.length > 0) {
    return fetchedMarkets;
  }

  const isLookupFoundInLoaded = isLookupActive && foundInLoadedId != null;
  const hasCategories = filters.categories.length > 0;
  const hasResTypes = filters.resolutionTypes?.length > 0;
  const hasVolPriorities = filters.volPriorities?.length > 0;
  const hasConjTypes = filters.conjunctionTypes?.length > 0;
  const minEdge = filters.minEstEdge > 0 ? filters.minEstEdge / 100 : 0;
  const brAllowed = filters.baseRateConfidence === 'HIGH' ? ['HIGH'] : filters.baseRateConfidence === 'MEDIUM' ? ['HIGH', 'MEDIUM'] : null;
  const hasSearch = !isLookupActive && searchLower.length > 0;
  // One case-insensitive regex per run instead of lowercasing every
  // question/description per market (several MB of garbage per pass).
  // 'u' gives Unicode case folding; only regex syntax chars are escaped
  // (escaping anything else is a SyntaxError in 'u' mode).
  const searchRe = hasSearch
    ? new RegExp(searchLower.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), 'iu')
    : null;

  // Pre-convert filter arrays to Sets for O(1) lookups in the hot loop
  const categorySet = hasCategories ? new Set(filters.categories) : null;
  const volPrioritySet = hasVolPriorities ? new Set(filters.volPriorities) : null;
  const resTypeSet = hasResTypes ? new Set(filters.resolutionTypes) : null;
  const conjTypeSet = hasConjTypes ? new Set(filters.conjunctionTypes) : null;
  const brSet = brAllowed ? new Set(brAllowed) : null;

  // Single-pass filter — cheapest checks first
  perfStart('filter-sort');
  const result = [];
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const isPinned = isLookupFoundInLoaded && m.id === foundInLoadedId;

    if (!isPinned) {
      // CHEAPEST: numeric comparisons
      if (m.volume < filters.volumeRange[0] || m.volume > filters.volumeRange[1]) continue;
      if (m.yesPrice != null) {
        const yc = m.yesPrice * 100;
        if (yc < filters.yesPriceRange[0] || yc > filters.yesPriceRange[1]) continue;
      }
      if (m.noPrice != null) {
        const nc = m.noPrice * 100;
        if (nc < filters.noPriceRange[0] || nc > filters.noPriceRange[1]) continue;
      }
      if (m.daysLeft != null) {
        if (m.daysLeft < filters.daysLeftRange[0] || m.daysLeft > filters.daysLeftRange[1]) continue;
      }

      // MEDIUM: set membership (O(1) per check)
      if (hasCategories && !categorySet.has(m.category)) continue;
      if (hasVolPriorities && !(m.volumeEfficiency && volPrioritySet.has(m.volumeEfficiency.priority))) continue;

      // NUMERIC thresholds
      if (filters.minStrictness > 0 && (m.resolutionAnalysis?.strictness?.score ?? 0) < filters.minStrictness) continue;
      if (filters.minNarrativeGap > 0 && (m.baseRate?.absGapCents ?? 0) < filters.minNarrativeGap) continue;
      if (filters.minTheta > 0 && (!m.theta || Math.abs(m.theta.bestTheta) * 100 < filters.minTheta)) continue;
      if (minEdge > 0 && (m.volumeEfficiency?.estimatedEdge ?? 0) < minEdge) continue;
      if (filters.minConjunctionGap > 0 && !(m.conjunction?.isConjunction && Math.abs(m.conjunction.gapPp ?? 0) >= filters.minConjunctionGap)) continue;

      // BOOLEAN toggles
      if (filters.flbOnly && !m.flb?.isBiasOpportunity) continue;
      if (filters.hideDeadMoney && m.theta?.zones?.includes('DEAD_MONEY')) continue;
      if (filters.hideEfficient && m.volumeEfficiency?.priority === 'EFFICIENT') continue;
      if (filters.positiveEdgeAfterFees) {
        const netEdge = executionStyle === 'maker' ? m.flb?.netEdgeMaker : m.flb?.netEdgeTaker;
        if (netEdge == null || netEdge <= 0) continue;
      }

      // Resolution types
      if (hasResTypes) {
        if (!m.resolutionAnalysis?.characteristics) continue;
        const hasMatch = m.resolutionAnalysis.characteristics.some((c) => c.confidence === 'HIGH' && resTypeSet.has(c.type));
        if (!hasMatch) continue;
      }

      // Base rate confidence
      if (brSet && !(m.baseRate && brSet.has(m.baseRate.confidence))) continue;

      // Conjunction types
      if (hasConjTypes) {
        if (conjTypeSet.has('NONE')) {
          if (m.conjunction?.isConjunction) continue;
        } else {
          if (!(m.conjunction?.isConjunction && conjTypeSet.has(m.conjunction.type))) continue;
        }
      }

      // Hide held — O(1) Set lookup
      if (filters.hideHeld && portfolio.hasPortfolio && portfolio.isMarketHeld(m.id)) continue;

      // MOST EXPENSIVE: string matching (last)
      if (hasSearch && !searchRe.test(m.question) && !searchRe.test(m.description)) continue;
    }

    result.push(m);
  }

  // Sort
  const dir = filters.sortAsc ? 1 : -1;
  result.sort((a, b) => {
    if (isLookupFoundInLoaded) {
      if (a.id === foundInLoadedId) return -1;
      if (b.id === foundInLoadedId) return 1;
    }

    let av, bv;
    switch (filters.sortBy) {
      case 'flbEdge':
        av = a.flb?.bestEdge ?? 0; bv = b.flb?.bestEdge ?? 0; break;
      case 'theta':
        av = Math.abs(a.theta?.bestTheta ?? 0); bv = Math.abs(b.theta?.bestTheta ?? 0); break;
      case 'strictness':
        av = a.resolutionAnalysis?.strictness?.score ?? 0; bv = b.resolutionAnalysis?.strictness?.score ?? 0; break;
      case 'impliedDailyRate':
        av = a.resolutionAnalysis?.temporal?.metrics?.impliedDailyRate ?? 0; bv = b.resolutionAnalysis?.temporal?.metrics?.impliedDailyRate ?? 0; break;
      case 'volEfficiency':
        av = getVolEffSortValue(a.volumeEfficiency); bv = getVolEffSortValue(b.volumeEfficiency); break;
      case 'effectiveVolume':
        av = a.volumeEfficiency?.effectiveVolume ?? 0; bv = b.volumeEfficiency?.effectiveVolume ?? 0; break;
      case 'volVelocity':
        av = a.volumeEfficiency?.recencyMultiplier ?? 0; bv = b.volumeEfficiency?.recencyMultiplier ?? 0; break;
      case 'baseRateGap':
        av = a.baseRate?.absGapCents ?? 0; bv = b.baseRate?.absGapCents ?? 0; break;
      case 'conjunctionGap':
        av = Math.abs(a.conjunction?.gapPp ?? 0); bv = Math.abs(b.conjunction?.gapPp ?? 0); break;
      case 'walletImbalance':
        av = Math.abs(a._flowImbalance ?? 0); bv = Math.abs(b._flowImbalance ?? 0); break;
      case 'fee':
        if (executionStyle === 'maker') {
          av = -(a.flb?.makerRebatePP ?? 0); bv = -(b.flb?.makerRebatePP ?? 0);
        } else {
          av = a.effectiveTakerFee ?? 0; bv = b.effectiveTakerFee ?? 0;
        }
        break;
      default:
        av = a[filters.sortBy] ?? 0; bv = b[filters.sortBy] ?? 0;
    }
    return (av - bv) * dir;
  });

  perfEnd('filter-sort', 50);
  return result;
}
