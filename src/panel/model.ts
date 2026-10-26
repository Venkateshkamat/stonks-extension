import {
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatSignedMoney,
  formatSignedNumber,
} from '../format';
import { IndexResult, sourceLabel } from '../market/marketData';
import { HoldingRow, PortfolioSnapshot } from '../portfolio/controller';
import { PortfolioTotals } from '../portfolio/calc';
import { holdingPin, pinKey } from '../portfolio/pins';
import { marketGroup, nativeCurrency, PortfolioGroup } from '../symbols';
import { ChartRange, DEFAULT_CHART_RANGE } from '../types';
import { DEFAULT_HEATMAP_SOURCE, DEFAULT_PANEL_VIEW, findHeatmapSource, HEATMAP_SOURCES, HeatmapWidget, heatmapConfig, PanelView, viewGroup } from './views';

/** Serializable view model posted to the webview. All formatting happens here so the webview stays dumb. */

export type CellTone = 'gain' | 'loss' | 'muted';

export interface Cell {
  text: string;
  tone?: CellTone;
  /** Hover text. */
  title?: string;
}

export interface Column {
  label: string;
  align: 'left' | 'right';
}

export interface HeaderCard {
  label: string;
  main: Cell;
  sub?: Cell;
}

export interface RowModel {
  id: string;
  /** e.g. NSE:RELIANCE (for accessible button labels). */
  label: string;
  cells: Cell[];
  /** Pin identity (shared by all lots of the symbol) and whether it is pinned to the status bar. */
  pinKey: string;
  pinned: boolean;
  /** Inline per-symbol error. */
  error?: string;
}

export interface IndexItemModel {
  name: string;
  pinKey: string;
  pinned: boolean;
  level: Cell;
  change: Cell;
  percent: Cell;
  error?: string;
}

export interface IndexGroupModel {
  region: string;
  items: IndexItemModel[];
}

/** What the Heatmap view needs to embed a TradingView widget. */
export interface HeatmapModel {
  /** Selected source id (HEATMAP_SOURCES). */
  source: string;
  widget: HeatmapWidget;
  /** Widget JSON config without `colorTheme` (the webview adds it from the VS Code theme). */
  config: Record<string, string | number | boolean>;
  options: Array<{ value: string; label: string }>;
}

export interface PanelModel {
  /** Selected view (drives the Stocks | Crypto | Heatmap switcher). */
  view: PanelView;
  /** Present only in the Heatmap view. */
  heatmap?: HeatmapModel;
  hideAmounts: boolean;
  baseCurrency: string;
  /** Selected chart range (drives the 1D | 15D | 30D selector). */
  chartRange: ChartRange;
  loading: boolean;
  /** True when the selected view has no holdings (show its empty state). */
  empty: boolean;
  /** Pre-formatted "last updated" time. */
  updated?: string;
  dataSource?: string;
  /** e.g. "1 USD = ₹83.50". */
  fx?: string;
  /** Shown instead of the header cards while there are no totals (loading / failed). */
  statusMessage?: string;
  cards: HeaderCard[];
  columns: Column[];
  rows: RowModel[];
  /** Markets table: indices (Stocks view) or major coins (Crypto view). */
  indices: IndexGroupModel[];
  indicesLoading: boolean;
  marketsTitle: string;
  /** Column headings of the Markets table. */
  marketsNameLabel: string;
  marketsLevelLabel: string;
  /** Portfolio-wide issues (FX, Finnhub, excluded holdings). Per-symbol errors are inline on rows / indices. */
  warnings: string[];
}

export interface PanelModelOptions {
  /** Formats the last-updated epoch ms. Defaults to the local time string. */
  formatTime?: (ms: number) => string;
  /** Selected chart range; defaults to 30D. */
  range?: ChartRange;
  /** Selected view; defaults to Stocks. */
  view?: PanelView;
  /** Selected heatmap source (Heatmap view); defaults to the S&P 500. */
  heatmapSource?: string;
}

const MUTED: Cell = { text: '--', tone: 'muted' };

/** Gain/loss tone for a value as it will be displayed (rounded to 2 decimals so +0.00 is neutral). */
export function toneOf(n: number): CellTone | undefined {
  const r = Math.round(n * 100) / 100;
  return r > 0 ? 'gain' : r < 0 ? 'loss' : undefined;
}

function signed(text: string, n: number): Cell {
  return { text, tone: toneOf(n) };
}

function percentCell(p: number): Cell {
  return signed(formatPercent(p), p);
}

