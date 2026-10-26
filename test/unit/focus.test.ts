import * as assert from 'assert';
import { setup } from '../controllerSetup';
import { FakeTimers } from '../fakeTimers';
import { Emitter } from '../../src/util/emitter';
import { FocusSource } from '../../src/util/focus';
import { UNFOCUSED_FACTOR } from '../../src/market/schedule';

const utc = (s: string): number => Date.parse(`${s}Z`);
const SEC = 1000;
const MIN = 60 * SEC;
const NSE_OPEN = utc('2026-10-27T05:00:00'); // 10:30 IST, NSE open

class FakeFocus implements FocusSource {
  private readonly emitter = new Emitter<boolean>();
  readonly onDidChange = this.emitter.event;
  constructor(public focused: boolean) {}
  set(focused: boolean): void {
    this.focused = focused;
    this.emitter.fire(focused);
  }
}

const count = (calls: string[], needle: string): number => calls.filter((c) => c.includes(needle)).length;

async function withTimers<T>(clock: { t: number }, body: (timers: FakeTimers) => Promise<T>): Promise<T> {
  const timers = new FakeTimers(clock);
  timers.install();
  try {
    return await body(timers);
  } finally {
    timers.uninstall();
  }
}

describe('refreshing while the window is not focused', () => {
  it('refreshes five times less often', async () => {
    const focus = new FakeFocus(false);
    const { store, controller, fetch, clock } = setup({ now: NSE_OPEN, deps: { focus } });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      const n = () => count(fetch.calls, 'RELIANCE.NS?range=1d');
      assert.strictEqual(n(), 1, 'the first load is not delayed');
      await timers.advance(UNFOCUSED_FACTOR * MIN - SEC);
      assert.strictEqual(n(), 1, 'nothing before 5 minutes');
      await timers.advance(SEC);
      assert.strictEqual(n(), 2);
      await timers.advance(UNFOCUSED_FACTOR * MIN);
      assert.strictEqual(n(), 3);
    });
    controller.dispose();
  });

  it('applies to crypto as well', async () => {
    const { store, controller, fetch, clock } = setup({ now: NSE_OPEN, deps: { focus: new FakeFocus(false) } });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 1, buyPrice: 1 });
      await controller.start();
      await timers.advance(10 * MIN);
      assert.strictEqual(count(fetch.calls, 'BTC-USD?range=1d'), 3, 'at 0, 5 and 10 minutes');
    });
    controller.dispose();
  });

  it('stretches an already pending wake-up when the window loses focus', async () => {
    const focus = new FakeFocus(true);
    const { store, controller, fetch, clock } = setup({ now: NSE_OPEN, deps: { focus } });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      await timers.advance(30 * SEC);
      focus.set(false);
      await timers.advance(2 * MIN);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 1, 'the 60s wake-up was replaced by a 5 minute one');
      await timers.advance(2 * MIN + 30 * SEC);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), 2);
    });
    controller.dispose();
  });

  it('refreshes at once on regaining focus when the data is stale, and not when it is fresh', async () => {
    const focus = new FakeFocus(false);
    const { store, controller, fetch, clock } = setup({ now: NSE_OPEN, deps: { focus } });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      const n = () => count(fetch.calls, 'RELIANCE.NS?range=1d');
      await timers.advance(2 * MIN); // older than the focused interval, younger than the unfocused one
      focus.set(true);
      await timers.flush();
      assert.strictEqual(n(), 2, 'stale -> fetched immediately on focus');

      focus.set(false);
      await timers.advance(20 * SEC);
      focus.set(true);
      await timers.flush();
      assert.strictEqual(n(), 2, 'fresh -> no request when focus returns');
      await timers.advance(40 * SEC);
      assert.strictEqual(n(), 3, 'and the normal focused cadence resumes');
    });
    controller.dispose();
  });

  it('spot FX moves from every 15 to every 75 minutes', async () => {
    const focus = new FakeFocus(false);
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-27T15:00:00'), deps: { focus } }); // US open
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
      await controller.start();
      await timers.advance(74 * MIN);
      assert.strictEqual(count(fetch.calls, 'USDINR'), 1);
      await timers.advance(1 * MIN);
      assert.strictEqual(count(fetch.calls, 'USDINR'), 2);
    });
    controller.dispose();
  });

  it('still captures the closing price once, even unfocused', async () => {
    const { store, controller, fetch, clock } = setup({ now: utc('2026-10-27T09:50:00'), deps: { focus: new FakeFocus(false) } });
    await withTimers(clock, async (timers) => {
      await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
      await controller.start();
      await timers.advance(10 * MIN); // 15:30 IST: one in-session refresh happened at 09:55
      const atClose = count(fetch.calls, 'RELIANCE.NS?range=1d');
      await timers.advance(15 * MIN);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), atClose + 1);
      await timers.advance(10 * 3600 * SEC);
      assert.strictEqual(count(fetch.calls, 'RELIANCE.NS?range=1d'), atClose + 1);
    });
    controller.dispose();
  });
});
