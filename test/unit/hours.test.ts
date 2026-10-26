import * as assert from 'assert';
import { easternOffsetMs, isMarketOpen, sessionAt } from '../../src/market/hours';

const utc = (s: string): number => Date.parse(s.endsWith('Z') ? s : `${s}Z`);

describe('market hours: India (NSE/BSE, IST = UTC+5:30)', () => {
  it('is open 09:15-15:30 IST on weekdays, with the boundaries exact', () => {
    // Tue 2026-10-27
    assert.strictEqual(isMarketOpen('IN', utc('2026-10-27T03:44:59')), false); // 09:14:59 IST
    assert.strictEqual(isMarketOpen('IN', utc('2026-10-27T03:45:00')), true); // 09:15:00 IST
    assert.strictEqual(isMarketOpen('IN', utc('2026-10-27T09:59:59')), true); // 15:29:59 IST
    assert.strictEqual(isMarketOpen('IN', utc('2026-10-27T10:00:00')), false); // 15:30:00 IST
  });

  it('is closed all weekend', () => {
    for (const d of ['2026-10-24', '2026-10-25']) {
      for (let h = 0; h < 24; h++) assert.strictEqual(isMarketOpen('IN', utc(`${d}T${String(h).padStart(2, '0')}:30:00`)), false);
    }
  });

  it('reports the open session end and the previous close', () => {
    const s = sessionAt('IN', utc('2026-10-27T05:00:00'));
    assert.strictEqual(s.open, true);
    assert.strictEqual(s.closesAt, utc('2026-10-27T10:00:00'));
    assert.strictEqual(s.lastCloseAt, utc('2026-10-26T10:00:00'));
  });

  it('after Friday close the next open is Monday 09:15 IST', () => {
    const s = sessionAt('IN', utc('2026-10-30T12:00:00')); // Fri 17:30 IST
    assert.strictEqual(s.open, false);
    assert.strictEqual(s.lastCloseAt, utc('2026-10-30T10:00:00'));
    assert.strictEqual(s.nextOpenAt, utc('2026-11-02T03:45:00'));
  });

  it('before the open on a weekday the next open is today and the last close was the previous weekday', () => {
    const s = sessionAt('IN', utc('2026-10-27T01:00:00')); // Tue 06:30 IST
    assert.strictEqual(s.nextOpenAt, utc('2026-10-27T03:45:00'));
    assert.strictEqual(s.lastCloseAt, utc('2026-10-26T10:00:00'));
  });

  it('on Monday morning the last close is the previous Friday', () => {
    const s = sessionAt('IN', utc('2026-11-02T01:00:00'));
    assert.strictEqual(s.lastCloseAt, utc('2026-10-30T10:00:00'));
  });
});

