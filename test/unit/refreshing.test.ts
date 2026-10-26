import * as assert from 'assert';
import { fixture } from '../helpers';
import { setup } from '../controllerSetup';
import { FakeTimers } from '../fakeTimers';
import { MAX_SLEEP_MS } from '../../src/market/schedule';
import { PortfolioSnapshot } from '../../src/portfolio/controller';

const utc = (s: string): number => Date.parse(`${s}Z`);
const MIN = 60_000;
const HOUR = 60 * MIN;

const count = (calls: string[], needle: string): number => calls.filter((c) => c.includes(needle)).length;

/** Runs `body` with virtual timers driving the controller's fake clock. */
async function withTimers<T>(clock: { t: number }, body: (timers: FakeTimers) => Promise<T>): Promise<T> {
  const timers = new FakeTimers(clock);
  timers.install();
  try {
    return await body(timers);
  } finally {
    timers.uninstall();
  }
}

describe('refreshing follows market hours', () => {
  it('polls NSE while open, makes one closing fetch after 15:30 IST, then sleeps until the next open', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-27T09:50:00') }); // Tue 15:20 IST
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      const n = () => count(fetch.calls, 'RELIANCE.NS?range=1d');
      assert.strictEqual(n(), 1);

      await timers.advance(10 * MIN); // to 15:30 IST sharp
      const atClose = n();
      assert.ok(atClose >= 9 && atClose <= 11, `polled roughly every minute while open, got ${atClose}`);

      await timers.advance(14 * MIN + 59_000); // 10:14:59Z, one second before the settle time
      assert.strictEqual(n(), atClose, 'nothing between the close and the settle time');
      await timers.advance(1_000);
      assert.strictEqual(n(), atClose + 1, 'exactly one fetch to capture the final close');

      const updates: PortfolioSnapshot[] = [];
      controller.onDidUpdate((s) => updates.push(s));
      const delaysBefore = timers.delays.length;
      await timers.advance(17 * HOUR + 29 * MIN + 59_000); // to 03:44:59Z on Wednesday
      assert.strictEqual(n(), atClose + 1, 'closed overnight: no requests');
      assert.strictEqual(updates.length, 0, 'closed overnight: no snapshot churn');
      assert.ok(timers.pending <= 1, 'a single wake-up timer, never a stack of them');

      await timers.advance(1_000);
      assert.strictEqual(n(), atClose + 2, 'fetched again at the next open');

      const overnight = timers.delays.slice(delaysBefore, delaysBefore + 35);
      assert.ok(overnight.every((d) => d >= 1_000 && d <= MAX_SLEEP_MS), `sleeps stay within [1s, ${MAX_SLEEP_MS}ms]`);
      assert.ok(overnight.filter((d) => d >= 25 * MIN).length >= 30, 'overnight sleeps are ~30 minutes long, not a polling loop');
    });
    controller.dispose();
  });

  it('wakes at most once per sleep cap while closed (a cheap re-check, no network)', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-24T12:00:00') }); // Saturday
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      const calls = fetch.calls.length;
      const before = timers.delays.length;
      await timers.advance(24 * HOUR);
      assert.strictEqual(fetch.calls.length, calls, 'no requests all day');
      const wakes = timers.delays.length - before;
      assert.ok(wakes <= (24 * HOUR) / MAX_SLEEP_MS + 1, `at most one wake-up per ${MAX_SLEEP_MS / MIN} minutes, got ${wakes}`);
    });
    controller.dispose();
  });

  it('a stock-only portfolio started at the weekend fetches once, and nothing more until Monday', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-24T12:00:00') });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
      await controller.start();
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 1);
      assert.strictEqual(count(fetch.calls, 'AAPL?range=1d'), 1);
      assert.ok(controller.snapshot.holdings.every((h) => h.quote), 'closing prices are shown');
      await timers.advance(39 * HOUR + 44 * MIN + 59_000); // to Monday 03:44:59Z; NSE reopens at 03:45Z
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 1, 'closed all weekend');
      assert.strictEqual(count(fetch.calls, 'AAPL?range=1d'), 1);
      await timers.advance(1_000);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 2, 'NSE fetched once at the Monday open');
      assert.strictEqual(count(fetch.calls, 'AAPL?range=1d'), 1, 'US is still closed');
    });
    controller.dispose();
  });

  it('crypto keeps refreshing around the clock, including weekends', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-24T12:00:00') });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 1, buyPrice: 1 });
      await controller.start();
      await timers.advance(10 * MIN);
      const n = count(fetch.calls, 'BTC-USD?range=1d');
      assert.ok(n >= 10 && n <= 11, `about one per minute, got ${n}`);
    });
    controller.dispose();
  });

  it('keeps stock indices out of the loop when their market is closed, but not pinned crypto', async () => {
    const { store, controller, pins, fetch, clock } = setup({ now: utc('2026-10-24T12:00:00') });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 1, buyPrice: 1 });
      await pins.add({ kind: 'market', symbol: '^GSPC' });
      await controller.start();
      assert.strictEqual(count(fetch.calls, '%5EGSPC'), 1, 'fetched once for the last close');
      await timers.advance(10 * MIN);
      assert.strictEqual(count(fetch.calls, '%5EGSPC'), 1);
      assert.ok(count(fetch.calls, 'BTC-USD?range=1d') >= 10);
    });
    controller.dispose();
  });

  it('refreshes FX at most every 15 minutes, however short the interval', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-27T15:00:00'), settings: { refreshIntervalSeconds: 15 } }); // US open
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
      await controller.start();
      await timers.advance(14 * MIN);
      assert.strictEqual(count(fetch.calls, 'USDINR'), 1);
      assert.ok(count(fetch.calls, 'AAPL?range=1d') >= 50, 'the quote itself still follows the 15s setting');
      await timers.advance(1 * MIN + 1_000);
      assert.strictEqual(count(fetch.calls, 'USDINR'), 2);
    });
    controller.dispose();
  });

  it('a manual refresh fetches everything even when markets are closed', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-24T12:00:00') });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    await controller.start();
    assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 1);
    clock.t += 5_000;
    await controller.refresh('manual');
    assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 2);
    controller.dispose();
  });

  it('timer and holdings refreshes do not re-fetch quotes that are still fresh', async () => {
    const { store, controller, fetch } = setup({ now: utc('2026-10-27T05:00:00') });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    await controller.start();
    const calls = fetch.calls.length;
    await controller.refresh('timer');
    await controller.refresh('settings');
    assert.strictEqual(fetch.calls.length, calls);
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
    await controller.refresh('holdings');
    assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 1, 'only the new holding (and fx) were fetched');
    assert.strictEqual(count(fetch.calls, 'AAPL?range=1d'), 1);
    controller.dispose();
  });

  it('retries a failed closing fetch after five minutes instead of waiting for the next open', async () => {
    let fail = false;
    const { store, controller, fetch, clock } = setup({
      now: utc('2026-10-27T09:59:00'),
      routes: [['/chart/RELIANCE.NS?range=1d', () => (fail ? { status: 500 } : { body: fixture('yahoo/RELIANCE.NS.1d.json') })]],
    });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      fail = true;
      await timers.advance(16 * MIN); // closing fetch at 10:15Z fails
      const failedAt = count(fetch.calls, 'RELIANCE.NS?range=1d');
      assert.ok(controller.snapshot.holdings[0].error, 'the failure is reported');
      assert.ok(controller.snapshot.holdings[0].quote, 'the previous quote stays on screen');
      fail = false;
      await timers.advance(5 * MIN);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), failedAt + 1, 'retried');
      assert.strictEqual(controller.snapshot.holdings[0].error, undefined);
      await timers.advance(3 * HOUR);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), failedAt + 1, 'and then quiet');
    });
    controller.dispose();
  });

  it('keeps no timer alive when there is nothing to refresh', async () => {
    const { controller, clock } = setup({ now: utc('2026-10-27T05:00:00') });
    await withTimers(clock, async (timers) => {
      await controller.start();
      assert.strictEqual(timers.pending, 0);
    });
    controller.dispose();
  });

  it('the panel opening fetches only indices that are not cached yet', async () => {
    const { controller, fetch } = setup({ now: utc('2026-10-27T05:00:00') });
    await controller.start();
    controller.setWatchlists({ indices: true });
    await controller.refresh('settings');
    const n = fetch.calls.length;
    assert.strictEqual(count(fetch.calls, '%5ENSEI'), 1);
    controller.setWatchlists({ indices: false });
    controller.setWatchlists({ indices: true });
    await controller.refresh('settings');
    assert.strictEqual(fetch.calls.length, n, 'reopening within the interval reuses the cached quotes');
    controller.dispose();
  });
});
