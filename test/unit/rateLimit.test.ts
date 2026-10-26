import * as assert from 'assert';
import { HttpError } from '../../src/market/http';
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, withRateLimitBackoff } from '../../src/market/rateLimit';

function fakeFetch(statuses: Array<number | { status: number; retryAfter?: string }>) {
  const calls: string[] = [];
  let i = 0;
  const fn = async (url: string) => {
    calls.push(url);
    const s = statuses[Math.min(i++, statuses.length - 1)];
    const { status, retryAfter } = typeof s === 'number' ? { status: s, retryAfter: undefined } : s;
    return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: (h: string) => (h === 'retry-after' ? (retryAfter ?? null) : null) }, json: async () => ({}) } as unknown as Response;
  };
  return { fn, calls };
}

describe('withRateLimitBackoff', () => {
  const A = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL';
  const B = 'https://finnhub.io/api/v1/quote?symbol=AAPL';

  it('passes requests through while nothing is limited', async () => {
    const { fn, calls } = fakeFetch([200]);
    const f = withRateLimitBackoff(fn, () => 0);
    await f(A);
    await f(A);
    assert.strictEqual(calls.length, 2);
  });

  it('after a 429 blocks that host without touching the network, then retries once the back-off has passed', async () => {
    let t = 1_000;
    const { fn, calls } = fakeFetch([429, 200]);
    const f = withRateLimitBackoff(fn, () => t);
    assert.strictEqual((await f(A)).status, 429);
    t += BASE_BACKOFF_MS - 1;
    await assert.rejects(f(A), (e: unknown) => e instanceof HttpError && e.status === 429);
    assert.strictEqual(calls.length, 1, 'blocked calls never reach the network');
    assert.ok(f.blockedUntil(A));
    t += 1;
    assert.strictEqual((await f(A)).status, 200);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(f.blockedUntil(A), undefined);
  });

  it('only blocks the host that answered 429', async () => {
    const { fn, calls } = fakeFetch([429, 200]);
    const f = withRateLimitBackoff(fn, () => 0);
    await f(A);
    await f(B);
    assert.strictEqual(calls.length, 2);
  });

  it('doubles the back-off on consecutive 429s up to the cap, and honours Retry-After', async () => {
    let t = 0;
    const { fn } = fakeFetch([429, 429, 429, { status: 429, retryAfter: '7' }, 429]);
    const f = withRateLimitBackoff(fn, () => t);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await f(A);
      waits.push(f.blockedUntil(A)! - t);
      t = f.blockedUntil(A)!;
    }
    assert.deepStrictEqual(waits, [BASE_BACKOFF_MS, BASE_BACKOFF_MS * 2, BASE_BACKOFF_MS * 4, 7_000, Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** 4)]);
  });

  it('a success resets the back-off streak', async () => {
    let t = 0;
    const { fn } = fakeFetch([429, 200, 429]);
    const f = withRateLimitBackoff(fn, () => t);
    await f(A);
    t = f.blockedUntil(A)!;
    await f(A); // 200
    await f(A); // 429 again: back to the base wait
    assert.strictEqual(f.blockedUntil(A)! - t, BASE_BACKOFF_MS);
  });
});
