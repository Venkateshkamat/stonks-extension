import { Currency } from './types';

const SYMBOL: Record<Currency, string> = { INR: '₹', USD: '$' };
const LOCALE: Record<Currency, string> = { INR: 'en-IN', USD: 'en-US' };

export function currencySymbol(c: Currency): string {
  return SYMBOL[c];
}

/** 1234567.891 INR -> ₹12,34,567.89 ; negative -> -₹1,000.00 */
export function formatMoney(amount: number, currency: Currency): string {
  const abs = new Intl.NumberFormat(LOCALE[currency], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
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
