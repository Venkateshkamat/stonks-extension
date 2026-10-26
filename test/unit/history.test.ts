import * as assert from 'assert';
import { buildHistorySeries } from '../../src/portfolio/history';
import { Holding } from '../../src/types';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const hold = (id: string, market: Holding['market'], quantity: number, buyPrice: number, buyDate?: string): Holding => ({ id, symbol: id, market, quantity, buyPrice, buyDate });
const closes = (pairs: Array<[string, number]>) => pairs.map(([date, close]) => ({ date, close }));

describe('buildHistorySeries', () => {
  it('sums qty x close over the union of dates with forward-fill (holiday / weekend gaps)', () => {
    // US trades Mon-Fri; crypto every day. 2026-10-24/25 is a weekend.
    const us = hold('AAPL', 'US', 2, 100);
    const btc = hold('BTC', 'CRYPTO', 0.5, 50);
    const pts = buildHistorySeries(
      [
        { holding: us, closes: closes([['2026-10-22', 110], ['2026-10-23', 120]]) },
        { holding: btc, closes: closes([['2026-10-22', 1000], ['2026-10-23', 1010], ['2026-10-24', 1020], ['2026-10-25', 1030]]) },
      ],
      { base: 'USD', usdInr: 90 },
    );
    assert.deepStrictEqual(pts.map((p) => p.date), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    assert.strictEqual(pts[0].value, 2 * 110 + 0.5 * 1000);
    assert.strictEqual(pts[2].value, 2 * 120 + 0.5 * 1020, 'AAPL forward-filled over the weekend');
    assert.strictEqual(pts[3].value, 2 * 120 + 0.5 * 1030);
    assert.strictEqual(pts[0].invested, 2 * 100 + 0.5 * 50);
    near(pts[0].pnlPercent, ((720 - 225) / 225) * 100);
    assert.strictEqual(pts[0].pnl, 720 - 225);
  });

  it('honors buyDate: holding excluded before it, value and cost both', () => {
    const early = hold('A', 'US', 1, 10);
    const late = hold('B', 'US', 1, 20, '2026-10-23');
    const data = closes([['2026-10-22', 15], ['2026-10-23', 25], ['2026-10-24', 30]]);
    const pts = buildHistorySeries([{ holding: early, closes: data }, { holding: late, closes: data }], { base: 'USD', usdInr: undefined });
    assert.strictEqual(pts[0].value, 15);
    assert.strictEqual(pts[0].invested, 10);
    assert.strictEqual(pts[1].value, 25 + 25);
    assert.strictEqual(pts[1].invested, 10 + 20, 'buyDate itself is included');
    assert.strictEqual(pts[2].value, 60);
  });

  it('treats a missing buyDate as "held for the whole window"', () => {
    const pts = buildHistorySeries([{ holding: hold('A', 'US', 1, 10), closes: closes([['2026-10-01', 11], ['2026-10-02', 12]]) }], { base: 'USD', usdInr: undefined });
    assert.strictEqual(pts.length, 2);
    assert.strictEqual(pts[0].invested, 10);
  });

  it('omits days with no active holding (all bought later)', () => {
    const pts = buildHistorySeries([{ holding: hold('A', 'US', 1, 10, '2026-10-02'), closes: closes([['2026-10-01', 11], ['2026-10-02', 12]]) }], { base: 'USD', usdInr: undefined });
    assert.deepStrictEqual(pts.map((p) => p.date), ['2026-10-02']);
  });

  it('forward-fills from a close before the window start, and limits to 30 calendar days', () => {
    const many = closes([['2026-08-01', 5], ['2026-09-01', 6], ['2026-10-01', 7], ['2026-10-25', 9]]);
    const other = closes([['2026-10-10', 1], ['2026-10-25', 1]]);
    const pts = buildHistorySeries(
      [{ holding: hold('A', 'US', 1, 5), closes: many }, { holding: hold('B', 'US', 1, 1), closes: other }],
      { base: 'USD', usdInr: undefined, today: '2026-10-25' },
    );
    // window is 2026-09-26 .. 2026-10-25 -> dates 10-01, 10-10, 10-25
    assert.deepStrictEqual(pts.map((p) => p.date), ['2026-10-01', '2026-10-10', '2026-10-25']);
    assert.strictEqual(pts[1].value, 7 + 1, 'A forward-filled from 10-01');
    assert.strictEqual(pts[0].value, 7, 'B has no close yet on 10-01 and is not counted');
    assert.strictEqual(pts[0].invested, 5);
  });

  it('converts to the base currency with the given rate (mixed INR/USD)', () => {
    const inr = hold('R', 'NSE', 10, 100);
    const usd = hold('U', 'US', 1, 10);
    const d = closes([['2026-10-01', 1]]);
    const pts = buildHistorySeries([{ holding: inr, closes: closes([['2026-10-01', 110]]) }, { holding: usd, closes: closes([['2026-10-01', 12]]) }], { base: 'INR', usdInr: 90 });
    assert.strictEqual(pts[0].value, 1100 + 12 * 90);
    assert.strictEqual(pts[0].invested, 1000 + 10 * 90);
    const usdBase = buildHistorySeries([{ holding: inr, closes: d }], { base: 'USD', usdInr: 100 });
    near(usdBase[0].value, 10 * 1 / 100);
  });

  it('skips holdings whose currency cannot be converted and holdings without data', () => {
    const pts = buildHistorySeries(
      [
        { holding: hold('R', 'NSE', 1, 1), closes: closes([['2026-10-01', 100]]) },
        { holding: hold('U', 'US', 1, 1), closes: closes([['2026-10-01', 5]]) },
        { holding: hold('N', 'US', 1, 1), closes: undefined },
      ],
      { base: 'INR', usdInr: undefined },
    );
    assert.strictEqual(pts[0].value, 100);
  });

  it('returns [] when nothing has data', () => {
    assert.deepStrictEqual(buildHistorySeries([], { base: 'INR', usdInr: undefined }), []);
    assert.deepStrictEqual(buildHistorySeries([{ holding: hold('A', 'US', 1, 1), closes: [] }], { base: 'USD', usdInr: undefined }), []);
  });
});
