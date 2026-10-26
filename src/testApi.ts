import { PortfolioController } from './portfolio/controller';
import { HoldingsStore } from './portfolio/store';
import { PortfolioPanel } from './ui/portfolioPanel';
import { StatusBarController } from './ui/statusBar';

/**
 * Object returned from activate() ONLY when STONKS_INTEGRATION_TEST=1 (set by the integration test launcher).
 * It gives the in-host tests access to internals that the VS Code API cannot observe (status bar text, webview health).
 */
export interface StonksTestApi {
  store: HoldingsStore;
  controller: PortfolioController;
  statusBar: StatusBarController;
  panel: PortfolioPanel;
}
