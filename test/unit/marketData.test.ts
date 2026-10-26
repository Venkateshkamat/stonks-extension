import * as assert from 'assert';
import { fixture, mockFetch } from '../helpers';
import { MarketDataService } from '../../src/market/marketData';
import { NotFoundError } from '../../src/market/http';

const YAHOO_AAPL = ['/chart/AAPL?', { body: fixture('yahoo/AAPL.1d.json') }] as const;
const FINNHUB_OK = ['finnhub.io', { body: fixture('finnhub/quote.AAPL.json') }] as const;

function svc(routes: Parameters<typeof mockFetch>[0], key?: string, extra: Partial<ConstructorParameters<typeof MarketDataService>[0]> = {}) {
  const f = mockFetch(routes);
  return { f, s: new MarketDataService({ fetch: f, getFinnhubKey: () => key, ...extra }) };
}

describe('MarketDataService', () => {
  it('uses Yahoo when no Finnhub key is set', async () => {
    const { f, s } = svc([YAHOO_AAPL, FINNHUB_OK]);
    const q = await s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(q.source, 'yahoo');
    assert.ok(f.calls.every((c) => !c.includes('finnhub')));
  });

  it('prefers Finnhub for US/crypto when keyed', async () => {
    const { f, s } = svc([FINNHUB_OK, YAHOO_AAPL], 'k');
    const q = await s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(q.source, 'finnhub');
    assert.strictEqual(f.calls.length, 1);
  });

  it('always uses Yahoo for NSE/BSE even with a key', async () => {
    const { f, s } = svc([['/chart/RELIANCE.NS', { body: fixture('yahoo/RELIANCE.NS.1d.json') }], FINNHUB_OK], 'k');
    const q = await s.getQuote({ symbol: 'RELIANCE', market: 'NSE' });
    assert.strictEqual(q.source, 'yahoo');
    assert.ok(f.calls.every((c) => !c.includes('finnhub')));
  });

  for (const [name, route] of [
    ['401', { status: 401 }],
    ['403', { status: 403 }],
    ['429', { status: 429 }],
    ['500', { status: 500 }],
    ['c === 0', { body: fixture('finnhub/quote.unknown.json') }],
    ['network error', { throws: new Error('ECONNRESET') }],
  ] as const) {
    it(`falls back to Yahoo when Finnhub fails (${name})`, async () => {
      const { s } = svc([['finnhub.io', route], YAHOO_AAPL], 'k');
      const q = await s.getQuote({ symbol: 'AAPL', market: 'US' });
      assert.strictEqual(q.source, 'yahoo');
      assert.strictEqual(q.price, 347.725);
    });
  }

  it('reports the Finnhub issue kind', async () => {
    const { s } = svc([['finnhub.io', { status: 401 }], YAHOO_AAPL], 'k');
    await s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(s.getFinnhubIssue(), 'rejected');
    const r = svc([['finnhub.io', { status: 429 }], YAHOO_AAPL], 'k');
    await r.s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(r.s.getFinnhubIssue(), 'rate-limited');
  });

  it('fails only when both providers fail; NotFound propagates', async () => {
    const { s } = svc([['finnhub.io', { status: 500 }], ['/chart/', { body: fixture('yahoo/notfound.json') }]], 'k');
    await assert.rejects(s.getQuote({ symbol: 'ZZZZ', market: 'US' }), NotFoundError);
  });

  it('caches quotes within a cycle and refetches after clearQuoteCache', async () => {
    const { f, s } = svc([YAHOO_AAPL]);
    await Promise.all([s.getQuote({ symbol: 'AAPL', market: 'US' }), s.getQuote({ symbol: 'aapl', market: 'US' })]);
    await s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(f.calls.length, 1);
    s.clearQuoteCache();
    await s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(f.calls.length, 2);
    await s.getQuote({ symbol: 'AAPL', market: 'US' }, { fresh: true });
    assert.strictEqual(f.calls.length, 3);
  });

  it('does not cache failures', async () => {
    let n = 0;
    const { f, s } = svc([['/chart/AAPL', () => (n++ === 0 ? { status: 500 } : { body: fixture('yahoo/AAPL.1d.json') })]]);
    await assert.rejects(s.getQuote({ symbol: 'AAPL', market: 'US' }));
    await s.getQuote({ symbol: 'AAPL', market: 'US' });
    assert.strictEqual(f.calls.length, 2);
  });

  it('fetches USDINR and falls back to the last known rate', async () => {
    let fail = false;
    const { s } = svc([['USDINR%3DX', () => (fail ? { status: 500 } : { body: fixture('yahoo/USDINR.1d.json') })]]);
    assert.deepStrictEqual(await s.getFxRate(), { rate: 94.93, stale: false });
    fail = true;
    s.clearQuoteCache();
    assert.deepStrictEqual(await s.getFxRate(), { rate: 94.93, stale: true });
    const none = svc([['USDINR', { status: 500 }]]);
    await assert.rejects(none.s.getFxRate());
  });

  it('returns index quotes with per-index errors', async () => {
    const { s } = svc([
      ['%5EGSPC', { body: fixture('yahoo/GSPC.1d.json') }],
      ['/chart/', { status: 500 }],
    ]);
    const res = await s.getIndexQuotes();
    assert.strictEqual(res.length, 6);
    const sp = res.find((r) => r.index.name === 'S&P 500')!;
    assert.strictEqual(sp.quote?.price, 7623.68);
    assert.ok(res.find((r) => r.index.name === 'NIFTY 50')!.error);
  });

  it('caches history for an hour and serves stale history when a refetch fails', async () => {
    let t = 1_000_000;
    let fail = false;
    const { f, s } = svc([['range=1mo', () => (fail ? { status: 500 } : { body: fixture('yahoo/AAPL.1mo.json') })]], undefined, { now: () => t });
    const ref = { symbol: 'AAPL', market: 'US' } as const;
    const h1 = await s.getHistory(ref);
    assert.strictEqual(h1.length, 22);
    t += 30 * 60_000;
    await s.getHistory(ref);
    assert.strictEqual(f.calls.length, 1);
    t += 31 * 60_000;
    fail = true;
    const h3 = await s.getHistory(ref);
    assert.strictEqual(f.calls.length, 2);
    assert.strictEqual(h3.length, 22, 'stale data served');
  });

  it('falls back to the NSE series when BSE history is sparse', async () => {
    const sparse = { chart: { result: [{ meta: { gmtoffset: 19800 }, timestamp: [1792751372], indicators: { quote: [{ close: [1190] }] } }], error: null } };
    const { f, s } = svc([
      ['/RELIANCE.BO?', { body: sparse }],
      ['/RELIANCE.NS?', { body: fixture('yahoo/RELIANCE.NS.1mo.json') }],
    ]);
    const h = await s.getHistory({ symbol: 'RELIANCE', market: 'BSE' });
    assert.strictEqual(h.length, 21);
    assert.strictEqual(f.calls.length, 2);
  });
});
