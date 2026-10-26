import * as fs from 'fs';
import * as path from 'path';
import { FetchFn } from '../src/market/http';

export function fixture(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', rel), 'utf8'));
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  /** Throw instead of responding (network error). */
  throws?: Error;
}

export type Route = MockResponse | ((url: string) => MockResponse);
export type RouteEntry = readonly [string, Route];

/** Fetch mock: routes are matched by URL substring, first match wins. Records every URL called. */
export function mockFetch(routes: readonly RouteEntry[]): FetchFn & { calls: string[]; headers: Array<Record<string, string>> } {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fn = (async (input: string, init?: RequestInit) => {
    calls.push(input);
    headers.push((init?.headers as Record<string, string>) ?? {});
    const match = routes.find(([k]) => input.includes(k));
    if (!match) throw new Error(`mockFetch: unexpected URL ${input}`);
    const r = typeof match[1] === 'function' ? match[1](input) : match[1];
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      json: async () => r.body,
    } as unknown as Response;
  }) as FetchFn & { calls: string[]; headers: Array<Record<string, string>> };
  fn.calls = calls;
  fn.headers = headers;
  return fn;
}
