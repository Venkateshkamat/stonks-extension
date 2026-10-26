import * as assert from 'assert';
import { HOLDINGS_KEY, HoldingsStore, isValidHolding, KeyValueStore } from '../../src/portfolio/store';

class MemStore implements KeyValueStore {
  data = new Map<string, unknown>();
  get<T>(k: string, d: T): T {
    return (this.data.has(k) ? this.data.get(k) : d) as T;
  }
  async update(k: string, v: unknown): Promise<void> {
    this.data.set(k, JSON.parse(JSON.stringify(v)));
  }
}

describe('HoldingsStore', () => {
  it('adds with generated id and normalized symbol, and fires onDidChange', async () => {
    const s = new HoldingsStore(new MemStore());
    let n = 0;
    s.onDidChange(() => n++);
    const h = await s.add({ symbol: 'reliance.ns', market: 'NSE', quantity: 5, buyPrice: 2500, buyDate: '' });
    assert.strictEqual(h.symbol, 'RELIANCE');
    assert.ok(h.id.length > 10);
    assert.ok(!('buyDate' in h), 'empty buy date is dropped');
    assert.strictEqual(s.list().length, 1);
    assert.strictEqual(n, 1);
  });

  it('persists under stonks.holdings and survives a new store instance', async () => {
    const mem = new MemStore();
    await new HoldingsStore(mem).add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 1 });
    assert.ok(mem.data.has(HOLDINGS_KEY));
    assert.strictEqual(new HoldingsStore(mem).list()[0].symbol, 'AAPL');
  });

  it('updates quantity, price and date (and clears the date)', async () => {
    const s = new HoldingsStore(new MemStore());
    const h = await s.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 100, buyDate: '2026-01-01' });
    const u = await s.update(h.id, { quantity: 3, buyPrice: 90, buyDate: undefined });
    assert.strictEqual(u?.quantity, 3);
    assert.strictEqual(u?.buyPrice, 90);
    assert.ok(!('buyDate' in (u as object)));
    assert.strictEqual(s.get(h.id)?.symbol, 'AAPL');
    assert.strictEqual(await s.update('nope', { quantity: 1 }), undefined);
  });

  it('removes holdings', async () => {
    const s = new HoldingsStore(new MemStore());
    const a = await s.add({ symbol: 'A', market: 'US', quantity: 1, buyPrice: 1 });
    const b = await s.add({ symbol: 'B', market: 'US', quantity: 1, buyPrice: 1 });
    assert.strictEqual(await s.remove(a.id), true);
    assert.strictEqual(await s.remove(a.id), false);
    assert.deepStrictEqual(s.list().map((h) => h.id), [b.id]);
  });

  it('ignores corrupted stored entries', () => {
    const mem = new MemStore();
    mem.data.set(HOLDINGS_KEY, [{ id: 'x', symbol: 'A', market: 'US', quantity: 1, buyPrice: 1 }, { id: 'y', symbol: 'B', market: 'MARS', quantity: 1, buyPrice: 1 }, null, { id: 'z', symbol: 'C', market: 'US', quantity: -1, buyPrice: 1 }]);
    assert.deepStrictEqual(new HoldingsStore(mem).list().map((h) => h.id), ['x']);
    mem.data.set(HOLDINGS_KEY, 'garbage');
    assert.deepStrictEqual(new HoldingsStore(mem).list(), []);
    assert.strictEqual(isValidHolding(undefined), false);
  });
});
