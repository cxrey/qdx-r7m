import { describe, it, expect } from 'vitest';
import { formatVolumeShort } from '../formatters';

describe('formatVolumeShort (Volume slider boxes)', () => {
  it('prints whole dollars under $1K — "$0", not "$0K"', () => {
    expect(formatVolumeShort(0)).toBe('$0');
    expect(formatVolumeShort(999.6)).toBe('$1K');
    expect(formatVolumeShort(450)).toBe('$450');
  });

  it('prints thousands and millions compactly', () => {
    expect(formatVolumeShort(15_000)).toBe('$15K');
    expect(formatVolumeShort(1_000)).toBe('$1K');
    expect(formatVolumeShort(1_500_000)).toBe('$1.5M');
    expect(formatVolumeShort(50_000_000)).toBe('$50.0M');
  });
});
