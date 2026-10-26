import { Currency, Holding, Quote } from '../types';
import { nativeCurrency } from '../symbols';

/** USD -> INR rate; required only when converting between currencies. */
export type FxRate = number | undefined;

/** Converts an amount between currencies using the USD->INR rate. Returns undefined if the rate is needed but missing. */
export function convert(amount: number, from: Currency, to: Currency, usdInr: FxRate): number | undefined {
  if (from === to) return amount;
  if (usdInr === undefined || !(usdInr > 0)) return undefined;
  return from === 'USD' ? amount * usdInr : amount / usdInr;
}

/** Per-holding figures, all in the holding's native currency. */
export interface HoldingPnL {
  currency: Currency;
  ltp: number;
  prevClose: number;
  invested: number;
  current: number;
  pnl: number;
  pnlPercent: number;
  /** Today's change for the whole position. */
  dayChange: number;
  dayChangePercent: number;
}

export function computeHoldingPnL(holding: Holding, quote: Quote): HoldingPnL {
  const invested = holding.quantity * holding.buyPrice;
  const current = holding.quantity * quote.price;
  const pnl = current - invested;
  return {
    currency: nativeCurrency(holding.market),
    ltp: quote.price,
    prevClose: quote.prevClose,
    invested,
    current,
    pnl,
    pnlPercent: invested > 0 ? (pnl / invested) * 100 : 0,
    dayChange: holding.quantity * quote.change,
    dayChangePercent: quote.changePercent,
  };
}

/** Portfolio totals in the base currency. */
export interface PortfolioTotals {
  currency: Currency;
  invested: number;
  current: number;
  pnl: number;
  pnlPercent: number;
  dayChange: number;
  /** Today's change as a percentage of yesterday's value (current - dayChange). */
  dayChangePercent: number;
  /** Holdings included in the totals. */
  counted: number;
  /** Holdings left out (no quote, or missing FX rate). */
  skipped: number;
}

/**
 * Sums holdings in the base currency. Both cost and value are converted at the *current* rate, so the
 * resulting percentage reflects asset performance only. Holdings without a quote, or needing a missing
 * FX rate, are excluded (and counted in `skipped`) so cost and value always cover the same set.
 */
export function computeTotals(
  rows: ReadonlyArray<{ pnl?: HoldingPnL }>,
  base: Currency,
  usdInr: FxRate,
): PortfolioTotals {
  let invested = 0;
  let current = 0;
  let dayChange = 0;
  let counted = 0;
  let skipped = 0;
  for (const r of rows) {
    const p = r.pnl;
    if (!p) {
      skipped++;
      continue;
    }
    const i = convert(p.invested, p.currency, base, usdInr);
    const c = convert(p.current, p.currency, base, usdInr);
    const d = convert(p.dayChange, p.currency, base, usdInr);
    if (i === undefined || c === undefined || d === undefined) {
      skipped++;
      continue;
    }
    invested += i;
    current += c;
    dayChange += d;
    counted++;
  }
  const pnl = current - invested;
  const prevValue = current - dayChange;
  return {
    currency: base,
    invested,
    current,
    pnl,
    pnlPercent: invested > 0 ? (pnl / invested) * 100 : 0,
    dayChange,
    dayChangePercent: prevValue > 0 ? (dayChange / prevValue) * 100 : 0,
    counted,
    skipped,
  };
}
