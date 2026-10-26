import { formatMoney, formatNumber, formatPercent, formatPrice, formatSignedMoney, formatSignedNumber } from './format';
import { GroupSummary, PortfolioSnapshot } from './portfolio/controller';
import { PortfolioTotals } from './portfolio/calc';
import { PinItem } from './portfolio/pins';
import { PortfolioGroup } from './symbols';

export type Tone = 'gain' | 'loss' | 'neutral' | 'warning';

export interface StatusBarModel {
  text: string;
  tooltip: string;
  tone: Tone;
}

const GROUP_LABEL: Record<PortfolioGroup, string> = { stocks: 'Stocks', crypto: 'Crypto' };

/** Gain / loss as displayed (percent rounded to 2 decimals, so +0.00% is neutral). */
export function percentTone(p: number): Tone {
  const rounded = Math.round(p * 100) / 100;
  return rounded > 0 ? 'gain' : rounded < 0 ? 'loss' : 'neutral';
}

function amountLines(t: PortfolioTotals, indent = ''): string[] {
  return [`${indent}Value: ${formatMoney(t.current, t.currency)}`, `${indent}Invested: ${formatMoney(t.invested, t.currency)}`, `${indent}P/L: ${formatSignedMoney(t.pnl, t.currency)}`];
}

function groupTooltipLines(g: GroupSummary, hide: boolean): string[] {
  const label = GROUP_LABEL[g.group];
  const t = g.totals;
  if (!t) return [`${label}: no quotes yet`];
  const today = hide ? formatPercent(t.dayChangePercent) : `${formatPercent(t.dayChangePercent)} (${formatSignedMoney(t.dayChange, t.currency)})`;
  const lines = [`${label}: P/L ${formatPercent(t.pnlPercent)} | Today ${today}`];
  if (!hide) lines.push(...amountLines(t, '  '));
  return lines;
}

/**
 * Pure presentation logic for the main status bar item; unit-tested without VS Code.
 *
 * Text: with both stocks and crypto holdings, `$(graph) Stocks +4.21% | Crypto -1.30%` (each group's total P/L %
 * in the base currency); with stocks only `$(graph) +4.21%`; with crypto only `$(graph) Crypto -1.30%`.
 * Colour: green when both numbers are up, red when both are down, default otherwise; a single number as before.
 */
export function buildStatusBarModel(s: PortfolioSnapshot): StatusBarModel {
  if (!s.hasHoldings) {
    return { text: '$(graph) Stonks', tooltip: 'Stonks\nAdd holdings to track your profit/loss.\nClick to open.', tone: 'neutral' };
  }
  const t = s.totals;
  if (!t) {
    if (s.loading || s.lastUpdated === undefined) {
      return { text: '$(sync~spin) Stonks', tooltip: 'Stonks\nLoading quotes...', tone: 'neutral' };
    }
    const first = s.errors[0]?.message;
    return {
      text: '$(graph) --',
      tooltip: `Stonks\nCould not load quotes${first ? `: ${first}` : ''}\nClick to open.`,
      tone: 'warning',
    };
  }

  const both = s.groups.length > 1;
  const lines: string[] = ['Stonks - Portfolio'];
  if (both) {
    for (const g of s.groups) lines.push(...groupTooltipLines(g, s.hideAmounts));
    lines.push('Overall:');
  }
  lines.push(`Total P/L: ${formatPercent(t.pnlPercent)}`);
  lines.push(
    s.hideAmounts
      ? `Today: ${formatPercent(t.dayChangePercent)}`
      : `Today: ${formatPercent(t.dayChangePercent)} (${formatSignedMoney(t.dayChange, t.currency)})`,
  );
  if (!s.hideAmounts) lines.push(...amountLines(t));
  if (t.skipped > 0) lines.push(`${t.skipped} holding(s) excluded (no quote or FX rate)`);
  const updated = s.lastUpdated !== undefined ? new Date(s.lastUpdated).toLocaleTimeString() : 'n/a';
  lines.push(`Updated ${updated} - Data: ${s.dataSource}`);
  if (s.errors.length > 0) lines.push(`Warning: ${s.errors.length} issue(s) - ${s.errors[0].label}: ${s.errors[0].message}`);
  lines.push('Click to open portfolio.');

  if (both) {
    const parts = s.groups.map((g) => `${GROUP_LABEL[g.group]} ${g.totals ? formatPercent(g.totals.pnlPercent) : '--'}`);
    const tones = s.groups.map((g) => (g.totals ? percentTone(g.totals.pnlPercent) : 'neutral'));
    const tone: Tone = tones.every((x) => x === 'gain') ? 'gain' : tones.every((x) => x === 'loss') ? 'loss' : 'neutral';
    return { text: `$(graph) ${parts.join(' | ')}`, tooltip: lines.join('\n'), tone };
  }
  // A single kind of holding: show just that number (labelled when it is crypto, as before for stocks).
  const only = s.groups[0]?.group;
  const label = only === 'crypto' ? 'Crypto ' : '';
  return { text: `$(graph) ${label}${formatPercent(t.pnlPercent)}`, tooltip: lines.join('\n'), tone: percentTone(t.pnlPercent) };
}

/**
 * Status bar item for one pinned ticker: `AAPL $231.40 +0.67%` (holdings: last price in the native currency) or
 * `NIFTY 50 24,832.65 +0.50%` (market rows). Coloured by the day change. Prices and day % are market data, not
 * portfolio amounts, so they are shown even when amounts are hidden; the tooltip adds the user's P/L % for holdings.
 */
export function buildPinStatusModel(p: PinItem): StatusBarModel {
  const fmtPrice = (v: number) => (p.currency ? formatPrice(v, p.currency) : formatNumber(v, p.locale));
  const fmtChange = (v: number) => (p.currency ? formatSignedMoney(v, p.currency) : formatSignedNumber(v, p.locale));
  if (p.price === undefined || p.changePercent === undefined || p.change === undefined) {
    const lines = [p.name, p.error ? `Could not load quote: ${p.error}` : 'Loading quote...'];
    if (p.pnlPercent !== undefined) lines.push(`Your P/L: ${formatPercent(p.pnlPercent)}`);
    lines.push('Click to open portfolio.');
    return { text: `${p.label} ${p.error ? '--' : '...'}`, tooltip: lines.join('\n'), tone: p.error ? 'warning' : 'neutral' };
  }
  const lines = [p.name, `Price: ${fmtPrice(p.price)}`, `Today: ${fmtChange(p.change)} (${formatPercent(p.changePercent)})`];
  if (p.pnlPercent !== undefined) lines.push(`Your P/L: ${formatPercent(p.pnlPercent)}`);
  lines.push('Click to open portfolio.');
  return { text: `${p.label} ${fmtPrice(p.price)} ${formatPercent(p.changePercent)}`, tooltip: lines.join('\n'), tone: percentTone(p.changePercent) };
}

/**
 * The fields of `next` that differ from what is already shown (all of them when nothing has been shown yet).
 * Setting a status bar item property costs an IPC message to the UI even when the value is unchanged, so only changed
 * fields are written.
 */
export function changedFields(shown: Partial<StatusBarModel>, next: StatusBarModel): Partial<StatusBarModel> {
  const out: Partial<StatusBarModel> = {};
  if (shown.text !== next.text) out.text = next.text;
  if (shown.tooltip !== next.tooltip) out.tooltip = next.tooltip;
  if (shown.tone !== next.tone) out.tone = next.tone;
  return out;
}
