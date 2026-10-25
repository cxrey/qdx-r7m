import { describe, it, expect, vi } from 'vitest';
import { keepUnconfirmedMarkets, MAX_UNCONFIRMED_REFRESHES } from '../RefreshManager';

const m = (id) => ({ id, question: `Q ${id}` });

describe('keepUnconfirmedMarkets (Tier 3 after a partial crawl)', () => {
  it('a complete crawl is authoritative — missing markets are removed', () => {
    const crawled = [m('a'), m('b')];
    expect(keepUnconfirmedMarkets(crawled, [m('a'), m('b'), m('gone')], true)).toBe(crawled);
  });

  it('an incomplete crawl keeps current markets it did not reach', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = keepUnconfirmedMarkets([m('a'), m('new')], [m('a'), m('b'), m('c')], false);
    expect(result.map((x) => x.id)).toEqual(['a', 'new', 'b', 'c']);
  });

  it('prefers the freshly crawled copy over the current one', () => {
    const fresh = { id: 'a', question: 'Q a', yesPrice: 0.7 };
    const result = keepUnconfirmedMarkets([fresh], [{ id: 'a', question: 'Q a', yesPrice: 0.5 }], false);
    expect(result).toEqual([fresh]);
  });

  it('returns the crawled array untouched when nothing is missing', () => {
    const crawled = [m('a')];
    expect(keepUnconfirmedMarkets(crawled, [m('a')], false)).toBe(crawled);
  });

  it(`drops a market unconfirmed for ${MAX_UNCONFIRMED_REFRESHES} incomplete refreshes in a row`, () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const misses = new Map();
    const current = [m('a'), m('stuck')];
    const ids = () => keepUnconfirmedMarkets([m('a')], current, false, misses).map((x) => x.id);
    expect(ids()).toEqual(['a', 'stuck']); // miss 1
    expect(ids()).toEqual(['a', 'stuck']); // miss 2
    expect(ids()).toEqual(['a']);          // miss 3 → dropped
    expect(misses.has('stuck')).toBe(false);
  });

  it('resets the count when the market is seen again', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const misses = new Map();
    keepUnconfirmedMarkets([m('a')], [m('a'), m('b')], false, misses); // b missed once
    keepUnconfirmedMarkets([m('a'), m('b')], [m('a'), m('b')], false, misses); // b seen
    expect(misses.has('b')).toBe(false);
    keepUnconfirmedMarkets([m('a')], [m('a'), m('b')], false, misses);
    expect(misses.get('b')).toBe(1);
  });

  it('a complete crawl clears all counts', () => {
    const misses = new Map([['x', 2]]);
    keepUnconfirmedMarkets([m('a')], [m('a'), m('x')], true, misses);
    expect(misses.size).toBe(0);
  });
});
