import * as assert from 'assert';
import { isRealDate, parseBuyDate, parsePositiveNumber, parseRefreshInterval, validateBuyDate, validateBuyPrice, validateQuantity, validateRefreshInterval } from '../../src/validation';
import { DEFAULT_SETTINGS, parseSettings } from '../../src/settings';
import { formatMoney, formatPercent, formatSignedMoney } from '../../src/format';

describe('input validation', () => {
  it('validates quantity', () => {
    assert.strictEqual(validateQuantity('10'), undefined);
    assert.strictEqual(validateQuantity('0.25'), undefined);
    assert.strictEqual(validateQuantity('1,000'), undefined);
    for (const bad of ['', '0', '-1', 'abc', '1e5', '1.2.3', 'NaN', 'Infinity', '1e13']) assert.ok(validateQuantity(bad), `"${bad}" should be invalid`);
    assert.ok(validateQuantity('10000000000000'));
  });

  it('validates buy price', () => {
    assert.strictEqual(validateBuyPrice('2450.5'), undefined);
    assert.strictEqual(validateBuyPrice('.5'), undefined);
    assert.ok(validateBuyPrice('0'));
    assert.ok(validateBuyPrice('-5'));
    assert.ok(validateBuyPrice('x'));
    assert.strictEqual(parsePositiveNumber(' 12.50 '), 12.5);
  });

  it('validates optional buy dates', () => {
    const today = '2026-10-25';
    assert.strictEqual(validateBuyDate('', today), undefined);
    assert.strictEqual(validateBuyDate('  ', today), undefined);
    assert.strictEqual(validateBuyDate('2026-10-25', today), undefined);
    assert.strictEqual(validateBuyDate('2024-02-29', today), undefined);
    assert.ok(validateBuyDate('2026-10-26', today), 'future');
    assert.ok(validateBuyDate('2025-02-29', today), 'not a real date');
    assert.ok(validateBuyDate('2025-13-01', today));
    assert.ok(validateBuyDate('25-10-2026', today));
    assert.ok(validateBuyDate('2026/10/01', today));
    assert.ok(validateBuyDate('1960-01-01', today));
    assert.strictEqual(isRealDate('2026-04-31'), false);
    assert.strictEqual(parseBuyDate(' 2026-01-02 '), '2026-01-02');
    assert.strictEqual(parseBuyDate(''), undefined);
  });
});

describe('settings parsing', () => {
  it('applies defaults and clamps the refresh interval to >= 15s', () => {
    assert.deepStrictEqual(parseSettings({}), DEFAULT_SETTINGS);
    assert.strictEqual(parseSettings({ refreshIntervalSeconds: 5 }).refreshIntervalSeconds, 15);
    assert.strictEqual(parseSettings({ refreshIntervalSeconds: 120.4 }).refreshIntervalSeconds, 120);
    assert.strictEqual(parseSettings({ refreshIntervalSeconds: 'x' }).refreshIntervalSeconds, 60);
    assert.strictEqual(parseSettings({ refreshIntervalSeconds: NaN }).refreshIntervalSeconds, 60);
  });

  it('accepts only INR/USD and boolean hideAmounts', () => {
    assert.strictEqual(parseSettings({ baseCurrency: 'USD' }).baseCurrency, 'USD');
    assert.strictEqual(parseSettings({ baseCurrency: 'EUR' }).baseCurrency, 'INR');
    assert.strictEqual(parseSettings({ hideAmounts: true }).hideAmounts, true);
    assert.strictEqual(parseSettings({ hideAmounts: 'yes' }).hideAmounts, false);
  });
});

describe('refresh interval validation', () => {
  it('accepts whole seconds from 15 to one day', () => {
    for (const ok of ['15', '60', ' 120 ', '86400']) assert.strictEqual(validateRefreshInterval(ok), undefined, ok);
    assert.strictEqual(parseRefreshInterval(' 120 '), 120);
  });

  it('rejects too small, too large, fractional and non-numeric input', () => {
    for (const bad of ['14', '0', '86401']) assert.ok(validateRefreshInterval(bad), bad);
    for (const bad of ['', 'abc', '1.5', '-30', '30s', '1e3', '0x20']) assert.match(validateRefreshInterval(bad) ?? '', /whole number/, bad);
  });
});

describe('formatting', () => {
  it('formats INR with Indian grouping and USD with US grouping', () => {
    assert.strictEqual(formatMoney(1234567.891, 'INR'), '₹12,34,567.89');
    assert.strictEqual(formatMoney(1234567.891, 'USD'), '$1,234,567.89');
    assert.strictEqual(formatMoney(-1000, 'INR'), '-₹1,000.00');
    assert.strictEqual(formatMoney(-0.001, 'USD'), '$0.00');
    assert.strictEqual(formatSignedMoney(50, 'USD'), '+$50.00');
    assert.strictEqual(formatSignedMoney(-50, 'USD'), '-$50.00');
  });

  it('formats signed percentages', () => {
    assert.strictEqual(formatPercent(2.3412), '+2.34%');
    assert.strictEqual(formatPercent(-0.5), '-0.50%');
    assert.strictEqual(formatPercent(0), '0.00%');
    assert.strictEqual(formatPercent(-0.001), '0.00%');
  });
});
