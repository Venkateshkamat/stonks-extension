import { Currency, DailyClose, Market, Quote } from '../types';
import { yahooSymbol } from '../symbols';
import { FetchFn, getJson, NotFoundError } from './http';
import { QuoteProvider } from './provider';

// Yahoo rejects curl-like and (inconsistently) full Chrome user agents with 429;
// a short Mozilla UA is accepted reliably.
export const YAHOO_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

interface YahooMeta {
  currency?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  gmtoffset?: number;
}

interface YahooResult {
  meta?: YahooMeta;
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
}

interface YahooResponse {
  chart?: {
    result?: YahooResult[] | null;
    error?: { code?: string; description?: string } | null;
  };
}

function extractResult(json: unknown, rawSymbol: string): YahooResult {
  const chart = (json as YahooResponse)?.chart;
  const err = chart?.error;
  if (err) {
    if (err.code === 'Not Found') throw new NotFoundError(`${rawSymbol}: no data found`);
    throw new Error(`Yahoo error for ${rawSymbol}: ${err.description ?? err.code ?? 'unknown'}`);
  }
  const result = chart?.result?.[0];
  if (!result) throw new NotFoundError(`${rawSymbol}: no data found`);
  return result;
}

/**
 * Field semantics (verified live against range=1d):
 *  - regularMarketPrice: last regular-session price.
 *  - chartPreviousClose with range=1d: the previous trading day's close for
 *    equities/indices/FX. With longer ranges (e.g. 1mo) it is the close BEFORE
 *    the range start, so quotes must always use range=1d.
 *  - Crypto trades 24/7: chartPreviousClose is a UTC-midnight reference, whereas
 *    regularMarketChangePercent is the rolling 24h change Yahoo displays, so for
 *    crypto the previous price is derived from the percentage.
 */
export function parseYahooQuote(json: unknown, rawSymbol: string, isCrypto: boolean): Quote {
  const meta = extractResult(json, rawSymbol).meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo returned no price for ${rawSymbol}`);
  }
  const pct = meta?.regularMarketChangePercent;
  const impliedPrev =
    typeof pct === 'number' && Number.isFinite(pct) && pct > -100 ? price / (1 + pct / 100) : undefined;
  const reference = meta?.chartPreviousClose ?? meta?.previousClose;
  let prev: number;
  if (isCrypto) prev = impliedPrev ?? reference ?? price;
  else prev = reference ?? impliedPrev ?? price;
  const change = price - prev;
  const currency: Currency = meta?.currency === 'INR' ? 'INR' : 'USD';
  return {
    symbol: rawSymbol,
    price,
    prevClose: prev,
    change,
    changePercent: prev > 0 ? (change / prev) * 100 : 0,
    currency,
    source: 'yahoo',
    time: (meta?.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}

function toDate(tsSeconds: number, gmtoffset: number): string {
  return new Date((tsSeconds + gmtoffset) * 1000).toISOString().slice(0, 10);
}

/** Daily closes with null entries skipped; dates are in the exchange's local time. */
export function parseYahooHistory(json: unknown, rawSymbol: string): DailyClose[] {
  const result = extractResult(json, rawSymbol);
  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const offset = result.meta?.gmtoffset ?? 0;
  const byDate = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && Number.isFinite(c)) byDate.set(toDate(ts[i], offset), c);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
}

export class YahooProvider implements QuoteProvider {
  readonly id = 'yahoo' as const;

  constructor(private readonly fetchFn: FetchFn) {}

  supports(_market: Market): boolean {
    return true;
  }

  getQuote(symbol: string, market: Market): Promise<Quote> {
    return this.getQuoteRaw(yahooSymbol(symbol, market), market === 'CRYPTO');
  }

  /** Quote for an arbitrary Yahoo symbol (indices, FX). */
  async getQuoteRaw(rawSymbol: string, isCrypto = false): Promise<Quote> {
    const json = await this.fetchChart(rawSymbol, '1d');
    return parseYahooQuote(json, rawSymbol, isCrypto);
  }

  async getHistory(symbol: string, market: Market): Promise<DailyClose[]> {
    const raw = yahooSymbol(symbol, market);
    const json = await this.fetchChart(raw, '1mo');
    return parseYahooHistory(json, raw);
  }

  private fetchChart(rawSymbol: string, range: '1d' | '1mo'): Promise<unknown> {
    const url = `${BASE_URL}${encodeURIComponent(rawSymbol)}?range=${range}&interval=1d`;
    return getJson(url, this.fetchFn, { 'User-Agent': YAHOO_USER_AGENT, Accept: 'application/json' });
  }
}
