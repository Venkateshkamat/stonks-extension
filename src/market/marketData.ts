import { mapSettled, errorMessage } from '../util/async';
import { FX_SYMBOL, COINS, DailyClose, IndexDef, INDICES, IntradayPoint, ProviderId, Quote, SymbolRef } from '../types';
import { normalizeSymbol } from '../symbols';
import { FetchFn, HttpError } from './http';
import { FinnhubProvider } from './finnhub';
import { YahooProvider } from './yahoo';

const SPARSE_HISTORY_DAYS = 5;
const SPARSE_INTRADAY_POINTS = 10;

/** How long intraday series stay cached (and the minimum gap between 1D chart reloads). */
export const INTRADAY_TTL_MS = 5 * 60 * 1000;

export interface MarketDataOptions {
  fetch: FetchFn;
  /** Returns the Finnhub API key, if any. Must be synchronous (cache the secret in memory). */
  getFinnhubKey: () => string | undefined;
  now?: () => number;
  /** In-cycle quote cache TTL. Default 10s; cleared explicitly at the start of every refresh cycle. */
  quoteTtlMs?: number;
  /** History cache TTL. Default 1 hour. */
  historyTtlMs?: number;
  /** Intraday (15m bars) cache TTL. Default 5 minutes. */
  intradayTtlMs?: number;
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

interface SeriesEntry<T> {
  at: number;
  value?: T;
  promise?: Promise<T>;
}

export class MarketDataService {
  readonly yahoo: YahooProvider;
  readonly finnhub: FinnhubProvider;

  private readonly now: () => number;
  private readonly quoteTtl: number;
  private readonly historyTtl: number;
  private readonly intradayTtl: number;
  private readonly concurrency: number;
  private quotes = new Map<string, CacheEntry<Quote>>();
  private history = new Map<string, SeriesEntry<DailyClose[]>>();
  private intraday = new Map<string, SeriesEntry<IntradayPoint[]>>();
  private lastFx?: number;
  private finnhubIssue?: FinnhubIssue;

  constructor(opts: MarketDataOptions) {
    this.yahoo = new YahooProvider(opts.fetch);
    this.finnhub = new FinnhubProvider(opts.fetch, opts.getFinnhubKey);
    this.now = opts.now ?? Date.now;
    this.quoteTtl = opts.quoteTtlMs ?? 10_000;
    this.historyTtl = opts.historyTtlMs ?? 60 * 60 * 1000;
    this.intradayTtl = opts.intradayTtlMs ?? INTRADAY_TTL_MS;
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
    this.intraday.clear();
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

  getIndexQuotes(): Promise<IndexResult[]> {
    return this.getMarketQuotes(INDICES);
  }

  /** Quotes for the major coins (Crypto view's Markets table). */
  getCoinQuotes(): Promise<IndexResult[]> {
    return this.getMarketQuotes(COINS);
  }

  /** Quotes for watch-list markets (indices and coins) by Yahoo symbol, with per-symbol errors. */
  async getMarketQuotes(defs: readonly IndexDef[]): Promise<IndexResult[]> {
    const settled = await mapSettled(defs, this.concurrency, (index) =>
      // Coins trade 24/7: their day change is the rolling 24h one, like crypto holdings.
      this.cachedQuote(`i:${index.symbol}`, false, () => this.yahoo.getQuoteRaw(index.symbol, index.region === 'Crypto')),
    );
    return defs.map((index, i) => {
      const r = settled[i];
      return r.ok ? { index, quote: r.value } : { index, error: errorMessage(r.error) };
    });
  }

  /** ~1 month of daily closes (Yahoo), cached for an hour; stale cache is served if a refetch fails. */
  getHistory(ref: SymbolRef): Promise<DailyClose[]> {
    const key = `h:${ref.market}:${normalizeSymbol(ref.symbol, ref.market)}`;
    return this.cachedSeries(this.history, key, this.historyTtl, () => this.fetchHistory(ref));
  }

  /**
   * ~5 trading days of 15-minute closes (Yahoo) for the 1D chart, cached for 5 minutes; stale cache is served
   * if a refetch fails. The extra days before the 24h window let symbols that have not traded yet today seed
   * their forward-fill.
   */
  getIntraday(ref: SymbolRef): Promise<IntradayPoint[]> {
    const key = `hi:${ref.market}:${normalizeSymbol(ref.symbol, ref.market)}`;
    return this.cachedSeries(this.intraday, key, this.intradayTtl, () => this.fetchIntraday(ref));
  }

  /** Intraday USDINR=X series, used to convert holdings at the rate prevailing at each chart point. */
  getFxIntraday(): Promise<IntradayPoint[]> {
    return this.cachedSeries(this.intraday, `hi:fx`, this.intradayTtl, () => this.yahoo.getIntradayRaw(FX_SYMBOL));
  }

  private cachedSeries<T>(cache: Map<string, SeriesEntry<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const entry = cache.get(key);
    if (entry && this.now() - entry.at < ttl) {
      if (entry.value) return Promise.resolve(entry.value);
      if (entry.promise) return entry.promise;
    }
    const stale = entry?.value;
    const promise = load()
      .then((value) => {
        cache.set(key, { at: this.now(), value });
        return value;
      })
      .catch((e) => {
        if (stale) {
          // serve the stale series and retry in a minute
          cache.set(key, { at: this.now() - ttl + 60_000, value: stale });
          return stale;
        }
        cache.delete(key);
        throw e;
      });
    cache.set(key, { at: this.now(), promise });
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

  private async fetchIntraday(ref: SymbolRef): Promise<IntradayPoint[]> {
    const h = await this.yahoo.getIntraday(ref.symbol, ref.market);
    // Same BSE (.BO) sparsity workaround as for daily history: fall back to the NSE listing.
    if (ref.market === 'BSE' && h.length < SPARSE_INTRADAY_POINTS) {
      try {
        const nse = await this.yahoo.getIntraday(ref.symbol, 'NSE');
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
