import { currencyLocale, currencySymbol, formatMoney, formatPercent, formatSignedMoney } from '../format';
import { HistorySeries } from '../portfolio/controller';

/** Serializable 30-day chart model posted to the webview. */
export interface ChartModel {
  /** historyKey() of the data this chart was built for. */
  key: string;
  /** 'value' plots portfolio value; 'percent' plots P/L % (used when amounts are hidden). */
  mode: 'value' | 'percent';
  title: string;
  /** Short x-axis labels, e.g. "12 Oct". */
  labels: string[];
  values: number[];
  /** Tooltip heading per point, e.g. "Mon, 12 Oct 2026". */
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

function dateFmt(opts: Intl.DateTimeFormatOptions): (date: string) => string {
  const f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
  return (date) => f.format(new Date(`${date}T00:00:00Z`));
}
const shortDate = dateFmt({ day: 'numeric', month: 'short' });
const longDate = dateFmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function buildChartModel(series: HistorySeries, key: string): ChartModel {
  const hide = series.hideAmounts;
  const cur = series.baseCurrency;
  const mode: ChartModel['mode'] = hide ? 'percent' : 'value';
  const base: ChartModel = {
    key,
    mode,
    title: hide ? '30-day P/L %' : `30-day portfolio value (${currencySymbol(cur)} ${cur})`,
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
  base.labels = pts.map((p) => shortDate(p.date));
  base.tooltipTitles = pts.map((p) => longDate(p.date));
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
