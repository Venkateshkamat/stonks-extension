import * as assert from 'assert';
import { fixture, mockFetch } from '../helpers';
import { FIXTURE_NOW, setup } from '../controllerSetup';
import { MarketDataService } from '../../src/market/marketData';
import { parseYahooIntraday } from '../../src/market/yahoo';
import { NotFoundError } from '../../src/market/http';
import { buildChartModel } from '../../src/panel/chartModel';
import { buildIntradaySeries, DAY_MS } from '../../src/portfolio/history';
import { Holding, IntradayPoint } from '../../src/types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const hold = (id: string, market: Holding['market'], quantity: number, buyPrice: number, buyDate?: string): Holding => ({ id, symbol: id, market, quantity, buyPrice, buyDate });

/** 2026-10-23 12:00 UTC. All synthetic times are offsets in 15-minute steps from here. */
const T0 = Date.UTC(2026, 9, 23, 12, 0);
const q = (n: number) => T0 + n * 15 * 60_000;
const pts = (pairs: Array<[number, number]>): IntradayPoint[] => pairs.map(([n, close]) => ({ t: q(n), close }));
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('parseYahooIntraday', () => {
  it('parses the live AAPL range=5d&interval=15m fixture (regular session bars only)', () => {
    const p = parseYahooIntraday(fixture('yahoo/AAPL.5d15m.json'), 'AAPL');
    assert.strictEqual(p.length, 131);
    assert.strictEqual(p[0].t, 1792416600 * 1000);
    assert.strictEqual(p[p.length - 1].t, 1792785600 * 1000);
    assert.ok(p.every((x, i) => i === 0 || x.t > p[i - 1].t), 'ascending');
  });

  it('skips null closes (USDINR=X has many) and keeps ascending order', () => {
    const p = parseYahooIntraday(fixture('yahoo/USDINR.5d15m.json'), 'USDINR=X');
    assert.strictEqual(p.length, 387 - 217);
    assert.ok(p.every((x) => x.close > 50 && x.close < 200));
  });

  it('handles crypto (24/7 bars, last bar is the live partial one) and NSE', () => {
    const btc = parseYahooIntraday(fixture('yahoo/BTC-USD.5d15m.json'), 'BTC-USD');
    assert.strictEqual(btc.length, 398);
    assert.strictEqual(btc[btc.length - 1].t, 1792984471 * 1000);
    const rel = parseYahooIntraday(fixture('yahoo/RELIANCE.NS.5d15m.json'), 'RELIANCE.NS');
    assert.strictEqual(rel[0].t, 1792122300 * 1000);
  });

  it('de-duplicates identical timestamps and tolerates a missing timestamp array', () => {
    const json = { chart: { result: [{ timestamp: [10, 20, 20, 30], indicators: { quote: [{ close: [1, 2, 3, null] }] } }], error: null } };
    assert.deepStrictEqual(parseYahooIntraday(json, 'X'), [{ t: 10_000, close: 1 }, { t: 20_000, close: 3 }]);
    assert.deepStrictEqual(parseYahooIntraday({ chart: { result: [{ indicators: { quote: [{}] } }], error: null } }, 'X'), []);
  });

  it('throws NotFoundError for an unknown symbol', () => {
    assert.throws(() => parseYahooIntraday(fixture('yahoo/notfound.json'), 'ZZZZ'), NotFoundError);
  });
});

