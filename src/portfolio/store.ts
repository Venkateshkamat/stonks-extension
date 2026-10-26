import { randomUUID } from 'crypto';
import { Emitter, Event } from '../util/emitter';
import { Holding, MARKETS } from '../types';
import { normalizeSymbol } from '../symbols';

/** Subset of vscode.Memento used for persistence. */
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const HOLDINGS_KEY = 'stonks.holdings';

export function isValidHolding(h: unknown): h is Holding {
  if (!h || typeof h !== 'object') return false;
  const x = h as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.symbol === 'string' &&
    x.symbol.length > 0 &&
    typeof x.market === 'string' &&
    (MARKETS as readonly string[]).includes(x.market) &&
    typeof x.quantity === 'number' &&
    Number.isFinite(x.quantity) &&
    x.quantity > 0 &&
    typeof x.buyPrice === 'number' &&
    Number.isFinite(x.buyPrice) &&
    x.buyPrice > 0 &&
    (x.buyDate === undefined || typeof x.buyDate === 'string')
  );
}

export type NewHolding = Omit<Holding, 'id'>;

export class HoldingsStore {
  private readonly changed = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changed.event;

  constructor(private readonly storage: KeyValueStore) {}

  list(): Holding[] {
    const raw = this.storage.get<unknown[]>(HOLDINGS_KEY, []);
    return Array.isArray(raw) ? raw.filter(isValidHolding).map((h) => ({ ...h })) : [];
  }

  get(id: string): Holding | undefined {
    return this.list().find((h) => h.id === id);
  }

  async add(input: NewHolding): Promise<Holding> {
    const holding: Holding = { ...input, symbol: normalizeSymbol(input.symbol, input.market), id: randomUUID() };
    if (!holding.buyDate) delete holding.buyDate;
    await this.save([...this.list(), holding]);
    return holding;
  }

  /** Updates quantity / buyPrice / buyDate (pass buyDate: undefined to clear). Symbol and market are fixed. */
  async update(id: string, patch: Partial<Pick<Holding, 'quantity' | 'buyPrice' | 'buyDate'>>): Promise<Holding | undefined> {
    const all = this.list();
    const idx = all.findIndex((h) => h.id === id);
    if (idx < 0) return undefined;
    const next: Holding = { ...all[idx], ...patch };
    if (!next.buyDate) delete next.buyDate;
    all[idx] = next;
    await this.save(all);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const all = this.list();
    const rest = all.filter((h) => h.id !== id);
    if (rest.length === all.length) return false;
    await this.save(rest);
    return true;
  }

  private async save(holdings: Holding[]): Promise<void> {
    await this.storage.update(HOLDINGS_KEY, holdings);
    this.changed.fire();
  }
}
