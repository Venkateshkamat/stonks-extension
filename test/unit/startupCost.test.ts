import * as assert from 'assert';

/**
 * Building an Intl formatter costs milliseconds, so none may be built while modules load (that is extension
 * startup time) - they are created on first use and then reused.
 */
describe('startup cost', () => {
  function countIntlConstructions<T>(body: () => T): { result: T; dateTime: number; number: number } {
    const counts = { dateTime: 0, number: 0 };
    const origDate = Intl.DateTimeFormat;
    const origNumber = Intl.NumberFormat;
    Intl.DateTimeFormat = new Proxy(origDate, { construct: (t, args) => (counts.dateTime++, new t(...(args as []))) });
    Intl.NumberFormat = new Proxy(origNumber, { construct: (t, args) => (counts.number++, new t(...(args as []))) });
    try {
      return { result: body(), ...counts };
    } finally {
      Intl.DateTimeFormat = origDate;
      Intl.NumberFormat = origNumber;
    }
  }

  it('loading the chart model and formatting modules builds no Intl formatters', () => {
    for (const m of ['../../src/panel/chartModel', '../../src/format', '../../src/statusBarModel', '../../src/panel/model']) {
      delete require.cache[require.resolve(m)];
    }
    const { dateTime, number } = countIntlConstructions(() => {
      require('../../src/format');
      require('../../src/statusBarModel');
      require('../../src/panel/model');
      require('../../src/panel/chartModel');
    });
    assert.strictEqual(dateTime, 0);
    assert.strictEqual(number, 0);
  });

  it('number formatters are built once per variant, however many numbers are formatted', () => {
    const { formatMoney, formatPrice, formatNumber } = require('../../src/format') as typeof import('../../src/format');
    formatMoney(1, 'INR'); // warm the variants used below
    formatMoney(1, 'USD');
    formatNumber(1, 'en-US');
    formatPrice(0.5, 'USD');
    const { number } = countIntlConstructions(() => {
      for (let i = 0; i < 100; i++) {
        formatMoney(i * 1.5, 'INR');
        formatMoney(-i, 'USD');
        formatNumber(i, 'en-US');
        formatPrice(i / 1000, 'USD');
      }
    });
    assert.strictEqual(number, 0);
  });
});
