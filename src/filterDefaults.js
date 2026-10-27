import { CATALOG_MIN_VOLUME } from './engineConfig';

// Slider tops. A range whose upper end is at the top means "no upper limit"
// (shown as "$50M+" / "365+"): markets above $50M volume or more than a year
// out used to be silently excluded by the default filters.
export const VOLUME_FILTER_MAX = 50_000_000;
export const DAYS_FILTER_MAX = 365;

export const DEFAULT_FILTERS = {
  // Starts at the catalog floor, so by default only markets that individually
  // clear it are shown. Lower-volume markets inside qualifying events are
  // loaded too and appear when the slider is lowered (its minimum is $0).
  volumeRange: [CATALOG_MIN_VOLUME, VOLUME_FILTER_MAX],
  yesPriceRange: [0, 100],
  noPriceRange: [0, 100],
  daysLeftRange: [0, DAYS_FILTER_MAX],
  categories: [],
  sortBy: 'edgeScore',
  sortAsc: false,
  perPage: 50,
  flbOnly: false,
  minTheta: 0,
  hideDeadMoney: false,
  resolutionTypes: [],
  minStrictness: 0,
  volPriorities: [],
  hideEfficient: false,
  minEstEdge: 0,
  minNarrativeGap: 0,
  baseRateConfidence: 'any',
  conjunctionTypes: [],
  minConjunctionGap: 0,
  // Portfolio filters
  highlightHeld: true,
  hideHeld: false,
  showPortfolioFit: true,
  // Trade flow filters
  flowDirection: 'any',
  leaderboardActive: false,
  relevantExpertActive: false,
};
