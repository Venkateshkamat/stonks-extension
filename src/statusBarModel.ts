import { formatMoney, formatPercent, formatSignedMoney } from './format';
import { PortfolioSnapshot } from './portfolio/controller';

export type Tone = 'gain' | 'loss' | 'neutral' | 'warning';

export interface StatusBarModel {
  text: string;
  tooltip: string;
  tone: Tone;
}

/** Pure presentation logic for the status bar item; unit-tested without VS Code. */
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

  const lines: string[] = ['Stonks - Portfolio'];
  lines.push(`Total P/L: ${formatPercent(t.pnlPercent)}`);
  lines.push(
    s.hideAmounts
      ? `Today: ${formatPercent(t.dayChangePercent)}`
      : `Today: ${formatPercent(t.dayChangePercent)} (${formatSignedMoney(t.dayChange, t.currency)})`,
  );
  if (!s.hideAmounts) {
    lines.push(`Value: ${formatMoney(t.current, t.currency)}`);
    lines.push(`Invested: ${formatMoney(t.invested, t.currency)}`);
    lines.push(`P/L: ${formatSignedMoney(t.pnl, t.currency)}`);
  }
  if (t.skipped > 0) lines.push(`${t.skipped} holding(s) excluded (no quote or FX rate)`);
  const updated = s.lastUpdated !== undefined ? new Date(s.lastUpdated).toLocaleTimeString() : 'n/a';
  lines.push(`Updated ${updated} - Data: ${s.dataSource}`);
  if (s.errors.length > 0) lines.push(`Warning: ${s.errors.length} issue(s) - ${s.errors[0].label}: ${s.errors[0].message}`);
  lines.push('Click to open portfolio.');

  const rounded = Math.round(t.pnlPercent * 100) / 100;
  const tone: Tone = rounded > 0 ? 'gain' : rounded < 0 ? 'loss' : 'neutral';
  return { text: `$(graph) ${formatPercent(t.pnlPercent)}`, tooltip: lines.join('\n'), tone };
}
