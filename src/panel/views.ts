import { PortfolioGroup } from '../symbols';

/** The panel's top-level views. Stocks and Crypto show a portfolio subset; Heatmap embeds a TradingView market heatmap. */
export type PanelView = PortfolioGroup | 'heatmap';
export const PANEL_VIEWS: readonly PanelView[] = ['stocks', 'crypto', 'heatmap'];
export const DEFAULT_PANEL_VIEW: PanelView = 'stocks';

export function isPanelView(v: unknown): v is PanelView {
  return typeof v === 'string' && (PANEL_VIEWS as readonly string[]).includes(v);
}

/** The portfolio group a view shows; undefined for the Heatmap view (no holdings). */
export function viewGroup(view: PanelView): PortfolioGroup | undefined {
  return view === 'heatmap' ? undefined : view;
}

/** Which TradingView widget script renders a source: the stock heatmap or the crypto coins heatmap. */
export type HeatmapWidget = 'stock' | 'crypto';

export interface HeatmapSource {
  /** Stable id (persisted and sent by the webview); for stock heatmaps it is TradingView's `dataSource`. */
  id: string;
  label: string;
  widget: HeatmapWidget;
}

/**
 * Heatmaps offered in the Heatmap view. TradingView's stock heatmap has no Nifty index at all (NIFTY50 renders
 * blank), so India is covered by SENSEX only.
 */
export const HEATMAP_SOURCES: readonly HeatmapSource[] = [
  { id: 'SPX500', label: 'S&P 500', widget: 'stock' },
  { id: 'NASDAQ100', label: 'Nasdaq 100', widget: 'stock' },
  { id: 'DJDJI', label: 'Dow 30', widget: 'stock' },
  { id: 'SENSEX', label: 'SENSEX', widget: 'stock' },
  { id: 'CRYPTO', label: 'Crypto', widget: 'crypto' },
];
export const DEFAULT_HEATMAP_SOURCE = 'SPX500';

export function isHeatmapSource(v: unknown): v is string {
  return typeof v === 'string' && HEATMAP_SOURCES.some((s) => s.id === v);
}

export function findHeatmapSource(id: string): HeatmapSource {
  return HEATMAP_SOURCES.find((s) => s.id === id) ?? HEATMAP_SOURCES[0];
}

/**
 * JSON config for the TradingView widget script, minus `colorTheme` (the webview adds it from the VS Code theme).
 * The top bar is kept (it shows what the colours mean) but its data-set picker is off: the source switcher is ours.
 */
export function heatmapConfig(id: string): Record<string, string | number | boolean> {
  const source = findHeatmapSource(id);
  const common = {
    locale: 'en',
    isTransparent: true,
    hasTopBar: true,
    isDataSetEnabled: false,
    isZoomEnabled: true,
    hasSymbolTooltip: true,
    isMonoSize: false,
    width: '100%',
    height: '100%',
  };
  return source.widget === 'crypto'
    ? { ...common, dataSource: 'Crypto', blockSize: 'market_cap_calc', blockColor: '24h_close_change|5' }
    : { ...common, dataSource: source.id, blockSize: 'market_cap_basic', blockColor: 'change', grouping: 'sector' };
}
