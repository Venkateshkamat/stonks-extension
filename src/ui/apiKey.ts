import * as vscode from 'vscode';
import { HttpError } from '../market/http';
import { MarketDataService } from '../market/marketData';
import { errorMessage } from '../util/async';

const SECRET_KEY = 'stonks.finnhubApiKey';
const DISMISSED_KEY = 'stonks.finnhubPromptDismissed';
const REGISTER_URL = 'https://finnhub.io/register';

/** Holds the Finnhub API key (SecretStorage) with a synchronous in-memory copy for the providers. */
export class FinnhubKeyManager implements vscode.Disposable {
  private key: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
    private readonly market: MarketDataService,
  ) {
    this.sub = secrets.onDidChange(async (e) => {
      if (e.key !== SECRET_KEY) return;
      this.key = (await secrets.get(SECRET_KEY)) || undefined;
      this.changed.fire();
    });
  }

  async init(): Promise<void> {
    this.key = (await this.secrets.get(SECRET_KEY)) || undefined;
  }

  get(): string | undefined {
    return this.key;
  }

  /** Spec: shown on activation when no key is stored and the user has not chosen "Use Yahoo" before. */
  async promptOnActivation(): Promise<void> {
    if (this.key || this.state.get<boolean>(DISMISSED_KEY, false)) return;
    for (;;) {
      const choice = await vscode.window.showInformationMessage(
        'Add a free Finnhub API key for faster US & crypto quotes? Yahoo Finance is used otherwise.',
        'Enter API Key',
        'Get Free Key',
        'Use Yahoo',
      );
      if (choice === 'Enter API Key') {
        await this.setKey();
        return;
      }
      if (choice === 'Get Free Key') {
        await vscode.env.openExternal(vscode.Uri.parse(REGISTER_URL));
        continue; // offer the buttons again once the user is back
      }
      if (choice === 'Use Yahoo') await this.state.update(DISMISSED_KEY, true);
      return;
    }
  }

  async setKey(): Promise<void> {
    const input = await vscode.window.showInputBox({
      title: 'Finnhub API Key',
      prompt: `Paste your free Finnhub API key (get one at ${REGISTER_URL})`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() === '' ? 'Enter your API key' : /\s/.test(v.trim()) ? 'The key must not contain spaces' : undefined),
    });
    const key = input?.trim();
    if (!key) return;

    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying Finnhub API key...' }, () =>
        this.market.finnhub.fetchQuote('AAPL', key),
      );
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        void vscode.window.showErrorMessage('Finnhub rejected this API key. Check it and try again.');
        return;
      }
      void vscode.window.showWarningMessage(`Could not verify the Finnhub key (${errorMessage(e)}); saved anyway.`);
    }
    await this.secrets.store(SECRET_KEY, key);
    this.key = key;
    this.changed.fire();
    void vscode.window.showInformationMessage('Finnhub API key saved. US and crypto quotes will now use Finnhub.');
  }

  async clearKey(): Promise<void> {
    if (!this.key) {
      void vscode.window.showInformationMessage('No Finnhub API key is stored.');
      return;
    }
    await this.secrets.delete(SECRET_KEY);
    this.key = undefined;
    this.changed.fire();
    void vscode.window.showInformationMessage('Finnhub API key cleared. Yahoo Finance will be used.');
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
