import { Currency } from './types';

const SYMBOL: Record<Currency, string> = { INR: '₹', USD: '$' };
const LOCALE: Record<Currency, string> = { INR: 'en-IN', USD: 'en-US' };

const formatters = new Map<string, Intl.NumberFormat>();

/** Intl.NumberFormat instances are expensive to build and a refresh formats dozens of numbers: build each variant once. */
function numberFormat(locale: string, minimumFractionDigits: number, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${locale}|${minimumFractionDigits}|${maximumFractionDigits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits });
    formatters.set(key, f);
  }
  return f;
}

export function currencySymbol(c: Currency): string {
  return SYMBOL[c];
}

/** 1234567.891 INR -> ₹12,34,567.89 ; negative -> -₹1,000.00 */
export function formatMoney(amount: number, currency: Currency): string {
  const abs = numberFormat(LOCALE[currency], 2, 2).format(Math.abs(amount));
  const sign = amount < 0 && Number(abs.replace(/,/g, '')) !== 0 ? '-' : '';
  return `${sign}${SYMBOL[currency]}${abs}`;
}

/** Always-signed money: +₹1,000.00 / -₹1,000.00 */
export function formatSignedMoney(amount: number, currency: Currency): string {
  const s = formatMoney(amount, currency);
  return s.startsWith('-') ? s : `+${s}`;
}

/** Signed percent with 2 decimals: +2.34% / -0.50% / 0.00% */
export function formatPercent(p: number): string {
  const r = Math.round(p * 100) / 100;
  if (r === 0) return '0.00%';
  return `${r > 0 ? '+' : '-'}${Math.abs(r).toFixed(2)}%`;
}

export function currencyLocale(c: Currency): string {
  return LOCALE[c];
}

/** Plain grouped number with a fixed number of decimals (no currency symbol): 24,350.50 */
export function formatNumber(n: number, locale = 'en-US', decimals = 2): string {
  const abs = numberFormat(locale, decimals, decimals).format(Math.abs(n));
  const sign = n < 0 && Number(abs.replace(/,/g, '')) !== 0 ? '-' : '';
  return `${sign}${abs}`;
}

/** Always-signed plain number: +123.45 / -123.45 / 0.00 */
export function formatSignedNumber(n: number, locale = 'en-US', decimals = 2): string {
  const s = formatNumber(n, locale, decimals);
  if (s.startsWith('-')) return s;
  return Number(s.replace(/,/g, '')) === 0 ? s : `+${s}`;
}

/** Per-unit price: 2 decimals, but up to 6 for sub-1 values so tiny crypto prices stay readable. */
export function formatPrice(amount: number, currency: Currency): string {
  if (Math.abs(amount) >= 1 || amount === 0) return formatMoney(amount, currency);
  const abs = numberFormat(LOCALE[currency], 2, 6).format(Math.abs(amount));
  return `${amount < 0 ? '-' : ''}${SYMBOL[currency]}${abs}`;
}

/** Share / unit quantity: grouped, up to 8 decimals, no trailing zeros. */
export function formatQuantity(q: number, currency: Currency): string {
  return numberFormat(LOCALE[currency], 0, 8).format(q);
}
