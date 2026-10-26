import * as assert from 'assert';
import { MemStore, setup } from '../controllerSetup';
import { buildPinItems, holdingPin, parsePinKey, Pin, pinKey, PinStore, PINS_KEY } from '../../src/portfolio/pins';
import { buildPanelModel } from '../../src/panel/model';
import { parseWebviewMessage } from '../../src/panel/protocol';
import { buildPinStatusModel } from '../../src/statusBarModel';
import { buildSnapshot, FetchedData } from '../../src/portfolio/controller';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { Holding, INDICES, Quote } from '../../src/types';

const NOW = 1_700_000_000_000;
const quote = (symbol: string, price: number, prev: number, currency: 'INR' | 'USD' = 'USD'): Quote => {
  const change = price - prev;
  return { symbol, price, prevClose: prev, change, changePercent: (change / prev) * 100, currency, source: 'yahoo', time: NOW };
};

describe('pin keys', () => {
  it('round-trips holding and market pins', () => {
    const h = holdingPin('NSE', 'reliance.ns');
    assert.deepStrictEqual(h, { kind: 'holding', market: 'NSE', symbol: 'RELIANCE' }, 'normalised like holdings');
    assert.strictEqual(pinKey(h), 'h:NSE:RELIANCE');
    assert.deepStrictEqual(parsePinKey('h:NSE:RELIANCE'), h);
    const m: Pin = { kind: 'market', symbol: '^NSEI' };
    assert.strictEqual(pinKey(m), 'm:^NSEI');
    assert.deepStrictEqual(parsePinKey('m:^NSEI'), m);
    assert.deepStrictEqual(parsePinKey('h:CRYPTO:BTC'), { kind: 'holding', market: 'CRYPTO', symbol: 'BTC' });
    assert.deepStrictEqual(parsePinKey('h:US:BRK.B'), { kind: 'holding', market: 'US', symbol: 'BRK.B' });
  });

  it('rejects malformed keys', () => {
    for (const bad of [undefined, null, 5, '', 'x', 'h:', 'h:NSE', 'h:NSE:', 'h:FOO:AAPL', 'h:nse:AAPL', 'm:', 'm:<script>', 'h:US:A B', `m:${'x'.repeat(80)}`, {}]) {
      assert.strictEqual(parsePinKey(bad), undefined, String(bad));
    }
  });
});

describe('PinStore stale storage echo', () => {
  it('keeps returning its own last write when the storage briefly hands back an older value', async () => {
    const mem = new MemStore();
    const s = new PinStore(mem);
    await s.add(holdingPin('US', 'AAPL'));
    await s.add({ kind: 'market', symbol: '^NSEI' });
    await s.remove(holdingPin('US', 'AAPL'));
    mem.data.set(PINS_KEY, ['h:US:AAPL', 'm:^NSEI']); // the extension host echoes an older value
    assert.deepStrictEqual(s.list().map(pinKey), ['m:^NSEI']);
  });
});

describe('PinStore', () => {
  it('adds in order, ignores duplicates, removes, and persists as a key array', async () => {
    const mem = new MemStore();
    const s = new PinStore(mem);
    let fired = 0;
    s.onDidChange(() => fired++);
    assert.deepStrictEqual(s.list(), []);
    assert.strictEqual(await s.add(holdingPin('US', 'AAPL')), true);
    assert.strictEqual(await s.add({ kind: 'market', symbol: '^NSEI' }), true);
    assert.strictEqual(await s.add(holdingPin('US', 'aapl')), false, 'same market + symbol = same pin');
    assert.strictEqual(fired, 2);
    assert.deepStrictEqual(mem.data.get(PINS_KEY), ['h:US:AAPL', 'm:^NSEI']);
    assert.ok(s.has(holdingPin('US', 'AAPL')));
    assert.ok(!s.has(holdingPin('NSE', 'AAPL')), 'market is part of the identity');
    assert.strictEqual(await s.remove(holdingPin('US', 'AAPL')), true);
    assert.strictEqual(await s.remove(holdingPin('US', 'AAPL')), false);
    assert.deepStrictEqual(s.list().map(pinKey), ['m:^NSEI']);
    assert.strictEqual(fired, 3);
    assert.deepStrictEqual(new PinStore(mem).list().map(pinKey), ['m:^NSEI'], 'a new instance over the same storage sees the pins');
  });

  it('survives garbage in storage', () => {
    const mem = new MemStore();
    mem.data.set(PINS_KEY, ['h:US:AAPL', 7, 'junk', 'h:US:AAPL', 'm:^GSPC', null]);
    assert.deepStrictEqual(new PinStore(mem).list().map(pinKey), ['h:US:AAPL', 'm:^GSPC']);
    mem.data.set(PINS_KEY, 'nope');
    assert.deepStrictEqual(new PinStore(mem).list(), []);
  });
});

