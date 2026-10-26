import { Currency, Holding, ProviderId, Quote } from '../types';
import { nativeCurrency } from '../symbols';
import { errorMessage, mapSettled } from '../util/async';
import { Disposable, Emitter, Event } from '../util/emitter';
import { IndexResult, MarketDataService, sourceLabel } from '../market/marketData';
import { Settings, SettingsSource } from '../settings';
import { computeHoldingPnL, computeTotals, HoldingPnL, PortfolioTotals } from './calc';
import { buildHistorySeries, HistoryPoint } from './history';
import { HoldingsStore } from './store';

export interface HoldingRow {
  holding: Holding;
  /** Present once a quote has been fetched for this holding. */
  quote?: Quote;
  /** Native-currency figures; present iff `quote` is. */
  pnl?: HoldingPnL;
  /** Set when the last quote fetch for this holding failed. */
  error?: string;
}

export interface SnapshotError {
  scope: 'holding' | 'fx' | 'index' | 'finnhub';
  /** Holding id for scope 'holding'. */
  holdingId?: string;
  /** Human label, e.g. "NSE:RELIANCE" or "NIFTY 50". */
  label: string;
  message: string;
}

/** Everything the status bar and webview need to render, already computed. */
export interface PortfolioSnapshot {
  holdings: HoldingRow[];
  hasHoldings: boolean;
  /** Totals in `baseCurrency`; undefined when there are no priced holdings. */
  totals?: PortfolioTotals;
  /** Index quotes; empty unless indices were requested via setIncludeIndices(true). */
  indices: IndexResult[];
  /** USD -> INR; undefined if never fetched / not needed. */
  fxRate?: number;
  fxStale: boolean;
  baseCurrency: Currency;
  hideAmounts: boolean;
  /** Epoch ms of the last completed refresh. */
  lastUpdated?: number;
  /** True while a refresh is in flight. */
  loading: boolean;
  errors: SnapshotError[];
  /** Providers that supplied the holding quotes. */
  sources: ProviderId[];
  /** e.g. "Finnhub + Yahoo Finance". */
  dataSource: string;
}

export interface HistorySeries {
  baseCurrency: Currency;
  hideAmounts: boolean;
  /** Ascending by date. Points hold both value and P/L %, so the UI can switch based on hideAmounts. */
  points: HistoryPoint[];
  errors: string[];
}

export type RefreshReason = 'start' | 'timer' | 'manual' | 'holdings' | 'settings' | 'key';

export interface FetchedData {
  quotes: Map<string, Quote>; // by holding id
  quoteErrors: Map<string, string>;
  fx?: { rate: number; stale: boolean };
  fxError?: string;
  indices: IndexResult[];
  finnhubIssue?: string;
  lastUpdated?: number;
}

const FINNHUB_MESSAGES = {
  rejected: 'Finnhub API key was rejected; using Yahoo Finance instead.',
  'rate-limited': 'Finnhub rate limit reached; using Yahoo Finance instead.',
  error: 'Finnhub request failed; using Yahoo Finance instead.',
} as const;

export function holdingLabel(h: Holding): string {
  return `${h.market}:${h.symbol}`;
}

/** Pure: assemble a snapshot from holdings, fetched data and settings. */
export function buildSnapshot(
  holdings: readonly Holding[],
  data: FetchedData,
  settings: Settings,
  loading: boolean,
): PortfolioSnapshot {
  const rows: HoldingRow[] = holdings.map((holding) => {
    const quote = data.quotes.get(holding.id);
    return {
      holding,
      quote,
      pnl: quote ? computeHoldingPnL(holding, quote) : undefined,
      error: data.quoteErrors.get(holding.id),
    };
  });
  const priced = rows.filter((r) => r.pnl);
  const errors: SnapshotError[] = [];
  for (const r of rows) {
    if (r.error) errors.push({ scope: 'holding', holdingId: r.holding.id, label: holdingLabel(r.holding), message: r.error });
  }
  if (data.fxError && holdings.some((h) => nativeCurrency(h.market) !== settings.baseCurrency)) {
    errors.push({ scope: 'fx', label: 'USDINR', message: data.fxError });
  }
  for (const i of data.indices) if (i.error) errors.push({ scope: 'index', label: i.index.name, message: i.error });
  if (data.finnhubIssue) errors.push({ scope: 'finnhub', label: 'Finnhub', message: data.finnhubIssue });

  const sources = [...new Set(priced.map((r) => r.quote!.source))];
  return {
    holdings: rows,
    hasHoldings: holdings.length > 0,
    totals: priced.length > 0 ? computeTotals(rows, settings.baseCurrency, data.fx?.rate) : undefined,
    indices: data.indices,
    fxRate: data.fx?.rate,
    fxStale: data.fx?.stale ?? false,
    baseCurrency: settings.baseCurrency,
    hideAmounts: settings.hideAmounts,
    lastUpdated: data.lastUpdated,
    loading,
    errors,
    sources,
    dataSource: sourceLabel(sources),
  };
}

