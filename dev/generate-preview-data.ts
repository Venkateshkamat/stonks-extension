/**
 * Generates dev/preview-data.js: realistic mock view models for dev/preview.html, built with the REAL
 * model builders so the preview always matches what the extension posts.
 *
 *   npm run preview:data
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildChartModel } from '../src/panel/chartModel';
import { buildPanelModel, historyKey, PanelModel } from '../src/panel/model';
import { buildSnapshot, FetchedData, HistorySeries } from '../src/portfolio/controller';
import { buildHistorySeries, buildIntradaySeries } from '../src/portfolio/history';
import { DEFAULT_SETTINGS, Settings } from '../src/settings';
import { ChartRange, CHART_RANGES, DailyClose, Holding, INDICES, IntradayPoint, Quote } from '../src/types';

const NOW = Date.UTC(2026, 9, 23, 10, 32, 11);
const TODAY = '2026-10-23';

const HOLDINGS: Holding[] = [
  { id: 'h1', symbol: 'RELIANCE', market: 'NSE', quantity: 25, buyPrice: 1180.5, buyDate: '2026-03-02' },
  { id: 'h2', symbol: 'TCS', market: 'NSE', quantity: 12, buyPrice: 3890 },
  { id: 'h3', symbol: 'HDFCBANK', market: 'BSE', quantity: 40, buyPrice: 1710.25 },
  { id: 'h4', symbol: 'AAPL', market: 'US', quantity: 8, buyPrice: 172.4 },
  { id: 'h5', symbol: 'NVDA', market: 'US', quantity: 3.5, buyPrice: 118.9, buyDate: '2026-10-05' },
  { id: 'h6', symbol: 'TSLA', market: 'US', quantity: 5, buyPrice: 265 },
  { id: 'h7', symbol: 'BTC', market: 'CRYPTO', quantity: 0.0425, buyPrice: 61250 },
  { id: 'h8', symbol: 'DOGE', market: 'CRYPTO', quantity: 12000, buyPrice: 0.094 },
];

// symbol -> [price, prevClose]
const PRICES: Record<string, [number, number]> = {
  RELIANCE: [1324.8, 1311.2],
  TCS: [3702.45, 3731.9],
  HDFCBANK: [1789.6, 1781.15],
  AAPL: [231.4, 229.85],
  NVDA: [141.27, 138.02],
  TSLA: [243.1, 251.6],
  BTC: [67420.5, 66810],
  DOGE: [0.1325, 0.1291],
};

const INDEX_PRICES: Record<string, [number, number]> = {
  '^NSEI': [24832.65, 24710.3],
  '^BSESN': [81420.1, 81012.55],
  '^NSEBANK': [52410.8, 52590.2],
  '^GSPC': [5821.22, 5844.5],
  '^DJI': [42310.9, 42250.1],
  '^IXIC': [18420.75, 18510.4],
};

function quote(symbol: string, price: number, prev: number, currency: 'INR' | 'USD'): Quote {
  const change = price - prev;
  return { symbol, price, prevClose: prev, change, changePercent: (change / prev) * 100, currency, source: 'yahoo', time: NOW };
}

function fetched(holdings: Holding[], extra: Partial<FetchedData> = {}): FetchedData {
  const quotes = new Map<string, Quote>();
  for (const h of holdings) {
    const p = PRICES[h.symbol];
    quotes.set(h.id, quote(h.symbol, p[0], p[1], h.market === 'NSE' || h.market === 'BSE' ? 'INR' : 'USD'));
  }
  return {
    quotes,
    quoteErrors: new Map(),
    fx: { rate: 84.2, stale: false },
    indices: INDICES.map((index) => ({
      index,
      quote: quote(index.symbol, INDEX_PRICES[index.symbol][0], INDEX_PRICES[index.symbol][1], index.region === 'India' ? 'INR' : 'USD'),
    })),
    lastUpdated: NOW,
    ...extra,
  };
}

// Deterministic pseudo random walk.
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function isoDay(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function closesFor(h: Holding, seed: number): DailyClose[] {
  const [last] = PRICES[h.symbol];
  const rand = rng(seed);
  const out: DailyClose[] = [];
  // Walk backwards from the live price so the series ends exactly where the quote is.
  let price = last;
  for (let i = 0; i >= -44; i--) {
    const date = isoDay(i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    if (!weekend || h.market === 'CRYPTO') out.unshift({ date, close: price }); // stocks skip weekends (forward-filled)
    price = price / (1 + (rand() - 0.47) * 0.02);
  }
  return out;
}

/** 15-minute bars for the last ~5 days ending at NOW: stocks only inside a rough session window, crypto around the clock. */
function intradayFor(h: Holding, seed: number): IntradayPoint[] {
  const [last] = PRICES[h.symbol];
  const rand = rng(seed);
  const STEP = 15 * 60 * 1000;
  const end = Math.floor(NOW / STEP) * STEP;
  const out: IntradayPoint[] = [];
  let price = last;
  for (let t = end; t > end - 5 * 24 * 60 * 60 * 1000; t -= STEP) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    // NSE/BSE ~03:45-10:00 UTC, US ~13:30-20:00 UTC, weekdays only.
    const inSession =
      h.market === 'CRYPTO' ||
      (dow >= 1 && dow <= 5 && (h.market === 'US' ? minutes >= 13 * 60 + 30 && minutes <= 20 * 60 : minutes >= 3 * 60 + 45 && minutes <= 10 * 60));
    if (inSession) out.unshift({ t, close: price });
    price = price / (1 + (rand() - 0.49) * 0.004);
  }
  return out;
}