describe('buildPinItems', () => {
  const lotA: Holding = { id: 'a', symbol: 'AAPL', market: 'US', quantity: 2, buyPrice: 100 };
  const lotB: Holding = { id: 'b', symbol: 'AAPL', market: 'US', quantity: 3, buyPrice: 200 };
  const other: Holding = { id: 'c', symbol: 'AAPL', market: 'NSE', quantity: 1, buyPrice: 10 };

  function rows(holdings: Holding[], quotes: Record<string, Quote>, errors: Record<string, string> = {}) {
    const data: FetchedData = {
      quotes: new Map(Object.entries(quotes)),
      quoteErrors: new Map(Object.entries(errors)),
      indices: [],
      lastUpdated: NOW,
    };
    return buildSnapshot(holdings, data, DEFAULT_SETTINGS, false).holdings;
  }

  it('shares one item between lots of the same market + symbol and aggregates P/L % over them', () => {
    const r = rows([lotA, lotB, other], { a: quote('AAPL', 231.4, 229.85), b: quote('AAPL', 231.4, 229.85), c: quote('AAPL', 5, 4, 'INR') });
    const items = buildPinItems([holdingPin('US', 'AAPL')], r, []);
    assert.strictEqual(items.length, 1);
    const i = items[0];
    assert.strictEqual(i.key, 'h:US:AAPL');
    assert.strictEqual(i.label, 'AAPL');
    assert.strictEqual(i.currency, 'USD');
    assert.strictEqual(i.price, 231.4);
    assert.ok(Math.abs(i.changePercent! - ((231.4 - 229.85) / 229.85) * 100) < 1e-9);
    // invested 200 + 600 = 800; current 5 * 231.4 = 1157; the NSE AAPL holding is not part of it
    assert.ok(Math.abs(i.pnlPercent! - ((1157 - 800) / 800) * 100) < 1e-9);
  });

  it('keeps pin order, resolves market rows and omits holdings that no longer exist', () => {
    const r = rows([lotA], { a: quote('AAPL', 1, 1) });
    const idx = INDICES[0];
    const items = buildPinItems(
      [{ kind: 'market', symbol: idx.symbol }, holdingPin('NSE', 'GONE'), holdingPin('US', 'AAPL')],
      r,
      [{ index: idx, quote: quote(idx.symbol, 24832.65, 24710.3, 'INR') }],
    );
    assert.deepStrictEqual(items.map((i) => i.key), ['m:^NSEI', 'h:US:AAPL']);
    assert.strictEqual(items[0].label, 'NIFTY 50');
    assert.strictEqual(items[0].locale, 'en-IN');
    assert.strictEqual(items[0].price, 24832.65);
    assert.strictEqual(items[0].pnlPercent, undefined);
  });

  it('flags a missing quote (loading) and a failed one (error)', () => {
    const r = rows([lotA], {}, { a: 'HTTP 500' });
    const [h] = buildPinItems([holdingPin('US', 'AAPL')], r, []);
    assert.strictEqual(h.price, undefined);
    assert.strictEqual(h.error, 'HTTP 500');
    const [m] = buildPinItems([{ kind: 'market', symbol: '^GSPC' }], [], [{ index: INDICES[3], error: 'No data' }]);
    assert.strictEqual(m.error, 'No data');
    const [loading] = buildPinItems([{ kind: 'market', symbol: '^GSPC' }], [], []);
    assert.strictEqual(loading.error, undefined);
    assert.strictEqual(loading.price, undefined);
  });
});

