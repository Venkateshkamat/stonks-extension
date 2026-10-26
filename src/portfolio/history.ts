import { Currency, DailyClose, Holding } from '../types';
import { nativeCurrency } from '../symbols';
import { convert, FxRate } from './calc';

export interface HoldingHistory {
  holding: Holding;
  /** Daily closes, ascending by date. Undefined when history could not be loaded. */
  closes: DailyClose[] | undefined;
}

export interface HistoryPoint {
  /** YYYY-MM-DD */
  date: string;
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
