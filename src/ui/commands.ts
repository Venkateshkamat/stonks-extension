import * as vscode from 'vscode';
import { currencySymbol, formatMoney } from '../format';
import { NotFoundError } from '../market/http';
import { MarketDataService } from '../market/marketData';
import { PortfolioController } from '../portfolio/controller';
import { holdingPin, parsePinKey, Pin, pinKey, PinStore } from '../portfolio/pins';
import { HoldingsStore } from '../portfolio/store';
import { nativeCurrency, normalizeSymbol, validateSymbol } from '../symbols';
import { Currency, findMarketDef, Holding, INDICES, Market, Quote } from '../types';
import { errorMessage } from '../util/async';
import { parseBuyDate, parseQuantity, validateBuyDate, validateBuyPrice, validateQuantity, parsePositiveNumber, parseRefreshInterval, validateRefreshInterval } from '../validation';
import { FinnhubKeyManager } from './apiKey';

export interface CommandDeps {
  store: HoldingsStore;
  market: MarketDataService;
  controller: PortfolioController;
  pins: PinStore;
  keys: FinnhubKeyManager;
  /** Opens (or reveals) the portfolio panel. */
  openPortfolio: () => void;
}

const MARKET_ITEMS: Array<vscode.QuickPickItem & { market: Market }> = [
  { label: 'NSE', description: 'India - National Stock Exchange (INR)', market: 'NSE' },
  { label: 'BSE', description: 'India - Bombay Stock Exchange (INR)', market: 'BSE' },
  { label: 'US', description: 'US stocks & ETFs (USD)', market: 'US' },
  { label: 'CRYPTO', description: 'Cryptocurrency, priced in USD', market: 'CRYPTO' },
];

const SYMBOL_PLACEHOLDER: Record<Market, string> = {
  NSE: 'RELIANCE',
  BSE: 'RELIANCE',
  US: 'AAPL',
  CRYPTO: 'BTC',
};

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand;
  return [
    reg('stonks.openPortfolio', () => deps.openPortfolio()),
    reg('stonks.addHolding', () => addHolding(deps)),
    reg('stonks.editHolding', (id?: unknown) => editHolding(deps, typeof id === 'string' ? id : undefined)),
    reg('stonks.removeHolding', (id?: unknown) => removeHolding(deps, typeof id === 'string' ? id : undefined)),
    reg('stonks.toggleHideAmounts', () => deps.controller.toggleHideAmounts()),
    reg('stonks.setBaseCurrency', (value?: unknown) => setBaseCurrency(deps, value)),
    reg('stonks.setRefreshInterval', (value?: unknown) => setRefreshInterval(deps, value)),
    reg('stonks.pinTicker', (key?: unknown) => pinTicker(deps, key)),
    reg('stonks.unpinTicker', (key?: unknown) => unpinTicker(deps, key)),
    reg('stonks.refresh', () => deps.controller.refresh('manual')),
    reg('stonks.setFinnhubApiKey', () => deps.keys.setKey()),
    reg('stonks.clearFinnhubApiKey', () => deps.keys.clearKey()),
  ];
}

const CURRENCY_ITEMS: Array<vscode.QuickPickItem & { currency: Currency }> = [
  { label: 'INR', description: 'Indian Rupee (₹)', currency: 'INR' },
  { label: 'USD', description: 'US Dollar ($)', currency: 'USD' },
];

/**
 * Picks the base currency (INR / USD) and writes `stonks.baseCurrency`. Passing 'INR' or 'USD' as the argument
 * (used by the panel toggle and by tests/automation) skips the QuickPick.
 */
export async function setBaseCurrency(deps: CommandDeps, value?: unknown): Promise<void> {
  let currency: Currency | undefined;
  if (value === 'INR' || value === 'USD') currency = value;
  else {
    const current = deps.controller.snapshot.baseCurrency;
    const pick = await vscode.window.showQuickPick(
      CURRENCY_ITEMS.map((i) => (i.currency === current ? { ...i, description: `${i.description} - current`, picked: true } : i)),
      { title: 'Stonks: Set Base Currency', placeHolder: `Current base currency: ${current}` },
    );
    currency = pick?.currency;
  }
  if (!currency || currency === deps.controller.snapshot.baseCurrency) return;
  await deps.controller.setBaseCurrency(currency);
}

/**
 * Asks for the refresh interval in seconds (integer >= 15) and writes `stonks.refreshIntervalSeconds`.
 * A number (or numeric string) argument that passes validation skips the InputBox (tests / automation).
 */
export async function setRefreshInterval(deps: CommandDeps, value?: unknown): Promise<void> {
  let seconds: number | undefined;
  const given = typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;
  if (given !== undefined && validateRefreshInterval(given) === undefined) seconds = parseRefreshInterval(given);
  else {
    const input = await vscode.window.showInputBox({
      title: 'Stonks: Set Refresh Interval',
      prompt: 'How often to refresh quotes, in seconds (minimum 15)',
      value: String(deps.controller.currentRefreshIntervalSeconds),
      validateInput: validateRefreshInterval,
    });
    if (input === undefined) return;
    seconds = parseRefreshInterval(input);
  }
  if (seconds === deps.controller.currentRefreshIntervalSeconds) return;
  await deps.controller.setRefreshIntervalSeconds(seconds);
}

