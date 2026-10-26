import * as assert from 'assert';
import { fixture } from '../helpers';
import { setup } from '../controllerSetup';
import { buildStatusBarModel } from '../../src/statusBarModel';

describe('buildStatusBarModel', () => {
  async function snap(hide = false, base: 'INR' | 'USD' = 'INR') {
    const { store, controller } = setup({ settings: { hideAmounts: hide, baseCurrency: base } });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    await controller.refresh();
    const s = controller.snapshot;
    controller.dispose();
    return s;
  }

  it('shows a plain label with no holdings', () => {
    const { controller } = setup();
    const m = buildStatusBarModel(controller.snapshot);
    assert.strictEqual(m.text, '$(graph) Stonks');
    assert.ok(m.tooltip.includes('Add holdings'));
    controller.dispose();
  });

  it('shows total P/L % with gain tone and amounts in the tooltip', async () => {
    const m = buildStatusBarModel(await snap());
    assert.strictEqual(m.text, '$(graph) +19.00%');
    assert.strictEqual(m.tone, 'gain');
    assert.ok(m.tooltip.includes('Total P/L: +19.00%'));
    assert.ok(m.tooltip.includes('Value: ₹11,900.00'));
    assert.ok(m.tooltip.includes('Invested: ₹10,000.00'));
    assert.ok(m.tooltip.includes('P/L: +₹1,900.00'));
    assert.ok(m.tooltip.includes('Today: +0.46%'));
    assert.ok(m.tooltip.includes('Data: Yahoo Finance'));
  });

  it('hides amounts in the tooltip but keeps percentages', async () => {
    const m = buildStatusBarModel(await snap(true));
    assert.strictEqual(m.text, '$(graph) +19.00%');
    assert.ok(!m.tooltip.includes('₹'));
    assert.ok(!m.tooltip.includes('Value:'));
    assert.ok(m.tooltip.includes('Today: +0.46%'));
  });

  it('uses loss tone for negative P/L', async () => {
    const { store, controller } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 2000 });
    await controller.refresh();
    const m = buildStatusBarModel(controller.snapshot);
    assert.strictEqual(m.tone, 'loss');
    assert.ok(m.text.includes('-40.50%'));
    controller.dispose();
  });

  it('shows a warning state when no quote could be loaded', async () => {
    const { store, controller } = setup({ routes: [['/chart/', { status: 500 }]] });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    await controller.refresh();
    const m = buildStatusBarModel(controller.snapshot);
    assert.strictEqual(m.tone, 'warning');
    assert.strictEqual(m.text, '$(graph) --');
    controller.dispose();
  });
});
