export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Runs `fn` over `items` with at most `limit` in flight; never rejects. Results keep input order. */
export async function mapSettled<I, O>(items: readonly I[], limit: number, fn: (item: I) => Promise<O>): Promise<Settled<O>[]> {
  const results: Settled<O>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (e) {
        results[i] = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
