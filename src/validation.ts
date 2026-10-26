/** Input validators for the add/edit holding flows. Each returns an error message or undefined when valid. */

export function parsePositiveNumber(input: string): number | undefined {
  const s = input.trim().replace(/,/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function validateQuantity(input: string): string | undefined {
  const n = parsePositiveNumber(input);
  if (n === undefined) return 'Enter a positive number (decimals allowed, e.g. 0.5 for crypto)';
  if (n > 1e12) return 'Quantity is too large';
  return undefined;
}

export function validateBuyPrice(input: string): string | undefined {
  const n = parsePositiveNumber(input);
  if (n === undefined) return 'Enter a positive price';
  if (n > 1e12) return 'Price is too large';
  return undefined;
}

export function parseQuantity(input: string): number {
  return parsePositiveNumber(input) as number;
}

export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Buy date is optional: empty is valid. `today` (YYYY-MM-DD) is injectable for tests. */
export function validateBuyDate(input: string, today: string = new Date().toISOString().slice(0, 10)): string | undefined {
  const s = input.trim();
  if (s === '') return undefined;
  if (!isRealDate(s)) return 'Use the format YYYY-MM-DD (a real calendar date), or leave empty';
  if (s > today) return 'Buy date cannot be in the future';
  if (s < '1970-01-01') return 'Buy date is too far in the past';
  return undefined;
}

/** Returns the normalized buy date, or undefined for empty input. */
export function parseBuyDate(input: string): string | undefined {
  const s = input.trim();
  return s === '' ? undefined : s;
}
