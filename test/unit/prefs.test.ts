import * as assert from 'assert';
import { MemStore } from '../controllerSetup';
import { CHART_RANGE_KEY, HEATMAP_SOURCE_KEY, PANEL_VIEW_KEY, PanelPrefs } from '../../src/panel/prefs';
import { buildPanelModel } from '../../src/panel/model';
import { setup } from '../controllerSetup';

describe('PanelPrefs', () => {
  it('defaults the chart range to 30D and persists a change', async () => {
    const mem = new MemStore();
    const prefs = new PanelPrefs(mem);
    assert.strictEqual(prefs.chartRange, '30D');
    await prefs.setChartRange('1D');
    assert.strictEqual(prefs.chartRange, '1D');
    assert.strictEqual(mem.data.get(CHART_RANGE_KEY), '1D');
    assert.strictEqual(new PanelPrefs(mem).chartRange, '1D', 'survives a restart (new instance over the same storage)');
  });

  it('ignores garbage in storage', () => {
    const mem = new MemStore();
    for (const bad of ['7D', 5, null, {}]) {
      mem.data.set(CHART_RANGE_KEY, bad);
      assert.strictEqual(new PanelPrefs(mem).chartRange, '30D');
    }
  });
});

describe('PanelPrefs view', () => {
  it('defaults to Stocks, persists a change and ignores garbage', async () => {
    const mem = new MemStore();
    const prefs = new PanelPrefs(mem);
    assert.strictEqual(prefs.view, 'stocks');
    await prefs.setView('crypto');
    assert.strictEqual(mem.data.get(PANEL_VIEW_KEY), 'crypto');
    assert.strictEqual(new PanelPrefs(mem).view, 'crypto');
    await prefs.setView('heatmap');
    assert.strictEqual(new PanelPrefs(mem).view, 'heatmap');
    for (const bad of ['bonds', 3, null]) {
      mem.data.set(PANEL_VIEW_KEY, bad);
      assert.strictEqual(new PanelPrefs(mem).view, 'stocks');
    }
  });
});

describe('PanelPrefs heatmap source', () => {
  it('defaults to the S&P 500, persists a change and ignores garbage', async () => {
    const mem = new MemStore();
    const prefs = new PanelPrefs(mem);
    assert.strictEqual(prefs.heatmapSource, 'SPX500');
    await prefs.setHeatmapSource('CRYPTO');
    assert.strictEqual(mem.data.get(HEATMAP_SOURCE_KEY), 'CRYPTO');
    assert.strictEqual(new PanelPrefs(mem).heatmapSource, 'CRYPTO');
    for (const bad of ['NIFTY50', 7, null]) {
      mem.data.set(HEATMAP_SOURCE_KEY, bad);
      assert.strictEqual(new PanelPrefs(mem).heatmapSource, 'SPX500');
    }
  });
});

describe('PanelPrefs write-through', () => {
  it('keeps returning what it last wrote even if the storage hands back a stale value (extension-host echo)', async () => {
    const stale = { get: <T>(_k: string, d: T): T => d, update: async () => undefined };
    const prefs = new PanelPrefs(stale);
    await prefs.setView('crypto');
    await prefs.setChartRange('1D');
    assert.strictEqual(prefs.view, 'crypto');
    assert.strictEqual(prefs.chartRange, '1D');
    await prefs.setView('stocks');
    assert.strictEqual(prefs.view, 'stocks');
  });
});

describe('buildPanelModel chartRange', () => {
  it('carries the selected range (default 30D)', () => {
    const { controller } = setup();
    assert.strictEqual(buildPanelModel(controller.snapshot).chartRange, '30D');
    assert.strictEqual(buildPanelModel(controller.snapshot, { range: '1D' }).chartRange, '1D');
    controller.dispose();
  });
});
