import { ChartRange, COINS, Currency, DEFAULT_CHART_RANGE, findMarketDef, Holding, IndexDef, INDICES, IntradayPoint, ProviderId, Quote } from '../types';
import { marketGroup, nativeCurrency, normalizeSymbol, PORTFOLIO_GROUPS, PortfolioGroup } from '../symbols';
import { errorMessage, mapSettled } from '../util/async';
import { Disposable, Emitter, Event } from '../util/emitter';
import { ALWAYS_FOCUSED, FocusSource } from '../util/focus';
import { IndexResult, MarketDataService, sourceLabel } from '../market/marketData';
import { MarketClock, MS_MIN, sessionAt } from '../market/hours';
import { QuoteCacheData, SharedQuoteCache } from '../market/quoteCache';
import { clockForIndex, clockForMarket, MAX_SLEEP_MS, nextDueAt, refreshIntervalMs } from '../market/schedule';
import { Settings, SettingsSource } from '../settings';
import { computeHoldingPnL, computeTotals, HoldingPnL, PortfolioTotals } from './calc';
import { buildHistorySeries, buildIntradaySeries, HistoryPoint } from './history';
import { buildPinItems, Pin, PinItem, PinStore } from './pins';
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

/** Totals for one portfolio group (stocks or crypto), in the base currency. Only groups that have holdings are listed. */
export interface GroupSummary {
  group: PortfolioGroup;
  /** Number of holdings (lots) in the group. */
  holdings: number;
  /** Undefined while none of the group's holdings has a quote (or a needed FX rate). */
  totals?: PortfolioTotals;
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
  /** Per-group totals (stocks = NSE/BSE/US, crypto), in `stocks`, `crypto` order; groups without holdings are omitted. */
  groups: GroupSummary[];
  /** Index quotes; empty unless indices were requested via setIncludeIndices(true). */
  indices: IndexResult[];
  /** Major-coin quotes; empty unless requested via setIncludeCoins(true) (the panel's Crypto view). */
  coins: IndexResult[];
  /** Pinned tickers resolved against the latest quotes, in pin order (status bar items). */
  pins: PinItem[];
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
  range: ChartRange;
  baseCurrency: Currency;
  hideAmounts: boolean;
  /** Ascending by date (by time for the 1D range). Points hold both value and P/L %, so the UI can switch based on hideAmounts. */
  points: HistoryPoint[];
  errors: string[];
}

export type RefreshReason = 'start' | 'timer' | 'manual' | 'holdings' | 'settings' | 'key' | 'focus';

export interface FetchedData {
  quotes: Map<string, Quote>; // by holding id
  quoteErrors: Map<string, string>;
  fx?: { rate: number; stale: boolean };
  fxError?: string;
  indices: IndexResult[];
  /** Quotes for the major coins (only while the Crypto view is open). */
  coins?: IndexResult[];
  /** Quotes for pinned market rows (fetched even when the panel is closed). */
  pinnedMarkets?: IndexResult[];
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
  pins: readonly Pin[] = [],
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
  for (const i of [...data.indices, ...(data.coins ?? [])]) if (i.error) errors.push({ scope: 'index', label: i.index.name, message: i.error });
  if (data.finnhubIssue) errors.push({ scope: 'finnhub', label: 'Finnhub', message: data.finnhubIssue });

