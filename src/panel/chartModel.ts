import { currencyLocale, currencySymbol, formatMoney, formatPercent, formatSignedMoney } from '../format';
import { HistorySeries } from '../portfolio/controller';
import { ChartRange } from '../types';

export const RANGE_WORDS: Record<ChartRange, string> = { '1D': '1-day', '15D': '15-day', '30D': '30-day' };

/** Serializable chart model (1D / 15D / 30D) posted to the webview. */
export interface ChartModel {
  /** historyKey() of the data this chart was built for. */
  key: string;
  range: ChartRange;
  /** 'value' plots portfolio value; 'percent' plots P/L % (used when amounts are hidden). */
  mode: 'value' | 'percent';
  title: string;
  /** Short x-axis labels, e.g. "12 Oct" (daily) or "14:15" (1D). */
  labels: string[];
  values: number[];
  /** Tooltip heading per point, e.g. "Mon, 12 Oct 2026" or "Fri, 23 Oct, 14:15". */
  tooltipTitles: string[];
  /** Tooltip body lines per point. */
  tooltips: string[][];
  /** Whether the plotted line ended above (gain), below (loss) or at its start. */
  trend: 'gain' | 'loss' | 'neutral';
  axis: { kind: 'money' | 'percent'; symbol?: string; locale?: string };
  /** Shown instead of the chart when there is nothing to plot. */
  message?: string;
  errors: string[];
}

/** Created on first use: building an Intl.DateTimeFormat costs several milliseconds, which must not be paid at extension startup. */
function dateFmt(opts: Intl.DateTimeFormatOptions): (date: string) => string {
  let f: Intl.DateTimeFormat | undefined;
  return (date) => (f ??= new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' })).format(new Date(`${date}T00:00:00Z`));
}
const shortDate = dateFmt({ day: 'numeric', month: 'short' });
const longDate = dateFmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export interface ChartModelOptions {
  /** IANA timezone for intraday labels. Defaults to the host's local timezone. */
  timeZone?: string;
}

export function buildChartModel(series: HistorySeries, key: string, opts: ChartModelOptions = {}): ChartModel {
  const intraday = series.range === '1D';
  const timeOnly = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: opts.timeZone });
  const dateTime = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: opts.timeZone });
  const hide = series.hideAmounts;
  const cur = series.baseCurrency;
  const mode: ChartModel['mode'] = hide ? 'percent' : 'value';
  const base: ChartModel = {
    key,
    range: series.range,
    mode,
    title: hide ? `${RANGE_WORDS[series.range]} P/L %` : `${RANGE_WORDS[series.range]} portfolio value (${currencySymbol(cur)} ${cur})`,
    labels: [],
    values: [],
    tooltipTitles: [],
    tooltips: [],
    trend: 'neutral',
    axis: hide ? { kind: 'percent' } : { kind: 'money', symbol: currencySymbol(cur), locale: currencyLocale(cur) },
    errors: series.errors,
  };
  if (series.points.length === 0) {
    return { ...base, message: series.errors.length > 0 ? 'Could not load price history.' : 'No price history available.' };
  }

  const pts = series.points;
  base.labels = pts.map((p) => (intraday && p.time !== undefined ? timeOnly.format(p.time) : shortDate(p.date)));
  base.tooltipTitles = pts.map((p) => (intraday && p.time !== undefined ? dateTime.format(p.time) : longDate(p.date)));
  base.values = pts.map((p) => (hide ? p.pnlPercent : p.value));
  base.tooltips = pts.map((p) =>
    hide ? [`P/L: ${formatPercent(p.pnlPercent)}`] : [`Value: ${formatMoney(p.value, cur)}`, `P/L: ${formatSignedMoney(p.pnl, cur)} (${formatPercent(p.pnlPercent)})`],
  );
  const first = base.values[0];
  const last = base.values[base.values.length - 1];
  const delta = Math.round((last - first) * 100) / 100;
  base.trend = delta > 0 ? 'gain' : delta < 0 ? 'loss' : 'neutral';
  return base;
}
