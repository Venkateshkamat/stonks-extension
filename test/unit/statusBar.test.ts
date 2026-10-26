import * as assert from 'assert';
import { fixture } from '../helpers';
import { setup } from '../controllerSetup';
import { buildStatusBarModel } from '../../src/statusBarModel';
import { buildSnapshot, FetchedData } from '../../src/portfolio/controller';
import { DEFAULT_SETTINGS, Settings } from '../../src/settings';
import { Holding, Quote } from '../../src/types';

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

  it('says in the tooltip when the markets behind the figures are closed, and not while they are open', async () => {
    const tooltipAt = async (iso: string, holdings: Array<[string, 'NSE' | 'US' | 'CRYPTO']>) => {
      const { store, controller } = setup({ now: Date.parse(iso) });
      for (const [symbol, market] of holdings) await store.add({ symbol, market, quantity: 1, buyPrice: 1 });
      await controller.refresh();
      const tip = buildStatusBarModel(controller.snapshot).tooltip;
      controller.dispose();
      return tip;
    };
    assert.match(await tooltipAt('2026-10-27T11:00:00Z', [['RELIANCE', 'NSE']]), /Market closed: India - showing the last close/);
    assert.doesNotMatch(await tooltipAt('2026-10-27T05:00:00Z', [['RELIANCE', 'NSE']]), /Market closed/);
    assert.match(await tooltipAt('2026-10-27T05:00:00Z', [['RELIANCE', 'NSE'], ['AAPL', 'US']]), /Market closed: US - /);
    assert.doesNotMatch(await tooltipAt('2026-10-24T05:00:00Z', [['BTC', 'CRYPTO']]), /Market closed/, 'crypto never closes');
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

describe('buildStatusBarModel: stocks and crypto separately', () => {
  const NOW = 1_700_000_000_000;
  const reliance: Holding = { id: 'h1', symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 };
  const aapl: Holding = { id: 'h2', symbol: 'AAPL', market: 'US', quantity: 2, buyPrice: 100 };
  const doge: Holding = { id: 'h3', symbol: 'DOGE', market: 'CRYPTO', quantity: 1000, buyPrice: 0.08 };
  const btc: Holding = { id: 'h4', symbol: 'BTC', market: 'CRYPTO', quantity: 0.5, buyPrice: 50_000 };

  function quote(symbol: string, price: number, prev: number): Quote {
    const change = price - prev;
    return { symbol, price, prevClose: prev, change, changePercent: (change / prev) * 100, currency: 'USD', source: 'yahoo', time: NOW };
  }

  /** prices: holding id -> [price, prevClose]; holdings without an entry have no quote yet. */
  function snap(holdings: Holding[], prices: Record<string, [number, number]>, settings: Partial<Settings> = {}) {
    const quotes = new Map<string, Quote>();
    for (const h of holdings) if (prices[h.id]) quotes.set(h.id, quote(h.symbol, prices[h.id][0], prices[h.id][1]));
    const data: FetchedData = { quotes, quoteErrors: new Map(), fx: { rate: 80, stale: false }, indices: [], lastUpdated: NOW };
    return buildSnapshot(holdings, data, { ...DEFAULT_SETTINGS, ...settings }, false);
  }

  it('groups the snapshot into stocks (NSE/BSE/US) and crypto totals in the base currency', () => {
    const s = snap([reliance, aapl, doge], { h1: [1190, 1180], h2: [120, 118], h3: [0.0832, 0.08] });
    assert.deepStrictEqual(s.groups.map((g) => [g.group, g.holdings]), [['stocks', 2], ['crypto', 1]]);
    const stocks = s.groups[0].totals!;
    // 10000 + 200*80 invested; 11900 + 240*80 current
    assert.strictEqual(stocks.invested, 10000 + 200 * 80);
    assert.strictEqual(stocks.current, 11900 + 240 * 80);
    const crypto = s.groups[1].totals!;
    assert.strictEqual(crypto.invested, 80 * 80);
    assert.ok(Math.abs(crypto.current - 83.2 * 80) < 1e-9);
    assert.ok(Math.abs(crypto.pnlPercent - 4) < 1e-9);
    assert.strictEqual(snap([], {}).groups.length, 0);
  });

  it('stocks only: just the one number, unlabelled, as before', () => {
    const m = buildStatusBarModel(snap([reliance, aapl], { h1: [1190, 1180], h2: [120, 118] }));
    assert.strictEqual(m.text, '$(graph) +19.00%'.replace('19.00', (((11900 + 240 * 80) / (10000 + 200 * 80) - 1) * 100).toFixed(2)));
    assert.strictEqual(m.tone, 'gain');
    assert.ok(!m.tooltip.includes('Stocks:'), 'no per-group breakdown for a single group');
    assert.ok(!m.tooltip.includes('Overall:'));
  });

  it('crypto only: labelled so it is not mistaken for stocks', () => {
    const m = buildStatusBarModel(snap([doge], { h3: [0.0832, 0.08] }));
    assert.strictEqual(m.text, '$(graph) Crypto +4.00%');
    assert.strictEqual(m.tone, 'gain');
    const loss = buildStatusBarModel(snap([doge], { h3: [0.07, 0.08] }));
    assert.strictEqual(loss.text, '$(graph) Crypto -12.50%');
    assert.strictEqual(loss.tone, 'loss');
  });

  it('both kinds: "Stocks +x% | Crypto +y%" with green when both are up', () => {
    const m = buildStatusBarModel(snap([reliance, doge], { h1: [1190, 1180], h3: [0.0832, 0.08] }));
    assert.strictEqual(m.text, '$(graph) Stocks +19.00% | Crypto +4.00%');
    assert.strictEqual(m.tone, 'gain');
  });

  it('both kinds: red when both are down, default when they disagree or one is flat', () => {
    assert.strictEqual(buildStatusBarModel(snap([reliance, doge], { h1: [900, 950], h3: [0.07, 0.08] })).tone, 'loss');
    const mixed = buildStatusBarModel(snap([reliance, doge], { h1: [1190, 1180], h3: [0.07, 0.08] }));
    assert.strictEqual(mixed.text, '$(graph) Stocks +19.00% | Crypto -12.50%');
    assert.strictEqual(mixed.tone, 'neutral');
    assert.strictEqual(buildStatusBarModel(snap([reliance, doge], { h1: [900, 950], h3: [0.08, 0.08] })).tone, 'neutral', 'a flat +0.00% is not a gain');
  });

  it('a group without quotes yet shows "--" and keeps the colour neutral', () => {
    const m = buildStatusBarModel(snap([reliance, doge], { h1: [1190, 1180] }));
    assert.strictEqual(m.text, '$(graph) Stocks +19.00% | Crypto --');
    assert.strictEqual(m.tone, 'neutral');
    assert.ok(m.tooltip.includes('Crypto: no quotes yet'));
  });

  it('tooltip breaks down both groups (with amounts) plus the overall total', () => {
    const m = buildStatusBarModel(snap([reliance, doge], { h1: [1190, 1180], h3: [0.0832, 0.08] }));
    const lines = m.tooltip.split('\n');
    assert.strictEqual(lines[0], 'Stonks - Portfolio');
    assert.ok(lines.includes('Stocks: P/L +19.00% | Today +0.85% (+₹100.00)'), m.tooltip);
    assert.ok(lines.includes('  Value: ₹11,900.00'));
    assert.ok(lines.includes('  Invested: ₹10,000.00'));
    assert.ok(lines.includes('  P/L: +₹1,900.00'));
    assert.ok(lines.some((l) => l.startsWith('Crypto: P/L +4.00% | Today +4.00% (+')));
    assert.ok(lines.includes('  Value: ₹6,656.00'));
    assert.ok(lines.indexOf('Overall:') > lines.indexOf('  P/L: +₹1,900.00'));
    assert.ok(lines.includes('Value: ₹18,556.00'), 'overall value after the breakdown');
    assert.ok(lines.includes('Invested: ₹16,400.00'));
    assert.ok(lines.some((l) => l.startsWith('Total P/L: +13.15%')));
  });

  it('hides amounts in the breakdown but keeps percentages', () => {
    const m = buildStatusBarModel(snap([reliance, doge], { h1: [1190, 1180], h3: [0.0832, 0.08] }, { hideAmounts: true }));
    assert.strictEqual(m.text, '$(graph) Stocks +19.00% | Crypto +4.00%');
    assert.ok(!m.tooltip.includes('₹') && !m.tooltip.includes('Value:'));
    assert.ok(m.tooltip.includes('Stocks: P/L +19.00% | Today +0.85%'));
  });

  it('computes each group in the base currency (USD base)', () => {
    const m = buildStatusBarModel(snap([aapl, btc], { h2: [120, 118], h4: [60_000, 59_000] }, { baseCurrency: 'USD' }));
    assert.strictEqual(m.text, '$(graph) Stocks +20.00% | Crypto +20.00%');
    assert.ok(m.tooltip.includes('  Value: $240.00'));
    assert.ok(m.tooltip.includes('  Value: $30,000.00'));
  });
});