  const sources = [...new Set(priced.map((r) => r.quote!.source))];
  return {
    holdings: rows,
    hasHoldings: holdings.length > 0,
    totals: priced.length > 0 ? computeTotals(rows, settings.baseCurrency, data.fx?.rate) : undefined,
    groups: PORTFOLIO_GROUPS.flatMap((group): GroupSummary[] => {
      const inGroup = rows.filter((r) => marketGroup(r.holding.market) === group);
      if (inGroup.length === 0) return [];
      const hasQuote = inGroup.some((r) => r.pnl);
      return [{ group, holdings: inGroup.length, totals: hasQuote ? computeTotals(inGroup, settings.baseCurrency, data.fx?.rate) : undefined }];
    }),
    indices: data.indices,
    coins: data.coins ?? [],
    pins: buildPinItems(pins, rows, data.pinnedMarkets ?? []),
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
  /** Pinned tickers; their quotes are fetched like the holdings' (index pins even when the panel is closed). */
  pins?: PinStore;
  now?: () => number;
  /**
   * Quote cache shared with the other editor windows (and kept across restarts): quotes another window fetched
   * recently are used instead of fetching again, and the controller's own fetches are written back.
   */
  cache?: SharedQuoteCache;
  /** Whether the editor window is focused; refreshes are five times less frequent while it is not. Default: always focused. */
  focus?: FocusSource;
  /** Random source for wake-up jitter (so several windows do not all fetch at the same instant). Default Math.random. */
  random?: () => number;
}

/** One quote the snapshot needs, and how to fetch it. */
interface Need {
  key: string;
  clock: MarketClock;
  load: () => Promise<Quote>;
}

/** What the controller knows about one quote: the last good value, when it was fetched, and the last failure. */
interface QuoteEntry {
  quote?: Quote;
  /** When `quote` was fetched (epoch ms). */
  at?: number;
  /** When the last fetch was attempted (successful or not). */
  attemptAt?: number;
  /** Set while the last attempt failed. */
  error?: string;
}

/** How long after a failed fetch of a closed market's quote to try again. */
const CLOSED_RETRY_MS = 5 * MS_MIN;
/** Wake-ups are never closer together than this. */
const MIN_SLEEP_MS = 1000;
/** Upper bound of the random delay added to each wake-up. */
const MAX_JITTER_MS = 3000;
/** Upper bound of the random delay before the startup refresh when cached data is already on screen. */
const START_JITTER_MS = 1500;

function holdingQuoteKey(h: Holding): string {
  return `q:${h.market}:${normalizeSymbol(h.symbol, h.market)}`;
}

/**
 * Central portfolio state. Owns the refresh loop, merges holdings + quotes + FX + indices into a
 * PortfolioSnapshot and notifies listeners (status bar, webview) via onDidUpdate. VS Code agnostic.
 *
 * Refreshing is per quote: each quote is re-fetched only when it is due (see market/schedule.ts) - not at all while
 * its market is closed, apart from one fetch after the close. A single timer sleeps until the earliest due time.
 */
export class PortfolioController implements Disposable {
  private readonly updated = new Emitter<PortfolioSnapshot>();
  /** Fires with a fresh snapshot after every refresh and on holdings / settings changes. */
  readonly onDidUpdate: Event<PortfolioSnapshot> = this.updated.event;

  private readonly entries = new Map<string, QuoteEntry>();
  private finnhubIssue?: string;
  private lastAttemptAt?: number;
  private settings: Settings;
  private current: PortfolioSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private rerun?: RefreshReason;
  private includeIndices = false;
  private includeCoins = false;
  private pins: Pin[] = [];
  private disposed = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly focus: FocusSource;
  private readonly subscriptions: Disposable[] = [];

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.focus = deps.focus ?? ALWAYS_FOCUSED;
    this.settings = deps.settings.get();
    this.pins = deps.pins?.list() ?? [];
    this.adoptShared();
    this.current = buildSnapshot(deps.store.list(), this.buildData(), this.settings, false, this.pins);
    this.subscriptions.push(deps.store.onDidChange(() => this.onHoldingsChanged()));
    if (deps.pins) this.subscriptions.push(deps.pins.onDidChange(() => this.onPinsChanged()));
    this.subscriptions.push(this.focus.onDidChange((focused) => this.onFocusChanged(focused)));
  }

  /** Latest computed snapshot. */
  get snapshot(): PortfolioSnapshot {
    return this.current;
  }

  /** The refresh interval currently in effect, in seconds. */
  get currentRefreshIntervalSeconds(): number {
    return this.settings.refreshIntervalSeconds;
  }

  /**
   * Starts the refresh loop: fetches whatever is due now, then sleeps until the next quote is due. When cached
   * quotes are already showing, the first fetch waits a random moment so that several windows opening together
   * (e.g. on editor startup) do not all request the same quotes.
   */
  start(): Promise<void> {
    const delay = this.current.lastUpdated !== undefined ? Math.round(this.random() * START_JITTER_MS) : 0;
    if (delay <= 0) return this.refresh('start');
    return new Promise((resolve) => {
      this.startTimer = setTimeout(() => void this.refresh('start').then(resolve), delay);
      (this.startTimer as { unref?: () => void }).unref?.();
    });
  }

