import { fixture, mockFetch } from './helpers';
import { MarketDataService } from '../src/market/marketData';
import { PortfolioController } from '../src/portfolio/controller';
import { HoldingsStore, KeyValueStore } from '../src/portfolio/store';
import { DEFAULT_SETTINGS, Settings, SettingsSource } from '../src/settings';

export class MemStore implements KeyValueStore {
  data = new Map<string, unknown>();
  get<T>(k: string, d: T): T {
    return (this.data.has(k) ? this.data.get(k) : d) as T;
  }
  async update(k: string, v: unknown): Promise<void> {
    this.data.set(k, JSON.parse(JSON.stringify(v)));
  }
}

export class FakeSettings implements SettingsSource {
  constructor(public value: Settings = { ...DEFAULT_SETTINGS }) {}
  get(): Settings {
    return { ...this.value };
  }
  async setHideAmounts(v: boolean): Promise<void> {
    this.value = { ...this.value, hideAmounts: v };
  }
}

export function setup(opts: { settings?: Partial<Settings>; routes?: Parameters<typeof mockFetch>[0] } = {}) {
  const fetch = mockFetch(
    opts.routes ?? [
      ['/chart/RELIANCE.NS?range=1d', { body: fixture('yahoo/RELIANCE.NS.1d.json') }],
      ['/chart/RELIANCE.NS?range=1mo', { body: fixture('yahoo/RELIANCE.NS.1mo.json') }],
      ['/chart/AAPL?range=1d', { body: fixture('yahoo/AAPL.1d.json') }],
      ['/chart/AAPL?range=1mo', { body: fixture('yahoo/AAPL.1mo.json') }],
      ['USDINR%3DX', { body: fixture('yahoo/USDINR.1d.json') }],
      ['%5EGSPC', { body: fixture('yahoo/GSPC.1d.json') }],
      ['/chart/', { status: 500 }],
    ],
  );
  const market = new MarketDataService({ fetch, getFinnhubKey: () => undefined });
  const store = new HoldingsStore(new MemStore());
  const settings = new FakeSettings({ ...DEFAULT_SETTINGS, ...opts.settings });
  const controller = new PortfolioController({ store, market, settings, now: () => 1_700_000_000_000 });
  return { fetch, market, store, settings, controller };
}