describe('buildIntradaySeries', () => {
  const opts = { base: 'USD' as const, usdInr: undefined, now: q(200), dateOf: utcDate };

  it('uses the union of bar times and forward-fills each holding', () => {
    const a = hold('A', 'US', 2, 10);
    const b = hold('B', 'US', 1, 20);
    const out = buildIntradaySeries(
      [
        { holding: a, points: pts([[0, 100], [1, 101], [2, 102]]) },
        { holding: b, points: pts([[1, 50], [3, 52]]) },
      ],
      opts,
    );
    assert.deepStrictEqual(out.map((p) => p.time), [q(0), q(1), q(2), q(3)]);
    assert.strictEqual(out[0].value, 200, 'B has no close at or before t0, so only A counts');
    assert.strictEqual(out[0].invested, 20);
    assert.strictEqual(out[1].value, 2 * 101 + 50);
    assert.strictEqual(out[2].value, 2 * 102 + 50, 'B forward-filled from its 15:15 bar');
    assert.strictEqual(out[3].value, 2 * 102 + 52, 'A forward-filled');
    assert.strictEqual(out[3].invested, 2 * 10 + 20);
    near(out[3].pnlPercent, ((256 - 40) / 40) * 100);
    assert.strictEqual(out[0].date, '2026-10-23');
  });

  it('back-fills a holding that has no bar in the window yet from its last value before the window', () => {
    const crypto = hold('BTC', 'CRYPTO', 1, 1000);
    const stock = hold('S', 'US', 10, 5);
    const startOfWindow = q(200) - DAY_MS;
    const out = buildIntradaySeries(
      [
        { holding: crypto, points: pts([[190, 1000], [191, 1010], [192, 1020]]) },
        // last stock bar is 3 days old: outside the 24h window, but its close seeds the whole chart
        { holding: stock, points: [{ t: startOfWindow - 3 * DAY_MS, close: 7 }] },
      ],
      { ...opts, now: q(200) },
    );
    assert.ok(out.length > 0);
    for (const p of out) assert.ok(p.time! >= startOfWindow && p.time! <= q(200));
    assert.deepStrictEqual(out.map((p) => p.value), [1000 + 70, 1010 + 70, 1020 + 70].slice(0, out.length));
  });

  it('only plots bar times inside the 24h window', () => {
    const a = hold('A', 'US', 1, 1);
    const out = buildIntradaySeries([{ holding: a, points: pts([[0, 1], [50, 2], [150, 3], [200, 4]]) }], opts);
    // window = [q(200) - 96 bars, q(200)] = [q(104), q(200)]
    assert.deepStrictEqual(out.map((p) => p.time), [q(150), q(200)]);
    assert.strictEqual(out[0].value, 3);
  });

  it('anchors the window at the newest bar when markets are closed (weekend, stocks only)', () => {
    const a = hold('A', 'US', 1, 1);
    const weekendNow = q(200) + 3 * DAY_MS;
    const out = buildIntradaySeries([{ holding: a, points: pts([[100, 5], [150, 6], [200, 7]]) }], { ...opts, now: weekendNow });
    assert.deepStrictEqual(out.map((p) => p.time), [q(150), q(200)].filter((t) => t >= q(200) - DAY_MS));
    assert.strictEqual(out[out.length - 1].value, 7);
  });

  it('excludes holdings from points earlier than their buyDate (local calendar date of the point)', () => {
    const early = hold('A', 'US', 1, 10);
    const late = hold('B', 'US', 1, 20, '2026-10-24');
    // T0 = 2026-10-23 12:00 UTC; q(48) = 2026-10-24 00:00 UTC
    const data = pts([[40, 100], [47, 101], [48, 102], [60, 103]]);
    const out = buildIntradaySeries([{ holding: early, points: data }, { holding: late, points: data }], { ...opts, now: q(60) });
    const at = (n: number) => out.find((p) => p.time === q(n))!;
    assert.strictEqual(at(47).value, 101, 'B not counted before its buyDate');
    assert.strictEqual(at(47).invested, 10);
    assert.strictEqual(at(48).value, 204, 'B counted from the buyDate midnight');
    assert.strictEqual(at(48).invested, 30);
  });

  it('converts cross-currency holdings with the intraday USDINR rate at each point (forward-filled, back-filled at the start)', () => {
    const us = hold('A', 'US', 2, 100);
    const fxSeries = pts([[1, 80], [3, 90]]);
    const out = buildIntradaySeries(
      [{ holding: us, points: pts([[0, 10], [1, 10], [2, 10], [3, 10]]) }],
      { base: 'INR', usdInr: 999, fxSeries, now: q(10), dateOf: utcDate },
    );
    assert.deepStrictEqual(out.map((p) => p.value), [2 * 10 * 80, 2 * 10 * 80, 2 * 10 * 80, 2 * 10 * 90]);
    assert.strictEqual(out[3].invested, 2 * 100 * 90);
    near(out[3].pnlPercent, ((1800 - 18000) / 18000) * 100);
  });

  it('converts INR holdings to a USD base by dividing by the rate', () => {
    const inr = hold('R', 'NSE', 10, 1000);
    const out = buildIntradaySeries([{ holding: inr, points: pts([[0, 1000]]) }], { base: 'USD', usdInr: 80, now: q(10), dateOf: utcDate });
    assert.strictEqual(out[0].value, (10 * 1000) / 80);
  });

  it('falls back to the scalar rate without an fx series, and skips cross-currency holdings with no rate at all', () => {
    const us = hold('A', 'US', 1, 1);
    const inr = hold('R', 'NSE', 1, 1);
    const withScalar = buildIntradaySeries([{ holding: us, points: pts([[0, 2]]) }, { holding: inr, points: pts([[0, 100]]) }], { base: 'INR', usdInr: 50, now: q(5), dateOf: utcDate });
    assert.strictEqual(withScalar[0].value, 2 * 50 + 100);
    const noRate = buildIntradaySeries([{ holding: us, points: pts([[0, 2]]) }, { holding: inr, points: pts([[0, 100]]) }], { base: 'INR', usdInr: undefined, now: q(5), dateOf: utcDate });
    assert.strictEqual(noRate[0].value, 100, 'USD holding skipped');
    const onlyUsd = buildIntradaySeries([{ holding: us, points: pts([[0, 2]]) }], { base: 'INR', usdInr: undefined, now: q(5), dateOf: utcDate });
    assert.deepStrictEqual(onlyUsd, []);
  });

  it('ignores holdings whose intraday data failed to load; empty input gives an empty series', () => {
    const a = hold('A', 'US', 1, 1);
    assert.deepStrictEqual(buildIntradaySeries([{ holding: a, points: undefined }, { holding: a, points: [] }], opts), []);
    assert.deepStrictEqual(buildIntradaySeries([], opts), []);
    const out = buildIntradaySeries([{ holding: a, points: undefined }, { holding: hold('B', 'US', 1, 1), points: pts([[0, 4]]) }], opts);
    assert.strictEqual(out[0].value, 4);
  });
});