  /** Whether refreshes should also fetch index quotes (the panel's Stocks view turns this on while shown). */
  setIncludeIndices(on: boolean): void {
    this.setWatchlists({ indices: on });
  }

  /** Whether refreshes should also fetch the major coins' quotes (the panel's Crypto view turns this on while shown). */
  setIncludeCoins(on: boolean): void {
    this.setWatchlists({ coins: on });
  }

  /** Sets both Markets-table watch-lists at once (one refresh at most); omitted keys are left as they are. */
  setWatchlists(w: { indices?: boolean; coins?: boolean }): void {
    const indices = w.indices ?? this.includeIndices;
    const coins = w.coins ?? this.includeCoins;
    if (indices === this.includeIndices && coins === this.includeCoins) return;
    const turnedOn = (indices && !this.includeIndices) || (coins && !this.includeCoins);
    this.includeIndices = indices;
    this.includeCoins = coins;
    this.rebuild();
    if (turnedOn) void this.refresh('settings');
  }

  /** Re-reads settings after a configuration change. No network call unless needed. */
  notifySettingsChanged(): void {
    const prev = this.settings;
    this.settings = this.deps.settings.get();
    if (prev.baseCurrency !== this.settings.baseCurrency) {
      // Re-base instantly when the conversion rate is already known (or not needed) so the UI reacts at once;
      // otherwise wait for the refresh to bring the rate.
      const base = this.settings.baseCurrency;
      if (this.entries.get(FX_KEY)?.quote || this.deps.store.list().every((h) => nativeCurrency(h.market) === base)) this.rebuild(true);
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

  async setRefreshIntervalSeconds(seconds: number): Promise<void> {
    await this.deps.settings.setRefreshIntervalSeconds(seconds);
    this.notifySettingsChanged();
  }

  /**
   * Fetches the quotes that are due now (all of them for a 'manual' or 'key' refresh, whatever the market state).
   * Overlapping calls are coalesced into one follow-up run.
   */
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

  /**
   * Portfolio series (value, invested, P/L, P/L %) in the base currency for a chart range: daily closes for
   * 15D / 30D, 15-minute bars over the last 24h for 1D. `group` restricts it to stocks or crypto holdings.
   */
  async getHistorySeries(range: ChartRange = DEFAULT_CHART_RANGE, group?: PortfolioGroup): Promise<HistorySeries> {
    const holdings = this.deps.store.list().filter((h) => !group || marketGroup(h.market) === group);
    const base = this.settings.baseCurrency;
    const errors: string[] = [];
    const needsFx = holdings.some((h) => nativeCurrency(h.market) !== base);
    const common = { range, baseCurrency: base, hideAmounts: this.settings.hideAmounts };

    if (range === '1D') {
      const settled = await mapSettled(holdings, 4, (h) => this.deps.market.getIntraday(h));
      const items = holdings.map((holding, i) => {
        const r = settled[i];
        if (!r.ok) errors.push(`${holdingLabel(holding)}: ${r.error.message}`);
        return { holding, points: r.ok ? r.value : undefined };
      });
      let fxSeries: IntradayPoint[] | undefined;
      let usdInr = this.fxRate();
      if (needsFx) {
        try {
          fxSeries = await this.deps.market.getFxIntraday();
        } catch {
          // fall back to the spot rate below
        }
        if (!fxSeries?.length && usdInr === undefined) {
          try {
            usdInr = (await this.deps.market.getFxRate()).rate;
          } catch (e) {
            errors.push(`USDINR: ${errorMessage(e)}`);
          }
        }
      }
      return { ...common, points: buildIntradaySeries(items, { base, usdInr, fxSeries, now: this.now() }), errors };
    }

    const settled = await mapSettled(holdings, 4, (h) => this.deps.market.getHistory(h));
    const items = holdings.map((holding, i) => {
      const r = settled[i];
      if (!r.ok) errors.push(`${holdingLabel(holding)}: ${r.error.message}`);
      return { holding, closes: r.ok ? r.value : undefined };
    });
    let usdInr = this.fxRate();
    if (needsFx && usdInr === undefined) {
      try {
        usdInr = (await this.deps.market.getFxRate()).rate;
      } catch (e) {
        errors.push(`USDINR: ${errorMessage(e)}`);
      }
    }
    return { ...common, points: buildHistorySeries(items, { base, usdInr, days: range === '15D' ? 15 : 30 }), errors };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.subscriptions.forEach((s) => s.dispose());
    this.updated.dispose();
  }

  // ---- internals ----

  private onHoldingsChanged(): void {
    // Show the new list immediately (removed holdings disappear); then fetch quotes for any holding that has none.
    this.rebuild();
    void this.refresh('holdings');
  }

  private onFocusChanged(focused: boolean): void {
    if (focused) void this.refresh('focus'); // fetches whatever went stale at the normal pace while unfocused
    else this.schedule(); // lengthen the pending wake-up
  }

  private onPinsChanged(): void {
    const before = this.pinnedMarketDefs().map((d) => d.symbol).join(',');
    this.pins = this.deps.pins?.list() ?? [];
    const defs = this.pinnedMarketDefs();
    this.rebuild();
    // Newly pinned market rows need a quote now rather than at the next wake-up.
    if (defs.length > 0 && defs.map((d) => d.symbol).join(',') !== before) void this.refresh('settings');
  }

  /** Market rows (indices today) currently pinned, in pin order. */
  private pinnedMarketDefs(): IndexDef[] {
    const out: IndexDef[] = [];
    for (const p of this.pins) {
      const def = p.kind === 'market' ? findMarketDef(p.symbol) : undefined;
      if (def) out.push(def);
    }
    return out;
  }

  /**
   * Takes over quotes that another window (or an earlier session) fetched more recently than ours. Returns whether
   * anything changed.
   */
  private adoptShared(): boolean {
    const cache = this.deps.cache;
    if (!cache) return false;
    let changed = false;
    for (const [key, c] of Object.entries(cache.load())) {
      const cur = this.entries.get(key);
      if (cur?.at !== undefined && cur.at >= c.at) continue;
      this.entries.set(key, { quote: c.quote, at: c.at, attemptAt: c.at });
      changed = true;
    }
    return changed;
  }

  private fxRate(): number | undefined {
    return this.entries.get(FX_KEY)?.quote?.price;
  }

  /** Everything the current holdings, pins and open watch-lists need quotes for, de-duplicated by quote key. */
  private collectNeeds(): Need[] {
    const { market } = this.deps;
    const needs = new Map<string, Need>();
    const add = (n: Need) => {
      if (!needs.has(n.key)) needs.set(n.key, n);
    };
    const holdings = this.deps.store.list();
    for (const h of holdings) add({ key: holdingQuoteKey(h), clock: clockForMarket(h.market), load: () => market.getQuote(h) });
    if (holdings.some((h) => nativeCurrency(h.market) !== this.settings.baseCurrency)) {
      add({ key: FX_KEY, clock: 'FX', load: () => market.getFxQuote() });
    }
    const marketDefs = [...(this.includeIndices ? INDICES : []), ...(this.includeCoins ? COINS : []), ...this.pinnedMarketDefs()];
    for (const def of marketDefs) add({ key: marketQuoteKey(def), clock: clockForIndex(def), load: () => market.getMarketQuote(def) });
    return [...needs.values()];
  }

  private intervalMs(clock: MarketClock): number {
    return refreshIntervalMs(clock, this.settings.refreshIntervalSeconds, this.focus.focused);
  }

  /** When this quote should next be fetched (<= now means due). */
  private dueAt(n: Need, now: number): number {
    const e = this.entries.get(n.key);
    const interval = this.intervalMs(n.clock);
    const due = nextDueAt(n.clock, e?.at, now, interval);
    if (e?.attemptAt !== undefined && (e.at === undefined || e.attemptAt > e.at)) {
      // The last attempt failed: do not retry before the normal interval (sooner would hammer a failing endpoint).
      return Math.max(due, e.attemptAt + (sessionAt(n.clock, now).open ? interval : CLOSED_RETRY_MS));
    }
    return due;
  }

  private buildData(): FetchedData {
    const holdings = this.deps.store.list();
    /** Entries behind what is on screen: "last updated" is the newest of them. */
    const used: QuoteEntry[] = [];
    const quotes = new Map<string, Quote>();
    const quoteErrors = new Map<string, string>();
    for (const h of holdings) {
      const e = this.entries.get(holdingQuoteKey(h));
      if (!e) continue;
      used.push(e);
      if (e.quote) quotes.set(h.id, e.quote);
      if (e.error) quoteErrors.set(h.id, e.error);
    }
    const fxEntry = this.entries.get(FX_KEY);
    if (fxEntry && holdings.some((h) => nativeCurrency(h.market) !== this.settings.baseCurrency)) used.push(fxEntry);
    const fx = fxEntry?.quote ? { rate: fxEntry.quote.price, stale: fxEntry.error !== undefined } : undefined;
    let fxError: string | undefined;
    if (fxEntry?.error) fxError = fx ? 'Live USDINR rate unavailable; using last known rate.' : `USDINR rate unavailable: ${fxEntry.error}`;
    const result = (index: IndexDef): IndexResult => {
      const e = this.entries.get(marketQuoteKey(index));
      if (e) used.push(e);
      return e?.quote ? { index, quote: e.quote } : { index, error: e?.error ?? 'No quote yet' };
    };
    const indices = this.includeIndices ? INDICES.map(result) : [];
    const coins = this.includeCoins ? COINS.map(result) : [];
    const pinnedMarkets = this.pinnedMarketDefs().map(result);
    let lastUpdated: number | undefined;
    for (const e of used) if (e.at !== undefined && (lastUpdated === undefined || e.at > lastUpdated)) lastUpdated = e.at;
    return { quotes, quoteErrors, fx, fxError, indices, coins, pinnedMarkets, finnhubIssue: this.finnhubIssue, lastUpdated: lastUpdated ?? this.lastAttemptAt };
  }

  private rebuild(loading = this.running !== undefined): void {
    this.current = buildSnapshot(this.deps.store.list(), this.buildData(), this.settings, loading, this.pins);
    if (!this.disposed) this.updated.fire(this.current);
  }

  /** Sleeps until the earliest quote is due (never longer than MAX_SLEEP_MS, so a long sleep / clock change is re-checked). */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const needs = this.collectNeeds();
    if (needs.length === 0) return; // nothing to keep fresh: no timer at all
    if (this.adoptShared()) this.rebuild(); // another window fetched in the meantime: show it and wake up later
    const now = this.now();
    let due = Infinity;
    for (const n of needs) due = Math.min(due, this.dueAt(n, now));
    const jitter = this.random() * Math.min(MAX_JITTER_MS, this.settings.refreshIntervalSeconds * 50);
    const delay = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, due - now + jitter));
    this.timer = setTimeout(() => void this.refresh('timer'), delay);
    // Don't keep the Node process alive just for the timer (matters for tests / smoke scripts).
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async doRefresh(reason: RefreshReason): Promise<void> {
    const { market } = this.deps;
    this.settings = this.deps.settings.get();
    const force = reason === 'manual' || reason === 'key';
    const now = this.now();
    const adopted = this.adoptShared();
    const todo = this.collectNeeds().filter((n) => force || this.dueAt(n, now) <= now);
    if (todo.length === 0) {
      if (adopted || this.current.loading) this.rebuild(false);
      return;
    }
    if (this.current.lastUpdated === undefined) this.rebuild(true);
    market.clearQuoteCache();
    const results = await mapSettled(todo, 4, (n) => n.load());
    const done = this.now();
    this.lastAttemptAt = done;
    const fetched: QuoteCacheData = {};
    todo.forEach((n, i) => {
      const r = results[i];
      const prev = this.entries.get(n.key);
      if (r.ok) {
        this.entries.set(n.key, { quote: r.value, at: done, attemptAt: done });
        fetched[n.key] = { quote: r.value, at: done };
      } else {
        this.entries.set(n.key, { quote: prev?.quote, at: prev?.at, attemptAt: done, error: r.error.message });
      }
    });
    if (Object.keys(fetched).length > 0) this.deps.cache?.save(fetched);
    const issue = market.getFinnhubIssue();
    this.finnhubIssue = issue ? FINNHUB_MESSAGES[issue] : undefined;
    this.rebuild(false);
  }
}

const FX_KEY = 'fx';

function marketQuoteKey(def: IndexDef): string {
  return `i:${def.symbol}`;
}
