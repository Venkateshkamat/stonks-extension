import * as assert from 'assert';
import { finnhubSupports, finnhubSymbol, nativeCurrency, normalizeSymbol, validateSymbol, yahooSymbol } from '../../src/symbols';

describe('symbol mapping', () => {
  it('maps to Yahoo symbols per market', () => {
    assert.strictEqual(yahooSymbol('reliance', 'NSE'), 'RELIANCE.NS');
    assert.strictEqual(yahooSymbol('RELIANCE', 'BSE'), 'RELIANCE.BO');
    assert.strictEqual(yahooSymbol('AAPL', 'US'), 'AAPL');
    assert.strictEqual(yahooSymbol('BRK.B', 'US'), 'BRK-B');
    assert.strictEqual(yahooSymbol('BTC', 'CRYPTO'), 'BTC-USD');
  });

  it('maps to Finnhub symbols, undefined for Indian markets', () => {
    assert.strictEqual(finnhubSymbol('aapl', 'US'), 'AAPL');
    assert.strictEqual(finnhubSymbol('BTC', 'CRYPTO'), 'BINANCE:BTCUSDT');
    assert.strictEqual(finnhubSymbol('RELIANCE', 'NSE'), undefined);
    assert.strictEqual(finnhubSymbol('RELIANCE', 'BSE'), undefined);
    assert.strictEqual(finnhubSupports('NSE'), false);
    assert.strictEqual(finnhubSupports('US'), true);
    assert.strictEqual(finnhubSupports('CRYPTO'), true);
  });

  it('normalizes suffixes the user may type', () => {
    assert.strictEqual(normalizeSymbol(' reliance.ns ', 'NSE'), 'RELIANCE');
    assert.strictEqual(normalizeSymbol('RELIANCE.BO', 'BSE'), 'RELIANCE');
    assert.strictEqual(normalizeSymbol('btc-usd', 'CRYPTO'), 'BTC');
    assert.strictEqual(yahooSymbol('M&M', 'NSE'), 'M&M.NS');
  });

  it('derives native currency', () => {
    assert.strictEqual(nativeCurrency('NSE'), 'INR');
    assert.strictEqual(nativeCurrency('BSE'), 'INR');
    assert.strictEqual(nativeCurrency('US'), 'USD');
    assert.strictEqual(nativeCurrency('CRYPTO'), 'USD');
  });

  it('validates symbols', () => {
    assert.strictEqual(validateSymbol('AAPL', 'US'), undefined);
    assert.strictEqual(validateSymbol('BAJAJ-AUTO', 'NSE'), undefined);
    assert.strictEqual(validateSymbol('M&M', 'NSE'), undefined);
    assert.ok(validateSymbol('   ', 'US'));
    assert.ok(validateSymbol('A B', 'US'));
    assert.ok(validateSymbol('^NSEI', 'US'));
    assert.ok(validateSymbol('A'.repeat(30), 'US'));
  });
});
