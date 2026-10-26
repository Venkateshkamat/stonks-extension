import { Currency, Market } from './types';

export function nativeCurrency(market: Market): Currency {
  return market === 'NSE' || market === 'BSE' ? 'INR' : 'USD';
}

/**
 * Normalizes user input to a bare uppercase symbol, stripping exchange
 * suffixes the user may have typed (RELIANCE.NS, BTC-USD, ...).
 */
export function normalizeSymbol(input: string, market: Market): string {
  let s = input.trim().toUpperCase();
  if (market === 'NSE') s = s.replace(/\.NS$/, '');
  else if (market === 'BSE') s = s.replace(/\.BO$/, '');
  else if (market === 'CRYPTO') s = s.replace(/-USD$/, '');
  return s;
}

/** Returns an error message, or undefined when the (normalized) symbol looks valid. */
export function validateSymbol(input: string, market: Market): string | undefined {
  const s = normalizeSymbol(input, market);
  if (!s) return 'Enter a symbol';
  if (s.length > 20) return 'Symbol is too long';
  if (!/^[A-Z0-9][A-Z0-9.&_-]*$/.test(s)) return 'Symbol may only contain letters, digits and . & _ -';
  return undefined;
}

export function yahooSymbol(symbol: string, market: Market): string {
  const s = normalizeSymbol(symbol, market);
  switch (market) {
    case 'NSE':
      return `${s}.NS`;
    case 'BSE':
      return `${s}.BO`;
    case 'CRYPTO':
      return `${s}-USD`;
    case 'US':
      // Yahoo uses '-' for share classes (BRK.B -> BRK-B).
      return s.replace(/\./g, '-');
  }
}

/** Finnhub free tier only covers US stocks and crypto. */
export function finnhubSupports(market: Market): boolean {
  return market === 'US' || market === 'CRYPTO';
}

export function finnhubSymbol(symbol: string, market: Market): string | undefined {
  const s = normalizeSymbol(symbol, market);
  switch (market) {
    case 'US':
      return s;
    case 'CRYPTO':
      return `BINANCE:${s}USDT`;
    default:
      return undefined;
  }
}

/** Portfolio subsets that are shown / totalled separately: stocks (NSE, BSE, US) and crypto. */
export type PortfolioGroup = 'stocks' | 'crypto';
export const PORTFOLIO_GROUPS: readonly PortfolioGroup[] = ['stocks', 'crypto'];

export function marketGroup(market: Market): PortfolioGroup {
  return market === 'CRYPTO' ? 'crypto' : 'stocks';
}
