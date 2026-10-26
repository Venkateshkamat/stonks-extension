/**
 * Live smoke test against real Yahoo Finance (no Finnhub key). Not part of `npm test`.
 * Run with: npm run test:live
 */
import { MarketDataService } from '../../src/market/marketData';
import { SymbolRef } from '../../src/types';

async function main(): Promise<void> {
  const svc = new MarketDataService({ fetch: (u, i) => fetch(u, i), getFinnhubKey: () => undefined });
  const refs: SymbolRef[] = [
    { symbol: 'AAPL', market: 'US' },
    { symbol: 'RELIANCE', market: 'NSE' },
    { symbol: 'RELIANCE', market: 'BSE' },
    { symbol: 'BTC', market: 'CRYPTO' },
  ];
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) {
      failures++;
      console.error('  FAIL:', msg);
    }
  };
  for (const ref of refs) {
    try {
      const q = await svc.getQuote(ref);
      console.log(
        `${ref.market}:${ref.symbol} ${q.currency} price=${q.price} prev=${q.prevClose.toFixed(2)} ` +
          `day=${q.changePercent.toFixed(2)}% src=${q.source} t=${new Date(q.time).toISOString()}`,
      );
      check(q.price > 0 && q.prevClose > 0 && Math.abs(q.changePercent) < 25, `${ref.symbol} sane numbers`);
      const h = await svc.getHistory(ref);
      console.log(`  history: ${h.length} days, ${h[0]?.date} .. ${h[h.length - 1]?.date}, last close=${h[h.length - 1]?.close}`);
      check(h.length >= 15, `${ref.symbol} history length`);
    } catch (e) {
      failures++;
      console.error(`${ref.market}:${ref.symbol} ERROR`, e instanceof Error ? e.message : e);
    }
  }
  try {
    const fx = await svc.getFxRate();
    console.log(`USDINR rate=${fx.rate} stale=${fx.stale}`);
    check(fx.rate > 50 && fx.rate < 200, 'fx sane');
  } catch (e) {
    failures++;
    console.error('FX ERROR', e);
  }
  for (const r of await svc.getIndexQuotes()) {
    if (r.quote) console.log(`${r.index.region} ${r.index.name}: ${r.quote.price} (${r.quote.change.toFixed(2)}, ${r.quote.changePercent.toFixed(2)}%)`);
    else {
      failures++;
      console.error(`${r.index.name} ERROR ${r.error}`);
    }
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nLive smoke test OK');
  process.exit(failures ? 1 : 0);
}

void main();
