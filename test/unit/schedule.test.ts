import * as assert from 'assert';
import { MS_MIN } from '../../src/market/hours';
import { clockForIndex, clockForMarket, FX_MIN_INTERVAL_MS, isStale, nextDueAt, refreshIntervalMs, UNFOCUSED_FACTOR } from '../../src/market/schedule';
import { COINS, INDICES } from '../../src/types';

const utc = (s: string): number => Date.parse(`${s}Z`);
const MIN = MS_MIN;

describe('refresh intervals', () => {
  it('uses the configured interval, five times longer while unfocused', () => {
    assert.strictEqual(refreshIntervalMs('IN', 60, true), 60_000);
    assert.strictEqual(refreshIntervalMs('US', 60, false), 60_000 * UNFOCUSED_FACTOR);
    assert.strictEqual(refreshIntervalMs('CRYPTO', 15, false), 75_000);
  });

  it('never refreshes FX more often than every 15 minutes', () => {
    assert.strictEqual(refreshIntervalMs('FX', 15, true), FX_MIN_INTERVAL_MS);
    assert.strictEqual(refreshIntervalMs('FX', 60, true), FX_MIN_INTERVAL_MS);
    assert.strictEqual(refreshIntervalMs('FX', 60, false), FX_MIN_INTERVAL_MS * UNFOCUSED_FACTOR);
    assert.strictEqual(refreshIntervalMs('FX', 3600, true), 3_600_000, 'a longer user interval still wins');
  });
});

describe('market clocks', () => {
  it('maps markets, indices and coins to the clock they follow', () => {
    assert.strictEqual(clockForMarket('NSE'), 'IN');
    assert.strictEqual(clockForMarket('BSE'), 'IN');
    assert.strictEqual(clockForMarket('US'), 'US');
    assert.strictEqual(clockForMarket('CRYPTO'), 'CRYPTO');
    for (const i of INDICES) assert.strictEqual(clockForIndex(i), i.region === 'India' ? 'IN' : 'US', i.name);
    for (const c of COINS) assert.strictEqual(clockForIndex(c), 'CRYPTO', c.name);
  });
});

describe('nextDueAt', () => {
  const interval = 60_000;

  it('is now for a quote that was never fetched, whatever the market state', () => {
    const sat = utc('2026-10-24T12:00:00');
    assert.strictEqual(nextDueAt('IN', undefined, sat, interval), sat);
    assert.strictEqual(nextDueAt('US', undefined, sat, interval), sat);
  });

  it('crypto is due one interval after the last fetch, day and night', () => {
    const t = utc('2026-10-24T03:00:00'); // Saturday
    assert.strictEqual(nextDueAt('CRYPTO', t - 10_000, t, interval), t + 50_000);
    assert.strictEqual(nextDueAt('CRYPTO', t - 90_000, t, interval), t - 30_000);
    assert.strictEqual(isStale('CRYPTO', t - 90_000, t, interval), true);
    assert.strictEqual(isStale('CRYPTO', t - 10_000, t, interval), false);
  });

  it('an open market is due one interval after the last fetch', () => {
    const now = utc('2026-10-27T05:00:30'); // 10:30:30 IST
    assert.strictEqual(nextDueAt('IN', utc('2026-10-27T05:00:00'), now, interval), utc('2026-10-27T05:01:00'));
  });

  it('a fetch that would land after the close is replaced by one fetch just after the close', () => {
    const at = utc('2026-10-27T09:59:00'); // 15:29 IST
    const now = utc('2026-10-27T09:59:20');
    assert.strictEqual(nextDueAt('IN', at, now, interval), utc('2026-10-27T10:15:00')); // close 10:00 + 15 min settle
    const us = utc('2026-10-27T19:59:30'); // 15:59:30 EDT
    assert.strictEqual(nextDueAt('US', us, us + 5_000, interval), utc('2026-10-27T20:05:00')); // close + 5 min
  });

  it('after the closing fetch the next due time is the next open', () => {
    const at = utc('2026-10-27T10:15:00'); // closing fetch done
    assert.strictEqual(nextDueAt('IN', at, utc('2026-10-27T12:00:00'), interval), utc('2026-10-28T03:45:00'));
    assert.strictEqual(isStale('IN', at, utc('2026-10-28T03:44:59'), interval), false);
    assert.strictEqual(isStale('IN', at, utc('2026-10-28T03:45:00'), interval), true);
  });

  it('between the close and the settle time the closing fetch is pending', () => {
    const at = utc('2026-10-27T09:59:00');
    const now = utc('2026-10-27T10:05:00');
    assert.strictEqual(nextDueAt('IN', at, now, interval), utc('2026-10-27T10:15:00'));
    assert.strictEqual(isStale('IN', at, now, interval), false);
    assert.strictEqual(isStale('IN', at, utc('2026-10-27T10:15:00'), interval), true);
  });

  it('a quote older than the last close is due immediately, even long after (e.g. editor started on Saturday)', () => {
    const at = utc('2026-10-30T08:00:00'); // Friday morning
    const now = utc('2026-10-31T12:00:00'); // Saturday
    assert.strictEqual(nextDueAt('IN', at, now, interval), now);
    assert.strictEqual(nextDueAt('US', at, now, interval), now);
  });

  it('a Friday closing fetch holds until Monday open (US, DST-aware)', () => {
    const at = utc('2026-10-30T20:05:00'); // Fri 16:05 EDT
    assert.strictEqual(nextDueAt('US', at, utc('2026-10-31T10:00:00'), interval), utc('2026-11-02T14:30:00')); // Mon 09:30 EST
  });

  it('FX follows its own week: nothing between Friday 17:00 ET and Sunday 17:00 ET', () => {
    const at = utc('2026-10-30T21:05:00'); // just after the weekly close
    assert.strictEqual(nextDueAt('FX', at, utc('2026-10-31T12:00:00'), FX_MIN_INTERVAL_MS), utc('2026-11-01T22:00:00'));
  });
});
