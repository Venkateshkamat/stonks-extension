import * as vscode from 'vscode';
import { PinItem } from '../portfolio/pins';
import { PortfolioController, PortfolioSnapshot } from '../portfolio/controller';
import { buildPinStatusModel, buildStatusBarModel, StatusBarModel, Tone } from '../statusBarModel';

const COLORS: Record<Tone, vscode.ThemeColor | undefined> = {
  gain: new vscode.ThemeColor('charts.green'),
  loss: new vscode.ThemeColor('charts.red'),
  warning: new vscode.ThemeColor('editorWarning.foreground'),
  neutral: undefined,
};

const MAIN_PRIORITY = 100;
const OPEN_COMMAND = 'stonks.openPortfolio';

/** Read-only view of a pin's status bar item (used by the integration tests). */
export interface PinItemInfo {
  key: string;
  text: string;
  tooltip: string;
  priority: number;
  command: string | undefined;
}

function tooltipText(t: string | vscode.MarkdownString | undefined): string {
  return typeof t === 'string' ? t : (t?.value ?? '');
}

/**
 * The main portfolio item plus one item per pinned ticker. Right-aligned items with a lower priority sit further
 * right, so pins use priorities just below the main item: they appear right after it, in pin order.
 */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: { dispose(): void };
  private pinItems: Array<{ key: string; item: vscode.StatusBarItem }> = [];

  constructor(controller: PortfolioController) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, MAIN_PRIORITY);
    this.item.name = 'Stonks';
    this.item.command = OPEN_COMMAND;
    this.render(controller.snapshot);
    this.item.show();
    this.sub = controller.onDidUpdate((s) => this.render(s));
  }

  /** Current item text, e.g. "$(graph) Stocks +2.34% | Crypto -1.10%". */
  get text(): string {
    return this.item.text;
  }

  get tooltip(): string {
    return tooltipText(this.item.tooltip);
  }

  get command(): string | undefined {
    const c = this.item.command;
    return typeof c === 'string' ? c : c?.command;
  }

  get priority(): number | undefined {
    return this.item.priority;
  }

  /** The pinned-ticker items currently shown, in display order (left to right). */
  get pins(): PinItemInfo[] {
    return this.pinItems.map(({ key, item }) => {
      const c = item.command;
      return { key, text: item.text, tooltip: tooltipText(item.tooltip), priority: item.priority ?? 0, command: typeof c === 'string' ? c : c?.command };
    });
  }

  private render(s: PortfolioSnapshot): void {
    const m = buildStatusBarModel(s);
    this.item.text = m.text;
    this.item.tooltip = m.tooltip;
    this.item.color = COLORS[m.tone];
    this.renderPins(s.pins);
  }

  private renderPins(pins: readonly PinItem[]): void {
    const keys = pins.map((p) => p.key).join('\n');
    if (keys !== this.pinItems.map((p) => p.key).join('\n')) {
      // Pins were added / removed / reordered: rebuild so the priorities (= display order) are right.
      this.pinItems.forEach((p) => p.item.dispose());
      this.pinItems = pins.map((p, i) => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, MAIN_PRIORITY - (i + 1) * 0.001);
        item.name = `Stonks: ${p.name}`;
        item.command = OPEN_COMMAND;
        return { key: p.key, item };
      });
    }
    pins.forEach((p, i) => {
      const { item } = this.pinItems[i];
      const m: StatusBarModel = buildPinStatusModel(p);
      item.text = m.text;
      item.tooltip = m.tooltip;
      item.color = COLORS[m.tone];
      item.show();
    });
  }

  dispose(): void {
    this.sub.dispose();
    this.pinItems.forEach((p) => p.item.dispose());
    this.item.dispose();
  }
}