describe('MarketDataService intraday', () => {
  const ref = { symbol: 'AAPL', market: 'US' } as const;
  function svc(routes: Parameters<typeof mockFetch>[0], t: { now: number }, ttl?: number) {
    const f = mockFetch(routes);
    return { f, s: new MarketDataService({ fetch: f, getFinnhubKey: () => undefined, now: () => t.now, intradayTtlMs: ttl }) };
  }

  it('requests range=5d&interval=15m, caches for 5 minutes and refetches afterwards', async () => {
    const t = { now: 1_000_000 };
    const { f, s } = svc([['/chart/AAPL?', { body: fixture('yahoo/AAPL.5d15m.json') }]], t);
    const a = await s.getIntraday(ref);
    assert.strictEqual(a.length, 131);
    assert.ok(f.calls[0].endsWith('/chart/AAPL?range=5d&interval=15m'), f.calls[0]);
    t.now += 4 * 60_000;
    await s.getIntraday({ symbol: 'aapl', market: 'US' });
    assert.strictEqual(f.calls.length, 1, 'cached within 5 minutes');
    t.now += 61_000;
    await s.getIntraday(ref);
    assert.strictEqual(f.calls.length, 2, 'refetched after 5 minutes');
  });

  it('shares one in-flight request and does not cache failures', async () => {
    const t = { now: 0 };
    let n = 0;
    const { f, s } = svc([['/chart/AAPL?', () => (n++ === 0 ? { status: 500 } : { body: fixture('yahoo/AAPL.5d15m.json') })]], t);
    await assert.rejects(s.getIntraday(ref));
    const [x, y] = await Promise.all([s.getIntraday(ref), s.getIntraday(ref)]);
    assert.strictEqual(x, y);
    assert.strictEqual(f.calls.length, 2);
  });

  it('serves stale intraday data when a refetch fails', async () => {
    const t = { now: 0 };
    let fail = false;
    const { s } = svc([['/chart/AAPL?', () => (fail ? { status: 500 } : { body: fixture('yahoo/AAPL.5d15m.json') })]], t);
    await s.getIntraday(ref);
    t.now += 6 * 60_000;
    fail = true;
    assert.strictEqual((await s.getIntraday(ref)).length, 131);
  });

  it('fetches the USDINR=X intraday series', async () => {
    const t = { now: 0 };
    const { f, s } = svc([['USDINR%3DX?', { body: fixture('yahoo/USDINR.5d15m.json') }]], t);
    assert.strictEqual((await s.getFxIntraday()).length, 170);
    assert.ok(f.calls[0].includes('USDINR%3DX?range=5d&interval=15m'));
  });

  it('falls back to the NSE intraday series when the BSE one is sparse', async () => {
    const sparse = { chart: { result: [{ timestamp: [1792751372], indicators: { quote: [{ close: [1190] }] } }], error: null } };
    const t = { now: 0 };
    const { f, s } = svc([['/RELIANCE.BO?', { body: sparse }], ['/RELIANCE.NS?', { body: fixture('yahoo/RELIANCE.NS.5d15m.json') }]], t);
    const h = await s.getIntraday({ symbol: 'RELIANCE', market: 'BSE' });
    assert.strictEqual(h.length, 125);
    assert.strictEqual(f.calls.length, 2);
  });
});