const ALL_COLUMNS = ['Symbol', 'Market', 'Qty', 'Avg Buy', 'LTP', 'Day %', 'Invested', 'Current', 'P/L', 'P/L %'];
const HIDDEN_COLUMNS = ['Symbol', 'Market', 'LTP', 'Day %', 'P/L %'];

function buildColumns(hide: boolean): Column[] {
  return (hide ? HIDDEN_COLUMNS : ALL_COLUMNS).map((label) => ({
    label,
    align: label === 'Symbol' || label === 'Market' ? 'left' : 'right',
  }));
}

function buildRow(r: HoldingRow, hide: boolean, pinned: ReadonlySet<string>): RowModel {
  const { holding: h, pnl } = r;
  const cur = nativeCurrency(h.market);
  const symbolCell: Cell = { text: h.symbol, title: h.buyDate ? `Bought ${h.buyDate}` : undefined };
  const marketCell: Cell = { text: h.market, tone: 'muted' };
  const ltp: Cell = pnl ? { text: formatPrice(pnl.ltp, cur) } : MUTED;
  const day: Cell = pnl ? percentCell(pnl.dayChangePercent) : MUTED;
  const plPct: Cell = pnl ? percentCell(pnl.pnlPercent) : MUTED;

  const cells: Cell[] = hide
    ? [symbolCell, marketCell, ltp, day, plPct]
    : [
        symbolCell,
        marketCell,
        { text: formatQuantity(h.quantity, cur) },
        { text: formatPrice(h.buyPrice, cur) },
        ltp,
        day,
        { text: formatMoney(h.quantity * h.buyPrice, cur) },
        pnl ? { text: formatMoney(pnl.current, cur) } : MUTED,
        pnl ? signed(formatSignedMoney(pnl.pnl, cur), pnl.pnl) : MUTED,
        plPct,
      ];
  const key = pinKey(holdingPin(h.market, h.symbol));
  return { id: h.id, label: `${h.market}:${h.symbol}`, cells, pinKey: key, pinned: pinned.has(key), error: r.error };
}

function buildCards(t: PortfolioTotals | undefined, hideAmounts: boolean): HeaderCard[] {
  if (!t) return [];
  const cur = t.currency;
  const hide = hideAmounts;
  const pl: HeaderCard = hide
    ? { label: 'Total P/L', main: percentCell(t.pnlPercent) }
    : { label: 'Total P/L', main: signed(formatSignedMoney(t.pnl, cur), t.pnl), sub: percentCell(t.pnlPercent) };
  const today: HeaderCard = hide
    ? { label: 'Today', main: percentCell(t.dayChangePercent) }
    : { label: 'Today', main: signed(formatSignedMoney(t.dayChange, cur), t.dayChange), sub: percentCell(t.dayChangePercent) };
  return hide
    ? [pl, today]
    : [{ label: 'Current value', main: { text: formatMoney(t.current, cur) } }, { label: 'Invested', main: { text: formatMoney(t.invested, cur) } }, pl, today];
}

function buildIndices(indices: readonly IndexResult[], pinned: ReadonlySet<string>): IndexGroupModel[] {
  const groups: IndexGroupModel[] = [];
  for (const region of ['India', 'US'] as const) {
    const locale = region === 'India' ? 'en-IN' : 'en-US';
    const items: IndexItemModel[] = [];
    for (const r of indices) {
      if (r.index.region !== region) continue;
      const q = r.quote;
      const key = pinKey({ kind: 'market', symbol: r.index.symbol });
      items.push({
        name: r.index.name,
        pinKey: key,
        pinned: pinned.has(key),
        level: q ? { text: formatNumber(q.price, locale) } : MUTED,
        change: q ? signed(formatSignedNumber(q.change, locale), q.change) : MUTED,
        percent: q ? percentCell(q.changePercent) : MUTED,
        error: q ? undefined : r.error,
      });
    }
    if (items.length > 0) groups.push({ region, items });
  }
  return groups;
}

/** Signed per-unit price change that keeps sub-dollar coins readable: +$880.00 / -$0.012. */
function signedPrice(n: number, cur: 'INR' | 'USD'): string {
  if (n === 0) return formatPrice(0, cur);
  return n < 0 ? `-${formatPrice(-n, cur)}` : `+${formatPrice(n, cur)}`;
}