describe('buildPinStatusModel', () => {
  const base = { pin: holdingPin('US', 'AAPL'), key: 'h:US:AAPL', label: 'AAPL', name: 'AAPL (US)', locale: 'en-US' };

  it('formats a holding as "SYMBOL price day%" in its native currency, coloured by the day change', () => {
    const m = buildPinStatusModel({ ...base, currency: 'USD', price: 231.4, change: 1.55, changePercent: 0.67, pnlPercent: 34.2 });
    assert.strictEqual(m.text, 'AAPL $231.40 +0.67%');
    assert.strictEqual(m.tone, 'gain');
    assert.deepStrictEqual(m.tooltip.split('\n'), ['AAPL (US)', 'Price: $231.40', 'Today: +$1.55 (+0.67%)', 'Your P/L: +34.20%', 'Click to open portfolio.']);
  });

  it('uses rupees for NSE holdings and red for a falling price', () => {
    const m = buildPinStatusModel({ ...base, label: 'RELIANCE', name: 'RELIANCE (NSE)', currency: 'INR', price: 1324.8, change: -13.6, changePercent: -1.02 });
    assert.strictEqual(m.text, 'RELIANCE ₹1,324.80 -1.02%');
    assert.strictEqual(m.tone, 'loss');
    assert.ok(!m.tooltip.includes('Your P/L'), 'no P/L line without a position value');
  });

  it('formats a market row as "NAME level day%" without a currency symbol', () => {
    const m = buildPinStatusModel({ pin: { kind: 'market', symbol: '^NSEI' }, key: 'm:^NSEI', label: 'NIFTY 50', name: 'NIFTY 50', locale: 'en-IN', price: 24832.65, change: 122.35, changePercent: 0.5 });
    assert.strictEqual(m.text, 'NIFTY 50 24,832.65 +0.50%');
    assert.strictEqual(m.tone, 'gain');
    assert.deepStrictEqual(m.tooltip.split('\n'), ['NIFTY 50', 'Price: 24,832.65', 'Today: +122.35 (+0.50%)', 'Click to open portfolio.']);
  });

  it('keeps sub-dollar crypto prices readable and a flat day neutral', () => {
    const m = buildPinStatusModel({ ...base, pin: holdingPin('CRYPTO', 'DOGE'), key: 'h:CRYPTO:DOGE', label: 'DOGE', name: 'DOGE (CRYPTO)', currency: 'USD', price: 0.1325, change: 0, changePercent: 0 });
    assert.strictEqual(m.text, 'DOGE $0.1325 0.00%');
    assert.strictEqual(m.tone, 'neutral');
  });

  it('shows loading and error states', () => {
    assert.strictEqual(buildPinStatusModel({ ...base, currency: 'USD' }).text, 'AAPL ...');
    const e = buildPinStatusModel({ ...base, currency: 'USD', error: 'HTTP 500' });
    assert.strictEqual(e.text, 'AAPL --');
    assert.strictEqual(e.tone, 'warning');
    assert.ok(e.tooltip.includes('HTTP 500'));
  });
});

