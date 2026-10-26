import * as assert from 'assert';
import { MemStore } from '../controllerSetup';
import { CHART_RANGE_KEY, PanelPrefs } from '../../src/panel/prefs';
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

describe('buildPanelModel chartRange', () => {
  it('carries the selected range (default 30D)', () => {
    const { controller } = setup();
    assert.strictEqual(buildPanelModel(controller.snapshot).chartRange, '30D');
    assert.strictEqual(buildPanelModel(controller.snapshot, { range: '1D' }).chartRange, '1D');
    controller.dispose();
  });
});