export interface ControllerDeps {
  store: HoldingsStore;
  market: MarketDataService;
  settings: SettingsSource;
  now?: () => number;
}

/**
 * Central portfolio state. Owns the refresh loop, merges holdings + quotes + FX + indices into a
 * PortfolioSnapshot and notifies listeners (status bar, webview) via onDidUpdate. VS Code agnostic.
 */
export class PortfolioController implements Disposable {
  private readonly updated = new Emitter<PortfolioSnapshot>();
  /** Fires with a fresh snapshot after every refresh and on holdings / settings changes. */
  readonly onDidUpdate: Event<PortfolioSnapshot> = this.updated.event;

  private data: FetchedData = { quotes: new Map(), quoteErrors: new Map(), indices: [] };
  private settings: Settings;
  private current: PortfolioSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private rerun?: RefreshReason;
  private includeIndices = false;
  private disposed = false;
  private readonly now: () => number;
  private readonly subscriptions: Disposable[] = [];

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.settings = deps.settings.get();
    this.current = buildSnapshot(deps.store.list(), this.data, this.settings, false);
    this.subscriptions.push(deps.store.onDidChange(() => this.onHoldingsChanged()));
  }

  /** Latest computed snapshot. */
  get snapshot(): PortfolioSnapshot {
    return this.current;
  }

  /** Starts the refresh loop (immediate refresh, then every refreshIntervalSeconds). */
  start(): Promise<void> {
    return this.refresh('start');
  }

  /** Whether refreshes should also fetch index quotes (the webview turns this on while open). */
  setIncludeIndices(on: boolean): void {
    if (this.includeIndices === on) return;
    this.includeIndices = on;
    if (on) void this.refresh('settings');
    else {
      this.data = { ...this.data, indices: [] };
      this.rebuild();
    }
  }

  /** Re-reads settings after a configuration change. No network call unless needed. */
  notifySettingsChanged(): void {
    const prev = this.settings;
    this.settings = this.deps.settings.get();
    if (prev.baseCurrency !== this.settings.baseCurrency) {
      // Re-base instantly when the conversion rate is already known (or not needed) so the UI reacts at once;
      // otherwise wait for the refresh to bring the rate.
      const base = this.settings.baseCurrency;
      if (this.data.fx || this.deps.store.list().every((h) => nativeCurrency(h.market) === base)) this.rebuild(true);
      void this.refresh('settings');
    } else {
      this.rebuild();
      this.schedule();
    }
  }

  async toggleHideAmounts(): Promise<void> {
    await this.deps.settings.setHideAmounts(!this.settings.hideAmounts);
    // The configuration change event normally triggers notifySettingsChanged; do it directly too (idempotent).
    this.notifySettingsChanged();
  }

  async setBaseCurrency(currency: Currency): Promise<void> {
    await this.deps.settings.setBaseCurrency(currency);
    this.notifySettingsChanged();
  }

  /** Fetches all quotes now. Overlapping calls are coalesced into one follow-up run. */
  refresh(reason: RefreshReason = 'manual'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.rerun = reason === 'manual' || reason === 'key' || !this.rerun ? reason : this.rerun;
      return this.running;
    }
    this.running = (async () => {
      let r: RefreshReason | undefined = reason;
      try {
        while (r && !this.disposed) {
          this.rerun = undefined;
          await this.doRefresh(r);
          r = this.rerun;
        }
      } finally {
        this.running = undefined;
        this.schedule();
      }
    })();
    return this.running;
  }

  /** 30-day portfolio series (value, invested, P/L, P/L %) in the base currency. */
  async getHistorySeries(): Promise<HistorySeries> {
    const holdings = this.deps.store.list();
    const base = this.settings.baseCurrency;
    const errors: string[] = [];
    const settled = await mapSettled(holdings, 4, (h) => this.deps.market.getHistory(h));
    const items = holdings.map((holding, i) => {
      const r = settled[i];
      if (!r.ok) errors.push(`${holdingLabel(holding)}: ${r.error.message}`);
      return { holding, closes: r.ok ? r.value : undefined };
    });
    let usdInr = this.data.fx?.rate;
    if (holdings.some((h) => nativeCurrency(h.market) !== base) && usdInr === undefined) {
      try {
        usdInr = (await this.deps.market.getFxRate()).rate;
      } catch (e) {
        errors.push(`USDINR: ${errorMessage(e)}`);
      }
    }
    return {
      baseCurrency: base,
      hideAmounts: this.settings.hideAmounts,
      points: buildHistorySeries(items, { base, usdInr }),
      errors,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
    this.updated.dispose();
  }

  // ---- internals ----

  private onHoldingsChanged(): void {
    // Drop data for removed holdings and show the new list immediately; then fetch quotes.
    const ids = new Set(this.deps.store.list().map((h) => h.id));
    for (const id of [...this.data.quotes.keys()]) if (!ids.has(id)) this.data.quotes.delete(id);
    for (const id of [...this.data.quoteErrors.keys()]) if (!ids.has(id)) this.data.quoteErrors.delete(id);
    this.rebuild();
    void this.refresh('holdings');
  }

  private rebuild(loading = this.running !== undefined): void {
    this.current = buildSnapshot(this.deps.store.list(), this.data, this.settings, loading);
    if (!this.disposed) this.updated.fire(this.current);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.disposed) return;
    this.timer = setTimeout(() => void this.refresh('timer'), this.settings.refreshIntervalSeconds * 1000);
    // Don't keep the Node process alive just for the timer (matters for tests / smoke scripts).
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async doRefresh(reason: RefreshReason): Promise<void> {
    const { market } = this.deps;
    this.settings = this.deps.settings.get();
    const holdings = this.deps.store.list();
    if (reason !== 'holdings' && reason !== 'settings') market.clearQuoteCache();
    if (this.data.lastUpdated === undefined) this.rebuild(true);

    const quotes = new Map<string, Quote>();
    const quoteErrors = new Map<string, string>();
    const results = await mapSettled(holdings, 4, (h) => market.getQuote(h));
    holdings.forEach((h, i) => {
      const r = results[i];
      if (r.ok) quotes.set(h.id, r.value);
      else {
        quoteErrors.set(h.id, r.error.message);
        // keep showing the previous quote for this holding while flagging the error
        const prev = this.data.quotes.get(h.id);
        if (prev) quotes.set(h.id, prev);
      }
    });

    let fx = this.data.fx;
    let fxError: string | undefined;
    if (holdings.some((h) => nativeCurrency(h.market) !== this.settings.baseCurrency)) {
      try {
        fx = await market.getFxRate();
        if (fx.stale) fxError = 'Live USDINR rate unavailable; using last known rate.';
      } catch (e) {
        fxError = `USDINR rate unavailable: ${errorMessage(e)}`;
      }
    }

    let indices = this.data.indices;
    if (this.includeIndices) indices = await market.getIndexQuotes();

    const issue = market.getFinnhubIssue();
    this.data = {
      quotes,
      quoteErrors,
      fx,
      fxError,
      indices,
      finnhubIssue: issue ? FINNHUB_MESSAGES[issue] : undefined,
      lastUpdated: this.now(),
    };
    this.rebuild(false);
  }
}
