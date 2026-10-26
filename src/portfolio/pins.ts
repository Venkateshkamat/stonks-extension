import { Emitter, Event } from '../util/emitter';
import { Currency, findMarketDef, Market, MARKETS, Quote } from '../types';
import { nativeCurrency, normalizeSymbol } from '../symbols';
import type { IndexResult } from '../market/marketData';
import type { HoldingRow } from './controller';
import type { KeyValueStore } from './store';

/**
 * A ticker pinned to the status bar. Holdings are identified by market + symbol (so several lots of the same
 * symbol share one pin); "market" pins (indices today, crypto coins in the crypto view) by Yahoo symbol.
 */
export type Pin = { kind: 'holding'; market: Market; symbol: string } | { kind: 'market'; symbol: string };

export const PINS_KEY = 'stonks.pins';

/** Stable string identity, also used in webview messages: `h:NSE:RELIANCE` or `m:^NSEI`. */
export function pinKey(p: Pin): string {
  return p.kind === 'holding' ? `h:${p.market}:${p.symbol}` : `m:${p.symbol}`;
}

const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9.&_=^-]{0,30}$/;

export function parsePinKey(key: unknown): Pin | undefined {
  if (typeof key !== 'string' || key.length > 64) return undefined;
  if (key.startsWith('m:')) {
    const symbol = key.slice(2);
    return SYMBOL_RE.test(symbol) ? { kind: 'market', symbol } : undefined;
  }
  const m = /^h:([A-Z]+):(.+)$/.exec(key);
  if (!m || !(MARKETS as readonly string[]).includes(m[1]) || !SYMBOL_RE.test(m[2])) return undefined;
  const market = m[1] as Market;
  return { kind: 'holding', market, symbol: normalizeSymbol(m[2], market) };
}

export function holdingPin(market: Market, symbol: string): Pin {
  return { kind: 'holding', market, symbol: normalizeSymbol(symbol, market) };
}

/** Persisted, ordered set of pins (globalState; synced across machines). Stored as an array of pin keys. */
export class PinStore {
  private readonly changed = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changed.event;

  /**
   * What this instance last wrote. The extension host can hand back a stale globalState value (an echo of an
   * earlier write) for a few hundred ms after a newer write; reading our own last write avoids pins flickering back.
   */
  private latest?: string[];

  constructor(private readonly storage: KeyValueStore) {}

  list(): Pin[] {
    const raw = this.latest ?? this.storage.get<unknown>(PINS_KEY, []);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: Pin[] = [];
    for (const k of raw) {
      const p = parsePinKey(k);
      if (p && !seen.has(pinKey(p))) {
        seen.add(pinKey(p));
        out.push(p);
      }
    }
    return out;
  }

  has(p: Pin): boolean {
    return this.list().some((x) => pinKey(x) === pinKey(p));
  }

  /** Appends the pin (no-op if already pinned). Returns whether anything changed. */
  async add(p: Pin): Promise<boolean> {
    if (this.has(p)) return false;
    await this.save([...this.list(), p]);
    return true;
  }

  async remove(p: Pin): Promise<boolean> {
    const all = this.list();
    const rest = all.filter((x) => pinKey(x) !== pinKey(p));
    if (rest.length === all.length) return false;
    await this.save(rest);
    return true;
  }

  private async save(pins: Pin[]): Promise<void> {
    this.latest = pins.map(pinKey);
    await this.storage.update(PINS_KEY, this.latest);
    this.changed.fire();
  }
}

/** What the status bar needs to render one pin, already resolved against the latest quotes. */
export interface PinItem {
  pin: Pin;
  key: string;
  /** Short status bar label: AAPL / NIFTY 50. */
  label: string;
  /** Tooltip heading: "AAPL (US)" / "NIFTY 50". */
  name: string;
  /** Currency of `price`: native for holdings, USD for coins; undefined for index levels. */
  currency?: Currency;
  /** Number locale for market levels. */
  locale: string;
  price?: number;
  /** Per-unit day change. */
  change?: number;
  changePercent?: number;
  /** Holdings only: P/L % across all lots of the symbol (shown even when amounts are hidden). */
  pnlPercent?: number;
  /** Set when the quote could not be loaded. */
  error?: string;
}

function fromQuote(q: Quote | undefined): Pick<PinItem, 'price' | 'change' | 'changePercent'> {
  return q ? { price: q.price, change: q.change, changePercent: q.changePercent } : {};
}

/**
 * Resolves pins against the current holdings (and quotes) and the pinned market quotes. A holding pin whose
 * holding no longer exists yields no item (the pin is kept in storage and reappears if the holding is re-added).
 */
export function buildPinItems(pins: readonly Pin[], rows: readonly HoldingRow[], markets: readonly IndexResult[]): PinItem[] {
  const items: PinItem[] = [];
  for (const pin of pins) {
    const key = pinKey(pin);
    if (pin.kind === 'holding') {
      const lots = rows.filter((r) => r.holding.market === pin.market && normalizeSymbol(r.holding.symbol, r.holding.market) === pin.symbol);
      if (lots.length === 0) continue;
      const priced = lots.filter((r) => r.pnl);
      const invested = priced.reduce((a, r) => a + r.pnl!.invested, 0);
      const current = priced.reduce((a, r) => a + r.pnl!.current, 0);
      const quote = lots.find((r) => r.quote)?.quote;
      items.push({
        pin,
        key,
        label: pin.symbol,
        name: `${pin.symbol} (${pin.market})`,
        currency: nativeCurrency(pin.market),
        locale: 'en-US',
        ...fromQuote(quote),
        pnlPercent: invested > 0 ? ((current - invested) / invested) * 100 : undefined,
        error: quote ? undefined : lots.find((r) => r.error)?.error,
      });
    } else {
      const def = findMarketDef(pin.symbol);
      const res = markets.find((m) => m.index.symbol === pin.symbol);
      items.push({
        pin,
        key,
        label: def?.name ?? pin.symbol,
        name: def?.name ?? pin.symbol,
        currency: def?.currency,
        locale: def?.region === 'India' ? 'en-IN' : 'en-US',
        ...fromQuote(res?.quote),
        error: res?.quote ? undefined : res?.error,
      });
    }
  }
  return items;
}
