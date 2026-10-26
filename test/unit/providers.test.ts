import * as assert from 'assert';
import { fixture, mockFetch } from '../helpers';
import { parseFinnhubQuote, FinnhubProvider } from '../../src/market/finnhub';
import { parseYahooHistory, parseYahooQuote, YahooProvider, YAHOO_USER_AGENT } from '../../src/market/yahoo';
import { HttpError, NotFoundError, getJson } from '../../src/market/http';

describe('Yahoo parsing', () => {
  it('uses chartPreviousClose (range=1d) for equities: AAPL', () => {
    const q = parseYahooQuote(fixture('yahoo/AAPL.1d.json'), 'AAPL', false);
    assert.strictEqual(q.price, 347.725);
    assert.strictEqual(q.prevClose, 348.22);
    assert.ok(Math.abs(q.change - -0.495) < 1e-9);
    assert.ok(Math.abs(q.changePercent - -0.142) < 0.001); // matches Yahoo's regularMarketChangePercent
    assert.strictEqual(q.currency, 'USD');
    assert.strictEqual(q.source, 'yahoo');
    assert.strictEqual(q.time, 1792785601 * 1000);
  });

  it('parses an NSE quote in INR', () => {
    const q = parseYahooQuote(fixture('yahoo/RELIANCE.NS.1d.json'), 'RELIANCE.NS', false);
    assert.strictEqual(q.currency, 'INR');
    assert.strictEqual(q.prevClose, 1184.5);
    assert.ok(Math.abs(q.changePercent - 0.464) < 0.001);
  });

  it('derives crypto previous price from the rolling 24h change, not chartPreviousClose', () => {
    const q = parseYahooQuote(fixture('yahoo/BTC-USD.1d.json'), 'BTC-USD', true);
    // chartPreviousClose is 80039.69 (UTC midnight) but Yahoo's 24h change is -1.635%
    assert.ok(Math.abs(q.changePercent - -1.635) < 0.001);
    assert.ok(Math.abs(q.prevClose - 80803) < 1);
  });

  it('parses an index and FX (zero change)', () => {
    const idx = parseYahooQuote(fixture('yahoo/GSPC.1d.json'), '^GSPC', false);
    assert.strictEqual(idx.prevClose, 7663.43);
    assert.ok(idx.changePercent < 0);
    const fx = parseYahooQuote(fixture('yahoo/USDINR.1d.json'), 'USDINR=X', false);
    assert.strictEqual(fx.price, 94.93);
    assert.strictEqual(fx.currency, 'INR');
  });

  it('throws NotFoundError for unknown symbols', () => {
    assert.throws(() => parseYahooQuote(fixture('yahoo/notfound.json'), 'ZZZZ.NS', false), NotFoundError);
  });

  it('rejects responses without a price', () => {
    assert.throws(() => parseYahooQuote({ chart: { result: [{ meta: {} }] } }, 'X', false), /no price/);
  });

  it('parses history in exchange-local dates, skipping null closes', () => {
    const btc = parseYahooHistory(fixture('yahoo/BTC-USD.1mo.json'), 'BTC-USD');
    const dates = btc.map((d) => d.date);
    assert.ok(!dates.includes('2026-10-25'), 'null close for 2026-10-25 is skipped');
    assert.ok(dates.includes('2026-10-24') && dates.includes('2026-10-26'));
    assert.deepStrictEqual([...dates].sort(), dates);

    const aapl = parseYahooHistory(fixture('yahoo/AAPL.1mo.json'), 'AAPL');
    assert.strictEqual(aapl.length, 22);
    assert.strictEqual(aapl[aapl.length - 1].date, '2026-10-23'); // 13:30Z, EDT offset -4h
    assert.ok(Math.abs(aapl[aapl.length - 1].close - 347.73) < 0.01);

    const rel = parseYahooHistory(fixture('yahoo/RELIANCE.NS.1mo.json'), 'RELIANCE.NS');
    assert.strictEqual(rel[rel.length - 1].date, '2026-10-23'); // 03:45Z + IST offset
  });
});

describe('Yahoo provider requests', () => {
  it('requests range=1d with browser-like UA and encodes the symbol', async () => {
    const f = mockFetch([['/v8/finance/chart/', { body: fixture('yahoo/RELIANCE.NS.1d.json') }]]);
    const q = await new YahooProvider(f).getQuote('RELIANCE', 'NSE');
    assert.strictEqual(q.price, 1190);
    assert.ok(f.calls[0].includes('/RELIANCE.NS?range=1d&interval=1d'));
    assert.strictEqual(f.headers[0]['User-Agent'], YAHOO_USER_AGENT);
    await new YahooProvider(f).getQuoteRaw('^NSEI');
    assert.ok(f.calls[1].includes('%5ENSEI?range=1d'));
  });

  it('requests range=1mo for history', async () => {
    const f = mockFetch([['/v8/finance/chart/', { body: fixture('yahoo/AAPL.1mo.json') }]]);
    const h = await new YahooProvider(f).getHistory('AAPL', 'US');
    assert.ok(f.calls[0].includes('range=1mo&interval=1d'));
    assert.strictEqual(h.length, 22);
  });

  it('surfaces HTTP 429 as HttpError', async () => {
    const f = mockFetch([['/v8/', { status: 429 }]]);
    await assert.rejects(new YahooProvider(f).getQuote('AAPL', 'US'), (e: unknown) => e instanceof HttpError && e.status === 429);
  });
});

describe('Finnhub provider', () => {
  it('parses c/d/dp/pc', () => {
    const q = parseFinnhubQuote(fixture('finnhub/quote.AAPL.json'), 'AAPL');
    assert.strictEqual(q.price, 261.74);
    assert.strictEqual(q.prevClose, 262.94);
    assert.strictEqual(q.change, -1.2);
    assert.strictEqual(q.changePercent, -0.4564);
    assert.strictEqual(q.source, 'finnhub');
    assert.strictEqual(q.time, 1582641000 * 1000);
  });

  it('treats c === 0 as failure', () => {
    assert.throws(() => parseFinnhubQuote(fixture('finnhub/quote.unknown.json'), 'ZZZ'), /no data/);
  });

  it('only supports US/crypto and only with a key', () => {
    const f = mockFetch([]);
    assert.strictEqual(new FinnhubProvider(f, () => undefined).supports('US'), false);
    const p = new FinnhubProvider(f, () => 'k');
    assert.strictEqual(p.supports('US'), true);
    assert.strictEqual(p.supports('CRYPTO'), true);
    assert.strictEqual(p.supports('NSE'), false);
    assert.strictEqual(p.supports('BSE'), false);
  });

  it('builds the request URL with symbol and token', async () => {
    const f = mockFetch([['finnhub.io/api/v1/quote', { body: fixture('finnhub/quote.AAPL.json') }]]);
    const p = new FinnhubProvider(f, () => 'sekret key');
    await p.getQuote('BTC', 'CRYPTO');
    assert.ok(f.calls[0].includes('symbol=BINANCE%3ABTCUSDT'));
    assert.ok(f.calls[0].includes('token=sekret%20key'));
  });
});

describe('getJson', () => {
  it('times out slow requests', async () => {
    const slow = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    await assert.rejects(getJson('http://x', slow as never, {}, 20), /timed out/);
  });
});
