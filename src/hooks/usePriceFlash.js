import { useRef, useEffect } from 'react';

const UP = 'price-flash-up';
const DOWN = 'price-flash-down';
export const FLASH_DURATION_MS = 1000;

/**
 * Animate a row's YES/NO price cells when its price moves, via direct DOM
 * class toggling (no re-render).
 *
 * priceFlash is 'up:<seq>' / 'down:<seq>' (see utils/priceSnapshot) — the
 * sequence number makes two consecutive same-direction moves distinct, so
 * each one re-fires the animation. The hook removes its own classes after
 * FLASH_DURATION_MS, so the parent never has to render again to clear a
 * flash.
 *
 * @returns {{ yesCellRef, noCellRef }} refs to attach to the two price cells
 */
export function usePriceFlash(priceFlash) {
  const yesCellRef = useRef(null);
  const noCellRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!priceFlash) return;
    const yesCell = yesCellRef.current;
    const noCell = noCellRef.current;
    if (!yesCell || !noCell) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    yesCell.classList.remove(UP, DOWN);
    noCell.classList.remove(UP, DOWN);

    void yesCell.offsetWidth; // force reflow so the animation restarts
    const up = priceFlash.startsWith('up');
    yesCell.classList.add(up ? UP : DOWN);
    noCell.classList.add(up ? DOWN : UP);

    timerRef.current = setTimeout(() => {
      yesCell.classList.remove(UP, DOWN);
      noCell.classList.remove(UP, DOWN);
      timerRef.current = null;
    }, FLASH_DURATION_MS);
    // No cleanup here: priceFlash returning to null on the next tick must
    // not cancel the removal timer mid-animation. Unmount is handled below.
  }, [priceFlash]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { yesCellRef, noCellRef };
}