function fxIntraday(): IntradayPoint[] {
  const rand = rng(99);
  const STEP = 15 * 60 * 1000;
  const end = Math.floor(NOW / STEP) * STEP;
  const out: IntradayPoint[] = [];
  let rate = 84.2;
  for (let t = end; t > end - 5 * 24 * 60 * 60 * 1000; t -= STEP) {
    out.unshift({ t, close: rate });
    rate = rate / (1 + (rand() - 0.5) * 0.0006);
  }
  return out;
}

function history(holdings: Holding[], settings: Settings, range: ChartRange, errors: string[] = []): HistorySeries {
  if (range === '1D') {
    const items = holdings.map((holding, i) => ({ holding, points: intradayFor(holding, 21 + i * 17) }));
    return {
      range,
      baseCurrency: settings.baseCurrency,
      hideAmounts: settings.hideAmounts,
      points: buildIntradaySeries(items, { base: settings.baseCurrency, usdInr: 84.2, fxSeries: fxIntraday(), now: NOW, dateOf: (ms) => new Date(ms).toISOString().slice(0, 10) }),
      errors,
    };
  }
  const items = holdings.map((holding, i) => ({ holding, closes: closesFor(holding, 7 + i * 13) }));
  return {
    range,
    baseCurrency: settings.baseCurrency,
    hideAmounts: settings.hideAmounts,
    points: buildHistorySeries(items, { base: settings.baseCurrency, usdInr: 84.2, today: TODAY, days: range === '15D' ? 15 : 30 }),
    errors,
  };
}

type ChartByRange = Partial<Record<ChartRange, ReturnType<typeof buildChartModel> | null>>;

interface Variant {
  model: PanelModel;
  /** Per range: null = still loading; undefined/absent = no chart (empty state). `chart` is the 30D one. */
  charts: ChartByRange;
  chart: ReturnType<typeof buildChartModel> | null | undefined;
}

function variant(holdings: Holding[], settings: Partial<Settings>, opts: { data?: Partial<FetchedData>; loading?: boolean; errors?: string[] } = {}): Variant {
  const st: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const snap = buildSnapshot(holdings, fetched(holdings, opts.data), st, opts.loading ?? false);
  const model = buildPanelModel(snap, { formatTime: () => '10:32:11 AM' });
  if (holdings.length === 0) return { model, charts: {}, chart: undefined };
  if (opts.loading) return { model, charts: { '1D': null, '15D': null, '30D': null }, chart: null };
  const charts: ChartByRange = {};
  for (const r of CHART_RANGES) charts[r] = buildChartModel(history(holdings, st, r, opts.errors), historyKey(snap, r), { timeZone: 'Asia/Kolkata' });
  return { model, charts, chart: charts['30D'] };
}

const errorData = (): Partial<FetchedData> => {
  const base = fetched(HOLDINGS);
  base.quoteErrors.set('h6', 'Yahoo Finance: HTTP 429 (rate limited)');
  base.indices[1] = { index: INDICES[1], error: 'No data returned for ^BSESN' };
  return { quotes: base.quotes, quoteErrors: base.quoteErrors, indices: base.indices, finnhubIssue: 'Finnhub rate limit reached; using Yahoo Finance instead.' };
};

const variants: Record<string, Variant> = {
  shown: variant(HOLDINGS, { hideAmounts: false, baseCurrency: 'INR' }),
  hidden: variant(HOLDINGS, { hideAmounts: true, baseCurrency: 'INR' }),
  usd: variant(HOLDINGS, { hideAmounts: false, baseCurrency: 'USD' }),
  errors: variant(HOLDINGS, { hideAmounts: false, baseCurrency: 'INR' }, { data: errorData(), errors: ['US:TSLA: HTTP 429'] }),
  loading: variant(HOLDINGS, {}, { loading: true, data: { quotes: new Map(), lastUpdated: undefined, indices: [] } }),
  empty: variant([], {}),
};

const out = `/* GENERATED by dev/generate-preview-data.ts (npm run preview:data). Do not edit. */\nwindow.STONKS_MOCK = ${JSON.stringify(variants, null, 1)};\n`;
const target = path.join(__dirname, '..', '..', 'dev', 'preview-data.js');
fs.writeFileSync(target, out);
console.log(`wrote ${target} (${out.length} bytes, variants: ${Object.keys(variants).join(', ')})`);
