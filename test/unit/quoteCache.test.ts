import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CACHE_MAX_AGE_MS, CachedQuote, FileQuoteCacheStorage, MemoryQuoteCacheStorage, SharedQuoteCache } from '../../src/market/quoteCache';
import { Quote } from '../../src/types';

const quote = (symbol: string, price: number): Quote => ({ symbol, price, prevClose: price - 1, change: 1, changePercent: 1, currency: 'USD', source: 'yahoo', time: 1_000 });
const entry = (symbol: string, price: number, at: number): CachedQuote => ({ quote: quote(symbol, price), at });

describe('SharedQuoteCache', () => {
  it('round-trips entries through the backend', () => {
    const cache = new SharedQuoteCache(new MemoryQuoteCacheStorage(), () => 10_000);
    cache.save({ 'q:US:AAPL': entry('AAPL', 100, 9_000) });
    assert.deepStrictEqual(cache.load(), { 'q:US:AAPL': entry('AAPL', 100, 9_000) });
  });

  it('merges concurrent writers: each key keeps its newest fetch and no window loses the other\'s entries', () => {
    const backend = new MemoryQuoteCacheStorage();
    const a = new SharedQuoteCache(backend, () => 10_000);
    const b = new SharedQuoteCache(backend, () => 10_000);
    a.save({ 'q:US:AAPL': entry('AAPL', 100, 5_000), 'q:US:MSFT': entry('MSFT', 300, 5_000) });
    b.save({ 'q:US:AAPL': entry('AAPL', 101, 6_000), 'q:NSE:TCS': entry('TCS', 4000, 6_000) });
    a.save({ 'q:US:AAPL': entry('AAPL', 99, 4_000) }); // an older fetch never overwrites a newer one
    const all = a.load();
    assert.strictEqual(all['q:US:AAPL'].quote.price, 101);
    assert.deepStrictEqual(Object.keys(all).sort(), ['q:NSE:TCS', 'q:US:AAPL', 'q:US:MSFT']);
  });

  it('drops entries older than two weeks when saving', () => {
    const now = 100 * 24 * 3_600_000;
    const cache = new SharedQuoteCache(new MemoryQuoteCacheStorage(), () => now);
    cache.save({ 'q:US:OLD': entry('OLD', 1, now - CACHE_MAX_AGE_MS - 1), 'q:US:NEW': entry('NEW', 1, now - 1_000) });
    assert.deepStrictEqual(Object.keys(cache.load()), ['q:US:NEW']);
  });
});

describe('FileQuoteCacheStorage (two windows sharing one file)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stonks-cache-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is empty before anything is written, and creates the directory on first write', () => {
    const sub = path.join(dir, 'does', 'not', 'exist');
    const s = new FileQuoteCacheStorage(sub);
    assert.deepStrictEqual(s.read(), {});
    new SharedQuoteCache(s, () => 5_000).save({ k: entry('AAPL', 1, 4_000) });
    assert.deepStrictEqual(Object.keys(new FileQuoteCacheStorage(sub).read()), ['k']);
    assert.deepStrictEqual(fs.readdirSync(sub), ['quotes.json'], 'no temp files left behind');
  });

  it('one window reads what another wrote', () => {
    const w1 = new SharedQuoteCache(new FileQuoteCacheStorage(dir), () => 5_000);
    const w2 = new SharedQuoteCache(new FileQuoteCacheStorage(dir), () => 5_000);
    w1.save({ 'q:US:AAPL': entry('AAPL', 123, 4_000) });
    assert.strictEqual(w2.load()['q:US:AAPL'].quote.price, 123);
    w2.save({ 'q:CRYPTO:BTC': entry('BTC', 9, 4_500) });
    assert.deepStrictEqual(Object.keys(w1.load()).sort(), ['q:CRYPTO:BTC', 'q:US:AAPL']);
  });

  it('treats corrupt or foreign files as empty and ignores malformed entries', () => {
    const s = new FileQuoteCacheStorage(dir);
    fs.writeFileSync(path.join(dir, 'quotes.json'), '{not json');
    assert.deepStrictEqual(s.read(), {});
    fs.writeFileSync(path.join(dir, 'quotes.json'), JSON.stringify({ v: 99, entries: {} }));
    assert.deepStrictEqual(s.read(), {});
    fs.writeFileSync(path.join(dir, 'quotes.json'), JSON.stringify({ v: 1, entries: { good: entry('A', 1, 1), bad: { quote: { price: 'x' }, at: 1 }, worse: 5 } }));
    assert.deepStrictEqual(Object.keys(s.read()), ['good']);
  });

  it('does not throw when the directory cannot be written', () => {
    const file = path.join(dir, 'blocker');
    fs.writeFileSync(file, 'x');
    const s = new FileQuoteCacheStorage(path.join(file, 'child')); // a file in the way
    assert.doesNotThrow(() => s.write({ k: entry('A', 1, 1) }));
    assert.deepStrictEqual(s.read(), {});
  });
});

describe('SharedQuoteCache change detection', () => {
  it('does not read the backend again while its contents are unchanged, and notices a write by another window', () => {
    const backend = new MemoryQuoteCacheStorage();
    const mine = new SharedQuoteCache(backend, () => 10_000);
    const theirs = new SharedQuoteCache(backend, () => 10_000);
    theirs.save({ a: entry('A', 1, 9_000) });
    const first = mine.load();
    const reads = backend.reads;
    assert.strictEqual(mine.load(), first, 'same object when nothing changed');
    assert.strictEqual(mine.load(), first);
    assert.strictEqual(backend.reads, reads, 'no extra reads');
    theirs.save({ b: entry('B', 2, 9_500) });
    const second = mine.load();
    assert.notStrictEqual(second, first);
    assert.deepStrictEqual(Object.keys(second).sort(), ['a', 'b']);
  });

  it('the file backend fingerprint changes with every write, by any window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stonks-cache-'));
    try {
      const a = new FileQuoteCacheStorage(dir);
      const b = new FileQuoteCacheStorage(dir);
      assert.strictEqual(a.stamp(), '', 'no file yet');
      new SharedQuoteCache(a, () => 5_000).save({ k: entry('A', 1, 4_000) });
      const s1 = a.stamp();
      assert.notStrictEqual(s1, '');
      assert.strictEqual(b.stamp(), s1, 'both windows see the same fingerprint');
      new SharedQuoteCache(b, () => 5_000).save({ k: entry('A', 2, 4_500) });
      assert.notStrictEqual(a.stamp(), s1);
      const cache = new SharedQuoteCache(a, () => 5_000);
      assert.strictEqual(cache.load().k.quote.price, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
