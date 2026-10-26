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
    if (api) await clearHoldings();
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
    for (const id of ['stonks.setBaseCurrency', 'stonks.setRefreshInterval']) assert.ok(contributed.includes(id), `manifest is missing ${id}`);
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
      assert.match(api.statusBar.text, /^\$\(graph\) [+-]?\d+\.\d{2}%$/, `unexpected status bar text: ${api.statusBar.text}`);
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
      assert.strictEqual(d.holdingRows, 3, 'the holdings table should show the 3 seeded holdings');
      assert.strictEqual(d.currencyButtons, 2, 'the INR | USD toggle should be rendered in the header');
      assert.strictEqual(d.chartRendered, true, 'the chart was not rendered (history fetch failed or chart code threw)');
    });

    it('closing the panel and reopening it creates a fresh single panel', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor('panel closed', () => webviewTabs().length === 0 && !api.panel.isOpen);
      await vscode.commands.executeCommand('stonks.openPortfolio');
      await waitFor('panel reopened', () => webviewTabs().length === 1);
      await waitFor('webview ready after reopen', () => api.panel.diagnostics.ready, 20_000);
      assert.deepStrictEqual(api.panel.diagnostics.errors, []);
    });

    it('returns to the idle status bar once the holdings are removed', async () => {
      await clearHoldings();
      await waitFor('idle status bar', () => api.statusBar.text === '$(graph) Stonks');
    });
  });

});
