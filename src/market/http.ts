export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The symbol does not exist at the provider (as opposed to a transient failure). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 10_000;

/** GET a URL and parse JSON, with a timeout. Throws HttpError for non-2xx. */
export async function getJson(
  url: string,
  fetchFn: FetchFn,
  headers: Record<string, string> = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText ?? ''}`.trim());
    }
    return await res.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (controller.signal.aborted) throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}
