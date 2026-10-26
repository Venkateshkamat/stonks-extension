import * as assert from 'assert';
import { computeHoldingPnL, computeTotals, convert } from '../../src/portfolio/calc';
import { Holding, Quote } from '../../src/types';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

function q(price: number, prevClose: number, currency: 'INR' | 'USD'): Quote {
  return { symbol: 'X', price, prevClose, change: price - prevClose, changePercent: ((price - prevClose) / prevClose) * 100, currency, source: 'yahoo', time: 0 };
}
const h = (market: Holding['market'], quantity: number, buyPrice: number): Holding => ({ id: market + quantity, symbol: 'X', market, quantity, buyPrice });

describe('convert', () => {
  it('converts both ways and is identity for the same currency', () => {
    assert.strictEqual(convert(10, 'USD', 'INR', 90), 900);
    assert.strictEqual(convert(900, 'INR', 'USD', 90), 10);
    assert.strictEqual(convert(5, 'INR', 'INR', undefined), 5);
    assert.strictEqual(convert(5, 'USD', 'INR', undefined), undefined);
    assert.strictEqual(convert(5, 'USD', 'INR', 0), undefined);
  });
});

describe('computeHoldingPnL', () => {
  it('computes a gain in native currency', () => {
    const p = computeHoldingPnL(h('NSE', 10, 100), q(120, 118, 'INR'));
    assert.strictEqual(p.currency, 'INR');
    assert.strictEqual(p.invested, 1000);
    assert.strictEqual(p.current, 1200);
    assert.strictEqual(p.pnl, 200);
    near(p.pnlPercent, 20);
    assert.strictEqual(p.dayChange, 20);
    near(p.dayChangePercent, (2 / 118) * 100);
    assert.strictEqual(p.ltp, 120);
  });

  it('computes a loss and fractional crypto quantity', () => {
    const p = computeHoldingPnL(h('CRYPTO', 0.5, 80000), q(70000, 72000, 'USD'));
    assert.strictEqual(p.currency, 'USD');
    assert.strictEqual(p.pnl, -5000);
    near(p.pnlPercent, -12.5);
    assert.strictEqual(p.dayChange, -1000);
  });
});

describe('computeTotals', () => {
  const inr = computeHoldingPnL(h('NSE', 10, 100), q(120, 118, 'INR')); // 1000 -> 1200, day +20
  const usd = computeHoldingPnL(h('US', 2, 100), q(110, 100, 'USD')); // 200 -> 220, day +20 USD

  it('converts USD holdings into INR base at the current rate for both cost and value', () => {
    const t = computeTotals([{ pnl: inr }, { pnl: usd }], 'INR', 90);
    assert.strictEqual(t.invested, 1000 + 200 * 90);
    assert.strictEqual(t.current, 1200 + 220 * 90);
    assert.strictEqual(t.pnl, 200 + 20 * 90);
    near(t.pnlPercent, ((200 + 1800) / 19000) * 100);
    assert.strictEqual(t.dayChange, 20 + 20 * 90);
    near(t.dayChangePercent, (1820 / (1200 + 19800 - 1820)) * 100);
    assert.strictEqual(t.counted, 2);
    assert.strictEqual(t.skipped, 0);
  });

  it('converts INR holdings into USD base', () => {
    const t = computeTotals([{ pnl: inr }, { pnl: usd }], 'USD', 100);
    near(t.invested, 10 + 200);
    near(t.current, 12 + 220);
    near(t.pnlPercent, (22 / 210) * 100);
    assert.strictEqual(t.currency, 'USD');
  });

  it('percent reflects asset performance, independent of the fx rate for single-currency portfolios', () => {
    const a = computeTotals([{ pnl: usd }], 'INR', 80);
    const b = computeTotals([{ pnl: usd }], 'INR', 100);
    near(a.pnlPercent, 10);
    near(b.pnlPercent, 10);
  });

  it('skips holdings without a quote or needing a missing fx rate', () => {
    const t = computeTotals([{ pnl: inr }, { pnl: usd }, {}], 'INR', undefined);
    assert.strictEqual(t.counted, 1);
    assert.strictEqual(t.skipped, 2);
    assert.strictEqual(t.invested, 1000);
  });

  it('handles empty input', () => {
    const t = computeTotals([], 'INR', undefined);
    assert.strictEqual(t.pnlPercent, 0);
    assert.strictEqual(t.dayChangePercent, 0);
  });
});
