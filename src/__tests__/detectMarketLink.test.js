import { describe, it, expect } from 'vitest';
import { detectMarketLink } from '../utils/detectMarketLink';

const COND = '0x' + 'a1'.repeat(32);

describe('detectMarketLink — IDs', () => {
  it('detects a 0x condition ID (bytes32 hex) — it used to fall through to text search', () => {
    expect(detectMarketLink(COND)).toEqual({ type: 'CONDITION_ID', extracted: COND, outcomeId: null });
    expect(detectMarketLink(COND.toUpperCase().replace('0X', '0x')).extracted).toBe(COND);
  });

  it('a long decimal number is a token ID; 4–8 digits a market ID', () => {
    expect(detectMarketLink('71321045679252212594626385532706912750332728571942532289631379312455583992563').type).toBe('TOKEN_ID');
    expect(detectMarketLink('559652').type).toBe('MARKET_ID');
  });

  it('0x strings of the wrong length are not condition IDs', () => {
    expect(detectMarketLink('0x' + 'a'.repeat(63)).type).toBe('TEXT');
    expect(detectMarketLink('0x1234').type).toBe('TEXT');
  });
});

describe('detectMarketLink — sports URLs', () => {
  it('a /sports/<league>/<event-slug> link is an event link (it used to be searched as text)', () => {
    expect(detectMarketLink('https://polymarket.com/sports/ufc/ufc-ran3-jac21-2026-10-31')).toEqual({
      type: 'EVENT_URL', extracted: 'ufc-ran3-jac21-2026-10-31', outcomeId: null,
    });
  });

  it('takes the last segment of deeper sports paths, and keeps ?tid', () => {
    const d = detectMarketLink('polymarket.com/sports/nfl/games/week/8/nfl-dal-phi-2026-10-26/?tid=123');
    expect(d).toMatchObject({ type: 'EVENT_URL', extracted: 'nfl-dal-phi-2026-10-26', outcomeId: '123' });
  });

  it('a league page with no event slug is not a link', () => {
    expect(detectMarketLink('https://polymarket.com/sports/ufc').type).toBe('TEXT');
    expect(detectMarketLink('https://polymarket.com/sports/ufc/').type).toBe('TEXT');
  });
});
