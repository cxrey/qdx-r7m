import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTERS, VOLUME_FILTER_MAX } from '../filterDefaults';
import { CATALOG_MIN_VOLUME } from '../engineConfig';

describe('DEFAULT_FILTERS', () => {
  it('defaults the Volume filter to the catalog floor', () => {
    expect(DEFAULT_FILTERS.volumeRange).toEqual([CATALOG_MIN_VOLUME, VOLUME_FILTER_MAX]);
    expect(CATALOG_MIN_VOLUME).toBe(15_000);
  });

  it('has no search key (search text is separate state in App)', () => {
    expect('search' in DEFAULT_FILTERS).toBe(false);
  });
});
