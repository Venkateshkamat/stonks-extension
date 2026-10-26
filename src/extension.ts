import * as vscode from 'vscode';
import { MarketDataService } from './market/marketData';
import { PortfolioController } from './portfolio/controller';
import { HOLDINGS_KEY, HoldingsStore } from './portfolio/store';
import { FinnhubKeyManager } from './ui/apiKey';
import { registerCommands } from './ui/commands';
import { PanelPrefs } from './panel/prefs';
import { PortfolioPanel } from './ui/portfolioPanel';
import { StatusBarController } from './ui/statusBar';
import { VsCodeSettings } from './ui/vscodeSettings';
import { StonksTestApi } from './testApi';

export async function activate(context: vscode.ExtensionContext): Promise<StonksTestApi | undefined> {
  context.globalState.setKeysForSync([HOLDINGS_KEY]);

  // The key manager needs the market service (to verify keys) and the service needs the key: break the cycle lazily.
  let keys: FinnhubKeyManager | undefined;
  const market = new MarketDataService({
    fetch: (url, init) => fetch(url, init),
    getFinnhubKey: () => keys?.get(),
  });
  keys = new FinnhubKeyManager(context.secrets, context.globalState, market);
  await keys.init();

  const store = new HoldingsStore(context.globalState);
  const controller = new PortfolioController({ store, market, settings: new VsCodeSettings() });
  const statusBar = new StatusBarController(controller);
  const panel = new PortfolioPanel(context.extensionUri, controller, new PanelPrefs(context.globalState));

  context.subscriptions.push(
    keys,
    controller,
    statusBar,
    panel,
    keys.onDidChange(() => {
      market.clearAll();
      void controller.refresh('key');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('stonks')) controller.notifySettingsChanged();
    }),
    ...registerCommands({
      store,
      market,
      controller,
      keys,
      openPortfolio: () => panel.show(),
    }),
  );

  void controller.start();
  void keys.promptOnActivation();

  // Integration-test hook: only exposed when the test launcher sets this env var; undefined for real users.
  return process.env.STONKS_INTEGRATION_TEST === '1' ? { store, controller, statusBar, panel } : undefined;
}

export function deactivate(): void {
  // disposables are cleaned up via context.subscriptions
}
