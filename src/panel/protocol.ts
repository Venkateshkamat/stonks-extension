import { randomInt } from 'crypto';
import { ChartModel } from './chartModel';
import { ChartRange, Currency, isChartRange } from '../types';
import { parsePinKey } from '../portfolio/pins';
import { PanelModel } from './model';

/** Extension -> webview. */
export type ToWebview =
  | { type: 'state'; model: PanelModel }
  /** chart: null means "loading". */
  | { type: 'history'; chart: ChartModel | null };

/** Webview -> extension. */
export type FromWebview =
  | { type: 'ready' }
  /** Webview health report: whether Chart.js loaded, whether a chart is drawn and how many holding rows are shown. */
  | { type: 'diag'; chartLib: boolean; chartRendered: boolean; holdingRows: number; currencyButtons: number; rangeButtons: number; pinButtons: number }
  /** An uncaught error or unhandled rejection inside the webview. */
  | { type: 'error'; message: string }
  | { type: 'action'; action: 'add' | 'refresh' | 'toggleHide' }
  /** Base-currency toggle in the panel header. */
  | { type: 'setCurrency'; currency: Currency }
  /** Chart range selector (1D | 15D | 30D). */
  | { type: 'setRange'; range: ChartRange }
  /** Pin / unpin button on a holding or market row. `key` is a pinKey(). */
  | { type: 'togglePin'; key: string }
  | { type: 'action'; action: 'edit' | 'remove'; id: string };

/** Validates an untrusted message from the webview. Returns undefined for anything unexpected. */
export function parseWebviewMessage(raw: unknown): FromWebview | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (m.type === 'ready') return { type: 'ready' };
  if (m.type === 'diag') {
    const count = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0);
    return { type: 'diag', chartLib: m.chartLib === true, chartRendered: m.chartRendered === true, holdingRows: count(m.holdingRows), currencyButtons: count(m.currencyButtons), rangeButtons: count(m.rangeButtons), pinButtons: count(m.pinButtons) };
  }
  if (m.type === 'error') return { type: 'error', message: typeof m.message === 'string' ? m.message.slice(0, 500) : 'unknown error' };
  if (m.type === 'setCurrency') return m.currency === 'INR' || m.currency === 'USD' ? { type: 'setCurrency', currency: m.currency } : undefined;
  if (m.type === 'setRange') return isChartRange(m.range) ? { type: 'setRange', range: m.range } : undefined;
  if (m.type === 'togglePin') return parsePinKey(m.key) ? { type: 'togglePin', key: m.key as string } : undefined;
  if (m.type !== 'action') return undefined;
  switch (m.action) {
    case 'add':
    case 'refresh':
    case 'toggleHide':
      return { type: 'action', action: m.action };
    case 'edit':
    case 'remove':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 ? { type: 'action', action: m.action, id: m.id } : undefined;
    default:
      return undefined;
  }
}

export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  styleUri: string;
  chartUri: string;
  scriptUri: string;
}

/** The webview document. Strict CSP: only nonce'd scripts and local styles, no inline script/style, no network. */
export function buildHtml(o: HtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${o.cspSource}`,
    `script-src 'nonce-${o.nonce}'`,
    `img-src ${o.cspSource} data:`,
    `font-src ${o.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stonks Portfolio</title>
<link rel="stylesheet" href="${o.styleUri}">
</head>
<body>
<div id="app"></div>
<script nonce="${o.nonce}" src="${o.chartUri}"></script>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function makeNonce(random: (max: number) => number = randomInt): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += NONCE_CHARS.charAt(random(NONCE_CHARS.length));
  return s;
}
