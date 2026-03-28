/**
 * refreshWorker.js — Web Worker for Tier 2 (new market discovery) and
 * Tier 3 (full catalog refresh) background timers.
 *
 * Runs independent of the main thread so timers fire even when the
 * tab's requestAnimationFrame is throttled.
 *
 * Messages IN:
 *   { type: 'start', tier2Interval, tier3Interval }
 *   { type: 'stop' }
 *   { type: 'updateIntervals', tier2Interval, tier3Interval }
 *   { type: 'resetTier3' }   — restart Tier 3 timer (after manual refresh)
 *
 * Messages OUT:
 *   { type: 'tier2Tick' }    — time for new-market discovery
 *   { type: 'tier3Tick' }    — time for full catalog refresh
 */

let tier2Timer = null;
let tier3Timer = null;
let tier2Interval = 5 * 60 * 1000;   // 5 minutes default
let tier3Interval = 30 * 60 * 1000;  // 30 minutes default

function startTimers() {
  stopTimers();
  tier2Timer = setInterval(() => {
    self.postMessage({ type: 'tier2Tick' });
  }, tier2Interval);
  tier3Timer = setInterval(() => {
    self.postMessage({ type: 'tier3Tick' });
  }, tier3Interval);
}

function stopTimers() {
  if (tier2Timer) { clearInterval(tier2Timer); tier2Timer = null; }
  if (tier3Timer) { clearInterval(tier3Timer); tier3Timer = null; }
}

self.onmessage = (e) => {
  const { type } = e.data;

  switch (type) {
    case 'start':
      if (e.data.tier2Interval) tier2Interval = e.data.tier2Interval;
      if (e.data.tier3Interval) tier3Interval = e.data.tier3Interval;
      startTimers();
      break;

    case 'stop':
      stopTimers();
      break;

    case 'updateIntervals':
      if (e.data.tier2Interval) tier2Interval = e.data.tier2Interval;
      if (e.data.tier3Interval) tier3Interval = e.data.tier3Interval;
      startTimers(); // restart with new intervals
      break;

    case 'resetTier3':
      // Restart Tier 3 timer (e.g., after manual refresh resets the clock)
      if (tier3Timer) { clearInterval(tier3Timer); }
      tier3Timer = setInterval(() => {
        self.postMessage({ type: 'tier3Tick' });
      }, tier3Interval);
      break;
  }
};
