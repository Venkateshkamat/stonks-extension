import * as vscode from 'vscode';
import { buildChartModel, ChartModel } from '../panel/chartModel';
import { INTRADAY_TTL_MS } from '../market/marketData';
import { PanelPrefs } from '../panel/prefs';
import { PanelView } from '../panel/views';
import { buildPanelModel, historyKey } from '../panel/model';
import { buildHtml, FromWebview, makeNonce, parseWebviewMessage, ToWebview } from '../panel/protocol';
import { PortfolioController, PortfolioSnapshot } from '../portfolio/controller';
import { ChartRange } from '../types';
import { PortfolioGroup } from '../symbols';
import { errorMessage } from '../util/async';

const VIEW_TYPE = 'stonks.portfolio';

const ACTION_COMMANDS = {
  add: 'stonks.addHolding',
  refresh: 'stonks.refresh',
  toggleHide: 'stonks.toggleHideAmounts',
  edit: 'stonks.editHolding',
  remove: 'stonks.removeHolding',
} as const;

/** What the webview has reported about itself; used by the integration tests and for surfacing webview errors. */
export interface PanelDiagnostics {
  /** True once the webview posted `ready` (its script loaded and ran under the CSP). */
  ready: boolean;
  /** Whether Chart.js was defined in the webview (last report). */
  chartLib?: boolean;
  /** Whether a chart was drawn (last report). */
  chartRendered?: boolean;
  /** Number of holding rows currently drawn in the table (last report). */
  holdingRows?: number;
  /** Number of buttons in the base-currency toggle (2 when the header rendered). */
  currencyButtons?: number;
  /** Number of pin buttons (one per holding row and market row). */
  pinButtons?: number;
  /** Number of buttons in the 1D | 15D | 30D selector (3 when the chart section rendered). */
  rangeButtons?: number;
  /** Number of buttons in the Stocks | Crypto switcher (2 when the header rendered). */
  viewButtons?: number;
  /** The view the webview reports showing ('stocks' | 'crypto'; undefined until the first report). */
  view?: string;
  /** Rows in the Markets table (indices or coins). */
  marketRows?: number;
  /** Uncaught errors / unhandled rejections reported by the webview. */
  errors: string[];
}

/**
 * Singleton webview panel showing the portfolio table, 30-day chart and indices.
 * The extension posts a pre-formatted view model; the webview only renders it and posts back actions.
 */
