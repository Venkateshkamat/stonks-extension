import * as vscode from 'vscode';
import { buildChartModel, ChartModel } from '../panel/chartModel';
import { buildPanelModel, historyKey } from '../panel/model';
import { buildHtml, FromWebview, makeNonce, parseWebviewMessage, ToWebview } from '../panel/protocol';
import { PortfolioController, PortfolioSnapshot } from '../portfolio/controller';
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
  private diag: PanelDiagnostics = { ready: false, errors: [] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: PortfolioController,
  ) {}

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

    this.controller.setIncludeIndices(true);
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
      this.post({ type: 'state', model: buildPanelModel(s) });
      if (this.chart && this.chart.key === historyKey(s)) this.post({ type: 'history', chart: this.chart });
      else this.ensureHistory(s, true);
      return;
    }
    const command = ACTION_COMMANDS[msg.action];
    try {
      if (msg.action === 'edit' || msg.action === 'remove') await vscode.commands.executeCommand(command, msg.id);
      else await vscode.commands.executeCommand(command);
    } catch (e) {
      void vscode.window.showErrorMessage(`Stonks: ${errorMessage(e)}`);
    }
  }

  private push(s: PortfolioSnapshot): void {
    this.post({ type: 'state', model: buildPanelModel(s) });
    this.ensureHistory(s, false);
  }

  /** (Re)loads the 30-day series when holdings / hideAmounts / baseCurrency changed (not on plain quote refreshes). */
  private ensureHistory(s: PortfolioSnapshot, force: boolean): void {
    if (!s.hasHoldings) {
      this.histKey = undefined;
      this.chart = undefined;
      this.histSeq++;
      return;
    }
    const key = historyKey(s);
    if (!force && key === this.histKey) return;
    this.histKey = key;
    this.chart = undefined;
    const seq = ++this.histSeq;
    this.post({ type: 'history', chart: null });
    this.controller
      .getHistorySeries()
      .then((series) => buildChartModel(series, key))
      .catch((e) => buildChartModel({ baseCurrency: s.baseCurrency, hideAmounts: s.hideAmounts, points: [], errors: [errorMessage(e)] }, key))
      .then((chart) => {
        if (seq !== this.histSeq || !this.panel) return; // superseded or panel closed
        this.chart = chart;
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
    this.controller.setIncludeIndices(false);
  }
}
