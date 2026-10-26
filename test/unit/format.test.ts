import * as assert from 'assert';
import { formatNumber, formatPrice, formatQuantity, formatSignedNumber } from '../../src/format';

describe('number formatting helpers', () => {
  it('formatNumber groups per locale and never shows negative zero', () => {
    assert.strictEqual(formatNumber(1234567.891, 'en-IN'), '12,34,567.89');
    assert.strictEqual(formatNumber(1234567.891, 'en-US'), '1,234,567.89');
    assert.strictEqual(formatNumber(-0.001), '0.00');
  });

  it('formatSignedNumber always carries a sign except for zero', () => {
    assert.strictEqual(formatSignedNumber(150.5), '+150.50');
    assert.strictEqual(formatSignedNumber(-19.75), '-19.75');
    assert.strictEqual(formatSignedNumber(0), '0.00');
    assert.strictEqual(formatSignedNumber(0.001), '0.00');
  });

  it('formatPrice keeps 2 decimals for normal prices and more for tiny ones', () => {
    assert.strictEqual(formatPrice(1190, 'INR'), '₹1,190.00');
    assert.strictEqual(formatPrice(0.0832, 'USD'), '$0.0832');
    assert.strictEqual(formatPrice(0.00001234, 'USD'), '$0.000012');
    assert.strictEqual(formatPrice(0, 'USD'), '$0.00');
  });

  it('formatQuantity trims trailing zeros and groups', () => {
    assert.strictEqual(formatQuantity(10, 'INR'), '10');
    assert.strictEqual(formatQuantity(2.5, 'USD'), '2.5');
    assert.strictEqual(formatQuantity(0.12345678, 'USD'), '0.12345678');
    assert.strictEqual(formatQuantity(1234567, 'INR'), '12,34,567');
  });
});
