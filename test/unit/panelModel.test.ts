import * as assert from 'assert';
import { buildPanelModel, historyKey, toneOf } from '../../src/panel/model';
import { buildSnapshot, FetchedData } from '../../src/portfolio/controller';
import { DEFAULT_SETTINGS, Settings } from '../../src/settings';
import { COINS, Holding, INDICES, Quote } from '../../src/types';

const NOW = 1_700_000_000_000;

const reliance: Holding = { id: 'h1', symbol: 'RELIANCE', market: 'NSE', quantity: 10, buyPrice: 1000, buyDate: '2026-01-05' };
const aapl: Holding = { id: 'h2', symbol: 'AAPL', market: 'US', quantity: 2.5, buyPrice: 200 };
const doge: Holding = { id: 'h3', symbol: 'DOGE', market: 'CRYPTO', quantity: 1000, buyPrice: 0.08 };

function quote(symbol: string, price: number, prevClose: number, currency: 'INR' | 'USD'): Quote {
  const change = price - prevClose;
  return { symbol, price, prevClose, change, changePercent: (change / prevClose) * 100, currency, source: 'yahoo', time: NOW };
}

function snapshot(holdings: Holding[], data: Partial<FetchedData> = {}, settings: Partial<Settings> = {}, loading = false) {
  const quotes = new Map<string, Quote>();
  if (holdings.includes(reliance)) quotes.set('h1', quote('RELIANCE', 1190, 1184.5, 'INR'));
  if (holdings.includes(aapl)) quotes.set('h2', quote('AAPL', 180, 182, 'USD'));
  if (holdings.includes(doge)) quotes.set('h3', quote('DOGE', 0.0832, 0.08, 'USD'));
  const fetched: FetchedData = {
    quotes,
    quoteErrors: new Map(),
    fx: { rate: 80, stale: false },
    indices: [],
    lastUpdated: NOW,
    ...data,
  };
  return buildSnapshot(holdings, fetched, { ...DEFAULT_SETTINGS, ...settings }, loading);
}

const fmtTime = () => '10:00:00';

