import * as assert from 'assert';
import { findHeatmapSource, heatmapConfig, HEATMAP_SOURCES, isHeatmapSource, isPanelView, PANEL_VIEWS, viewGroup } from '../../src/panel/views';

describe('panel views', () => {
  it('are Stocks, Crypto and Heatmap; only the first two have a portfolio group', () => {
    assert.deepStrictEqual(PANEL_VIEWS, ['stocks', 'crypto', 'heatmap']);
    assert.strictEqual(viewGroup('stocks'), 'stocks');
    assert.strictEqual(viewGroup('crypto'), 'crypto');
    assert.strictEqual(viewGroup('heatmap'), undefined);
    for (const bad of ['Stocks', '', 1, null, undefined]) assert.strictEqual(isPanelView(bad), false);
    assert.strictEqual(isPanelView('heatmap'), true);
  });
});

describe('heatmap sources', () => {
  it('offers S&P 500, Nasdaq 100, Dow 30, SENSEX (TradingView stock heatmap) and Crypto (coins heatmap) - no Nifty', () => {
    assert.deepStrictEqual(HEATMAP_SOURCES.map((s) => [s.id, s.widget]), [
      ['SPX500', 'stock'],
      ['NASDAQ100', 'stock'],
      ['DJDJI', 'stock'],
      ['SENSEX', 'stock'],
      ['CRYPTO', 'crypto'],
    ]);
    assert.ok(!HEATMAP_SOURCES.some((s) => /nifty/i.test(s.id + s.label)), "TradingView's widget has no Nifty index (renders blank)");
  });

  it('validates ids and resolves unknown ones to the first source', () => {
    assert.strictEqual(isHeatmapSource('SENSEX'), true);
    for (const bad of ['NIFTY50', 'sensex', '', 4, null, undefined]) assert.strictEqual(isHeatmapSource(bad), false);
    assert.strictEqual(findHeatmapSource('nope').id, 'SPX500');
  });

  it('builds the stock heatmap config with the verified TradingView dataSource values', () => {
    for (const id of ['SPX500', 'NASDAQ100', 'DJDJI', 'SENSEX']) {
      const c = heatmapConfig(id);
      assert.strictEqual(c.dataSource, id);
      assert.strictEqual(c.blockSize, 'market_cap_basic');
      assert.strictEqual(c.blockColor, 'change');
      assert.strictEqual(c.grouping, 'sector');
      assert.strictEqual(c.width, '100%');
      assert.strictEqual(c.height, '100%');
      assert.strictEqual(c.isTransparent, true);
      assert.strictEqual(c.hasTopBar, true);
      assert.ok(!('colorTheme' in c));
    }
  });

  it('builds the crypto coins heatmap config from the widget defaults', () => {
    const c = heatmapConfig('CRYPTO');
    assert.strictEqual(c.dataSource, 'Crypto');
    assert.strictEqual(c.blockSize, 'market_cap_calc');
    assert.strictEqual(c.blockColor, '24h_close_change|5');
    assert.ok(!('grouping' in c), 'the coins widget has no sector grouping');
  });

  it('config is plain JSON (it becomes the widget script text)', () => {
    for (const s of HEATMAP_SOURCES) assert.deepStrictEqual(JSON.parse(JSON.stringify(heatmapConfig(s.id))), heatmapConfig(s.id));
  });
});