/** The Crypto view's Markets table: one group of priced coin rows. */
function buildCoins(coins: readonly IndexResult[], pinned: ReadonlySet<string>): IndexGroupModel[] {
  const items: IndexItemModel[] = coins.map((r) => {
    const q = r.quote;
    const cur = r.index.currency ?? 'USD';
    const key = pinKey({ kind: 'market', symbol: r.index.symbol });
    return {
      name: r.index.name,
      pinKey: key,
      pinned: pinned.has(key),
      level: q ? { text: formatPrice(q.price, cur) } : MUTED,
      change: q ? { text: signedPrice(q.change, cur), tone: toneOf(q.change) } : MUTED,
      percent: q ? percentCell(q.changePercent) : MUTED,
      error: q ? undefined : r.error,
    };
  });
  return items.length > 0 ? [{ region: 'Crypto', items }] : [];
}

export function buildPanelModel(s: PortfolioSnapshot, opts: PanelModelOptions = {}): PanelModel {
  const formatTime = opts.formatTime ?? ((ms: number) => new Date(ms).toLocaleTimeString());
  const view = opts.view ?? DEFAULT_PANEL_VIEW;
  const group = viewGroup(view);
  const rows = group ? s.holdings.filter((r) => marketGroup(r.holding.market) === group) : [];
  const summary = group ? s.groups.find((g) => g.group === group) : undefined;
  const totals = summary?.totals;
  const crossCurrency = rows.some((r) => nativeCurrency(r.holding.market) !== s.baseCurrency);

  const warnings: string[] = [];
  for (const e of s.errors) {
    if (e.scope === 'finnhub' || (e.scope === 'fx' && crossCurrency)) warnings.push(`${e.label}: ${e.message}`);
  }
  if (totals && totals.skipped > 0) {
    warnings.push(`${totals.skipped} holding(s) excluded from totals (no quote or FX rate).`);
  }

  let statusMessage: string | undefined;
  if (rows.length > 0 && !totals) {
    statusMessage = s.loading || s.lastUpdated === undefined ? 'Loading quotes...' : 'Could not load quotes. See the errors below.';
  }

  const pinned = new Set(s.pins.map((p) => p.key));
  const fx =
    s.fxRate !== undefined && crossCurrency
      ? `1 USD = ${formatMoney(s.fxRate, 'INR')}${s.fxStale ? ' (stale)' : ''}`
      : undefined;
  const sources = [...new Set(rows.flatMap((r) => (r.quote ? [r.quote.source] : [])))];
  const crypto = view === 'crypto';
  const heatmapSource = findHeatmapSource(opts.heatmapSource ?? DEFAULT_HEATMAP_SOURCE);

  return {
    view,
    heatmap:
      view === 'heatmap'
        ? { source: heatmapSource.id, widget: heatmapSource.widget, config: heatmapConfig(heatmapSource.id), options: HEATMAP_SOURCES.map((o) => ({ value: o.id, label: o.label })) }
        : undefined,
    hideAmounts: s.hideAmounts,
    baseCurrency: s.baseCurrency,
    chartRange: opts.range ?? DEFAULT_CHART_RANGE,
    loading: s.loading,
    empty: group ? rows.length === 0 : false,
    updated: s.lastUpdated !== undefined ? formatTime(s.lastUpdated) : undefined,
    dataSource: sources.length > 0 ? sourceLabel(sources) : undefined,
    fx,
    statusMessage,
    cards: buildCards(totals, s.hideAmounts),
    columns: buildColumns(s.hideAmounts),
    rows: rows.map((r) => buildRow(r, s.hideAmounts, pinned)),
    indices: !group ? [] : crypto ? buildCoins(s.coins, pinned) : buildIndices(s.indices, pinned),
    indicesLoading: group ? (crypto ? s.coins : s.indices).length === 0 : false,
    marketsTitle: crypto ? 'Major coins' : 'Markets',
    marketsNameLabel: crypto ? 'Coin' : 'Index',
    marketsLevelLabel: crypto ? 'Price' : 'Level',
    warnings,
  };
}

/**
 * Identity of everything the chart depends on. Quote refreshes do not change it. `group` restricts the chart to
 * stocks or crypto (the Stocks / Crypto views); omitted = whole portfolio.
 */
export function historyKey(
  s: Pick<PortfolioSnapshot, 'holdings' | 'hideAmounts' | 'baseCurrency'>,
  range: ChartRange = DEFAULT_CHART_RANGE,
  group?: PortfolioGroup,
): string {
  return JSON.stringify([
    s.baseCurrency,
    s.hideAmounts,
    range,
    group ?? null,
    s.holdings.filter(({ holding: h }) => !group || marketGroup(h.market) === group).map(({ holding: h }) => [h.id, h.symbol, h.market, h.quantity, h.buyPrice, h.buyDate ?? null]),
  ]);
}