describe('PortfolioController pins', () => {
  it('fetches pinned index quotes even when indices are not requested (panel closed) and builds the status bar items', async () => {
    const { controller, pins, fetch } = setup();
    await pins.add({ kind: 'market', symbol: '^NSEI' });
    await controller.refresh();
    const nifty = controller.snapshot.pins.find((p) => p.key === 'm:^NSEI')!;
    assert.ok(nifty, 'pin resolved');
    assert.ok(nifty.price! > 0);
    assert.deepStrictEqual(controller.snapshot.indices, [], 'the index table data is still only loaded while the panel is open');
    assert.ok(fetch.calls.some((c) => c.includes('%5ENSEI')));
    assert.ok(fetch.calls.every((c) => !c.includes('%5EGSPC')), 'only the pinned index is fetched');
    controller.dispose();
  });

  it('fetches the quote right away when a market row gets pinned, and stops when it is unpinned', async () => {
    const { controller, pins, fetch } = setup();
    await controller.refresh();
    assert.ok(fetch.calls.every((c) => !c.includes('%5ENSEI')));
    await pins.add({ kind: 'market', symbol: '^NSEI' });
    await controller.refresh(); // joins the refresh the pin kicked off
    assert.strictEqual(controller.snapshot.pins.length, 1);
    assert.ok(controller.snapshot.pins[0].price! > 0);
    await pins.remove({ kind: 'market', symbol: '^NSEI' });
    assert.deepStrictEqual(controller.snapshot.pins, []);
    const n = fetch.calls.length;
    await controller.refresh();
    assert.ok(fetch.calls.slice(n).every((c) => !c.includes('%5ENSEI')));
    controller.dispose();
  });

  it('pins a holding: updates immediately from quotes the controller already has', async () => {
    const { controller, pins, store } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000 });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1100 });
    await controller.refresh();
    await pins.add(holdingPin('NSE', 'RELIANCE'));
    const item = controller.snapshot.pins[0];
    assert.strictEqual(item.price, 1190);
    assert.ok(Math.abs(item.pnlPercent! - ((23800 - 21000) / 21000) * 100) < 1e-9, 'aggregated over both lots');
    await store.remove(store.list()[0].id);
    assert.strictEqual(controller.snapshot.pins.length, 1, 'one lot left, pin remains');
    await store.remove(store.list()[0].id);
    assert.deepStrictEqual(controller.snapshot.pins, [], 'no holdings left: the pin is not rendered');
    assert.strictEqual(pins.list().length, 1, 'but it is kept and reappears if the holding is added again');
    controller.dispose();
  });
});

describe('panel model pins', () => {
  it('marks pinned rows and markets, with a shared key for lots of the same symbol', async () => {
    const { controller, pins, store } = setup();
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1 });
    await store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 2, buyPrice: 2 });
    await store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
    controller.setIncludeIndices(true);
    await controller.refresh();
    await pins.add(holdingPin('NSE', 'RELIANCE'));
    await pins.add({ kind: 'market', symbol: '^GSPC' });
    const model = buildPanelModel(controller.snapshot);
    assert.deepStrictEqual(model.rows.map((r) => [r.pinKey, r.pinned]), [['h:NSE:RELIANCE', true], ['h:NSE:RELIANCE', true], ['h:US:AAPL', false]]);
    const items = model.indices.flatMap((g) => g.items);
    assert.strictEqual(items.find((i) => i.name === 'S&P 500')!.pinned, true);
    assert.strictEqual(items.find((i) => i.name === 'S&P 500')!.pinKey, 'm:^GSPC');
    assert.strictEqual(items.find((i) => i.name === 'NIFTY 50')!.pinned, false);
    controller.dispose();
  });
});

describe('togglePin message', () => {
  it('accepts only valid pin keys', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'togglePin', key: 'h:US:AAPL', extra: 1 }), { type: 'togglePin', key: 'h:US:AAPL' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'togglePin', key: 'm:^NSEI' }), { type: 'togglePin', key: 'm:^NSEI' });
    for (const bad of ['', 'junk', 5, undefined, 'h:XX:AAPL']) assert.strictEqual(parseWebviewMessage({ type: 'togglePin', key: bad }), undefined);
  });
});