type PinPick = vscode.QuickPickItem & { pin?: Pin };

/** Display name for a pin (holding "NSE:RELIANCE" / market row "NIFTY 50"). */
function pinTitle(p: Pin): string {
  return p.kind === 'holding' ? `${p.market}:${p.symbol}` : (findMarketDef(p.symbol)?.name ?? p.symbol);
}

/** Every pinnable ticker: one entry per distinct holding symbol, then the market rows (indices). */
function pinCandidates(deps: CommandDeps): Pin[] {
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const h of deps.store.list()) {
    const p = holdingPin(h.market, h.symbol);
    if (!seen.has(pinKey(p))) {
      seen.add(pinKey(p));
      out.push(p);
    }
  }
  for (const i of INDICES) out.push({ kind: 'market', symbol: i.symbol });
  return out;
}

function pinItems(pins: readonly Pin[]): PinPick[] {
  const items: PinPick[] = [];
  const holdings = pins.filter((p) => p.kind === 'holding');
  const markets = pins.filter((p) => p.kind === 'market');
  if (holdings.length > 0) {
    items.push({ label: 'Holdings', kind: vscode.QuickPickItemKind.Separator });
    for (const p of holdings) items.push({ label: pinTitle(p), pin: p });
  }
  if (markets.length > 0) {
    items.push({ label: 'Markets', kind: vscode.QuickPickItemKind.Separator });
    for (const p of markets) items.push({ label: pinTitle(p), description: findMarketDef(p.symbol)?.region, pin: p });
  }
  return items;
}

/** Whether a pin points at something that exists (a current holding, or a known market row). */
function isPinTarget(deps: CommandDeps, p: Pin): boolean {
  return p.kind === 'market' ? findMarketDef(p.symbol) !== undefined : deps.store.list().some((h) => pinKey(holdingPin(h.market, h.symbol)) === pinKey(p));
}

/**
 * Pins a holding or market row to the status bar. A pin key (see pinKey()) argument skips the QuickPick; the
 * panel's pin buttons and the tests use that.
 */
export async function pinTicker(deps: CommandDeps, arg?: unknown): Promise<void> {
  let pin: Pin | undefined;
  if (arg !== undefined) {
    pin = parsePinKey(arg);
    if (!pin || !isPinTarget(deps, pin)) {
      void vscode.window.showWarningMessage('Stonks: that ticker is not in your holdings or markets list.');
      return;
    }
  } else {
    const pinned = new Set(deps.pins.list().map(pinKey));
    const candidates = pinCandidates(deps).filter((p) => !pinned.has(pinKey(p)));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('Everything is already pinned.');
      return;
    }
    pin = (await vscode.window.showQuickPick(pinItems(candidates), { title: 'Stonks: Pin Ticker to Status Bar', placeHolder: 'Select a holding or market' }))?.pin;
  }
  if (pin) await deps.pins.add(pin);
}

/** Removes a ticker from the status bar. A pin key argument skips the QuickPick. */
export async function unpinTicker(deps: CommandDeps, arg?: unknown): Promise<void> {
  let pin: Pin | undefined;
  if (arg !== undefined) pin = parsePinKey(arg);
  else {
    const pinned = deps.pins.list();
    if (pinned.length === 0) {
      void vscode.window.showInformationMessage('No tickers are pinned to the status bar.');
      return;
    }
    pin = (await vscode.window.showQuickPick(pinItems(pinned), { title: 'Stonks: Unpin Ticker', placeHolder: 'Select a pinned ticker' }))?.pin;
  }
  if (pin) await deps.pins.remove(pin);
}

