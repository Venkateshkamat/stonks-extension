import * as fs from 'fs';
import * as path from 'path';
import { Quote } from '../types';

/** A quote together with when it was fetched (epoch ms). */
export interface CachedQuote {
  quote: Quote;
  at: number;
}

export type QuoteCacheData = Record<string, CachedQuote>;

/** Persistence backend for the shared quote cache (synchronous: the payload is a couple of KB). */
export interface QuoteCacheStorage {
  /** Never throws: returns {} when nothing is stored or the contents are unusable. */
  read(): QuoteCacheData;
  /** Best effort: failures are swallowed (the cache is an optimisation, not state). */
  write(data: QuoteCacheData): void;
}

/** Entries older than this are dropped on save (they are only useful as a last-known-price fallback). */
export const CACHE_MAX_AGE_MS = 14 * 24 * 3_600_000;
const FORMAT_VERSION = 1;
const FILE_NAME = 'quotes.json';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isCachedQuote(v: unknown): v is CachedQuote {
  if (!v || typeof v !== 'object') return false;
  const { quote: q, at } = v as { quote?: Record<string, unknown>; at?: unknown };
  return (
    isFiniteNumber(at) &&
    !!q &&
    typeof q === 'object' &&
    typeof q.symbol === 'string' &&
    isFiniteNumber(q.price) &&
    q.price > 0 &&
    isFiniteNumber(q.prevClose) &&
    isFiniteNumber(q.change) &&
    isFiniteNumber(q.changePercent) &&
    (q.currency === 'INR' || q.currency === 'USD') &&
    (q.source === 'yahoo' || q.source === 'finnhub') &&
    isFiniteNumber(q.time)
  );
}

/**
 * Quote cache shared by every editor window of the same user, kept in one small JSON file in the extension's
 * global storage directory (not in globalState: that is one blob per extension that every window rewrites and
 * re-parses wholesale, so frequent cache writes could race with real user data like holdings and pins).
 * Writes are atomic (temp file + rename).
 */
export class FileQuoteCacheStorage implements QuoteCacheStorage {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, FILE_NAME);
  }

  read(): QuoteCacheData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { v?: unknown; entries?: unknown };
      if (raw?.v !== FORMAT_VERSION || !raw.entries || typeof raw.entries !== 'object') return {};
      const out: QuoteCacheData = {};
      for (const [k, v] of Object.entries(raw.entries)) if (isCachedQuote(v)) out[k] = v;
      return out;
    } catch {
      return {};
    }
  }

  write(data: QuoteCacheData): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: FORMAT_VERSION, entries: data }));
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing more to do
      }
    }
  }
}

/** In-memory backend, used by tests and as the fallback when no storage directory is available. */
export class MemoryQuoteCacheStorage implements QuoteCacheStorage {
  private data: QuoteCacheData = {};
  reads = 0;
  writes = 0;

  read(): QuoteCacheData {
    this.reads++;
    return JSON.parse(JSON.stringify(this.data)) as QuoteCacheData;
  }

  write(data: QuoteCacheData): void {
    this.writes++;
    this.data = JSON.parse(JSON.stringify(data)) as QuoteCacheData;
  }
}

/**
 * Last-fetched quotes by key, shared between windows. `load()` always reads the backend (another window may have
 * written since); `save()` merges - for each key the newest fetch wins - so two windows saving at about the same time
 * keep each other's entries.
 */
export class SharedQuoteCache {
  constructor(
    private readonly storage: QuoteCacheStorage,
    private readonly now: () => number = Date.now,
  ) {}

  load(): QuoteCacheData {
    return this.storage.read();
  }

  save(entries: QuoteCacheData): void {
    const merged = this.storage.read();
    for (const [k, e] of Object.entries(entries)) {
      const cur = merged[k];
      if (!cur || e.at >= cur.at) merged[k] = e;
    }
    const cutoff = this.now() - CACHE_MAX_AGE_MS;
    for (const [k, e] of Object.entries(merged)) if (e.at < cutoff) delete merged[k];
    this.storage.write(merged);
  }
}
