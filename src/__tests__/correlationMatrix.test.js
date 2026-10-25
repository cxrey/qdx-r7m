// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import CorrelationMatrix from '../components/CorrelationMatrix';

afterEach(cleanup);

const positions = (n) => Array.from({ length: n }, (_, i) => ({ market: { id: `m${i}`, question: `Market ${i}?` }, side: 'YES' }));
const matrix = (n) => Array.from({ length: n }, () => Array(n).fill(0.5));

describe('CorrelationMatrix', () => {
  it('shows the cluster summary for a large portfolio even when it is one cluster (not an n² grid)', () => {
    const n = 40;
    const ps = positions(n);
    const { container } = render(h(CorrelationMatrix, {
      positions: ps, correlationMatrix: matrix(n),
      clusters: [{ name: 'Politics Cluster', positions: ps, risk: 'HIGH' }],
    }));
    expect(screen.getByText(/aggregated from 40 positions/)).toBeTruthy();
    expect(container.querySelectorAll('div').length).toBeLessThan(50);
  });

  it('still draws the grid for small portfolios', () => {
    const ps = positions(3);
    render(h(CorrelationMatrix, { positions: ps, correlationMatrix: matrix(3), clusters: [{ name: 'C', positions: ps, risk: 'LOW' }] }));
    expect(screen.getByText('Correlation Matrix')).toBeTruthy();
  });
});
