import * as assert from 'assert';
import * as vscode from 'vscode';
import type { PortfolioSnapshot } from '../../../src/portfolio/controller';
import type { StonksTestApi } from '../../../src/testApi';

const EXTENSION_ID = 'venkateshkamat.stonks';
const NETWORK_TIMEOUT = 60_000;

let ext: vscode.Extension<StonksTestApi | undefined>;
let api: StonksTestApi;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(100);
  }
}

function webviewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('stonks.portfolio'));
}

async function clearPins(): Promise<void> {
  for (const p of api.pins.list()) await api.pins.remove(p);
}

async function clearHoldings(): Promise<void> {
  for (const h of api.store.list()) await api.store.remove(h.id);
}

/** Puts the settings the tests touch back to their defaults in both scopes. */
async function resetSettings(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('stonks');
  for (const key of ['baseCurrency', 'refreshIntervalSeconds']) {
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
}

function describeErrors(s: PortfolioSnapshot): string {
  return s.errors.map((e) => `${e.label}: ${e.message}`).join('; ') || '(none)';
}

describe(`Stonks in ${process.env.STONKS_IT_TARGET ?? 'editor'} ${vscode.version}`, function () {
  before(async function () {
    console.log(`[stonks-it] host: ${vscode.env.appName} (vscode API ${vscode.version})`);
    const found = vscode.extensions.getExtension<StonksTestApi | undefined>(EXTENSION_ID);
    assert.ok(found, `extension ${EXTENSION_ID} not found in the host`);
    ext = found;
    const exported = await ext.activate();
    assert.ok(exported, 'activate() returned no test API (is STONKS_INTEGRATION_TEST=1 set?)');
    api = exported;
    await clearHoldings();
  });

  after(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (api) {
      await clearHoldings();
      await clearPins();
    }
    // Back to the default (unset) value in whichever scope toggleHideAmounts wrote to.
    await vscode.workspace.getConfiguration('stonks').update('hideAmounts', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('stonks').update('hideAmounts', undefined, vscode.ConfigurationTarget.Workspace);
    await resetSettings();
  });

  it('activates on startup', () => {
    assert.strictEqual(ext.isActive, true);
  });

  it('registers every contributed command', async () => {
    const contributed: string[] = ext.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
    for (const id of ['stonks.setBaseCurrency', 'stonks.setRefreshInterval', 'stonks.pinTicker', 'stonks.unpinTicker']) assert.ok(contributed.includes(id), `manifest is missing ${id}`);
    assert.ok(contributed.length >= 8, `expected the manifest to contribute commands, got ${contributed.length}`);
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter((c) => !all.has(c));
    assert.deepStrictEqual(missing, [], `commands not registered: ${missing.join(', ')}`);
  });

  it('shows an idle status bar item with no holdings', () => {
    assert.strictEqual(api.statusBar.text, '$(graph) Stonks');
    assert.strictEqual(api.statusBar.command, 'stonks.openPortfolio');
    assert.match(api.statusBar.tooltip, /Add holdings/);
  });

  describe('with seeded holdings and live data (no Finnhub key)', () => {
    before(async () => {
      await api.store.add({ symbol: 'AAPL', market: 'US', quantity: 1, buyPrice: 100 });
      await api.store.add({ symbol: 'RELIANCE', market: 'NSE', quantity: 1, buyPrice: 1000 });
      await api.store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 1, buyPrice: 10_000 });
    });

    it('fetches quotes for AAPL, RELIANCE (NSE) and BTC from Yahoo and updates the status bar', async function () {
      this.timeout(NETWORK_TIMEOUT + 10_000);
      let snap: PortfolioSnapshot | undefined;
      try {
        snap = await waitFor(
          'a completed refresh for all three holdings',
          () => {
            const s = api.controller.snapshot;
            return !s.loading && s.lastUpdated !== undefined && s.holdings.length === 3 && s.holdings.every((r) => r.quote || r.error) ? s : undefined;
          },
          NETWORK_TIMEOUT,
        );
      } catch (e) {
        throw new Error(`${(e as Error).message}. Snapshot errors: ${describeErrors(api.controller.snapshot)}. Is the network reachable?`);
      }
      const failed = snap.holdings.filter((r) => !r.quote);
      assert.deepStrictEqual(
        failed.map((r) => `${r.holding.market}:${r.holding.symbol} -> ${r.error}`),
        [],
        `quote fetch failed (network down or Yahoo blocked?). Errors: ${describeErrors(snap)}`,
      );
      for (const r of snap.holdings) assert.ok(r.quote!.price > 0, `${r.holding.symbol} has no positive price`);
      assert.deepStrictEqual(snap.sources, ['yahoo'], 'without a Finnhub key every quote should come from Yahoo');
      assert.ok(snap.totals, 'expected portfolio totals');
      assert.match(api.statusBar.text, /^\$\(graph\) Stocks [+-]?\d+\.\d{2}% \| Crypto [+-]?\d+\.\d{2}%$/, `unexpected status bar text: ${api.statusBar.text}`);
      assert.match(api.statusBar.tooltip, /Stocks: P\/L [+-]?\d+\.\d{2}%/);
      assert.match(api.statusBar.tooltip, /Crypto: P\/L [+-]?\d+\.\d{2}%/);
      assert.match(api.statusBar.tooltip, /Overall:/);
      assert.match(api.statusBar.tooltip, /Yahoo Finance/);
      assert.match(api.statusBar.tooltip, /Value:/);
    });

    it('toggleHideAmounts flips the setting and hides amounts in the status bar tooltip', async () => {
      const cfg = () => vscode.workspace.getConfiguration('stonks');
      assert.strictEqual(cfg().get('hideAmounts'), false);
      await vscode.commands.executeCommand('stonks.toggleHideAmounts');
      await waitFor('hideAmounts=true', () => cfg().get('hideAmounts') === true);
      await waitFor('tooltip without amounts', () => !/Value:/.test(api.statusBar.tooltip));
      await vscode.commands.executeCommand('stonks.toggleHideAmounts');
      await waitFor('hideAmounts=false', () => cfg().get('hideAmounts') === false);
      await waitFor('tooltip with amounts', () => /Value:/.test(api.statusBar.tooltip));
    });

    it('setBaseCurrency writes stonks.baseCurrency and re-bases the status bar tooltip', async function () {
      this.timeout(NETWORK_TIMEOUT);
      const cfg = () => vscode.workspace.getConfiguration('stonks');
      assert.strictEqual(cfg().get('baseCurrency'), 'INR');
      try {
        await vscode.commands.executeCommand('stonks.setBaseCurrency', 'USD');
        await waitFor('baseCurrency=USD', () => cfg().get('baseCurrency') === 'USD');
        await waitFor('snapshot in USD with totals', () => api.controller.snapshot.baseCurrency === 'USD' && api.controller.snapshot.totals?.currency === 'USD' && !api.controller.snapshot.loading, NETWORK_TIMEOUT);
        await waitFor('USD amounts in the tooltip', () => /Value: \$/.test(api.statusBar.tooltip));
      } finally {
        await cfg().update('baseCurrency', undefined, vscode.ConfigurationTarget.Global);
        await cfg().update('baseCurrency', undefined, vscode.ConfigurationTarget.Workspace);
      }
      await waitFor('baseCurrency back to INR', () => api.controller.snapshot.baseCurrency === 'INR');
    });

    it('setRefreshInterval writes stonks.refreshIntervalSeconds and reschedules the controller', async () => {
      const cfg = () => vscode.workspace.getConfiguration('stonks');
      assert.strictEqual(cfg().get('refreshIntervalSeconds'), 60);
      try {
        await vscode.commands.executeCommand('stonks.setRefreshInterval', 120);
        await waitFor('refreshIntervalSeconds=120', () => cfg().get('refreshIntervalSeconds') === 120);
        await waitFor('controller using 120s', () => api.controller.currentRefreshIntervalSeconds === 120);
      } finally {
        await cfg().update('refreshIntervalSeconds', undefined, vscode.ConfigurationTarget.Global);
        await cfg().update('refreshIntervalSeconds', undefined, vscode.ConfigurationTarget.Workspace);
      }
      await waitFor('controller back to 60s', () => api.controller.currentRefreshIntervalSeconds === 60);
    });

    it('pinning a holding and an index creates status bar items right after the main item; unpinning removes them', async function () {
      this.timeout(NETWORK_TIMEOUT);
      assert.strictEqual(api.panel.isOpen, false, 'index pins must work with the panel closed');
      assert.strictEqual(api.statusBar.pins.length, 0);
      try {
        await vscode.commands.executeCommand('stonks.pinTicker', 'h:US:AAPL');
        const aapl = await waitFor('AAPL pin with a quote', () => api.statusBar.pins.find((p) => p.key === 'h:US:AAPL' && /^AAPL \$[\d,]+\.\d{2} [+-]?\d+\.\d{2}%$/.test(p.text)), NETWORK_TIMEOUT);
        assert.match(aapl.tooltip, /^AAPL \(US\)\n/);
        assert.match(aapl.tooltip, /Your P\/L: [+-]?\d+\.\d{2}%/, 'holding pins show the aggregated P/L %');
        assert.strictEqual(aapl.command, 'stonks.openPortfolio');
        assert.ok(aapl.priority < api.statusBar.priority!, 'the pin is placed to the right of the main item');

        await vscode.commands.executeCommand('stonks.pinTicker', 'm:^NSEI');
        const nifty = await waitFor('NIFTY 50 pin with a quote (fetched without the panel)', () => api.statusBar.pins.find((p) => p.key === 'm:^NSEI' && /^NIFTY 50 [\d,]+\.\d{2} [+-]?\d+\.\d{2}%$/.test(p.text)), NETWORK_TIMEOUT);
        assert.ok(!/Your P\/L/.test(nifty.tooltip));
        const order = api.statusBar.pins;
        assert.deepStrictEqual(order.map((p) => p.key), ['h:US:AAPL', 'm:^NSEI'], 'pin order');
        assert.ok(order[0].priority > order[1].priority, 'later pins are further right');
        assert.deepStrictEqual(api.pins.list().map((p) => (p.kind === 'holding' ? `h:${p.market}:${p.symbol}` : `m:${p.symbol}`)), ['h:US:AAPL', 'm:^NSEI']);
        assert.strictEqual(api.controller.snapshot.indices.length, 0, 'the markets table is not loaded while the panel is closed');

        await vscode.commands.executeCommand('stonks.unpinTicker', 'h:US:AAPL');
        await waitFor('AAPL pin removed', () => api.statusBar.pins.length === 1 && api.statusBar.pins[0].key === 'm:^NSEI');
        await vscode.commands.executeCommand('stonks.pinTicker', 'h:US:NOTMINE'); // unknown holding: warns, pins nothing
        await sleep(200);
        assert.strictEqual(api.pins.list().length, 1);
      } finally {
        await clearPins();
      }
      await waitFor('all pins removed', () => api.statusBar.pins.length === 0);
    });

    it('openPortfolio creates exactly one panel, even when called twice', async () => {
      assert.strictEqual(webviewTabs().length, 0);
      await vscode.commands.executeCommand('stonks.openPortfolio');
      await waitFor('first panel tab', () => webviewTabs().length === 1);
      await vscode.commands.executeCommand('stonks.openPortfolio');
      await sleep(500);
      assert.strictEqual(webviewTabs().length, 1, 'a second panel was created');
      assert.strictEqual(webviewTabs()[0].label, 'Stonks Portfolio');
      assert.strictEqual(api.panel.isOpen, true);
    });

    it('webview loads its script under the real CSP, loads Chart.js and renders the chart without errors', async function () {
      this.timeout(NETWORK_TIMEOUT + 10_000);
      await waitFor('webview ready message (script blocked by CSP?)', () => api.panel.diagnostics.ready, 20_000);
      try {
        await waitFor('chart rendered', () => api.panel.diagnostics.chartRendered === true || api.panel.diagnostics.errors.length > 0, NETWORK_TIMEOUT);
      } catch {
        /* fall through to the descriptive assertions below */
      }
      const d = api.panel.diagnostics;
      assert.deepStrictEqual(d.errors, [], `webview reported errors: ${d.errors.join(' | ')}`);
      assert.strictEqual(d.ready, true);
      assert.strictEqual(d.chartLib, true, 'Chart.js did not load in the webview (typeof Chart === "undefined")');
      assert.strictEqual(api.panel.view, 'stocks', 'default view');
      assert.strictEqual(d.view, 'stocks');
      assert.strictEqual(d.viewButtons, 2, 'the Stocks | Crypto switcher should be rendered');
      assert.strictEqual(d.holdingRows, 2, 'the Stocks view shows the 2 seeded stock holdings (AAPL, RELIANCE), not BTC');
      assert.strictEqual(d.currencyButtons, 2, 'the INR | USD toggle should be rendered in the header');
      assert.ok((d.pinButtons ?? 0) >= 3, `every holding row has a pin button, got ${d.pinButtons}`);
      assert.strictEqual(d.rangeButtons, 3, 'the 1D | 15D | 30D selector should be rendered above the chart');
      assert.strictEqual(api.panel.range, '30D', 'default range');
      assert.strictEqual(api.panel.currentChart?.range, '30D');
      assert.strictEqual(d.chartRendered, true, 'the chart was not rendered (history fetch failed or chart code threw)');
    });

    it('switching to the Crypto view shows only BTC, major-coin quotes and a crypto-only chart; the choice persists', async function () {
      this.timeout(NETWORK_TIMEOUT + 10_000);
      try {
        await waitFor('index rows in the Stocks view', () => (api.panel.diagnostics.marketRows ?? 0) >= 6, NETWORK_TIMEOUT);
        assert.ok(api.controller.snapshot.indices.length === 6 && api.controller.snapshot.coins.length === 0, 'the Stocks view loads indices only');

        await api.panel.setView('crypto');
        assert.strictEqual(api.panel.view, 'crypto');
        await waitFor('webview shows the crypto view with 1 holding row', () => api.panel.diagnostics.view === 'crypto' && api.panel.diagnostics.holdingRows === 1, 20_000);
        await waitFor('5 coin rows', () => api.panel.diagnostics.marketRows === 5, NETWORK_TIMEOUT);
        const snap = api.controller.snapshot;
        assert.strictEqual(snap.indices.length, 0, 'indices are no longer fetched in the Crypto view');
        assert.ok(snap.coins.length === 5 && snap.coins.every((c) => c.quote && c.quote.price > 0), `coin quotes: ${snap.coins.map((c) => `${c.index.name}:${c.error ?? 'ok'}`).join(', ')}`);
        const chart = await waitFor('crypto chart', () => (api.panel.currentChart?.key.includes('"crypto"') ? api.panel.currentChart : undefined), NETWORK_TIMEOUT);
        assert.ok(chart.values.length > 0, `crypto chart has no points: ${chart.message ?? ''} ${chart.errors.join('; ')}`);
        await waitFor('chart rendered in the crypto view', () => api.panel.diagnostics.chartRendered === true);
        assert.deepStrictEqual(api.panel.diagnostics.errors, []);

        // A coin can be pinned from the Markets table and shows a dollar price in the status bar.
        await vscode.commands.executeCommand('stonks.pinTicker', 'm:ETH-USD');
        const eth = await waitFor('ETH coin pin', () => api.statusBar.pins.find((p) => p.key === 'm:ETH-USD' && /^ETH \$[\d,]+\.\d{2} [+-]?\d+\.\d{2}%$/.test(p.text)), NETWORK_TIMEOUT);
        assert.strictEqual(eth.command, 'stonks.openPortfolio');
        await vscode.commands.executeCommand('stonks.unpinTicker', 'm:ETH-USD');
        await waitFor('coin pin removed', () => api.statusBar.pins.length === 0);

        // Closing and reopening the panel keeps the Crypto view.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor('panel closed', () => !api.panel.isOpen);
        assert.strictEqual(api.controller.snapshot.coins.length, 0, 'coins are only fetched while the Crypto view is open');
        await vscode.commands.executeCommand('stonks.openPortfolio');
        await waitFor('reopened on the crypto view', () => api.panel.diagnostics.ready && api.panel.diagnostics.view === 'crypto' && api.panel.diagnostics.holdingRows === 1, 20_000);
        assert.strictEqual(api.panel.view, 'crypto');
      } finally {
        await api.panel.setView('stocks'); // restore the default so persisted state does not leak
      }
      await waitFor('webview back on stocks with 2 rows', () => api.panel.diagnostics.view === 'stocks' && api.panel.diagnostics.holdingRows === 2, 20_000);
      assert.strictEqual(api.panel.view, 'stocks');
      assert.deepStrictEqual(api.panel.diagnostics.errors, []);
    });

    it('switching the chart range to 1D and 15D loads the matching chart without webview errors, and persists the choice', async function () {
      this.timeout(NETWORK_TIMEOUT + 10_000);
      try {
        await api.panel.setRange('1D');
        const chart1d = await waitFor('1D chart', () => (api.panel.currentChart?.range === '1D' ? api.panel.currentChart : undefined), NETWORK_TIMEOUT);
        assert.match(chart1d.title, /^1-day portfolio value/);
        assert.ok(chart1d.values.length > 0, `1D chart has no points: ${chart1d.message ?? ''} ${chart1d.errors.join('; ')}`);
        assert.ok(chart1d.labels.every((l) => /^\d{2}:\d{2}$/.test(l)), 'the 1D x axis shows times');
        assert.ok(chart1d.values.length <= 120, 'at most ~96 15-minute bars plus partial bars');
        await waitFor('chart rendered for 1D', () => api.panel.diagnostics.chartRendered === true);
        assert.strictEqual(api.panel.range, '1D');

        await api.panel.setRange('15D');
        const chart15 = await waitFor('15D chart', () => (api.panel.currentChart?.range === '15D' ? api.panel.currentChart : undefined), NETWORK_TIMEOUT);
        assert.match(chart15.title, /^15-day portfolio value/);
        assert.ok(chart15.values.length > 5 && chart15.values.length <= 16);
        assert.deepStrictEqual(api.panel.diagnostics.errors, [], 'webview reported errors after switching ranges');
        assert.strictEqual(api.panel.diagnostics.rangeButtons, 3);
      } finally {
        await api.panel.setRange('30D'); // restore the default so persisted state does not leak
      }
      assert.strictEqual(api.panel.range, '30D');
    });

    it('closing the panel and reopening it creates a fresh single panel', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor('panel closed', () => webviewTabs().length === 0 && !api.panel.isOpen);
      await vscode.commands.executeCommand('stonks.openPortfolio');
      await waitFor('panel reopened', () => webviewTabs().length === 1);
      await waitFor('webview ready after reopen', () => api.panel.diagnostics.ready, 20_000);
      assert.deepStrictEqual(api.panel.diagnostics.errors, []);
    });

    it('shows a single number once only stocks (or only crypto) remain', async function () {
      this.timeout(NETWORK_TIMEOUT);
      const isBtc = (h: { symbol: string }) => h.symbol === 'BTC';
      const btc = api.store.list().filter(isBtc);
      await api.store.remove(btc[0].id);
      await waitFor('stocks-only text', () => /^\$\(graph\) [+-]?\d+\.\d{2}%$/.test(api.statusBar.text), NETWORK_TIMEOUT);
      assert.ok(!/Crypto:/.test(api.statusBar.tooltip));
      for (const h of api.store.list().filter((x) => !isBtc(x))) await api.store.remove(h.id);
      await api.store.add({ symbol: 'BTC', market: 'CRYPTO', quantity: 1, buyPrice: 10_000 });
      await waitFor('crypto-only text', () => /^\$\(graph\) Crypto [+-]?\d+\.\d{2}%$/.test(api.statusBar.text), NETWORK_TIMEOUT);
    });

    it('returns to the idle status bar once the holdings are removed', async () => {
      await clearHoldings();
      await waitFor('idle status bar', () => api.statusBar.text === '$(graph) Stonks');
    });
  });

});
