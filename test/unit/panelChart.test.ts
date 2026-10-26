import * as assert from 'assert';
import { buildChartModel } from '../../src/panel/chartModel';
import { HistorySeries } from '../../src/portfolio/controller';

function series(overrides: Partial<HistorySeries> = {}): HistorySeries {
  return {
    baseCurrency: 'INR',
    hideAmounts: false,
    points: [
      { date: '2026-10-12', value: 100000, invested: 90000, pnl: 10000, pnlPercent: 11.11 },
      { date: '2026-10-13', value: 101500.5, invested: 90000, pnl: 11500.5, pnlPercent: 12.78 },
      { date: '2026-10-14', value: 99000, invested: 90000, pnl: 9000, pnlPercent: 10 },
    ],
    errors: [],
    ...overrides,
  };
}

describe('buildChartModel', () => {
  it('plots value with INR formatting when amounts are shown', () => {
    const m = buildChartModel(series(), 'k');
    assert.strictEqual(m.mode, 'value');
    assert.strictEqual(m.key, 'k');
    assert.deepStrictEqual(m.values, [100000, 101500.5, 99000]);
    assert.deepStrictEqual(m.labels, ['12 Oct', '13 Oct', '14 Oct']);
    assert.strictEqual(m.tooltipTitles[0], 'Mon, 12 Oct 2026');
    assert.deepStrictEqual(m.tooltips[1], ['Value: ₹1,01,500.50', 'P/L: +₹11,500.50 (+12.78%)']);
    assert.deepStrictEqual(m.axis, { kind: 'money', symbol: '₹', locale: 'en-IN' });
    assert.ok(m.title.includes('₹') && m.title.includes('value'));
    assert.strictEqual(m.message, undefined);
  });

  it('plots P/L % and exposes no amounts when amounts are hidden', () => {
    const m = buildChartModel(series({ hideAmounts: true }), 'k');
    assert.strictEqual(m.mode, 'percent');
    assert.deepStrictEqual(m.values, [11.11, 12.78, 10]);
    assert.deepStrictEqual(m.tooltips[1], ['P/L: +12.78%']);
    assert.deepStrictEqual(m.axis, { kind: 'percent' });
    const json = JSON.stringify(m);
    assert.ok(!json.includes('₹') && !json.includes('100000') && !json.includes('1,01'));
  });

  it('uses USD formatting for a USD base', () => {
    const m = buildChartModel(series({ baseCurrency: 'USD' }), 'k');
    assert.ok(m.tooltips[0][0].startsWith('Value: $'));
    assert.strictEqual(m.axis.symbol, '$');
  });

  it('derives the trend from first vs last plotted value', () => {
    assert.strictEqual(buildChartModel(series(), 'k').trend, 'loss');
    const up = series();
    up.points = [up.points[2], up.points[1]];
    assert.strictEqual(buildChartModel(up, 'k').trend, 'gain');
    up.points = [up.points[0], { ...up.points[0], date: '2026-10-13' }];
    assert.strictEqual(buildChartModel(up, 'k').trend, 'neutral');
  });

  it('returns a message instead of data when there are no points', () => {
    const m = buildChartModel(series({ points: [] }), 'k');
    assert.strictEqual(m.message, 'No price history available.');
    assert.deepStrictEqual(m.values, []);
  });

  it('reports failures and passes per-symbol errors through', () => {
    const m = buildChartModel(series({ points: [], errors: ['NSE:FOO: HTTP 500'] }), 'k');
    assert.strictEqual(m.message, 'Could not load price history.');
    assert.deepStrictEqual(m.errors, ['NSE:FOO: HTTP 500']);
    const partial = buildChartModel(series({ errors: ['US:BAR: timeout'] }), 'k');
    assert.strictEqual(partial.message, undefined);
    assert.deepStrictEqual(partial.errors, ['US:BAR: timeout']);
  });
});
