import * as vscode from 'vscode';
import { MarketDataService } from './market/marketData';
import { PortfolioController } from './portfolio/controller';
import { HOLDINGS_KEY, HoldingsStore } from './portfolio/store';
import { FinnhubKeyManager } from './ui/apiKey';
import { registerCommands } from './ui/commands';
import { StatusBarController } from './ui/statusBar';
import { VsCodeSettings } from './ui/vscodeSettings';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

  context.subscriptions.push(
    keys,
    controller,
    statusBar,
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
      // Replaced by the webview panel in the next phase.
      openPortfolio: () => void vscode.window.showInformationMessage('Portfolio panel coming soon'),
    }),
  );

  void controller.start();
  void keys.promptOnActivation();
}

export function deactivate(): void {
  // disposables are cleaned up via context.subscriptions
}