describe('buildPanelModel', () => {
  describe('with amounts shown (INR base)', () => {
    const model = buildPanelModel(snapshot([reliance, aapl, doge]), { formatTime: fmtTime });

    it('formats the header cards in the base currency (stocks view: the crypto holding is not included)', () => {
      // invested: 10000 + 500*80 = 50000 ; current: 11900 + 450*80 = 47900
      const labels = model.cards.map((c) => c.label);
      assert.deepStrictEqual(labels, ['Current value', 'Invested', 'Total P/L', 'Today']);
      assert.strictEqual(model.cards[0].main.text, '₹47,900.00');
      assert.strictEqual(model.cards[1].main.text, '₹50,000.00');
      assert.strictEqual(model.cards[2].main.text, '-₹2,100.00');
      assert.strictEqual(model.cards[2].main.tone, 'loss');
      assert.ok(model.cards[2].sub?.text.endsWith('%'));
    });

    it('has the full set of columns and matching cells', () => {
      assert.deepStrictEqual(
        model.columns.map((c) => c.label),
        ['Symbol', 'Market', 'Qty', 'Avg Buy', 'LTP', 'Day %', 'Invested', 'Current', 'P/L', 'P/L %'],
      );
      for (const r of model.rows) assert.strictEqual(r.cells.length, model.columns.length);
    });

    it('formats INR rows with rupee symbol and Indian grouping', () => {
      const r = model.rows[0].cells.map((c) => c.text);
      assert.deepStrictEqual(r, ['RELIANCE', 'NSE', '10', '₹1,000.00', '₹1,190.00', '+0.46%', '₹10,000.00', '₹11,900.00', '+₹1,900.00', '+19.00%']);
      assert.strictEqual(model.rows[0].cells[0].title, 'Bought 2026-01-05');
      assert.strictEqual(model.rows[0].cells[8].tone, 'gain');
    });

    it('formats USD rows with dollar symbol and keeps fractional quantity', () => {
      const r = model.rows[1].cells.map((c) => c.text);
      assert.deepStrictEqual(r, ['AAPL', 'US', '2.5', '$200.00', '$180.00', '-1.10%', '$500.00', '$450.00', '-$50.00', '-10.00%']);
      assert.strictEqual(model.rows[1].cells[8].tone, 'loss');
    });

    it('keeps precision for sub-dollar crypto prices (Crypto view)', () => {
      const r = buildPanelModel(snapshot([reliance, aapl, doge]), { view: 'crypto' }).rows[0].cells.map((c) => c.text);
      assert.strictEqual(r[3], '$0.08');
      assert.strictEqual(r[4], '$0.0832');
    });

    it('carries meta information', () => {
      assert.strictEqual(model.updated, '10:00:00');
      assert.strictEqual(model.dataSource, 'Yahoo Finance');
      assert.strictEqual(model.baseCurrency, 'INR');
      assert.strictEqual(model.fx, '1 USD = ₹80.00');
      assert.strictEqual(model.hideAmounts, false);
      assert.strictEqual(model.empty, false);
    });
  });

  it('formats totals in USD when the base currency is USD', () => {
    const m = buildPanelModel(snapshot([reliance, aapl], {}, { baseCurrency: 'USD' }), { formatTime: fmtTime });
    // 11900/80 + 450 = 598.75 ; invested 125 + 500 = 625
    assert.strictEqual(m.cards[0].main.text, '$598.75');
    assert.strictEqual(m.cards[1].main.text, '$625.00');
    assert.strictEqual(m.cards[2].main.text, '-$26.25');
    assert.strictEqual(m.baseCurrency, 'USD');
  });

  describe('with amounts hidden', () => {
    const model = buildPanelModel(snapshot([reliance, aapl], {}, { hideAmounts: true }), { formatTime: fmtTime });

    it('shows only percentage cards in the header', () => {
      assert.deepStrictEqual(model.cards.map((c) => c.label), ['Total P/L', 'Today']);
      for (const c of model.cards) {
        assert.ok(c.main.text.endsWith('%'), c.main.text);
        assert.strictEqual(c.sub, undefined);
      }
    });

    it('drops qty / avg buy / invested / current / P/L columns', () => {
      assert.deepStrictEqual(model.columns.map((c) => c.label), ['Symbol', 'Market', 'LTP', 'Day %', 'P/L %']);
      assert.deepStrictEqual(model.rows[0].cells.map((c) => c.text), ['RELIANCE', 'NSE', '₹1,190.00', '+0.46%', '+19.00%']);
    });

    it('does not leak any hidden amount anywhere in the serialized model', () => {
      const json = JSON.stringify(model);
      for (const secret of ['10,000', '11,900', '1,900', '1,000.00', '₹54', '56,400', '2.5', '$200.00', '$500', '$450']) {
        assert.ok(!json.includes(secret), `leaked ${secret}`);
      }
    });
  });

  describe('empty state', () => {
    const model = buildPanelModel(snapshot([], { lastUpdated: undefined }), { formatTime: fmtTime });
    it('flags empty and has no cards or rows', () => {
      assert.strictEqual(model.empty, true);
      assert.deepStrictEqual(model.cards, []);
      assert.deepStrictEqual(model.rows, []);
      assert.strictEqual(model.updated, undefined);
      assert.strictEqual(model.dataSource, undefined);
    });
  });

  describe('errors and loading', () => {
    it('reports loading while no totals yet', () => {
      const m = buildPanelModel(snapshot([reliance], { quotes: new Map(), lastUpdated: undefined }, {}, true));
      assert.strictEqual(m.statusMessage, 'Loading quotes...');
      assert.strictEqual(m.loading, true);
      assert.deepStrictEqual(m.cards, []);
      assert.strictEqual(m.rows[0].cells[4].text, '--');
    });

    it('reports a failure after a completed refresh with nothing priced', () => {
      const m = buildPanelModel(snapshot([reliance], { quotes: new Map(), quoteErrors: new Map([['h1', 'HTTP 500']]) }));
      assert.ok(m.statusMessage?.startsWith('Could not load quotes'));
      assert.strictEqual(m.rows[0].error, 'HTTP 500');
      // qty / avg buy / invested are still known without a quote
      assert.strictEqual(m.rows[0].cells[2].text, '10');
      assert.strictEqual(m.rows[0].cells[6].text, '₹10,000.00');
      assert.strictEqual(m.rows[0].cells[7].text, '--');
    });

    it('keeps the stale quote and flags the row error', () => {
      const s = snapshot([reliance, aapl], { quoteErrors: new Map([['h2', 'timeout']]) });
      const m = buildPanelModel(s);
      assert.strictEqual(m.rows[1].error, 'timeout');
      assert.strictEqual(m.rows[1].cells[4].text, '$180.00');
      assert.strictEqual(m.rows[0].error, undefined);
    });

    it('lists fx / finnhub issues as warnings but not per-symbol errors', () => {
      const m = buildPanelModel(
        snapshot([reliance, aapl], { fxError: 'Live USDINR rate unavailable; using last known rate.', finnhubIssue: 'Finnhub rate limit reached; using Yahoo Finance instead.', fx: { rate: 80, stale: true } }),
      );
      assert.strictEqual(m.warnings.length, 2);
      assert.ok(m.warnings[0].startsWith('USDINR: '));
      assert.ok(m.warnings[1].startsWith('Finnhub: '));
      assert.strictEqual(m.fx, '1 USD = ₹80.00 (stale)');
    });

    it('mentions holdings excluded from totals', () => {
      const m = buildPanelModel(snapshot([reliance, aapl], { fx: undefined, fxError: 'down' }));
      assert.ok(m.warnings.some((w) => w.includes('1 holding(s) excluded')));
    });
  });

  describe('indices', () => {
    const indices = INDICES.map((index, i) =>
      i === 1
        ? { index, error: 'HTTP 429' }
        : { index, quote: index.region === 'India' ? quote(index.symbol, 24350.5, 24200, 'INR') : quote(index.symbol, 5300.25, 5320, 'USD') },
    );
    const model = buildPanelModel(snapshot([reliance], { indices }));

    it('groups by region in India / US order', () => {
      assert.deepStrictEqual(model.indices.map((g) => g.region), ['India', 'US']);
      assert.strictEqual(model.indices[0].items.length, 3);
      assert.strictEqual(model.indices[1].items.length, 3);
      assert.strictEqual(model.indicesLoading, false);
    });

    it('formats level, change and percent without currency symbols', () => {
      const nifty = model.indices[0].items[0];
      assert.strictEqual(nifty.name, 'NIFTY 50');
      assert.strictEqual(nifty.level.text, '24,350.50');
      assert.strictEqual(nifty.change.text, '+150.50');
      assert.strictEqual(nifty.percent.text, '+0.62%');
      assert.strictEqual(nifty.percent.tone, 'gain');
      const sp = model.indices[1].items[0];
      assert.strictEqual(sp.change.text, '-19.75');
      assert.strictEqual(sp.percent.tone, 'loss');
    });

    it('shows per-index errors inline', () => {
      const sensex = model.indices[0].items[1];
      assert.strictEqual(sensex.error, 'HTTP 429');
      assert.strictEqual(sensex.level.text, '--');
    });

    it('is not hidden by hideAmounts', () => {
      const m = buildPanelModel(snapshot([reliance], { indices }, { hideAmounts: true }));
      assert.strictEqual(m.indices[0].items[0].level.text, '24,350.50');
    });

    it('marks indices as loading when none are present', () => {
      const m = buildPanelModel(snapshot([reliance]));
      assert.strictEqual(m.indicesLoading, true);
      assert.deepStrictEqual(m.indices, []);
    });
  });

  it('is JSON-serializable (survives postMessage)', () => {
    const m = buildPanelModel(snapshot([reliance, aapl, doge]));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(m)), JSON.parse(JSON.stringify(m)));
    assert.ok(!JSON.stringify(m).includes('undefined'));
  });
});