/** Fetches a fresh quote to validate a symbol. Returns undefined if the user aborted or rejected it. */
async function verifySymbol(deps: CommandDeps, symbol: string, market: Market): Promise<{ quote?: Quote } | undefined> {
  try {
    const quote = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking ${market}:${symbol}...` },
      () => deps.market.getQuote({ symbol, market }, { fresh: true }),
    );
    return { quote };
  } catch (e) {
    if (e instanceof NotFoundError) {
      void vscode.window.showWarningMessage(`Could not find "${symbol}" on ${market}. Check the symbol and market.`);
      return undefined;
    }
    const pick = await vscode.window.showWarningMessage(
      `Could not verify ${market}:${symbol} (${errorMessage(e)}). Save it anyway?`,
      { modal: true },
      'Save anyway',
    );
    return pick === 'Save anyway' ? {} : undefined;
  }
}

async function askQuantity(initial?: number): Promise<number | undefined> {
  const v = await vscode.window.showInputBox({
    title: 'Quantity',
    prompt: 'Number of shares / units (decimals allowed)',
    value: initial !== undefined ? String(initial) : undefined,
    ignoreFocusOut: true,
    validateInput: validateQuantity,
  });
  return v === undefined ? undefined : parseQuantity(v);
}

async function askBuyPrice(market: Market, quote?: Quote, initial?: number): Promise<number | undefined> {
  const cur = nativeCurrency(market);
  const v = await vscode.window.showInputBox({
    title: `Buy price (${cur})`,
    prompt: `Average price paid per unit in ${currencySymbol(cur)}${quote ? ` (current price: ${formatMoney(quote.price, cur)})` : ''}`,
    value: initial !== undefined ? String(initial) : undefined,
    ignoreFocusOut: true,
    validateInput: validateBuyPrice,
  });
  return v === undefined ? undefined : (parsePositiveNumber(v) as number);
}

/** Returns { date } where date is undefined for "no date", or undefined if the user aborted. */
async function askBuyDate(initial?: string): Promise<{ date?: string } | undefined> {
  const v = await vscode.window.showInputBox({
    title: 'Buy date (optional)',
    prompt: 'YYYY-MM-DD. Leave empty if unknown; the 30-day chart then counts the holding for the whole period.',
    value: initial,
    ignoreFocusOut: true,
    validateInput: (s) => validateBuyDate(s),
  });
  return v === undefined ? undefined : { date: parseBuyDate(v) };
}

export async function addHolding(deps: CommandDeps): Promise<void> {
  const marketPick = await vscode.window.showQuickPick(MARKET_ITEMS, { title: 'Add Holding - Market', placeHolder: 'Select a market' });
  if (!marketPick) return;
  const market = marketPick.market;

  let symbol = '';
  let quote: Quote | undefined;
  for (;;) {
    const input = await vscode.window.showInputBox({
      title: `Add Holding - ${market} symbol`,
      prompt: `Ticker symbol, e.g. ${SYMBOL_PLACEHOLDER[market]}`,
      value: symbol || undefined,
      ignoreFocusOut: true,
      validateInput: (v) => validateSymbol(v, market),
    });
    if (input === undefined) return;
    symbol = normalizeSymbol(input, market);
    const verified = await verifySymbol(deps, symbol, market);
    if (verified) {
      quote = verified.quote;
      break;
    }
    // not found / rejected: ask again with the previous text
    if (!(await retryPrompt())) return;
  }

  const quantity = await askQuantity();
  if (quantity === undefined) return;
  const buyPrice = await askBuyPrice(market, quote);
  if (buyPrice === undefined) return;
  const date = await askBuyDate();
  if (!date) return;

  await deps.store.add({ symbol, market, quantity, buyPrice, buyDate: date.date });
  void vscode.window.showInformationMessage(`Added ${market}:${symbol}.`);
}

async function retryPrompt(): Promise<boolean> {
  const pick = await vscode.window.showQuickPick(['Try another symbol', 'Cancel'], { placeHolder: 'Symbol not added' });
  return pick === 'Try another symbol';
}

async function pickHolding(deps: CommandDeps, title: string, id?: string): Promise<Holding | undefined> {
  const holdings = deps.store.list();
  if (id) return holdings.find((h) => h.id === id);
  if (holdings.length === 0) {
    void vscode.window.showInformationMessage('No holdings yet. Use "Stonks: Add Holding" first.');
    return undefined;
  }
  const hide = deps.controller.snapshot.hideAmounts;
  const sym = (h: Holding) => currencySymbol(nativeCurrency(h.market));
  const pick = await vscode.window.showQuickPick(
    holdings.map((h) => ({
      label: `${h.market}:${h.symbol}`,
      description: hide ? undefined : `${h.quantity} @ ${sym(h)}${h.buyPrice}`,
      detail: h.buyDate ? `Bought ${h.buyDate}` : undefined,
      holding: h,
    })),
    { title, placeHolder: 'Select a holding' },
  );
  return pick?.holding;
}

export async function editHolding(deps: CommandDeps, id?: string): Promise<void> {
  const h = await pickHolding(deps, 'Edit Holding', id);
  if (!h) return;
  const quantity = await askQuantity(h.quantity);
  if (quantity === undefined) return;
  const buyPrice = await askBuyPrice(h.market, deps.controller.snapshot.holdings.find((r) => r.holding.id === h.id)?.quote, h.buyPrice);
  if (buyPrice === undefined) return;
  const date = await askBuyDate(h.buyDate);
  if (!date) return;
  await deps.store.update(h.id, { quantity, buyPrice, buyDate: date.date });
  void vscode.window.showInformationMessage(`Updated ${h.market}:${h.symbol}.`);
}

export async function removeHolding(deps: CommandDeps, id?: string): Promise<void> {
  const h = await pickHolding(deps, 'Remove Holding', id);
  if (!h) return;
  const confirm = await vscode.window.showWarningMessage(`Remove ${h.market}:${h.symbol} from your portfolio?`, { modal: true }, 'Remove');
  if (confirm !== 'Remove') return;
  await deps.store.remove(h.id);
  void vscode.window.showInformationMessage(`Removed ${h.market}:${h.symbol}.`);
}
