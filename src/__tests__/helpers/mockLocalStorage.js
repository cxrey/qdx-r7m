import { vi } from 'vitest';

/**
 * Shared localStorage mock for test files that test modules using localStorage.
 * Returns { mock, store } where store is the backing object for inspection.
 * All methods are vi.fn() spies so tests can assert on calls.
 *
 * Usage in beforeEach:
 *   const ls = setupLocalStorageMock();
 *   vi.stubGlobal('localStorage', ls.mock);
 *   // ls.store['key'] = '...' to pre-populate
 */
export function setupLocalStorageMock() {
  const store = {};
  const mock = {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, val) => { store[key] = val; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
  };
  return { mock, store };
}