describe('market hours: US (NYSE/Nasdaq, 09:30-16:00 US Eastern)', () => {
  it('uses EDT (UTC-4) in summer: opens 13:30 UTC, closes 20:00 UTC', () => {
    assert.strictEqual(isMarketOpen('US', utc('2026-07-14T13:29:59')), false);
    assert.strictEqual(isMarketOpen('US', utc('2026-07-14T13:30:00')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-07-14T19:59:59')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-07-14T20:00:00')), false);
  });

  it('uses EST (UTC-5) in winter: opens 14:30 UTC, closes 21:00 UTC', () => {
    assert.strictEqual(isMarketOpen('US', utc('2026-01-13T14:29:59')), false);
    assert.strictEqual(isMarketOpen('US', utc('2026-01-13T14:30:00')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-01-13T20:59:59')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-01-13T21:00:00')), false);
  });

  it('spring forward (Sun 2026-03-08): Friday is EST, Monday is EDT', () => {
    assert.strictEqual(isMarketOpen('US', utc('2026-03-06T14:30:00')), true); // Fri 09:30 EST
    assert.strictEqual(isMarketOpen('US', utc('2026-03-06T14:29:59')), false);
    assert.strictEqual(isMarketOpen('US', utc('2026-03-09T13:29:59')), false); // Mon 09:29:59 EDT
    assert.strictEqual(isMarketOpen('US', utc('2026-03-09T13:30:00')), true); // Mon 09:30 EDT
    assert.strictEqual(isMarketOpen('US', utc('2026-03-09T19:59:59')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-03-09T20:00:00')), false);
    const s = sessionAt('US', utc('2026-03-07T12:00:00')); // Saturday
    assert.strictEqual(s.lastCloseAt, utc('2026-03-06T21:00:00')); // Fri 16:00 EST
    assert.strictEqual(s.nextOpenAt, utc('2026-03-09T13:30:00')); // Mon 09:30 EDT
  });

  it('fall back (Sun 2026-11-01): Friday is EDT, Monday is EST', () => {
    assert.strictEqual(isMarketOpen('US', utc('2026-10-30T13:30:00')), true); // Fri 09:30 EDT
    assert.strictEqual(isMarketOpen('US', utc('2026-10-30T13:29:59')), false);
    assert.strictEqual(isMarketOpen('US', utc('2026-11-02T14:29:59')), false); // Mon 09:29:59 EST
    assert.strictEqual(isMarketOpen('US', utc('2026-11-02T14:30:00')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-11-02T20:59:59')), true);
    assert.strictEqual(isMarketOpen('US', utc('2026-11-02T21:00:00')), false);
    const s = sessionAt('US', utc('2026-10-31T12:00:00'));
    assert.strictEqual(s.lastCloseAt, utc('2026-10-30T20:00:00')); // Fri 16:00 EDT
    assert.strictEqual(s.nextOpenAt, utc('2026-11-02T14:30:00')); // Mon 09:30 EST
  });

  it('is closed at the weekend', () => {
    assert.strictEqual(isMarketOpen('US', utc('2026-10-31T15:00:00')), false);
    assert.strictEqual(isMarketOpen('US', utc('2026-11-01T15:00:00')), false);
  });

  it('the Eastern offset matches the platform tz database across 2025-2027', () => {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
    for (let t = utc('2025-01-01T00:00:00'); t < utc('2028-01-01T00:00:00'); t += 30 * 60_000) {
      const name = fmt.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')!.value; // GMT-5 / GMT-4
      assert.strictEqual(easternOffsetMs(t), Number(name.replace('GMT', '')) * 3_600_000, new Date(t).toISOString());
    }
  });
});

describe('market hours: FX (Sun 17:00 ET - Fri 17:00 ET) and crypto', () => {
  it('is closed Friday evening through Sunday 17:00 ET', () => {
    assert.strictEqual(isMarketOpen('FX', utc('2026-10-30T20:59:59')), true); // Fri 16:59 EDT
    assert.strictEqual(isMarketOpen('FX', utc('2026-10-30T21:00:00')), false); // Fri 17:00 EDT
    assert.strictEqual(isMarketOpen('FX', utc('2026-10-31T12:00:00')), false);
    assert.strictEqual(isMarketOpen('FX', utc('2026-11-01T21:59:59')), false); // Sun 16:59:59 EST (DST ended that morning)
    assert.strictEqual(isMarketOpen('FX', utc('2026-11-01T22:00:00')), true); // Sun 17:00 EST
  });

  it('reports the next open and last close', () => {
    const s = sessionAt('FX', utc('2026-10-31T12:00:00'));
    assert.strictEqual(s.lastCloseAt, utc('2026-10-30T21:00:00'));
    assert.strictEqual(s.nextOpenAt, utc('2026-11-01T22:00:00'));
    const o = sessionAt('FX', utc('2026-10-28T12:00:00'));
    assert.strictEqual(o.closesAt, utc('2026-10-30T21:00:00'));
  });

  it('crypto is always open', () => {
    assert.strictEqual(isMarketOpen('CRYPTO', utc('2026-10-31T03:00:00')), true);
    assert.strictEqual(sessionAt('CRYPTO', 0).closesAt, undefined);
  });
});
