export type Market = 'NSE' | 'BSE' | 'US' | 'CRYPTO';
export type Currency = 'INR' | 'USD';
export type ProviderId = 'finnhub' | 'yahoo';

export const MARKETS: readonly Market[] = ['NSE', 'BSE', 'US', 'CRYPTO'];

export interface Holding {
  id: string;
  /** Bare symbol as typed by the user: RELIANCE, AAPL, BTC. */
  symbol: string;
  market: Market;
  quantity: number;
  /** Per-unit purchase price in the holding's native currency. */
  buyPrice: number;
  /** YYYY-MM-DD */
  buyDate?: string;
}

export interface Quote {
  /** Bare symbol / provider symbol the quote was requested for. */
  symbol: string;
  price: number;
  /** Previous day close (24h-ago price for crypto). */
  prevClose: number;
  change: number;
  changePercent: number;
  currency: Currency;
  source: ProviderId;
  /** Quote time, epoch milliseconds. */
  time: number;
}

export interface DailyClose {
  /** YYYY-MM-DD in the exchange's local time. */
  date: string;
  close: number;
}

/** One intraday bar close. */
export interface IntradayPoint {
  /** Bar start time, epoch milliseconds. */
  t: number;
  close: number;
}

/** Chart ranges offered by the panel. */
export type ChartRange = '1D' | '15D' | '30D';
export const CHART_RANGES: readonly ChartRange[] = ['1D', '15D', '30D'];
export const DEFAULT_CHART_RANGE: ChartRange = '30D';

export function isChartRange(v: unknown): v is ChartRange {
  return typeof v === 'string' && (CHART_RANGES as readonly string[]).includes(v);
}

export interface SymbolRef {
  symbol: string;
  market: Market;
}

export interface IndexDef {
  /** Yahoo symbol, e.g. ^NSEI */
  symbol: string;
  name: string;
  region: 'India' | 'US';
}

export const INDICES: readonly IndexDef[] = [
  { symbol: '^NSEI', name: 'NIFTY 50', region: 'India' },
  { symbol: '^BSESN', name: 'SENSEX', region: 'India' },
  { symbol: '^NSEBANK', name: 'NIFTY BANK', region: 'India' },
  { symbol: '^GSPC', name: 'S&P 500', region: 'US' },
  { symbol: '^DJI', name: 'Dow Jones', region: 'US' },
  { symbol: '^IXIC', name: 'Nasdaq Composite', region: 'US' },
];

export const FX_SYMBOL = 'USDINR=X';
