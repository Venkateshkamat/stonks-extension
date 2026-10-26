import * as vscode from 'vscode';
import { PortfolioController, PortfolioSnapshot } from '../portfolio/controller';
import { buildStatusBarModel, Tone } from '../statusBarModel';

const COLORS: Record<Tone, vscode.ThemeColor | undefined> = {
  gain: new vscode.ThemeColor('charts.green'),
  loss: new vscode.ThemeColor('charts.red'),
  warning: new vscode.ThemeColor('editorWarning.foreground'),
  neutral: undefined,
};

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: { dispose(): void };

  constructor(controller: PortfolioController) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Stonks';
    this.item.command = 'stonks.openPortfolio';
    this.render(controller.snapshot);
    this.item.show();
    this.sub = controller.onDidUpdate((s) => this.render(s));
  }

  /** Current item text, e.g. "$(graph) +2.34%". */
  get text(): string {
    return this.item.text;
  }

  get tooltip(): string {
    const t = this.item.tooltip;
    return typeof t === 'string' ? t : (t?.value ?? '');
  }

  get command(): string | undefined {
    const c = this.item.command;
    return typeof c === 'string' ? c : c?.command;
  }

  private render(s: PortfolioSnapshot): void {
    const m = buildStatusBarModel(s);
    this.item.text = m.text;
    this.item.tooltip = m.tooltip;
    this.item.color = COLORS[m.tone];
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