describe('PortfolioController 1D / 15D / 30D series', () => {
  it('builds the 1D series from the live-shaped fixtures: union of times, fx from the intraday series, last 24h only', async () => {
    const { store, controller } = setup({ now: FIXTURE_NOW });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 2, buyPrice: 300 });
    await store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 0.01, buyPrice: 50_000 });
    const series = await controller.getHistorySeries('1D');
    assert.strictEqual(series.range, '1D');
    assert.deepStrictEqual(series.errors, []);
    assert.ok(series.points.length > 90, `expected ~96+ crypto bars, got ${series.points.length}`);
    const first = series.points[0].time!;
    const last = series.points[series.points.length - 1].time!;
    assert.strictEqual(last, 1792984471 * 1000, 'ends at the newest bar (BTC live bar)');
    assert.ok(last - first <= DAY_MS);
    assert.ok(series.points.every((p, i) => i === 0 || p.time! > series.points[i - 1].time!));
    // Independent expectation for the final point: RELIANCE last bar 1190 (INR), AAPL last bar x USDINR, BTC last bar x USDINR.
    const fx = parseYahooIntraday(fixture('yahoo/USDINR.5d15m.json'), 'USDINR=X');
    const rate = fx.filter((p) => p.t <= last).pop()!.close;
    const aapl = parseYahooIntraday(fixture('yahoo/AAPL.5d15m.json'), 'AAPL').pop()!.close;
    const rel = parseYahooIntraday(fixture('yahoo/RELIANCE.NS.5d15m.json'), 'RELIANCE.NS').pop()!.close;
    const btc = parseYahooIntraday(fixture('yahoo/BTC-USD.5d15m.json'), 'BTC-USD').pop()!.close;
    near(series.points[series.points.length - 1].value, 10 * rel + 2 * aapl * rate + 0.01 * btc * rate, 1e-4);
    controller.dispose();
  });

  it('1D uses only the group filter when asked (crypto subset)', async () => {
    const { store, controller } = setup({ now: FIXTURE_NOW });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 2, buyPrice: 300 });
    await store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 0.01, buyPrice: 50_000 });
    const crypto = await controller.getHistorySeries('1D', 'crypto');
    const btc = parseYahooIntraday(fixture('yahoo/BTC-USD.5d15m.json'), 'BTC-USD');
    assert.strictEqual(crypto.points[crypto.points.length - 1].invested > 0, true);
    near(crypto.points[crypto.points.length - 1].value, 0.01 * btc[btc.length - 1].close * 94.93, 0.5);
    const stocks = await controller.getHistorySeries('1D', 'stocks');
    assert.ok(stocks.points.length > 0 && stocks.points.length < crypto.points.length, 'stocks only have session bars in the window');
    controller.dispose();
  });

  it('reports intraday errors per holding without throwing, and returns no points', async () => {
    const { store, controller } = setup({ now: FIXTURE_NOW, routes: [['/chart/', { status: 500 }]] });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
    const series = await controller.getHistorySeries('1D');
    assert.deepStrictEqual(series.points, []);
    assert.ok(series.errors[0].startsWith('US:AAPL'));
    controller.dispose();
  });

  it('falls back to the spot fx rate when the intraday USDINR series is unavailable', async () => {
    const { store, controller } = setup({
      now: FIXTURE_NOW,
      routes: [
        ['/chart/AAPL?range=5d', { body: fixture('yahoo/AAPL.5d15m.json') }],
        ['USDINR%3DX?range=5d', { status: 500 }],
        ['USDINR%3DX', { body: fixture('yahoo/USDINR.1d.json') }],
        ['/chart/', { status: 500 }],
      ],
    });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
    const series = await controller.getHistorySeries('1D');
    assert.deepStrictEqual(series.errors, []);
    const aapl = parseYahooIntraday(fixture('yahoo/AAPL.5d15m.json'), 'AAPL').pop()!.close;
    near(series.points[series.points.length - 1].value, aapl * 94.93);
    controller.dispose();
  });

  it('15D returns the last 15 calendar days of the daily series, 30D the full month', async () => {
    const { store, controller } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    const d15 = await controller.getHistorySeries('15D');
    const d30 = await controller.getHistorySeries('30D');
    assert.strictEqual(d15.range, '15D');
    assert.strictEqual(d30.range, '30D');
    assert.ok(d15.points.length < d30.points.length);
    const last = d15.points[d15.points.length - 1].date;
    assert.strictEqual(last, '2026-10-23');
    assert.ok(d15.points[0].date >= '2026-10-09', d15.points[0].date);
    assert.strictEqual((await controller.getHistorySeries()).range, '30D', 'defaults to 30D');
    controller.dispose();
  });
});

