import { finnhubSupports, finnhubSymbol } from '../symbols';
import { Market, Quote } from '../types';
import { FetchFn, getJson } from './http';
import { QuoteProvider } from './provider';

const BASE_URL = 'https://finnhub.io/api/v1/quote';

interface FinnhubQuote {
  c?: number;
  d?: number | null;
  dp?: number | null;
  pc?: number;
  t?: number;
}

/** Finnhub returns all zeros (c === 0) for unknown symbols; treat that as failure. */
export function parseFinnhubQuote(json: unknown, symbol: string): Quote {
  const q = json as FinnhubQuote;
  if (!q || typeof q.c !== 'number' || !Number.isFinite(q.c) || q.c === 0) {
    throw new Error(`Finnhub returned no data for ${symbol}`);
  }
  const prev = typeof q.pc === 'number' && q.pc > 0 ? q.pc : q.c - (q.d ?? 0);
  const change = typeof q.d === 'number' ? q.d : q.c - prev;
  const pct = typeof q.dp === 'number' ? q.dp : prev > 0 ? (change / prev) * 100 : 0;
  return {
    symbol,
    price: q.c,
    prevClose: prev,
    change,
    changePercent: pct,
    currency: 'USD',
    source: 'finnhub',
    time: q.t && q.t > 0 ? q.t * 1000 : Date.now(),
  };
}

export class FinnhubProvider implements QuoteProvider {
  readonly id = 'finnhub' as const;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly getApiKey: () => string | undefined,
  ) {}

  supports(market: Market): boolean {
    return Boolean(this.getApiKey()) && finnhubSupports(market);
  }

  async getQuote(symbol: string, market: Market): Promise<Quote> {
    const key = this.getApiKey();
    const fh = finnhubSymbol(symbol, market);
    if (!key || !fh) throw new Error('Finnhub not available for this symbol');
    return this.fetchQuote(fh, key);
  }

  /** Used to validate a freshly entered API key. Throws HttpError(401/403) when rejected. */
  async fetchQuote(providerSymbol: string, apiKey: string): Promise<Quote> {
    const url = `${BASE_URL}?symbol=${encodeURIComponent(providerSymbol)}&token=${encodeURIComponent(apiKey)}`;
    const json = await getJson(url, this.fetchFn);
    return parseFinnhubQuote(json, providerSymbol);
  }
}
