import * as assert from 'assert';
import { fixture } from '../helpers';
import { setup } from '../controllerSetup';
import { FakeTimers } from '../fakeTimers';
import { buildSnapshot, PortfolioSnapshot } from '../../src/portfolio/controller';
import { DEFAULT_SETTINGS } from '../../src/settings';

/** Tue 2026-10-27 10:30 IST: NSE open, US closed. */
const NSE_OPEN = Date.parse('2026-10-27T05:00:00Z');

describe('PortfolioController', () => {
  it('starts empty, then computes a snapshot with quotes, totals and fx in base currency', async () => {
    const { store, controller } = setup();
    assert.strictEqual(controller.snapshot.hasHoldings, false);
    assert.strictEqual(controller.snapshot.totals, undefined);

    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 2, buyPrice: 300 });
    await controller.refresh();

    const s = controller.snapshot;
    assert.strictEqual(s.holdings.length, 2);
    const rel = s.holdings[0];
    assert.strictEqual(rel.quote?.price, 1190);
    assert.strictEqual(rel.pnl?.invested, 10000);
    assert.strictEqual(rel.pnl?.pnl, 1900);
    assert.strictEqual(s.fxRate, 94.93);
    assert.strictEqual(s.baseCurrency, 'INR');
    assert.strictEqual(s.lastUpdated, 1_700_000_000_000);
    assert.strictEqual(s.loading, false);
    assert.deepStrictEqual(s.sources, ['yahoo']);
    assert.strictEqual(s.dataSource, 'Yahoo Finance');
    const expectedInvested = 10000 + 600 * 94.93;
    const expectedCurrent = 11900 + 2 * 347.725 * 94.93;
    assert.ok(Math.abs(s.totals!.invested - expectedInvested) < 1e-6);
    assert.ok(Math.abs(s.totals!.current - expectedCurrent) < 1e-6);
    assert.strictEqual(s.errors.length, 0);
    controller.dispose();
  });

  it('does not fetch fx when all holdings are in the base currency', async () => {
    const { store, controller, fetch } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    await controller.refresh();
    assert.ok(fetch.calls.every((c) => !c.includes('USDINR')));
    controller.dispose();
  });

  it('keeps going when one holding fails and reports it inline', async () => {
    const { store, controller } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1000 });
    await store.add({ symbol: 'BROKEN', market: 'US', quantity: 1, buyPrice: 1 });
    await controller.refresh();
    const s = controller.snapshot;
    assert.ok(s.holdings[0].quote);
    assert.ok(!s.holdings[1].quote);
    assert.ok(s.holdings[1].error);
    assert.strictEqual(s.errors.length, 1);
    assert.strictEqual(s.errors[0].scope, 'holding');
    assert.strictEqual(s.totals!.counted, 1);
    controller.dispose();
  });

  it('keeps the previous quote when a refresh fails for a holding', async () => {
    let fail = false;
    const { store, controller } = setup({ routes: [['/chart/AAPL?range=1d', () => (fail ? { status: 500 } : { body: fixture('yahoo/AAPL.1d.json') })], ['USDINR', { body: fixture('yahoo/USDINR.1d.json') }]] });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 100 });
    await controller.refresh();
    fail = true;
    await controller.refresh();
    const row = controller.snapshot.holdings[0];
    assert.strictEqual(row.quote?.price, 347.725);
    assert.ok(row.error);
    controller.dispose();
  });

  it('toggles hideAmounts without any network call and notifies listeners', async () => {
    const { store, controller, fetch } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1000 });
    await controller.refresh();
    const calls = fetch.calls.length;
    const seen: PortfolioSnapshot[] = [];
    controller.onDidUpdate((s) => seen.push(s));
    await controller.toggleHideAmounts();
    assert.strictEqual(controller.snapshot.hideAmounts, true);
    assert.ok(seen.length >= 1);
    assert.strictEqual(fetch.calls.length, calls);
    await controller.toggleHideAmounts();
    assert.strictEqual(controller.snapshot.hideAmounts, false);
    controller.dispose();
  });

  it('setBaseCurrency writes the setting, re-bases totals in the new currency and fetches fx', async () => {
    const { store, controller, settings, fetch } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    await controller.refresh();
    assert.strictEqual(controller.snapshot.totals?.currency, 'INR');
    assert.ok(fetch.calls.every((c) => !c.includes('USDINR')));
    await controller.setBaseCurrency('USD');
    assert.strictEqual(settings.value.baseCurrency, 'USD');
    await controller.refresh(); // settle the refresh kicked off by the change
    const t = controller.snapshot.totals!;
    assert.strictEqual(t.currency, 'USD');
    assert.ok(Math.abs(t.current - 11900 / 94.93) < 1e-6);
    assert.ok(fetch.calls.some((c) => c.includes('USDINR')));
    controller.dispose();
  });

  it('setRefreshIntervalSeconds writes the setting and reschedules the timer', async () => {
    const { store, controller, settings, fetch, clock } = setup({ settings: { refreshIntervalSeconds: 600 }, now: NSE_OPEN });
    const timers = new FakeTimers(clock);
    timers.install();
    try {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      const n = () => fetch.calls.filter((c) => c.includes('RELIANCE.NS')).length;
      const n0 = n();
      assert.strictEqual(controller.currentRefreshIntervalSeconds, 600);
      await controller.setRefreshIntervalSeconds(20);
      assert.strictEqual(settings.value.refreshIntervalSeconds, 20);
      assert.strictEqual(controller.currentRefreshIntervalSeconds, 20);
      await timers.advance(19_000);
      assert.strictEqual(n(), n0, 'no refresh before the new interval');
      await timers.advance(1_000);
      assert.strictEqual(n(), n0 + 1, 'refreshed after the new 20s interval, not the old 600s');
      controller.dispose();
    } finally {
      timers.uninstall();
    }
  });

  it('re-bases instantly on a currency change when the fx rate is already known', async () => {
    const { store, controller } = setup();
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 2, buyPrice: 300 });
    await controller.refresh();
    assert.strictEqual(controller.snapshot.totals?.currency, 'INR');
    const p = controller.setBaseCurrency('USD');
    await p;
    assert.strictEqual(controller.snapshot.baseCurrency, 'USD');
    assert.strictEqual(controller.snapshot.totals?.currency, 'USD');
    assert.ok(Math.abs(controller.snapshot.totals!.current - 2 * 347.725) < 1e-6);
    controller.dispose();
  });

  it('updates immediately when holdings change and refreshes quotes', async () => {
    const { store, controller } = setup();
    const a = await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1000 });
    await controller.refresh();
    assert.strictEqual(controller.snapshot.holdings.length, 1);
    await store.remove(a.id);
    assert.strictEqual(controller.snapshot.holdings.length, 0, 'removed holding disappears synchronously');
    assert.strictEqual(controller.snapshot.totals, undefined);
    controller.dispose();
  });

  it('fetches indices only when requested', async () => {
    const { controller, fetch } = setup();
    await controller.refresh();
    assert.ok(fetch.calls.every((c) => !c.includes('%5EGSPC')));
    controller.setIncludeIndices(true);
    await controller.refresh();
    assert.ok(fetch.calls.some((c) => c.includes('%5EGSPC')));
    assert.strictEqual(controller.snapshot.indices.length, 6);
    assert.ok(controller.snapshot.errors.some((e) => e.scope === 'index'), 'indices that failed are reported');
    controller.dispose();
  });

  it('coalesces overlapping refreshes', async () => {
    const { store, controller, fetch } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    await Promise.all([controller.refresh('manual'), controller.refresh('manual'), controller.refresh('manual')]);
    const quoteCalls = fetch.calls.filter((c) => c.includes('RELIANCE.NS')).length;
    assert.ok(quoteCalls <= 2, `expected at most 2 quote fetches, got ${quoteCalls}`);
    controller.dispose();
  });

  it('refreshes on the configured interval', async () => {
    const { store, controller, fetch, clock } = setup({ settings: { refreshIntervalSeconds: 30 }, now: NSE_OPEN });
    const timers = new FakeTimers(clock);
    timers.install();
    try {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      const after = () => fetch.calls.filter((c) => c.includes('RELIANCE.NS')).length;
      const n0 = after();
      await timers.advance(29_000);
      assert.strictEqual(after(), n0, 'no refresh before the interval');
      await timers.advance(1_000);
      assert.strictEqual(after(), n0 + 1, 'refreshed after 30s');
      controller.dispose();
    } finally {
      timers.uninstall();
    }
  });

  it('builds the 30-day history series from cached Yahoo history', async () => {
    const { store, controller } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 300, buyDate: '2026-10-20' });
    const series = await controller.getHistorySeries();
    assert.strictEqual(series.baseCurrency, 'INR');
    assert.ok(series.points.length > 15);
    const last = series.points[series.points.length - 1];
    assert.strictEqual(last.date, '2026-10-23');
    assert.ok(Math.abs(last.value - (10 * 1190 + 347.7300109863281 * 94.93)) < 1e-6);
    assert.strictEqual(series.errors.length, 0);
    const first = series.points[0];
    assert.strictEqual(first.invested, 10000, 'AAPL not counted before its buyDate');
    controller.dispose();
  });

  it('reports history errors per holding without throwing', async () => {
    const { store, controller } = setup({ routes: [['/chart/', { status: 500 }]] });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    const series = await controller.getHistorySeries();
    assert.deepStrictEqual(series.points, []);
    assert.strictEqual(series.errors.length, 1);
    controller.dispose();
  });
});

describe('buildSnapshot', () => {
  it('flags a Finnhub issue', () => {
    const s = buildSnapshot([], { quotes: new Map(), quoteErrors: new Map(), indices: [], finnhubIssue: 'bad key' }, DEFAULT_SETTINGS, false);
    assert.strictEqual(s.errors[0].scope, 'finnhub');
  });
});
