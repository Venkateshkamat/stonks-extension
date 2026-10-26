import { mapSettled, errorMessage } from '../util/async';
import { FX_SYMBOL, DailyClose, IndexDef, INDICES, ProviderId, Quote, SymbolRef } from '../types';
import { normalizeSymbol } from '../symbols';
import { FetchFn, HttpError } from './http';
import { FinnhubProvider } from './finnhub';
import { YahooProvider } from './yahoo';

const SPARSE_HISTORY_DAYS = 5;

export interface MarketDataOptions {
  fetch: FetchFn;
  /** Returns the Finnhub API key, if any. Must be synchronous (cache the secret in memory). */
  getFinnhubKey: () => string | undefined;
  now?: () => number;
  /** In-cycle quote cache TTL. Default 10s; cleared explicitly at the start of every refresh cycle. */
  quoteTtlMs?: number;
  /** History cache TTL. Default 1 hour. */
  historyTtlMs?: number;
  /** Max concurrent requests for batch calls. Default 4. */
  concurrency?: number;
}

export interface FxResult {
  /** USD -> INR */
  rate: number;
  /** True when the live fetch failed and the last known rate is returned. */
  stale: boolean;
}

export interface IndexResult {
  index: IndexDef;
  quote?: Quote;
  error?: string;
}

export type FinnhubIssue = 'rejected' | 'rate-limited' | 'error';

interface CacheEntry<T> {
  at: number;
  promise: Promise<T>;
}

export class MarketDataService {
  readonly yahoo: YahooProvider;
  readonly finnhub: FinnhubProvider;

  private readonly now: () => number;
  private readonly quoteTtl: number;
  private readonly historyTtl: number;
  private readonly concurrency: number;
  private quotes = new Map<string, CacheEntry<Quote>>();
  private history = new Map<string, { at: number; value?: DailyClose[]; promise?: Promise<DailyClose[]> }>();
  private lastFx?: number;
  private finnhubIssue?: FinnhubIssue;

  constructor(opts: MarketDataOptions) {
    this.yahoo = new YahooProvider(opts.fetch);
    this.finnhub = new FinnhubProvider(opts.fetch, opts.getFinnhubKey);
    this.now = opts.now ?? Date.now;
    this.quoteTtl = opts.quoteTtlMs ?? 10_000;
    this.historyTtl = opts.historyTtlMs ?? 60 * 60 * 1000;
    this.concurrency = opts.concurrency ?? 4;
  }

  /** Latest Finnhub problem seen since the last successful Finnhub call (undefined = none). */
  getFinnhubIssue(): FinnhubIssue | undefined {
    return this.finnhubIssue;
  }

  /** Call at the start of every refresh cycle so quotes are re-fetched. */
  clearQuoteCache(): void {
    this.quotes.clear();
  }

  clearAll(): void {
    this.quotes.clear();
    this.history.clear();
    this.finnhubIssue = undefined;
  }

  /** Quote with Finnhub-first (when keyed and supported) and per-symbol fallback to Yahoo. */
  getQuote(ref: SymbolRef, opts: { fresh?: boolean } = {}): Promise<Quote> {
    const key = `q:${ref.market}:${normalizeSymbol(ref.symbol, ref.market)}`;
    return this.cachedQuote(key, opts.fresh ?? false, () => this.fetchQuote(ref));
  }

  private async fetchQuote(ref: SymbolRef): Promise<Quote> {
    if (this.finnhub.supports(ref.market)) {
      try {
        const q = await this.finnhub.getQuote(ref.symbol, ref.market);
        this.finnhubIssue = undefined;
        return q;
      } catch (e) {
        this.finnhubIssue = classifyFinnhubError(e);
        // fall through to Yahoo
      }
    }
    return this.yahoo.getQuote(ref.symbol, ref.market);
  }

  /** USD -> INR rate from Yahoo. Falls back to the last known rate (stale: true) when the fetch fails. */
  async getFxRate(): Promise<FxResult> {
    try {
      const q = await this.cachedQuote('fx', false, () => this.yahoo.getQuoteRaw(FX_SYMBOL));
      this.lastFx = q.price;
      return { rate: q.price, stale: false };
    } catch (e) {
      if (this.lastFx !== undefined) return { rate: this.lastFx, stale: true };
      throw e;
    }
  }

  async getIndexQuotes(): Promise<IndexResult[]> {
    const settled = await mapSettled(INDICES, this.concurrency, (index) =>
      this.cachedQuote(`i:${index.symbol}`, false, () => this.yahoo.getQuoteRaw(index.symbol)),
    );
    return INDICES.map((index, i) => {
      const r = settled[i];
      return r.ok ? { index, quote: r.value } : { index, error: errorMessage(r.error) };
    });
  }

  /** ~1 month of daily closes (Yahoo), cached for an hour; stale cache is served if a refetch fails. */
  getHistory(ref: SymbolRef): Promise<DailyClose[]> {
    const key = `h:${ref.market}:${normalizeSymbol(ref.symbol, ref.market)}`;
    const entry = this.history.get(key);
    if (entry && this.now() - entry.at < this.historyTtl) {
      if (entry.value) return Promise.resolve(entry.value);
      if (entry.promise) return entry.promise;
    }
    const stale = entry?.value;
    const promise = this.fetchHistory(ref)
      .then((value) => {
        this.history.set(key, { at: this.now(), value });
        return value;
      })
      .catch((e) => {
        if (stale) {
          this.history.set(key, { at: this.now() - this.historyTtl + 60_000, value: stale });
          return stale;
        }
        this.history.delete(key);
        throw e;
      });
    this.history.set(key, { at: this.now(), promise, value: undefined });
    return promise;
  }

  private async fetchHistory(ref: SymbolRef): Promise<DailyClose[]> {
    const h = await this.yahoo.getHistory(ref.symbol, ref.market);
    // Yahoo's BSE (.BO) listings are sometimes nearly empty (a single bar). The same company's
    // NSE series is a close proxy for the chart, so use it when BSE history is too sparse.
    if (ref.market === 'BSE' && h.length < SPARSE_HISTORY_DAYS) {
      try {
        const nse = await this.yahoo.getHistory(ref.symbol, 'NSE');
        if (nse.length > h.length) return nse;
      } catch {
        // keep the sparse BSE series
      }
    }
    return h;
  }

  private cachedQuote(key: string, fresh: boolean, load: () => Promise<Quote>): Promise<Quote> {
    const hit = this.quotes.get(key);
    if (!fresh && hit && this.now() - hit.at < this.quoteTtl) return hit.promise;
    const promise = load();
    const entry: CacheEntry<Quote> = { at: this.now(), promise };
    this.quotes.set(key, entry);
    promise.catch(() => {
      if (this.quotes.get(key) === entry) this.quotes.delete(key);
    });
    return promise;
  }
}

export function classifyFinnhubError(e: unknown): FinnhubIssue {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) return 'rejected';
    if (e.status === 429) return 'rate-limited';
  }
  return 'error';
}

export function sourceLabel(sources: Iterable<ProviderId>): string {
  const set = new Set(sources);
  if (set.size === 0) return 'n/a';
  return [...set].map((s) => (s === 'finnhub' ? 'Finnhub' : 'Yahoo Finance')).join(' + ');
}
