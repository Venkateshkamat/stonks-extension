import { PortfolioGroup } from '../symbols';

/** The panel's top-level views. Stocks and Crypto show a portfolio subset; Heatmap embeds a market heatmap. */
export type PanelView = PortfolioGroup;
export const PANEL_VIEWS: readonly PanelView[] = ['stocks', 'crypto'];
export const DEFAULT_PANEL_VIEW: PanelView = 'stocks';

export function isPanelView(v: unknown): v is PanelView {
  return typeof v === 'string' && (PANEL_VIEWS as readonly string[]).includes(v);
}
