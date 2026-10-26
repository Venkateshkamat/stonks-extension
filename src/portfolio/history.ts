import { Currency, DailyClose, Holding, IntradayPoint } from '../types';
import { nativeCurrency } from '../symbols';
import { convert, FxRate } from './calc';

export interface HoldingHistory {
  holding: Holding;
  /** Daily closes, ascending by date. Undefined when history could not be loaded. */
  closes: DailyClose[] | undefined;
}

export interface HistoryPoint {
  /** YYYY-MM-DD (the local calendar date for intraday points). */
  date: string;
  /** Epoch ms; set only for intraday (1D) points. */
  time?: number;
  /** Portfolio value in the base currency. */
  value: number;
  /** Cost of the holdings counted on that day, in the base currency. */
  invested: number;
  pnl: number;
  pnlPercent: number;
}

export interface HistoryOptions {
  base: Currency;
  usdInr: FxRate;
  /** Number of calendar days ending at `today` (inclusive). Default 30. */
  days?: number;
  /** YYYY-MM-DD; defaults to the latest date present in the data. */
  today?: string;
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Last close on or before `date` (forward-fill), via binary search over ascending closes. */
function closeOnOrBefore(closes: DailyClose[], date: string): number | undefined {
  let lo = 0;
  let hi = closes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? closes[found].close : undefined;
}

/**
 * Aggregates per-holding daily closes into a portfolio series.
 *
 * - X axis: union of all dates present in any holding's closes within the window.
 * - A holding counts on day D only if it has no buyDate or buyDate <= D, and has a close on or before D
 *   (missing closes - market holidays, crypto weekends - are forward-filled from the last known close).
 * - value = sum(qty * close * fx-to-base); invested = sum(qty * buyPrice * fx-to-base) over the same holdings.
 * - Holdings whose currency cannot be converted (missing FX rate) are skipped.
 */
export function buildHistorySeries(items: readonly HoldingHistory[], opts: HistoryOptions): HistoryPoint[] {
  const days = opts.days ?? 30;
  const allDates = new Set<string>();
  for (const it of items) for (const c of it.closes ?? []) allDates.add(c.date);
  if (allDates.size === 0) return [];

  const sorted = [...allDates].sort();
  const today = opts.today ?? sorted[sorted.length - 1];
  const start = addDays(today, -(days - 1));
  const dates = sorted.filter((d) => d >= start && d <= today);

  const usable = items
    .filter((it) => it.closes && it.closes.length > 0)
    .map((it) => ({
      holding: it.holding,
      closes: it.closes as DailyClose[],
      fx: convert(1, nativeCurrency(it.holding.market), opts.base, opts.usdInr),
    }))
    .filter((it) => it.fx !== undefined) as Array<{ holding: Holding; closes: DailyClose[]; fx: number }>;

  const points: HistoryPoint[] = [];
  for (const date of dates) {
    let value = 0;
    let invested = 0;
    let any = false;
    for (const u of usable) {
      if (u.holding.buyDate && u.holding.buyDate > date) continue;
      const close = closeOnOrBefore(u.closes, date);
      if (close === undefined) continue;
      value += u.holding.quantity * close * u.fx;
      invested += u.holding.quantity * u.holding.buyPrice * u.fx;
      any = true;
    }
    if (!any) continue;
    const pnl = value - invested;
    points.push({ date, value, invested, pnl, pnlPercent: invested > 0 ? (pnl / invested) * 100 : 0 });
  }
  return points;
}

// ---------------------------------------------------------------------------------------------
// Intraday (1D) aggregation
// ---------------------------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface HoldingIntraday {
  holding: Holding;
  /** 15-minute closes, ascending by time. Undefined when they could not be loaded. */
  points: IntradayPoint[] | undefined;
}

export interface IntradayOptions {
  base: Currency;
  /** Fallback USD -> INR rate, used when no intraday FX series is available. */
  usdInr: FxRate;
  /** Intraday USDINR series; each chart point converts with the last rate at or before it. */
  fxSeries?: IntradayPoint[];
  /** Epoch ms of "now". */
  now: number;
  /** Window length. Default 24h. */
  windowMs?: number;
  /** Calendar date (YYYY-MM-DD) of an instant, used for buyDate comparisons. Default: the host's local date. */
  dateOf?: (ms: number) => string;
}

/** Local (host timezone) YYYY-MM-DD of an epoch-ms instant. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Index of the last point with t <= time (binary search), or -1. */
function lastIndexAtOrBefore(points: readonly IntradayPoint[], time: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Aggregates per-holding 15-minute closes into the 1D portfolio series.
 *
 * - Window: the 24h ending at min(now, newest bar of any holding) - so on a weekend, with only closed markets in
 *   the portfolio, the chart shows the last 24h of data rather than nothing.
 * - X axis: the union of all bar times inside the window.
 * - Forward-fill: a holding's value at time T is its last close at or before T. A holding with no bar inside the
 *   window yet (or before its first in-window bar) is back-filled from its last close BEFORE the window - that
 *   is why 5 days are fetched. A holding with no close at or before T at all is left out of that point.
 * - A holding is left out of points earlier than its buyDate (compared as calendar dates via `dateOf`).
 * - Cross-currency holdings convert with the intraday USDINR rate at T (last at or before T, else the first
 *   known rate, else the scalar fallback `usdInr`); without any rate they are skipped.
 */
export function buildIntradaySeries(items: readonly HoldingIntraday[], opts: IntradayOptions): HistoryPoint[] {
  const usable = items.filter((it): it is { holding: Holding; points: IntradayPoint[] } => !!it.points && it.points.length > 0);
  if (usable.length === 0) return [];

  const dateOf = opts.dateOf ?? localDate;
  const newest = Math.max(...usable.map((u) => u.points[u.points.length - 1].t));
  const anchor = Math.min(opts.now, newest);
  const start = anchor - (opts.windowMs ?? DAY_MS);

  const times = new Set<number>();
  for (const u of usable) for (const p of u.points) if (p.t >= start && p.t <= anchor) times.add(p.t);
  const sorted = [...times].sort((a, b) => a - b);

  const fx = opts.fxSeries && opts.fxSeries.length > 0 ? opts.fxSeries : undefined;
  const rateAt = (t: number): number | undefined => {
    if (fx) {
      const i = lastIndexAtOrBefore(fx, t);
      return fx[i >= 0 ? i : 0].close; // before the first known rate: back-fill with it
    }
    return opts.usdInr;
  };

  const out: HistoryPoint[] = [];
  for (const t of sorted) {
    const date = dateOf(t);
    const rate = rateAt(t);
    let value = 0;
    let invested = 0;
    let any = false;
    for (const u of usable) {
      const h = u.holding;
      if (h.buyDate && h.buyDate > date) continue;
      const i = lastIndexAtOrBefore(u.points, t);
      if (i < 0) continue;
      const k = convert(1, nativeCurrency(h.market), opts.base, rate);
      if (k === undefined) continue;
      value += h.quantity * u.points[i].close * k;
      invested += h.quantity * h.buyPrice * k;
      any = true;
    }
    if (!any) continue;
    const pnl = value - invested;
    out.push({ date, time: t, value, invested, pnl, pnlPercent: invested > 0 ? (pnl / invested) * 100 : 0 });
  }
  return out;
}
