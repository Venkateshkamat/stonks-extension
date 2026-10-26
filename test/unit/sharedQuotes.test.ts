import * as assert from 'assert';
import { fixture } from '../helpers';
import { setup } from '../controllerSetup';
import { FakeTimers } from '../fakeTimers';
import { MemoryQuoteCacheStorage, SharedQuoteCache } from '../../src/market/quoteCache';
import { PortfolioSnapshot } from '../../src/portfolio/controller';
import { Holding } from '../../src/types';

const utc = (s: string): number => Date.parse(`${s}Z`);
const SEC = 1000;
const MIN = 60 * SEC;
const count = (calls: string[], needle: string): number => calls.filter((c) => c.includes(needle)).length;

const lot = (symbol: string, market: Holding['market'], quantity = 1): Holding => ({ id: `${market}:${symbol}`, symbol, market, quantity, buyPrice: 1000 });

describe('sharing quotes across windows', () => {
  it('a second window starting shortly after the first shows the first one\'s quotes at once and makes no request', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const now = utc('2026-10-27T05:00:00');
    const holdings = [lot('RELIANCE', 'NSE')];
    const a = setup({ now, holdings, deps: { cache: new SharedQuoteCache(storage, () => now) } });
    await a.controller.start();
    assert.ok(a.fetch.calls.length > 0);

    const later = now + 20 * SEC;
    const b = setup({ now: later, holdings, deps: { cache: new SharedQuoteCache(storage, () => later) } });
    assert.strictEqual(b.controller.snapshot.holdings[0].quote?.price, 1190, 'cached quote is shown without any fetch');
    assert.strictEqual(b.controller.snapshot.lastUpdated, now);
    await b.controller.start();
    assert.strictEqual(b.fetch.calls.length, 0, 'fresh in the shared cache: no request');
    a.controller.dispose();
    b.controller.dispose();
  });

  it('constructing a controller over an existing cache renders totals before start() and without touching the network', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const now = utc('2026-10-27T05:00:00');
    const holdings = [lot('RELIANCE', 'NSE', 10), lot('AAPL', 'US', 2)];
    const first = setup({ now, holdings, deps: { cache: new SharedQuoteCache(storage, () => now) } });
    await first.controller.start();
    const expected = first.controller.snapshot.totals!;
    first.controller.dispose();

    const later = now + 3600 * SEC;
    const second = setup({
      now: later,
      holdings,
      routes: [['/chart/', { throws: new Error('network must not be touched before the first render') }]],
      deps: { cache: new SharedQuoteCache(storage, () => later) },
    });
    const snap = second.controller.snapshot;
    assert.strictEqual(second.fetch.calls.length, 0);
    assert.strictEqual(snap.loading, false);
    assert.deepStrictEqual(snap.totals, expected, 'same totals as the last session ended with');
    assert.strictEqual(snap.lastUpdated, now, 'the tooltip can say when the numbers are from');
    second.controller.dispose();
  });

  it('does not fetch a closed market at startup when the cache already holds the final close', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const fridayClose = utc('2026-10-30T10:16:00'); // closing fetch, after 15:45 IST
    const holdings = [lot('RELIANCE', 'NSE')];
    const a = setup({ now: fridayClose, holdings, deps: { cache: new SharedQuoteCache(storage, () => fridayClose) } });
    await a.controller.refresh('manual');
    a.controller.dispose();

    const sunday = utc('2026-11-01T09:00:00');
    const b = setup({ now: sunday, holdings, deps: { cache: new SharedQuoteCache(storage, () => sunday) } });
    await b.controller.start();
    assert.strictEqual(count(b.fetch.calls, 'RELIANCE.NS'), 0);
    assert.ok(b.controller.snapshot.holdings[0].quote);
    b.controller.dispose();
  });

  it('fetches once at startup when the cached quote predates the last close', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const fridayMorning = utc('2026-10-30T05:00:00');
    const holdings = [lot('RELIANCE', 'NSE')];
    const a = setup({ now: fridayMorning, holdings, deps: { cache: new SharedQuoteCache(storage, () => fridayMorning) } });
    await a.controller.refresh('manual');
    a.controller.dispose();

    const sunday = utc('2026-11-01T09:00:00');
    const b = setup({ now: sunday, holdings, deps: { cache: new SharedQuoteCache(storage, () => sunday) } });
    await b.controller.start();
    assert.strictEqual(count(b.fetch.calls, 'RELIANCE.NS?range=1d'), 1);
    b.controller.dispose();
  });

  it('writes what it fetched back, and failed fetches are not shared', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const now = utc('2026-10-27T05:00:00');
    const a = setup({
      now,
      holdings: [lot('RELIANCE', 'NSE'), lot('BROKEN', 'US')],
      routes: [['/chart/RELIANCE.NS?range=1d', { body: fixture('yahoo/RELIANCE.NS.1d.json') }], ['/chart/', { status: 500 }]],
      deps: { cache: new SharedQuoteCache(storage, () => now) },
    });
    await a.controller.start();
    assert.deepStrictEqual(Object.keys(storage.read()), ['q:NSE:RELIANCE']);
    a.controller.dispose();
  });

  it('two windows running side by side share one fetch per interval (jittered wake-ups, no thundering herd)', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const start = utc('2026-10-27T05:00:00');
    const holdings = [lot('BTC', 'CRYPTO')];
    const mk = (random: number) => setup({ now: start, holdings, deps: { cache: new SharedQuoteCache(storage, () => start), random: () => random } });
    const a = mk(0);
    const b = mk(0.9);
    const timers = new FakeTimers(a.clock);
    // one shared clock: b reads a's
    const bAtOnce = b.clock;
    const sync = () => {
      bAtOnce.t = a.clock.t;
    };
    timers.install();
    try {
      await a.controller.start();
      sync();
      await b.controller.start();
      for (let i = 0; i < 10; i++) {
        await timers.advance(MIN);
        sync();
      }
      const na = count(a.fetch.calls, 'BTC-USD?range=1d');
      const nb = count(b.fetch.calls, 'BTC-USD?range=1d');
      assert.ok(na + nb >= 10 && na + nb <= 12, `about one fetch per minute across both windows (a=${na}, b=${nb})`);
    } finally {
      timers.uninstall();
    }
    a.controller.dispose();
    b.controller.dispose();
  });

  it('a window picks up another window\'s newer quotes on its next wake-up and updates its display', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const now = utc('2026-10-27T05:00:00');
    const holdings = [lot('RELIANCE', 'NSE')];
    const a = setup({ now, holdings, deps: { cache: new SharedQuoteCache(storage, () => now) } });
    const b = setup({ now, holdings, deps: { cache: new SharedQuoteCache(storage, () => now) } });
    await a.controller.start();
    await b.controller.start();
    const seen: PortfolioSnapshot[] = [];
    b.controller.onDidUpdate((s) => seen.push(s));
    // window A refreshes later (e.g. the user hit Refresh there)
    a.clock.t = now + 30 * SEC;
    await a.controller.refresh('manual');
    b.clock.t = now + 40 * SEC;
    const before = b.fetch.calls.length;
    await b.controller.refresh('timer');
    assert.strictEqual(b.fetch.calls.length, before, 'B did not fetch');
    assert.strictEqual(b.controller.snapshot.lastUpdated, now + 30 * SEC, 'B shows A\'s newer data');
    assert.ok(seen.length >= 1);
    a.controller.dispose();
    b.controller.dispose();
  });

  it('start() with cached data waits a random moment before refreshing, so windows opening together do not all fetch', async () => {
    const storage = new MemoryQuoteCacheStorage();
    const now = utc('2026-10-27T05:00:00');
    const holdings = [lot('BTC', 'CRYPTO')];
    const seed = setup({ now, holdings, deps: { cache: new SharedQuoteCache(storage, () => now) } });
    await seed.controller.start();
    seed.controller.dispose();

    const later = now + 10 * MIN; // cached data is stale
    const w = setup({ now: later, holdings, deps: { cache: new SharedQuoteCache(storage, () => later), random: () => 0.5 } });
    const timers = new FakeTimers(w.clock);
    timers.install();
    try {
      const started = w.controller.start();
      await timers.flush();
      assert.strictEqual(w.fetch.calls.length, 0, 'not yet');
      await timers.advance(2 * SEC);
      await started;
      assert.strictEqual(count(w.fetch.calls, 'BTC-USD?range=1d'), 1);
    } finally {
      timers.uninstall();
    }
    w.controller.dispose();
  });
});
