import { IndexDef, Market } from '../types';
import { MarketClock, MS_MIN, SETTLE_MS, sessionAt } from './hours';

/** Spot FX is refreshed at most this often. */
export const FX_MIN_INTERVAL_MS = 15 * MS_MIN;
/** Refresh slow-down factor while the editor window is not focused. */
export const UNFOCUSED_FACTOR = 5;
/** Longest a wake-up timer sleeps; it re-evaluates against the wall clock afterwards (guards against sleep / clock changes). */
export const MAX_SLEEP_MS = 30 * MS_MIN;

export function clockForMarket(m: Market): MarketClock {
  return m === 'NSE' || m === 'BSE' ? 'IN' : m === 'US' ? 'US' : 'CRYPTO';
}

/** Indices follow their exchange, coins are 24/7. */
export function clockForIndex(def: IndexDef): MarketClock {
  return def.region === 'India' ? 'IN' : def.region === 'US' ? 'US' : 'CRYPTO';
}

/** Interval between refreshes of a quote: the user's setting (x5 while unfocused), never below 15 minutes for FX. */
export function refreshIntervalMs(clock: MarketClock, baseSeconds: number, focused: boolean): number {
  const base = baseSeconds * 1000;
  return (clock === 'FX' ? Math.max(base, FX_MIN_INTERVAL_MS) : base) * (focused ? 1 : UNFOCUSED_FACTOR);
}

/**
 * When a quote that was last fetched at `fetchedAt` should be fetched again (a time at or before `now` means due now).
 *
 *  - Open (or 24/7) market: `intervalMs` after the last fetch, except that if that would land after the close the
 *    fetch happens once just after the close instead, so the final close is captured.
 *  - Closed market: nothing until the next open, unless the last fetch predates the most recent close (plus the
 *    settle delay) - then exactly one fetch for the final close.
 *  - Never fetched: now.
 */
export function nextDueAt(clock: MarketClock, fetchedAt: number | undefined, now: number, intervalMs: number): number {
  if (fetchedAt === undefined) return now;
  const s = sessionAt(clock, now);
  const settle = SETTLE_MS[clock];
  if (s.open) {
    const due = fetchedAt + intervalMs;
    return s.closesAt !== undefined && due >= s.closesAt ? s.closesAt + settle : due;
  }
  const closeFetchAt = (s.lastCloseAt ?? 0) + settle;
  if (fetchedAt < closeFetchAt) return Math.max(now, closeFetchAt);
  return s.nextOpenAt ?? now + intervalMs;
}

export function isStale(clock: MarketClock, fetchedAt: number | undefined, now: number, intervalMs: number): boolean {
  return nextDueAt(clock, fetchedAt, now, intervalMs) <= now;
}