export class PortfolioPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private subscriptions: vscode.Disposable[] = [];
  /** Key of the history currently loaded or loading; the chart reloads only when this changes. */
  private histKey?: string;
  private chart?: ChartModel;
  private histSeq = 0;
  /** When the current history was (re)loaded; the 1D range reloads at most every INTRADAY_TTL_MS. */
  private loadedAt = 0;
  private diag: PanelDiagnostics = { ready: false, errors: [] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: PortfolioController,
    private readonly prefs: PanelPrefs,
  ) {}

  /** The selected chart range (persisted). */
  get range(): ChartRange {
    return this.prefs.chartRange;
  }

  /** Changes and persists the chart range, then reloads the chart. Used by the webview selector and by tests. */
  async setRange(range: ChartRange): Promise<void> {
    if (range === this.prefs.chartRange) return;
    await this.prefs.setChartRange(range);
    const s = this.controller.snapshot;
    this.post({ type: 'state', model: this.model(s, { range }) });
    this.ensureHistory(s, true);
  }

  /** The selected view (persisted). */
  get view(): PanelView {
    return this.prefs.view;
  }

  /** Changes and persists the view, then swaps the Markets watch-list and reloads the chart. Used by the switcher and by tests. */
  async setView(view: PanelView): Promise<void> {
    if (view === this.prefs.view) return;
    await this.prefs.setView(view);
    this.applyView();
  }

  /** The chart currently shown (or undefined while loading / closed); exposed for the integration tests. */
  get currentChart(): ChartModel | undefined {
    return this.chart;
  }

  /** True while the panel is open. */
  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Snapshot of the webview's self-reported health (reset each time the panel is opened). */
  get diagnostics(): PanelDiagnostics {
    return { ...this.diag, errors: [...this.diag.errors] };
  }

  /** Opens the panel, or reveals it if it is already open. */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'media');
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Stonks Portfolio', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel = panel;
    this.diag = { ready: false, errors: [] };
    const webview = panel.webview;
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file)).toString();
    webview.html = buildHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      styleUri: uri('panel.css'),
      chartUri: uri('chart.umd.min.js'),
      scriptUri: uri('panel.js'),
    });

    this.applyWatchlists();
    this.subscriptions.push(
      webview.onDidReceiveMessage((raw: unknown) => void this.onMessage(parseWebviewMessage(raw))),
      this.controller.onDidUpdate((s) => this.push(s)),
      panel.onDidDispose(() => this.onDisposed()),
    );
  }

  dispose(): void {
    this.panel?.dispose();
  }

  // ---- internals ----

  private async onMessage(msg: FromWebview | undefined): Promise<void> {
    if (!msg) return;
    if (msg.type === 'diag') {
      this.diag.chartLib = msg.chartLib;
      this.diag.chartRendered = msg.chartRendered;
      this.diag.holdingRows = msg.holdingRows;
      this.diag.currencyButtons = msg.currencyButtons;
      this.diag.rangeButtons = msg.rangeButtons;
      this.diag.pinButtons = msg.pinButtons;
      this.diag.viewButtons = msg.viewButtons;
      this.diag.view = msg.view;
      this.diag.marketRows = msg.marketRows;
      return;
    }
    if (msg.type === 'error') {
      console.error(`[stonks] webview error: ${msg.message}`);
      if (this.diag.errors.length < 20) this.diag.errors.push(msg.message);
      return;
    }
    if (msg.type === 'ready') {
      this.diag.ready = true;
      // A (re)loaded webview starts empty: send everything again.
      const s = this.controller.snapshot;
      this.post({ type: 'state', model: this.model(s) });
      if (this.chart && this.chart.key === historyKey(s, this.prefs.chartRange, this.prefs.view)) this.post({ type: 'history', chart: this.chart });
      else this.ensureHistory(s, true);
      return;
    }
    if (msg.type === 'togglePin') {
      const pinned = this.controller.snapshot.pins.some((p) => p.key === msg.key);
      try {
        await vscode.commands.executeCommand(pinned ? 'stonks.unpinTicker' : 'stonks.pinTicker', msg.key);
      } catch (e) {
        void vscode.window.showErrorMessage(`Stonks: ${errorMessage(e)}`);
      }
      return;
    }
    if (msg.type === 'setView') {
      await this.setView(msg.view);
      return;
    }
    if (msg.type === 'setRange') {
      await this.setRange(msg.range);
      return;
    }
    if (msg.type === 'setCurrency') {
      try {
        await vscode.commands.executeCommand('stonks.setBaseCurrency', msg.currency);
      } catch (e) {
        void vscode.window.showErrorMessage(`Stonks: ${errorMessage(e)}`);
      }
      return;
    }
    const command = ACTION_COMMANDS[msg.action];
    try {
      if (msg.action === 'edit' || msg.action === 'remove') await vscode.commands.executeCommand(command, msg.id);
      else if (msg.action === 'add') await vscode.commands.executeCommand(command, msg.group);
      else await vscode.commands.executeCommand(command);
    } catch (e) {
      void vscode.window.showErrorMessage(`Stonks: ${errorMessage(e)}`);
    }
  }

  private push(s: PortfolioSnapshot): void {
    this.post({ type: 'state', model: this.model(s) });
    this.ensureHistory(s, false);
  }

  private model(s: PortfolioSnapshot, over: { range?: ChartRange } = {}) {
    return buildPanelModel(s, { range: over.range ?? this.prefs.chartRange, view: this.prefs.view });
  }

  /** The Markets table follows the view: indices while Stocks is shown, major coins while Crypto is shown. */
  private applyWatchlists(): void {
    const view = this.prefs.view;
    this.controller.setWatchlists({ indices: view === 'stocks', coins: view === 'crypto' });
  }

  private applyView(): void {
    const s = this.controller.snapshot;
    this.applyWatchlists();
    this.post({ type: 'state', model: this.model(s) });
    this.ensureHistory(s, true);
  }

  /**
   * (Re)loads the chart series when holdings / hideAmounts / baseCurrency / range changed (not on plain quote
   * refreshes). While 1D is selected it also reloads quietly (keeping the old chart on screen) on refresh cycles,
   * at most every INTRADAY_TTL_MS.
   */
  private ensureHistory(s: PortfolioSnapshot, force: boolean): void {
    const group: PortfolioGroup = this.prefs.view;
    if (!s.groups.some((g) => g.group === group)) {
      this.histKey = undefined;
      this.chart = undefined;
      this.histSeq++;
      return;
    }
    const range = this.prefs.chartRange;
    const key = historyKey(s, range, group);
    const sameKey = key === this.histKey;
    const quiet = !force && sameKey && range === '1D' && Date.now() - this.loadedAt >= INTRADAY_TTL_MS;
    if (!force && sameKey && !quiet) return;
    this.histKey = key;
    this.loadedAt = Date.now();
    if (!quiet) {
      this.chart = undefined;
      this.post({ type: 'history', chart: null });
    }
    const seq = ++this.histSeq;
    this.controller
      .getHistorySeries(range, group)
      .then((series) => buildChartModel(series, key))
      .catch((e) =>
        buildChartModel({ range, baseCurrency: s.baseCurrency, hideAmounts: s.hideAmounts, points: [], errors: [errorMessage(e)] }, key),
      )
      .then((chart) => {
        if (seq !== this.histSeq || !this.panel) return; // superseded or panel closed
        if (quiet && chart.values.length === 0 && this.chart) return; // keep the last good chart on a failed quiet reload
        this.chart = chart;
        this.loadedAt = Date.now();
        this.post({ type: 'history', chart });
      });
  }

  private post(msg: ToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  private onDisposed(): void {
    this.panel = undefined;
    this.histKey = undefined;
    this.chart = undefined;
    this.histSeq++;
    this.subscriptions.forEach((d) => d.dispose());
    this.subscriptions = [];
    this.controller.setWatchlists({ indices: false, coins: false });
  }
}
