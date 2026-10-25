import { describe, it, expect, vi } from 'vitest';
import { keepUnconfirmedMarkets } from '../RefreshManager';

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
});
