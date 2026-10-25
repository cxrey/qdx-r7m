// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePriceFlash, FLASH_DURATION_MS } from '../hooks/usePriceFlash';

function setup(initial = null) {
  const yes = document.createElement('div');
  const no = document.createElement('div');
  const hook = renderHook(({ flash }) => {
    const refs = usePriceFlash(flash);
    // Attach cells before effects run (as JSX ref props would)
    refs.yesCellRef.current = yes;
    refs.noCellRef.current = no;
    return refs;
  }, { initialProps: { flash: initial } });
  return { ...hook, yes, no };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePriceFlash', () => {
  it('does nothing without a flash', () => {
    const { yes, no } = setup(null);
    expect(yes.className).toBe('');
    expect(no.className).toBe('');
  });

  it('flashes YES up and NO down on an up move', () => {
    const { yes, no, rerender } = setup(null);
    rerender({ flash: 'up:1' });
    expect(yes.classList.contains('price-flash-up')).toBe(true);
    expect(no.classList.contains('price-flash-down')).toBe(true);
  });

  it('flashes YES down and NO up on a down move', () => {
    const { yes, no, rerender } = setup(null);
    rerender({ flash: 'down:1' });
    expect(yes.classList.contains('price-flash-down')).toBe(true);
    expect(no.classList.contains('price-flash-up')).toBe(true);
  });

  it('removes its own classes after the animation', () => {
    const { yes, no, rerender } = setup(null);
    rerender({ flash: 'up:1' });
    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(yes.className).toBe('');
    expect(no.className).toBe('');
  });

  it('keeps animating when the parent clears the flash on the next tick', () => {
    // App replaces flashes every tick, so priceFlash returns to null ~1s
    // later. That must not cancel the removal timer mid-animation.
    const { yes, rerender } = setup(null);
    rerender({ flash: 'up:1' });
    vi.advanceTimersByTime(300);
    rerender({ flash: null });
    expect(yes.classList.contains('price-flash-up')).toBe(true);
    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(yes.className).toBe('');
  });

  it('re-fires for consecutive same-direction moves', () => {
    const { yes, rerender } = setup(null);
    rerender({ flash: 'up:1' });
    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(yes.className).toBe('');
    rerender({ flash: 'up:2' });
    expect(yes.classList.contains('price-flash-up')).toBe(true);
  });

  it('switches direction cleanly', () => {
    const { yes, rerender } = setup(null);
    rerender({ flash: 'up:1' });
    rerender({ flash: 'down:2' });
    expect(yes.classList.contains('price-flash-down')).toBe(true);
    expect(yes.classList.contains('price-flash-up')).toBe(false);
  });

  it('clears its timer on unmount', () => {
    const { rerender, unmount } = setup(null);
    rerender({ flash: 'up:1' });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
