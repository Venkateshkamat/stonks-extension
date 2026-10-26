/**
 * Regular trading hours for the markets the extension refreshes, in exchange-local time. Pure and dependency-free:
 * the US Eastern DST rules (2nd Sunday of March 02:00 -> 1st Sunday of November 02:00, in force since 2007) and the
 * fixed IST offset are computed by hand, so behaviour does not depend on the host's ICU/timezone data.
 *
 * Holidays are not modelled: on a holiday the market is treated as open and quotes are simply fetched as usual.
 */

/** What a quote's refresh schedule follows. */
export type MarketClock = 'IN' | 'US' | 'FX' | 'CRYPTO';

export const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

export interface Session {
  open: boolean;
  /** When the current session ends (only while open). */
  closesAt?: number;
  /** The most recent close at or before `t` (the previous session's close while open). Undefined for 24/7 markets. */
  lastCloseAt?: number;
  /** The next open strictly after `t` (only while closed). */
  nextOpenAt?: number;
}

/** How long after the close the final quote is fetched, so the settled closing price is captured. */
export const SETTLE_MS: Record<MarketClock, number> = { IN: 15 * MS_MIN, US: 5 * MS_MIN, FX: 5 * MS_MIN, CRYPTO: 0 };

/** Day of month of the nth (1-based) Sunday of a month (month is 0-based). */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/** UTC offset of America/New_York at `t`, in ms (-5h standard, -4h daylight saving). */
export function easternOffsetMs(t: number): number {
  const year = new Date(t).getUTCFullYear();
  // DST starts at 02:00 EST (07:00 UTC) and ends at 02:00 EDT (06:00 UTC).
  const start = Date.UTC(year, 2, nthSunday(year, 2, 2), 7);
  const end = Date.UTC(year, 10, nthSunday(year, 10, 1), 6);
  return (t >= start && t < end ? -4 : -5) * 3_600_000;
}

const IST_OFFSET_MS = 330 * MS_MIN;
const istOffset = (): number => IST_OFFSET_MS;

interface Local {
  /** Days since 1970-01-01 in the exchange's calendar. */
  day: number;
  /** Minutes since local midnight. */
  minute: number;
  /** 0 = Sunday .. 6 = Saturday */
  dow: number;
}

function localOf(t: number, offset: (t: number) => number): Local {
  const local = t + offset(t);
  const day = Math.floor(local / MS_DAY);
  return { day, minute: Math.floor((local - day * MS_DAY) / MS_MIN), dow: (((day + 4) % 7) + 7) % 7 };
}

/** Epoch ms of local wall-clock `minute` on local day `day`. */
function epochOf(day: number, minute: number, offset: (t: number) => number): number {
  const local = day * MS_DAY + minute * MS_MIN;
  // Local time read as UTC is within a day of the real instant, which is enough to pick the right DST offset
  // (sessions never sit within hours of a 02:00 changeover).
  return local - offset(local - offset(local));
}

const isWeekday = (dow: number): boolean => dow >= 1 && dow <= 5;

interface DailyHours {
  offset: (t: number) => number;
  openMinute: number;
  closeMinute: number;
}

const HOURS: Record<'IN' | 'US', DailyHours> = {
  IN: { offset: istOffset, openMinute: 9 * 60 + 15, closeMinute: 15 * 60 + 30 }, // NSE / BSE 09:15-15:30 IST
  US: { offset: easternOffsetMs, openMinute: 9 * 60 + 30, closeMinute: 16 * 60 }, // NYSE / Nasdaq 09:30-16:00 ET
};

/** Previous weekday strictly before `day`. */
function prevWeekday(day: number): number {
  let d = day - 1;
  while (!isWeekday((((d + 4) % 7) + 7) % 7)) d--;
  return d;
}

/** Next weekday strictly after `day`. */
function nextWeekday(day: number): number {
  let d = day + 1;
  while (!isWeekday((((d + 4) % 7) + 7) % 7)) d++;
  return d;
}

function dailySession(h: DailyHours, t: number): Session {
  const { day, minute, dow } = localOf(t, h.offset);
  const weekday = isWeekday(dow);
  const closeOf = (d: number) => epochOf(d, h.closeMinute, h.offset);
  const openOf = (d: number) => epochOf(d, h.openMinute, h.offset);
  if (weekday && minute >= h.openMinute && minute < h.closeMinute) {
    return { open: true, closesAt: closeOf(day), lastCloseAt: closeOf(prevWeekday(day)) };
  }
  return {
    open: false,
    lastCloseAt: weekday && minute >= h.closeMinute ? closeOf(day) : closeOf(prevWeekday(day)),
    nextOpenAt: weekday && minute < h.openMinute ? openOf(day) : openOf(nextWeekday(day)),
  };
}

/** Spot FX trades continuously from Sunday 17:00 ET to Friday 17:00 ET. */
function fxSession(t: number): Session {
  const { day, minute, dow } = localOf(t, easternOffsetMs);
  const weekStart = day - dow; // Sunday
  const at = (week: number, d: number) => epochOf(week + d, 17 * 60, easternOffsetMs);
  const minuteOfWeek = dow * 1440 + minute;
  const openFrom = 17 * 60; // Sunday 17:00
  const openUntil = 5 * 1440 + 17 * 60; // Friday 17:00
  if (minuteOfWeek >= openFrom && minuteOfWeek < openUntil) {
    return { open: true, closesAt: at(weekStart, 5), lastCloseAt: at(weekStart - 7, 5) };
  }
  if (minuteOfWeek >= openUntil) return { open: false, lastCloseAt: at(weekStart, 5), nextOpenAt: at(weekStart + 7, 0) };
  return { open: false, lastCloseAt: at(weekStart - 7, 5), nextOpenAt: at(weekStart, 0) };
}

/** Trading session state of a market clock at epoch-ms `t`. Crypto is always open. */
export function sessionAt(clock: MarketClock, t: number): Session {
  switch (clock) {
    case 'CRYPTO':
      return { open: true };
    case 'FX':
      return fxSession(t);
    default:
      return dailySession(HOURS[clock], t);
  }
}

export function isMarketOpen(clock: MarketClock, t: number): boolean {
  return sessionAt(clock, t).open;
}