describe('buildPanelModel views', () => {
  const all = [reliance, aapl, doge];
  const stocks = buildPanelModel(snapshot(all), { formatTime: fmtTime, view: 'stocks' });
  const crypto = buildPanelModel(snapshot(all), { formatTime: fmtTime, view: 'crypto' });

  it('defaults to the Stocks view', () => {
    assert.strictEqual(buildPanelModel(snapshot(all)).view, 'stocks');
    assert.strictEqual(crypto.view, 'crypto');
  });

  it('Stocks shows only NSE / BSE / US rows, Crypto only CRYPTO rows', () => {
    assert.deepStrictEqual(stocks.rows.map((r) => r.label), ['NSE:RELIANCE', 'US:AAPL']);
    assert.deepStrictEqual(crypto.rows.map((r) => r.label), ['CRYPTO:DOGE']);
    assert.strictEqual(stocks.empty, false);
    assert.strictEqual(crypto.empty, false);
  });

  it('each view has its own totals in the base currency', () => {
    // crypto: invested 1000 * 0.08 * 80 = 6400, current 1000 * 0.0832 * 80 = 6656
    assert.deepStrictEqual(crypto.cards.map((c) => c.label), ['Current value', 'Invested', 'Total P/L', 'Today']);
    assert.strictEqual(crypto.cards[0].main.text, '₹6,656.00');
    assert.strictEqual(crypto.cards[1].main.text, '₹6,400.00');
    assert.strictEqual(crypto.cards[2].main.text, '+₹256.00');
    assert.strictEqual(crypto.cards[2].sub?.text, '+4.00%');
    assert.strictEqual(stocks.cards[0].main.text, '₹47,900.00');
  });

  it('USD base: the crypto view needs no FX rate, so no fx note and no fx warning', () => {
    const s = snapshot([doge, reliance], { fx: undefined, fxError: 'down' }, { baseCurrency: 'USD' });
    const c = buildPanelModel(s, { view: 'crypto' });
    assert.strictEqual(c.fx, undefined);
    assert.deepStrictEqual(c.warnings, []);
    assert.strictEqual(c.cards[0].main.text, '$83.20');
    const st = buildPanelModel(s, { view: 'stocks' });
    assert.ok(st.warnings.some((w) => w.startsWith('USDINR')), 'the stocks view still warns about the missing rate');
  });

  it('shows the per-view empty state when the view has no holdings, even if the other has', () => {
    const onlyStocks = snapshot([reliance, aapl]);
    const c = buildPanelModel(onlyStocks, { view: 'crypto' });
    assert.strictEqual(c.empty, true);
    assert.deepStrictEqual(c.rows, []);
    assert.deepStrictEqual(c.cards, []);
    assert.strictEqual(c.statusMessage, undefined);
    assert.strictEqual(c.dataSource, undefined);
    assert.strictEqual(buildPanelModel(onlyStocks, { view: 'stocks' }).empty, false);
    const onlyCrypto = snapshot([doge]);
    assert.strictEqual(buildPanelModel(onlyCrypto, { view: 'stocks' }).empty, true);
  });

  it('loading message is per view', () => {
    const s = snapshot([reliance, doge], { quotes: new Map(), lastUpdated: undefined }, {}, true);
    assert.strictEqual(buildPanelModel(s, { view: 'crypto' }).statusMessage, 'Loading quotes...');
    assert.strictEqual(buildPanelModel(snapshot([reliance]), { view: 'crypto' }).statusMessage, undefined);
  });

  it('Markets: indices in the Stocks view, coins in the Crypto view', () => {
    const indices = INDICES.map((index) => ({ index, quote: quote(index.symbol, 100, 99, 'USD') }));
    const coins = COINS.map((index, i) => ({ index, quote: quote(index.symbol, i === 4 ? 0.5231 : 67420.5, i === 4 ? 0.5 : 66810, 'USD') }));
    const s = snapshot(all, { indices, coins });
    const st = buildPanelModel(s, { view: 'stocks' });
    assert.strictEqual(st.marketsTitle, 'Markets');
    assert.deepStrictEqual(st.indices.map((g) => g.region), ['India', 'US']);
    const c = buildPanelModel(s, { view: 'crypto' });
    assert.strictEqual(c.marketsTitle, 'Major coins');
    assert.strictEqual(c.marketsNameLabel, 'Coin');
    assert.strictEqual(c.marketsLevelLabel, 'Price');
    assert.deepStrictEqual(c.indices.map((g) => g.region), ['Crypto']);
    assert.deepStrictEqual(c.indices[0].items.map((i) => i.name), ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
    const btc = c.indices[0].items[0];
    assert.strictEqual(btc.level.text, '$67,420.50');
    assert.strictEqual(btc.change.text, '+$610.50');
    assert.strictEqual(btc.change.tone, 'gain');
    assert.strictEqual(btc.pinKey, 'm:BTC-USD');
    const xrp = c.indices[0].items[4];
    assert.strictEqual(xrp.level.text, '$0.5231');
    assert.strictEqual(xrp.change.text, '+$0.0231');
  });

  it('coin rows show their pinned state and inline errors; loading until coins arrive', () => {
    const coins = [
      { index: COINS[0], quote: quote(COINS[0].symbol, 100, 100, 'USD') },
      { index: COINS[1], error: 'HTTP 429' },
    ];
    const withPin = buildSnapshot([doge], { quotes: new Map(), quoteErrors: new Map(), indices: [], coins, lastUpdated: NOW }, DEFAULT_SETTINGS, false, [{ kind: 'market', symbol: 'BTC-USD' }]);
    const c = buildPanelModel(withPin, { view: 'crypto' });
    assert.strictEqual(c.indices[0].items[0].pinned, true);
    assert.strictEqual(c.indices[0].items[0].change.text, '$0.00');
    assert.strictEqual(c.indices[0].items[1].pinned, false);
    assert.strictEqual(c.indices[0].items[1].error, 'HTTP 429');
    assert.strictEqual(buildPanelModel(snapshot([doge]), { view: 'crypto' }).indicesLoading, true);
  });

  it('historyKey for a group ignores holdings of the other group', () => {
    const base = snapshot([reliance, doge]);
    const withMoreStocks = snapshot([reliance, aapl, doge]);
    assert.strictEqual(historyKey(withMoreStocks, '30D', 'crypto'), historyKey(base, '30D', 'crypto'));
    assert.notStrictEqual(historyKey(withMoreStocks, '30D', 'stocks'), historyKey(base, '30D', 'stocks'));
  });
});

describe('toneOf', () => {
  it('treats values that round to zero as neutral', () => {
    assert.strictEqual(toneOf(0.004), undefined);
    assert.strictEqual(toneOf(-0.004), undefined);
    assert.strictEqual(toneOf(0.01), 'gain');
    assert.strictEqual(toneOf(-0.01), 'loss');
  });
});

describe('historyKey', () => {
  const base = snapshot([reliance, aapl]);

  it('is stable across quote refreshes', () => {
    const refreshed = snapshot([reliance, aapl], { lastUpdated: NOW + 60_000, quotes: new Map([['h1', quote('RELIANCE', 1300, 1190, 'INR')]]) });
    assert.strictEqual(historyKey(refreshed), historyKey(base));
  });

  it('changes with the chart range and the stocks / crypto group', () => {
    const k = historyKey(base);
    assert.strictEqual(historyKey(base, '30D'), k, 'default range is 30D');
    assert.notStrictEqual(historyKey(base, '1D'), k);
    assert.notStrictEqual(historyKey(base, '15D'), k);
    assert.notStrictEqual(historyKey(base, '1D'), historyKey(base, '15D'));
    assert.notStrictEqual(historyKey(base, '30D', 'crypto'), k);
    assert.notStrictEqual(historyKey(base, '30D', 'stocks'), historyKey(base, '30D', 'crypto'));
  });

  it('changes when holdings, hideAmounts or base currency change', () => {
    const k = historyKey(base);
    assert.notStrictEqual(historyKey(snapshot([reliance])), k);
    assert.notStrictEqual(historyKey(snapshot([{ ...reliance, quantity: 11 }, aapl])), k);
    assert.notStrictEqual(historyKey(snapshot([{ ...reliance, buyDate: undefined }, aapl])), k);
    assert.notStrictEqual(historyKey(snapshot([reliance, aapl], {}, { hideAmounts: true })), k);
    assert.notStrictEqual(historyKey(snapshot([reliance, aapl], {}, { baseCurrency: 'USD' })), k);
  });
});
