import {
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatSignedMoney,
  formatSignedNumber,
} from '../format';
import { HoldingRow, PortfolioSnapshot } from '../portfolio/controller';
import { nativeCurrency, PortfolioGroup } from '../symbols';
import { ChartRange, DEFAULT_CHART_RANGE } from '../types';

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
  /** Inline per-symbol error. */
  error?: string;
}

export interface IndexItemModel {
  name: string;
  level: Cell;
  change: Cell;
  percent: Cell;
  error?: string;
}

export interface IndexGroupModel {
  region: string;
  items: IndexItemModel[];
}

export interface PanelModel {
  hideAmounts: boolean;
  baseCurrency: string;
  /** Selected chart range (drives the 1D | 15D | 30D selector). */
  chartRange: ChartRange;
  loading: boolean;
  /** True when there are no holdings (show the empty state). */
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
  indices: IndexGroupModel[];
  indicesLoading: boolean;
  /** Portfolio-wide issues (FX, Finnhub, excluded holdings). Per-symbol errors are inline on rows / indices. */
  warnings: string[];
}

export interface PanelModelOptions {
  /** Formats the last-updated epoch ms. Defaults to the local time string. */
  formatTime?: (ms: number) => string;
  /** Selected chart range; defaults to 30D. */
  range?: ChartRange;
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

function buildRow(r: HoldingRow, hide: boolean): RowModel {
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
  return { id: h.id, label: `${h.market}:${h.symbol}`, cells, error: r.error };
}

function buildCards(s: PortfolioSnapshot): HeaderCard[] {
  const t = s.totals;
  if (!t) return [];
  const cur = t.currency;
  const pl: HeaderCard = s.hideAmounts
    ? { label: 'Total P/L', main: percentCell(t.pnlPercent) }
    : { label: 'Total P/L', main: signed(formatSignedMoney(t.pnl, cur), t.pnl), sub: percentCell(t.pnlPercent) };
  const today: HeaderCard = s.hideAmounts
    ? { label: 'Today', main: percentCell(t.dayChangePercent) }
    : { label: 'Today', main: signed(formatSignedMoney(t.dayChange, cur), t.dayChange), sub: percentCell(t.dayChangePercent) };
  return s.hideAmounts
    ? [pl, today]
    : [{ label: 'Current value', main: { text: formatMoney(t.current, cur) } }, { label: 'Invested', main: { text: formatMoney(t.invested, cur) } }, pl, today];
}

function buildIndices(s: PortfolioSnapshot): IndexGroupModel[] {
  const groups: IndexGroupModel[] = [];
  for (const region of ['India', 'US'] as const) {
    const locale = region === 'India' ? 'en-IN' : 'en-US';
    const items: IndexItemModel[] = [];
    for (const r of s.indices) {
      if (r.index.region !== region) continue;
      const q = r.quote;
      items.push({
        name: r.index.name,
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

export function buildPanelModel(s: PortfolioSnapshot, opts: PanelModelOptions = {}): PanelModel {
  const formatTime = opts.formatTime ?? ((ms: number) => new Date(ms).toLocaleTimeString());
  const warnings: string[] = [];
  for (const e of s.errors) if (e.scope === 'fx' || e.scope === 'finnhub') warnings.push(`${e.label}: ${e.message}`);
  if (s.totals && s.totals.skipped > 0) {
    warnings.push(`${s.totals.skipped} holding(s) excluded from totals (no quote or FX rate).`);
  }

  let statusMessage: string | undefined;
  if (s.hasHoldings && !s.totals) {
    statusMessage = s.loading || s.lastUpdated === undefined ? 'Loading quotes...' : 'Could not load quotes. See the errors below.';
  }

  const crossCurrency = s.holdings.some((r) => nativeCurrency(r.holding.market) !== s.baseCurrency);
  const fx =
    s.fxRate !== undefined && crossCurrency
      ? `1 USD = ${formatMoney(s.fxRate, 'INR')}${s.fxStale ? ' (stale)' : ''}`
      : undefined;

  return {
    hideAmounts: s.hideAmounts,
    baseCurrency: s.baseCurrency,
    chartRange: opts.range ?? DEFAULT_CHART_RANGE,
    loading: s.loading,
    empty: !s.hasHoldings,
    updated: s.lastUpdated !== undefined ? formatTime(s.lastUpdated) : undefined,
    dataSource: s.hasHoldings && s.sources.length > 0 ? s.dataSource : undefined,
    fx,
    statusMessage,
    cards: buildCards(s),
    columns: buildColumns(s.hideAmounts),
    rows: s.holdings.map((r) => buildRow(r, s.hideAmounts)),
    indices: buildIndices(s),
    indicesLoading: s.indices.length === 0,
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
    s.holdings.map(({ holding: h }) => [h.id, h.symbol, h.market, h.quantity, h.buyPrice, h.buyDate ?? null]),
  ]);
}