describe('buildChartModel ranges', () => {
  function intradaySeries(hide = false) {
    return {
      range: '1D' as const,
      baseCurrency: 'INR' as const,
      hideAmounts: hide,
      points: [
        { date: '2026-10-23', time: Date.UTC(2026, 9, 23, 20, 15), value: 1000, invested: 900, pnl: 100, pnlPercent: 11.11 },
        { date: '2026-10-24', time: Date.UTC(2026, 9, 23, 23, 45), value: 1010, invested: 900, pnl: 110, pnlPercent: 12.22 },
      ],
      errors: [],
    };
  }

  it('shows times on the x axis and date + time in the tooltip title for 1D, in the requested timezone', () => {
    const utc = buildChartModel(intradaySeries(), 'k', { timeZone: 'UTC' });
    assert.deepStrictEqual(utc.labels, ['20:15', '23:45']);
    assert.strictEqual(utc.tooltipTitles[0], 'Fri 23 Oct, 20:15');
    const ist = buildChartModel(intradaySeries(), 'k', { timeZone: 'Asia/Kolkata' });
    assert.deepStrictEqual(ist.labels, ['01:45', '05:15'], 'midnight renders as 00:xx, not 24:xx');
    assert.strictEqual(ist.tooltipTitles[0], 'Sat 24 Oct, 01:45');
    assert.strictEqual(ist.range, '1D');
  });

  it('titles reflect the range, with amounts and when hidden', () => {
    assert.strictEqual(buildChartModel(intradaySeries(), 'k').title, '1-day portfolio value (₹ INR)');
    assert.strictEqual(buildChartModel(intradaySeries(true), 'k').title, '1-day P/L %');
    const daily = { ...intradaySeries(), range: '15D' as const, points: [{ date: '2026-10-23', value: 5, invested: 4, pnl: 1, pnlPercent: 25 }] };
    assert.strictEqual(buildChartModel(daily, 'k').title, '15-day portfolio value (₹ INR)');
    assert.strictEqual(buildChartModel({ ...daily, range: '30D' }, 'k').title, '30-day portfolio value (₹ INR)');
    assert.strictEqual(buildChartModel({ ...daily, range: '30D', hideAmounts: true }, 'k').title, '30-day P/L %');
    assert.deepStrictEqual(buildChartModel(daily, 'k').labels, ['23 Oct']);
  });

  it('plots P/L % for 1D when amounts are hidden', () => {
    const m = buildChartModel(intradaySeries(true), 'k', { timeZone: 'UTC' });
    assert.deepStrictEqual(m.values, [11.11, 12.22]);
    assert.ok(!JSON.stringify(m).includes('1010'));
  });
});
