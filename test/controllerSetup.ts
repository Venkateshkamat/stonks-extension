import { fixture, mockFetch } from './helpers';
import { MarketDataService } from '../src/market/marketData';
import { ControllerDeps, PortfolioController } from '../src/portfolio/controller';
import { PinStore } from '../src/portfolio/pins';
import { HOLDINGS_KEY, HoldingsStore, KeyValueStore } from '../src/portfolio/store';
import { DEFAULT_SETTINGS, Settings, SettingsSource } from '../src/settings';
import { Currency, Holding } from '../src/types';

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
  async setRefreshIntervalSeconds(v: number): Promise<void> {
    this.value = { ...this.value, refreshIntervalSeconds: v };
  }
  async setBaseCurrency(v: Currency): Promise<void> {
    this.value = { ...this.value, baseCurrency: v };
  }
}

/** Roughly the end of the 5d15m fixtures (2026-10-26 03:23 UTC): BTC's last bar is 03:14 UTC. */
export const FIXTURE_NOW = 1_792_985_000_000;

export function setup(opts: { settings?: Partial<Settings>; routes?: Parameters<typeof mockFetch>[0]; now?: number; deps?: Partial<ControllerDeps>; holdings?: Holding[] } = {}) {
  const fetch = mockFetch(
    opts.routes ?? [
      ['/chart/RELIANCE.NS?range=5d', { body: fixture('yahoo/RELIANCE.NS.5d15m.json') }],
      ['/chart/AAPL?range=5d', { body: fixture('yahoo/AAPL.5d15m.json') }],
      ['/chart/BTC-USD?range=5d', { body: fixture('yahoo/BTC-USD.5d15m.json') }],
      ['USDINR%3DX?range=5d', { body: fixture('yahoo/USDINR.5d15m.json') }],
      ['/chart/BTC-USD?range=1d', { body: fixture('yahoo/BTC-USD.1d.json') }],
      ['/chart/BTC-USD?range=1mo', { body: fixture('yahoo/BTC-USD.1mo.json') }],
      ['%5ENSEI', { body: fixture('yahoo/GSPC.1d.json') }],
      ['/chart/RELIANCE.NS?range=1d', { body: fixture('yahoo/RELIANCE.NS.1d.json') }],
      ['/chart/RELIANCE.NS?range=1mo', { body: fixture('yahoo/RELIANCE.NS.1mo.json') }],
      ['/chart/AAPL?range=1d', { body: fixture('yahoo/AAPL.1d.json') }],
      ['/chart/AAPL?range=1mo', { body: fixture('yahoo/AAPL.1mo.json') }],
      ['USDINR%3DX', { body: fixture('yahoo/USDINR.1d.json') }],
      ['%5EGSPC', { body: fixture('yahoo/GSPC.1d.json') }],
      ['/chart/', { status: 500 }],
    ],
  );
  const clockRef: { t: number } = { t: 0 };
  const market = new MarketDataService({ fetch, getFinnhubKey: () => undefined, now: () => clockRef.t });
  const holdingState = new MemStore();
  if (opts.holdings) holdingState.data.set(HOLDINGS_KEY, opts.holdings);
  const store = new HoldingsStore(holdingState);
  const settings = new FakeSettings({ ...DEFAULT_SETTINGS, ...opts.settings });
  const pins = new PinStore(new MemStore());
  const clock = clockRef;
  clock.t = opts.now ?? 1_700_000_000_000;
  const controller = new PortfolioController({ store, market, settings, pins, now: () => clock.t, random: () => 0, ...opts.deps });
  return { fetch, market, store, settings, controller, pins, clock };
}
