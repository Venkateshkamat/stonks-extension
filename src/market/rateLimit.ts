import { FetchFn, HttpError } from './http';

/** First back-off after a 429, doubled on every further 429 up to MAX_BACKOFF_MS. */
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

interface HostState {
  blockedUntil: number;
  streak: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Retry-After as a delay in ms (seconds form only; the HTTP-date form is ignored), if present and sane. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/**
 * Wraps a fetch so that after an HTTP 429 from a host no further requests go to that host until a back-off has
 * passed (30s, 60s, 120s ... capped at 10 minutes, or the server's Retry-After); blocked calls fail immediately with
 * an HttpError(429) and never touch the network. A successful response resets the back-off.
 */
export function withRateLimitBackoff(inner: FetchFn, now: () => number = Date.now): FetchFn & { blockedUntil(url: string): number | undefined } {
  const hosts = new Map<string, HostState>();
  const fn = (async (url: string, init?: RequestInit) => {
    const host = hostOf(url);
    const state = hosts.get(host);
    const t = now();
    if (state && t < state.blockedUntil) {
      throw new HttpError(429, `HTTP 429 rate limited - retrying in ${Math.ceil((state.blockedUntil - t) / 1000)}s`);
    }
    const res = await inner(url, init);
    if (res.status === 429) {
      const streak = (state?.streak ?? 0) + 1;
      const wait = Math.min(MAX_BACKOFF_MS, retryAfterMs(res) ?? BASE_BACKOFF_MS * 2 ** (streak - 1));
      hosts.set(host, { blockedUntil: now() + wait, streak });
    } else if (res.ok && state) {
      hosts.delete(host);
    }
    return res;
  }) as FetchFn & { blockedUntil(url: string): number | undefined };
  fn.blockedUntil = (url) => {
    const s = hosts.get(hostOf(url));
    return s && now() < s.blockedUntil ? s.blockedUntil : undefined;
  };
  return fn;
}
